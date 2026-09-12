# Retire the Web-GUI digital-human plugin from a dsh profile.
#
# The avatar's job moved to the desktop app (packages/app), which answers
# permission requests through the bridge plugin. This removes the older Web
# plugin's installation: its dependency, its junction, and its managed patch
# block — including the `ui-approval: disabled: true` override that block
# carried, so the shipped approval panel works again.
#
# Idempotent: running it twice is a no-op.
#
#   pwsh -File uninstall.ps1 -Profile web
#   pwsh -File uninstall.ps1 -Profile web -DshHome C:\Users\me\.dsh -PassThru

[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [string]$DshHome = $env:DSH_HOME,
  [switch]$PassThru
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$utf8 = [System.Text.UTF8Encoding]::new($false)
$packageName = 'dsh-digital-human'
$startMarker = "# >>> $packageName (managed) >>>"
$endMarker = "# <<< $packageName (managed) <<<"

if ([string]::IsNullOrWhiteSpace($DshHome)) {
  $DshHome = Join-Path $env:USERPROFILE '.dsh'
}

$profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$manifestPath = Join-Path $profileDir 'package.json'
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$linkPath = Join-Path (Join-Path $profileDir 'node_modules') $packageName
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$result = [ordered]@{ profile = $Profile; removedDependency = $false; removedLink = $false; removedPatchBlock = $false; backups = @(); changed = $false }

if (-not (Test-Path $profileDir)) {
  throw "profile '$Profile' not found at $profileDir"
}

# 1. The dependency entry.
if (Test-Path $manifestPath) {
  $manifest = [System.IO.File]::ReadAllText($manifestPath, $utf8) | ConvertFrom-Json
  if ($manifest.PSObject.Properties.Name -contains 'dependencies' -and
      $manifest.dependencies.PSObject.Properties.Name -contains $packageName) {
    $backup = "$manifestPath.bak-$stamp"
    Copy-Item $manifestPath $backup -Force
    $result.backups += $backup
    $manifest.dependencies.PSObject.Properties.Remove($packageName)
    # ConvertTo-Json of a profile manifest is stable enough here because the file
    # was machine-written in the first place; depth 8 covers bundles + deps.
    [System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 8), $utf8)
    $result.removedDependency = $true
    $result.changed = $true
  }
}

# 2. The junction. Remove the LINK only: deleting the target would destroy the
#    source tree the link points at.
if (Test-Path $linkPath) {
  $item = Get-Item -Force $linkPath
  if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
    [System.IO.Directory]::Delete($linkPath, $false)
  } else {
    Remove-Item -Recurse -Force $linkPath
  }
  $result.removedLink = $true
  $result.changed = $true
}

# 3. The managed patch block, which also carried the ui-approval override.
if (Test-Path $patchPath) {
  $lines = [System.IO.File]::ReadAllLines($patchPath, $utf8)
  $kept = New-Object System.Collections.Generic.List[string]
  $inside = $false
  $found = $false
  foreach ($line in $lines) {
    if ($line.Trim() -eq $startMarker) { $inside = $true; $found = $true; continue }
    if ($line.Trim() -eq $endMarker) { $inside = $false; continue }
    if (-not $inside) { $kept.Add($line) }
  }
  if ($found) {
    $backup = "$patchPath.bak-$stamp"
    Copy-Item $patchPath $backup -Force
    $result.backups += $backup
    # Collapse the blank runs the removal leaves behind.
    $text = ($kept -join "`n")
    $text = [regex]::Replace($text, "(\r?\n){3,}", "`n`n")
    if (-not $text.EndsWith("`n")) { $text += "`n" }
    [System.IO.File]::WriteAllText($patchPath, $text, $utf8)
    $result.removedPatchBlock = $true
    $result.changed = $true
  }
}

Write-Output "uninstall: profile '$Profile' at $profileDir"
Write-Output "uninstall: dependency removed=$($result.removedDependency) link removed=$($result.removedLink) patch block removed=$($result.removedPatchBlock)"
if (-not $result.changed) {
  Write-Output "uninstall: nothing to do — '$packageName' is not installed in this profile."
} else {
  Write-Output "uninstall: backup(s): $($result.backups -join ', ')"
  Write-Output "uninstall: refresh the Web GUI page so the re-enabled ui-approval panel mounts."
}

if ($PassThru) { [pscustomobject]$result }
