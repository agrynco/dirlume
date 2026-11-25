#Requires -RunAsAdministrator
#Requires -Modules Hyper-V
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$IsoPath,

    [string]$Name = 'Dirlume-Windows-CI',
    [string]$SwitchName = 'Default Switch',
    [string]$Destination = "$env:PUBLIC\Documents\Hyper-V",
    [ValidateRange(2, 64)]
    [int]$Processors = 4,
    [ValidateRange(4GB, 1TB)]
    [long]$Memory = 12GB,
    [ValidateRange(64GB, 4TB)]
    [long]$DiskSize = 120GB
)

$ErrorActionPreference = 'Stop'
$iso = (Resolve-Path -LiteralPath $IsoPath).ProviderPath
if ([IO.Path]::GetExtension($iso) -ne '.iso') { throw 'Select a Windows installation ISO.' }
if ($Name -match '[^a-zA-Z0-9_-]') { throw 'Use letters, digits, hyphens or underscores in the VM name.' }
if (Get-VM -Name $Name -ErrorAction SilentlyContinue) { throw "A VM named $Name already exists." }
Get-VMSwitch -Name $SwitchName | Out-Null

$vmPath = Join-Path $Destination $Name
$diskPath = Join-Path $vmPath "$Name.vhdx"
New-Item -ItemType Directory -Path $vmPath | Out-Null
$vm = New-VM -Name $Name -Generation 2 -Path $vmPath -MemoryStartupBytes $Memory `
    -NewVHDPath $diskPath -NewVHDSizeBytes $DiskSize -SwitchName $SwitchName
Set-VM -VM $vm -ProcessorCount $Processors -AutomaticStartAction Start -AutomaticStopAction ShutDown
Set-VMKeyProtector -VMName $Name -NewLocalKeyProtector
Enable-VMTPM -VMName $Name
$dvd = Add-VMDvdDrive -VMName $Name -Path $iso -Passthru
Set-VMFirmware -VMName $Name -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows -FirstBootDevice $dvd
Write-Output "Connect to $Name in Hyper-V Manager, start it and boot from the ISO."
