# F4-C1: Real Windows CLI stop/start/rollback, disposable runner only.
# Never run against an installed C2C/WinForms instance or user HOME.
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
if ($env:GITHUB_ACTIONS -ne "true" -or $env:CI -ne "true" -or
    $env:C2C_F4C1_E2E -ne "true" -or
    [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP) -or
    -not $IsWindows) {
    throw "F4-C1 is restricted to opted-in ephemeral Windows CI runners"
}
$runnerTemp = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path
if ((Get-Item -LiteralPath $runnerTemp).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Unexpected runner temporary directory reparse point"
}
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$node = (Get-Command node.exe -ErrorAction Stop).Source
$cli = Join-Path $repo "dist/cli.js"
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
    throw "C2C CLI must be built before the F4-C1 rehearsal"
}
$root = Join-Path $runnerTemp ("c2c-f4c1-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
$before = @{}
foreach ($key in @("HOME", "USERPROFILE", "XDG_CONFIG_HOME")) {
    $before[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
}
$source = "ci-f4c1-source"
$target = "ci-f4c1-target"
$cleanupFailure = $false

function Invoke-FixtureCli {
    param([string[]]$Arguments)
    # Don't echo raw CLI output: owner-token setup returns a one-time secret.
    $result = & $node $cli @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Disposable CLI operation $($Arguments[0]) failed"
    }
    try { return (($result | Out-String).Trim() | ConvertFrom-Json -ErrorAction Stop) }
    catch { throw "Disposable CLI operation $($Arguments[0]) returned invalid JSON" }
}
function Get-NextPort {
    $socket = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $socket.Start()
    try { return ([Net.IPEndPoint]$socket.LocalEndpoint).Port }
    finally { $socket.Stop() }
}
function Status([string]$instance) {
    return Invoke-FixtureCli -Arguments @("status", "--instance", $instance)
}
function Assert-OneWriter {
    $a = Status $source
    $b = Status $target
    if ($a.alive -and $b.alive) { throw "Two live CLI writers in shared fixture HOME" }
    return @($a, $b)
}
function Assert-Health([int]$port) {
    $result = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 5
    if ($result.ok -ne $true -or $result.name -ne "chatgpt2codex") {
        throw "Disposable C2C health identity did not match"
    }
}
function Start-Owned([string]$instance, [int]$port) {
    $other = if ($instance -eq $source) { $target } else { $source }
    if ((Status $other).alive) { throw "Refusing to start concurrent fixture instance" }
    $result = Invoke-FixtureCli -Arguments @(
        "start", "--instance", $instance, "--workspace", $workspace,
        "--host", "127.0.0.1", "--port", "$port", "--tunnel", "none"
    )
    if ($result.started -ne $true -or $result.healthy -ne $true) {
        throw "Disposable CLI failed to start healthy"
    }
    Assert-Health $port
    $states = Assert-OneWriter
    if (-not (Status $instance).alive) { throw "Started instance did not own a running process" }
}
function Stop-Owned([string]$instance) {
    if (-not (Status $instance).alive) { throw "Expected fixture instance was not running" }
    $result = Invoke-FixtureCli -Arguments @("stop", "--instance", $instance)
    if ($result.stopped -ne $true) { throw "Owned fixture instance did not stop" }
    if ((Status $instance).alive) { throw "Stopped fixture instance still alive" }
    $states = Assert-OneWriter
}
try {
    $fixtureHome = Join-Path $root "home"
    $workspace = Join-Path $root "workspace"
    $config = Join-Path $root "config"
    New-Item -ItemType Directory -Path $fixtureHome, $workspace, $config -ErrorAction Stop | Out-Null
    [Environment]::SetEnvironmentVariable("USERPROFILE", $fixtureHome, "Process")
    [Environment]::SetEnvironmentVariable("HOME", $fixtureHome, "Process")
    [Environment]::SetEnvironmentVariable("XDG_CONFIG_HOME", $config, "Process")
    $observed = (& $node -p 'require("os").homedir()').Trim()
    if ($LASTEXITCODE -ne 0 -or
        -not [string]::Equals([IO.Path]::GetFullPath($observed).TrimEnd('\'),
                              [IO.Path]::GetFullPath($fixtureHome).TrimEnd('\'),
                              [StringComparison]::OrdinalIgnoreCase)) {
        throw "Node home escaped disposable runner sandbox"
    }
    Set-Content -LiteralPath (Join-Path $workspace "package.json") -NoNewline -Value '{"name":"f4c1-only","private":true}'
    $ports = @((Get-NextPort), (Get-NextPort))
    for ($retry = 0; $retry -lt 10 -and
         ($ports[0] -eq $ports[1] -or $ports[0] -in @(7979,18797) -or
          $ports[1] -in @(7979,18797)); $retry++) {
        $ports = @((Get-NextPort), (Get-NextPort))
    }
    if ($ports[0] -eq $ports[1] -or $ports[0] -in @(7979,18797) -or
        $ports[1] -in @(7979,18797) -or $ports[0] -lt 1024 -or $ports[1] -lt 1024) {
        throw "Unsafe or colliding disposable fixture port"
    }
    # Generates a secret only inside this CI sandbox; no token text in logs.
    $owner = Invoke-FixtureCli -Arguments @("owner-token", "--generate")
    if (-not $owner.configured) { throw "Disposable Owner Token initialization failed" }
    Remove-Variable owner
    $ownerPath = Join-Path $fixtureHome ".local/share/chatgpt2codex/owner-token.json"
    if (-not (Test-Path -LiteralPath $ownerPath -PathType Leaf)) {
        throw "Missing disposable Owner Token verifier"
    }
    $sourceDigest = (Get-FileHash -LiteralPath $ownerPath -Algorithm SHA256).Hash

    # Scenario 1: Inject failure after legacy shutdown, then restore source.
    Start-Owned $source $ports[0]
    Stop-Owned $source
    if ((Status $target).alive) { throw "Target running before cutover" }
    Start-Owned $source $ports[0]
    if ((Status $target).alive) { throw "Unexpected target after first rollback" }
    Write-Host "PASS F4-C1: rollback after source stop"

    # Scenario 2: Inject failure after target starts; terminate owned target
    # before bringing source back. Both use the same ephemeral HOME.
    Stop-Owned $source
    Start-Owned $target $ports[1]
    Stop-Owned $target
    Start-Owned $source $ports[0]
    Write-Host "PASS F4-C1: rollback after real target startup"

    # Scenario 3: A successful handover followed by an explicit recovery.
    Stop-Owned $source
    Start-Owned $target $ports[1]
    if ((Status $source).alive) { throw "Source still running after handover" }
    Stop-Owned $target
    Start-Owned $source $ports[0]
    if (-not (Status $source).healthy) { throw "Source was not restored healthy" }
    $finalDigest = (Get-FileHash -LiteralPath $ownerPath -Algorithm SHA256).Hash
    if ($sourceDigest -ne $finalDigest) { throw "Synthetic Owner Token verifier changed" }
    Stop-Owned $source
    if ((Status $target).alive) { throw "Target remained running after recovery" }
    Write-Host "PASS F4-C1: real CLI handover, recovery, and credential-verifier invariance"
} finally {
    # Only the two *named* disposable CLI instances in the verified fixture
    # HOME may be stopped. CLI performs its own fail-closed PID ownership check.
    foreach ($instance in @($target, $source)) {
        try {
            $status = Status $instance
            if ($status.alive) {
                $stop = Invoke-FixtureCli -Arguments @("stop", "--instance", $instance)
                if ($stop.stopped -ne $true) { throw "Disposable cleanup stop failed" }
            }
        } catch {
            $cleanupFailure = $true
            Write-Warning "Unable to verify cleanup of an isolated CI instance"
        }
    }
    foreach ($key in @("HOME", "USERPROFILE", "XDG_CONFIG_HOME")) {
        [Environment]::SetEnvironmentVariable($key, $before[$key], "Process")
    }
    if ($cleanupFailure) {
        throw "F4-C1 disposable CLI cleanup not verified; runner must be discarded"
    }
    # Remove only the newly created disposable CI sandbox.
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop
}
