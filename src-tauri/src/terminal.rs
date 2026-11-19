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
fn install_prompt(shell: &std::ffi::OsStr, writer: &mut dyn Write) -> std::io::Result<()> {
    let marker = r#"printf '\033]2;%s:0:%s\007' "$DIRLUME_PROMPT_TOKEN" "$(printf '%s' "$PWD" | base64 | tr -d '\n')""#;
    let init = match std::path::Path::new(shell).file_name().and_then(std::ffi::OsStr::to_str) {
        Some("bash") => format!("__dirlume_prompt() {{ local status=$?; {marker}; return \"$status\"; }}; PROMPT_COMMAND+=(__dirlume_prompt)"),
        Some("zsh") => format!("__dirlume_prompt() {{ {marker}; }}; precmd_functions+=(__dirlume_prompt)"),
        Some("sh" | "dash" | "ksh") => format!("PS1='$(__dirlume_prompt)'\"$PS1\"; __dirlume_prompt() {{ {marker}; }}"),
        _ => return Ok(()),
    };
    writeln!(writer, "{init}")?;
    writer.flush()
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

fn create(request: OpenTerminal, output: Channel<Output>) -> Result<SharedTerminal> {
    let cwd = local::absolute(&request.directory).map_err(message)?;
    let pair = native_pty_system()
        .openpty(size(request.rows, request.cols))
        .map_err(message)?;
    #[cfg(windows)]
    let mut command = {
        let mut command = CommandBuilder::new("powershell.exe");
        crate::windows_environment::apply(&mut command, request.refresh_environment)
            .map_err(message)?;
        command.args(["-NoLogo", "-NoExit", "-Command", POWERSHELL_PROMPT]);
        command
    };
    #[cfg(not(windows))]
    let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
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
    install_prompt(&shell, &mut *terminal.lock().map_err(message)?.writer).map_err(message)?;
    Ok(terminal)
}

#[tauri::command]
pub async fn open_terminal(
    request: OpenTerminal,
    output: Channel<Output>,
    state: State<'_, Terminals>,
) -> Result<()> {
    let id = request.id;
    let terminal = blocking(move || create(request, output)).await?;
    state.0.lock().map_err(message)?.insert(id, terminal);
    Ok(())
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
