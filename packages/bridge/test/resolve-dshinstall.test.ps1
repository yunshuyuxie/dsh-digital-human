<#
.SYNOPSIS
  Fixture tests for the dsh discovery in scripts/common.ps1.

.DESCRIPTION
  Resolve-DshInstall must recognise every layout `dsh` arrives through, and they
  differ in where the bin shim sits relative to the package:

    * npm prefix / npm global / nvm:  <prefix>/dsh.cmd
    * npm or pnpm local install:      <root>/node_modules/.bin/dsh.cmd
    * pnpm global:                    <pnpm home>/dsh.cmd  with the package in
                                      <pnpm home>/global/<store>/node_modules/...

  Every case builds one of those trees from the shim text npm and pnpm really
  generate, then points PATH and the app-data environment at the fixture only,
  so a pass can only come from the layout under test.

  Run: powershell -File test/resolve-dshinstall.test.ps1
       (Windows PowerShell 5.1 and pwsh are both supported.)

.PARAMETER WorkRoot
  Directory for the throwaway fixture trees. Defaults to the temporary
  directory of the current user.
#>
[CmdletBinding()]
param(
  [string] $WorkRoot
)

$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts/common.ps1')

if (-not $WorkRoot) { $WorkRoot = [System.IO.Path]::GetTempPath() }
$fixtureRoot = Join-Path $WorkRoot ("dsh-resolve-" + [guid]::NewGuid().ToString('N').Substring(0, 8))

$failures = [System.Collections.Generic.List[string]]::new()
$checks = 0

<#
.SYNOPSIS
  Report one case.
#>
function Add-Result {
  param([string] $Name, [bool] $Passed, [string] $Detail = '')
  $script:checks++
  $state = if ($Passed) { 'ok  ' } else { 'FAIL' }
  $suffix = if ($Detail) { " -- $Detail" } else { '' }
  Write-Host ("  {0} {1}{2}" -f $state, $Name, $suffix)
  if (-not $Passed) { $failures.Add($Name) }
}

<#
.SYNOPSIS
  Write a minimal but valid @deepseek-ai/dsh package into a directory.
#>
function New-DshPackage {
  param([string] $Directory, [string] $Version = '9.9.9')
  Write-TextFile -Path (Join-Path $Directory 'package.json') -Text (
    "{`n  `"name`": `"@deepseek-ai/dsh`",`n  `"version`": `"$Version`"`n}`n")
  Write-TextFile -Path (Join-Path $Directory 'lib/bin.js') -Text "// fixture entry`n"
}

<#
.SYNOPSIS
  Run Resolve-DshInstall with PATH and the well-known roots aimed at a fixture.
#>
function Invoke-Resolve {
  param([string] $PathValue, [string] $AppData, [string] $LocalAppData, [string] $Override, [hashtable] $Extra = @{})
  $env:PATH = $PathValue
  $env:APPDATA = $AppData
  $env:LOCALAPPDATA = $LocalAppData
  $env:USERPROFILE = Join-Path $fixtureRoot 'home'
  $env:DSH_INSTALL_ANCHOR = ''
  foreach ($key in $Extra.Keys) { Set-Item -Path ("Env:" + $key) -Value $Extra[$key] }
  try {
    # -Override is always passed (as '' when the case does not use it) so the
    # function never falls back to the caller's own environment anchor.
    return Resolve-DshInstall $Override
  } finally {
    foreach ($key in $Extra.Keys) { Remove-Item -Path ("Env:" + $key) -ErrorAction SilentlyContinue }
  }
}

# The shim npm writes for a global/prefix install (verbatim shape from npm).
$npmCmdShim = @'
@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@deepseek-ai\dsh\lib\bin.js" %*
'@

# The same shim npm writes into <root>/node_modules/.bin: one '..' segment.
$npmBinShim = $npmCmdShim.Replace('%dp0%\node_modules\', '%dp0%\..\node_modules\')

# The PowerShell shim (a different base variable and forward slashes).
$npmPs1Shim = @'
#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
  & "$basedir/node$exe"  "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" $args
  $ret=$LASTEXITCODE
} else {
  & "node$exe"  "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" $args
  $ret=$LASTEXITCODE
}
exit $ret
'@

$emptyAppData = Join-Path $fixtureRoot 'appdata-empty'
$emptyLocalAppData = Join-Path $fixtureRoot 'localappdata-empty'
New-Item -ItemType Directory -Force -Path $emptyAppData, $emptyLocalAppData, (Join-Path $fixtureRoot 'home') | Out-Null

try {
  Write-Host "resolve-dshinstall: fixtures in $fixtureRoot"

  # --- npm prefix install: shim beside node_modules ------------------------------
  $prefix = Join-Path $fixtureRoot 'npm-prefix'
  New-DshPackage (Join-Path $prefix 'node_modules/@deepseek-ai/dsh')
  Write-TextFile -Path (Join-Path $prefix 'dsh.cmd') -Text $npmCmdShim
  Write-TextFile -Path (Join-Path $prefix 'dsh.ps1') -Text $npmPs1Shim
  $expected = Convert-DshPath (Join-Path $prefix 'node_modules/@deepseek-ai/dsh/package.json')
  $actual = Convert-DshPath (Invoke-Resolve -PathValue $prefix -AppData $emptyAppData -LocalAppData $emptyLocalAppData)
  Add-Result 'npm prefix shim (cmd, %dp0%)' ($actual -eq $expected) $actual

  # --- npm prefix install, ps1 shim only ----------------------------------------
  $prefixPs1 = Join-Path $fixtureRoot 'npm-prefix-ps1'
  New-DshPackage (Join-Path $prefixPs1 'node_modules/@deepseek-ai/dsh')
  Write-TextFile -Path (Join-Path $prefixPs1 'dsh.ps1') -Text $npmPs1Shim
  $expected = Convert-DshPath (Join-Path $prefixPs1 'node_modules/@deepseek-ai/dsh/package.json')
  $actual = Convert-DshPath (Invoke-Resolve -PathValue $prefixPs1 -AppData $emptyAppData -LocalAppData $emptyLocalAppData)
  Add-Result 'npm prefix shim (ps1, $basedir)' ($actual -eq $expected) $actual

  # --- npm local install: shim inside node_modules/.bin -------------------------
  $local = Join-Path $fixtureRoot 'npm-local'
  New-DshPackage (Join-Path $local 'node_modules/@deepseek-ai/dsh')
  Write-TextFile -Path (Join-Path $local 'node_modules/.bin/dsh.cmd') -Text $npmBinShim
  $binDir = Join-Path $local 'node_modules/.bin'
  $expected = Convert-DshPath (Join-Path $local 'node_modules/@deepseek-ai/dsh/package.json')
  $actual = Convert-DshPath (Invoke-Resolve -PathValue $binDir -AppData $emptyAppData -LocalAppData $emptyLocalAppData)
  Add-Result 'npm local .bin shim (..\node_modules)' ($actual -eq $expected) $actual

  # --- pnpm global: shim in the pnpm bin directory, package in the store --------
  $pnpmHome = Join-Path $fixtureRoot 'pnpm'
  $vstore = Join-Path $pnpmHome 'global/5/.pnpm/@deepseek-ai+dsh@9.9.9_abcdef/node_modules/@deepseek-ai/dsh'
  New-DshPackage $vstore
  $pnpmShim = $npmCmdShim.Replace(
    '%dp0%\node_modules\@deepseek-ai\dsh\lib\bin.js',
    '%dp0%\global\5\.pnpm\@deepseek-ai+dsh@9.9.9_abcdef\node_modules\@deepseek-ai\dsh\lib\bin.js')
  Write-TextFile -Path (Join-Path $pnpmHome 'dsh.cmd') -Text $pnpmShim
  $expected = Convert-DshPath (Join-Path $vstore 'package.json')
  $actual = Convert-DshPath (Invoke-Resolve -PathValue $pnpmHome -AppData $emptyAppData -LocalAppData $emptyLocalAppData)
  Add-Result 'pnpm global shim (store path with + and @)' ($actual -eq $expected) $actual

  # --- pnpm global via %PNPM_HOME% and the known global root --------------------
  $customHome = Join-Path $fixtureRoot 'pnpm-home'
  $customVstore = Join-Path $customHome 'store/node_modules/@deepseek-ai/dsh'
  New-DshPackage $customVstore
  Write-TextFile -Path (Join-Path $customHome 'dsh.cmd') -Text (
    "@ECHO off`nnode `"%PNPM_HOME%\store\node_modules\@deepseek-ai\dsh\lib\bin.js`" %*`n")
  $expected = Convert-DshPath (Join-Path $customVstore 'package.json')
  $actual = Convert-DshPath (Invoke-Resolve -PathValue $customHome -AppData $emptyAppData -LocalAppData $emptyLocalAppData -Extra @{ PNPM_HOME = $customHome })
  Add-Result 'shim referencing %PNPM_HOME%' ($actual -eq $expected) $actual

  $knownHome = Join-Path $fixtureRoot 'pnpm-known'
  $knownStore = Join-Path $knownHome 'pnpm/global/5/node_modules/@deepseek-ai/dsh'
  New-DshPackage $knownStore
  $opaqueBin = Join-Path $knownHome 'bin'
  New-Item -ItemType Directory -Force -Path $opaqueBin | Out-Null
  Write-TextFile -Path (Join-Path $opaqueBin 'dsh.cmd') -Text "@ECHO off`nnode `"launcher.js`" %*`n"
  $expected = Convert-DshPath (Join-Path $knownStore 'package.json')
  $actual = Convert-DshPath (Invoke-Resolve -PathValue $opaqueBin -AppData $emptyAppData -LocalAppData $knownHome)
  Add-Result 'opaque shim falls back to the pnpm global root' ($actual -eq $expected) $actual

  # --- nvm-windows: no shim on PATH, package under %APPDATA%\nvm\<version> ------
  $nvmAppData = Join-Path $fixtureRoot 'appdata-nvm'
  $nvmPackage = Join-Path $nvmAppData 'nvm/v22.11.0/node_modules/@deepseek-ai/dsh'
  New-DshPackage $nvmPackage
  $noShimDir = Join-Path $fixtureRoot 'no-shim'
  New-Item -ItemType Directory -Force -Path $noShimDir | Out-Null
  $expected = Convert-DshPath (Join-Path $nvmPackage 'package.json')
  $actual = Convert-DshPath (Invoke-Resolve -PathValue $noShimDir -AppData $nvmAppData -LocalAppData $emptyLocalAppData)
  Add-Result 'nvm per-version root is discovered without a shim' ($actual -eq $expected) $actual

  # --- an explicit -DshInstall always wins --------------------------------------
  $expected = Convert-DshPath (Join-Path $prefix 'node_modules/@deepseek-ai/dsh/package.json')
  $actual = Convert-DshPath (Invoke-Resolve -PathValue $noShimDir -AppData $emptyAppData -LocalAppData $emptyLocalAppData -Override (Join-Path $prefix 'node_modules/@deepseek-ai/dsh'))
  Add-Result '-DshInstall directory is honoured' ($actual -eq $expected) $actual

  # --- nothing anywhere must fail loudly ----------------------------------------
  $threw = $false
  $message = ''
  try {
    $null = Invoke-Resolve -PathValue $noShimDir -AppData $emptyAppData -LocalAppData $emptyLocalAppData
  } catch {
    $threw = $true
    $message = $_.Exception.Message
  }
  Add-Result 'a missing dsh is reported, not guessed' ($threw -and $message -match '-DshInstall') $message
} finally {
  if (Test-Path $fixtureRoot) { Remove-Item -Recurse -Force $fixtureRoot -ErrorAction SilentlyContinue }
}

Write-Host ("resolve-dshinstall: {0} checks, {1} failed" -f $checks, $failures.Count)
if ($failures.Count -gt 0) {
  Write-Host ("resolve-dshinstall: FAILED -- " + ($failures -join ', '))
  exit 1
}
Write-Host 'resolve-dshinstall: OK'
exit 0
