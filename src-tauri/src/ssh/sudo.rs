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

use super::{
    standard_rename::{self, RenameSession},
    AuthenticatedRoute, Connection, Session,
};
use crate::{
    desktop::{message, Result},
    netbox_connection,
};

const IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

struct Authorization {
    session: Session,
    rename: Option<RenameSession>,
    read_only: bool,
    expires: Instant,
}

impl Authorization {
    fn open(
        connection: &Connection,
        password: Zeroizing<String>,
        read_only: bool,
        stop: Option<CancellationToken>,
    ) -> Result<Self> {
        let (session, rename) = open_sftp(
            connection.authenticated_client_with_cancel(stop)?,
            password,
            read_only,
        )?;
        Ok(Self {
            session: session.with_recycle(connection.profile.environment.recycle_bin.clone(), true),
            rename,
            read_only,
            expires: Instant::now() + IDLE_TIMEOUT,
        })
    }

    fn alive(&self, read_only: bool) -> bool {
        self.expires > Instant::now() && !self.session.is_closed() && (!self.read_only || read_only)
    }

    fn rename(&mut self, from: &str, to: &str) -> Option<Result<()>> {
        let rename = self.rename.as_mut().filter(|rename| rename.usable)?;
        let result = self.session.critical(rename.rename(from, to));
        self.expires = Instant::now() + IDLE_TIMEOUT;
        Some(result)
    }
}

#[derive(Default)]
pub(super) struct Access(Arc<Mutex<Option<Authorization>>>);

impl Access {
    fn remember(&self, state: &mut Option<Authorization>, authorization: Authorization) {
        let start_timer = state.is_none();
        *state = Some(authorization);
        if start_timer {
            async_runtime::spawn(expire(Arc::downgrade(&self.0)));
        }
    }

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
        if let Some(current) = state
            .as_mut()
            .filter(|current| password.is_none() && current.alive(read_only))
        {
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
        let mut authorization = Authorization::open(connection, password, read_only, stop)?;
        let result = operation(&mut authorization.session)?;
        authorization.session.set_cancel(None);
        authorization.expires = Instant::now() + IDLE_TIMEOUT;
        self.remember(&mut state, authorization);
        Ok(Some(result))
    }

    pub(super) fn rename(
        &self,
        connection: &Connection,
        password: Option<Zeroizing<String>>,
        from: &str,
        to: &str,
    ) -> Result<()> {
        let mut state = async_runtime::block_on(self.0.lock());
        if password.is_none() {
            return state
                .as_mut()
                .filter(|current| current.alive(false))
                .and_then(|current| current.rename(from, to))
                .unwrap_or_else(|| Err(super::PERMISSION_DENIED.to_owned()));
        }
        let password = password.expect("explicit sudo authorization");
        let mut authorization = Authorization::open(connection, password.clone(), false, None)?;
        if let Some(result) = authorization.rename(from, to) {
            self.remember(&mut state, authorization);
            return result;
        }
        // Some SSH servers limit a connection to one session. Use a separate connection
        // for the authorized rename in that case.
        drop(authorization);
        let route = connection.authenticated_client()?;
        route.1.wait(async {
            let channel = open_channel(&route, password, false).await?;
            standard_rename::run_on_channel(channel, from, to).await
        })
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
    password: Zeroizing<String>,
    read_only: bool,
) -> Result<(Session, Option<RenameSession>)> {
    let (sftp, rename) = client.1.wait(async {
        let rename_password = (!read_only).then(|| password.clone());
        let channel = open_channel(&client, password, read_only).await?;
        let (reader, writer) = tokio::io::split(channel.into_stream());
        let sftp = Sftp::new(writer, reader, Default::default())
            .await
            .map_err(message)?;
        let rename = if let Some(password) = rename_password {
            match open_channel(&client, password, false).await {
                Ok(channel) => RenameSession::open(channel).await.ok(),
                Err(_) => None,
            }
        } else {
            None
        };
        Ok::<_, String>((sftp, rename))
    })?;
    Ok((Session::new(client, sftp), rename))
}

pub(super) async fn open_channel(
    client: &AuthenticatedRoute,
    mut password: Zeroizing<String>,
    read_only: bool,
) -> Result<russh::Channel<russh::client::Msg>> {
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
                return Err("The SSH server did not allow an SFTP session through sudo.".to_owned());
            }
            _ => {}
        }
    }
    Ok(channel)
}
