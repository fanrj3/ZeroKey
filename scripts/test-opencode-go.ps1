param(
    [string]$Gateway = 'http://127.0.0.1:4000',
    [string]$Model = 'opencode-go/gpt-6-luna',
    [string]$Prompt = 'Reply with exactly: OK',
    [string]$SessionId
)

$ErrorActionPreference = 'Stop'

function Read-EnvValue([string]$Path, [string]$Name) {
    $line = Get-Content -LiteralPath $Path |
        Where-Object { $_.StartsWith($Name + '=') } |
        Select-Object -First 1
    if (-not $line) { throw "Missing $Name in $Path" }
    return $line.Substring($Name.Length + 1).Trim()
}

if ([string]::IsNullOrWhiteSpace($SessionId)) {
    $SessionId = 'ses_zerokey_' + [guid]::NewGuid().ToString('N')
}

$envPath = Join-Path (Split-Path -Parent $PSScriptRoot) '.env'
$master = Read-EnvValue $envPath 'LITELLM_MASTER_KEY'
$body = @{
    model = $Model
    input = $Prompt
    max_output_tokens = 64
} | ConvertTo-Json -Depth 10

try {
    $response = Invoke-RestMethod `
        -Method Post `
        -Uri "$Gateway/v1/responses" `
        -Headers @{
            Authorization = "Bearer $master"
            'x-litellm-session-id' = $SessionId
        } `
        -ContentType 'application/json' `
        -Body $body `
        -TimeoutSec 90
} catch {
    if ($_.Exception.Response) {
        $reader = [IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
        try { $details = $reader.ReadToEnd() } finally { $reader.Dispose() }
        throw "LiteLLM request failed with HTTP $([int]$_.Exception.Response.StatusCode): $details"
    }
    throw
}

$textParts = @(
    foreach ($item in @($response.output)) {
        foreach ($content in @($item.content)) {
            if ($content.type -eq 'output_text' -and $content.text) {
                [string]$content.text
            }
        }
    }
)
$text = $textParts -join ''
if ([string]::IsNullOrWhiteSpace($text)) {
    throw 'The model returned no output text.'
}

[pscustomobject]@{
    Model = $response.model
    SessionId = $SessionId
    Text = $text
    InputTokens = $response.usage.input_tokens
    OutputTokens = $response.usage.output_tokens
    TotalTokens = $response.usage.total_tokens
    Cost = $response.usage.cost
    BillingSource = $response.usage.opencode.billing_source
}
