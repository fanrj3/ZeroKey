param(
    [ValidateSet('Check', 'Verify')]
    [string]$Mode = 'Check',
    [string]$Message = 'Authorize this ZeroKey project'
)

$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $verifier = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
    $availabilityType = [Windows.Security.Credentials.UI.UserConsentVerifierAvailability, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
    $resultType = [Windows.Security.Credentials.UI.UserConsentVerificationResult, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and
            $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        } | Select-Object -First 1

    $operation = $verifier::CheckAvailabilityAsync()
    $task = $asTask.MakeGenericMethod($availabilityType).Invoke($null, @($operation))
    $availability = $task.GetAwaiter().GetResult().ToString()
    if ($Mode -eq 'Check' -or $availability -ne 'Available') {
        Write-Output $availability
        if ($Mode -eq 'Verify') { exit 2 }
        exit 0
    }

    $operation = $verifier::RequestVerificationAsync($Message)
    $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $result = $task.GetAwaiter().GetResult().ToString()
    Write-Output $result
    if ($result -ne 'Verified') { exit 3 }
} catch {
    Write-Output 'Unavailable'
    exit 4
}
