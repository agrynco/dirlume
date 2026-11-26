use std::{
    collections::HashMap,
    fs,
    future::Future,
    io::{self, Read, Write},
    net::SocketAddr,
    ops::Deref,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use socket2::{SockRef, TcpKeepalive};
use suppaftp::{
    list::{File, ListParser},
    tokio::{AsyncRustlsConnector, ImplAsyncFtpStream, TransferStream},
    types::FileType,
    FtpError, FtpResult, Mode, Status,
};
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    desktop::{blocking, message, Result},
    local,
    netbox_connection::{self, ConnectionPreferences},
    netbox_directories::{list_initial, DirectoryPreferences, InitialListingError},
    netbox_environment::EnvironmentPreferences,
    protocol::{file_server_origin, RemoteListing},
};

const TIMEOUT: Duration = Duration::from_secs(12);
const MAX_DEPTH: usize = 128;
const ACTIVE_TIMEOUT: Duration = Duration::from_secs(60);

mod wire;
type FtpStream = ImplAsyncFtpStream<wire::WireStream>;

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum MlsdPolicy {
    #[default]
    Auto,
    On,
    Off,
}

#[derive(Clone, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct FtpOptions {
    mlsd: MlsdPolicy,
    active_mode: bool,
    empty_password: bool,
    post_login_commands: Vec<String>,
    raw_iac_commands: bool,
    raw_iac_pwd: bool,
}

impl FtpOptions {
    fn is_default(&self) -> bool {
        self == &Self::default()
    }

    fn validated(self) -> Result<Self> {
        if self
            .post_login_commands
            .iter()
            .any(|command| command.trim().is_empty() || !safe_argument(command))
        {
            return Err("Enter one non-empty FTP command per line.".to_owned());
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Encryption {
    #[default]
    Plain,
    ExplicitTls,
    ImplicitTls,
}

impl Encryption {
    fn is_plain(&self) -> bool {
        *self == Self::Plain
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    id: Uuid,
    label: String,
    host: String,
    port: u16,
    username: String,
    code_page: Option<u16>,
    #[serde(default, skip_serializing_if = "Encryption::is_plain")]
    encryption: Encryption,
    #[serde(default, skip_serializing_if = "FtpOptions::is_default")]
    ftp_options: FtpOptions,
    #[serde(default, skip_serializing_if = "DirectoryPreferences::is_default")]
    directories: DirectoryPreferences,
    #[serde(default, skip_serializing_if = "EnvironmentPreferences::is_default")]
    environment: EnvironmentPreferences,
    #[serde(default, skip_serializing_if = "ConnectionPreferences::is_default")]
    connection_options: ConnectionPreferences,
}

#[derive(Deserialize, Serialize)]
struct SavedProfile {
    #[serde(flatten)]
    profile: Profile,
    credential: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInput {
    id: Option<Uuid>,
    label: String,
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    code_page: Option<u16>,
    encryption: Option<Encryption>,
    ftp_options: Option<FtpOptions>,
    directories: Option<DirectoryPreferences>,
    environment: Option<EnvironmentPreferences>,
    connection_options: Option<ConnectionPreferences>,
}

#[derive(Default)]
pub struct FtpState {
    connections: Mutex<HashMap<u32, Arc<Connection>>>,
    searches: Mutex<HashMap<u32, CancellationToken>>,
    next: AtomicU32,
}

impl FtpState {
    pub fn connection(&self, id: u32) -> Result<Arc<Connection>> {
        self.connections
            .lock()
            .map_err(message)?
            .get(&id)
            .cloned()
            .ok_or_else(|| "Connect to the FTP server first.".to_owned())
    }
}

fn profiles_path(app: &AppHandle) -> Result<PathBuf> {
    #[cfg(all(windows, feature = "ui-automation"))]
    if let Some(path) = std::env::var_os("DIRLUME_FTP_TEST_CONFIG")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        return Ok(path.join("ftp-profiles.json"));
    }
    Ok(app
        .path()
        .app_config_dir()
        .map_err(message)?
        .join("ftp-profiles.json"))
}

fn load_profiles(path: &Path) -> Result<Vec<SavedProfile>> {
    match fs::File::open(path) {
        Ok(file) => serde_json::from_reader(file).map_err(message),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(message(error)),
    }
}

fn lock_profiles(path: &Path) -> Result<fs::File> {
    let parent = path
        .parent()
        .ok_or("The FTP profile folder is unavailable.")?;
    fs::create_dir_all(parent).map_err(message)?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.with_extension("lock"))
        .map_err(message)?;
    lock.lock().map_err(message)?;
    Ok(lock)
}

fn persist_profiles(path: &Path, profiles: &[SavedProfile]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or("The FTP profile folder is unavailable.")?;
    fs::create_dir_all(parent).map_err(message)?;
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(message)?;
    serde_json::to_writer_pretty(staged.as_file_mut(), profiles).map_err(message)?;
    staged.as_file().sync_all().map_err(message)?;
    staged.persist(path).map_err(message)?;
    Ok(())
}

fn credential(key: &str) -> Result<keyring::Entry> {
    keyring::Entry::new("Dirlume FTP", key).map_err(message)
}

fn delete_credential(key: &str) {
    let _ = credential(key).and_then(|entry| entry.delete_credential().map_err(message));
}

#[tauri::command]
pub fn ftp_windows_code_page() -> Option<u16> {
    #[cfg(windows)]
    {
        // GetACP reads the process system code page and takes no arguments.
        u16::try_from(unsafe { windows_sys::Win32::Globalization::GetACP() }).ok()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[tauri::command]
pub async fn ftp_profiles(app: AppHandle) -> Result<Vec<Profile>> {
    let path = profiles_path(&app)?;
    blocking(move || {
        let _lock = lock_profiles(&path)?;
        Ok(load_profiles(&path)?
            .into_iter()
            .map(|item| item.profile)
            .collect())
    })
    .await
}

fn safe_argument(text: &str) -> bool {
    !text.contains(['\r', '\n', '\0'])
}

impl ProfileInput {
    fn profile(&self) -> Result<Profile> {
        let label = self.label.trim().to_owned();
        let host = self
            .host
            .trim()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_owned();
        let username = self.username.trim().to_owned();
        if label.is_empty()
            || host.is_empty()
            || self.port == 0
            || host.contains(['/', '\\', '@', '?', '#'])
            || host.chars().any(char::is_whitespace)
            || !safe_argument(&username)
            || self
                .password
                .as_deref()
                .is_some_and(|password| !safe_argument(password))
        {
            return Err(
                "Enter a connection name, server host, port, and valid credentials.".to_owned(),
            );
        }
        if self
            .code_page
            .is_some_and(|page| codepage::to_encoding_no_replacement(page).is_none())
        {
            return Err("Enter a supported Windows code page or use UTF-8.".to_owned());
        }
        let mut directories = self.directories.clone().unwrap_or_default().normalized()?;
        directories.resolve_links = false;
        Ok(Profile {
            id: self.id.unwrap_or_else(Uuid::new_v4),
            label,
            host,
            port: self.port,
            username,
            code_page: self.code_page.filter(|&page| page != 65001),
            encryption: self.encryption.unwrap_or_default(),
            ftp_options: self.ftp_options.clone().unwrap_or_default().validated()?,
            directories,
            environment: self.environment.clone().unwrap_or_default().validated()?,
            connection_options: self.connection_options.unwrap_or_default().validated()?,
        })
    }
}

impl Profile {
    fn same_login(&self, other: &Self) -> bool {
        self.host == other.host && self.port == other.port && self.username == other.username
    }
}

#[tauri::command]
pub async fn save_ftp_profile(input: ProfileInput, app: AppHandle) -> Result<Uuid> {
    let path = profiles_path(&app)?;
    blocking(move || {
        let mut profile = input.profile()?;
        let _lock = lock_profiles(&path)?;
        let mut saved = load_profiles(&path)?;
        let index = input.id.map(|id| saved.iter().position(|item| item.profile.id == id)
            .ok_or_else(|| "This FTP profile was removed.".to_owned())).transpose()?;
        let previous = index.map(|index| &saved[index]);
        if input.encryption.is_none() {
            profile.encryption = previous.map(|old| old.profile.encryption).unwrap_or_default();
        }
        if input.ftp_options.is_none() {
            profile.ftp_options = previous.map(|old| old.profile.ftp_options.clone()).unwrap_or_default();
        }
        if input.directories.is_none() {
            profile.directories = previous.map(|old| old.profile.directories.clone()).unwrap_or_default();
        }
        if input.environment.is_none() {
            profile.environment = previous.map(|old| old.profile.environment.clone()).unwrap_or_default();
        }
        if input.connection_options.is_none() {
            profile.connection_options = previous.map(|old| old.profile.connection_options).unwrap_or_default();
        }
        let mut key = previous.filter(|old| old.profile.same_login(&profile)).and_then(|old| old.credential.clone());
        let updated_key = if let Some(password) = input.password {
            key = None;
            if password.is_empty() {
                None
            } else {
                let updated_key = Uuid::new_v4().to_string();
                credential(&updated_key)?.set_password(&password)
                    .map_err(|error| format!("Could not save the FTP password in the system credential store: {error}"))?;
                key = Some(updated_key.clone());
                Some(updated_key)
            }
        } else {
            None
        };
        let old_key = previous.and_then(|old| old.credential.clone()).filter(|old| Some(old) != key.as_ref());
        let id = profile.id;
        let item = SavedProfile { profile, credential: key };
        if let Some(index) = index { saved[index] = item; } else { saved.push(item); }
        if let Err(error) = persist_profiles(&path, &saved) {
            if let Some(key) = updated_key { delete_credential(&key); }
            return Err(error);
        }
        if let Some(key) = old_key { delete_credential(&key); }
        Ok(id)
    }).await
}

#[tauri::command]
pub async fn remove_ftp_profile(id: Uuid, app: AppHandle) -> Result<()> {
    let path = profiles_path(&app)?;
    blocking(move || {
        let _lock = lock_profiles(&path)?;
        let mut saved = load_profiles(&path)?;
        let index = saved
            .iter()
            .position(|item| item.profile.id == id)
            .ok_or("This FTP profile was removed.")?;
        let removed = saved.remove(index);
        persist_profiles(&path, &saved)?;
        if let Some(key) = removed.credential {
            delete_credential(&key);
        }
        Ok(())
    })
    .await
}

pub struct Connection {
    profile: Profile,
    password: String,
}

fn read_password(key: Option<&str>) -> Result<String> {
    Ok(key
        .map(|key| {
            credential(key)?.get_password().map_err(|error| {
                format!("Could not read the FTP password from the system credential store: {error}")
            })
        })
        .transpose()?
        .unwrap_or_default())
}

#[tauri::command]
pub async fn test_ftp_connection(
    input: ProfileInput,
    request: Option<Uuid>,
    requests: State<'_, netbox_connection::Requests>,
    app: AppHandle,
) -> Result<()> {
    let path = profiles_path(&app)?;
    let stop = requests.token(request)?;
    blocking(move || {
        let mut profile = input.profile()?;
        let saved = input
            .id
            .filter(|_| {
                input.password.is_none()
                    || input.connection_options.is_none()
                    || input.encryption.is_none()
                    || input.ftp_options.is_none()
            })
            .map(|id| {
                let _lock = lock_profiles(&path)?;
                load_profiles(&path)?
                    .into_iter()
                    .find(|item| item.profile.id == id)
                    .ok_or_else(|| "This FTP profile was removed.".to_owned())
            })
            .transpose()?;
        if let Some(saved) = saved.as_ref() {
            if input.connection_options.is_none() {
                profile.connection_options = saved.profile.connection_options;
            }
            if input.encryption.is_none() {
                profile.encryption = saved.profile.encryption;
            }
            if input.ftp_options.is_none() {
                profile.ftp_options = saved.profile.ftp_options.clone();
            }
        }
        let password = match (profile.ftp_options.empty_password, input.password) {
            (true, _) => String::new(),
            (false, Some(password)) => password,
            (false, None) => read_password(
                saved
                    .as_ref()
                    .filter(|saved| saved.profile.same_login(&profile))
                    .and_then(|saved| saved.credential.as_deref()),
            )?,
        };
        let mut session = Connection { profile, password }.open_with_cancel(stop)?;
        let directory = parse_path(&session.pwd().map_err(message)?)?;
        session.list(&directory)?;
        Ok(())
    })
    .await
}

#[derive(Debug)]
struct LegacyEncoding(&'static encoding_rs::Encoding);

impl suppaftp::Encoding for LegacyEncoding {
    fn decode(&self, bytes: &[u8]) -> String {
        self.0.decode_without_bom_handling(bytes).0.into_owned()
    }

    fn encode(&self, text: &str) -> io::Result<Vec<u8>> {
        let (bytes, _, unrepresentable) = self.0.encode(text);
        if unrepresentable {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "The FTP server's selected encoding cannot represent this name.",
            ));
        }
        Ok(bytes.into_owned())
    }
}

fn configure_socket(
    stream: &TcpStream,
    options: ConnectionPreferences,
    data: bool,
) -> io::Result<()> {
    let socket = SockRef::from(stream);
    if let Some(interval) = options.keepalive_interval(None) {
        socket.set_tcp_keepalive(
            &TcpKeepalive::new()
                .with_time(interval)
                .with_interval(interval),
        )?;
    }
    if data && options.optimize_buffer {
        const BUFFER_SIZE: usize = 256 * 1024;
        if socket.recv_buffer_size()? < BUFFER_SIZE {
            socket.set_recv_buffer_size(BUFFER_SIZE)?;
        }
        if socket.send_buffer_size()? < BUFFER_SIZE {
            socket.set_send_buffer_size(BUFFER_SIZE)?;
        }
    }
    Ok(())
}

async fn dial(
    address: SocketAddr,
    options: ConnectionPreferences,
    data: bool,
) -> FtpResult<TcpStream> {
    let socket = TcpStream::connect(address)
        .await
        .map_err(FtpError::ConnectionError)?;
    configure_socket(&socket, options, data).map_err(FtpError::ConnectionError)?;
    Ok(socket)
}

struct OperationLimits {
    timeout: Option<Duration>,
    stop: Option<CancellationToken>,
}

impl OperationLimits {
    fn call<T>(&self, operation: impl Future<Output = FtpResult<T>>) -> FtpResult<T> {
        tauri::async_runtime::block_on(netbox_connection::wait(
            self.timeout,
            self.stop.as_ref(),
            operation,
        ))
        .map_err(|error| FtpError::ConnectionError(error.into()))?
    }

    fn io<T>(&self, operation: impl Future<Output = io::Result<T>>) -> io::Result<T> {
        tauri::async_runtime::block_on(netbox_connection::wait(
            self.timeout,
            self.stop.as_ref(),
            operation,
        ))?
    }

    fn data(
        &self,
        operation: impl Future<Output = FtpResult<TransferStream<wire::WireStream>>>,
        options: ConnectionPreferences,
        active: bool,
    ) -> FtpResult<TransferStream<wire::WireStream>> {
        let stream = self.call(operation).map_err(|error| match error {
            FtpError::ConnectionError(error)
                if active && error.kind() == io::ErrorKind::TimedOut =>
            {
                FtpError::ConnectionError(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "The active FTP data connection timed out.",
                ))
            }
            error => error,
        })?;
        if active {
            configure_socket(stream.get_ref().get_ref(), options, true)
                .map_err(FtpError::ConnectionError)?;
        }
        Ok(stream)
    }
}

fn tls_config() -> Result<Arc<rustls::ClientConfig>> {
    let native = rustls_native_certs::load_native_certs();
    let mut roots = rustls::RootCertStore::empty();
    roots.add_parsable_certificates(native.certs);
    if roots.is_empty() {
        return Err("No trusted certificates are available for FTPS.".to_owned());
    }
    client_tls_config(roots)
}

fn client_tls_config(roots: rustls::RootCertStore) -> Result<Arc<rustls::ClientConfig>> {
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(message)?
    .with_root_certificates(roots)
    .with_no_client_auth();
    // A session's control and data sockets share this config and its TLS resumption cache.
    Ok(Arc::new(config))
}

fn tls_name(host: &str) -> Result<String> {
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return Ok(ip.to_string());
    }
    url::Host::parse(host)
        .map(|host| host.to_string())
        .map_err(|_| "Enter a valid server name for FTPS.".to_owned())
}

async fn open_control(
    address: SocketAddr,
    options: ConnectionPreferences,
    encryption: Encryption,
    tls: Option<&Arc<rustls::ClientConfig>>,
    name: &str,
    raw_iac: bool,
) -> FtpResult<FtpStream> {
    if encryption == Encryption::Plain {
        if raw_iac {
            // This constructor accepts a control adapter before reading the greeting.
            // The plain adapter adds no TLS layer.
            let connector = wire::Connector::new(None, true, options);
            return FtpStream::connect_secure_implicit(address, connector, "").await;
        }
        let stream = dial(address, options, false).await?;
        return FtpStream::connect_with_stream(stream).await;
    }
    let config =
        tls.ok_or_else(|| FtpError::SecureError("FTPS TLS configuration is missing.".to_owned()))?;
    let tls = AsyncRustlsConnector::from(suppaftp::tokio_rustls::TlsConnector::from(Arc::clone(
        config,
    )));
    let connector = wire::Connector::new(Some(tls), raw_iac, options);
    if encryption == Encryption::ImplicitTls {
        return FtpStream::connect_secure_implicit(address, connector, name).await;
    }
    let stream = FtpStream::connect_with_stream(dial(address, options, false).await?).await?;
    stream.into_secure(connector, name).await.map_err(|error| {
        FtpError::SecureError(format!(
            "Could not negotiate explicit TLS or protected data connections. {error}"
        ))
    })
}

impl Connection {
    pub fn open(&self) -> Result<Session> {
        self.open_with_cancel(None)
    }

    pub(crate) fn open_with_cancel(&self, stop: Option<CancellationToken>) -> Result<Session> {
        let tls = (!self.profile.encryption.is_plain())
            .then(tls_config)
            .transpose()?;
        self.open_session(stop, tls)
    }

    fn open_session(
        &self,
        stop: Option<CancellationToken>,
        tls: Option<Arc<rustls::ClientConfig>>,
    ) -> Result<Session> {
        let options = self.profile.connection_options;
        let ftp_options = &self.profile.ftp_options;
        let limits = OperationLimits {
            timeout: options.response_timeout(TIMEOUT),
            stop,
        };
        let addresses = limits
            .io(options
                .address_family
                .resolve(&self.profile.host, self.profile.port))
            .map_err(message)?;
        let encryption = self.profile.encryption;
        let name = if encryption.is_plain() {
            String::new()
        } else {
            tls_name(&self.profile.host)?
        };
        let mut control = None;
        let mut last = io::Error::new(
            io::ErrorKind::AddrNotAvailable,
            "Could not reach the FTP server.",
        );
        for address in addresses {
            match limits.call(open_control(
                address,
                options,
                encryption,
                tls.as_ref(),
                &name,
                ftp_options.raw_iac_commands,
            )) {
                Ok(stream) => {
                    control = Some((stream, address.ip()));
                    break;
                }
                Err(FtpError::ConnectionError(error))
                    if error.kind() != io::ErrorKind::Interrupted =>
                {
                    last = error;
                }
                Err(error) => return Err(message(error)),
            }
        }
        let (stream, peer) =
            control.ok_or_else(|| message(options.address_family.connect_error(last)))?;
        let mut stream = stream.passive_stream_builder(move |address| {
            Box::pin(dial(SocketAddr::new(peer, address.port()), options, true))
        });
        if ftp_options.active_mode {
            stream = stream.active_mode(limits.timeout.unwrap_or(ACTIVE_TIMEOUT));
        } else if peer.is_ipv6() {
            stream.set_mode(Mode::ExtendedPassive);
        }
        let user = if self.profile.username.is_empty() {
            "anonymous"
        } else {
            &self.profile.username
        };
        let password = if ftp_options.empty_password {
            ""
        } else {
            &self.password
        };
        limits.call(stream.login(user, password)).map_err(|error| {
            format!("FTP login failed. Check the username and password. {error}")
        })?;
        if encryption == Encryption::ImplicitTls {
            for command in ["PBSZ 0", "PROT P"] {
                limits
                    .call(stream.custom_command(command, &[Status::CommandOk]))
                    .map_err(|error| {
                        format!("Could not negotiate protected FTPS data connections. {error}")
                    })?;
            }
        }
        let encoding = self
            .profile
            .code_page
            .map(|page| {
                codepage::to_encoding_no_replacement(page)
                    .ok_or("The FTP name encoding is unavailable.")
            })
            .transpose()?;
        if let Some(encoding) = encoding {
            tauri::async_runtime::block_on(stream.set_encoding(LegacyEncoding(encoding)));
        }
        let _ =
            limits.call(stream.opts("UTF8", Some(if encoding.is_some() { "OFF" } else { "ON" })));
        if !ftp_options.post_login_commands.is_empty() {
            let success: Vec<_> = (200..300)
                .map(Status::from)
                .filter(|status| (200..300).contains(&(*status as u32)))
                .collect();
            for (index, command) in ftp_options.post_login_commands.iter().enumerate() {
                if let Err(error) = limits.call(stream.custom_command(command, &success)) {
                    let number = index + 1;
                    return Err(match error {
                        FtpError::UnexpectedResponse(response) => format!(
                            "FTP post-login command {number} failed (server status {}).",
                            response.status as u32,
                        ),
                        FtpError::ConnectionError(error)
                            if error.kind() == io::ErrorKind::Interrupted =>
                        {
                            message(error)
                        }
                        _ => format!("FTP post-login command {number} failed."),
                    });
                }
            }
        }
        limits
            .call(stream.transfer_type(FileType::Binary))
            .map_err(message)?;
        Ok(Session {
            stream,
            limits,
            encoding,
            use_mlsd: ftp_options.mlsd != MlsdPolicy::Off,
            options,
            ftp_options: ftp_options.clone(),
            environment: self.profile.environment.clone(),
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    id: u32,
    address: String,
    origin: String,
    segments: Vec<String>,
    listing: RemoteListing,
    directories: DirectoryPreferences,
    environment: EnvironmentPreferences,
    unavailable_folders: Vec<String>,
}

#[tauri::command]
pub async fn connect_ftp(
    id: Uuid,
    segments: Option<Vec<String>>,
    remembered: Option<Vec<String>>,
    request: Option<Uuid>,
    app: AppHandle,
    state: State<'_, FtpState>,
    requests: State<'_, netbox_connection::Requests>,
) -> Result<Connected> {
    let path = profiles_path(&app)?;
    let stop = requests.token(request)?;
    let (connection, start) = blocking(move || {
        let (profile, password) = {
            let _lock = lock_profiles(&path)?;
            let item = load_profiles(&path)?
                .into_iter()
                .find(|item| item.profile.id == id)
                .ok_or("This FTP profile was removed.")?;
            let password = if item.profile.ftp_options.empty_password {
                String::new()
            } else {
                read_password(item.credential.as_deref())?
            };
            (item.profile, password)
        };
        let connection = Arc::new(Connection { profile, password });
        let mut session = connection.open_with_cancel(stop)?;
        let start = list_initial(
            &connection.profile.directories,
            segments,
            remembered,
            |candidate| {
                let path = match candidate {
                    Some(candidate) => candidate.to_vec(),
                    None => parse_path(
                        &session
                            .pwd()
                            .map_err(|error| InitialListingError::Other(message(error)))?,
                    )
                    .map_err(InitialListingError::Other)?,
                };
                let absolute = absolute(&path).map_err(InitialListingError::Other)?;
                session
                    .limits
                    .call(session.stream.cwd(absolute))
                    .map_err(start_directory_error)?;
                let listing = session
                    .list_current()
                    .map_err(start_directory_error)?
                    .into_listing();
                Ok((path, listing))
            },
        )?;
        Ok((connection, start))
    })
    .await?;
    let address = connection.profile.label.clone();
    let directories = connection.profile.directories.clone();
    let environment = connection.profile.environment.clone();
    let (scheme, default_port) = match connection.profile.encryption {
        Encryption::Plain => ("ftp", 21),
        Encryption::ExplicitTls => ("ftps", 21),
        Encryption::ImplicitTls => ("ftps", 990),
    };
    let origin = file_server_origin(
        scheme,
        &connection.profile.host,
        connection.profile.port,
        default_port,
    );
    let id = state.next.fetch_add(1, Ordering::Relaxed);
    state
        .connections
        .lock()
        .map_err(message)?
        .insert(id, connection);
    Ok(Connected {
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
pub fn disconnect_ftp(id: u32, state: State<'_, FtpState>) -> Result<()> {
    state.connections.lock().map_err(message)?.remove(&id);
    Ok(())
}

pub struct Session {
    stream: FtpStream,
    use_mlsd: bool,
    pub(crate) environment: EnvironmentPreferences,
    limits: OperationLimits,
    encoding: Option<&'static encoding_rs::Encoding>,
    options: ConnectionPreferences,
    ftp_options: FtpOptions,
}

pub struct FtpEntry {
    raw: File,
    pub(crate) corrected: SystemTime,
}

impl PartialEq for FtpEntry {
    fn eq(&self, other: &Self) -> bool {
        self.raw == other.raw
    }
}

impl Deref for FtpEntry {
    type Target = File;

    fn deref(&self) -> &File {
        &self.raw
    }
}

pub struct Entries {
    pub files: Vec<FtpEntry>,
    omitted: usize,
}

impl Entries {
    fn into_listing(self) -> RemoteListing {
        RemoteListing {
            entries: self.files.into_iter().map(listing_entry).collect(),
            omitted: self.omitted,
        }
    }

    pub fn complete(self) -> Result<Vec<FtpEntry>> {
        if self.omitted > 0 {
            return Err(
                "The FTP server returned items whose names or attributes could not be read."
                    .to_owned(),
            );
        }
        Ok(self.files)
    }
}

fn listing_entry(file: FtpEntry) -> local::Entry {
    let mut entry = local::Entry::new(
        file.name().to_owned(),
        file.is_directory(),
        file.is_symlink(),
        local::EntryAttributes::default(),
        file.is_file().then_some(file.size() as u64),
        (file.modified() != UNIX_EPOCH).then_some(file.corrected),
    );
    entry.owner = file.uid().map(|uid| uid.to_string());
    entry
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && !matches!(name, "." | "..")
        && !name.contains(['/', '\\', '\u{fffd}'])
        && safe_argument(name)
}

pub fn parse_path(path: &str) -> Result<Vec<String>> {
    let path = path
        .strip_prefix('/')
        .ok_or("Enter an absolute FTP path starting with /.")?;
    let segments: Vec<_> = path
        .trim_end_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect();
    absolute(&segments)?;
    Ok(segments)
}

pub fn absolute(segments: &[String]) -> Result<String> {
    if segments.len() > MAX_DEPTH || segments.iter().any(|name| !valid_name(name)) {
        return Err("Invalid FTP file or folder path.".to_owned());
    }
    Ok(format!("/{}", segments.join("/")))
}

pub fn child(segments: &[String], name: &str) -> Vec<String> {
    let mut result = segments.to_vec();
    result.push(name.to_owned());
    result
}

fn unsupported(error: &FtpError) -> bool {
    matches!(error, FtpError::UnexpectedResponse(response) if matches!(response.status,
        Status::BadCommand | Status::BadArguments | Status::NotImplemented | Status::NotImplementedParameter))
}

fn start_directory_error(error: FtpError) -> InitialListingError {
    if matches!(&error, FtpError::UnexpectedResponse(response) if response.status == Status::FileUnavailable)
    {
        InitialListingError::Unavailable(message(error))
    } else {
        InitialListingError::Other(message(error))
    }
}

impl Session {
    fn decode(&self, bytes: &[u8]) -> String {
        match self.encoding {
            Some(encoding) => encoding.decode_without_bom_handling(bytes).0.into_owned(),
            None => String::from_utf8_lossy(bytes).into_owned(),
        }
    }

    fn pwd(&mut self) -> FtpResult<String> {
        if !self.ftp_options.raw_iac_pwd {
            return self.limits.call(self.stream.pwd());
        }
        let response = self
            .limits
            .call(self.stream.custom_command("PWD", &[Status::PathCreated]))?;
        let path = self.decode(&response.body);
        match (path.find('"'), path.rfind('"')) {
            (Some(begin), Some(end)) if begin < end => Ok(path[begin + 1..end].to_owned()),
            _ => Err(FtpError::BadResponse),
        }
    }

    pub fn list(&mut self, segments: &[String]) -> Result<Entries> {
        self.limits
            .call(self.stream.cwd(absolute(segments)?))
            .map_err(message)?;
        self.list_current().map_err(message)
    }

    fn listing_lines(&mut self, command: &str) -> FtpResult<Vec<String>> {
        let data = self.limits.data(
            async {
                self.stream
                    .custom_data_command(command, &[Status::AboutToSend, Status::AlreadyOpen])
                    .await
                    .map(|(_, stream)| stream)
            },
            self.options,
            self.ftp_options.active_mode,
        )?;
        let mut reader = BufReader::new(data);
        let mut lines = Vec::new();
        let mut buffer = Vec::new();
        while self
            .limits
            .io(reader.read_until(b'\n', &mut buffer))
            .map_err(FtpError::ConnectionError)?
            != 0
        {
            let bytes = buffer.strip_suffix(b"\n").unwrap_or(&buffer);
            let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
            if !bytes.is_empty() {
                lines.push(self.decode(bytes));
            }
            buffer.clear();
        }
        self.limits.call(reader.into_inner().finish())?;
        Ok(lines)
    }

    fn list_current(&mut self) -> std::result::Result<Entries, FtpError> {
        let lines = if self.use_mlsd {
            match self.listing_lines("MLSD") {
                Ok(lines) => lines,
                Err(error) if self.ftp_options.mlsd == MlsdPolicy::Auto && unsupported(&error) => {
                    self.use_mlsd = false;
                    self.listing_lines("LIST")?
                }
                Err(error) => return Err(error),
            }
        } else {
            self.listing_lines("LIST")?
        };
        let mut result = Entries {
            files: Vec::new(),
            omitted: 0,
        };
        let corrected_time = self.environment.ftp_clock(self.use_mlsd);
        for line in lines {
            if line.is_empty() || (!self.use_mlsd && line.starts_with("total ")) {
                continue;
            }
            if self.use_mlsd
                && line.split_once(' ').is_some_and(|(facts, _)| {
                    facts.split(';').any(|fact| {
                        fact.eq_ignore_ascii_case("type=cdir")
                            || fact.eq_ignore_ascii_case("type=pdir")
                    })
                })
            {
                continue;
            }
            let parsed = if self.use_mlsd {
                ListParser::parse_mlsd(&line)
            } else {
                line.parse()
            };
            match parsed {
                Ok(file) if valid_name(file.name()) => {
                    let corrected = corrected_time(file.modified());
                    result.files.push(FtpEntry {
                        raw: file,
                        corrected,
                    });
                }
                Ok(file) if matches!(file.name(), "." | "..") => {}
                _ => result.omitted += 1,
            }
        }
        Ok(result)
    }

    pub fn stat(&mut self, segments: &[String]) -> Result<Option<FtpEntry>> {
        let (name, parent) = segments
            .split_last()
            .ok_or("Choose an FTP file or folder.")?;
        absolute(segments)?;
        let listing = self.list(parent)?;
        let found = listing.files.into_iter().find(|file| file.name() == name);
        if found.is_none() && listing.omitted > 0 {
            return Err(
                "The FTP listing is incomplete. The destination could not be checked.".to_owned(),
            );
        }
        Ok(found)
    }

    pub fn matches_file(&mut self, segments: &[String], expected: &FtpEntry) -> Result<bool> {
        if self.use_mlsd {
            // MLST may use an absolute name where the directory listing uses a bare name.
            let path = absolute(segments)?;
            if let Ok(reply) = self.limits.call(self.stream.mlst(Some(&path))) {
                if let Some((facts, name)) = reply.split_once("; ") {
                    if (name == path || name == expected.name())
                        && ListParser::parse_mlst(&format!("{facts}; {}", expected.name()))
                            .is_ok_and(|file| file == expected.raw)
                    {
                        return Ok(true);
                    }
                }
            }
        }
        // Legacy servers and replies with different facts use the listing check.
        Ok(self
            .stat(segments)?
            .is_some_and(|entry| entry.raw == expected.raw))
    }

    pub fn folder_size(&mut self, segments: &[String], stop: &AtomicBool) -> Option<(u64, bool)> {
        if stop.load(Ordering::Relaxed) {
            return None;
        }
        let Ok(listing) = self.list(segments) else {
            return Some((0, true));
        };
        let mut bytes = 0_u64;
        let mut incomplete = listing.omitted > 0;
        for file in listing.files {
            if stop.load(Ordering::Relaxed) {
                return None;
            }
            if file.is_directory() {
                let (child_bytes, partial) =
                    self.folder_size(&child(segments, file.name()), stop)?;
                bytes = bytes.saturating_add(child_bytes);
                incomplete |= partial;
            } else if file.is_file() {
                bytes = bytes.saturating_add(file.size() as u64);
            }
        }
        Some((bytes, incomplete))
    }

    pub fn regular(&mut self, segments: &[String]) -> Result<FtpEntry> {
        self.stat(segments)?
            .filter(|file| file.is_file())
            .ok_or_else(|| "Choose a regular FTP file.".to_owned())
    }

    pub fn download(
        &mut self,
        segments: &[String],
        output: &mut impl Write,
        mut progress: impl FnMut(u64) -> Result<()>,
    ) -> Result<()> {
        let mut stream = self
            .limits
            .data(
                self.stream.retr_as_stream(absolute(segments)?),
                self.options,
                self.ftp_options.active_mode,
            )
            .map_err(message)?;
        let mut buffer = vec![0; 64 * 1024];
        let mut total = 0;
        loop {
            let count = self.limits.io(stream.read(&mut buffer)).map_err(message)?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count]).map_err(message)?;
            total += count as u64;
            progress(total)?;
        }
        self.limits.call(stream.finish()).map_err(message)
    }

    pub fn read_limited(
        &mut self,
        segments: &[String],
        offset: u64,
        limit: u64,
        length: u64,
    ) -> Result<Vec<u8>> {
        let count = limit.min(length.saturating_sub(offset));
        if count == 0 && (length > 0 || offset > 0) {
            return Ok(Vec::new());
        }
        if offset > 0 {
            self.limits
                .call(
                    self.stream
                        .resume_transfer(usize::try_from(offset).map_err(message)?),
                )
                .map_err(message)?;
        }
        let mut bytes = Vec::new();
        let mut stream = self
            .limits
            .data(
                self.stream.retr_as_stream(absolute(segments)?),
                self.options,
                self.ftp_options.active_mode,
            )
            .map_err(message)?;
        let mut buffer = [0; 64 * 1024];
        while bytes.len() as u64 != count {
            let available = (count - bytes.len() as u64).min(buffer.len() as u64) as usize;
            let chunk = self
                .limits
                .io(stream.read(&mut buffer[..available]))
                .map_err(message)?;
            if chunk == 0 {
                return Err("The FTP file changed during the read.".to_owned());
            }
            bytes.extend_from_slice(&buffer[..chunk]);
        }
        if offset + count == length {
            let mut extra = [0];
            if self.limits.io(stream.read(&mut extra)).map_err(message)? > 0 {
                return Err("The FTP file changed during the read.".to_owned());
            }
            self.limits.call(stream.finish()).map_err(message)?;
        }
        Ok(bytes)
    }

    pub fn upload_to_stage(
        &mut self,
        target: &[String],
        input: &mut impl Read,
        mut progress: impl FnMut(u64) -> Result<()>,
    ) -> Result<String> {
        let (_, parent) = target
            .split_last()
            .ok_or("Choose an FTP destination file.")?;
        let stage = absolute(&child(parent, &format!(".dirlume-{}.part", Uuid::new_v4())))?;
        let result = (|| {
            let mut stream = self
                .limits
                .data(
                    self.stream.put_with_stream(&stage),
                    self.options,
                    self.ftp_options.active_mode,
                )
                .map_err(message)?;
            let mut buffer = vec![0; 64 * 1024];
            let mut total = 0;
            loop {
                let count = input.read(&mut buffer).map_err(message)?;
                if count == 0 {
                    break;
                }
                self.limits
                    .io(stream.write_all(&buffer[..count]))
                    .map_err(message)?;
                total += count as u64;
                progress(total)?;
            }
            self.limits.call(stream.finish()).map_err(message)
        })();
        if let Err(error) = result {
            self.remove_stage(&stage);
            return Err(error);
        }
        Ok(stage)
    }

    pub fn remove_stage(&mut self, stage: &str) {
        let limits = OperationLimits {
            timeout: Some(Duration::from_millis(500)),
            stop: None,
        };
        let _ = limits.call(self.stream.rm(stage));
    }

    pub fn rename_stage(&mut self, stage: &str, target: &[String]) -> Result<()> {
        let target = absolute(target)?;
        self.limits
            .call(self.stream.rename(stage, &target))
            .map_err(message)
    }

    pub fn mkdir(&mut self, segments: &[String]) -> Result<()> {
        self.limits
            .call(self.stream.mkdir(absolute(segments)?))
            .map_err(message)
    }

    fn remove(&mut self, segments: &[String], recursive: bool) -> Result<()> {
        let file = self
            .stat(segments)?
            .ok_or("The FTP item no longer exists.")?;
        let path = absolute(segments)?;
        if file.is_directory() {
            if recursive {
                for entry in self.list(segments)?.complete()? {
                    self.remove(&child(segments, entry.name()), true)?;
                }
            }
            self.limits.call(self.stream.rmdir(path)).map_err(message)
        } else {
            self.limits.call(self.stream.rm(path)).map_err(message)
        }
    }
}

#[tauri::command]
pub async fn list_ftp(
    id: u32,
    segments: Vec<String>,
    request: Option<Uuid>,
    state: State<'_, FtpState>,
    requests: State<'_, netbox_connection::Requests>,
) -> Result<RemoteListing> {
    let connection = state.connection(id)?;
    let stop = requests.token(request)?;
    blocking(move || {
        connection
            .open_with_cancel(stop)?
            .list(&segments)
            .map(Entries::into_listing)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FtpSearchRequest {
    connection: u32,
    segments: Vec<String>,
    mask: String,
    show_hidden: bool,
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FtpSearchEvent {
    Batch {
        segments: Vec<String>,
        prefix: String,
        entries: Vec<local::Entry>,
    },
    Done {
        omitted: usize,
    },
}

#[tauri::command]
pub async fn search_ftp(
    id: u32,
    request: FtpSearchRequest,
    output: Channel<FtpSearchEvent>,
    state: State<'_, FtpState>,
) -> Result<()> {
    let connection = state.connection(request.connection)?;
    let stop = CancellationToken::new();
    {
        let mut searches = state.searches.lock().map_err(message)?;
        if searches.contains_key(&id) {
            return Err("An FTP search is already running.".to_owned());
        }
        searches.insert(id, stop.clone());
    }
    let result = blocking(move || {
        let mut session = connection.open_with_cancel(Some(stop.clone()))?;
        let search = search_session(&mut session, request, &stop, &output);
        let _ = session.limits.call(session.stream.quit());
        search
    })
    .await;
    state.searches.lock().map_err(message)?.remove(&id);
    result
}

#[tauri::command]
pub fn cancel_ftp_search(id: u32, state: State<'_, FtpState>) -> Result<()> {
    if let Some(stop) = state.searches.lock().map_err(message)?.get(&id) {
        stop.cancel();
    }
    Ok(())
}

fn search_session(
    session: &mut Session,
    request: FtpSearchRequest,
    stop: &CancellationToken,
    output: &Channel<FtpSearchEvent>,
) -> Result<()> {
    const BATCH_SIZE: usize = 128;
    let mask: Vec<_> = request.mask.to_lowercase().chars().collect();
    let mut omitted = 0;
    let mut pending = vec![(request.segments, String::new())];
    while let Some((segments, prefix)) = pending.pop() {
        if stop.is_cancelled() {
            return Ok(());
        }
        let listing = match session.list(&segments) {
            Ok(listing) => listing,
            Err(error) if prefix.is_empty() => return Err(error),
            Err(_) => {
                omitted += 1;
                continue;
            }
        };
        omitted += listing.omitted;
        let mut matches = Vec::new();
        let send = |entries| {
            output
                .send(FtpSearchEvent::Batch {
                    segments: segments.clone(),
                    prefix: prefix.clone(),
                    entries,
                })
                .map_err(message)
        };
        for file in listing.files {
            if stop.is_cancelled() {
                return Ok(());
            }
            let entry = listing_entry(file);
            if entry.is_hidden() && !request.show_hidden {
                continue;
            }
            if entry.directory {
                if !entry.link {
                    pending.push((
                        child(&segments, &entry.name),
                        format!("{}{}/", prefix, entry.name),
                    ));
                }
            } else if matches_mask(&mask, &entry.name) {
                matches.push(entry);
                if matches.len() == BATCH_SIZE {
                    send(std::mem::take(&mut matches))?;
                }
            }
        }
        if !matches.is_empty() {
            send(matches)?;
        }
    }
    if !stop.is_cancelled() {
        output
            .send(FtpSearchEvent::Done { omitted })
            .map_err(message)?;
    }
    Ok(())
}

pub(crate) fn matches_mask(pattern: &[char], name: &str) -> bool {
    let name: Vec<_> = name.to_lowercase().chars().collect();
    let (mut index, mut next) = (0, 0);
    let mut wildcard = None;
    while index < name.len() {
        match pattern.get(next) {
            Some('*') => {
                next += 1;
                wildcard = Some((next, index));
            }
            Some(letter) if *letter == '?' || *letter == name[index] => {
                index += 1;
                next += 1;
            }
            _ => {
                let Some((after, previous)) = wildcard else {
                    return false;
                };
                index = previous + 1;
                next = after;
                wildcard = Some((after, index));
            }
        }
    }
    pattern[next..].iter().all(|&letter| letter == '*')
}

#[tauri::command]
pub async fn rename_ftp(
    id: u32,
    segments: Vec<String>,
    name: String,
    state: State<'_, FtpState>,
) -> Result<()> {
    let connection = state.connection(id)?;
    blocking(move || {
        let mut session = connection.open()?;
        let (old, parent) = segments
            .split_last()
            .ok_or("Choose an FTP file or folder.")?;
        if old == &name {
            return Ok(());
        }
        let target = child(parent, &name);
        if session.stat(&target)?.is_some() {
            return Err("An item with that name already exists.".to_owned());
        }
        session
            .limits
            .call(
                session
                    .stream
                    .rename(absolute(&segments)?, absolute(&target)?),
            )
            .map_err(message)
    })
    .await
}

#[tauri::command]
pub async fn delete_ftp(
    id: u32,
    segments: Vec<String>,
    recursive: bool,
    state: State<'_, FtpState>,
) -> Result<()> {
    let connection = state.connection(id)?;
    blocking(move || connection.open()?.remove(&segments, recursive)).await
}

#[cfg(test)]
mod compatibility_tests;

#[cfg(test)]
mod tls_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[tokio::test]
    async fn data_and_control_sockets_inherit_the_profile_settings() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let default = dial(address, ConnectionPreferences::default(), false)
            .await
            .unwrap();
        let default = SockRef::from(&default);
        assert!(!default.keepalive().unwrap());

        let options = serde_json::from_str::<ConnectionPreferences>(
            r#"{"timeout":{"mode":"disabled"},"keepalive":{"mode":"custom","seconds":3},"optimizeBuffer":true}"#,
        )
        .unwrap()
        .validated()
        .unwrap();
        let control = dial(address, options, false).await.unwrap();
        let data = dial(address, options, true).await.unwrap();
        let control = SockRef::from(&control);
        let data = SockRef::from(&data);
        assert!(control.keepalive().unwrap() && data.keepalive().unwrap());
        assert!(data.recv_buffer_size().unwrap() >= control.recv_buffer_size().unwrap());
        assert!(data.send_buffer_size().unwrap() >= control.send_buffer_size().unwrap());
    }
}
