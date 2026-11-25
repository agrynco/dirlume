[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^https://github\.com/[\w.-]+/[\w.-]+/?$')]
    [string]$RepositoryUrl,

    [string]$RunnerPath = "$env:LOCALAPPDATA\dirlume-runner"
)

$ErrorActionPreference = 'Stop'
$version = '2.338.2'
$checksum = 'a1f17aa987fc8158bc7521d284912267a0d01b7c2c4684b33c86783b5e8221cc'
$archive = Join-Path $env:TEMP "dirlume-runner-$([guid]::NewGuid()).zip"
if (Test-Path -LiteralPath (Join-Path $RunnerPath '.runner')) {
    throw 'This directory already contains a registered runner.'
}
if (-not (Test-Path -LiteralPath (Join-Path $RunnerPath 'config.cmd'))) {
    try {
        Invoke-WebRequest "https://github.com/actions/runner/releases/download/v$version/actions-runner-win-x64-$version.zip" -OutFile $archive
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $checksum) {
            throw 'GitHub Actions runner checksum mismatch.'
        }
        Expand-Archive -LiteralPath $archive -DestinationPath $RunnerPath
    } finally {
        if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive }
    }
}

$token = Read-Host 'GitHub runner registration token' -AsSecureString
Push-Location -LiteralPath $RunnerPath
try {
    .\config.cmd --unattended --url $RepositoryUrl --token ([System.Net.NetworkCredential]::new('', $token).Password) `
        --name dirlume-windows-x64 --labels dirlume-windows-x64
    if ($LASTEXITCODE -ne 0) { throw "Runner registration failed with exit code $LASTEXITCODE." }
} finally {
    $token.Dispose()
    Pop-Location
}
Write-Output "Run $RunnerPath\run.cmd in the signed-in Windows desktop session."
