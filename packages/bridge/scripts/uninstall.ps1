<#
.SYNOPSIS
  Remove this DSH plugin from a profile: junction, dependency entry, row block.

.DESCRIPTION
  The exact inverse of install.ps1, and equally offline. Every step is
  idempotent, so running it against a profile that was never installed is a
  no-op rather than an error.

  With -PurgeState it also removes this plugin's runtime state (the endpoint
  file and the profile's token entry) from `$DSH_HOME/digital-human`.

.PARAMETER PurgeState
  Also delete the endpoint file and token entry for this profile.

.EXAMPLE
  pwsh -File uninstall.ps1 -Profile web
#>
[CmdletBinding()]
param(
  [string] $Profile = 'web',
  [string] $DshHome,
  [string] $PackageRoot,
  [switch] $PurgeState,
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$PackageRoot = Resolve-PackageRoot -ScriptRoot $PSScriptRoot -Override $PackageRoot
$packageName = Get-PropertyValue -Object ((Read-TextFile (Join-Path $PackageRoot 'package.json')) | ConvertFrom-Json) -Name 'name'
if (-not $packageName) { throw "uninstall: $PackageRoot/package.json has no name" }

$harnessHome = Resolve-DshHome $DshHome
$profileDir = Resolve-ProfileDir -DshHome $harnessHome -Profile $Profile
$manifestPath = Join-Path $profileDir 'package.json'
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$link = Join-Path $profileDir "node_modules/$packageName"

Write-Host "uninstall: $packageName from profile '$Profile' ($profileDir)"

if ($DryRun) {
  Write-Host "uninstall: [dry-run] would remove $link, the dependency entry, and the managed row block"
} else {
  if (Remove-PluginJunction -Link $link) { Write-Host "uninstall: removed $link" }
  else { Write-Host 'uninstall: no junction to remove' }

  $manifestBackup = Backup-File $manifestPath
  if (Remove-ProfileDependency -ManifestPath $manifestPath -PackageName $packageName) {
    Assert-ManifestParses -ManifestPath $manifestPath
    Write-Host 'uninstall: removed the dependency entry'
  } else {
    Write-Host 'uninstall: no dependency entry to remove'
  }

  $hadBlock = $null -ne (Get-PatchBlock -PatchPath $patchPath -PackageName $packageName)
  Set-PatchBlock -PatchPath $patchPath -PackageName $packageName -Rows ''
  if ($hadBlock) { Write-Host 'uninstall: removed the managed row block' }
  else { Write-Host 'uninstall: no managed row block to remove' }
}

if ($PurgeState) {
  $stateDir = Join-Path $harnessHome 'digital-human'
  $endpoint = Join-Path $stateDir "endpoints/$Profile.json"
  if ($DryRun) {
    Write-Host "uninstall: [dry-run] would purge $endpoint and the token entry"
  } else {
    if (Test-Path $endpoint) { Remove-Item -Path $endpoint -Force; Write-Host "uninstall: purged $endpoint" }
    $secretsPath = Join-Path $stateDir 'secrets.json'
    if (Test-Path $secretsPath) {
      $secrets = (Read-TextFile $secretsPath) | ConvertFrom-Json
      $profiles = Get-PropertyValue -Object $secrets -Name 'profiles'
      if ($null -ne $profiles -and $null -ne $profiles.PSObject.Properties[$Profile]) {
        $profiles.PSObject.Properties.Remove($Profile)
        Write-TextFile -Path $secretsPath -Text (($secrets | ConvertTo-Json -Depth 8) + "`n")
        Write-Host "uninstall: purged the token entry for '$Profile'"
      }
    }
  }
}

Write-Host 'uninstall: done -- refresh the Web GUI page to drop the plugin from the client graph.'
