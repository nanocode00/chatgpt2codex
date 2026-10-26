# F4-D1: Read-only Windows acceptance observations.
# Operates only against the locally selected loopback port.
# No auth headers, CLI operations, public requests, file writes, or process control.
[CmdletBinding()]
param(
    [ValidateRange(1,65535)]
    [int]$Port = 7979
)
$ErrorActionPreference = "Stop"

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "This read-only observation is supported on Windows only."
}

# Never include raw command lines, installation paths, process IDs, DNS
# names, OAuth issuer URLs, HTTP response bodies, or errors in output.
$listenerState = "unverified"
$processIdentity = "unverified"
$healthState = "unverified"
$listenerCount = 0

try {
    # Enumerate listeners first; filtering -LocalPort directly can throw
    # when no listener exists and mislabel an absent port as an API failure.
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object { $_.LocalPort -eq $Port -and $_.LocalAddress -in @("127.0.0.1", "::1") })
    $listenerCount = $listeners.Count
    if ($listenerCount -eq 0) {
        $listenerState = "absent"
    } elseif ($listenerCount -eq 1) {
        $listenerState = "observed"
    } else {
        $listenerState = "ambiguous"
    }

    if ($listenerCount -eq 1 -and $listeners[0].OwningProcess -gt 0) {
        # Read process metadata in memory only. The executable name and CLI
        # argv are a *candidate* indicator, never authority to stop this PID.
        try {
            $observedPid = [int]$listeners[0].OwningProcess
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $observedPid" -ErrorAction Stop
            if ($null -ne $proc -and $null -ne $proc.ExecutablePath -and $null -ne $proc.CommandLine) {
                $exeName = [IO.Path]::GetFileName([string]$proc.ExecutablePath)
                # Match a CLI script filename only, not command-line secrets.
                $looksLikeCli = ($exeName -ieq "node.exe") -and
                    [regex]::IsMatch([string]$proc.CommandLine, '(?i)[/\\]cli\.js(?=$|[\s"])')
                if ($looksLikeCli) { $processIdentity = "cli_candidate" }
            }
        } catch {
            $processIdentity = "unverified"
        }
    }
} catch {
    # Missing Get-NetTCPConnection or insufficient process permissions are
    # unknown, not evidence that the port is free.
    $listenerState = "unverified"
    $processIdentity = "unverified"
}

try {
    # Read-only localhost health probe; no authentication or OAuth operations.
    $health = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 3 -ErrorAction Stop
    if ($health.ok -eq $true -and $health.name -ceq "chatgpt2codex") {
        $healthState = "c2c_responded"
    } else {
        $healthState = "unrecognized"
    }
} catch {
    $healthState = "unavailable"
}

$checks = [ordered]@{
    loopbackListener = $listenerState
    cliProcessCandidate = $processIdentity
    localHealth = $healthState
    osProcessOwnership = "unverified"
    publicOAuthContinuity = "not_tested"
    chatgptClientRoundtrip = "not_tested"
    rollbackReadiness = "not_proven"
    featureParity = "manual_review_required"
}

# Fixed allowlist only; contains no raw user/runtime metadata.
$report = [ordered]@{
    schemaVersion = 1
    phase = "F4-D1"
    observationOnly = $true
    canTransitionNow = $false
    mayStopProcesses = $false
    inspectedPort = $Port
    checks = $checks
}

$report | ConvertTo-Json -Depth 6 -Compress
