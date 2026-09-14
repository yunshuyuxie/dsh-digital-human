<#
.SYNOPSIS
  Install this DSH plugin into a profile with no pnpm, no registry and no network.

.DESCRIPTION
  Reproduces by hand exactly the on-disk state a `link:` install produces:
    1. a directory junction under the profile's node_modules;
    2. a dependency entry in the profile's package.json;
    3. a managed row block in the profile's cordis.patch.yml.

  Every step is idempotent: re-running replaces its own artifacts and never
  reverts a decision recorded by another installer.

  A `patchReload: live` profile picks the row change up without a restart; only
  the browser page needs one refresh.

.PARAMETER Profile
  Profile to install into. Defaults to `web`.

.PARAMETER DshHome
  Harness home. Defaults to `$env:DSH_HOME`, then `~/.dsh`.

.PARAMETER PackageRoot
  Directory of the package to mount. Defaults to the `package/` directory beside
  this script (the packed layout), falling back to the repository package.

.PARAMETER RowsFile
  YAML file whose contents become the managed row block. Defaults to `rows.yml`
  beside the packed payload or this script.

.PARAMETER DshInstall
  Path to the installed `@deepseek-ai/dsh/package.json`. Discovered by default
  from the `dsh` bin shim on PATH, the well-known npm / pnpm / nvm global roots
  and a local `npm prefix -g` / `pnpm root -g` query; only needed when all of
  those miss.

.PARAMETER DryRun
  Report every planned change without touching the profile.

.EXAMPLE
  pwsh -File install.ps1 -Profile web
#>
[CmdletBinding()]
param(
  [string] $Profile = 'web',
  [string] $DshHome,
  [string] $PackageRoot,
  [string] $RowsFile,
  [string] $DshInstall,
  [switch] $DryRun,
  [switch] $SkipCompose
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$PackageRoot = Resolve-PackageRoot -ScriptRoot $PSScriptRoot -Override $PackageRoot
if (-not (Test-Path (Join-Path $PackageRoot 'package.json'))) {
  throw "install: no package.json under -PackageRoot $PackageRoot"
}
if (-not $RowsFile) {
  $candidates = @(
    (Join-Path (Split-Path -Parent $PSScriptRoot) 'rows.yml'),
    (Join-Path $PSScriptRoot 'rows.yml')
  )
  $RowsFile = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $RowsFile -or -not (Test-Path $RowsFile)) { throw 'install: rows.yml not found; pass -RowsFile' }

$packageManifest = (Read-TextFile (Join-Path $PackageRoot 'package.json')) | ConvertFrom-Json
$packageName = Get-PropertyValue -Object $packageManifest -Name 'name'
if (-not $packageName) { throw "install: $PackageRoot/package.json has no name" }

$harnessHome = Resolve-DshHome $DshHome
$profileDir = Resolve-ProfileDir -DshHome $harnessHome -Profile $Profile
$manifestPath = Join-Path $profileDir 'package.json'
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$link = Join-Path $profileDir "node_modules/$packageName"
$resolvedPackageRoot = (Resolve-Path -Path $PackageRoot).Path

Write-Host "install: $packageName -> profile '$Profile' ($profileDir)"
Write-Host "install: package root $resolvedPackageRoot"

# --- 1. compatibility, checked offline against the installed dsh ---------------
# Resolved once here and handed to the self-check below, so both steps agree on
# which dsh this installation is being checked against.
$dshManifestPath = Resolve-DshInstall $DshInstall
$compatPath = Resolve-SideFile -ScriptRoot $PSScriptRoot -Name 'compat.json'
if ($compatPath) {
  $compat = (Read-TextFile $compatPath) | ConvertFrom-Json
  $dshVersion = Get-PropertyValue -Object ((Read-TextFile $dshManifestPath) | ConvertFrom-Json) -Name 'version'
  Write-Host "install: installed dsh $dshVersion ($dshManifestPath)"
  Assert-DshCompatible -InstalledVersion $dshVersion -Range @(Get-PropertyValue -Object $compat -Name 'dsh')
  $compatProtocol = Get-PropertyValue -Object $compat -Name 'protocol'
  $packageProtocol = Get-PropertyValue -Object $packageManifest -Name 'protocolVersion'
  if ($null -ne $compatProtocol -and $null -ne $packageProtocol -and $compatProtocol -ne $packageProtocol) {
    Write-Host "install: warning: compat.json protocol $compatProtocol differs from package protocolVersion $packageProtocol"
  }
} else {
  Write-Host 'install: no compat.json beside the script; skipping the version gate'
}

# --- 2. backups ----------------------------------------------------------------
if ($DryRun) {
  Write-Host "install: [dry-run] would back up $manifestPath and $patchPath"
} else {
  $manifestBackup = Backup-File $manifestPath
  $patchBackup = Backup-File $patchPath
  if ($manifestBackup) { Write-Host "install: backed up $manifestBackup" }
  if ($patchBackup) { Write-Host "install: backed up $patchBackup" }
}

# --- 3. junction ---------------------------------------------------------------
if ($DryRun) {
  Write-Host "install: [dry-run] would link $link -> $resolvedPackageRoot"
} else {
  $nodeModules = Join-Path $profileDir 'node_modules'
  if (-not (Test-Path $nodeModules)) { New-Item -ItemType Directory -Path $nodeModules -Force | Out-Null }
  Set-PluginJunction -Link $link -Target $resolvedPackageRoot
  Write-Host "install: linked $link"
}

# --- 4. dependency entry -------------------------------------------------------
$spec = 'link:' + ($resolvedPackageRoot -replace '\\', '/')
if ($DryRun) {
  Write-Host "install: [dry-run] would record dependency $packageName = $spec"
} else {
  $action = Set-ProfileDependency -ManifestPath $manifestPath -PackageName $packageName -Spec $spec
  Assert-ManifestParses -ManifestPath $manifestPath
  Write-Host "install: dependency $packageName = $spec ($action)"
}

# --- 5. managed row block ------------------------------------------------------
# The profile name is substituted into the rows so endpoint and pipe names are
# deterministic, independent of the plugin's runtime profile discovery.
$rows = (Read-TextFile $RowsFile).Replace('__PROFILE__', $Profile)
if ($DryRun) {
  Write-Host 'install: [dry-run] would write this row block:'
  Write-Output "$rows".Trim()
} else {
  Set-PatchBlock -PatchPath $patchPath -PackageName $packageName -Rows $rows
  Write-Host "install: wrote the managed row block for $packageName"
}

# --- 6. offline self-check -----------------------------------------------------
if (-not $DryRun) {
  $verifyArgs = @{ Profile = $Profile; DshHome = $harnessHome; PackageRoot = $resolvedPackageRoot; Quiet = $true; PassThru = $true; DshInstall = $dshManifestPath }
  if ($SkipCompose) { $verifyArgs.SkipCompose = $true }
  $selfCheck = & (Join-Path $PSScriptRoot 'verify.ps1') @verifyArgs
  if (-not $selfCheck.ok) {
    throw ('install: self-check failed -- ' + (($selfCheck.failures) -join ', '))
  }
}

Write-Host 'install: done.'
Write-Host 'install: a live-reload profile has already picked the row up; refresh the Web GUI page to see it.'
