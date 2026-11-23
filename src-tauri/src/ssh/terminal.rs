use base64::{engine::general_purpose::STANDARD, Engine};
use std::{sync::Arc, time::Duration};

use russh::{client::Msg, ChannelMsg, ChannelWriteHalf};
use tauri::{async_runtime, ipc::Channel};

use super::{quote, wait, AuthenticatedRoute, Connection, Session};
use crate::{
    desktop::{message, Result},
    remote_transfer::UploadSession as _,
    terminal::Output,
};

pub struct RemoteTerminal {
    client: Arc<AuthenticatedRoute>,
    writer: ChannelWriteHalf<Msg>,
    reader: async_runtime::JoinHandle<()>,
}

impl RemoteTerminal {
    pub fn write(&self, data: String) -> Result<()> {
        wait(self.writer.data_bytes(data))
    }

    pub fn resize(&self, rows: u16, cols: u16) -> Result<()> {
        wait(self.writer.window_change(cols.into(), rows.into(), 0, 0))
    }

    pub(crate) async fn complete(&self, script: &str) -> Result<Vec<u8>> {
        complete(&self.client, script).await
    }
}

pub(super) async fn complete(client: &AuthenticatedRoute, script: &str) -> Result<Vec<u8>> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    let mut channel = tokio::time::timeout_at(deadline, client.channel_open_session())
        .await
        .map_err(message)?
        .map_err(message)?;
    let result = tokio::time::timeout_at(deadline, async {
        channel
            .exec(true, format!("exec /bin/sh -c {}", quote(script)))
            .await
            .map_err(message)?;
        let mut output = Vec::new();
        while let Some(event) = channel.wait().await {
            match event {
                ChannelMsg::Data { data } if output.len() + data.len() <= 64 * 1024 => {
                    output.extend_from_slice(&data);
                }
                ChannelMsg::Data { .. } | ChannelMsg::Failure => return Ok(Vec::new()),
                ChannelMsg::ExitStatus { exit_status } if exit_status != 0 => return Ok(Vec::new()),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok(output)
    })
    .await;
    let _ = tokio::time::timeout(Duration::from_millis(100), channel.close()).await;
    result.map_err(message)?
}

impl Drop for RemoteTerminal {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

pub fn open_shell(
    connection: &Connection,
    segments: &[String],
    prompt_token: &str,
    rows: u16,
    cols: u16,
    output: Channel<Output>,
) -> Result<RemoteTerminal> {
    let path = Session::absolute(segments)?;
    if prompt_token.is_empty()
        || prompt_token.len() > 80
        || !prompt_token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("Invalid terminal prompt token.".to_owned());
    }
    let client = Arc::new(connection.authenticated_client()?);
    let bash = quote(&crate::terminal::unix_prompt("bash", true));
    let zsh = quote(&crate::terminal::unix_prompt("zsh", true));
    let fallback = quote(&crate::terminal::unix_prompt("sh", true));
    let command = format!(
        "CDPATH= cd -- {} || exit\n\
        shell=${{SHELL:-/bin/sh}}\n\
        case \"${{shell##*/}}\" in bash|zsh|sh|dash|ksh) ;; *) shell=/bin/sh ;; esac\n\
        case \"${{shell##*/}}\" in bash) DIRLUME_SHELL_INIT={bash} ;; zsh) DIRLUME_SHELL_INIT={zsh} ;; *) DIRLUME_SHELL_INIT={fallback} ;; esac\n\
        export DIRLUME_SHELL_INIT DIRLUME_PROMPT_TOKEN={prompt_token}\n\
        printf '\\033]2;{prompt_token}:init\\007'\n\
        exec \"$shell\" -i",
        quote(&path)
    );
    let channel = wait(async {
        let mut channel = client.channel_open_session().await.map_err(message)?;
        channel
            .request_pty(true, "xterm-256color", cols.into(), rows.into(), 0, 0, &[])
            .await
            .map_err(message)?;
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => break,
                Some(ChannelMsg::Failure | ChannelMsg::Eof | ChannelMsg::Close) | None => {
                    return Err("The SSH server did not allocate a terminal.".to_owned())
                }
                _ => {}
            }
        }
        channel
            .exec(true, format!("exec /bin/sh -c {}", quote(&command)))
            .await
            .map_err(message)?;
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => return Ok(channel),
                Some(ChannelMsg::Failure | ChannelMsg::Eof | ChannelMsg::Close) | None => {
                    return Err("The SSH server did not open an interactive shell.".to_owned())
                }
                _ => {}
            }
        }
    })?;
    let (mut reader, writer) = channel.split();
    let reader = async_runtime::spawn(async move {
        while let Some(message) = reader.wait().await {
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    if output
                        .send(Output::Data {
                            data: STANDARD.encode(data),
                        })
                        .is_err()
                    {
                        break;
                    }
                }
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        let _ = output.send(Output::Closed);
    });
    Ok(RemoteTerminal {
        client,
        writer,
        reader,
    })
}
