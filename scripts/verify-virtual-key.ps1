param(
    [string]$Gateway = 'http://127.0.0.1:4000',
    [string]$Model = 'opencode-go/gpt-6-luna',
    [string]$DeniedModel = 'bbai/gpt-5.6-luna'
)

$ErrorActionPreference = 'Stop'

function Read-EnvValue([string]$Path, [string]$Name) {
    $line = Get-Content -LiteralPath $Path |
        Where-Object { $_.StartsWith($Name + '=') } |
        Select-Object -First 1
    if (-not $line) { throw "Missing $Name in $Path" }
    return $line.Substring($Name.Length + 1).Trim()
}

function Invoke-JsonPost([string]$Uri, [hashtable]$Headers, [hashtable]$Body) {
    Invoke-RestMethod -Method Post -Uri $Uri -Headers $Headers -ContentType 'application/json' `
        -Body ($Body | ConvertTo-Json -Depth 10) -TimeoutSec 90
}

function Get-HttpStatus($ErrorRecord) {
    if ($ErrorRecord.Exception.Response) {
        return [int]$ErrorRecord.Exception.Response.StatusCode
    }
    return 0
}

$envPath = Join-Path (Split-Path -Parent $PSScriptRoot) '.env'
$master = Read-EnvValue $envPath 'LITELLM_MASTER_KEY'
$masterHeaders = @{ Authorization = "Bearer $master" }
$virtualKey = $null
$exhaustedKey = $null
$alias = 'zerokey-verify-' + [guid]::NewGuid().ToString('N')

try {
    $created = Invoke-JsonPost "$Gateway/key/generate" $masterHeaders @{
        models = @($Model)
        key_alias = $alias
        key_type = 'llm_api'
        max_budget = 1
        budget_duration = '1d'
    }
    $virtualKey = [string]$created.key
    if ([string]::IsNullOrWhiteSpace($virtualKey)) { throw 'LiteLLM did not return a virtual key.' }
    if ($null -ne $created.expires) { throw 'The default virtual key unexpectedly has an expiration date.' }

    $session = 'ses_zerokey_virtual_key_' + [guid]::NewGuid().ToString('N')
    $response = Invoke-JsonPost "$Gateway/v1/responses" @{
        Authorization = "Bearer $virtualKey"
        'x-litellm-session-id' = $session
    } @{
        model = $Model
        input = 'Reply with exactly: OK'
        max_output_tokens = 32
    }
    $text = @(
        foreach ($item in @($response.output)) {
            foreach ($content in @($item.content)) {
                if ($content.type -eq 'output_text' -and $content.text) { [string]$content.text }
            }
        }
    ) -join ''
    if ($text -ne 'OK') { throw "Allowed model returned unexpected text: $text" }

    $deniedStatus = 0
    try {
        Invoke-JsonPost "$Gateway/v1/responses" @{
            Authorization = "Bearer $virtualKey"
            'x-litellm-session-id' = ($session + '_denied')
        } @{
            model = $DeniedModel
            input = 'Reply with exactly: DENIED'
            max_output_tokens = 32
        } | Out-Null
    } catch {
        $deniedStatus = Get-HttpStatus $_
    }
    if ($deniedStatus -ne 403) { throw "Expected model restriction HTTP 403; received $deniedStatus." }

    $exhausted = Invoke-JsonPost "$Gateway/key/generate" $masterHeaders @{
        models = @($Model)
        key_alias = ($alias + '-exhausted')
        key_type = 'llm_api'
        max_budget = 1
        spend = 1.01
        budget_duration = '1d'
    }
    $exhaustedKey = [string]$exhausted.key
    if ([string]::IsNullOrWhiteSpace($exhaustedKey)) { throw 'LiteLLM did not return a budget test key.' }
    $budgetStatus = 0
    $budgetType = ''
    try {
        Invoke-JsonPost "$Gateway/v1/responses" @{
            Authorization = "Bearer $exhaustedKey"
            'x-litellm-session-id' = ($session + '_budget')
        } @{
            model = $Model
            input = 'Reply with exactly: BUDGET'
            max_output_tokens = 32
        } | Out-Null
    } catch {
        $budgetStatus = Get-HttpStatus $_
        if ($_.ErrorDetails.Message) {
            try { $budgetType = ($_.ErrorDetails.Message | ConvertFrom-Json).error.type } catch { }
        }
    }
    if ($budgetStatus -lt 400 -or $budgetType -ne 'budget_exceeded') {
        throw "Expected budget_exceeded; received HTTP $budgetStatus ($budgetType)."
    }
    Invoke-JsonPost "$Gateway/key/delete" $masterHeaders @{ keys = @($exhaustedKey) } | Out-Null
    $exhaustedKey = $null

    $keyForDelete = $virtualKey
    Invoke-JsonPost "$Gateway/key/delete" $masterHeaders @{ keys = @($keyForDelete) } | Out-Null
    $virtualKey = $null

    $revokedStatus = 0
    try {
        Invoke-JsonPost "$Gateway/v1/responses" @{ Authorization = "Bearer $keyForDelete" } @{
            model = $Model
            input = 'Reply with exactly: REVOKED'
            max_output_tokens = 32
        } | Out-Null
    } catch {
        $revokedStatus = Get-HttpStatus $_
    }
    if ($revokedStatus -ne 401) { throw "Expected revoked key HTTP 401; received $revokedStatus." }

    [pscustomobject]@{
        AllowedModel = $Model
        AllowedText = $text
        DeniedModel = $DeniedModel
        DeniedModelStatus = $deniedStatus
        BudgetExceededStatus = $budgetStatus
        BudgetExceededType = $budgetType
        RevokedKeyStatus = $revokedStatus
        NoExpiry = ($null -eq $created.expires)
        Result = 'PASS'
    }
} finally {
    if ($virtualKey) {
        Invoke-JsonPost "$Gateway/key/delete" $masterHeaders @{ keys = @($virtualKey) } | Out-Null
    }
    if ($exhaustedKey) {
        Invoke-JsonPost "$Gateway/key/delete" $masterHeaders @{ keys = @($exhaustedKey) } | Out-Null
    }
    $master = $null
    $virtualKey = $null
}
