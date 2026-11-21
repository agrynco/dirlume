#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateRange(1, [int]::MaxValue)]
    [int]$DirlumeProcessId,
    [ValidateRange(1, 86400)]
    [int]$DurationSeconds = 180,
    [ValidateRange(250, 60000)]
    [int]$IntervalMilliseconds = 2000
)

$ErrorActionPreference = 'Stop'
$dirlume = Get-Process -Id $DirlumeProcessId
if ($dirlume.ProcessName -ne 'Dirlume') { throw "PID $DirlumeProcessId does not belong to Dirlume." }

$clock = [Diagnostics.Stopwatch]::StartNew()
$duration = $DurationSeconds * 1000
while (!$dirlume.HasExited -and $clock.ElapsedMilliseconds -lt $duration) {
    $started = $clock.ElapsedMilliseconds
    $webviews = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" `
        -Property ProcessId, ParentProcessId, CommandLine)
    $childrenByParent = $webviews | Group-Object -Property ParentProcessId -AsHashTable -AsString
    if ($null -eq $childrenByParent) { $childrenByParent = @{} }
    $tree = @{ $DirlumeProcessId = 'host' }
    $parents = [Collections.Generic.Queue[int]]::new()
    $parents.Enqueue($DirlumeProcessId)
    while ($parents.Count -gt 0) {
        $parent = $parents.Dequeue()
        foreach ($process in $childrenByParent[[string]$parent]) {
            $child = [int]$process.ProcessId
            if ($tree.ContainsKey($child)) { continue }
            $commandLine = [string]$process.CommandLine
            $role = [regex]::Match($commandLine, '(?:^|\s)--type=([\w-]+)')
            $tree[$child] = if ($role.Success) { $role.Groups[1].Value } elseif ($commandLine) { 'browser' } else { 'unknown' }
            $parents.Enqueue($child)
        }
    }

    $filter = ($tree.Keys | ForEach-Object { "IDProcess = $_" }) -join ' OR '
    $readings = Get-CimInstance Win32_PerfRawData_PerfProc_Process -Filter $filter -Property IDProcess, WorkingSetPrivate
    $elapsed = [Math]::Round($clock.Elapsed.TotalSeconds, 3)
    foreach ($reading in $readings | Sort-Object IDProcess) {
        $id = [int]$reading.IDProcess
        [pscustomobject]@{
            ElapsedSeconds = $elapsed
            ProcessId = $id
            Role = $tree[$id]
            PrivateWorkingSetBytes = [long]$reading.WorkingSetPrivate
        }
    }

    $next = [Math]::Min($duration, $started + $IntervalMilliseconds)
    $pause = $next - $clock.ElapsedMilliseconds
    if ($pause -gt 0) { Start-Sleep -Milliseconds $pause }
}
