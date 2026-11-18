$ErrorActionPreference = 'Stop'
$installer = Join-Path $env:RUNNER_TEMP ("webview2-" + [guid]::NewGuid().ToString('N') + ".exe")
try {
    Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $installer
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') {
        throw 'WebView2 installer signature validation failed.'
    }
    $process = Start-Process -FilePath $installer -ArgumentList '/silent','/install' -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -notin @(0, 3010)) {
        throw "WebView2 installation failed with exit code $($process.ExitCode)."
    }
} finally {
    if (Test-Path -LiteralPath $installer) {
        Remove-Item -LiteralPath $installer -Force
    }
}
