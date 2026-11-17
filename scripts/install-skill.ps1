$ErrorActionPreference = 'Stop'
$source = Join-Path (Split-Path -Parent $PSScriptRoot) 'skills\provision-key'
$taskCodexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$taskSkillsDir = Join-Path $taskCodexDir 'skills'
$destination = Join-Path $taskSkillsDir 'provision-key'
if (Test-Path -LiteralPath $destination) {
    $entry = Join-Path $destination 'SKILL.md'
    if (-not (Test-Path -LiteralPath $entry) -or
        -not ((Get-Content -Raw -LiteralPath $entry) -match 'ZeroKey')) {
        throw 'An unrelated provision-key skill already exists; it was not changed.'
    }
}
New-Item -ItemType Directory -Path (Join-Path $destination 'agents') -Force | Out-Null
$taskProjectPath = (Split-Path -Parent $PSScriptRoot).Replace('\', '/')
$taskSkillText = (Get-Content -Raw -LiteralPath (Join-Path $source 'SKILL.md')).Replace('<ZEROKEY_SOURCE>', $taskProjectPath)
[System.IO.File]::WriteAllText((Join-Path $destination 'SKILL.md'), $taskSkillText, [System.Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $source 'agents\openai.yaml') -Destination (Join-Path $destination 'agents\openai.yaml') -Force
Write-Output "Installed ZeroKey provision-key skill: $destination"
