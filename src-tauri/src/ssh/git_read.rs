use std::time::Duration;

use russh::ChannelMsg;

use super::{quote, AuthenticatedRoute};
use crate::{message, Result};

pub(crate) struct GitOutput {
    pub(crate) status: u32,
    pub(crate) stdout: Option<Vec<u8>>,
    pub(crate) stderr: String,
}

pub(super) async fn read(
    client: &AuthenticatedRoute,
    script: &str,
    limit: usize,
) -> Result<GitOutput> {
    let max = Duration::from_secs(10);
    let deadline =
        tokio::time::Instant::now() + client.1.timeout().map_or(max, |timeout| timeout.min(max));
    let mut channel = tokio::time::timeout_at(deadline, client.channel_open_session())
        .await
        .map_err(message)?
        .map_err(message)?;
    let result = tokio::time::timeout_at(deadline, async {
        channel
            .exec(true, format!("exec /bin/sh -c {}", quote(script)))
            .await
            .map_err(message)?;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut status = None;
        while let Some(event) = channel.wait().await {
            match event {
                ChannelMsg::Data { data } => {
                    if stdout.len().saturating_add(data.len()) > limit {
                        return Ok(GitOutput {
                            status: 0,
                            stdout: None,
                            stderr: String::new(),
                        });
                    }
                    stdout.extend_from_slice(&data);
                }
                ChannelMsg::ExtendedData { data, ext: 1 } => {
                    stderr.extend_from_slice(
                        &data[..data.len().min(4096usize.saturating_sub(stderr.len()))],
                    );
                }
                ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                ChannelMsg::Failure => {
                    return Err("SSH command execution is unavailable.".to_owned())
                }
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok(GitOutput {
            status: status.ok_or("The SSH command did not finish.")?,
            stdout: Some(stdout),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        })
    })
    .await;
    let _ = tokio::time::timeout(Duration::from_millis(100), channel.close()).await;
    result.map_err(message)?
}
