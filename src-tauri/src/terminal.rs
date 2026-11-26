use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, State};

use crate::{
    desktop::{blocking, blocking_for, message, Result},
    diagnostics::{failure, FailureCode},
    local, ssh,
};

#[cfg(windows)]
const POWERSHELL_PROMPT: &str = r#"
$global:DirlumeOriginalPrompt = (Get-Item Function:prompt).ScriptBlock
$global:DirlumePromptCount = 0
$global:DirlumeLastHistoryId = 0
$global:DirlumeCommandCount = 0
$global:DirlumeLatestCommand = ''
Microsoft.PowerShell.Core\Import-Module -Name PSReadLine -ErrorAction SilentlyContinue
$dirlumeReadLine = Get-Item Function:PSConsoleHostReadLine -ErrorAction SilentlyContinue
$global:DirlumeTracksSubmissions = [bool]$dirlumeReadLine
function global:Send-DirlumeCommand([string]$line) {
    if ($line.Trim()) {
        $global:DirlumeCommandCount++
        $global:DirlumeLatestCommand = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($line))
        [Console]::Title = '{0}:command:{1}:{2}' -f $env:DIRLUME_PROMPT_TOKEN, $global:DirlumeCommandCount, $global:DirlumeLatestCommand
    }
}
function global:Invoke-DirlumeDnsFlush([string]$program, [string]$option) {
    if ($program -notmatch '\Aipconfig(?:\.exe)?\z' -or $option -notmatch '\A/flushdns\z') {
        throw 'The command is not supported for elevation.'
    }
    $systemIpConfig = [IO.Path]::Combine([Environment]::SystemDirectory, 'ipconfig.exe')
    $resolved = Microsoft.PowerShell.Core\Get-Command -Name $program -ErrorAction SilentlyContinue
    $location = Microsoft.PowerShell.Management\Get-Location
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $elevated = [Security.Principal.WindowsPrincipal]::new($identity).IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator)
    } finally {
        $identity.Dispose()
    }
    if ($elevated -or !$resolved -or $resolved.CommandType -ne 'Application' -or $resolved.Path -ine $systemIpConfig -or
        $location.Provider.Name -ne 'FileSystem') {
        & $program $option
        return
    }
    $output = @(& $systemIpConfig $option 2>&1)
    $exitCode = $LASTEXITCODE
    $lines = @($output | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
    $requiresElevation = [ComponentModel.Win32Exception]::new(740).Message.TrimEnd([char[]]'.。')
    # ipconfig returns 1 for this error. Match the entire result of the resolved system command.
    if ($exitCode -ne 1 -or $lines.Count -ne 1 -or $lines[0].TrimEnd([char[]]'.。') -ne $requiresElevation) {
        $output
        return
    }
    $launch = @{
        FilePath = $systemIpConfig; ArgumentList = $option; WorkingDirectory = $location.ProviderPath
        Verb = 'RunAs'; WindowStyle = 'Hidden'; Wait = $true; PassThru = $true; ErrorAction = 'Stop'
    }
    try {
        $result = Microsoft.PowerShell.Management\Start-Process @launch
        $global:LASTEXITCODE = $result.ExitCode
        if ($result.ExitCode -eq 0) {
            [ComponentModel.Win32Exception]::new(0).Message
        } else {
            Write-Error ("ipconfig exited with code {0}." -f $result.ExitCode)
        }
    } catch {
        $cause = $_.Exception
        while ($cause.InnerException) { $cause = $cause.InnerException }
        if ($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 1223) {
            $cause.Message
        } else {
            throw
        }
    }
}
if ($dirlumeReadLine) {
    $global:DirlumeOriginalReadLine = $dirlumeReadLine.ScriptBlock
    function global:PSConsoleHostReadLine {
        $line = & $global:DirlumeOriginalReadLine
        if ($line -is [string]) {
            Send-DirlumeCommand $line
            if ($line -match '\A[ \t]*(ipconfig(?:\.exe)?)[ \t]+(/flushdns)[ \t]*\z') {
                return "Invoke-DirlumeDnsFlush '$($Matches[1])' '$($Matches[2])'"
            }
        }
        $line
    }
}
function global:prompt {
    $text = & $global:DirlumeOriginalPrompt
    if (-not $global:DirlumeTracksSubmissions) {
        $previous = Microsoft.PowerShell.Core\Get-History -Count 1
        if ($previous -and $previous.Id -gt $global:DirlumeLastHistoryId) {
            $global:DirlumeLastHistoryId = $previous.Id
            # The first prompt can see the encoded startup script in PowerShell history.
            if ($global:DirlumePromptCount -gt 0) {
                Send-DirlumeCommand $previous.CommandLine
            }
        }
    }
    $location = Get-Location
    $path = if ($location.Provider.Name -eq 'FileSystem') {
        [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($location.ProviderPath))
    }
    $global:DirlumePromptCount++
    $editor = 'powershell'
    $settings = @{
        PATH = $env:PATH
        DOCKER_CONFIG = $env:DOCKER_CONFIG
        DOCKER_CONTEXT = $env:DOCKER_CONTEXT
        DOCKER_HOST = $env:DOCKER_HOST
        DOCKER_TLS = $env:DOCKER_TLS
        DOCKER_TLS_VERIFY = $env:DOCKER_TLS_VERIFY
        DOCKER_CERT_PATH = $env:DOCKER_CERT_PATH
        DOCKER_API_VERSION = $env:DOCKER_API_VERSION
        COMPOSE_FILE = $env:COMPOSE_FILE
        COMPOSE_PATH_SEPARATOR = $env:COMPOSE_PATH_SEPARATOR
        COMPOSE_PROJECT_NAME = $env:COMPOSE_PROJECT_NAME
        COMPOSE_PROFILES = $env:COMPOSE_PROFILES
        COMPOSE_ENV_FILES = $env:COMPOSE_ENV_FILES
        COMPOSE_DISABLE_ENV_FILE = $env:COMPOSE_DISABLE_ENV_FILE
    }
    $settingsBytes = [Text.Encoding]::UTF8.GetBytes((Microsoft.PowerShell.Utility\ConvertTo-Json $settings -Compress))
    $settingsMarker = if ($settingsBytes.Length -le 12288) { [Convert]::ToBase64String($settingsBytes) }
    [Console]::Title = '{0}:{1}:{2}:{3}:{4}:{5}:{6}' -f $env:DIRLUME_PROMPT_TOKEN, $global:DirlumePromptCount, $path, $global:DirlumeCommandCount, $global:DirlumeLatestCommand, $editor, $settingsMarker
    $text
}
"#;

pub(crate) fn unix_prompt(shell: &str, remote: bool) -> String {
    let editor = if matches!(shell, "bash" | "zsh") {
        shell
    } else {
        ""
    };
    let search_path = if remote {
        r#" "$(printf '%s' "$PATH" | /usr/bin/base64 | /usr/bin/tr -d '\n')""#
    } else {
        ""
    };
    // A noninteractive subprocess sees the shell's exported environment, including variables set after startup.
    let environment = crate::completion::DOCKER_COMPLETION_ENVIRONMENT.iter().map(|name| {
        format!(r#"if [ "${{{name}+x}}" ]; then printf '%s=%s\000' {name} "${{{name}}}"; else printf '%s\000' {name}; fi"#)
    }).collect::<Vec<_>>().join("; ");
    let environment = crate::ssh::quote(&environment);
    let marker = format!(
        r#"printf '\033]2;%s:0:%s:::{editor}{}:%s\007' "$DIRLUME_PROMPT_TOKEN" "$(printf '%s' "$PWD" | base64 | tr -d '\n')"{search_path} "$(/bin/sh -c {environment} | /usr/bin/base64 | /usr/bin/tr -d '\n')""#,
        if remote { ":%s" } else { ":" }
    );
    match shell {
        "bash" => [
            r#"__dirlume_history() { local command id pattern='^[[:blank:]]*([0-9]+)[ *] (.*)$';"#,
            r#"command=$(HISTTIMEFORMAT= builtin history 1; printf .); command=${command%.}; command=${command%$'\n'};"#,
            r#"if [[ ! $command =~ $pattern || -z ${BASH_REMATCH[2]} ]]; then return; fi;"#,
            r#"id=${BASH_REMATCH[1]}; command=${BASH_REMATCH[2]};"#,
            r#"local previous=${__dirlume_history_id-}; __dirlume_history_id=$id; [[ $1 != baseline && ${__dirlume_history_ready-} && $previous != "$id" && -o history ]] || return;"#,
            r#"printf '\033]2;%s:command:%s\007' "$DIRLUME_PROMPT_TOKEN" "$(printf '%s' "$command" | base64 | tr -d '\n')"; };"#,
            r#"__dirlume_prompt() { local status=$?; __dirlume_history "$__dirlume_prompt_mode"; __dirlume_history_ready=1;"#,
            &marker,
            r#"; return "$status"; };"#,
            r#"if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then __dirlume_prompt_mode=baseline; PS0='$(__dirlume_history submitted)'"${PS0-}"; else __dirlume_prompt_mode=prompt; fi;"#,
            r#"if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a '* ]]; then PROMPT_COMMAND+=(__dirlume_prompt); else PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND; }__dirlume_prompt"; fi"#,
        ].join(" "),
        "zsh" => format!(r#"__dirlume_prompt() {{ {marker}; }}; __dirlume_history() {{ printf '\033]2;%s:command:%s\007' "$DIRLUME_PROMPT_TOKEN" "$(printf '%s' "$1" | base64 | tr -d '\n')"; }}; precmd_functions+=(__dirlume_prompt); preexec_functions+=(__dirlume_history)"#),
        _ => format!("PS1='$(__dirlume_prompt)'\"$PS1\"; __dirlume_prompt() {{ {marker}; }}"),
    }
}

#[cfg(any(not(windows), test))]
fn install_prompt(shell: &std::ffi::OsStr, writer: &mut dyn Write) -> std::io::Result<bool> {
    let Some(shell @ ("bash" | "zsh" | "sh" | "dash" | "ksh")) = std::path::Path::new(shell)
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
    else {
        return Ok(false);
    };
    let init = unix_prompt(shell, false);
    writeln!(writer, "{init}")?;
    writer.flush()?;
    Ok(true)
}

struct Terminal {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn ChildKiller + Send + Sync>,
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

#[derive(Clone)]
enum SharedTerminal {
    Local(Arc<Mutex<Terminal>>),
    Ssh(Arc<ssh::RemoteTerminal>),
}

#[derive(Default)]
pub struct Terminals(Mutex<HashMap<u32, SharedTerminal>>);

impl Terminals {
    fn get(&self, id: u32) -> Result<SharedTerminal> {
        self.0
            .lock()
            .map_err(message)?
            .get(&id)
            .cloned()
            .ok_or_else(|| "This terminal session has closed.".to_owned())
    }

    pub(crate) fn remote(&self, id: u32) -> Result<Arc<ssh::RemoteTerminal>> {
        match self.get(id)? {
            SharedTerminal::Ssh(terminal) => Ok(terminal),
            SharedTerminal::Local(_) => Err("This terminal is not an SSH session.".to_owned()),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Output {
    Data { data: String },
    Closed,
    Disconnected,
}

fn size(rows: u16, cols: u16) -> PtySize {
    PtySize {
        rows: rows.clamp(1, 256),
        cols: cols.clamp(1, 512),
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTerminal {
    id: u32,
    directory: String,
    prompt_token: String,
    rows: u16,
    cols: u16,
    refresh_environment: bool,
    ssh: Option<SshSource>,
}

#[derive(Deserialize)]
struct SshSource {
    connection: u32,
    segments: Vec<String>,
}

pub fn shell_program() -> std::ffi::OsString {
    #[cfg(windows)]
    {
        "powershell.exe".into()
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into())
    }
}

fn create(request: OpenTerminal, output: Channel<Output>) -> Result<(Arc<Mutex<Terminal>>, bool)> {
    let cwd = local::absolute(&request.directory).map_err(message)?;
    let pair = native_pty_system()
        .openpty(size(request.rows, request.cols))
        .map_err(message)?;
    let shell = shell_program();
    #[cfg(windows)]
    let mut command = {
        let mut command = CommandBuilder::new(&shell);
        crate::windows_environment::apply(&mut command, request.refresh_environment)
            .map_err(message)?;
        // Pass the bootstrap as one argument through the Windows command line.
        let startup = STANDARD.encode(
            POWERSHELL_PROMPT
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        command.args(["-NoLogo", "-NoExit", "-EncodedCommand", &startup]);
        command
    };
    #[cfg(not(windows))]
    let mut command = CommandBuilder::new(&shell);
    #[cfg(not(windows))]
    let _ = request.refresh_environment;
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    command.env("DIRLUME_PROMPT_TOKEN", request.prompt_token);
    let mut reader = pair.master.try_clone_reader().map_err(message)?;
    let writer = pair.master.take_writer().map_err(message)?;
    let mut child = pair.slave.spawn_command(command).map_err(message)?;
    drop(pair.slave);
    let terminal = Arc::new(Mutex::new(Terminal {
        master: pair.master,
        writer,
        child: child.clone_killer(),
    }));
    std::thread::Builder::new()
        .name("dirlume-terminal".into())
        .spawn(move || {
            let mut bytes = [0; 8192];
            loop {
                let length = match reader.read(&mut bytes) {
                    Ok(length) => length,
                    Err(error) => {
                        // Unplugging the child side of a PTY commonly returns EIO on Linux.
                        let closed = matches!(
                            error.kind(),
                            std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::UnexpectedEof
                        ) || (cfg!(unix) && error.raw_os_error() == Some(5));
                        if !closed {
                            failure("read_terminal", FailureCode::Io, error.raw_os_error());
                        }
                        break;
                    }
                };
                if length == 0
                    || output
                        .send(Output::Data {
                            data: STANDARD.encode(&bytes[..length]),
                        })
                        .is_err()
                {
                    break;
                }
            }
            let _ = output.send(Output::Closed);
            if let Err(error) = child.wait() {
                failure("wait_terminal", FailureCode::Io, error.raw_os_error());
            }
        })
        .map_err(message)?;
    #[cfg(not(windows))]
    let tracks_prompt =
        install_prompt(&shell, &mut *terminal.lock().map_err(message)?.writer).map_err(message)?;
    #[cfg(windows)]
    let tracks_prompt = true;
    Ok((terminal, tracks_prompt))
}

#[tauri::command]
pub async fn open_terminal(
    request: OpenTerminal,
    output: Channel<Output>,
    state: State<'_, Terminals>,
    ssh_state: State<'_, ssh::SshState>,
) -> Result<bool> {
    let id = request.id;
    let connection = request
        .ssh
        .as_ref()
        .map(|source| ssh_state.connection(source.connection))
        .transpose()?;
    let (terminal, tracks_prompt) = blocking_for("open_terminal", move || {
        if let (Some(source), Some(connection)) = (&request.ssh, connection) {
            let dimensions = size(request.rows, request.cols);
            let terminal = ssh::open_shell(
                &connection,
                &source.segments,
                &request.prompt_token,
                dimensions.rows,
                dimensions.cols,
                output,
            )?;
            Ok((SharedTerminal::Ssh(Arc::new(terminal)), true))
        } else {
            create(request, output)
                .map(|(terminal, tracks_prompt)| (SharedTerminal::Local(terminal), tracks_prompt))
        }
    })
    .await?;
    state.0.lock().map_err(message)?.insert(id, terminal);
    Ok(tracks_prompt)
}

#[tauri::command]
pub async fn write_terminal(id: u32, data: String, state: State<'_, Terminals>) -> Result<()> {
    let terminal = state.get(id)?;
    blocking(move || match terminal {
        SharedTerminal::Local(terminal) => {
            let mut terminal = terminal.lock().map_err(message)?;
            terminal
                .writer
                .write_all(data.as_bytes())
                .map_err(message)?;
            terminal.writer.flush().map_err(message)
        }
        SharedTerminal::Ssh(terminal) => terminal.write(data),
    })
    .await
}

#[tauri::command]
pub async fn resize_terminal(
    id: u32,
    rows: u16,
    cols: u16,
    state: State<'_, Terminals>,
) -> Result<()> {
    let terminal = state.get(id)?;
    let size = size(rows, cols);
    blocking(move || match terminal {
        SharedTerminal::Local(terminal) => terminal
            .lock()
            .map_err(message)?
            .master
            .resize(size)
            .map_err(message),
        SharedTerminal::Ssh(terminal) => terminal.resize(size.rows, size.cols),
    })
    .await
}

#[tauri::command]
pub async fn close_terminal(id: u32, state: State<'_, Terminals>) -> Result<()> {
    let terminal = state.0.lock().map_err(message)?.remove(&id);
    blocking(move || {
        drop(terminal);
        Ok(())
    })
    .await
}

#[cfg(all(test, unix))]
#[test]
fn reports_directory_changes_at_the_unix_shell_prompt() {
    use std::process::{Command, Stdio};

    let (shell, args): (&str, &[&str]) = if cfg!(target_os = "macos") {
        ("/bin/zsh", &["-f", "-i"])
    } else {
        ("/bin/bash", &["--noprofile", "--norc", "-i"])
    };
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    let next = root.join("test directory");
    std::fs::create_dir(&next).unwrap();
    let token = "Dirlume-directory-fixture";
    let mut child = Command::new(shell)
        .args(args)
        .current_dir(&root)
        .env("DIRLUME_PROMPT_TOKEN", token)
        .env("HISTFILE", "/dev/null")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    assert!(install_prompt(shell.as_ref(), &mut stdin).unwrap());
    writeln!(stdin, "cd -- 'test directory'").unwrap();
    writeln!(stdin, "cd -- 'missing directory'").unwrap();
    writeln!(stdin, "exit 0").unwrap();
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let prompt = format!("\x1b]2;{token}:0:");
    let directories: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .split(&prompt)
        .skip(1)
        .map(|marker| {
            let encoded = marker.split_once(':').unwrap().0;
            String::from_utf8(STANDARD.decode(encoded).unwrap()).unwrap()
        })
        .collect();
    assert_eq!(
        directories,
        [
            root.to_string_lossy().into_owned(),
            next.to_string_lossy().into_owned(),
            next.to_string_lossy().into_owned(),
        ]
    );
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{
        sync::mpsc,
        time::{Duration, Instant},
    };
    use tauri::ipc::InvokeResponseBody;

    const PROMPT_TOKEN: &str = "Dirlume-terminal-fixture";

    fn open_fixture(directory: &str) -> (Arc<Mutex<Terminal>>, mpsc::Receiver<Vec<u8>>) {
        let (send, receive) = mpsc::channel();
        let output = Channel::new(move |body| {
            if let InvokeResponseBody::Json(body) = body {
                let value: serde_json::Value = serde_json::from_str(&body).unwrap();
                if let Some(encoded) = value["data"].as_str() {
                    let _ = send.send(STANDARD.decode(encoded).unwrap());
                }
            }
            Ok(())
        });
        let (terminal, _) = create(
            OpenTerminal {
                id: 1,
                directory: directory.to_owned(),
                prompt_token: PROMPT_TOKEN.to_owned(),
                rows: 25,
                cols: 120,
                refresh_environment: false,
                ssh: None,
            },
            output,
        )
        .unwrap();
        (terminal, receive)
    }

    fn read_until(
        terminal: &Arc<Mutex<Terminal>>,
        receive: &mpsc::Receiver<Vec<u8>>,
        found: impl Fn(&str) -> bool,
    ) -> Option<String> {
        let expires = Instant::now() + Duration::from_secs(15);
        let mut bytes = Vec::new();
        let mut responses = [
            ("\x1b[6n", b"\x1b[1;1R".as_slice(), 0),
            ("\x1b[c", b"\x1b[?1;2c".as_slice(), 0),
        ];
        while let Ok(chunk) =
            receive.recv_timeout(expires.saturating_duration_since(Instant::now()))
        {
            bytes.extend(chunk);
            let output = String::from_utf8_lossy(&bytes);
            for (query, reply, answered) in &mut responses {
                let requests = output.matches(*query).count();
                if requests > *answered {
                    let mut terminal = terminal.lock().unwrap();
                    for _ in *answered..requests {
                        terminal.writer.write_all(reply).unwrap();
                    }
                    terminal.writer.flush().unwrap();
                    *answered = requests;
                }
            }
            if found(&output) {
                return None;
            }
        }
        Some(String::from_utf8_lossy(&bytes[..bytes.len().min(2200)]).into_owned())
    }

    #[test]
    fn reports_powershell_submission_from_the_real_pty() {
        let fixture = tempfile::tempdir().unwrap();
        let directory = local::display_path(fixture.path()).unwrap();
        let initial_prompt = format!("{PROMPT_TOKEN}:1:");
        let mut attempt = 1;
        let (terminal, receive) = loop {
            let (terminal, receive) = open_fixture(&directory);
            let Some(output) = read_until(&terminal, &receive, |output| {
                output.contains(&initial_prompt)
            }) else {
                break (terminal, receive);
            };
            // A hosted Windows runner can stall while ConPTY negotiates its initial cursor position.
            // Retry only the startup handshake. The submission assertion still requires a live shell.
            assert!(
                attempt < 3 && output.contains("\x1b[6n"),
                "Initial PowerShell prompt missing on attempt {attempt}; received: {output:?}"
            );
            eprintln!("Retrying ConPTY startup after attempt {attempt}: {output:?}");
            attempt += 1;
        };
        let submitted = "Write-Output 'terminal-history-fixture'";
        {
            let mut terminal = terminal.lock().unwrap();
            write!(terminal.writer, "{submitted}\r").unwrap();
            terminal.writer.flush().unwrap();
        }
        let command = STANDARD.encode(submitted);
        let submitted_marker = format!("Dirlume-terminal-fixture:command:1:{command}\x07");
        let prompt_marker = format!(":1:{command}:");
        // ConPTY can coalesce the submission and prompt title updates for a fast command.
        let missed = read_until(&terminal, &receive, |output| {
            output.contains(&submitted_marker)
                || output.split("\x1b]").any(|title| {
                    title.contains("Dirlume-terminal-fixture:2:") && title.contains(&prompt_marker)
                })
        });
        assert!(
            missed.is_none(),
            "Submitted command marker missing: {missed:?}"
        );
    }
}

#[cfg(test)]
mod bash_history_tests {
    use super::install_prompt;
    use std::{
        ffi::OsStr,
        io::Write,
        process::{Command, Stdio},
    };
    #[test]
    fn reports_only_history_eligible_submissions() {
        #[cfg(windows)]
        let bash = std::path::PathBuf::from(std::env::var_os("ProgramFiles").unwrap_or_default())
            .join("Git/bin/bash.exe");
        #[cfg(windows)]
        if !bash.is_file() {
            return;
        }
        #[cfg(unix)]
        let bash = "bash";
        let mut shell = Command::new(bash)
            .args(["--noprofile", "--norc", "-i"])
            .env("HISTFILE", "/dev/null")
            .env("HISTCONTROL", "ignorespace")
            .env("HISTIGNORE", "*ignored-marker*")
            .env("DIRLUME_PROMPT_TOKEN", "fixture")
            .env("PS1", "")
            .env("PS2", "")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = shell.stdin.take().unwrap();
        install_prompt(OsStr::new("bash"), &mut input).unwrap();
        writeln!(
            input,
            ": allowed-marker\n: ignored-marker\n : private-marker\nexit"
        )
        .unwrap();
        drop(input);
        let result = shell.wait_with_output().unwrap();
        assert!(result.status.success());
        use base64::{engine::general_purpose::STANDARD, Engine};
        let output = format!(
            "{}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        for (command, count) in [
            (": allowed-marker", 1),
            (": ignored-marker", 0),
            (" : private-marker", 0),
        ] {
            let marker = format!("fixture:command:{}\x07", STANDARD.encode(command));
            assert_eq!(output.matches(&marker).count(), count, "{command}");
        }
    }
}
