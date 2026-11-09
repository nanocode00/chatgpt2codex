# Build a self-contained, *isolated* C2C CLI payload for the unsigned Tauri
# preview. This does not touch the installed WinForms app or its settings.
[CmdletBinding()]
param(
  [string]$DestinationRoot = ""
)
$ErrorActionPreference = "Stop"
if (-not $IsWindows -and $env:OS -ne "Windows_NT") {
  throw "This preview runtime payload requires Windows"
}
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$target = Join-Path $repo "desktop/src-tauri/target/debug"
if (-not $DestinationRoot) { $DestinationRoot = $target }
$fullDest = [IO.Path]::GetFullPath($DestinationRoot)
$fullTarget = [IO.Path]::GetFullPath($target)
if (-not [string]::Equals($fullDest.TrimEnd('\'), $fullTarget.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to package outside the dedicated Tauri debug target directory"
}

$cli = Join-Path $repo "dist/cli.js"
$deps = Join-Path $repo "node_modules"
$package = Join-Path $repo "package.json"
$node = (Get-Command node.exe -ErrorAction Stop).Source
foreach ($required in @($cli, $deps, $package, $node)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Missing runtime input: $required. Run npm ci, npm run build first."
  }
}
$payload = Join-Path $fullDest "c2c-runtime"
New-Item -ItemType Directory -Force -Path $fullDest | Out-Null
if (Test-Path -LiteralPath $payload) {
  Remove-Item -LiteralPath $payload -Recurse -Force
}
New-Item -ItemType Directory -Force (Join-Path $payload "bin"), (Join-Path $payload "dist") | Out-Null
Copy-Item -LiteralPath $node -Destination (Join-Path $payload "bin/node.exe")
Copy-Item -Path (Join-Path $repo "dist/*") -Destination (Join-Path $payload "dist") -Recurse -Force
Copy-Item -LiteralPath $package -Destination (Join-Path $payload "package.json")
Copy-Item -LiteralPath $deps -Destination (Join-Path $payload "node_modules") -Recurse -Force

# A verified, *owned* Cloudflare Quick Tunnel executable is required before
# F5-D enables the native tunnel lifecycle. Never fall back to PATH, legacy
# WinForms binaries or an arbitrary WebView-provided executable at runtime.
$cloudflaredPath = Join-Path $payload "bin/cloudflared.exe"
# Pinned vendor release and SHA-256 published on the official release page.
# Never accept a partially downloaded or unexpected cloudflared executable.
$cloudflaredVersion = "2026.10.7"
$cloudflaredExpectedSha256 = "2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343"
$cloudflaredUrl = "https://github.com/cloudflare/cloudflared/releases/download/$cloudflaredVersion/cloudflared-windows-amd64.exe"
Write-Host "[tauri] downloading pinned Cloudflare cloudflared $cloudflaredVersion (Windows x64)..."
$downloadOk = $false
for ($attempt = 1; $attempt -le 4; $attempt++) {
  try {
    Invoke-WebRequest -Uri $cloudflaredUrl -OutFile $cloudflaredPath -MaximumRedirection 5 -ErrorAction Stop
    $downloadOk = $true
    break
  } catch {
    if (Test-Path -LiteralPath $cloudflaredPath) {
      Remove-Item -LiteralPath $cloudflaredPath -Force
    }
    if ($attempt -eq 4) { throw "cloudflared download failed after 4 attempts: $($_.Exception.Message)" }
    Write-Warning "Pinned cloudflared download temporarily failed (attempt $attempt); retrying..."
    Start-Sleep -Seconds (2 * $attempt)
  }
}
if (-not $downloadOk -or -not (Test-Path -LiteralPath $cloudflaredPath -PathType Leaf) -or
    (Get-Item -LiteralPath $cloudflaredPath).Length -lt 1000000) {
  throw "Invalid cloudflared bundle: download missing or unexpectedly small"
}
$cloudflaredObservedSha256 = (Get-FileHash $cloudflaredPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($cloudflaredObservedSha256 -ne $cloudflaredExpectedSha256) {
  throw "cloudflared release digest mismatch: refusing unverified binary"
}
# Runtime manifest SHA-256 also prevents replacement after distribution.
# Production release additionally requires package signing.

$manifest = [ordered]@{
  version = 1
  kind = "c2c-tauri-isolated-owned-cli-v1"
  cliSha256 = (Get-FileHash (Join-Path $payload "dist/cli.js") -Algorithm SHA256).Hash.ToLowerInvariant()
  nodeSha256 = (Get-FileHash (Join-Path $payload "bin/node.exe") -Algorithm SHA256).Hash.ToLowerInvariant()
  application = "ChatGPT To Codex Tauri preview"
  instance = "tauri-preview-v1"
  tunnel = "quick-ready"
  cloudflaredSha256 = (Get-FileHash $cloudflaredPath -Algorithm SHA256).Hash.ToLowerInvariant()
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $payload "manifest.json") -Encoding utf8
Write-Host "PASS: isolated Tauri CLI payload generated under target/debug/c2c-runtime"
Write-Host "The WinForms installation, its token, and its port 7979 remain unchanged."
