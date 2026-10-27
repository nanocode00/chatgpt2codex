# F4-D4-B: Windows hosted, disposable same-version repair / next-version
# installer scenario. Never use this on a workstation or production profile.
[CmdletBinding()]
param()
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne "true" -or $env:CI -ne "true" -or
    -not $env:RUNNER_TEMP -or
    [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "F4-D4-B requires a disposable Windows GitHub-hosted CI runner"
}

$installRoot = Join-Path $env:LOCALAPPDATA "ChatGPT To Codex Tauri Preview"
$legacyRoot = Join-Path $env:LOCALAPPDATA "Programs\ChatGPT To Codex"
$previewHome = Join-Path $env:LOCALAPPDATA "ChatGPTToCodex-Tauri-Preview"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$legacyName = "ChatGPT To Codex"
$tauriName = "ChatGPT To Codex Tauri Preview"
$legacyMarker = '"C:\F4D4-Disposable-Legacy-Only.exe"'
$baseline = Join-Path $env:RUNNER_TEMP "c2c-f4d4-nsis-baseline\baseline-setup.exe"
$upgrade = Join-Path $env:RUNNER_TEMP "c2c-f4d4-nsis-upgrade\upgrade-setup.exe"

function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Get-RunValue([string]$Name) {
    $v = Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue
    if ($null -eq $v -or -not $v.PSObject.Properties[$Name]) { return $null }
    return [string]$v.PSObject.Properties[$Name].Value
}
function Get-Bundle {
    $paths = @($installRoot, (Join-Path $installRoot "resources"))
    $candidates = @($paths | Where-Object { Test-Path -LiteralPath (Join-Path $_ "c2c-runtime\manifest.json") -PathType Leaf })
    Assert ($candidates.Count -eq 1) "Exactly one installed CLI manifest expected"
    return Join-Path $candidates[0] "c2c-runtime"
}
function Assert-Installed {
    $exePath = Join-Path $installRoot "chatgpt2codex-desktop.exe"
    Assert (Test-Path -LiteralPath $exePath -PathType Leaf) "Missing installed Tauri EXE"
    $bundle = Get-Bundle
    $manifest = Get-Content -LiteralPath (Join-Path $bundle "manifest.json") -Raw | ConvertFrom-Json
    Assert ($manifest.kind -ceq "c2c-tauri-isolated-owned-cli-v1") "Invalid bundle identity"
    Assert (($manifest.instance -ceq "tauri-preview-v1") -and ($manifest.tunnel -ceq "none")) "Installed CLI escaped preview isolation"
    $node = Join-Path $bundle "bin\node.exe"
    $cli = Join-Path $bundle "dist\cli.js"
    Assert ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $cli)) "Missing bundled CLI"
    Assert ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash -ieq $manifest.nodeSha256) "Node SHA mismatch"
    Assert ((Get-FileHash -LiteralPath $cli -Algorithm SHA256).Hash -ieq $manifest.cliSha256) "CLI SHA mismatch"
    Assert (-not (Test-Path -LiteralPath $legacyRoot)) "Legacy WinForms directory was unexpectedly created"
    Assert ((Get-RunValue $legacyName) -ceq $legacyMarker) "Legacy auto-start entry altered"
}
function Invoke-Setup([string]$Executable, [string]$Label) {
    $proc = Start-Process -FilePath $Executable -ArgumentList @("/S") -PassThru -Wait
    Assert ($proc.ExitCode -eq 0) "$Label exit=$($proc.ExitCode)"
}
function Get-InstalledVersion {
    $root = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
    $matches = @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue } |
        Where-Object {
            $null -ne $_ -and $null -ne $_.PSObject.Properties["DisplayName"] -and
            $_.DisplayName -eq "ChatGPT To Codex Tauri Preview"
        })
    Assert ($matches.Count -eq 1) "Expected exactly one dedicated Tauri uninstall entry"
    Assert ($null -ne $matches[0].PSObject.Properties["DisplayVersion"]) "Missing installed version metadata"
    return [string]$matches[0].DisplayVersion
}
function Assert-NoAutostart {
    Assert (-not (Get-RunValue $tauriName)) "Tauri login auto-start unexpectedly enabled"
}

foreach ($setup in @($baseline, $upgrade)) {
    Assert (Test-Path -LiteralPath $setup -PathType Leaf) "Missing staged NSIS setup: $setup"
}
Assert (-not (Test-Path -LiteralPath $installRoot)) "Expected clean Tauri install directory"
Assert (-not (Test-Path -LiteralPath $legacyRoot)) "Unexpected legacy WinForms installation on runner"
Assert (-not (Get-RunValue $legacyName)) "Refusing to overwrite existing legacy startup entry"
Assert (-not (Get-RunValue $tauriName)) "Refusing to overwrite existing Tauri startup entry"
Assert (-not (Test-Path -LiteralPath $previewHome)) "Runner already contains preview user data; abort"
$baselineHash = (Get-FileHash -LiteralPath $baseline -Algorithm SHA256).Hash
$upgradeHash = (Get-FileHash -LiteralPath $upgrade -Algorithm SHA256).Hash
Assert ($baselineHash -ne $upgradeHash) "Installer versions unexpectedly identical"
$markerPath = Join-Path $previewHome "workspace\f4d4-data-preservation-ci.txt"
$marker = "ci-f4d4-preserve-" + [guid]::NewGuid().ToString("N")
try {
    # Synthetic legacy value is never the production user's live registry.
    New-ItemProperty -Path $runKey -Name $legacyName -Value $legacyMarker -PropertyType String -Force | Out-Null

    Invoke-Setup $baseline "Clean baseline installation"
    Assert-Installed
    Assert-NoAutostart
    Assert ((Get-InstalledVersion) -eq "0.1.0") "Baseline installed version mismatch"

    New-Item -ItemType Directory -Force -Path (Split-Path $markerPath) | Out-Null
    [IO.File]::WriteAllText($markerPath, $marker)
    Invoke-Setup $baseline "Same-version reinstall"
    Assert-Installed
    Assert-NoAutostart
    Assert ((Get-InstalledVersion) -eq "0.1.0") "Reinstall unexpectedly changed version"
    Assert (([IO.File]::ReadAllText($markerPath)) -ceq $marker) "Same-version reinstall lost preview user data"

    # Deliberately corrupt a copied upgrade installer and reject it using
    # hash-based preflight. Do NOT launch this corrupted binary: avoiding a
    # Windows error dialog is part of the fail-closed test contract.
    $tamperedPath = Join-Path $env:RUNNER_TEMP "c2c-f4d4-corrupted-setup.exe"
    Copy-Item -LiteralPath $upgrade -Destination $tamperedPath
    $stream = [IO.File]::Open($tamperedPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite)
    try {
        $stream.Seek(512, [IO.SeekOrigin]::Begin) | Out-Null
        $originalByte = $stream.ReadByte()
        Assert ($originalByte -ge 0) "Corrupt installer has invalid size"
        $stream.Seek(512, [IO.SeekOrigin]::Begin) | Out-Null
        $stream.WriteByte($originalByte -bxor 255)
    } finally { $stream.Dispose() }
    $detected = (Get-FileHash -LiteralPath $tamperedPath -Algorithm SHA256).Hash -ne $upgradeHash
    Assert $detected "Modified installer was not rejected by preflight"
    Remove-Item -LiteralPath $tamperedPath -Force
    Assert-Installed
    Assert ((Get-InstalledVersion) -eq "0.1.0") "Rejected installer altered installed version"
    Assert (([IO.File]::ReadAllText($markerPath)) -ceq $marker) "Rejected upgrade changed user data"

    Invoke-Setup $upgrade "Next-version upgrade"
    Assert-Installed
    Assert-NoAutostart
    Assert ((Get-InstalledVersion) -eq "0.1.1") "Upgrade did not replace installed version"
    Assert (([IO.File]::ReadAllText($markerPath)) -ceq $marker) "Upgrade lost existing preview user data"

    # Opt-in login starts are scoped to the Tauri-only Run entry. The
    # uninstaller is allowed to remove ONLY this exact matching value.
    $installedExe = Join-Path $installRoot "chatgpt2codex-desktop.exe"
    New-ItemProperty -Path $runKey -Name $tauriName -Value ('"' + $installedExe + '"') -PropertyType String -Force | Out-Null
    $uninstallers = @(Get-ChildItem -LiteralPath $installRoot -Filter "*uninstall*.exe" -File)
    Assert ($uninstallers.Count -eq 1) "Expected exactly one Tauri uninstaller after upgrade"
    Invoke-Setup $uninstallers[0].FullName "Upgraded Tauri uninstall"
    Assert (-not (Test-Path -LiteralPath $installedExe)) "Tauri EXE remained after uninstall"
    Assert (-not (Get-RunValue $tauriName)) "Tauri-specific login entry not cleaned after uninstall"
    Assert ((Get-RunValue $legacyName) -ceq $legacyMarker) "Uninstall touched legacy WinForms login value"
    Assert (([IO.File]::ReadAllText($markerPath)) -ceq $marker) "Uninstall should not erase isolated preview user data"

    Invoke-Setup $upgrade "Clean reinstall of newer version"
    Assert-Installed
    Assert-NoAutostart
    Assert ((Get-InstalledVersion) -eq "0.1.1") "Final reinstall has wrong version"
    Assert (([IO.File]::ReadAllText($markerPath)) -ceq $marker) "Final reinstall lost preview data"

    $uninstallers = @(Get-ChildItem -LiteralPath $installRoot -Filter "*uninstall*.exe" -File)
    Assert ($uninstallers.Count -eq 1) "Final uninstaller missing"
    Invoke-Setup $uninstallers[0].FullName "Final NSIS uninstall"
    Assert (-not (Test-Path -LiteralPath $installedExe)) "Final uninstall left executable"
    Assert ((Get-RunValue $legacyName) -ceq $legacyMarker) "Final uninstall altered legacy entry"

    Write-Host "PASS F4-D4-B: baseline/reinstall/upgrade/hash-rejected staging/uninstall/reinstall, isolated user data, startup and legacy keys preserved"
} finally {
    # Do not delete a foreign entry even in CI; synthetic value cleanup
    # happens only when the marker still exactly matches ours.
    if ((Get-RunValue $legacyName) -ceq $legacyMarker) {
        Remove-ItemProperty -Path $runKey -Name $legacyName -ErrorAction SilentlyContinue
    }
}
