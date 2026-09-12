<#
.SYNOPSIS
  Shared helpers for the offline install / uninstall / verify scripts.

.DESCRIPTION
  Dot-source this file. Everything here is pure filesystem work: no pnpm, no
  registry, no network.

  Two host quirks drive the implementation and must not be undone:

    * The Windows PowerShell 5.1 that ships with this host decodes
      `Get-Content -Raw` with the ANSI code page and writes `-Encoding UTF8`
      WITH a byte order mark. Both corrupt non-ASCII content and a BOM breaks
      `JSON.parse`. Every text read/write therefore goes through
      Read-TextFile / Write-TextFile, which use .NET UTF-8 without a BOM.
    * `Set-StrictMode -Version Latest` turns a missing property into an error,
      so optional manifest fields are read through Get-PropertyValue.

  Script comments and messages stay ASCII-only for the same reason.
#>

Set-StrictMode -Version Latest

<#
.SYNOPSIS
  Read a text file as UTF-8 without a BOM.
#>
function Read-TextFile {
  param([string] $Path)
  if (-not (Test-Path $Path)) { return $null }
  return [System.IO.File]::ReadAllText($Path, [System.Text.UTF8Encoding]::new($false))
}

<#
.SYNOPSIS
  Write a text file as UTF-8 without a BOM.
#>
function Write-TextFile {
  param([string] $Path, [string] $Text)
  $directory = Split-Path -Parent $Path
  if ($directory -and -not (Test-Path $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

<#
.SYNOPSIS
  Read a property that may be absent, returning a default instead of throwing.
#>
function Get-PropertyValue {
  param($Object, [string] $Name, $Default = $null)
  if ($null -eq $Object) { return $Default }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $Default }
  return $property.Value
}

<#
.SYNOPSIS
  Locate a file that sits beside the package in one layout and beside the
  scripts in the other.

.DESCRIPTION
  The same scripts run from two layouts:

    * development:  <package>/scripts/<script>.ps1  with the payload in <package>
    * packed:       <zip root>/<script>.ps1         with the payload in <zip root>/package

  So a sibling file such as compat.json or CHECKSUMS.txt is looked up in the
  script directory first (packed) and then its parent (development).
#>
function Resolve-SideFile {
  param([string] $ScriptRoot, [string] $Name)
  foreach ($root in @($ScriptRoot, (Split-Path -Parent $ScriptRoot))) {
    $candidate = Join-Path $root $Name
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

<#
.SYNOPSIS
  Locate one of this package's Node tools across both layouts.

.DESCRIPTION
  The tools live inside the package (`package/tools` when packed, `tools` in the
  repository) and the scripts live beside the payload, so a lookup must try the
  payload first and the script directory second.
#>
function Resolve-ToolScript {
  param([string] $PackageRoot, [string] $ScriptRoot, [string] $Name)
  $candidates = @(
    (Join-Path $PackageRoot "tools/$Name"),
    (Join-Path $ScriptRoot "tools/$Name"),
    (Join-Path (Split-Path -Parent $ScriptRoot) "tools/$Name")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

<#
.SYNOPSIS
  Resolve the payload directory across both layouts.

.DESCRIPTION
    * packed:       <zip root>/<script>.ps1 with the payload in <zip root>/package
    * development:  <package>/scripts/<script>.ps1, so the payload is the parent

  Passing an explicit override skips discovery.
#>
function Resolve-PackageRoot {
  param([string] $ScriptRoot, [string] $Override)
  if ($Override) { return $Override }
  foreach ($candidate in @((Join-Path $ScriptRoot 'package'), (Split-Path -Parent $ScriptRoot))) {
    if (Test-Path (Join-Path $candidate 'package.json')) { return $candidate }
  }
  throw 'no package.json found in package/ beside the scripts or in their parent; pass -PackageRoot'
}

<#
.SYNOPSIS
  Run a Node script and report its outcome without ever reading an unset
  $LASTEXITCODE (Set-StrictMode makes that an error, and the value stays unset
  when the executable cannot even be started).
#>
function Invoke-NodeTool {
  param([string] $Script, [object[]] $Arguments = @())
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    return [pscustomobject]@{ ok = $false; exitCode = 127; output = @('node is not on PATH') }
  }
  if (-not (Test-Path $Script)) {
    return [pscustomobject]@{ ok = $false; exitCode = 127; output = @("script not found: $Script") }
  }
  $LASTEXITCODE = 0
  $lines = & $node.Source @($Script) @($Arguments) 2>&1
  $code = $LASTEXITCODE
  $text = @($lines | ForEach-Object { "$_" })
  return [pscustomobject]@{ ok = ($code -eq 0); exitCode = $code; output = $text }
}

<#
.SYNOPSIS
  Resolve the dsh home directory.
#>
function Resolve-DshHome {
  param([string] $Override)
  if ($Override) { return $Override }
  if ($env:DSH_HOME) { return $env:DSH_HOME }
  return (Join-Path $HOME '.dsh')
}

<#
.SYNOPSIS
  Resolve one profile directory, asserting it exists.
#>
function Resolve-ProfileDir {
  param([string] $DshHome, [string] $Profile)
  $dir = Join-Path $DshHome "profiles/$Profile"
  if (-not (Test-Path $dir)) {
    throw "profile '$Profile' does not exist at $dir -- boot it once with: dsh --profile $Profile"
  }
  return $dir
}

<#
.SYNOPSIS
  Locate the installed @deepseek-ai/dsh package by scanning PATH for its bin shim.
#>
function Resolve-DshInstall {
  param([string] $Override)
  $candidates = @()
  if ($Override) { $candidates += $Override }
  if ($env:DSH_INSTALL_ANCHOR) { $candidates += $env:DSH_INSTALL_ANCHOR }
  foreach ($dir in ($env:PATH -split [System.IO.Path]::PathSeparator)) {
    if (-not $dir) { continue }
    foreach ($shim in @('dsh.ps1', 'dsh.cmd', 'dsh.bat', 'dsh')) {
      if (Test-Path (Join-Path $dir $shim)) {
        $candidates += (Join-Path (Split-Path -Parent $dir) '@deepseek-ai/dsh/package.json')
        break
      }
    }
  }
  foreach ($candidate in $candidates) {
    $manifestPath = if ($candidate.EndsWith('package.json')) { $candidate } else { Join-Path $candidate 'package.json' }
    if (-not (Test-Path $manifestPath)) { continue }
    try {
      $manifest = (Read-TextFile $manifestPath) | ConvertFrom-Json
      if ((Get-PropertyValue -Object $manifest -Name 'name') -eq '@deepseek-ai/dsh') { return $manifestPath }
    } catch {
      continue
    }
  }
  throw 'cannot find the installed @deepseek-ai/dsh -- pass -DshInstall <path to its package.json>'
}

<#
.SYNOPSIS
  Compare two dotted versions, tolerating pre-release suffixes such as -rc.1.
  Returns -1 / 0 / 1. A pre-release sorts below its release (1.0.0-rc.1 < 1.0.0).
#>
function Compare-DshVersion {
  param([string] $Left, [string] $Right)
  function Convert-Part([string] $value) {
    $split = $value -split '-', 2
    $core = $split[0]
    $pre = if ($split.Count -gt 1) { $split[1] } else { '' }
    $numbers = @()
    foreach ($piece in ($core -split '\.')) {
      $digits = ($piece -replace '[^0-9].*$', '')
      if (-not $digits) { $digits = '0' }
      $numbers += [int]$digits
    }
    while ($numbers.Count -lt 3) { $numbers += 0 }
    return @{ numbers = $numbers; pre = $pre }
  }
  $a = Convert-Part $Left
  $b = Convert-Part $Right
  for ($i = 0; $i -lt 3; $i++) {
    if ($a.numbers[$i] -ne $b.numbers[$i]) { return [Math]::Sign($a.numbers[$i] - $b.numbers[$i]) }
  }
  if ($a.pre -eq $b.pre) { return 0 }
  if (-not $a.pre) { return 1 }
  if (-not $b.pre) { return -1 }
  return [Math]::Sign(([string]::CompareOrdinal($a.pre, $b.pre)))
}

<#
.SYNOPSIS
  Assert the installed dsh version satisfies a compat range.

.DESCRIPTION
  Supports the two clause shapes compat.json uses: '>=x.y.z' (minimum) and
  '<x.y.z' (exclusive upper bound).
#>
function Assert-DshCompatible {
  param([string] $InstalledVersion, [string[]] $Range)
  foreach ($clause in $Range) {
    $text = "$clause".Trim()
    if ($text -match '^>=\s*(.+)$') {
      if ((Compare-DshVersion $InstalledVersion $Matches[1]) -lt 0) {
        throw "installed dsh $InstalledVersion is older than the required $text"
      }
      continue
    }
    if ($text -match '^<\s*(.+)$') {
      if ((Compare-DshVersion $InstalledVersion $Matches[1]) -ge 0) {
        throw "installed dsh $InstalledVersion is not below the exclusive bound $text"
      }
      continue
    }
    throw "unsupported compat clause '$clause'"
  }
}

<#
.SYNOPSIS
  Back up a file next to itself, returning the backup path (or $null).
#>
function Backup-File {
  param([string] $Path)
  if (-not (Test-Path $Path)) { return $null }
  $stamp = Get-Date -Format 'yyyyMMddHHmmss'
  $backup = "$Path.bak-$stamp"
  Copy-Item -Path $Path -Destination $backup -Force
  return $backup
}

<#
.SYNOPSIS
  Read a junction's target, or $null when the path is not a link.
#>
function Get-JunctionTarget {
  param([string] $Link)
  if (-not (Test-Path $Link)) { return $null }
  $item = Get-Item -Force $Link
  $target = Get-PropertyValue -Object $item -Name 'Target'
  if ($null -eq $target) { return $null }
  if ($target -is [array]) { return ($target | Select-Object -First 1) }
  return [string]$target
}

<#
.SYNOPSIS
  Create (or replace) a directory junction without ever touching its target.
#>
function Set-PluginJunction {
  param([string] $Link, [string] $Target)
  if (Test-Path $Link) {
    # Delete() removes the reparse point itself; Remove-Item -Recurse could
    # follow the junction and delete the target's contents.
    (Get-Item -Force $Link).Delete()
  }
  New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null
}

<#
.SYNOPSIS
  Remove a junction if present, never its target.
#>
function Remove-PluginJunction {
  param([string] $Link)
  if (-not (Test-Path $Link)) { return $false }
  (Get-Item -Force $Link).Delete()
  return $true
}

<#
.SYNOPSIS
  Read the dependency spec recorded for a package in a profile manifest.
#>
function Get-ProfileDependency {
  param([string] $ManifestPath, [string] $PackageName)
  $text = Read-TextFile $ManifestPath
  if (-not $text) { return $null }
  $match = [regex]::Match($text, '"' + [regex]::Escape($PackageName) + '"\s*:\s*"([^"]*)"')
  if (-not $match.Success) { return $null }
  return $match.Groups[1].Value
}

<#
.SYNOPSIS
  Insert or replace one dependency entry, preserving the rest of the file.
#>
function Set-ProfileDependency {
  param([string] $ManifestPath, [string] $PackageName, [string] $Spec)
  $text = Read-TextFile $ManifestPath
  if ($null -eq $text) { throw "cannot read $ManifestPath" }
  $escapedName = [regex]::Escape($PackageName)

  $existing = [regex]::Match($text, '(\s*)"' + $escapedName + '"\s*:\s*"([^"]*)"(,?)')
  if ($existing.Success) {
    $replacement = $existing.Groups[1].Value + '"' + $PackageName + '": "' + $Spec + '"' + $existing.Groups[3].Value
    $text = $text.Remove($existing.Index, $existing.Length).Insert($existing.Index, $replacement)
    Write-TextFile -Path $ManifestPath -Text $text
    return 'replaced'
  }

  # An empty dependencies object needs the entry WITHOUT a trailing comma,
  # otherwise the inserted comma lands directly before the closing brace.
  $emptyDependencies = [regex]::Match($text, '("dependencies"\s*:\s*\{)\s*(\})')
  if ($emptyDependencies.Success) {
    $replacement = $emptyDependencies.Groups[1].Value + "`n    `"$PackageName`": `"$Spec`"`n  " + $emptyDependencies.Groups[2].Value
    $text = $text.Remove($emptyDependencies.Index, $emptyDependencies.Length).Insert($emptyDependencies.Index, $replacement)
    Write-TextFile -Path $ManifestPath -Text $text
    return 'inserted-empty'
  }

  $dependencies = [regex]::Match($text, '"dependencies"\s*:\s*\{')
  if ($dependencies.Success) {
    $insertAt = $dependencies.Index + $dependencies.Length
    $text = $text.Insert($insertAt, "`n    `"$PackageName`": `"$Spec`",")
    Write-TextFile -Path $ManifestPath -Text $text
    return 'inserted'
  }

  $closing = $text.LastIndexOf('}')
  if ($closing -lt 0) { throw "cannot find the root object in $ManifestPath" }
  $block = "  `"dependencies`": {`n    `"$PackageName`": `"$Spec`"`n  },`n"
  $text = $text.Insert($closing, $block)
  Write-TextFile -Path $ManifestPath -Text $text
  return 'added-block'
}

<#
.SYNOPSIS
  Remove one dependency entry, tolerating either a leading or trailing comma.
#>
function Remove-ProfileDependency {
  param([string] $ManifestPath, [string] $PackageName)
  $text = Read-TextFile $ManifestPath
  if (-not $text) { return $false }
  $escapedName = [regex]::Escape($PackageName)

  $match = [regex]::Match($text, ',\s*\r?\n\s*"' + $escapedName + '"\s*:\s*"[^"]*"')
  if ($match.Success) {
    $text = $text.Remove($match.Index, $match.Length)
  } else {
    $match = [regex]::Match($text, '\s*"' + $escapedName + '"\s*:\s*"[^"]*"\s*,?')
    if (-not $match.Success) { return $false }
    $text = $text.Remove($match.Index, $match.Length)
  }
  Write-TextFile -Path $ManifestPath -Text $text
  return $true
}

<#
.SYNOPSIS
  Validate that a manifest still parses as JSON after an edit.
#>
function Assert-ManifestParses {
  param([string] $ManifestPath)
  $text = Read-TextFile $ManifestPath
  try {
    $null = $text | ConvertFrom-Json
  } catch {
    throw "profile manifest $ManifestPath no longer parses as JSON: $($_.Exception.Message)"
  }
}

<#
.SYNOPSIS
  Read the managed row block for one package out of a patch file.
#>
function Get-PatchBlock {
  param([string] $PatchPath, [string] $PackageName)
  $text = Read-TextFile $PatchPath
  if (-not $text) { return $null }
  $start = "# >>> $PackageName (managed) >>>"
  $end = "# <<< $PackageName (managed) <<<"
  $startIndex = $text.IndexOf($start)
  $endIndex = $text.IndexOf($end)
  if ($startIndex -lt 0 -or $endIndex -le $startIndex) { return $null }
  return $text.Substring($startIndex, $endIndex - $startIndex)
}

<#
.SYNOPSIS
  Replace (or append) the managed row block in a patch file, preserving every
  other line verbatim. Passing empty -Rows removes the block.
#>
function Set-PatchBlock {
  param([string] $PatchPath, [string] $PackageName, [string] $Rows)
  $start = "# >>> $PackageName (managed) >>>"
  $end = "# <<< $PackageName (managed) <<<"
  $existing = Read-TextFile $PatchPath
  if ($null -eq $existing) { $existing = '' }

  $kept = [System.Collections.Generic.List[string]]::new()
  $inside = $false
  foreach ($line in ($existing -split "\r?\n")) {
    if ($line.Trim() -eq $start) { $inside = $true; continue }
    if ($line.Trim() -eq $end) { $inside = $false; continue }
    if (-not $inside) { $kept.Add($line) }
  }
  while ($kept.Count -gt 0 -and $kept[$kept.Count - 1].Trim() -eq '') { $kept.RemoveAt($kept.Count - 1) }

  # Drop the shipped empty-array placeholder. `[]` is a complete YAML document,
  # so appending sequence items after it would not parse; the shipped profile
  # template starts with exactly that placeholder.
  $hasEntries = $false
  foreach ($line in $kept) {
    $trimmed = $line.Trim()
    if ($trimmed -eq '' -or $trimmed.StartsWith('#') -or $trimmed -eq '[]') { continue }
    $hasEntries = $true
    break
  }
  if (-not $hasEntries) {
    $commentsOnly = [System.Collections.Generic.List[string]]::new()
    foreach ($line in $kept) {
      if ($line.Trim().StartsWith('#')) { $commentsOnly.Add($line) }
    }
    $kept = $commentsOnly
  }

  $body = ($kept -join "`n").TrimEnd()
  $trimmedRows = if ($Rows) { "$Rows".Trim() } else { '' }
  if ($trimmedRows) {
    $body = $body + "`n`n" + $start + "`n" + $trimmedRows + "`n" + $end + "`n"
  } else {
    $body = $body + "`n"
  }
  Write-TextFile -Path $PatchPath -Text $body
}
