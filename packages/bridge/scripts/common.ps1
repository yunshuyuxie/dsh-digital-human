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
  Return the path of a candidate's package.json when it really is
  @deepseek-ai/dsh, and $null otherwise.
#>
function Test-DshManifest {
  param([string] $Candidate)
  if (-not $Candidate) { return $null }
  $manifestPath = if ($Candidate.EndsWith('package.json')) { $Candidate } else { Join-Path $Candidate 'package.json' }
  if (-not (Test-Path -LiteralPath $manifestPath)) { return $null }
  try {
    $manifest = (Read-TextFile $manifestPath) | ConvertFrom-Json
    if ((Get-PropertyValue -Object $manifest -Name 'name') -eq '@deepseek-ai/dsh') { return $manifestPath }
  } catch {
    return $null
  }
  return $null
}

<#
.SYNOPSIS
  Fold '/' separators and '..' segments out of a path without touching the
  filesystem (the target of a shim may not exist).
#>
function Convert-DshPath {
  param([string] $Path)
  if (-not $Path) { return $null }
  $stack = [System.Collections.Generic.List[string]]::new()
  foreach ($part in @(($Path -replace '/', '\') -split '\\')) {
    if (-not $part -or $part -eq '.') { continue }
    if ($part -eq '..') {
      $atDriveRoot = ($stack.Count -eq 1 -and $stack[0] -match '^[A-Za-z]:$')
      if ($stack.Count -gt 0 -and -not $atDriveRoot) { $stack.RemoveAt($stack.Count - 1) }
      continue
    }
    $stack.Add($part)
  }
  if ($stack.Count -eq 0) { return $null }
  $joined = ($stack -join '\')
  if ($stack.Count -eq 1 -and $stack[0] -match '^[A-Za-z]:$') { return $joined + '\' }
  return $joined
}

<#
.SYNOPSIS
  Package roots named by a `dsh` bin shim's own body.

.DESCRIPTION
  Every shim npm, pnpm or yarn generates launches the entry script of the
  package it belongs to, and names it as '%dp0%\<relative>', '$basedir/<relative>'
  or an absolute path. Resolving that reference is what makes discovery work
  across layouts, because only one of them (a local install) puts the shim in
  <root>/node_modules/.bin.

  The reference continues past the package directory (for example '\lib\bin.js'),
  so the manifest directory is the segment that ends in 'dsh'.
#>
function Get-DshRootsFromShim {
  param([string] $ShimPath)
  $roots = [System.Collections.Generic.List[string]]::new()
  $text = Read-TextFile $ShimPath
  if (-not $text) { return $roots }
  $shimDir = Split-Path -Parent $ShimPath
  $pattern = 'node_modules[\\/](?:@[A-Za-z0-9._~-]+[\\/])?dsh(?=[\\/]|$)'
  $leftChars = '[A-Za-z0-9_~%.$\\/:@+-]'
  $rightChars = '[A-Za-z0-9_~$.\\/:@+-]'
  foreach ($match in [regex]::Matches($text, $pattern)) {
    $start = $match.Index
    while ($start -gt 0 -and ("$($text[$start - 1])" -match $leftChars)) { $start-- }
    $end = $match.Index + $match.Length
    while ($end -lt $text.Length -and ("$($text[$end])" -match $rightChars)) { $end++ }
    $token = $text.Substring($start, $end - $start)

    $variable = [regex]::Match($token, '^(%~?dp0%|\$basedir)')
    if ($variable.Success) {
      $relative = $token.Substring($variable.Groups[1].Length)
      if (-not $relative.StartsWith('\') -and -not $relative.StartsWith('/')) { $relative = '/' + $relative }
      $resolved = Convert-DshPath (Join-Path $shimDir $relative)
    } elseif ($token.StartsWith('%')) {
      # '%PNPM_HOME%\...' and friends: expand every leading %NAME% (dp0 is
      # already handled above). An unknown name makes the token unusable.
      $expanded = $token
      while ($expanded -match '^%([A-Za-z_][A-Za-z0-9_]*)%(.*)$') {
        $name = $Matches[1]
        $rest = $Matches[2]
        $value = Get-PropertyValue -Object (Get-Item -Path ("Env:" + $name) -ErrorAction SilentlyContinue) -Name 'Value'
        if (-not $value) { $expanded = $null; break }
        $expanded = "$value$rest"
      }
      $resolved = if ($expanded) { Convert-DshPath $expanded } else { $null }
    } elseif ($token -match '^[A-Za-z]:[\\/]' -or $token.StartsWith('\\') -or $token.StartsWith('/')) {
      $resolved = Convert-DshPath $token
    } else {
      # A bare relative reference (npm's fallback branch) is read as relative to
      # the shim directory; a wrong guess only fails the manifest check later.
      $resolved = Convert-DshPath (Join-Path $shimDir $token)
    }
    if (-not $resolved) { continue }

    $inner = [regex]::Match($resolved, 'node_modules[\\/](?:@[A-Za-z0-9._~-]+[\\/])?dsh')
    $root = if ($inner.Success) { $resolved.Substring(0, $inner.Index + $inner.Length) } else { $resolved }
    if (-not $roots.Contains($root)) { $roots.Add($root) }
  }
  return $roots
}

<#
.SYNOPSIS
  Global roots dsh is commonly installed into, independent of PATH.
#>
function Get-KnownDshRoots {
  $roots = [System.Collections.Generic.List[string]]::new()
  if ($env:APPDATA) {
    # npm's default user prefix; nvm-windows keeps one node per version, each
    # with its own global node_modules, below the same roaming directory.
    $roots.Add((Join-Path $env:APPDATA 'npm/node_modules/@deepseek-ai/dsh'))
    $nvmDir = Join-Path $env:APPDATA 'nvm'
    if (Test-Path -LiteralPath $nvmDir -PathType Container) {
      foreach ($version in (Get-ChildItem -LiteralPath $nvmDir -Directory -Force -ErrorAction SilentlyContinue)) {
        $roots.Add((Join-Path $version.FullName 'node_modules/@deepseek-ai/dsh'))
      }
    }
  }
  if ($env:LOCALAPPDATA) {
    # pnpm keeps its global bin directory on PATH but the package itself in a
    # store below it: <localAppData>/pnpm/global/<store>/node_modules/...
    $pnpmGlobal = Join-Path $env:LOCALAPPDATA 'pnpm/global'
    if (Test-Path -LiteralPath $pnpmGlobal -PathType Container) {
      foreach ($store in (Get-ChildItem -LiteralPath $pnpmGlobal -Directory -Force -ErrorAction SilentlyContinue)) {
        $roots.Add((Join-Path $store.FullName 'node_modules/@deepseek-ai/dsh'))
      }
      $roots.Add((Join-Path $pnpmGlobal 'node_modules/@deepseek-ai/dsh'))
    }
  }
  $homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
  if ($homeDir) { $roots.Add((Join-Path $homeDir '.npm-global/node_modules/@deepseek-ai/dsh')) }
  return $roots
}

<#
.SYNOPSIS
  Locate the installed @deepseek-ai/dsh package.

.DESCRIPTION
  `dsh` reaches PATH through several layouts and the shim's own directory only
  implies the package location in one of them:

    * npm prefix, npm global, nvm:  <prefix>/dsh.cmd  with the package in
      <prefix>/node_modules/@deepseek-ai/dsh;
    * npm or pnpm local install:    <root>/node_modules/.bin/dsh.cmd  with the
      package in <root>/node_modules/@deepseek-ai/dsh;
    * pnpm global store:            <localAppData>/pnpm/dsh.cmd  with the
      package in <localAppData>/pnpm/global/<store>/node_modules/@deepseek-ai/dsh.

  The shim body is therefore the primary evidence (Get-DshRootsFromShim), the
  known global roots come next, and a local `npm prefix -g` / `pnpm root -g`
  query - neither reads the registry nor installs anything - is the last
  resort for shims whose body carries no usable path. Every candidate must pass
  Test-DshManifest, so a wrong guess is skipped rather than trusted.
#>
function Resolve-DshInstall {
  param([string] $Override)
  foreach ($candidate in @($Override, $env:DSH_INSTALL_ANCHOR)) {
    $found = Test-DshManifest $candidate
    if ($found) { return $found }
  }

  foreach ($dir in ($env:PATH -split [System.IO.Path]::PathSeparator)) {
    if (-not $dir) { continue }
    foreach ($shim in @('dsh.cmd', 'dsh.bat', 'dsh.ps1', 'dsh')) {
      $shimPath = Join-Path $dir $shim
      if (-not (Test-Path -LiteralPath $shimPath)) { continue }
      foreach ($root in (Get-DshRootsFromShim -ShimPath $shimPath)) {
        $found = Test-DshManifest $root
        if ($found) { return $found }
      }
      # Legacy assumption, kept because it is exact for a .bin shim.
      $found = Test-DshManifest (Join-Path (Split-Path -Parent $dir) '@deepseek-ai/dsh')
      if ($found) { return $found }
      break
    }
  }

  foreach ($root in (Get-KnownDshRoots)) {
    $found = Test-DshManifest $root
    if ($found) { return $found }
  }

  $npmTool = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
  if (-not $npmTool) { $npmTool = Get-Command 'npm' -ErrorAction SilentlyContinue }
  if ($npmTool) {
    try {
      $prefix = "$((& $npmTool.Source 'prefix' '-g' 2>$null | Select-Object -First 1))".Trim()
      if ($prefix) {
        $found = Test-DshManifest (Join-Path $prefix 'node_modules/@deepseek-ai/dsh')
        if ($found) { return $found }
      }
    } catch {
      # npm is optional here: a failure only costs one candidate.
    }
  }
  $pnpmTool = Get-Command 'pnpm.cmd' -ErrorAction SilentlyContinue
  if (-not $pnpmTool) { $pnpmTool = Get-Command 'pnpm' -ErrorAction SilentlyContinue }
  if ($pnpmTool) {
    try {
      $globalRoot = "$((& $pnpmTool.Source 'root' '-g' 2>$null | Select-Object -First 1))".Trim()
      if ($globalRoot) {
        $found = Test-DshManifest (Join-Path $globalRoot '@deepseek-ai/dsh')
        if ($found) { return $found }
      }
    } catch {
      # pnpm is optional here too.
    }
  }

  throw 'cannot find the installed @deepseek-ai/dsh -- pass -DshInstall <path to its package.json>; find it under the node_modules of the prefix that installed dsh (npm prefix -g, pnpm root -g)'
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
