# Windows hosted CI only. Never run this test on a real installed Windows C2C.
$ErrorActionPreference = "Stop"
if ($env:GITHUB_ACTIONS -ne "true" -or $env:CI -ne "true" -or
    [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP) -or
    [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "F4-D3 CLI shim E2E requires a disposable Windows GitHub runner"
}

$scriptPath = Join-Path $PSScriptRoot "windows-cli-commands.ps1"
$root = Join-Path $env:RUNNER_TEMP ("c2c-f4d3-shims-" + [guid]::NewGuid().ToString("N"))
$install = Join-Path $root "fixture-bundle"
$shims = Join-Path $root "command-shims"
$node = Join-Path $install "bin\node.exe"
$cli = Join-Path $install "dist\cli.js"
$originalUserPath = [Environment]::GetEnvironmentVariable("Path", "User")

function Invoke-ShimTool([string[]]$Arguments) {
    $value = & $scriptPath @Arguments -FixtureInstallRoot $install -FixtureShimDir $shims
    if (-not $value) { throw "F4-D3 failed to return contract JSON" }
    return (($value | Out-String).Trim() | ConvertFrom-Json -ErrorAction Stop)
}
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
try {
    New-Item -ItemType Directory -Force -Path (Split-Path $node), (Split-Path $cli) | Out-Null
    Copy-Item -LiteralPath (Get-Command node.exe -ErrorAction Stop).Source -Destination $node
    Set-Content -LiteralPath $cli -Value 'console.log(JSON.stringify(process.argv.slice(2)))' -Encoding UTF8

    $before = Invoke-ShimTool -Arguments @()
    Assert ($before.installedCliPresent -and -not $before.ownedCommandShims) "Read-only observation incorrect"
    Assert (-not (Test-Path -LiteralPath $shims)) "Inspection changed the filesystem"

    $installed = Invoke-ShimTool -Arguments @("-Install")
    Assert ($installed.ownedCommandShims -and $installed.userPathRegistered) "Opt-in registration failed"
    Assert (-not $installed.productionRuntimeTouched) "Fixture report permits touching production"
    $cmdA = Join-Path $shims "c2c.cmd"
    $cmdB = Join-Path $shims "chatgpt2codex.cmd"
    foreach ($cmd in @($cmdA, $cmdB)) {
        $out = (& $cmd "status" "--instance" "ci-fixture" | Out-String).Trim()
        Assert ($LASTEXITCODE -eq 0) "Shim subprocess failed"
        Assert ($out -ceq '["status","--instance","ci-fixture"]') "Shim arguments failed to round trip"
    }
    $repeat = Invoke-ShimTool -Arguments @("-Install")
    Assert ($repeat.ownedCommandShims -and $repeat.userPathRegistered) "Idempotent reinstallation failed"

    $old = [IO.File]::ReadAllText($cmdA, [Text.Encoding]::ASCII)
    [IO.File]::WriteAllText($cmdA, "user-modified", [Text.Encoding]::ASCII)
    $refused = $false
    try { $null = Invoke-ShimTool -Arguments @("-Remove") } catch { $refused = $true }
    Assert $refused "Remove must refuse modified shim"
    [IO.File]::WriteAllText($cmdA, $old, [Text.Encoding]::ASCII)

    $removed = Invoke-ShimTool -Arguments @("-Remove")
    Assert (-not $removed.ownedCommandShims -and -not $removed.userPathRegistered) "Uninstall failed"
    Assert (-not (Test-Path -LiteralPath $cmdA) -and -not (Test-Path -LiteralPath $cmdB)) "Leftover command shims"
    Assert ([Environment]::GetEnvironmentVariable("Path","User") -ceq $originalUserPath) "User PATH changed after removal"

    # Reject an unowned command file instead of overwriting it.
    New-Item -ItemType Directory -Force -Path $shims | Out-Null
    Set-Content -LiteralPath $cmdA -Value "an unrelated command" -Encoding ASCII
    $refused = $false
    try { $null = Invoke-ShimTool -Arguments @("-Install") } catch { $refused = $true }
    Assert $refused "Install overwrote an unowned command"
    Assert ((Get-Content -LiteralPath $cmdA -Raw).Contains("unrelated command")) "Unowned shim changed"
    Remove-Item -LiteralPath $cmdA -Force

    # The script must reject attempts to redirect an isolated fixture
    # into arbitrary Windows production directories.
    $refused = $false
    try {
        $null = & $scriptPath -Install -FixtureInstallRoot $env:WINDIR -FixtureShimDir $shims
    } catch { $refused = $true }
    Assert $refused "Accepted CI fixture outside ephemeral RUNNER_TEMP"

    Write-Host "PASS: F4-D3 Windows CLI shims, command execution, idempotency, guarded removal and PATH rollback"
} finally {
    [Environment]::SetEnvironmentVariable("Path", $originalUserPath, "User")
    if (Test-Path -LiteralPath $root) {
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop
    }
}
