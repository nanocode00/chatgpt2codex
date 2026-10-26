# F4-D3: Optional current-user commands for an existing Windows CLI bundle.
# Without -Install or -Remove this performs a read-only inspection.
[CmdletBinding(DefaultParameterSetName = "Inspect")]
param(
    [Parameter(ParameterSetName = "Install", Mandatory = $true)]
    [switch]$Install,
    [Parameter(ParameterSetName = "Remove", Mandatory = $true)]
    [switch]$Remove,
    [Parameter(ParameterSetName = "Inspect")]
    [switch]$Inspect,
    [string]$FixtureInstallRoot = "",
    [string]$FixtureShimDir = ""
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "Windows-only CLI registration"
}
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw "Current Windows user LOCALAPPDATA is unavailable"
}
if ([bool]$FixtureInstallRoot -ne [bool]$FixtureShimDir) {
    throw "Fixture paths must be supplied together"
}

$installRoot = Join-Path $env:LOCALAPPDATA "Programs\ChatGPT To Codex"
$shimDir = Join-Path $env:LOCALAPPDATA "C2C-CLI-Shims"
if ($FixtureInstallRoot) {
    # Custom directories are only for disposable hosted Windows CI.
    if ($env:GITHUB_ACTIONS -ne "true" -or $env:CI -ne "true" -or
        [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
        throw "Custom fixture paths are restricted to ephemeral Windows CI"
    }
    $runnerRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
    $fixtureRoot = [IO.Path]::GetFullPath($FixtureInstallRoot)
    $fixtureBin = [IO.Path]::GetFullPath($FixtureShimDir)
    foreach ($value in @($fixtureRoot, $fixtureBin)) {
        if (-not $value.StartsWith($runnerRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "CI fixture must stay below RUNNER_TEMP"
        }
    }
    $installRoot = $fixtureRoot
    $shimDir = $fixtureBin
}

$node = Join-Path $installRoot "bin\node.exe"
$cli = Join-Path $installRoot "dist\cli.js"
$shimNames = @("c2c.cmd", "chatgpt2codex.cmd")
$receiptPath = Join-Path $shimDir "c2c-shims-receipt.json"
$marker = ":: C2C_USER_CLI_SHIM_V1"

function Assert-OrdinaryDirectory([string]$Target) {
    if (Test-Path -LiteralPath $Target) {
        $entry = Get-Item -LiteralPath $Target -Force
        if (-not $entry.PSIsContainer -or
            ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing unexpected or redirected shim directory"
        }
    }
}

function Get-ShimText([string]$NodePath, [string]$CliPath) {
    # CMD interpolates percent/bang tokens; refuse unsafe absolute paths.
    if ($NodePath -match '[%!"&|<>^]' -or $CliPath -match '[%!"&|<>^]') {
        throw "Unsafe characters in CLI installation path"
    }
    $newline = [Environment]::NewLine
    return ('@echo off' + $newline + $marker + $newline +
        '"' + $NodePath + '" "' + $CliPath + '" %*' + $newline)
}

function Read-Receipt {
    if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
        return $null
    }
    if ((Get-Item -LiteralPath $receiptPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Refusing redirected CLI receipt"
    }
    $raw = Get-Content -LiteralPath $receiptPath -Raw -ErrorAction Stop
    if ($raw.Length -gt 4096) { throw "CLI receipt exceeds bounded size" }
    $r = $raw | ConvertFrom-Json -ErrorAction Stop
    if ($r.schemaVersion -ne 1 -or $r.owner -cne "C2C_F4D3" -or
        $r.shimDir -cne $shimDir -or $r.installRoot -cne $installRoot) {
        throw "CLI shim receipt does not match this installation"
    }
    return $r
}

function Assert-OwnedShims {
    $expected = Get-ShimText $node $cli
    foreach ($name in $shimNames) {
        $path = Join-Path $shimDir $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "A registered CLI shim is missing"
        }
        $entry = Get-Item -LiteralPath $path -Force
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing redirected CLI shim"
        }
        $actual = [IO.File]::ReadAllText($path, [Text.Encoding]::ASCII)
        if ($actual -cne $expected) {
            throw "Refusing to overwrite or delete a modified CLI shim"
        }
    }
}

function Get-UserPathEntries {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not $userPath) { return @() }
    return @($userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Path-HasShim([string[]]$Entries) {
    foreach ($entry in $Entries) {
        $normalized = [Environment]::ExpandEnvironmentVariables($entry).TrimEnd('\')
        if ([string]::Equals($normalized, $shimDir.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

Assert-OrdinaryDirectory $shimDir

if ($Install) {
    if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or
        -not (Test-Path -LiteralPath $cli -PathType Leaf)) {
        throw "Installed Windows bundle does not contain the CLI and bundled Node executable"
    }
    foreach ($source in @($node, $cli)) {
        if ((Get-Item -LiteralPath $source -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing redirected CLI bundle file"
        }
    }
    $null = Get-ShimText $node $cli
    $receipt = Read-Receipt
    if ($null -ne $receipt) {
        Assert-OwnedShims
    } else {
        # Do not register commands that would shadow an unrelated existing
        # npm/user/system install. Require an explicit operator decision.
        foreach ($command in @("c2c", "chatgpt2codex")) {
            $existingCommand = Get-Command $command -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($null -ne $existingCommand -and
                -not [string]::Equals([string]$existingCommand.Source,
                    (Join-Path $shimDir ($command + ".cmd")),
                    [StringComparison]::OrdinalIgnoreCase)) {
                throw "An existing CLI command was found; refusing PATH shadowing"
            }
        }
        if (Test-Path -LiteralPath $shimDir) {
            foreach ($name in $shimNames) {
                if (Test-Path -LiteralPath (Join-Path $shimDir $name)) {
                    throw "Refusing to overwrite unowned CLI command"
                }
            }
        }
        New-Item -ItemType Directory -Path $shimDir -Force | Out-Null
        Assert-OrdinaryDirectory $shimDir
        $text = Get-ShimText $node $cli
        foreach ($name in $shimNames) {
            [IO.File]::WriteAllText((Join-Path $shimDir $name), $text, [Text.Encoding]::ASCII)
        }
        $original = @(Get-UserPathEntries)
        $added = -not (Path-HasShim $original)
        $record = [ordered]@{
            schemaVersion = 1
            owner = "C2C_F4D3"
            shimDir = $shimDir
            installRoot = $installRoot
            addedToUserPath = $added
        }
        [IO.File]::WriteAllText($receiptPath, ($record | ConvertTo-Json -Compress), [Text.Encoding]::UTF8)
        if ($added) {
            [Environment]::SetEnvironmentVariable("Path", ((@($original) + @($shimDir)) -join ';'), "User")
        }
    }
} elseif ($Remove) {
    $receipt = Read-Receipt
    if ($null -ne $receipt) {
        Assert-OwnedShims
        foreach ($name in $shimNames) {
            Remove-Item -LiteralPath (Join-Path $shimDir $name) -Force -ErrorAction Stop
        }
        if ($receipt.addedToUserPath -eq $true) {
            $existing = @(Get-UserPathEntries)
            $kept = @($existing | Where-Object {
                -not [string]::Equals(
                    [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\'),
                    $shimDir.TrimEnd('\'),
                    [StringComparison]::OrdinalIgnoreCase)
            })
            [Environment]::SetEnvironmentVariable("Path", ($kept -join ';'), "User")
        }
        Remove-Item -LiteralPath $receiptPath -Force -ErrorAction Stop
        if ((Get-ChildItem -LiteralPath $shimDir -Force | Measure-Object).Count -eq 0) {
            Remove-Item -LiteralPath $shimDir -ErrorAction Stop
        }
    }
}

$receipt = Read-Receipt
$entries = @(Get-UserPathEntries)
[pscustomobject][ordered]@{
    schemaVersion = 1
    phase = "F4-D3"
    installedCliPresent = ((Test-Path -LiteralPath $node -PathType Leaf) -and
                           (Test-Path -LiteralPath $cli -PathType Leaf))
    ownedCommandShims = ($null -ne $receipt)
    userPathRegistered = (Path-HasShim $entries)
    action = if ($Install) { "install" } elseif ($Remove) { "remove" } else { "inspect" }
    productionRuntimeTouched = $false
} | ConvertTo-Json -Compress
