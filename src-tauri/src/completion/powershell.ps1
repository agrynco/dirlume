$ProgressPreference = 'SilentlyContinue';
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false);
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false);
function Get-CompletedArguments($command, $position, $includeCurrent) {
    foreach ($element in ($command.CommandElements | Select-Object -Skip 1)) {
        if ($element.Extent.EndOffset -gt $position -or
            (!$includeCurrent -and $element.Extent.EndOffset -eq $position)) { break }
        if ($element -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
            $element.Value;
        } else { $element.Extent.Text }
    }
}

function New-ArgumentCompletion([string]$value) {
    $text = $value;
    if ($value.StartsWith('@') -or $value -notmatch '^[\p{L}\p{M}\p{N}._/@:+,=\-]+$') {
        $quote = [string][char]39;
        $text = $quote + [System.Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($value) + $quote;
    }
    [System.Management.Automation.CompletionResult]::new($text, $value, 'ParameterValue', $value)
}

function Get-DhcpAdapterNames {
    foreach ($adapter in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
        if (!$adapter.Supports([Net.NetworkInformation.NetworkInterfaceComponent]::IPv4)) { continue }
        try {
            if ($adapter.GetIPProperties().GetIPv4Properties().IsDhcpEnabled) { $adapter.Name }
        } catch {}
    }
}

$initial = ConvertFrom-Json -InputObject ([Console]::ReadLine());
$windowsCommands = @{};
foreach ($row in ($initial.catalog -split '\r?\n')) {
    if (!$row) { continue }
    $name, $values = $row.Split([char]9, 2);
    $windowsCommands[$name] = if ($values) { $values.Split(' ') } else { @() };
}
$windowsRoots = @($windowsCommands.Keys | Where-Object { !($_.Contains(' ')) } | Sort-Object);
$windowsPrograms = @(foreach ($name in $windowsRoots) { $name; $name + '.exe'; $name + '.com' });
function Get-WindowsCommandContext($command, $position) {
    if (!$command) { return }
    $invoked = $command.GetCommandName();
    if (!$invoked -or !$windowsCommands.ContainsKey([IO.Path]::GetFileNameWithoutExtension($invoked))) { return }
    $resolved = Get-Command -Name ([WildcardPattern]::Escape($invoked)) -ErrorAction SilentlyContinue |
        Select-Object -First 1;
    if ($resolved -is [System.Management.Automation.AliasInfo]) { $resolved = $resolved.ResolvedCommand }
    if ($resolved -isnot [System.Management.Automation.ApplicationInfo]) { return }
    $name = [IO.Path]::GetFileNameWithoutExtension($resolved.Name);
    $arguments = @(Get-CompletedArguments $command $position $false);
    $values = $null;
    if ($name -eq 'cmd') {
        for ($i = 0; $i -lt $arguments.Count; ++$i) {
            if ($arguments[$i] -notin '/c', '/k') { continue }
            if ($i + 1 -lt $arguments.Count) {
                $name = [IO.Path]::GetFileNameWithoutExtension($arguments[$i + 1]);
                $arguments = @($arguments | Select-Object -Skip ($i + 2));
            } else { $values = $windowsRoots }
            break
        }
    }
    $root = $name;
    if (!$values) {
        foreach ($argument in $arguments) {
            $child = $name + ' ' + $argument;
            if (!$windowsCommands.ContainsKey($child)) { break }
            $name = $child;
        }
        $values = $windowsCommands[$name];
    }
    @{ root = $root; values = $values; arguments = $arguments }
}

Register-ArgumentCompleter -Native -CommandName $windowsPrograms -ScriptBlock {
    param($word, $command, $position)
    $context = Get-WindowsCommandContext $command $position;
    if (!$context) { return }
    if ($context.root -eq 'ipconfig' -and $context.arguments.Count -and
        $context.arguments[0] -in '/renew','/release') {
        $script:adapterArguments = $true;
        if ($context.arguments.Count -ne 1) { return }
        $prefix = ([string]$word).Trim([char[]]@([char]39, [char]34));
        foreach ($adapterName in (Get-DhcpAdapterNames | Sort-Object -Unique)) {
            if ($adapterName.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                New-ArgumentCompletion $adapterName
            }
        }
        return
    }
    if ($word -eq '?') { $word = '/?' }
    foreach ($value in $context.values) {
        if ($value.StartsWith([string]$word, [StringComparison]::OrdinalIgnoreCase)) {
            [System.Management.Automation.CompletionResult]::new($value)
        }
    }
};
Register-ArgumentCompleter -Native -CommandName dotnet,dotnet.exe -ScriptBlock {
    param($word, $command, $position)
    $offset = $position - $command.Extent.StartOffset;
    dotnet.exe complete --position $offset $command.ToString() 2>$null | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_)
    }
};
function Find-GitCompletionTools {
    $git = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1;
    if (!$git) { return }
    $location = [IO.DirectoryInfo]::new([IO.Path]::GetDirectoryName($git.Source));
    for ($level = 0; $location -and $level -lt 3; ++$level) {
        $root = $location.FullName;
        $location = $location.Parent;
        $bash = Join-Path $root 'usr/bin/bash.exe';
        if (![IO.File]::Exists($bash)) { continue }
        foreach ($architecture in 'mingw64', 'mingw32', 'clangarm64') {
            $script = Join-Path $root ($architecture + '/share/git/completion/git-completion.bash');
            if ([IO.File]::Exists($script)) { return @{ bash = $bash; script = $script } }
        }
    }
}

# Send words as data to Git for Windows. Backslash-quote escapes are for Windows PowerShell's native argv.
$gitCompletionRunner = @'
export GIT_ALLOW_PROTOCOL= GIT_TERMINAL_PROMPT=0
mapfile -t input
for i in ~${!input[@]}~; do input[i]=~${input[i]%$'\r'}~; done
source ~${input[0]}~ || exit
words=(~${input[@]:1}~)
cword=$(( ${#words[@]} - 1 ))
cur=${words[cword]}
prev=${words[cword-1]}
__git_main
if (( ${#COMPREPLY[@]} )); then printf '%s\n' ~${COMPREPLY[@]}~; fi
'@.Replace('~', ('\' + [char]34));
$OutputEncoding = [Console]::OutputEncoding;
Register-ArgumentCompleter -Native -CommandName git,git.exe -ScriptBlock {
    param($word, $command, $position)
    if (!$script:gitCompletionTools) { $script:gitCompletionTools = Find-GitCompletionTools }
    if (!$script:gitCompletionTools) { return }
    $arguments = @('git') + @(Get-CompletedArguments $command $position) + @([string]$word);
    @($script:gitCompletionTools.script) + $arguments |
        & $script:gitCompletionTools.bash --noprofile --norc -p -c $gitCompletionRunner 2>$null |
        ForEach-Object {
            $value = $_.TrimEnd();
            if ($value) { New-ArgumentCompletion $value }
        }
};
function Get-CompletionCommand($request) {
    $prefix = $request.line.Substring(0, $request.caret).TrimEnd();
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($prefix, [ref]$null, [ref]$null);
    $ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.CommandAst] -and
        $node.Extent.EndOffset -eq $prefix.Length
    }, $true) | Select-Object -Last 1;
}
function Test-PathArgument($command, $replacementIndex) {
    if (!$command) { return $false }
    $name = $command.GetCommandName();
    if (!$name) { return $false }
    $info = Get-Command -Name ([WildcardPattern]::Escape($name)) -ErrorAction SilentlyContinue;
    if ($info -is [System.Management.Automation.AliasInfo]) { $info = $info.ResolvedCommand }
    if ($info -isnot [System.Management.Automation.FunctionInfo] -and
        $info -isnot [System.Management.Automation.CmdletInfo]) { return $false }
    $elements = @($command.CommandElements | Where-Object { $_.Extent.EndOffset -le $replacementIndex });
    $previous = $elements | Select-Object -Last 1;
    $parameters = $info.Parameters.Values;
    if ($previous -is [System.Management.Automation.Language.CommandParameterAst]) {
        $parameters = @($parameters | Where-Object {
            $_.Name -like "$($previous.ParameterName)*" -or $_.Aliases -contains $previous.ParameterName
        });
    } else {
        $parameters = @($parameters | Where-Object {
            $_.ParameterSets.Values | Where-Object { $_.Position -ge 0 }
        });
    }
    return [bool]($parameters | Where-Object {
        $_.Name -match '(Path|File|Directory|Folder)$' -or
        $_.ParameterType -in [System.IO.FileInfo], [System.IO.DirectoryInfo], [System.IO.FileSystemInfo]
    } | Select-Object -First 1);
}
while ($null -ne ($line = [Console]::ReadLine())) {
    try {
        $request = ConvertFrom-Json -InputObject $line -ErrorAction Stop;
        Set-Location -LiteralPath $request.directory -ErrorAction Stop;
        $script:adapterArguments = $false;
        $command = Get-CompletionCommand $request;
        $result = TabExpansion2 -inputScript $request.line -cursorColumn $request.caret;
        $candidates = $result.CompletionMatches;
        $prefix = $request.line.Substring(0, $request.caret);
        if ($result.ReplacementIndex -eq 0 -and $prefix -match '^[\p{L}\p{N}_-]+$') {
            # Keep short aliases visible even on hosts with many matching cmdlets.
            $aliases = @(Get-Alias -Name ([WildcardPattern]::Escape($prefix) + '*') -ErrorAction SilentlyContinue |
                Sort-Object Name | ForEach-Object {
                    [System.Management.Automation.CompletionResult]::new($_.Name, $_.Name, 'Command', $_.Definition)
                });
            $aliasNames = @($aliases | ForEach-Object CompletionText);
            $candidates = $aliases + @($candidates | Where-Object { $_.CompletionText -notin $aliasNames });
        }
        if ($command -and $command.GetCommandName() -in 'cd','sl','chdir','Set-Location','pushd','Push-Location') {
            $candidates = $candidates | Where-Object { $_.ResultType -ne 'ProviderItem' };
        }
        if (($candidates | Where-Object { $_.ResultType -in 'ProviderItem','ProviderContainer' } | Select-Object -First 1) -and
            ($script:adapterArguments -or (!$request.allowPaths -and ($request.commandPosition -or
                !(Test-PathArgument $command $result.ReplacementIndex))))) {
            $candidates = $candidates | Where-Object { $_.ResultType -notin 'ProviderItem','ProviderContainer' };
        }
        $items = @($candidates | Select-Object -First 100 | ForEach-Object {
            $label = if ($_.ResultType -eq 'ParameterName') { $_.CompletionText } else { $_.ListItemText };
            @{ label = $label; text = $_.CompletionText; directory = ($_.ResultType -eq 'ProviderContainer') }
        });
        $reply = @{ index = $result.ReplacementIndex; length = $result.ReplacementLength; matches = $items };
        [Console]::WriteLine((ConvertTo-Json -InputObject $reply -Compress -Depth 4));
    } catch { [Console]::WriteLine('{}') }
}
