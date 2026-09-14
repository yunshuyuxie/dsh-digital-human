# Build and publish a release: build the app, pack the bridge, verify the
# artifacts are not stale, then create or update a GitHub release and replace its
# assets.
#
# Three traps this encodes, all of them hit for real while publishing v0.1.0:
#   1. a running app instance locks `app.asar` and the build fails with EBUSY;
#   2. a stale build can be uploaded without complaint — the asar is compared
#      against the newest source file before anything is published;
#   3. `github.com:443` may be unreachable while the rest of the network is fine,
#      so a local proxy can be passed in;
#   4. replacing an asset means deleting it first, so re-uploading an unchanged
#      107 MB installer can leave the release without that installer if the
#      transfer dies; an asset whose digest already matches is kept as it is.
#
#   pwsh -File tools/release.ps1 -DryRun
#   pwsh -File tools/release.ps1 -Proxy http://127.0.0.1:64174
#   pwsh -File tools/release.ps1 -SkipBuild -Tag v0.1.1
#
# Credentials come from the stored git credential for github.com (Git Credential
# Manager). Nothing is written to the global git config.

[CmdletBinding()]
param(
  # Release tag; defaults to v<app version>.
  [string]$Tag = '',
  # HTTP proxy for GitHub, e.g. http://127.0.0.1:64174. Falls back to git's http.proxy.
  [string]$Proxy = '',
  # owner/repo; defaults to the origin remote.
  [string]$Repo = '',
  # Reuse the artifacts already on disk instead of building.
  [switch]$SkipBuild,
  # Report what would happen without publishing.
  [switch]$DryRun,
  # Publish even with uncommitted changes.
  [switch]$AllowDirty
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$utf8 = [System.Text.UTF8Encoding]::new($false)
$repoRoot = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $repoRoot 'packages\app'
$bridgeDir = Join-Path $repoRoot 'packages\bridge'
$distDir = Join-Path $repoRoot 'dist'
$asarPath = Join-Path $distDir 'app\win-unpacked\resources\app.asar'

function Write-Step([string]$Text) { Write-Output "release: $Text" }
function Fail([string]$Text) { throw "release: $Text" }

# --- helpers -----------------------------------------------------------------

function Get-ProxyUrl {
  if ($Proxy -ne '') { return $Proxy }
  $configured = (& git -C $repoRoot config --get http.proxy) 2>$null
  if ($configured) { return $configured.Trim() }
  return ''
}

function Read-Json([string]$Path) {
  # Windows PowerShell decodes `Get-Content -Raw` as ANSI, which mangles UTF-8
  # Chinese and then breaks ConvertFrom-Json outright; read the bytes as UTF-8.
  $text = [System.IO.File]::ReadAllText($Path, [System.Text.UTF8Encoding]::new($false))
  return ($text | ConvertFrom-Json)
}

function Get-Token {
  # Never echoes the secret; only its length reaches the log.
  $raw = ("protocol=https`nhost=github.com`n`n" | & git credential fill) 2>&1
  $line = $raw | Where-Object { $_ -like 'password=*' } | Select-Object -First 1
  if (-not $line) { Fail 'no stored GitHub credential — run a `git push` once so Git Credential Manager can store one' }
  return ($line -replace '^password=', '')
}

function Invoke-Api {
  # One place that knows about the proxy, the token and the API headers.
  param(
    [string]$Method,
    [string]$Url,
    [string]$Body,
    [string]$UploadFile
  )
  $curlArgs = @('-sS', '--max-time', '2400')
  if ($proxyUrl -ne '') { $curlArgs += @('--proxy', $proxyUrl) }
  $curlArgs += @('-X', $Method, '-H', "Authorization: Bearer $token", '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28')
  if ($UploadFile -ne '') {
    $curlArgs += @('-H', 'Content-Type: application/octet-stream', '-T', $UploadFile)
  } elseif ($Body -ne '') {
    $curlArgs += @('-H', 'Content-Type: application/json', '--data-binary', $Body)
  }
  $curlArgs += $Url
  $result = & curl.exe @curlArgs 2>&1
  return ($result -join "`n")
}

function Assert-Fresh([string]$Artifact) {
  # The artifact must be newer than every input, otherwise it silently ships old code.
  $artifactTime = (Get-Item $Artifact).LastWriteTimeUtc
  $inputs = @()
  foreach ($dir in @('main', 'preload', 'renderer', 'src')) {
    $path = Join-Path $appDir $dir
    if (Test-Path $path) { $inputs += Get-ChildItem $path -Recurse -File -Include *.js,*.cjs,*.css,*.html -ErrorAction SilentlyContinue }
  }
  foreach ($name in @('package.json', 'electron-builder.yml')) {
    $path = Join-Path $appDir $name
    if (Test-Path $path) { $inputs += Get-Item $path }
  }
  $newest = $inputs | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if ($newest -and $newest.LastWriteTimeUtc -gt $artifactTime) {
    Fail ("build is stale: {0} is newer than the artifact ({1:u} vs {2:u})" -f $newest.Name, $newest.LastWriteTimeUtc, $artifactTime)
  }
  if ($newest) { Write-Step ("freshness ok: the artifact is newer than the newest source ({0})" -f $newest.Name) }
}

# --- 1. repository and versions ----------------------------------------------

if (-not (Test-Path (Join-Path $repoRoot '.git'))) { Fail "not a git repository: $repoRoot" }

if ($Repo -eq '') {
  $remote = (& git -C $repoRoot remote get-url origin) 2>$null
  if (-not $remote) { Fail 'no origin remote and no -Repo given' }
  if ($remote -match 'github\.com[:/](?<slug>[^/]+/[^/.]+)') { $Repo = $Matches['slug'] } else { Fail "cannot derive owner/repo from $remote" }
}

$appVersion = (Read-Json (Join-Path $appDir 'package.json')).version
$bridgeVersion = (Read-Json (Join-Path $bridgeDir 'package.json')).version
if ($Tag -eq '') { $Tag = "v$appVersion" }
$bridgeZip = Join-Path $distDir "dsh-digital-human-bridge-$bridgeVersion.zip"
$appAssets = @(
  (Join-Path $distDir "app\dsh-digital-human-$appVersion-setup.exe"),
  (Join-Path $distDir "app\dsh-digital-human-$appVersion-portable.exe")
)

Write-Step "repo $Repo   tag $Tag   app $appVersion   bridge $bridgeVersion"

$dirty = & git -C $repoRoot status --porcelain
if ($dirty -and -not $AllowDirty -and -not $DryRun) {
  Fail 'working tree has uncommitted changes — commit them first, or pass -AllowDirty'
}

$proxyUrl = Get-ProxyUrl
if ($proxyUrl -eq '') { Write-Step 'no proxy configured (direct connection)' } else { Write-Step "proxy $proxyUrl" }

# --- 2. build ----------------------------------------------------------------

if ($SkipBuild) {
  Write-Step 'skipping the build (-SkipBuild)'
} elseif ($DryRun) {
  Write-Step 'dry run: would build the app and pack the bridge'
} else {
  # A running instance holds an exclusive handle on app.asar; electron-builder
  # then fails with EBUSY while unlinking it.
  $locked = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$distDir\app\*" }
  if ($locked) {
    Write-Step ("stopping {0} running app instance(s) that would lock app.asar" -f @($locked).Count)
    $locked | ForEach-Object { Stop-Process -Id $_.Id -Force }
    Start-Sleep -Seconds 3
  }

  Write-Step 'building the desktop app…'
  Push-Location $appDir
  try {
    & pnpm run dist
    if ($LASTEXITCODE -ne 0) { Fail "electron-builder failed (exit $LASTEXITCODE)" }
  } finally { Pop-Location }

  Write-Step 'packing the bridge plugin…'
  & (Join-Path $bridgeDir 'scripts\pack.ps1') -Force
  if ($LASTEXITCODE -ne 0) { Fail "pack.ps1 failed (exit $LASTEXITCODE)" }
}

# --- 3. verify the artifacts -------------------------------------------------

foreach ($path in @($asarPath) + $appAssets + @($bridgeZip)) {
  if (-not (Test-Path $path)) { Fail "missing artifact: $path" }
}
Assert-Fresh $asarPath

$totalMb = ($appAssets + $bridgeZip | ForEach-Object { (Get-Item $_).Length } | Measure-Object -Sum).Sum / 1MB
Write-Step ("artifacts: {0} file(s), {1:N1} MB" -f ($appAssets.Count + 1), $totalMb)

if ($DryRun) {
  Write-Step 'dry run: stopping here, nothing was published'
  return
}

# --- 4. publish --------------------------------------------------------------

$token = Get-Token
$apiBase = "https://api.github.com/repos/$Repo"
$uploadBase = "https://uploads.github.com/repos/$Repo"

Write-Step "looking for release $Tag…"
$existing = Invoke-Api -Method GET -Url "$apiBase/releases/tags/$Tag"
try { $release = $existing | ConvertFrom-Json } catch { $release = $null }
if ($release -and $release.id) {
  Write-Step "release exists (id $($release.id)) — assets will be replaced"
} else {
  $notes = "自动发布：桌面应用 $appVersion，桥接插件 $bridgeVersion。详见仓库 README。"
  $payload = @{
    tag_name         = $Tag
    target_commitish = 'main'
    name             = "数字人 $Tag"
    body             = $notes
    draft            = $false
    prerelease       = $false
  } | ConvertTo-Json -Depth 4
  $created = Invoke-Api -Method POST -Url "$apiBase/releases" -Body $payload
  $release = $created | ConvertFrom-Json
  if (-not $release.id) { Fail "could not create the release: $created" }
  Write-Step "created release $Tag (id $($release.id))"
}

$assets = @($appAssets) + @($bridgeZip)
foreach ($file in $assets) {
  $name = Split-Path $file -Leaf
  $localHash = (Get-FileHash -Path $file -Algorithm SHA256).Hash.ToLowerInvariant()
  # Replace semantics: an asset name is unique per release, so drop the old one.
  $current = Invoke-Api -Method GET -Url "$apiBase/releases/$($release.id)/assets" | ConvertFrom-Json
  $clash = $current | Where-Object { $_.name -eq $name } | Select-Object -First 1
  $remoteDigest = ''
  if ($clash) {
    # The digest is absent on assets uploaded before the API exposed it; only
    # then does this fall through to the unconditional replace below.
    $digest = $clash.PSObject.Properties['digest']
    if ($digest -and $digest.Value) { $remoteDigest = "$($digest.Value)" }
  }
  if ($remoteDigest -eq "sha256:$localHash") {
    # Re-uploading 107 MB that is already published gains nothing and risks
    # leaving the release without that installer if the transfer dies halfway.
    Write-Step "keeping $name (already published, sha256 unchanged)"
    continue
  }
  if ($clash) {
    Write-Step "removing the previous $name"
    Invoke-Api -Method DELETE -Url "$apiBase/releases/assets/$($clash.id)" | Out-Null
  }
  $mb = [math]::Round((Get-Item $file).Length / 1MB, 1)
  Write-Step "uploading $name ($mb MB)…"
  $response = Invoke-Api -Method POST -Url "$uploadBase/releases/$($release.id)/assets?name=$name" -UploadFile $file
  $uploaded = $response | ConvertFrom-Json
  if (-not $uploaded.id) { Fail "upload failed for ${name}: $response" }
}

$final = Invoke-Api -Method GET -Url "$apiBase/releases/$($release.id)/assets" | ConvertFrom-Json
Write-Step 'published:'
foreach ($asset in $final) {
  Write-Output ("  {0,-40} {1,8:N2} MB  {2}" -f $asset.name, ($asset.size / 1MB), $asset.browser_download_url)
}
Write-Output "release: https://github.com/$Repo/releases/tag/$Tag"
