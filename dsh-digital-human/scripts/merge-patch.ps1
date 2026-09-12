<#
.SYNOPSIS
  Merge the digital human's managed rows into a profile's cordis.patch.yml.

.DESCRIPTION
  Text-level merge with three guarantees:
    * rows are fenced by `# >>> dsh-digital-human (managed) >>>` markers, so a
      re-run replaces its own block instead of duplicating it;
    * every other line of the user's patch layer is preserved verbatim;
    * the `ui-approval` choice is sticky — without a switch, the merge keeps
      whatever the existing managed block records instead of silently reverting
      it.

  A patch file whose only content is the shipped placeholder `[]` is rewritten
  as a bare entry list; a file that already holds entries keeps them and gains
  the block after them.

.PARAMETER ProfileDir
  The profile directory holding cordis.patch.yml.

.PARAMETER OwnApprovals
  Hand permission confirmation to the digital human (emit the `ui-approval`
  disable row).

.PARAMETER NoOwnApprovals
  Give permission confirmation back to the shipped panel (drop the row).

.PARAMETER DryRun
  Print the merged document instead of writing it.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $ProfileDir,
  [switch] $OwnApprovals,
  [switch] $NoOwnApprovals,
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

if ($OwnApprovals -and $NoOwnApprovals) {
  throw 'merge-patch: -OwnApprovals and -NoOwnApprovals are mutually exclusive'
}

$markerStart = '# >>> dsh-digital-human (managed) >>>'
$markerEnd = '# <<< dsh-digital-human (managed) <<<'
$header = @(
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).'
)

$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'
$existing = if (Test-Path $patchPath) { Get-Content -Path $patchPath -Raw } else { '' }

# Read the previous managed block before stripping it: its `ui-approval` row is
# the sticky default when neither switch names a choice.
$previousBlock = ''
$startIndex = $existing.IndexOf($markerStart)
$endIndex = $existing.IndexOf($markerEnd)
if ($startIndex -ge 0 -and $endIndex -gt $startIndex) {
  $previousBlock = $existing.Substring($startIndex, $endIndex - $startIndex)
}
$ownApprovals = if ($OwnApprovals) { $true }
  elseif ($NoOwnApprovals) { $false }
  else { $previousBlock -match '(?m)^\s*-\s*id:\s*ui-approval' }

$block = @($markerStart, '- insert:', '    - id: digital-human', '      name: dsh-digital-human')
if ($ownApprovals) {
  $block += @(
    '',
    '# The avatar owns permission confirmation: the shipped composer panel would',
    '# otherwise answer each request first.',
    '- id: ui-approval',
    '  disabled: true'
  )
}
$block += $markerEnd

$kept = [System.Collections.Generic.List[string]]::new()
$inside = $false
foreach ($line in ($existing -split "\r?\n")) {
  if ($line.Trim() -eq $markerStart) { $inside = $true; continue }
  if ($line.Trim() -eq $markerEnd) { $inside = $false; continue }
  if (-not $inside) { $kept.Add($line) }
}
while ($kept.Count -gt 0 -and $kept[$kept.Count - 1].Trim() -eq '') { $kept.RemoveAt($kept.Count - 1) }

$body = ($kept -join "`n").TrimEnd()
$hadEntries = $false
foreach ($line in ($body -split "`n")) {
  $text = $line.Trim()
  if ($text -eq '' -or $text.StartsWith('#') -or $text -eq '[]') { continue }
  $hadEntries = $true
}
if (-not $hadEntries) { $body = ($header -join "`n") }

$content = $body.TrimEnd() + "`n`n" + ($block -join "`n") + "`n"
if ($DryRun) {
  Write-Output $content
  return
}
Set-Content -Path $patchPath -Value $content -Encoding UTF8 -NoNewline
$owner = if ($ownApprovals) { 'the digital human' } else { 'the shipped approval panel' }
Write-Output "merge-patch: wrote managed rows into $patchPath (permission confirmation -> $owner)"
