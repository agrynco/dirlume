use std::{
    sync::{Arc, Weak},
    time::{Duration, Instant},
};

use openssh_sftp_client::Sftp;
use russh::ChannelMsg;
use tauri::async_runtime;
use tokio::{io::AsyncWriteExt, sync::Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use super::{AuthenticatedRoute, Connection, Session};
use crate::{
    desktop::{message, Result},
    netbox_connection,
};

const IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

struct Authorization {
    session: Session,
    read_only: bool,
    expires: Instant,
}

#[derive(Default)]
pub(super) struct Access(Arc<Mutex<Option<Authorization>>>);

impl Access {
    pub(super) fn run<T>(
        &self,
        connection: &Connection,
        password: Option<Zeroizing<String>>,
        read_only: bool,
        stop: Option<CancellationToken>,
        operation: impl FnOnce(&mut Session) -> Result<T>,
    ) -> Result<Option<T>> {
        let mut state =
            async_runtime::block_on(netbox_connection::wait(None, stop.as_ref(), self.0.lock()))
                .map_err(|error| message(std::io::Error::from(error)))?;
        if let Some(current) = state.as_mut().filter(|current| {
            password.is_none()
                && current.expires > Instant::now()
                && !current.session.is_closed()
                && (!current.read_only || read_only)
        }) {
            current.session.set_cancel(stop);
            let result = operation(&mut current.session);
            current.session.set_cancel(None);
            if result.is_ok() {
                current.expires = Instant::now() + IDLE_TIMEOUT;
            } else if current.session.is_closed() {
                current.expires = Instant::now();
                return Ok(None);
            }
            return result.map(Some);
        }

        let Some(password) = password else {
            return Ok(None);
        };
        let mut session = open_sftp(
            connection.authenticated_client_with_cancel(stop)?,
            password,
            read_only,
        )?;
        let result = operation(&mut session)?;
        session.set_cancel(None);
        let start_timer = state.is_none();
        *state = Some(Authorization {
            session,
            read_only,
            expires: Instant::now() + IDLE_TIMEOUT,
        });
        if start_timer {
            async_runtime::spawn(expire(Arc::downgrade(&self.0)));
        }
        Ok(Some(result))
    }
}

async fn expire(cache: Weak<Mutex<Option<Authorization>>>) {
    let mut delay = IDLE_TIMEOUT;
    loop {
        tokio::time::sleep(delay).await;
        let Some(cache) = cache.upgrade() else { return };
        let mut state = cache.lock().await;
        let Some(current) = state.as_ref() else {
            return;
        };
        delay = current.expires.saturating_duration_since(Instant::now());
        if delay.is_zero() {
            *state = None;
            return;
        }
    }
}

fn open_sftp(
    client: AuthenticatedRoute,
    mut password: Zeroizing<String>,
    read_only: bool,
) -> Result<Session> {
    if password.contains(['\0', '\r', '\n']) {
        return Err("Enter a single-line sudo password.".to_owned());
    }
    let prompt = format!("[dirlume-sudo-{}]", Uuid::new_v4());
    let read_flag = if read_only { " -R" } else { "" };
    // Use a separate SSH exec channel without a PTY so binary SFTP data stays on
    // stdout and sudo's password prompt stays on stderr.
    let script = format!(
        "for server in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server \
        /usr/lib/ssh/sftp-server /usr/libexec/sftp-server /usr/lib/misc/sftp-server; do\n\
        if [ -x \"$server\" ]; then exec sudo -S -p '{prompt}' -- \"$server\" -e -l INFO{read_flag}; fi\n\
        done\nexit 127"
    );
    let command = format!("exec /bin/sh -c {}", super::quote(&script));
    let sftp = client.1.wait(async {
        let mut channel = client.channel_open_session().await.map_err(message)?;
        channel.exec(true, command).await.map_err(message)?;
        let mut supplied = false;
        let mut stderr = Vec::new();
        loop {
            match channel.wait().await {
                Some(ChannelMsg::ExtendedData { data, ext: 1 }) => {
                    stderr.extend_from_slice(&data);
                    let contains = |needle: &str| {
                        stderr
                            .windows(needle.len())
                            .any(|part| part == needle.as_bytes())
                    };
                    if contains("session opened for local user ") {
                        break;
                    }
                    if contains(&prompt) {
                        if supplied {
                            return Err("The server rejected the sudo password.".to_owned());
                        }
                        if password.is_empty() {
                            return Err("Enter the sudo password for this SSH account.".to_owned());
                        }
                        password.push('\n');
                        channel
                            .make_writer()
                            .write_all(password.as_bytes())
                            .await
                            .map_err(message)?;
                        password.zeroize();
                        supplied = true;
                        stderr.clear();
                    } else if stderr.len() > 4096 {
                        stderr.drain(..stderr.len() - 4096);
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status: 127 }) => {
                    return Err(
                        "The SSH server could not find sudo or the OpenSSH SFTP server.".to_owned(),
                    );
                }
                Some(
                    ChannelMsg::Failure
                    | ChannelMsg::Data { .. }
                    | ChannelMsg::ExitStatus { .. }
                    | ChannelMsg::Eof
                    | ChannelMsg::Close,
                )
                | None => {
                    return Err(
                        "The SSH server did not allow an SFTP session through sudo.".to_owned()
                    );
                }
                _ => {}
            }
        }
        let (reader, writer) = tokio::io::split(channel.into_stream());
        Sftp::new(writer, reader, Default::default())
            .await
            .map_err(message)
    })?;
    Ok(Session::new(client, sftp))
}
