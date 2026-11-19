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
    desktop::{blocking, message, Result},
    diagnostics::{failure, FailureCode},
    local,
};

#[cfg(windows)]
const POWERSHELL_PROMPT: &str = r#"
$global:DirlumeOriginalPrompt = (Get-Item Function:prompt).ScriptBlock
$global:DirlumePromptCount = 0
Import-Module PSReadLine -ErrorAction SilentlyContinue
$dirlumeReadLine = Get-Item Function:PSConsoleHostReadLine -ErrorAction SilentlyContinue
if ($dirlumeReadLine) {
    $global:DirlumeOriginalReadLine = $dirlumeReadLine.ScriptBlock
    function global:PSConsoleHostReadLine {
        $line = & $global:DirlumeOriginalReadLine
        if ($line -is [string] -and $line.Trim()) {
            $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($line))
            [Console]::Title = '{0}:command:{1}' -f $env:DIRLUME_PROMPT_TOKEN, $encoded
        }
        $line
    }
}
function global:prompt {
    $text = & $global:DirlumeOriginalPrompt
    $location = Get-Location
    $path = if ($location.Provider.Name -eq 'FileSystem') {
        [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($location.ProviderPath))
    }
    $global:DirlumePromptCount++
    [Console]::Title = '{0}:{1}:{2}' -f $env:DIRLUME_PROMPT_TOKEN, $global:DirlumePromptCount, $path
    $text
}
"#;

#[cfg(not(windows))]
fn install_prompt(shell: &std::ffi::OsStr, writer: &mut dyn Write) -> std::io::Result<bool> {
    let marker = r#"printf '\033]2;%s:0:%s\007' "$DIRLUME_PROMPT_TOKEN" "$(printf '%s' "$PWD" | base64 | tr -d '\n')""#;
    let init = match std::path::Path::new(shell).file_name().and_then(std::ffi::OsStr::to_str) {
        Some("bash") => r#"__dirlume_prompt() { local status=$?; printf '\033]2;%s:0:%s\007' "$DIRLUME_PROMPT_TOKEN" "$(printf '%s' "$PWD" | base64 | tr -d '\n')"; return "$status"; }; __dirlume_history() { local command pattern='^[[:blank:]]*[0-9]+[ *] (.*)$'; command=$(HISTTIMEFORMAT= builtin history 1; printf .); command=${command%.}; command=${command%$'\n'}; if [[ $command =~ $pattern && -n ${BASH_REMATCH[1]} ]]; then command=${BASH_REMATCH[1]}; printf '\033]2;%s:command:%s\007' "$DIRLUME_PROMPT_TOKEN" "$(printf '%s' "$command" | base64 | tr -d '\n')"; fi; }; HISTFILE=/dev/null; HISTCONTROL=; HISTIGNORE=; shopt -s cmdhist lithist; set -o history; PS0='$(__dirlume_history)'"$PS0"; PROMPT_COMMAND+=(__dirlume_prompt)"#.to_owned(),
        Some("zsh") => r#"__dirlume_prompt() { printf '\033]2;%s:0:%s\007' "$DIRLUME_PROMPT_TOKEN" "$(printf '%s' "$PWD" | base64 | tr -d '\n')"; }; __dirlume_history() { printf '\033]2;%s:command:%s\007' "$DIRLUME_PROMPT_TOKEN" "$(printf '%s' "$1" | base64 | tr -d '\n')"; }; precmd_functions+=(__dirlume_prompt); preexec_functions+=(__dirlume_history)"#.to_owned(),
        Some("sh" | "dash" | "ksh") => format!("PS1='$(__dirlume_prompt)'\"$PS1\"; __dirlume_prompt() {{ {marker}; }}"),
        _ => return Ok(false),
    };
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

type SharedTerminal = Arc<Mutex<Terminal>>;

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
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Output {
    Data { data: String },
    Closed,
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

fn create(request: OpenTerminal, output: Channel<Output>) -> Result<(SharedTerminal, bool)> {
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
        command.args(["-NoLogo", "-NoExit", "-Command", POWERSHELL_PROMPT]);
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
) -> Result<bool> {
    let id = request.id;
    let (terminal, tracks_prompt) = blocking(move || create(request, output)).await?;
    state.0.lock().map_err(message)?.insert(id, terminal);
    Ok(tracks_prompt)
}

#[tauri::command]
pub async fn write_terminal(id: u32, data: String, state: State<'_, Terminals>) -> Result<()> {
    let terminal = state.get(id)?;
    blocking(move || {
        let mut terminal = terminal.lock().map_err(message)?;
        terminal
            .writer
            .write_all(data.as_bytes())
            .map_err(message)?;
        terminal.writer.flush().map_err(message)
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
    blocking(move || {
        terminal
            .lock()
            .map_err(message)?
            .master
            .resize(size(rows, cols))
            .map_err(message)
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

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{
        sync::mpsc,
        time::{Duration, Instant},
    };
    use tauri::ipc::InvokeResponseBody;

    #[test]
    fn reports_powershell_submission_from_the_real_pty() {
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
        let fixture = tempfile::tempdir().unwrap();
        let (terminal, _) = create(
            OpenTerminal {
                id: 1,
                directory: local::display_path(fixture.path()).unwrap(),
                prompt_token: "Dirlume-terminal-fixture".to_owned(),
                rows: 25,
                cols: 120,
                refresh_environment: false,
            },
            output,
        )
        .unwrap();
        let read_until = |marker: &str| {
            let expires = Instant::now() + Duration::from_secs(12);
            let mut bytes = Vec::new();
            let mut answered = 0;
            while let Ok(chunk) =
                receive.recv_timeout(expires.saturating_duration_since(Instant::now()))
            {
                bytes.extend(chunk);
                let output = String::from_utf8_lossy(&bytes);
                let reports = output.matches("\x1b[6n").count();
                if reports > answered {
                    let mut terminal = terminal.lock().unwrap();
                    for _ in answered..reports {
                        terminal.writer.write_all(b"\x1b[1;1R").unwrap();
                    }
                    terminal.writer.flush().unwrap();
                    answered = reports;
                }
                if output.contains(marker) {
                    return;
                }
            }
            panic!(
                "Prompt or history marker missing: {marker}; received: {:?}",
                String::from_utf8_lossy(&bytes[..bytes.len().min(2200)])
            );
        };
        read_until("Dirlume-terminal-fixture:1:");
        let submitted = "Write-Output 'terminal-history-fixture'";
        {
            let mut terminal = terminal.lock().unwrap();
            write!(terminal.writer, "{submitted}\r").unwrap();
            terminal.writer.flush().unwrap();
        }
        read_until(&format!(
            "Dirlume-terminal-fixture:command:{}",
            STANDARD.encode(submitted)
        ));
    }
}
