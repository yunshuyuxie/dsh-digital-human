<#
.SYNOPSIS
  Install the digital human into a dsh profile.

.DESCRIPTION
  Two idempotent steps:
    1. link this package into the profile's dependencies
       (`dsh plugin --profile <name> add link:<this package>`);
    2. merge the managed row block into the profile's cordis.patch.yml
       (see merge-patch.ps1).

  A `patchReload: live` profile picks the patch change up without a restart; the
  browser still needs one page refresh to compose the new client boot graph.

.PARAMETER Profile
  Profile name to install into. Defaults to `web`.

.PARAMETER OwnApprovals
  Also disable the shipped `ui-approval` row so the digital human's card owns
  permission confirmation. Without it the shipped composer panel keeps
  answering requests and the avatar's card never appears.

.PARAMETER NoOwnApprovals
  Give permission confirmation back to the shipped panel. Omitting both
  switches keeps whichever choice the profile currently records, so a plain
  re-run never reverts a previous decision.

.PARAMETER DshHome
  Override the DSH home directory. Defaults to `$env:DSH_HOME`, then `~/.dsh`.

.PARAMETER PatchOnly
  Skip the dependency link and only rewrite the patch layer.

.EXAMPLE
  pwsh -File scripts/install.ps1 -OwnApprovals
#>
[CmdletBinding()]
param(
  [string] $Profile = 'web',
  [switch] $OwnApprovals,
  [switch] $NoOwnApprovals,
  [string] $DshHome,
  [switch] $PatchOnly
)

$ErrorActionPreference = 'Stop'

if ($OwnApprovals -and $NoOwnApprovals) {
  throw 'install: -OwnApprovals and -NoOwnApprovals are mutually exclusive'
}

$packageRoot = Split-Path -Parent $PSScriptRoot
if (-not $DshHome) {
  $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
}
$profileDir = Join-Path $DshHome "profiles/$Profile"
if (-not (Test-Path $profileDir)) {
  throw "install: profile '$Profile' does not exist at $profileDir (boot it once with: dsh --profile $Profile)"
}

if (-not $PatchOnly) {
  Write-Host "install: linking $packageRoot into profile '$Profile'"
  & dsh plugin --profile $Profile add "link:$packageRoot"
  if ($LASTEXITCODE -ne 0) {
    throw "install: 'dsh plugin --profile $Profile add' exited with $LASTEXITCODE"
  }
}

$mergeArgs = @{ ProfileDir = $profileDir }
if ($OwnApprovals) { $mergeArgs.OwnApprovals = $true }
if ($NoOwnApprovals) { $mergeArgs.NoOwnApprovals = $true }
& (Join-Path $PSScriptRoot 'merge-patch.ps1') @mergeArgs

if ($OwnApprovals) {
  Write-Host 'install: the digital human now owns permission confirmation.'
} elseif ($NoOwnApprovals) {
  Write-Host 'install: permission confirmation returned to the shipped approval panel.'
} else {
  Write-Host 'install: permission ownership left unchanged (sticky);'
  Write-Host '         pass -OwnApprovals to hand it to the digital human, or -NoOwnApprovals to take it back.'
}
Write-Host 'install: done — refresh the Web GUI page to compose the digital human into the client graph.'
