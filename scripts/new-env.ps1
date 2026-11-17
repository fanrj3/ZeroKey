param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot '.env'

if ((Test-Path -LiteralPath $envPath) -and -not $Force) {
    throw ".env already exists. Use -Force only if you intend to replace it."
}

function New-Secret([int]$Bytes = 32) {
    $raw = New-Object byte[] $Bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($raw)
    }
    finally {
        $rng.Dispose()
    }
    return ([System.BitConverter]::ToString($raw) -replace '-', '').ToLowerInvariant()
}

$lines = @(
    'LITELLM_IMAGE=ghcr.io/berriai/litellm:v1.109.0'
    'LITELLM_BIND=127.0.0.1'
    'LITELLM_PORT=4000'
    "LITELLM_MASTER_KEY=sk-$(New-Secret)"
    "LITELLM_SALT_KEY=sk-$(New-Secret)"
    "POSTGRES_PASSWORD=$(New-Secret)"
    'OPENAI_API_KEY='
    'GEMINI_API_KEY='
)

Set-Content -LiteralPath $envPath -Value $lines -Encoding UTF8
Write-Output ".env created at $envPath"
Write-Output 'Provider API keys are empty; add them to .env before making model requests.'
