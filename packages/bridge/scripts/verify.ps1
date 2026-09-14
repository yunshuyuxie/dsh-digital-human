<#
.SYNOPSIS
  Offline self-check for an installed copy of this DSH plugin.

.DESCRIPTION
  Answers "did the offline install actually take effect?" without any network
  access, in four layers:

    1. filesystem   - dependency entry, junction target, package entry file;
    2. composition  - the row is present and enabled in the composed tree
                      (delegated to tools/compose-verify.mjs);
    3. payload      - the inlined protocol copy matches CHECKSUMS.txt;
    4. runtime      - when dsh is running: the endpoint file exists and the
                      named pipe answers a handshake (delegated to tools/probe.mjs).

  Layers 1-3 always run. Layer 4 runs only when the endpoint file exists, and a
  missing runtime is reported as SKIP rather than FAIL: a plugin can be
  installed correctly while dsh is not running.

.PARAMETER Quiet
  Print only failures and the final summary (used by install.ps1).

.PARAMETER DshInstall
  Path to the installed `@deepseek-ai/dsh/package.json`, forwarded to the
  compose layer. Discovered the same way install.ps1 discovers it when omitted.

.EXAMPLE
  pwsh -File verify.ps1 -Profile web
#>
[CmdletBinding()]
param(
  [string] $Profile = 'web',
  [string] $DshHome,
  [string] $PackageRoot,
  [string] $DshInstall,
  [switch] $Quiet,
  [switch] $PassThru,
  [switch] $SkipCompose
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$PackageRoot = Resolve-PackageRoot -ScriptRoot $PSScriptRoot -Override $PackageRoot
$packageManifest = (Read-TextFile (Join-Path $PackageRoot 'package.json')) | ConvertFrom-Json
$packageName = Get-PropertyValue -Object $packageManifest -Name 'name'

$harnessHome = Resolve-DshHome $DshHome
$profileDir = Resolve-ProfileDir -DshHome $harnessHome -Profile $Profile
$manifestPath = Join-Path $profileDir 'package.json'
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$link = Join-Path $profileDir "node_modules/$packageName"
$checks = [System.Collections.Generic.List[object]]::new()

function Add-Check {
  param([string] $Layer, [string] $Name, [bool] $Passed, [string] $Detail = '', [switch] $Skip)
  $state = if ($Skip) { 'SKIP' } elseif ($Passed) { 'ok  ' } else { 'FAIL' }
  $checks.Add([pscustomobject]@{ Layer = $Layer; Name = $Name; State = $state; Detail = $Detail })
  if (-not $Quiet -or -not $Passed) {
    $suffix = if ($Detail) { " -- $Detail" } else { '' }
    Write-Host ("  {0} [{1}] {2}{3}" -f $state, $Layer, $Name, $suffix)
  }
}

Write-Host "verify: $packageName in profile '$Profile' ($profileDir)"

# --- layer 1: filesystem -------------------------------------------------------
$dependency = Get-ProfileDependency -ManifestPath $manifestPath -PackageName $packageName
$dependencyDetail = if ($dependency) { $dependency } else { 'missing' }
Add-Check 'files' 'profile dependency entry' ($null -ne $dependency) $dependencyDetail

$linkExists = Test-Path $link
Add-Check 'files' 'node_modules link' $linkExists $link
if ($linkExists) {
  $target = Get-JunctionTarget -Link $link
  $expected = (Resolve-Path -Path $PackageRoot).Path
  $linkOk = $false
  if ($target) {
    $normalizedTarget = ($target -replace '\\', '/').TrimEnd('/')
    $normalizedExpected = ($expected -replace '\\', '/').TrimEnd('/')
    $linkOk = $normalizedTarget -eq $normalizedExpected
  }
  Add-Check 'files' 'link points at this package' $linkOk "$target"
}

$entry = $null
foreach ($candidate in @('src/index.js', 'lib/index.js', 'index.js')) {
  if (Test-Path (Join-Path $PackageRoot $candidate)) { $entry = $candidate; break }
}
$entryDetail = if ($entry) { $entry } else { 'none of src/index.js, lib/index.js, index.js' }
Add-Check 'files' 'package entry module' ($null -ne $entry) $entryDetail

Add-Check 'files' 'managed row block present' ($null -ne (Get-PatchBlock -PatchPath $patchPath -PackageName $packageName))

# --- layer 2: composition ------------------------------------------------------
$composeScript = Resolve-ToolScript -PackageRoot $PackageRoot -ScriptRoot $PSScriptRoot -Name 'compose-verify.mjs'
if ($SkipCompose) {
  # Escape hatch for restricted shells that cannot start node at all.
  Add-Check 'compose' 'row present and enabled' $true 'skipped by -SkipCompose' -Skip
} elseif ($composeScript) {
  $rowId = Get-PropertyValue -Object $packageManifest -Name 'dshRowId' -Default 'digital-human-bridge'
  $composeArgs = @('--profile', $Profile, '--row', $rowId, '--name', $packageName, '--dsh-home', $harnessHome)
  if ($DshInstall) { $composeArgs += @('--install', $DshInstall) }
  $compose = Invoke-NodeTool -Script $composeScript -Arguments $composeArgs
  $composeDetail = if ($compose.ok) { 'ok' } else { (($compose.output | Select-Object -Last 2) -join ' | ') }
  Add-Check 'compose' 'row present and enabled' $compose.ok $composeDetail
  if (-not $Quiet) { $compose.output | ForEach-Object { Write-Host "      $_" } }
} else {
  Add-Check 'compose' 'compose-verify.mjs available' $false $composeScript
}

# --- layer 3: inlined payload --------------------------------------------------
$checksumFile = Resolve-SideFile -ScriptRoot $PSScriptRoot -Name 'CHECKSUMS.txt'
$vendorDir = Join-Path $PackageRoot 'src/vendor/protocol'
if ($checksumFile) {
  $expectedHash = $null
  foreach ($line in (Read-TextFile $checksumFile) -split "\r?\n") {
    $m = [regex]::Match($line, '^\s*([0-9a-fA-F]{64})\s+\*?(.+)$')
    if ($m.Success -and $m.Groups[2].Value -match 'protocol') { $expectedHash = $m.Groups[1].Value; break }
  }
  if ($expectedHash -and (Test-Path $vendorDir)) {
    $files = Get-ChildItem -Path $vendorDir -File | Sort-Object Name
    # Hash the files' bytes concatenated in name order: independent of directory
    # metadata, so a copy to another machine reproduces the same digest.
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $buffer = [System.Collections.Generic.List[byte]]::new()
    foreach ($file in $files) { $buffer.AddRange([System.IO.File]::ReadAllBytes($file.FullName)) }
    $actualHash = [System.BitConverter]::ToString($sha.ComputeHash($buffer.ToArray())).Replace('-', '').ToLowerInvariant()
    Add-Check 'payload' 'inlined protocol matches CHECKSUMS.txt' ($actualHash -eq $expectedHash.ToLowerInvariant()) $actualHash
  } else {
    Add-Check 'payload' 'inlined protocol checksum' $false 'no protocol entry in CHECKSUMS.txt or no src/vendor/protocol'
  }
} else {
  # An unpacked development copy carries no checksum manifest; only a packed
  # installation is expected to prove payload integrity.
  Add-Check 'payload' 'packed payload checksums' $true 'no CHECKSUMS.txt (unpacked copy)' -Skip
}

# --- layer 4: runtime (only when dsh appears to be running) --------------------
$endpoint = Join-Path $harnessHome "digital-human/endpoints/$Profile.json"
if (Test-Path $endpoint) {
  $endpointInfo = (Read-TextFile $endpoint) | ConvertFrom-Json
  Add-Check 'runtime' 'endpoint file' $true (Get-PropertyValue -Object $endpointInfo -Name 'path' -Default '')
  $probe = Resolve-ToolScript -PackageRoot $PackageRoot -ScriptRoot $PSScriptRoot -Name 'probe.mjs'
  if ($probe) {
    $probeRun = Invoke-NodeTool -Script $probe -Arguments @('--profile', $Profile, '--dsh-home', $harnessHome, '--check')
    $probeDetail = if ($probeRun.ok) { 'ok' } else { (($probeRun.output | Select-Object -Last 2) -join ' | ') }
    Add-Check 'runtime' 'pipe handshake + sessions.list' $probeRun.ok $probeDetail
    if (-not $Quiet) { $probeRun.output | ForEach-Object { Write-Host "      $_" } }
  } else {
    Add-Check 'runtime' 'probe.mjs available' $false $probe
  }
} else {
  Add-Check 'runtime' 'endpoint file (dsh running?)' $true 'dsh is not serving an endpoint yet' -Skip
}

# --- summary -------------------------------------------------------------------
$failed = @($checks | Where-Object { $_.State -eq 'FAIL' })
$skipped = @($checks | Where-Object { $_.State -eq 'SKIP' })
$passed = @($checks | Where-Object { $_.State -eq 'ok  ' })
Write-Host ("verify: {0} passed, {1} failed, {2} skipped" -f $passed.Count, $failed.Count, $skipped.Count)
$ok = $failed.Count -eq 0
if ($PassThru) {
  # Callers inspect this object: `exit` does not carry across `& script.ps1`.
  return [pscustomobject]@{
    ok       = $ok
    passed   = $passed.Count
    failed   = $failed.Count
    skipped  = $skipped.Count
    failures = @($failed | ForEach-Object { "$($_.Layer)/$($_.Name)" })
  }
}
if (-not $ok) { exit 1 }
exit 0
