$ErrorActionPreference = 'Stop'
$release = 'https://github.com/ip7z/7zip/releases/download/26.06'
$temp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$directory = Join-Path $temp 'dirlume-7zip-26.06'
$bundle = Join-Path $PSScriptRoot '../src-tauri/archive-tools'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$staging = Join-Path $directory "extract-$PID"
New-Item -ItemType Directory -Path $staging -Force | Out-Null

function Get-VerifiedAsset($name, $sha256) {
  $path = Join-Path $directory $name
  if (!(Test-Path -LiteralPath $path -PathType Leaf) -or
      (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $sha256) {
    Invoke-WebRequest "$release/$name" -OutFile $path
  }
  if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $sha256) {
    throw "7-Zip checksum mismatch for $name."
  }
  $path
}

if ($IsWindows) {
  $asset = '7z2606-x64.exe'
  $expected = '9b697f65ecc2d9b0152f5ee96d72dde522a7827690349d9307935dacf40f42ec'
  $files = @('7z.exe', '7z.dll', '7z.sfx', 'License.txt')
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

$download = Get-VerifiedAsset $asset $expected
$source = Get-VerifiedAsset '7z2606-src.tar.xz' 'a4e374c8f864f51df48c2cfd0e1413ec3b2ea030deae852d6a655402ebb61ac4'
if ($IsWindows) {
  $extractor = Join-Path $env:ProgramFiles '7-Zip/7z.exe'
  if (!(Test-Path -LiteralPath $extractor -PathType Leaf)) {
    $extractor = (Get-Command 7z.exe -CommandType Application -ErrorAction Stop).Source
  }
  & $extractor x -y "-o$staging" $download @files
} else {
  $files = @('7zz', 'License.txt')
  tar -xf $download -C $staging @files
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
foreach ($file in $files) {
  $path = Join-Path $staging $file
  if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "The bundled 7-Zip asset did not contain $file."
  }
  Move-Item -LiteralPath $path -Destination $bundle -Force
}
Remove-Item -LiteralPath $staging
Copy-Item -LiteralPath $source -Destination $bundle -Force
if ($env:GITHUB_PATH) {
  Add-Content -LiteralPath $env:GITHUB_PATH -Value (Resolve-Path -LiteralPath $bundle).Path
}
