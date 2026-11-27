mod compatibility;
pub(crate) mod profiles;
mod session;
mod standard_rename;
mod sudo;
mod terminal;
#[cfg(test)]
mod tests;

use std::{
    collections::HashMap,
    future::Future,
    io,
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
    ChannelMsg, Disconnect,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{
    desktop::{blocking, message, Result},
    netbox_connection::{self, ConnectionPreferences},
    netbox_directories::{list_initial, DirectoryPreferences, InitialListingError},
    netbox_environment::EnvironmentPreferences,
    netbox_proxy as proxy,
    protocol::{file_server_origin, RemoteListing},
};
use compatibility::Compatibility;
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

#[derive(Default)]
struct RouteOptions {
    preferences: ConnectionPreferences,
    stop: Option<CancellationToken>,
    proxy: Option<proxy::Route>,
    compatibility: Compatibility,
}

impl RouteOptions {
    fn timeout(&self) -> Option<Duration> {
        self.preferences.response_timeout(TIMEOUT)
    }

    fn wait<T, E: std::fmt::Display>(
        &self,
        operation: impl Future<Output = std::result::Result<T, E>>,
    ) -> Result<T> {
        tauri::async_runtime::block_on(netbox_connection::wait(
            self.timeout(),
            self.stop.as_ref(),
            operation,
        ))
        .map_err(|error| message(io::Error::from(error)))?
        .map_err(message)
    }
}

#[derive(Debug, PartialEq)]
pub(crate) enum SftpFailure {
    PermissionDenied,
    PathUnavailable(String),
    ConnectionLost(String),
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
            openssh_sftp_client::Error::SftpError(
                openssh_sftp_client::error::SftpErrorKind::NoSuchFile,
                _,
            ) => Self::PathUnavailable(message(error)),
            openssh_sftp_client::Error::BackgroundTaskFailure(_) => {
                Self::ConnectionLost(message(error))
            }
            openssh_sftp_client::Error::IOError(ref io)
                if matches!(
                    io.kind(),
                    std::io::ErrorKind::BrokenPipe
                        | std::io::ErrorKind::ConnectionAborted
                        | std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::NotConnected
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::UnexpectedEof
                ) =>
            {
                Self::ConnectionLost(message(error))
            }
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
            SftpFailure::ConnectionLost(detail)
            | SftpFailure::Other(detail)
            | SftpFailure::PathUnavailable(detail) => detail,
        }
    }
}

#[derive(Debug)]
enum HandshakeError {
    Transport(russh::Error),
    Forwarding(russh::Error),
    Network(io::Error),
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
            Self::Network(error) => error.fmt(output),
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
    options: &RouteOptions,
) -> std::result::Result<client::Handle<VerifyHost>, HandshakeError> {
    let config = client::Config {
        keepalive_interval: options
            .preferences
            .keepalive_interval(Some(Duration::from_secs(30))),
        nodelay: true,
        ..Default::default()
    };
    tauri::async_runtime::block_on(async {
        let config = Arc::new(config);
        let verifier = VerifyHost(expected);
        netbox_connection::wait(options.timeout(), options.stop.as_ref(), async {
            if let Some(jump) = through {
                let channel = jump
                    .channel_open_direct_tcpip(&endpoint.host, endpoint.port.into(), "127.0.0.1", 0)
                    .await
                    .map_err(HandshakeError::Forwarding)?;
                client::connect_stream(config, channel.into_stream(), verifier).await
            } else {
                let socket = proxy::connect(
                    options.proxy.as_ref(),
                    options.preferences.address_family,
                    &endpoint.host,
                    endpoint.port,
                )
                .await
                .map_err(|error| {
                    HandshakeError::Network(options.preferences.address_family.connect_error(error))
                })?;
                let _ = socket.set_nodelay(config.nodelay);
                client::connect_stream(config, socket, verifier).await
            }
        })
        .await
        .map_err(|error| HandshakeError::Network(error.into()))?
    })
}

fn authenticate(
    client: &mut client::Handle<VerifyHost>,
    settings: &ConnectionSettings,
    secret: Option<&str>,
    options: &RouteOptions,
) -> Result<()> {
    let user = settings.username.as_str();
    let authenticated = match &settings.auth {
        Authentication::Password => {
            let password = secret.ok_or("Enter the SSH password.")?;
            options.wait(client.authenticate_password(user, password))?
        }
        Authentication::PrivateKey { path } => {
            let key =
                Zeroizing::new(std::fs::read_to_string(path).map_err(|error| {
                    format!("Could not read the SSH private key file. {error}")
                })?);
            let key = decode_secret_key(&key, secret)
                .map_err(|error| format!("Could not read the SSH private key. {error}"))?;
            let hash = if key.algorithm().is_rsa() {
                options
                    .wait(client.best_supported_rsa_hash())?
                    .flatten()
                    .or(Some(HashAlg::Sha256))
            } else {
                None
            };
            options.wait(
                client
                    .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)),
            )?
        }
    };
    if !authenticated.success() {
        return Err("The SSH server rejected the credentials.".to_owned());
    }
    Ok(())
}

// The destination is last so closing the route can disconnect it before the transports it uses.
struct AuthenticatedRoute(Vec<client::Handle<VerifyHost>>, RouteOptions);

impl Deref for AuthenticatedRoute {
    type Target = client::Handle<VerifyHost>;

    fn deref(&self) -> &Self::Target {
        self.0
            .last()
            .expect("an authenticated route has a destination")
    }
}

impl Drop for AuthenticatedRoute {
    fn drop(&mut self) {
        let clients = std::mem::take(&mut self.0);
        if clients.is_empty() {
            return;
        }
        tauri::async_runtime::spawn(async move {
            for client in clients.into_iter().rev() {
                let _ = tokio::time::timeout(Duration::from_secs(1), async {
                    client
                        .disconnect(Disconnect::ByApplication, "Closing the SSH route", "")
                        .await?;
                    client.await
                })
                .await;
            }
        });
    }
}

async fn sftp_channel(client: &AuthenticatedRoute) -> Result<russh::Channel<client::Msg>> {
    let mut channel = client.channel_open_session().await.map_err(message)?;
    let command = &client.1.compatibility.sftp_command;
    if command.is_empty() {
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(message)?;
    } else {
        channel
            .exec(true, command.as_str())
            .await
            .map_err(message)?;
    }
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Success) => return Ok(channel),
            Some(ChannelMsg::Failure | ChannelMsg::Close | ChannelMsg::Eof) | None => {
                return Err(if command.is_empty() {
                    "The SSH server did not start SFTP."
                } else {
                    "The SSH server rejected the custom SFTP command."
                }
                .to_owned())
            }
            _ => {}
        }
    }
}

fn open_sftp(client: AuthenticatedRoute) -> Result<Session> {
    let sftp = client.1.wait(async {
        let channel = sftp_channel(&client).await?;
        let (reader, writer) = tokio::io::split(channel.into_stream());
        Sftp::new(writer, reader, Default::default())
            .await
            .map_err(|error| {
                if client.1.compatibility.sftp_command.is_empty() {
                    message(error)
                } else {
                    format!("The custom command did not start an SFTP session. {error}")
                }
            })
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
    pub(crate) async fn complete(&self, script: &str) -> Result<Vec<u8>> {
        let client = self
            .listing
            .try_lock()
            .map_err(message)?
            .completion_client();
        terminal::complete(&client, script).await
    }

    fn authenticated_client(&self) -> Result<AuthenticatedRoute> {
        self.authenticated_client_with_cancel(None)
    }

    fn authenticated_client_with_cancel(
        &self,
        stop: Option<CancellationToken>,
    ) -> Result<AuthenticatedRoute> {
        match open_route(
            self.profile.route().map(RouteHost::Saved).collect(),
            |endpoint| stored_key(&self.host_keys, endpoint),
            &[],
            RouteOptions {
                preferences: self.profile.connection_options,
                stop,
                proxy: self.profile.proxy_route()?,
                compatibility: self.profile.compatibility.clone(),
            },
        )? {
            Ok((client, _)) => Ok(client),
            Err(verification) => Err(format!(
                "Verify the SSH host key for {}:{} before reconnecting.",
                verification.endpoint.host, verification.endpoint.port
            )),
        }
    }

    pub fn open(&self) -> Result<Session> {
        self.open_with_cancel(None)
    }

    pub(crate) fn open_with_cancel(&self, stop: Option<CancellationToken>) -> Result<Session> {
        open_sftp(self.authenticated_client_with_cancel(stop)?)
            .map(|session| {
                session
                    .with_download_timestamps(self.profile.environment.preserve_download_timestamps)
                    .with_recycle(self.profile.environment.recycle_bin.clone(), false)
            })
            .map_err(|error| route_error(&self.profile.destination.settings.endpoint, None, error))
    }

    fn retry_with_sudo<T>(
        &self,
        password: Option<Zeroizing<String>>,
        reuse: bool,
        read_only: bool,
        stop: Option<CancellationToken>,
        ordinary: impl FnOnce() -> SftpResult<T>,
        elevated: impl FnOnce(&mut Session) -> SftpResult<T>,
    ) -> SftpResult<(T, bool)> {
        let denied = if password.is_none() {
            match ordinary() {
                Err(SftpFailure::PermissionDenied) if reuse => true,
                result => return result.map(|value| (value, false)),
            }
        } else {
            false
        };
        self.sudo
            .run(self, password, read_only, stop, |session| {
                elevated(session).map_err(Into::into)
            })?
            .map(|value| (value, true))
            .ok_or_else(|| {
                if denied {
                    SftpFailure::PermissionDenied
                } else {
                    "Authorize this SSH operation with sudo.".into()
                }
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
            None,
            || operation(&mut self.open()?),
            &operation,
        )
        .map(|(value, _)| value)
        .map_err(Into::into)
    }

    fn list(
        &self,
        segments: &[String],
        stop: Option<CancellationToken>,
    ) -> SftpResult<(Vec<String>, RemoteListing)> {
        let resolve_links = self.profile.directories.resolve_links;
        let mut session = self.listing.lock().map_err(message)?;
        if !session.is_closed() {
            session.set_cancel(stop.clone());
            let result = session.list_profile_directory(segments, resolve_links);
            session.set_cancel(None);
            match result {
                Err(SftpFailure::ConnectionLost(_)) => {}
                result => return result,
            }
        }
        let mut replacement = self
            .open_with_cancel(stop)
            .map_err(SftpFailure::ConnectionLost)?;
        let result = replacement.list_profile_directory(segments, resolve_links);
        replacement.set_cancel(None);
        *session = replacement;
        result
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
    options: &RouteOptions,
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
    match handshake(endpoint, expected.clone(), through, options) {
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
    options: RouteOptions,
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
    let mut clients = AuthenticatedRoute(Vec::with_capacity(hosts.len()), options);
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
            match verified_handshake(&endpoint, pinned, approval, clients.0.last(), &clients.1)
                .map_err(&explain)?
            {
                Ok(verified) => verified,
                Err(verification) => return Ok(Err(verification)),
            };
        clients.0.push(client);
        let (settings, secret) = host.credentials();
        let secret = secret.map_err(&explain)?;
        authenticate(
            clients
                .0
                .last_mut()
                .expect("the current SSH host was added"),
            settings,
            secret.as_deref().map(String::as_str),
            &clients.1,
        )
        .map_err(&explain)?;
        keys.push(HostKey {
            endpoint,
            fingerprint,
        });
    }
    if clients.0.is_empty() {
        return Err("The SSH route has no destination.".to_owned());
    }
    Ok(Ok((clients, keys)))
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
    request: Option<Uuid>,
    requests: State<'_, netbox_connection::Requests>,
    app: AppHandle,
) -> Result<TestOutcome> {
    let path = profiles::config_path(&app)?;
    let stop = requests.token(request)?;
    let approvals = route_approvals(approval, approvals);
    blocking(move || {
        let (config, mut route, preferences, proxy, compatibility) = {
            let _lock = profiles::lock(&path)?;
            let config = Config::load(&path)?;
            let preferences = input.connection_preferences(&config)?;
            let proxy = input.proxy_route(&config)?;
            let compatibility = input.compatibility(&config)?;
            let route = input.test_route(&config)?;
            (config, route, preferences, proxy, compatibility)
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
            RouteOptions {
                preferences,
                stop,
                proxy,
                compatibility,
            },
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
        directories: DirectoryPreferences,
        environment: EnvironmentPreferences,
        #[serde(rename = "unavailableFolders")]
        unavailable_folders: Vec<String>,
    },
}

#[tauri::command]
pub async fn connect_ssh(
    id: Uuid,
    approval: Option<HostVerification>,
    approvals: Option<Vec<HostVerification>>,
    segments: Option<Vec<String>>,
    remembered: Option<Vec<String>>,
    request: Option<Uuid>,
    app: AppHandle,
) -> Result<ConnectOutcome> {
    let path = profiles::config_path(&app)?;
    let stop = app.state::<netbox_connection::Requests>().token(request)?;
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
            RouteOptions {
                preferences: profile.connection_options,
                stop,
                proxy: profile.proxy_route()?,
                compatibility: profile.compatibility.clone(),
            },
        )? {
            Ok(route) => route,
            Err(verification) => return Ok(Err(verification)),
        };
        let explain = |error: String| route_error(endpoint, None, error);
        let mut session = open_sftp(client).map_err(&explain)?;
        let start = list_initial(&profile.directories, segments, remembered, |candidate| {
            let path = match candidate {
                Some(candidate) => candidate.to_vec(),
                None => session
                    .initial_directory()
                    .map_err(|error| InitialListingError::Other(explain(error)))?,
            };
            session
                .list_profile_directory(&path, profile.directories.resolve_links)
                .map_err(|error| {
                    if matches!(
                        error,
                        SftpFailure::PathUnavailable(_) | SftpFailure::PermissionDenied
                    ) {
                        InitialListingError::Unavailable(explain(error.into()))
                    } else {
                        InitialListingError::Other(explain(error.into()))
                    }
                })
        })?;
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
                listing: Mutex::new({
                    session.set_cancel(None);
                    session
                }),
                sudo: sudo::Access::default(),
            },
            start,
        )))
    })
    .await?;
    let (connection, start) = match result {
        Ok(connected) => connected,
        Err(verification) => return Ok(ConnectOutcome::VerifyHost { verification }),
    };
    let address = connection.profile.label.clone();
    let directories = connection.profile.directories.clone();
    let environment = connection.profile.environment.clone();
    let endpoint = &connection.profile.destination.settings.endpoint;
    let origin = file_server_origin("sftp", &endpoint.host, endpoint.port, 22);
    let state = app.state::<SshState>();
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
        segments: start.segments,
        listing: start.listing,
        directories,
        environment,
        unavailable_folders: start.unavailable,
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
    request: Option<Uuid>,
    state: State<'_, SshState>,
    requests: State<'_, netbox_connection::Requests>,
) -> std::result::Result<SshListing, SshListingError> {
    let sudo_password = sudo_password.map(Zeroizing::new);
    let connection = state.connection(id)?;
    let stop = requests.token(request)?;
    blocking(move || {
        let result = connection.retry_with_sudo(
            sudo_password,
            reuse_sudo.unwrap_or(false),
            true,
            stop.clone(),
            || connection.list(&segments, stop),
            |session| {
                session
                    .list_profile_directory(&segments, connection.profile.directories.resolve_links)
            },
        );
        Ok(result
            .map(|((segments, listing), elevated)| SshListing {
                listing,
                elevated,
                segments,
            })
            .map_err(SshListingError::from))
    })
    .await?
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum SshListingError {
    Lost {
        #[serde(rename = "sshCause")]
        ssh_cause: &'static str,
        message: String,
    },
    Message(String),
}

impl From<String> for SshListingError {
    fn from(message: String) -> Self {
        Self::Message(message)
    }
}

impl From<SftpFailure> for SshListingError {
    fn from(error: SftpFailure) -> Self {
        match error {
            SftpFailure::ConnectionLost(message) => Self::Lost {
                ssh_cause: "connection_lost",
                message,
            },
            other => Self::Message(other.into()),
        }
    }
}

#[derive(Serialize)]
pub struct SshListing {
    #[serde(flatten)]
    listing: RemoteListing,
    elevated: bool,
    segments: Vec<String>,
}

#[tauri::command]
pub async fn create_ssh_folder(
    id: u32,
    segments: Vec<String>,
    sudo_password: Option<String>,
    state: State<'_, SshState>,
) -> Result<()> {
    let connection = state.connection(id)?;
    let password = sudo_password.map(Zeroizing::new);
    blocking(move || {
        connection.text_operation(password, false, |session| session.create_folder(&segments))
    })
    .await
}

#[tauri::command]
pub async fn delete_ssh(
    id: u32,
    segments: Vec<String>,
    recursive: bool,
    recycle: Option<bool>,
    state: State<'_, SshState>,
) -> Result<()> {
    let connection = state.connection(id)?;
    blocking(move || {
        let mut session = connection.open()?;
        if recycle.unwrap_or(false) {
            session.recycle(&segments)
        } else {
            session.remove(&segments, recursive)
        }
    })
    .await
}
