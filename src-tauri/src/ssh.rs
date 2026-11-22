pub(crate) mod profiles;
mod session;
mod sudo;
mod terminal;
#[cfg(test)]
mod tests;

use std::{
    collections::HashMap,
    future::Future,
    ops::Deref,
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
    protocol::{file_server_origin, RemoteListing},
};
use profiles::{
    Authentication, Config, ConnectionSettings, DraftHost, Endpoint, HostKey, ProfileInput,
    SavedHost, SavedProfile,
};
pub(crate) use session::{Entry, Session};
pub(crate) use terminal::{open_shell, RemoteTerminal};

const TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) fn quote(value: &str) -> String {
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

#[derive(Debug, PartialEq)]
pub(crate) enum SftpFailure {
    PermissionDenied,
    Other(String),
}
pub(crate) type SftpResult<T> = std::result::Result<T, SftpFailure>;
impl From<openssh_sftp_client::Error> for SftpFailure {
    fn from(error: openssh_sftp_client::Error) -> Self {
        match error {
            openssh_sftp_client::Error::SftpError(
                openssh_sftp_client::error::SftpErrorKind::PermDenied,
                _,
            ) => Self::PermissionDenied,
            other => Self::Other(message(other)),
        }
    }
}
impl From<std::io::Error> for SftpFailure {
    fn from(error: std::io::Error) -> Self {
        Self::Other(message(error))
    }
}
impl From<String> for SftpFailure {
    fn from(error: String) -> Self {
        Self::Other(error)
    }
}
impl From<&str> for SftpFailure {
    fn from(error: &str) -> Self {
        Self::Other(error.to_owned())
    }
}
impl From<SftpFailure> for String {
    fn from(error: SftpFailure) -> Self {
        match error {
            SftpFailure::PermissionDenied => "SSH permission denied.".to_owned(),
            SftpFailure::Other(detail) => detail,
        }
    }
}

#[derive(Debug)]
enum HandshakeError {
    Transport(russh::Error),
    Forwarding(russh::Error),
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
            Self::Forwarding(error) => write!(output, "The preceding jump host could not forward the connection. {error}"),
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
    through: Option<&client::Handle<VerifyHost>>,
) -> std::result::Result<client::Handle<VerifyHost>, HandshakeError> {
    let config = client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        nodelay: true,
        ..Default::default()
    };
    tauri::async_runtime::block_on(async {
        let config = Arc::new(config);
        let verifier = VerifyHost(expected);
        tokio::time::timeout(TIMEOUT, async {
            if let Some(jump) = through {
                let channel = jump
                    .channel_open_direct_tcpip(&endpoint.host, endpoint.port.into(), "127.0.0.1", 0)
                    .await
                    .map_err(HandshakeError::Forwarding)?;
                client::connect_stream(config, channel.into_stream(), verifier).await
            } else {
                client::connect(config, (endpoint.host.as_str(), endpoint.port), verifier).await
            }
        })
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

struct AuthenticatedRoute {
    destination: client::Handle<VerifyHost>,
    // Keep the transports alive as long as any caller uses the destination.
    _jumps: Vec<client::Handle<VerifyHost>>,
}

impl Deref for AuthenticatedRoute {
    type Target = client::Handle<VerifyHost>;

    fn deref(&self) -> &Self::Target {
        &self.destination
    }
}

fn open_sftp(client: AuthenticatedRoute) -> Result<Session> {
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
    host_keys: Vec<HostKey>,
    listing: Mutex<Session>,
    sudo: sudo::Access,
}

impl Connection {
    fn authenticated_client(&self) -> Result<AuthenticatedRoute> {
        match open_route(
            self.profile.route().map(RouteHost::Saved).collect(),
            |endpoint| stored_key(&self.host_keys, endpoint),
            &[],
        )? {
            Ok((client, _)) => Ok(client),
            Err(verification) => Err(format!(
                "Verify the SSH host key for {}:{} before reconnecting.",
                verification.endpoint.host, verification.endpoint.port
            )),
        }
    }

    pub fn open(&self) -> Result<Session> {
        open_sftp(self.authenticated_client()?)
            .map_err(|error| route_error(&self.profile.destination.settings.endpoint, None, error))
    }

    fn retry_with_sudo<T>(
        &self,
        password: Option<Zeroizing<String>>,
        reuse: bool,
        read_only: bool,
        ordinary: impl FnOnce() -> SftpResult<T>,
        elevated: impl FnOnce(&mut Session) -> SftpResult<T>,
    ) -> Result<(T, bool)> {
        let denied = if password.is_none() {
            match ordinary() {
                Err(SftpFailure::PermissionDenied) if reuse => {
                    Some(String::from(SftpFailure::PermissionDenied))
                }
                result => return result.map(|value| (value, false)).map_err(Into::into),
            }
        } else {
            None
        };
        self.sudo
            .run(self, password, read_only, |session| {
                elevated(session).map_err(Into::into)
            })?
            .map(|value| (value, true))
            .ok_or_else(|| {
                denied.unwrap_or_else(|| "Authorize this SSH operation with sudo.".to_owned())
            })
    }

    pub fn text_operation<T>(
        &self,
        password: Option<Zeroizing<String>>,
        read_only: bool,
        operation: impl Fn(&mut Session) -> SftpResult<T>,
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

    fn list(&self, segments: &[String]) -> SftpResult<RemoteListing> {
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
    approval: Option<&HostVerification>,
    through: Option<&client::Handle<VerifyHost>>,
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
    let expected = pinned.or_else(|| approval.map(|approval| approval.fingerprint.clone()));
    match handshake(endpoint, expected.clone(), through) {
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

enum RouteHost<'a> {
    Saved(&'a SavedHost),
    Draft(&'a mut DraftHost),
}

impl<'a> RouteHost<'a> {
    fn settings(&self) -> &ConnectionSettings {
        match self {
            Self::Saved(host) => &host.settings,
            Self::Draft(host) => &host.settings,
        }
    }

    fn credentials(self) -> (&'a ConnectionSettings, Result<Option<Zeroizing<String>>>) {
        match self {
            Self::Saved(host) => (&host.settings, host.secret()),
            Self::Draft(host) => {
                let secret = host.take_secret();
                (&host.settings, secret)
            }
        }
    }
}

fn route_error(endpoint: &Endpoint, jump: Option<usize>, error: impl std::fmt::Display) -> String {
    let stage = jump.map_or_else(
        || "SSH destination".to_owned(),
        |index| format!("SSH jump host {index}"),
    );
    format!("{stage} ({}:{}). {error}", endpoint.host, endpoint.port)
}

fn stored_key(keys: &[HostKey], endpoint: &Endpoint) -> Option<String> {
    keys.iter()
        .find(|key| &key.endpoint == endpoint)
        .map(|key| key.fingerprint.clone())
}

type RouteHandshake = std::result::Result<(AuthenticatedRoute, Vec<HostKey>), HostVerification>;

fn open_route(
    hosts: Vec<RouteHost<'_>>,
    trusted: impl Fn(&Endpoint) -> Option<String>,
    approvals: &[HostVerification],
) -> Result<RouteHandshake> {
    for approval in approvals {
        if !hosts
            .iter()
            .any(|host| host.settings().endpoint == approval.endpoint)
        {
            return Err("The SSH route changed. Try the connection again.".to_owned());
        }
    }
    let jumps = hosts.len().saturating_sub(1);
    let mut clients = Vec::with_capacity(hosts.len());
    let mut keys = Vec::with_capacity(hosts.len());
    for (index, host) in hosts.into_iter().enumerate() {
        let endpoint = host.settings().endpoint.clone();
        let stage = (index < jumps).then_some(index + 1);
        let explain = |error: String| route_error(&endpoint, stage, error);
        let pinned = trusted(&endpoint).or_else(|| stored_key(&keys, &endpoint));
        let approval = approvals
            .iter()
            .find(|approval| approval.endpoint == endpoint);
        let (client, fingerprint) =
            match verified_handshake(&endpoint, pinned, approval, clients.last())
                .map_err(&explain)?
            {
                Ok(verified) => verified,
                Err(verification) => return Ok(Err(verification)),
            };
        let (settings, secret) = host.credentials();
        let secret = secret.map_err(&explain)?;
        let client = authenticate(client, settings, secret.as_deref().map(String::as_str))
            .map_err(&explain)?;
        clients.push(client);
        keys.push(HostKey {
            endpoint,
            fingerprint,
        });
    }
    let destination = clients.pop().ok_or("The SSH route has no destination.")?;
    Ok(Ok((
        AuthenticatedRoute {
            destination,
            _jumps: clients,
        },
        keys,
    )))
}

fn route_approvals(
    approval: Option<HostVerification>,
    approvals: Option<Vec<HostVerification>>,
) -> Vec<HostVerification> {
    approvals.unwrap_or_else(|| approval.into_iter().collect())
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TestOutcome {
    VerifyHost { verification: HostVerification },
    Success,
}

#[tauri::command]
pub async fn test_ssh_connection(
    input: ProfileInput,
    approval: Option<HostVerification>,
    approvals: Option<Vec<HostVerification>>,
    app: AppHandle,
) -> Result<TestOutcome> {
    let path = profiles::config_path(&app)?;
    let approvals = route_approvals(approval, approvals);
    blocking(move || {
        let (config, mut route) = {
            let _lock = profiles::lock(&path)?;
            let config = Config::load(&path)?;
            let route = input.test_route(&config)?;
            (config, route)
        };
        let endpoint = route
            .last()
            .ok_or("The SSH route has no destination.")?
            .settings
            .endpoint
            .clone();
        let (client, keys) = match open_route(
            route.iter_mut().map(RouteHost::Draft).collect(),
            |endpoint| config.fingerprint(endpoint).map(str::to_owned),
            &approvals,
        )? {
            Ok(route) => route,
            Err(verification) => return Ok(TestOutcome::VerifyHost { verification }),
        };
        {
            let _lock = profiles::lock(&path)?;
            let config = Config::load(&path)?;
            for key in keys {
                if config
                    .fingerprint(&key.endpoint)
                    .is_some_and(|pin| pin != key.fingerprint)
                {
                    return Err(format!(
                        "The trusted SSH host key for {}:{} changed. Try the connection again.",
                        key.endpoint.host, key.endpoint.port
                    ));
                }
            }
        }
        let explain = |error: String| route_error(&endpoint, None, error);
        let session = open_sftp(client).map_err(&explain)?;
        let directory = session.initial_directory().map_err(&explain)?;
        session
            .listing(&directory)
            .map_err(|error| explain(error.into()))?;
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
        origin: String,
        segments: Vec<String>,
        listing: RemoteListing,
    },
}

#[tauri::command]
pub async fn connect_ssh(
    id: Uuid,
    approval: Option<HostVerification>,
    approvals: Option<Vec<HostVerification>>,
    segments: Option<Vec<String>>,
    app: AppHandle,
    state: State<'_, SshState>,
) -> Result<ConnectOutcome> {
    let path = profiles::config_path(&app)?;
    let approvals = route_approvals(approval, approvals);
    let result = blocking(move || {
        let (profile, config) = {
            let _lock = profiles::lock(&path)?;
            let config = Config::load(&path)?;
            let profile = config.profile(id)?.clone();
            (profile, config)
        };
        let endpoint = &profile.destination.settings.endpoint;
        let (client, host_keys) = match open_route(
            profile.route().map(RouteHost::Saved).collect(),
            |endpoint| config.fingerprint(endpoint).map(str::to_owned),
            &approvals,
        )? {
            Ok(route) => route,
            Err(verification) => return Ok(Err(verification)),
        };
        let explain = |error: String| route_error(endpoint, None, error);
        let session = open_sftp(client).map_err(&explain)?;
        let segments = match segments {
            Some(segments) => segments,
            None => session.initial_directory().map_err(&explain)?,
        };
        let listing = session
            .listing(&segments)
            .map_err(|error| explain(error.into()))?;
        {
            let _lock = profiles::lock(&path)?;
            let mut config = Config::load(&path)?;
            if config.profile(id)? != &profile {
                return Err("The SSH profile changed. Select it again to connect.".to_owned());
            }
            config.trust(&path, host_keys.clone())?;
        }
        Ok(Ok((
            Connection {
                profile,
                host_keys,
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
    let address = connection.profile.label.clone();
    let endpoint = &connection.profile.destination.settings.endpoint;
    let origin = file_server_origin("sftp", &endpoint.host, endpoint.port, 22);
    let id = state.next.fetch_add(1, Ordering::Relaxed);
    state
        .connections
        .lock()
        .map_err(message)?
        .insert(id, Arc::new(connection));
    Ok(ConnectOutcome::Connected {
        id,
        address,
        origin,
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
