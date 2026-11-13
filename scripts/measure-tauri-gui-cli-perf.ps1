# Windows Tauri Smoke: real WebView2 -> Rust -> CLI timing
# Logs only numeric durations and fixed command labels.
$ErrorActionPreference = "Stop"
$exe = Join-Path (Get-Location) "desktop\src-tauri\target\debug\chatgpt2codex-desktop.exe"
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "Missing Tauri Windows preview executable" }
if ($env:C2C_CI_PERF_RUN -ne "1" -or [string]::IsNullOrWhiteSpace($env:C2C_CI_PERF_OUTPUT)) {
    throw "Benchmark runner opt-in is missing"
}
$reportPath = $env:C2C_CI_PERF_OUTPUT
if (Test-Path -LiteralPath $reportPath) { Remove-Item -LiteralPath $reportPath -Force }
$guiProcess = Start-Process -FilePath $exe -PassThru
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(180)
    while (-not (Test-Path -LiteralPath $reportPath) -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 500
        $guiProcess.Refresh()
        if ($guiProcess.HasExited) { throw "WebView2 app exited before finishing the benchmark" }
    }
    if (-not (Test-Path -LiteralPath $reportPath)) {
        throw "Timeout waiting for the real WebView2 benchmark"
    }
    $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json -ErrorAction Stop
    if ($report.error) { throw "GUI benchmark failed: $($report.error)" }
    if ($report.schemaVersion -ne 2 -or @($report.samples).Count -ne 15) {
        throw "Invalid GUI benchmark report"
    }
    if (-not $report.prewarm -or $report.prewarm.succeeded -ne $true -or
        [double]::IsNaN([double]$report.prewarm.elapsedMs) -or
        [double]::IsInfinity([double]$report.prewarm.elapsedMs) -or
        [double]$report.prewarm.elapsedMs -lt 0) {
        throw "Startup bundle prewarm verification was not successful"
    }
    function Percentile([double[]] $values, [double] $quantile) {
        $sorted = @($values | Sort-Object)
        $index = [Math]::Max(0, [Math]::Ceiling($sorted.Count * $quantile) - 1)
        return [Math]::Round($sorted[$index], 1)
    }
    $lines = @(
        "## GUI / Bridge / CLI timing — Windows WebView2",
        "",
        "Native startup bundle prewarm: $([Math]::Round([double]$report.prewarm.elapsedMs, 1)) ms (successful, before GUI benchmark).",
        "Five warm runs per read-only command. p50 and p95 in milliseconds.",
        "",
        "| Command | GUI p50 / p95 | Bridge p50 / p95 | Bundle verification p50 / p95 | Node process p50 / p95 | CLI handler p50 / p95 |",
        "| --- | ---: | ---: | ---: | ---: | ---: |"
    )
    foreach ($command in @("c2c status", "c2c repository list", "c2c profile list")) {
        $rows = @($report.samples | Where-Object { $_.command -eq $command })
        if ($rows.Count -ne 5) { throw "Missing measurements for $command" }
        $gui = [double[]]@($rows | ForEach-Object { $_.guiMs })
        $bridge = [double[]]@($rows | ForEach-Object { $_.bridgeMs })
        $cli = [double[]]@($rows | ForEach-Object { $_.cliMs })
        $verify = [double[]]@($rows | ForEach-Object { $_.bundleVerifyMs })
        $nodeProcessTimes = [double[]]@($rows | ForEach-Object { $_.childProcessMs })
        if (@($rows | Where-Object { [double]$_.bundleVerifyMs -gt 1000 }).Count -gt 0) {
            throw "Unexpected full bundle re-verification after prewarm: $command"
        }
        $lines += "| $command | $(Percentile $gui 0.5) / $(Percentile $gui 0.95) ms | $(Percentile $bridge 0.5) / $(Percentile $bridge 0.95) ms | $(Percentile $verify 0.5) / $(Percentile $verify 0.95) ms | $(Percentile $nodeProcessTimes 0.5) / $(Percentile $nodeProcessTimes 0.95) ms | $(Percentile $cli 0.5) / $(Percentile $cli 0.95) ms |"
    }
    $lines += ""
    $lines += "GUI = WebView invoke to response; bridge = Rust request/CLI/parse; bundle verification = locked-handle reuse after separately reported startup SHA; Node process = spawn through child exit; CLI = command handler (Node startup excluded)."
    $markdown = $lines -join [Environment]::NewLine
    Write-Host $markdown
    if ($env:GITHUB_STEP_SUMMARY) { Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $markdown }
} finally {
    $guiProcess.Refresh()
    if (-not $guiProcess.HasExited) {
        Stop-Process -Id $guiProcess.Id -Force -ErrorAction SilentlyContinue
        $guiProcess.WaitForExit(10000) | Out-Null
    }
}
