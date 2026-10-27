# F4-D4-A: disposable Windows CI only.
# One-shot NSIS install -> exact payload checks -> safe uninstall.
# NEVER execute on any user-owned Windows system with existing C2C.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne "true" -or $env:CI -ne "true" -or
    -not $env:RUNNER_TEMP -or
    [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "F4-D4 NSIS install test requires a disposable hosted Windows CI runner"
}

$installRoot = Join-Path $env:LOCALAPPDATA "ChatGPT To Codex Tauri Preview"
$legacyRoot = Join-Path $env:LOCALAPPDATA "Programs\ChatGPT To Codex"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$legacyValueName = "ChatGPT To Codex"
$tauriValueName = "ChatGPT To Codex Tauri Preview"
$marker = '"C:\Disposable-F4D4-Legacy-Sentinel.exe"'
$installerDir = Join-Path $PSScriptRoot "..\desktop\src-tauri\target\debug\bundle\nsis"
$installers = @(Get-ChildItem -LiteralPath $installerDir -Filter "*-setup.exe" -File -ErrorAction Stop)

function Assert([bool]$ok, [string]$message) {
    if (-not $ok) { throw $message }
}
function Read-RunValue([string]$name) {
    try {
        return [string](Get-ItemPropertyValue -Path $runKey -Name $name -ErrorAction Stop)
    } catch [System.Management.Automation.ItemNotFoundException] {
        return $null
    }
}
function Invoke-Installer([string]$file, [string]$label) {
    $proc = Start-Process -FilePath $file -ArgumentList @("/S") -PassThru -Wait
    Assert ($proc.ExitCode -eq 0) "$label exit=$($proc.ExitCode)"
}
function Assert-HealthyPayload {
    $exe = Join-Path $installRoot "chatgpt2codex-desktop.exe"
    Assert (Test-Path -LiteralPath $exe -PathType Leaf) "Tauri EXE missing"
    $candidateRoots = @($installRoot, (Join-Path $installRoot "resources"))
    $bundles = @($candidateRoots | Where-Object { Test-Path -LiteralPath (Join-Path $_ "c2c-runtime\manifest.json") })
    Assert ($bundles.Count -eq 1) "Expected exactly one installed C2C bundle root, observed $($bundles.Count)"
    $runtime = Join-Path $bundles[0] "c2c-runtime"
    $manifest = Get-Content -LiteralPath (Join-Path $runtime "manifest.json") -Raw | ConvertFrom-Json
    Assert ($manifest.kind -eq "c2c-tauri-isolated-owned-cli-v1") "Invalid isolated bundle kind"
    Assert ($manifest.instance -eq "tauri-preview-v1" -and $manifest.tunnel -eq "none") "Unexpected runtime scope"
    $node = Join-Path $runtime "bin\node.exe"
    $cli = Join-Path $runtime "dist\cli.js"
    Assert ((Test-Path $node) -and (Test-Path $cli)) "Bundled CLI or node missing"
    Assert ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash -ieq $manifest.nodeSha256) "Node hash mismatch"
    Assert ((Get-FileHash -LiteralPath $cli -Algorithm SHA256).Hash -ieq $manifest.cliSha256) "CLI hash mismatch"
    Write-Host "PASS: isolated Tauri NSIS install and signed-by-manifest runtime payload"
}

Assert ($installers.Count -eq 1) "Expected one F4-D4 NSIS installer"
Assert (-not (Test-Path -LiteralPath $legacyRoot)) "Runner already has WinForms; aborting before any mutation"
Assert (-not (Test-Path -LiteralPath $installRoot)) "Runner already has Tauri; aborting before any mutation"
Assert (-not (Read-RunValue $legacyValueName)) "Legacy startup entry already exists; abort"
Assert (-not (Read-RunValue $tauriValueName)) "Tauri startup entry already exists; abort"

try {
    # Synthetic legacy entry only in disposable GitHub runner, to prove
    # the new installer and its uninstaller cannot touch that registry name.
    New-ItemProperty -Path $runKey -Name $legacyValueName -Value $marker -PropertyType String -Force | Out-Null
    Invoke-Installer $installers[0].FullName "Tauri current-user NSIS install"
    Assert-HealthyPayload
    Assert ((Read-RunValue $legacyValueName) -ceq $marker) "Legacy Run entry changed by Tauri install"
    Assert (-not (Read-RunValue $tauriValueName)) "Installation must never enable autostart"

    $exePath = Join-Path $installRoot "chatgpt2codex-desktop.exe"
    # Simulate explicit opt-in without launching GUI or activating the server.
    New-ItemProperty -Path $runKey -Name $tauriValueName -Value ('"' + $exePath + '"') -PropertyType String -Force | Out-Null

    $uninstallers = @(Get-ChildItem -LiteralPath $installRoot -Filter "*uninstall*.exe" -File)
    Assert ($uninstallers.Count -eq 1) "Exactly one isolated Tauri uninstaller expected"
    Invoke-Installer $uninstallers[0].FullName "Tauri NSIS uninstall"
    Assert (-not (Test-Path -LiteralPath $exePath)) "Tauri binary remained after uninstall"
    Assert (-not (Read-RunValue $tauriValueName)) "Tauri-owned auto-start Run value not cleaned up"
    Assert ((Read-RunValue $legacyValueName) -ceq $marker) "Legacy Run sentinel mutated by uninstall"
    Assert (-not (Test-Path -LiteralPath $legacyRoot)) "Unexpected legacy WinForms install directory"

    Write-Host "PASS: F4-D4 NSIS current-user install, payload hashes, default-off startup, uninstall cleanup and WinForms isolation"
} finally {
    # Never remove foreign/unowned values or any directories. GitHub runners
    # are ephemeral even if the installer deliberately fails closed.
    if ((Read-RunValue $legacyValueName) -ceq $marker) {
        Remove-ItemProperty -Path $runKey -Name $legacyValueName -ErrorAction SilentlyContinue
    }
}
