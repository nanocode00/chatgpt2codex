# Explicitly destructive only to ephemeral, scoped processes on a fresh GitHub-hosted
# Windows runner. Never invoke from a user's installed C2C environment.
[CmdletBinding()]
param([string]$NodeExecutable = "", [string]$CliEntrypoint = "")
$ErrorActionPreference = "Stop"
$[REDACTED] = $false
if ($env:GITHUB_ACTIONS -ne "true" -or $env:CI -ne "true" -or
    [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    throw "Windows CLI lifecycle E2E may run only on an isolated GitHub Actions runner"
}

$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$cli = Join-Path $repo "dist\cli.js"
$node = (Get-Command node.exe -ErrorAction Stop).Source
if ($NodeExecutable -or $CliEntrypoint) {
    if (-not $NodeExecutable -or -not $CliEntrypoint) { throw "Both packaged inputs required" }
    $packRoot = Join-Path $repo "[REDACTED]"
    $fixedNode = Join-Path $packRoot "bin/node.exe"
    $fixedCli = Join-Path $packRoot "dist/cli.js"
    if (-not [string]::Equals([IO.Path]::GetFullPath($NodeExecutable), [IO.Path]::GetFullPath($fixedNode), [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([IO.Path]::GetFullPath($CliEntrypoint), [IO.Path]::GetFullPath($fixedCli), [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to use anything other than the fixed packaged preview CLI"
    }
    $node = $fixedNode
    $cli = $fixedCli
}
if (-not (Test-Path -LiteralPath $cli)) { throw "Missing CLI executable" }
$root = Join-Path $env:RUNNER_TEMP ("c2c-cli-isolated-" + [Guid]::NewGuid().ToString("N"))
$fake = $null
$instance = "ciisolated"
$started = $false
New-Item -ItemType Directory -Force (Join-Path $root "home"), (Join-Path $root "workspace"), (Join-Path $root "config") | Out-Null

# Fail closed if Node did not honor the isolated home. All state, secrets and
# auth material must be inside the disposable runner temp directory.
$env:USERPROFILE = Join-Path $root "home"
$env:HOME = $env:USERPROFILE
$env:XDG_CONFIG_HOME = Join-Path $root "config"
$actualHome = (& $node -p 'require("os").homedir()').Trim()
if ($LASTEXITCODE -ne 0 -or
    -not [string]::Equals([IO.Path]::GetFullPath($actualHome).TrimEnd('\'),
                          [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\'),
                          [StringComparison]::OrdinalIgnoreCase)) {
    throw "Node home is not isolated; refusing E2E execution"
}

$stateDir = Join-Path $env:USERPROFILE ".local\share\chatgpt2codex"
$recordPath = Join-Path $stateDir "runtime\$instance.json"
$workspace = Join-Path $root "workspace"
Set-Content -LiteralPath (Join-Path $workspace "package.json") -Value '{"name":"c2c-cli-windows-isolated","private":true}' -NoNewline

# Choose an unused local port on this ephemeral runner; no default 7979.
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()
if ($port -eq 7979 -or $port -lt 1024) { throw "Fixture selected unsafe port" }

function Invoke-C2C {
    param([string[]]$CliArgs, [switch]$ExpectFailure)
    $lines = & $node $cli @CliArgs 2>&1
    $code = $LASTEXITCODE
    if ($ExpectFailure) {
        if ($code -eq 0) { throw "Unsafe operation unexpectedly succeeded: $($CliArgs[0])" }
        return $null
    }
    if ($code -ne 0) {
        # CLI errors are printed without the generated owner token.
        throw "C2C $($CliArgs[0]) exit $code : $($lines | Out-String)"
    }
    # 'restart' currently emits two newline-delimited JSON objects: a
    # compact stop result followed by a multi-line start result.
    if ($CliArgs[0] -eq "restart") {
        if ($lines.Count -lt 2) { throw "Restart returned incomplete results" }
        $stopEvent = [string]$lines[0] | ConvertFrom-Json
        if ($stopEvent.stopped -ne $true) { throw "Restart did not stop the prior instance" }
        $raw = ($lines | Select-Object -Skip 1 | Out-String).Trim()
    } else {
        $raw = ($lines | Out-String).Trim()
    }
    try { return ($raw | ConvertFrom-Json -ErrorAction Stop) }
    catch { throw "CLI $($CliArgs[0]) returned invalid JSON: $raw" }
}

function Check-Health {
    $result = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 4
    if ($result.ok -ne $true -or $result.name -ne "chatgpt2codex") {
        throw "Unexpected localhost C2C Health response"
    }
}

try {
    # The token is generated in $stateDir, and its value is never written to CI logs.
    $tokenResult = Invoke-C2C -CliArgs @("owner-token", "--generate")
    if (-not $tokenResult.configured) { throw "Isolated owner token not configured" }
    Remove-Variable tokenResult

    # F5-F2 persistence: changes remain confined to the disposable instance.
    # These checks survive a separate CLI process and an MCP stop/restart.
    $savedConfig = Invoke-C2C -CliArgs @("config", "set", "host", "127.0.0.1", "--instance", $instance)
    if ($savedConfig.updated -ne $true -or $savedConfig.instance -ne $instance) {
        throw "Isolated instance configuration write failed"
    }
    $configBeforeStart = Invoke-C2C -CliArgs @("config", "show", "--instance", $instance)
    if ($configBeforeStart.persisted.host -ne "127.0.0.1") {
        throw "Isolated instance configuration was not persisted across CLI invocations"
    }

    $startArgs = @("start", "--instance", $instance, "--workspace", $workspace,
        "--host", "127.0.0.1", "--port", "$port", "--tunnel", "none")
    $start = Invoke-C2C -CliArgs $startArgs
    if ($start.started -ne $true -or $start.healthy -ne $true) {
        throw "Isolated instance did not start healthy"
    }
    $started = $true
    Check-Health
    $status = Invoke-C2C -CliArgs @("status", "--instance", $instance)
    if (-not $status.alive -or -not $status.healthy -or $status.port -ne $port) {
        throw "Status does not match isolated running instance"
    }
    $health = Invoke-C2C -CliArgs @("health", "--instance", $instance)
    if (-not $health.healthy) { throw "CLI health is not healthy" }
    Write-Host "PASS: isolated Windows CLI start/status/health"

    # Windows hot reload must not restart the MCP listener (and therefore must
    # not invalidate any existing tunnel URL or OAuth session). Every fixture
    # remains inside this ephemeral CI runner's HOME/workspace.
    $pidBefore = [int]$status.pid
    $urlBefore = [string]$status.publicUrl
    $reload = Invoke-C2C -CliArgs @("reload", "--instance", $instance)
    if (-not $reload.reloaded -or $reload.instance -ne $instance -or $reload.pid -ne $pidBefore) {
        throw "Windows reload did not acknowledge the owned running instance"
    }
    $extra = Join-Path $root "extra-project"
    New-Item -ItemType Directory -Force $extra | Out-Null
    Set-Content -LiteralPath (Join-Path $extra "package.json") -Value '{"name":"ci-extra-project","private":true}' -NoNewline
    $added = Invoke-C2C -CliArgs @("repository", "add", $extra, "--id", "ci-extra")
    if ($added.added -ne $true -or $added.liveReload.supported -ne $true -or
        @($added.liveReload.reloaded) -notcontains $instance) {
        throw "Windows repository add did not hot reload its running instance"
    }
    $registryPath = Join-Path $stateDir "projects.$instance.json"
    if (-not (Test-Path -LiteralPath $registryPath)) { throw "Missing live registry state after reload" }
    $registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json -ErrorAction Stop
    if (@($registry.projects.projectId) -notcontains "ci-extra") {
        throw "Windows live server registry did not reflect added repository"
    }
    $removed = Invoke-C2C -CliArgs @("repository", "remove", "ci-extra")
    if ($removed.removed -ne $true -or $removed.liveReload.supported -ne $true -or
        @($removed.liveReload.reloaded) -notcontains $instance) {
        throw "Windows repository removal did not auto reload"
    }
    $registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json -ErrorAction Stop
    if (@($registry.projects.projectId) -contains "ci-extra") {
        throw "Windows live server registry retained removed repository"
    }
    $afterReload = Invoke-C2C -CliArgs @("status", "--instance", $instance)
    if (-not $afterReload.healthy -or $afterReload.pid -ne $pidBefore -or
        $afterReload.port -ne $port -or $afterReload.publicUrl -ne $urlBefore) {
        throw "Windows reload changed MCP process, port, URL or health"
    }
    Check-Health
    Write-Host "PASS: Windows reload and repository auto-reload preserve PID/port/URL"

    # Simulate a stale/spoofed PID pointing at an unrelated disposable process
    # while the actual C2C health endpoint remains healthy. Stop MUST refuse it.
    $foreignScript = Join-Path $root "foreign-fixture.js"
    Set-Content -LiteralPath $foreignScript -Value "setInterval(function () {}, 10000);" -NoNewline
    $fake = Start-Process -FilePath $node -ArgumentList ('"' + $foreignScript + '"') -PassThru -WindowStyle Hidden
    Start-Sleep -Milliseconds 900
    if (-not $fake) { throw "Unable to spawn disposable foreign fixture" }
    $fake.Refresh()
    if ($fake.HasExited) { throw "Disposable foreign fixture exited prematurely" }
    $originalRecord = Get-Content -LiteralPath $recordPath -Raw
    try {
        $forged = $originalRecord | ConvertFrom-Json
        $forged.pid = $fake.Id
        Set-Content -LiteralPath $recordPath -Value ($forged | ConvertTo-Json -Depth 12)
        $fake.Refresh()
        if ($fake.HasExited) { throw "Foreign fixture exited before ownership check" }
        $forgedStatus = Invoke-C2C -CliArgs @("status", "--instance", $instance)
        if ($forgedStatus.alive -ne $true) { throw "Foreign fixture not alive according to CLI" }
        Invoke-C2C -CliArgs @("reload", "--instance", $instance) -ExpectFailure
        Invoke-C2C -CliArgs @("stop", "--instance", $instance, "--force") -ExpectFailure
        $fake.Refresh()
        if ($fake.HasExited) { throw "Unsafe: stop signaled unrelated process" }
        Check-Health
    } finally {
        Set-Content -LiteralPath $recordPath -Value $originalRecord
    }
    Write-Host "PASS: forged foreign PID rejected even with healthy endpoint"

    $stopped = Invoke-C2C -CliArgs @("stop", "--instance", $instance)
    if ($stopped.stopped -ne $true) { throw "Safe stop did not report stopped" }
    $started = $false
    $status = Invoke-C2C -CliArgs @("status", "--instance", $instance)
    if ($status.alive -ne $false) { throw "Stopped instance reported alive" }
    Write-Host "PASS: isolated Windows CLI stop"

    $start = Invoke-C2C -CliArgs $startArgs
    if ($start.started -ne $true -or $start.healthy -ne $true) {
        throw "Cannot start again after stop"
    }
    $started = $true
    $restarted = Invoke-C2C -CliArgs @("restart", "--instance", $instance,
        "--workspace", $workspace, "--host", "127.0.0.1",
        "--port", "$port", "--tunnel", "none")
    if ($restarted.started -ne $true -or $restarted.healthy -ne $true) {
        throw "Restart did not report a healthy instance"
    }
    Check-Health
    $configAfterRestart = Invoke-C2C -CliArgs @("config", "show", "--instance", $instance)
    if ($configAfterRestart.persisted.host -ne "127.0.0.1") {
        throw "MCP restart lost isolated preview instance configuration"
    }
    Write-Host "PASS: isolated Windows configuration survived CLI invocations and restart"
    Write-Host "PASS: isolated Windows CLI restart"

    $final = Invoke-C2C -CliArgs @("stop", "--instance", $instance)
    if ($final.stopped -ne $true) { throw "Final stop failed" }
    $started = $false
    Write-Host "PASS: all Windows CLI lifecycle smoke checks"
} finally {
    if ($started -and (Test-Path -LiteralPath $recordPath)) {
        try { $null = Invoke-C2C -CliArgs @("stop", "--instance", $instance, "--force") }
        catch { Write-Warning "Isolated process did not stop cleanly: $($_.Exception.Message)" }
    }
    if ($fake) {
        $fake.Refresh()
        if (-not $fake.HasExited) {
            # This is our own disposable fixture PID, never a discovered
            # C2C / cloudflared process or another user's runtime.
            Stop-Process -Id $fake.Id -Force -ErrorAction SilentlyContinue
        }
        $fake.Dispose()
    }
    # Runner workspace and all temporary secrets are discarded after CI.
}
