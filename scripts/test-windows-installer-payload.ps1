[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Installer,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion,
  [string]$ExpectedSha256 = ""
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$installerPath = [System.IO.Path]::GetFullPath($Installer)
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
  throw "Installer does not exist: $installerPath"
}

$actualSha256 = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ExpectedSha256) {
  if ($ExpectedSha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw "ExpectedSha256 must be exactly 64 hex characters"
  }
  if ($actualSha256 -ne $ExpectedSha256.ToLowerInvariant()) {
    throw "Installer SHA-256 mismatch: expected $ExpectedSha256, actual $actualSha256"
  }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("c2c-win-payload-smoke-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
$zipPath = Join-Path $tempRoot "payload.zip"
$extracted = Join-Path $tempRoot "extracted"

try {
  # Mirror the read-only footer format used by ChatGPTToCodexSetup.cs.
  $marker = [System.Text.Encoding]::ASCII.GetBytes("CHATGPT2CODEX_SETUP_PAYLOAD_V1")
  $inputStream = [System.IO.File]::OpenRead($installerPath)
  try {
    $footerLength = $marker.Length + 8
    if ($inputStream.Length -le $footerLength) {
      throw "Installer is too short to contain a payload"
    }
    $inputStream.Seek(-$footerLength, [System.IO.SeekOrigin]::End) | Out-Null
    $reader = [System.IO.BinaryReader]::new($inputStream, [System.Text.Encoding]::ASCII, $true)
    try {
      $actualMarker = $reader.ReadBytes($marker.Length)
      if ([Convert]::ToBase64String($actualMarker) -ne [Convert]::ToBase64String($marker)) {
        throw "Installer payload marker mismatch"
      }
      $payloadLength = $reader.ReadInt64()
    } finally {
      $reader.Dispose()
    }

    if ($payloadLength -le 0 -or $payloadLength -gt ($inputStream.Length - $footerLength)) {
      throw "Installer payload length is invalid"
    }
    $inputStream.Seek(-($footerLength + $payloadLength), [System.IO.SeekOrigin]::End) | Out-Null

    $output = [System.IO.File]::Create($zipPath)
    try {
      $remaining = $payloadLength
      $buffer = New-Object byte[] (1024 * 1024)
      while ($remaining -gt 0) {
        $readSize = [int][Math]::Min($buffer.Length, $remaining)
        $read = $inputStream.Read($buffer, 0, $readSize)
        if ($read -le 0) { throw "Truncated installer ZIP payload" }
        $output.Write($buffer, 0, $read)
        $remaining -= $read
      }
    } finally {
      $output.Dispose()
    }
  } finally {
    $inputStream.Dispose()
  }

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  New-Item -ItemType Directory -Path $extracted -Force | Out-Null
  $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    if ($archive.Entries.Count -lt 5) { throw "Installer ZIP has unexpectedly few entries" }
    $prefix = [System.IO.Path]::GetFullPath($extracted).TrimEnd('\') + '\'
    foreach ($entry in $archive.Entries) {
      $destination = [System.IO.Path]::GetFullPath((Join-Path $extracted $entry.FullName))
      if (-not $destination.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe ZIP entry: $($entry.FullName)"
      }
    }
  } finally {
    $archive.Dispose()
  }
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $extracted)

  $required = @(
    "package.json",
    "dist/cli.js",
    "bin/node.exe",
    "bin/cloudflared.exe",
    "bin/rg.exe",
    "chatgpt2codex.exe",
    "start-chatgpt.ps1"
  )
  foreach ($relative in $required) {
    $file = Join-Path $extracted $relative
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
      throw "Windows installer payload missing: $relative"
    }
  }

  $manifest = Get-Content -LiteralPath (Join-Path $extracted "package.json") -Raw | ConvertFrom-Json
  if ([string]$manifest.version -ne $ExpectedVersion) {
    throw "Bundled package version $($manifest.version) != expected $ExpectedVersion"
  }

  # Execute only the bundled CLI's help command in the temporary directory.
  # Never launch the installer, modify Windows shortcuts, or stop existing C2C processes.
  $node = Join-Path $extracted "bin/node.exe"
  $cli = Join-Path $extracted "dist/cli.js"
  Push-Location $extracted
  try {
    & $node $cli "--help" | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Bundled CLI --help exited $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }

  Write-Host "[windows payload smoke] PASS"
  Write-Host "  version=$ExpectedVersion"
  Write-Host "  sha256=$actualSha256"
  Write-Host "  requiredFiles=$($required.Count)"
  Write-Host "  bundledNodeCliHelp=ok"
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
