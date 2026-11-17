# Compatibility wrapper. The maintained implementation is TypeScript.
param(
    [string]$ConfigDir = (Join-Path $env:USERPROFILE 'Downloads\config'),
    [string]$Gateway = 'http://127.0.0.1:4000',
    [switch]$IncludePayg
)
$ErrorActionPreference = 'Stop'
$taskScript = Join-Path $PSScriptRoot 'sync-sources.ts'
$taskArgs = @($taskScript, '--config-dir', $ConfigDir, '--gateway', $Gateway)
if ($IncludePayg) { $taskArgs += '--include-payg' }
& node @taskArgs
exit $LASTEXITCODE
