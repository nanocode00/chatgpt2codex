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

$manifest = [ordered]@{
  version = 1
  kind = "c2c-tauri-isolated-owned-cli-v1"
  cliSha256 = (Get-FileHash (Join-Path $payload "dist/cli.js") -Algorithm SHA256).Hash.ToLowerInvariant()
  nodeSha256 = (Get-FileHash (Join-Path $payload "bin/node.exe") -Algorithm SHA256).Hash.ToLowerInvariant()
  application = "ChatGPT To Codex Tauri preview"
  instance = "tauri-preview-v1"
  tunnel = "none"
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $payload "manifest.json") -Encoding utf8
Write-Host "PASS: isolated Tauri CLI payload generated under target/debug/c2c-runtime"
Write-Host "The WinForms installation, its token, and its port 7979 remain unchanged."
