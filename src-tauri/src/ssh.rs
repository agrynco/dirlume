pub(crate) mod profiles;
mod session;
mod sudo;
mod terminal;

use std::{
    collections::HashMap,
    future::Future,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use openssh_sftp_client::Sftp;
use russh::{
    client,
    keys::{decode_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
    ChannelMsg,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{
    desktop::{blocking, message, Result},
    protocol::RemoteListing,
};
use profiles::{Authentication, Config, ConnectionSettings, Endpoint, ProfileInput, SavedProfile};
pub(crate) use session::{Entry, Session};
pub(crate) use terminal::{open_shell, RemoteTerminal};

const TIMEOUT: Duration = Duration::from_secs(15);

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn wait<T, E: std::fmt::Display>(
    operation: impl Future<Output = std::result::Result<T, E>>,
) -> Result<T> {
    tauri::async_runtime::block_on(async {
        tokio::time::timeout(TIMEOUT, operation)
            .await
            .map_err(|_| "The SSH server did not respond in time.".to_owned())?
            .map_err(message)
    })
}

#[derive(Debug)]
enum HandshakeError {
    Transport(russh::Error),
    Unverified(String),
    Changed { expected: String, received: String },
}

impl From<russh::Error> for HandshakeError {
    fn from(error: russh::Error) -> Self {
        Self::Transport(error)
    }
}

impl std::fmt::Display for HandshakeError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(error) => write!(output, "Could not connect to the SSH server. {error}"),
            Self::Unverified(fingerprint) => write!(output, "Verify the SSH host key {fingerprint} before connecting."),
            Self::Changed { expected, received } => write!(
                output,
                "The SSH server presented a different host key. Expected {expected}, received {received}. Verify the change with your server administrator."
            ),
        }
    }
}

struct VerifyHost(Option<String>);

impl client::Handler for VerifyHost {
    type Error = HandshakeError;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        let received = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        match &self.0 {
            Some(expected) if *expected == received => Ok(true),
            Some(expected) => Err(HandshakeError::Changed {
                expected: expected.clone(),
                received,
            }),
            None => Err(HandshakeError::Unverified(received)),
        }
    }
}

fn handshake(
    endpoint: &Endpoint,
    expected: Option<String>,
) -> std::result::Result<client::Handle<VerifyHost>, HandshakeError> {
    let config = client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        nodelay: true,
        ..Default::default()
    };
    tauri::async_runtime::block_on(async {
        tokio::time::timeout(
            TIMEOUT,
            client::connect(
                Arc::new(config),
                (endpoint.host.as_str(), endpoint.port),
                VerifyHost(expected),
            ),
        )
        .await
        .map_err(|_| russh::Error::ConnectionTimeout)?
    })
}

fn authenticate(
    mut client: client::Handle<VerifyHost>,
    settings: &ConnectionSettings,
    secret: Option<&str>,
) -> Result<client::Handle<VerifyHost>> {
    let user = settings.username.as_str();
    let authenticated = match &settings.auth {
        Authentication::Password => {
            let password = secret.ok_or("Enter the SSH password.")?;
            wait(client.authenticate_password(user, password))?
        }
        Authentication::PrivateKey { path } => {
            let key =
                Zeroizing::new(std::fs::read_to_string(path).map_err(|error| {
                    format!("Could not read the SSH private key file. {error}")
                })?);
            let key = decode_secret_key(&key, secret)
                .map_err(|error| format!("Could not read the SSH private key. {error}"))?;
            let hash = if key.algorithm().is_rsa() {
                wait(client.best_supported_rsa_hash())?
                    .flatten()
                    .or(Some(HashAlg::Sha256))
            } else {
                None
            };
            wait(
                client
                    .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)),
            )?
        }
    };
    if !authenticated.success() {
        return Err("The SSH server rejected the credentials.".to_owned());
    }
    Ok(client)
}

fn open_sftp(client: client::Handle<VerifyHost>) -> Result<Session> {
    let sftp = wait(async {
        let mut channel = client.channel_open_session().await.map_err(message)?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(message)?;
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => break,
                Some(ChannelMsg::Failure | ChannelMsg::Close | ChannelMsg::Eof) | None => {
                    return Err("The SSH server did not start SFTP.".to_owned())
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

pub struct Connection {
    profile: SavedProfile,
    fingerprint: String,
    listing: Mutex<Session>,
    sudo: sudo::Access,
}

impl Connection {
    fn authenticated_client(&self) -> Result<client::Handle<VerifyHost>> {
        let client = handshake(
            &self.profile.profile.settings.endpoint,
            Some(self.fingerprint.clone()),
        )
        .map_err(message)?;
        let secret = self.profile.secret()?;
        authenticate(
            client,
            &self.profile.profile.settings,
            secret.as_ref().map(|value| value.as_str()),
        )
    }

    pub fn open(&self) -> Result<Session> {
        open_sftp(self.authenticated_client()?)
    }

    fn retry_with_sudo<T>(
        &self,
        password: Option<Zeroizing<String>>,
        reuse: bool,
        read_only: bool,
        ordinary: impl FnOnce() -> Result<T>,
        elevated: impl FnOnce(&mut Session) -> Result<T>,
    ) -> Result<(T, bool)> {
        let denied = if password.is_none() {
            match ordinary() {
                Err(error)
                    if reuse
                        && error.starts_with("Sftp server reported error kind PermDenied,") =>
                {
                    Some(error)
                }
                result => return result.map(|value| (value, false)),
            }
        } else {
            None
        };
        self.sudo
            .run(self, password, read_only, elevated)?
            .map(|value| (value, true))
            .ok_or_else(|| {
                denied.unwrap_or_else(|| "Authorize this SSH operation with sudo.".to_owned())
            })
    }

    pub fn text_operation<T>(
        &self,
        password: Option<Zeroizing<String>>,
        read_only: bool,
        operation: impl Fn(&mut Session) -> Result<T>,
    ) -> Result<T> {
        self.retry_with_sudo(
            password,
            true,
            read_only,
            || operation(&mut self.open()?),
            &operation,
        )
        .map(|(value, _)| value)
    }

    fn list(&self, segments: &[String]) -> Result<RemoteListing> {
        let mut session = self.listing.lock().map_err(message)?;
        if session.is_closed() {
            *session = self.open()?;
        }
        session.listing(segments)
    }
}

#[derive(Default)]
pub struct SshState {
    connections: Mutex<HashMap<u32, Arc<Connection>>>,
    next: AtomicU32,
}

impl SshState {
    pub fn connection(&self, id: u32) -> Result<Arc<Connection>> {
        self.connections
            .lock()
            .map_err(message)?
            .get(&id)
            .cloned()
            .ok_or_else(|| "Connect to the SSH server first.".to_owned())
    }
}

#[derive(Deserialize, Serialize)]
pub struct HostVerification {
    #[serde(flatten)]
    endpoint: Endpoint,
    fingerprint: String,
}

fn verified_handshake(
    endpoint: &Endpoint,
    pinned: Option<String>,
    approval: Option<HostVerification>,
) -> Result<std::result::Result<(client::Handle<VerifyHost>, String), HostVerification>> {
    if let Some(approval) = &approval {
        if &approval.endpoint != endpoint
            || pinned
                .as_ref()
                .is_some_and(|pin| pin != &approval.fingerprint)
        {
            return Err("The SSH host verification changed. Try the connection again.".to_owned());
        }
    }
    let expected = pinned.or_else(|| approval.map(|approval| approval.fingerprint));
    match handshake(endpoint, expected.clone()) {
        Ok(client) => Ok(Ok((
            client,
            expected.ok_or("The SSH server did not provide a host key.")?,
        ))),
        Err(HandshakeError::Unverified(fingerprint)) => Ok(Err(HostVerification {
            endpoint: endpoint.clone(),
            fingerprint,
        })),
        Err(error) => Err(message(error)),
    }
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TestOutcome {
    VerifyHost { verification: HostVerification },
    Success,
}

#[tauri::command]
pub async fn test_ssh_connection(
    mut input: ProfileInput,
    approval: Option<HostVerification>,
    app: AppHandle,
) -> Result<TestOutcome> {
    let path = profiles::config_path(&app)?;
    let draft_secret = input.take_secret();
    blocking(move || {
        let settings = input.settings()?;
        let endpoint = &settings.endpoint;
        let pinned = {
            let _lock = profiles::lock(&path)?;
            Config::load(&path)?
                .fingerprint(endpoint)
                .map(str::to_owned)
        };
        let (client, fingerprint) = match verified_handshake(endpoint, pinned, approval)? {
            Ok(verified) => verified,
            Err(verification) => return Ok(TestOutcome::VerifyHost { verification }),
        };
        let secret = {
            let _lock = profiles::lock(&path)?;
            let config = Config::load(&path)?;
            if config
                .fingerprint(endpoint)
                .is_some_and(|pin| pin != fingerprint)
            {
                return Err(
                    "The trusted SSH host key changed. Try the connection again.".to_owned(),
                );
            }
            input.secret_for_test(&config, &settings, draft_secret)?
        };
        let session = open_sftp(authenticate(
            client,
            &settings,
            secret.as_ref().map(|value| value.as_str()),
        )?)?;
        session.listing(&session.initial_directory()?)?;
        Ok(TestOutcome::Success)
    })
    .await
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConnectOutcome {
    VerifyHost {
        verification: HostVerification,
    },
    Connected {
        id: u32,
        address: String,
        segments: Vec<String>,
        listing: RemoteListing,
    },
}

#[tauri::command]
pub async fn connect_ssh(
    id: Uuid,
    approval: Option<HostVerification>,
    segments: Option<Vec<String>>,
    app: AppHandle,
    state: State<'_, SshState>,
) -> Result<ConnectOutcome> {
    let path = profiles::config_path(&app)?;
    let result = blocking(move || {
        let (profile, pinned) = {
            let _lock = profiles::lock(&path)?;
            let config = Config::load(&path)?;
            let profile = config.profile(id)?.clone();
            let pinned = config
                .fingerprint(&profile.profile.settings.endpoint)
                .map(str::to_owned);
            (profile, pinned)
        };
        let settings = &profile.profile.settings;
        let endpoint = &settings.endpoint;
        let (client, fingerprint) = match verified_handshake(endpoint, pinned, approval)? {
            Ok(verified) => verified,
            Err(verification) => return Ok(Err(verification)),
        };
        {
            let _lock = profiles::lock(&path)?;
            let mut config = Config::load(&path)?;
            if config.profile(id)? != &profile {
                return Err("The SSH profile changed. Select it again to connect.".to_owned());
            }
            match config.fingerprint(endpoint) {
                Some(pin) if pin == fingerprint => {}
                Some(_) => {
                    return Err(
                        "The trusted SSH host key changed. Reopen the chooser to connect."
                            .to_owned(),
                    )
                }
                None => config.trust(&path, endpoint.clone(), fingerprint.clone())?,
            }
        }
        let secret = profile.secret()?;
        let session = open_sftp(authenticate(
            client,
            settings,
            secret.as_ref().map(|value| value.as_str()),
        )?)?;
        let segments = match segments {
            Some(segments) => segments,
            None => session.initial_directory()?,
        };
        let listing = session.listing(&segments)?;
        Ok(Ok((
            Connection {
                profile,
                fingerprint,
                listing: Mutex::new(session),
                sudo: sudo::Access::default(),
            },
            segments,
            listing,
        )))
    })
    .await?;
    let (connection, segments, listing) = match result {
        Ok(connected) => connected,
        Err(verification) => return Ok(ConnectOutcome::VerifyHost { verification }),
    };
    let address = connection.profile.profile.label.clone();
    let id = state.next.fetch_add(1, Ordering::Relaxed);
    state
        .connections
        .lock()
        .map_err(message)?
        .insert(id, Arc::new(connection));
    Ok(ConnectOutcome::Connected {
        id,
        address,
        segments,
        listing,
    })
}

#[tauri::command]
pub fn disconnect_ssh(id: u32, state: State<'_, SshState>) -> Result<()> {
    state.connections.lock().map_err(message)?.remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn list_ssh(
    id: u32,
    segments: Vec<String>,
    sudo_password: Option<String>,
    reuse_sudo: Option<bool>,
    state: State<'_, SshState>,
) -> Result<SshListing> {
    let sudo_password = sudo_password.map(Zeroizing::new);
    let connection = state.connection(id)?;
    blocking(move || {
        let (listing, elevated) = connection.retry_with_sudo(
            sudo_password,
            reuse_sudo.unwrap_or(false),
            true,
            || connection.list(&segments),
            |session| session.listing(&segments),
        )?;
        Ok(SshListing { listing, elevated })
    })
    .await
}

#[derive(Serialize)]
pub struct SshListing {
    #[serde(flatten)]
    listing: RemoteListing,
    elevated: bool,
}

#[tauri::command]
pub async fn delete_ssh(
    id: u32,
    segments: Vec<String>,
    recursive: bool,
    state: State<'_, SshState>,
) -> Result<()> {
    let connection = state.connection(id)?;
    blocking(move || connection.open()?.remove(&segments, recursive)).await
}
