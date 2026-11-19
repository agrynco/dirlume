$ErrorActionPreference = 'Stop'
$release = 'https://github.com/ip7z/7zip/releases/download/26.06'
$directory = Join-Path $env:RUNNER_TEMP 'dirlume-7zip'
New-Item -ItemType Directory -Path $directory -Force | Out-Null

if ($IsWindows) {
  $asset = '7z2606-extra.7z'
  $expected = '396c180f12d2247c24b0b1fcd482c6fc2a2700f61211ffede1061dd971f5e104'
} elseif ($IsMacOS -and (uname -m) -eq 'arm64') {
  $asset = '7z2606-mac.tar.xz'
  $expected = 'b6f17920b4240940461dac8ef4009891881ac44d2a5ead625ede2ec8472185dd'
} elseif ($IsMacOS) {
  $asset = '7z2606-mac-x64.tar.xz'
  $expected = '3af68b124052da7fc2a246c96b0bea6a68bfee389baa788f4cead1a133445586'
} else {
  $asset = '7z2606-linux-x64.tar.xz'
  $expected = '2b539cf067b2ad48e1baa5093dbaa8818b73542d1222a0ffde9dc5f2922ea62e'
}

$download = Join-Path $directory $asset
Invoke-WebRequest "$release/$asset" -OutFile $download
if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $expected) {
  throw "7-Zip test fixture checksum mismatch for $asset."
}
if ($IsWindows) {
  $extractor = Join-Path $env:ProgramFiles '7-Zip/7z.exe'
  & $extractor x -y "-o$directory" $download 'x64/7za.exe'
  $bin = Join-Path $directory 'x64'
} else {
  tar -xf $download -C $directory 7zz
  $bin = $directory
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Add-Content -LiteralPath $env:GITHUB_PATH -Value $bin
