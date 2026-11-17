$ErrorActionPreference = 'Stop'
if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core') { throw 'Release packaging currently supports Windows x64.' }
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskRuntime = Join-Path $taskRoot 'src-tauri/resources/runtime'
$taskNode = Join-Path $taskRuntime 'node.exe'
$taskVersion = 'v24.22.3'
$taskHash = '86fc4785327db5f5c7558dc6156c543b433c313e813a222e088086222ab4afa6'
function Get-RuntimeHash([string]$Path) {
    $taskStream = [IO.File]::OpenRead($Path)
    $taskSha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($taskSha.ComputeHash($taskStream))).Replace('-', '').ToLowerInvariant() }
    finally { $taskStream.Dispose(); $taskSha.Dispose() }
}
New-Item -ItemType Directory -Force -Path $taskRuntime | Out-Null
if (-not (Test-Path -LiteralPath $taskNode) -or (Get-RuntimeHash $taskNode) -ne $taskHash) {
    Invoke-WebRequest "https://nodejs.org/dist/$taskVersion/win-x64/node.exe" -OutFile $taskNode
}
if ((Get-RuntimeHash $taskNode) -ne $taskHash) { throw 'Node runtime checksum mismatch.' }
Invoke-WebRequest "https://raw.githubusercontent.com/nodejs/node/$taskVersion/LICENSE" -OutFile (Join-Path $taskRuntime 'LICENSE')
$taskManifest = '{"version":"' + $taskVersion + '","sha256":"' + $taskHash + '"}'
[IO.File]::WriteAllText((Join-Path $taskRuntime 'manifest.json'), $taskManifest)
Write-Output "Verified bundled Node $taskVersion (Windows x64)."
