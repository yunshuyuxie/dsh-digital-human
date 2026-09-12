<#
.SYNOPSIS
  Build the offline installation package for the digital-human bridge.

.DESCRIPTION
  Produces a self-contained zip that installs the plugin into a dsh profile with
  no pnpm, no registry and no network:

    dsh-digital-human-bridge-<version>/
      package/                 the plugin payload (zero runtime dependencies)
      install.ps1              link + profile dependency + patch rows + self-check
      uninstall.ps1            the exact inverse
      verify.ps1               four-layer offline self-check
      common.ps1               shared helpers
      rows.yml                 the patch rows the installer writes
      compat.json              the offline version gate
      CHECKSUMS.txt            protocol digest + per-file digests

  The protocol copy inlined under `package/src/vendor/protocol` must already
  match `packages/protocol/src`; run `node tools/sync-protocol.mjs` first.

.PARAMETER OutputDir
  Directory for the zip. Defaults to `<repo>/dist`.

.PARAMETER Force
  Overwrite an existing zip of the same version.

.EXAMPLE
  pwsh -File scripts/pack.ps1
#>
[CmdletBinding()]
param(
  [string] $OutputDir,
  [switch] $Force
)

$ErrorActionPreference = 'Stop'

$packageRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $packageRoot)
. (Join-Path $PSScriptRoot 'common.ps1')

$manifest = (Read-TextFile (Join-Path $packageRoot 'package.json')) | ConvertFrom-Json
$name = Get-PropertyValue -Object $manifest -Name 'name'
$version = Get-PropertyValue -Object $manifest -Name 'version'
if (-not $name -or -not $version) { throw 'pack: package.json must declare name and version' }
if (-not $OutputDir) { $OutputDir = Join-Path $repoRoot 'dist' }

# --- payload self-containment --------------------------------------------------
$sourceProtocol = Join-Path $repoRoot 'packages/protocol/src'
$vendoredProtocol = Join-Path $packageRoot 'src/vendor/protocol'
if (-not (Test-Path $vendoredProtocol)) {
  throw 'pack: src/vendor/protocol is missing - run: node tools/sync-protocol.mjs'
}
$sourceFiles = Get-ChildItem -Path $sourceProtocol -Filter '*.js' -File | Sort-Object Name
$vendorFiles = Get-ChildItem -Path $vendoredProtocol -Filter '*.js' -File | Sort-Object Name
if ($sourceFiles.Count -ne $vendorFiles.Count) {
  throw 'pack: the vendored protocol does not match packages/protocol/src - run: node tools/sync-protocol.mjs'
}
for ($index = 0; $index -lt $sourceFiles.Count; $index++) {
  if ($sourceFiles[$index].Name -ne $vendorFiles[$index].Name) {
    throw 'pack: the vendored protocol has a different file set - run: node tools/sync-protocol.mjs'
  }
  $a = (Get-FileHash -Path $sourceFiles[$index].FullName -Algorithm SHA256).Hash
  $b = (Get-FileHash -Path $vendorFiles[$index].FullName -Algorithm SHA256).Hash
  if ($a -ne $b) {
    throw "pack: $($sourceFiles[$index].Name) differs from packages/protocol/src - run: node tools/sync-protocol.mjs"
  }
}
Write-Host "pack: vendored protocol matches ($($vendorFiles.Count) files)"

# --- staging -------------------------------------------------------------------
$stageRoot = Join-Path $OutputDir 'staging'
$stage = Join-Path $stageRoot "$name-$version"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'package') | Out-Null

# The payload: everything a dsh process needs to import the plugin.
foreach ($file in @('package.json', 'README.md', 'compat.json')) {
  $from = Join-Path $packageRoot $file
  if (Test-Path $from) { Copy-Item $from (Join-Path $stage 'package') }
}
foreach ($directory in @('src', 'tools', 'scripts')) {
  $from = Join-Path $packageRoot $directory
  if (Test-Path $from) {
    Copy-Item -Recurse $from (Join-Path $stage 'package')
  }
}
# The payload must not carry the development test suite.
$payloadTests = Join-Path $stage 'package/test'
if (Test-Path $payloadTests) { Remove-Item -Recurse -Force $payloadTests }

# The installer sits beside the payload.
foreach ($file in @('install.ps1', 'uninstall.ps1', 'verify.ps1', 'common.ps1')) {
  Copy-Item (Join-Path $PSScriptRoot $file) $stage
}
Copy-Item (Join-Path $PSScriptRoot 'rows.yml') $stage
Copy-Item (Join-Path $packageRoot 'compat.json') $stage

# --- checksums -----------------------------------------------------------------
$sha = [System.Security.Cryptography.SHA256]::Create()
$protocolBuffer = [System.Collections.Generic.List[byte]]::new()
foreach ($file in $vendorFiles) { $protocolBuffer.AddRange([System.IO.File]::ReadAllBytes($file.FullName)) }
$protocolDigest = [System.BitConverter]::ToString($sha.ComputeHash($protocolBuffer.ToArray())).Replace('-', '').ToLowerInvariant()

$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add("$protocolDigest  protocol")
foreach ($file in (Get-ChildItem -Path (Join-Path $stage 'package') -Recurse -File | Sort-Object FullName)) {
  $relative = $file.FullName.Substring($stage.Length + 1).Replace('\', '/')
  $digest = (Get-FileHash -Path $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $lines.Add("$digest  $relative")
}
Write-TextFile -Path (Join-Path $stage 'CHECKSUMS.txt') -Text (($lines -join "`n") + "`n")
Write-Host "pack: wrote CHECKSUMS.txt ($($lines.Count) entries, protocol $protocolDigest)"

# --- zip -----------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$zipPath = Join-Path $OutputDir "$name-$version.zip"
if ((Test-Path $zipPath) -and -not $Force) {
  throw "pack: $zipPath exists; pass -Force to overwrite"
}
if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
Compress-Archive -Path $stage -DestinationPath $zipPath -CompressionLevel Optimal
$zipDigest = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Remove-Item -Recurse -Force $stageRoot

$bytes = (Get-Item $zipPath).Length
Write-Host "pack: $zipPath ($bytes bytes)"
Write-Host "pack: sha256 $zipDigest"
