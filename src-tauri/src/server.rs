use std::{
    fs,
    io::{self, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{
    body::Body,
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
    routing::post,
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use cap_std::{ambient_authority, fs::Dir};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tokio::task::spawn_blocking;
use tokio_util::io::ReaderStream;
use url::Url;

use crate::{
    local::{self, Entry},
    protocol::{
        BytePage, ByteRequest, Invitation, ListPage, ListRequest, RemoteListing, RemotePath,
    },
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[cfg(feature = "desktop")]
#[path = "server_lan_upload.rs"]
mod lan_upload;

#[derive(Deserialize, Serialize)]
struct Identity {
    invitation: Invitation,
    key: Vec<u8>,
}

impl Identity {
    fn load(directory: &Path) -> Result<Self> {
        Ok(serde_json::from_slice(&fs::read(
            directory.join("identity.json"),
        )?)?)
    }

    fn generate(address: Url) -> Result<Self> {
        let host = match address.host().ok_or("Missing advertised host")? {
            url::Host::Domain(name) => name.to_owned(),
            url::Host::Ipv4(ip) => ip.to_string(),
            url::Host::Ipv6(ip) => ip.to_string(),
        };
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec![host])?;
        let mut token = [0; 32];
        SystemRandom::new()
            .fill(&mut token)
            .map_err(|_| "Could not generate the server token")?;
        Ok(Self {
            invitation: Invitation {
                address,
                certificate: URL_SAFE_NO_PAD.encode(cert.der()),
                token: URL_SAFE_NO_PAD.encode(token),
            },
            key: signing_key.serialize_der(),
        })
    }

    fn init(directory: &Path, address: Url) -> Result<Self> {
        let identity = Self::generate(address)?;
        let mut output = tempfile::NamedTempFile::new_in(directory)?;
        output.write_all(&serde_json::to_vec(&identity)?)?;
        output.as_file().sync_all()?;
        output.persist_noclobber(directory.join("identity.json"))?;
        Ok(identity)
    }

    async fn tls(&self) -> Result<axum_server::tls_rustls::RustlsConfig> {
        let certificate = URL_SAFE_NO_PAD.decode(&self.invitation.certificate)?;
        Ok(
            axum_server::tls_rustls::RustlsConfig::from_der(vec![certificate], self.key.clone())
                .await?,
        )
    }
}

struct Share {
    roots: ShareRoots,
    authorization: String,
    #[cfg(feature = "desktop")]
    writable: Option<Arc<std::sync::atomic::AtomicBool>>,
    #[cfg(feature = "desktop")]
    lan_writes: std::sync::Mutex<()>,
    #[cfg(feature = "desktop")]
    lan_uploads: lan_upload::Uploads,
}

enum ShareRoots {
    Folder(Arc<Dir>),
    #[cfg(feature = "desktop")]
    Computer(ComputerLocations),
}

#[cfg(feature = "desktop")]
type ComputerLocations = Arc<dyn Fn() -> Vec<(String, PathBuf)> + Send + Sync>;

#[cfg(feature = "desktop")]
fn available_computer_locations(
    locations: &ComputerLocations,
) -> std::collections::BTreeMap<String, PathBuf> {
    locations()
        .into_iter()
        .filter(|(_, path)| Dir::open_ambient_dir(path, ambient_authority()).is_ok())
        .collect()
}

#[cfg(feature = "desktop")]
#[derive(Deserialize, Serialize)]
pub(crate) struct ComputerDrive {
    name: String,
    #[serde(rename = "type")]
    kind: Option<u32>,
    total: Option<u64>,
    available: Option<u64>,
}

impl Share {
    fn authorize(&self, headers: &HeaderMap) -> std::result::Result<(), StatusCode> {
        match headers.get(header::AUTHORIZATION) {
            Some(value) if bool::from(value.as_bytes().ct_eq(self.authorization.as_bytes())) => {
                Ok(())
            }
            _ => Err(StatusCode::UNAUTHORIZED),
        }
    }

    fn resolve(&self, path: RemotePath) -> io::Result<(Arc<Dir>, PathBuf)> {
        let root = match &self.roots {
            ShareRoots::Folder(root) => root,
            #[cfg(feature = "desktop")]
            ShareRoots::Computer(roots) => {
                let mut path = path;
                if path.segments.is_empty() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "Choose a drive",
                    ));
                }
                let name = path.segments.remove(0);
                let root = roots()
                    .into_iter()
                    .rev()
                    .filter(|(label, _)| label == &name)
                    .find_map(|(_, path)| Dir::open_ambient_dir(path, ambient_authority()).ok())
                    .ok_or_else(|| {
                        io::Error::new(io::ErrorKind::NotFound, "The drive is unavailable")
                    })?;
                return Ok((Arc::new(root), relative_path(path)?));
            }
        };
        Ok((Arc::clone(root), relative_path(path)?))
    }
}

fn relative_path(path: RemotePath) -> io::Result<PathBuf> {
    if path.segments.len() > 256 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Path too deep"));
    }
    let mut relative = PathBuf::from(".");
    for component in &path.segments {
        relative.push(local::name_component(component)?);
    }
    Ok(relative)
}

// Use a directory capability for every path access so that links cannot escape the share.
fn list(share: &Share, request: ListRequest) -> io::Result<ListPage> {
    #[cfg(any(unix, windows))]
    use cap_std::fs::MetadataExt;

    #[cfg(feature = "desktop")]
    if let ShareRoots::Computer(roots) = &share.roots {
        if request.path.segments.is_empty() {
            let entries = available_computer_locations(roots)
                .keys()
                .filter(|name| request.after.as_ref().is_none_or(|after| *name > after))
                .map(|name| {
                    Entry::new(
                        name.clone(),
                        true,
                        false,
                        local::EntryAttributes::default(),
                        None,
                        None,
                    )
                })
                .collect();
            return Ok(ListPage {
                listing: RemoteListing {
                    entries,
                    omitted: 0,
                },
                next: None,
            });
        }
    }
    let (root, path) = share.resolve(request.path)?;
    let directory = root.open_dir(path)?;
    let mut entries = Vec::new();
    let mut omitted = 0;
    const PAGE_SIZE: usize = 512;
    let mut names = std::collections::BTreeSet::new();
    let mut more = false;
    for entry in directory.entries()? {
        let Some(name) = entry
            .ok()
            .and_then(|entry| entry.file_name().into_string().ok())
        else {
            if request.after.is_none() {
                omitted += 1;
            }
            continue;
        };
        if request.after.as_ref().is_some_and(|after| name <= *after) {
            continue;
        }
        names.insert(name);
        if request.paged && names.len() > PAGE_SIZE {
            names.pop_last();
            more = true;
        }
    }
    let next = if more { names.last().cloned() } else { None };
    for name in names {
        let Ok(metadata) = directory.symlink_metadata(&name) else {
            omitted += 1;
            continue;
        };
        #[cfg(windows)]
        let link = metadata.is_symlink()
            || metadata.file_attributes()
                & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
                != 0;
        #[cfg(not(windows))]
        let link = metadata.is_symlink();
        let file = metadata.is_file();
        if !(metadata.is_dir() || file || link) || local::name_component(&name).is_err() {
            omitted += 1;
            continue;
        }
        let directory = metadata.is_dir() || (link && directory.open_dir(&name).is_ok());
        #[cfg(windows)]
        let attributes = local::EntryAttributes::from_windows(metadata.file_attributes());
        #[cfg(not(windows))]
        let attributes = local::EntryAttributes::default();
        let item = Entry::new(
            name,
            directory,
            link,
            attributes,
            file.then_some(metadata.len()),
            metadata.modified().ok().map(|time| time.into_std()),
        );
        let mut item = item;
        item.created = metadata.created().ok().and_then(|time| {
            time.into_std()
                .duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|value| value.as_secs())
        });
        item.accessed = metadata.accessed().ok().and_then(|time| {
            time.into_std()
                .duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|value| value.as_secs())
        });
        #[cfg(unix)]
        {
            item.owner = Some(metadata.uid().to_string());
            item.hard_links = (file && !link).then(|| metadata.nlink());
            item.changed = Some(
                metadata
                    .ctime()
                    .saturating_mul(10_000_000)
                    .saturating_add(metadata.ctime_nsec() / 100),
            );
            item.allocated = metadata.blocks().checked_mul(512);
            if file && !link && metadata.nlink() > 1 && metadata.ino() != 0 {
                item.allocation_id = Some(format!("{}:{}", metadata.dev(), metadata.ino()));
            }
        }
        entries.push(item);
    }
    Ok(ListPage {
        listing: RemoteListing { entries, omitted },
        next,
    })
}

fn response_error(error: io::Error) -> StatusCode {
    match error.kind() {
        io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
        io::ErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
        io::ErrorKind::InvalidInput | io::ErrorKind::NotADirectory => StatusCode::BAD_REQUEST,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn list_directory(
    State(share): State<Arc<Share>>,
    headers: HeaderMap,
    Json(path): Json<ListRequest>,
) -> std::result::Result<Json<ListPage>, StatusCode> {
    share.authorize(&headers)?;
    let listing = spawn_blocking(move || list(&share, path))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map_err(response_error)?;
    Ok(Json(listing))
}

async fn download(
    State(share): State<Arc<Share>>,
    headers: HeaderMap,
    Json(path): Json<RemotePath>,
) -> std::result::Result<Response, StatusCode> {
    share.authorize(&headers)?;
    let (file, length) = spawn_blocking(move || {
        let file = open_regular_file(&share, path)?;
        let length = file.metadata()?.len();
        Ok((file, length))
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .map_err(response_error)?;
    let file = tokio::fs::File::from_std(file);
    use tokio::io::AsyncReadExt;
    Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, length)
        .body(Body::from_stream(ReaderStream::new(file.take(length))))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn open_regular_file(share: &Share, path: RemotePath) -> io::Result<fs::File> {
    let (root, path) = share.resolve(path)?;
    if !root.symlink_metadata(&path)?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Choose a regular file",
        ));
    }
    let file = root.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Choose a regular file",
        ));
    }
    Ok(file.into_std())
}

async fn read_bytes(
    State(share): State<Arc<Share>>,
    headers: HeaderMap,
    Json(request): Json<ByteRequest>,
) -> std::result::Result<Json<BytePage>, StatusCode> {
    share.authorize(&headers)?;
    let page = spawn_blocking(move || {
        let file = open_regular_file(
            &share,
            RemotePath {
                segments: request.segments,
            },
        )?;
        local::read_byte_page(file, request.offset)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .map_err(response_error)?;
    Ok(Json(page))
}

fn make_share(root: &Path, token: &str) -> io::Result<Arc<Share>> {
    Ok(Arc::new(Share {
        roots: ShareRoots::Folder(Arc::new(Dir::open_ambient_dir(root, ambient_authority())?)),
        authorization: format!("Bearer {token}"),
        #[cfg(feature = "desktop")]
        writable: None,
        #[cfg(feature = "desktop")]
        lan_writes: std::sync::Mutex::new(()),
        #[cfg(feature = "desktop")]
        lan_uploads: lan_upload::Uploads::default(),
    }))
}

fn ensure_state_outside_share(root: &Path, directory: &Path) -> Result<()> {
    let directory = directory.canonicalize()?;
    for ancestor in directory.ancestors().filter(|path| path.has_root()) {
        if same_file::is_same_file(root, ancestor)? {
            return Err("Store server state outside the shared directory.".into());
        }
    }
    Ok(())
}

fn advertised_url(host: &str, port: u16) -> Result<Url> {
    let host = match host.parse::<std::net::Ipv6Addr>() {
        Ok(ip) => format!("[{ip}]"),
        Err(_) => host.to_owned(),
    };
    let address = Url::parse(&format!("https://{host}:{port}/"))?;
    if address.host().is_none()
        || address.path() != "/"
        || !address.username().is_empty()
        || address.password().is_some()
        || address.fragment().is_some()
        || address.query().is_some()
        || address.port_or_known_default() != Some(port)
    {
        return Err("Enter an IP address or DNS hostname without a port.".into());
    }
    Ok(address)
}

pub async fn serve(root: &Path, directory: &Path, bind: SocketAddr, host: &str) -> Result<()> {
    let address = advertised_url(host, bind.port())?;
    if bind.port() == 0 {
        return Err("Choose a fixed port to use in invitations.".into());
    }
    // Resolve the nearest existing ancestor before creating a state directory.
    let existing = directory
        .ancestors()
        .find(|path| path.is_dir())
        .ok_or("Cannot resolve server state directory")?;
    ensure_state_outside_share(root, existing)?;
    fs::create_dir_all(directory)?;
    ensure_state_outside_share(root, directory)?;
    let identity = match directory.join("identity.json").try_exists()? {
        true => Identity::load(directory)?,
        false => Identity::init(directory, address.clone())?,
    };
    if identity.invitation.address != address {
        return Err("This state directory belongs to a different advertised address. Choose another state directory.".into());
    }
    let share = make_share(root, &identity.invitation.token)?;
    let tls = identity.tls().await?;
    let listener = std::net::TcpListener::bind(bind)?;
    listener.set_nonblocking(true)?;
    println!("Dirlume server listening on {bind} for {address}");
    axum_server::from_tcp_rustls(listener, tls)?
        .serve(router(share).into_make_service())
        .await?;
    Ok(())
}

#[cfg(feature = "desktop")]
pub(crate) struct DesktopServer {
    pub(crate) invitation: String,
    pub(crate) address: String,
    shutdown: axum_server::Handle<SocketAddr>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

#[cfg(feature = "desktop")]
impl DesktopServer {
    #[cfg(test)]
    pub(crate) async fn start(root: &Path, ip: std::net::IpAddr) -> Result<Self> {
        let roots = ShareRoots::Folder(Arc::new(Dir::open_ambient_dir(root, ambient_authority())?));
        Self::start_with_roots(roots, ip, None).await
    }

    pub(crate) async fn start_computer(
        locations: impl Fn() -> Vec<(String, PathBuf)> + Send + Sync + 'static,
        ip: std::net::IpAddr,
    ) -> Result<Self> {
        Self::start_computer_with_group(locations, ip, None).await
    }

    pub(crate) async fn start_computer_with_group(
        locations: impl Fn() -> Vec<(String, PathBuf)> + Send + Sync + 'static,
        ip: std::net::IpAddr,
        group: Option<(
            &crate::lan_group::GroupKey,
            Arc<std::sync::atomic::AtomicBool>,
        )>,
    ) -> Result<Self> {
        let roots: ComputerLocations = Arc::new(locations);
        let initial = Arc::clone(&roots);
        if spawn_blocking(move || available_computer_locations(&initial).is_empty()).await? {
            return Err("There are no accessible local drives.".into());
        }
        Self::start_with_roots(ShareRoots::Computer(roots), ip, group).await
    }

    async fn start_with_roots(
        roots: ShareRoots,
        ip: std::net::IpAddr,
        group: Option<(
            &crate::lan_group::GroupKey,
            Arc<std::sync::atomic::AtomicBool>,
        )>,
    ) -> Result<Self> {
        let listener = std::net::TcpListener::bind(SocketAddr::new(ip, 0))?;
        listener.set_nonblocking(true)?;
        let address = advertised_url(&ip.to_string(), listener.local_addr()?.port())?;
        let mut identity = Identity::generate(address.clone())?;
        if let Some((key, _)) = &group {
            identity.invitation.token = key.bearer(&identity.invitation.certificate);
        }
        let share = Arc::new(Share {
            roots,
            authorization: format!("Bearer {}", identity.invitation.token),
            writable: group.map(|(_, writable)| writable),
            lan_writes: std::sync::Mutex::new(()),
            lan_uploads: lan_upload::Uploads::default(),
        });
        if share.writable.is_some() {
            lan_upload::reap_stale_uploads(&share.lan_uploads);
        }
        let invitation = identity.invitation.encode()?;
        let shutdown = axum_server::Handle::new();
        let server =
            axum_server::from_tcp_rustls(listener, identity.tls().await?)?.handle(shutdown.clone());
        let result = Self {
            invitation,
            address: address.to_string(),
            shutdown,
            task: tokio::spawn(server.serve(router(share).into_make_service())),
        };
        match tokio::time::timeout(
            std::time::Duration::from_secs(5),
            result.shutdown.listening(),
        )
        .await
        {
            Ok(Some(_)) => Ok(result),
            _ => Err("The direct connection could not start listening.".into()),
        }
    }

    pub(crate) fn is_running(&self) -> bool {
        !self.task.is_finished()
    }

    pub(crate) async fn stop(&mut self) -> Result<()> {
        self.shutdown.shutdown();
        (&mut self.task).await??;
        Ok(())
    }
}

#[cfg(feature = "desktop")]
impl Drop for DesktopServer {
    fn drop(&mut self) {
        self.shutdown.shutdown();
    }
}

fn router(share: Arc<Share>) -> Router {
    let router = Router::new()
        .route("/v1/list", post(list_directory))
        .route("/v1/download", post(download))
        .route("/v1/bytes", post(read_bytes));
    #[cfg(feature = "desktop")]
    let router = router
        .route("/v1/drives", post(computer_drives))
        .route("/v1/lan/change", post(change_computer))
        .route("/v1/lan/save-text", post(save_computer_text))
        .route("/v1/lan/upload", post(lan_upload::handle));
    router
        .layer(DefaultBodyLimit::max(64 * 1024))
        .with_state(share)
}

#[cfg(feature = "desktop")]
async fn change_computer(
    State(share): State<Arc<Share>>,
    headers: HeaderMap,
    Json(operation): Json<crate::protocol::LanChangeRequest>,
) -> std::result::Result<Json<std::result::Result<(), String>>, StatusCode> {
    share.authorize(&headers)?;
    Ok(Json(
        spawn_blocking(move || apply_lan_change(&share, operation))
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    ))
}

#[cfg(feature = "desktop")]
fn apply_lan_change(
    share: &Share,
    operation: crate::protocol::LanChangeRequest,
) -> std::result::Result<(), String> {
    use crate::protocol::LanChange;
    let _write = share.lan_writes.lock().map_err(crate::message)?;
    let (directory, path) = writable_lan_item(share, operation.segments)?;
    match operation.change {
        LanChange::Folder => directory.create_dir(path),
        LanChange::CreateText { encoding } => lan_create_text(&directory, &path, encoding),
        LanChange::Rename { name } => {
            let target = local::name_component(&name).map_err(crate::message)?;
            rename_lan_exclusive(&directory, &path, target)
        }
        LanChange::DeleteCompared { expected, digest } => {
            remove_compared_lan_file(&directory, &path, &expected, &digest)
        }
        LanChange::Delete { recursive } => {
            let metadata = directory.symlink_metadata(&path).map_err(crate::message)?;
            if metadata.is_symlink() || !metadata.is_dir() {
                directory.remove_file(path)
            } else if recursive {
                directory.remove_dir_all(path)
            } else {
                directory.remove_dir(path)
            }
        }
    }
    .map_err(|error| error.to_string())
}

#[cfg(feature = "desktop")]
fn remove_compared_lan_file(
    directory: &Dir,
    path: &Path,
    expected: &crate::protocol::LanStat,
    digest: &str,
) -> io::Result<()> {
    let changed = || io::Error::other("The Dirlume LAN source changed after copying.");
    let metadata = directory.symlink_metadata(path)?;
    if !metadata.is_file() || &lan_upload::file_stat(expected.name.clone(), &metadata) != expected {
        return Err(changed());
    }
    let file = directory.open(path)?;
    let identity = same_file::Handle::from_file(file.try_clone()?.into_std())?;
    if crate::protocol::lan_file_digest(file, || Ok(()))? != digest {
        return Err(changed());
    }
    let metadata = directory.symlink_metadata(path)?;
    if !metadata.is_file()
        || &lan_upload::file_stat(expected.name.clone(), &metadata) != expected
        || same_file::Handle::from_file(directory.open(path)?.into_std())? != identity
    {
        return Err(changed());
    }
    directory.remove_file(path)
}

#[cfg(all(feature = "desktop", windows))]
fn rename_lan_exclusive(directory: &Dir, source: &Path, target: &Path) -> io::Result<()> {
    use cap_std::fs::OpenOptionsExt;
    use std::{
        mem::{align_of, offset_of, size_of},
        os::windows::{ffi::OsStrExt, io::AsRawHandle},
    };
    use windows_sys::{
        Wdk::Storage::FileSystem::{
            FileRenameInformation, NtSetInformationFile, FILE_RENAME_INFORMATION,
        },
        Win32::{
            Foundation::RtlNtStatusToDosError,
            Storage::FileSystem::{
                DELETE, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, SYNCHRONIZE,
            },
            System::IO::IO_STATUS_BLOCK,
        },
    };
    let mut options = cap_std::fs::OpenOptions::new();
    let file = directory.open_with(
        source,
        options
            .access_mode(DELETE | SYNCHRONIZE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT),
    )?;
    let name: Vec<u16> = target.as_os_str().encode_wide().collect();
    let offset = offset_of!(FILE_RENAME_INFORMATION, FileName);
    let name_bytes = name.len() * size_of::<u16>();
    let length = (offset + name_bytes + size_of::<u16>()).max(size_of::<FILE_RENAME_INFORMATION>());
    assert!(align_of::<usize>() >= align_of::<FILE_RENAME_INFORMATION>());
    let mut buffer = vec![0usize; length.div_ceil(size_of::<usize>())];
    let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
    let mut completion = IO_STATUS_BLOCK::default();
    let result = unsafe {
        (*info).RootDirectory = directory.as_raw_handle();
        (*info).FileNameLength = name_bytes as u32;
        let destination = buffer.as_mut_ptr().cast::<u8>().add(offset).cast::<u16>();
        std::ptr::copy_nonoverlapping(name.as_ptr(), destination, name.len());
        NtSetInformationFile(
            file.as_raw_handle(),
            &mut completion,
            info.cast(),
            length as u32,
            FileRenameInformation,
        )
    };
    if result < 0 {
        Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(result) } as i32,
        ))
    } else {
        Ok(())
    }
}

#[cfg(all(feature = "desktop", unix))]
fn rename_lan_exclusive(directory: &Dir, source: &Path, target: &Path) -> io::Result<()> {
    use std::{
        ffi::CString,
        os::{fd::AsRawFd, unix::ffi::OsStrExt},
    };
    let source = CString::new(source.as_os_str().as_bytes())?;
    let target = CString::new(target.as_os_str().as_bytes())?;
    let dir = directory.as_raw_fd();
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            dir,
            source.as_ptr(),
            dir,
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            dir,
            source.as_ptr(),
            dir,
            target.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(feature = "desktop")]
fn writable_lan_item(
    share: &Share,
    segments: Vec<String>,
) -> std::result::Result<(Dir, PathBuf), String> {
    require_lan_write(share)?;
    if segments.len() < 2 {
        return Err("Choose a location inside a remote drive.".to_owned());
    }
    let (root, path) = share
        .resolve(RemotePath { segments })
        .map_err(crate::message)?;
    let parent = root
        .open_dir(path.parent().unwrap_or(Path::new(".")))
        .map_err(crate::message)?;
    let name = path
        .file_name()
        .ok_or("Choose an item inside a remote drive.")?;
    Ok((parent, PathBuf::from(name)))
}

#[cfg(feature = "desktop")]
fn require_lan_write(share: &Share) -> std::result::Result<(), String> {
    if share
        .writable
        .as_ref()
        .is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Acquire))
    {
        Ok(())
    } else {
        Err("The remote computer allows read access only.".to_owned())
    }
}

#[cfg(feature = "desktop")]
fn lan_create_text(
    directory: &Dir,
    path: &Path,
    encoding: crate::desktop::Encoding,
) -> io::Result<()> {
    let bytes = crate::desktop::encode_text(encoding, "");
    if bytes.is_empty() {
        let mut options = cap_std::fs::OpenOptions::new();
        return directory
            .open_with(path, options.write(true).create_new(true))
            .map(drop);
    }
    stage_lan_text(directory, &bytes, None, |stage| {
        directory.hard_link(stage, directory, path)
    })
}

#[cfg(feature = "desktop")]
fn stage_lan_text(
    directory: &Dir,
    bytes: &[u8],
    original: Option<&cap_std::fs::File>,
    publish: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<()> {
    let stage = PathBuf::from(format!(".dirlume-text-{}", uuid::Uuid::new_v4()));
    let mut options = cap_std::fs::OpenOptions::new();
    #[cfg(windows)]
    if original.is_some() {
        use cap_std::fs::OpenOptionsExt;
        use windows_sys::Win32::{Foundation::GENERIC_WRITE, Storage::FileSystem::WRITE_DAC};
        options.access_mode(GENERIC_WRITE | WRITE_DAC);
    }
    #[cfg(unix)]
    if original.is_some() {
        use cap_std::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = directory.open_with(&stage, options.write(true).create_new(true))?;
    let written = original
        .map_or(Ok(()), |original| preserve_lan_access(original, &file))
        .and_then(|_| file.write_all(bytes))
        .and_then(|_| file.sync_all());
    drop(file);
    let result = written.and_then(|_| publish(&stage));
    let _ = directory.remove_file(&stage);
    result
}

#[cfg(all(feature = "desktop", windows))]
fn preserve_lan_access(original: &cap_std::fs::File, staged: &cap_std::fs::File) -> io::Result<()> {
    use std::{
        os::windows::io::AsRawHandle,
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{GetSecurityInfo, SetSecurityInfo, SE_FILE_OBJECT},
            DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
        },
    };
    let mut access = null_mut();
    let mut descriptor = null_mut();
    let read = unsafe {
        GetSecurityInfo(
            original.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut access,
            null_mut(),
            &mut descriptor,
        )
    };
    if read != 0 {
        return Err(io::Error::from_raw_os_error(read as i32));
    }
    let result = unsafe {
        let result = SetSecurityInfo(
            staged.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            access,
            null(),
        );
        LocalFree(descriptor);
        result
    };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result as i32));
    }
    staged.set_permissions(original.metadata()?.permissions())
}

#[cfg(all(feature = "desktop", unix))]
fn preserve_lan_access(original: &cap_std::fs::File, staged: &cap_std::fs::File) -> io::Result<()> {
    use cap_std::fs::{MetadataExt, PermissionsExt};
    use std::os::fd::AsRawFd;
    let source = original.metadata()?;
    if source.permissions().mode() & 0o6000 != 0 {
        return Err(io::Error::other(
            "Edit this file with a tool that supports special permissions.",
        ));
    }
    let target = staged.metadata()?;
    if (source.uid(), source.gid()) != (target.uid(), target.gid())
        && unsafe { libc::fchown(staged.as_raw_fd(), source.uid(), source.gid()) } != 0
    {
        return Err(io::Error::last_os_error());
    }
    staged.set_permissions(source.permissions())
}

#[cfg(feature = "desktop")]
async fn save_computer_text(
    State(share): State<Arc<Share>>,
    request: axum::extract::Request,
) -> std::result::Result<Json<std::result::Result<String, String>>, StatusCode> {
    share.authorize(request.headers())?;
    let bytes = axum::body::to_bytes(
        request.into_body(),
        6 * crate::desktop::TEXT_LIMIT as usize + 65_536,
    )
    .await
    .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?;
    let request = serde_json::from_slice(&bytes).map_err(|_| StatusCode::BAD_REQUEST)?;
    Ok(Json(
        spawn_blocking(move || save_lan_text(&share, request))
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    ))
}

#[cfg(feature = "desktop")]
fn save_lan_text(
    share: &Share,
    request: crate::protocol::LanTextSave,
) -> std::result::Result<String, String> {
    use crate::{
        desktop::{decode_text, encode_text, TEXT_LIMIT},
        protocol::lan_text_revision,
    };
    use std::io::Read as _;

    let _write = share.lan_writes.lock().map_err(crate::message)?;
    let (directory, path) = writable_lan_item(share, request.segments)?;
    let read_original = || -> io::Result<(Vec<u8>, cap_std::fs::File)> {
        if !directory.symlink_metadata(&path)?.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Choose a regular file.",
            ));
        }
        let mut options = cap_std::fs::OpenOptions::new();
        // Check write access on the original before replacing its directory entry.
        let mut file = directory.open_with(&path, options.read(true).write(true))?;
        let mut bytes = Vec::new();
        (&mut file).take(TEXT_LIMIT + 1).read_to_end(&mut bytes)?;
        Ok((bytes, file))
    };
    let (source, original) = read_original().map_err(crate::message)?;
    if lan_text_revision(&source) != request.revision {
        return Err("The file changed outside Dirlume. Reopen it before saving.".to_owned());
    }
    let encoding = decode_text(source.as_slice())?.encoding;
    let bytes = encode_text(encoding, &request.text);
    if bytes.len() as u64 > TEXT_LIMIT {
        return Err("The file is too large to edit in this remote editor.".to_owned());
    }
    stage_lan_text(&directory, &bytes, Some(&original), |stage| {
        let (current, current_file) = read_original()?;
        let first = same_file::Handle::from_file(original.try_clone()?.into_std())?;
        let second = same_file::Handle::from_file(current_file.into_std())?;
        if source != current || first != second {
            return Err(io::Error::other(
                "The file changed outside Dirlume. Reopen it before saving.",
            ));
        }
        directory.rename(stage, &directory, &path)
    })
    .map_err(crate::message)?;
    Ok(lan_text_revision(&bytes))
}

#[cfg(feature = "desktop")]
async fn computer_drives(
    State(share): State<Arc<Share>>,
    headers: HeaderMap,
) -> std::result::Result<(HeaderMap, Json<Vec<ComputerDrive>>), StatusCode> {
    share.authorize(&headers)?;
    spawn_blocking(move || {
        let ShareRoots::Computer(roots) = &share.roots else {
            return Err(StatusCode::NOT_FOUND);
        };
        let mut headers = HeaderMap::new();
        if let Some(name) = crate::protocol::computer_name() {
            if let Ok(name) = URL_SAFE_NO_PAD.encode(name).parse() {
                headers.insert(crate::protocol::COMPUTER_NAME_HEADER, name);
            }
        }
        Ok((
            headers,
            Json(
                available_computer_locations(roots)
                    .iter()
                    .map(|(name, path)| {
                        let space = crate::disk_space::query(path).ok();
                        ComputerDrive {
                            name: name.clone(),
                            #[cfg(windows)]
                            kind: local::drive_type(path),
                            #[cfg(not(windows))]
                            kind: None,
                            total: space.map(|space| space.total),
                            available: space.map(|space| space.available),
                        }
                    })
                    .collect(),
            ),
        ))
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
}

pub fn invitation(directory: &Path) -> Result<String> {
    Ok(Identity::load(directory)?.invitation.encode()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_every_entry_across_page_boundaries() {
        let temp = tempfile::tempdir().unwrap();
        for i in 0..515 {
            fs::write(temp.path().join(format!("item-{i:04}")), []).unwrap();
        }
        let share = make_share(temp.path(), "token").unwrap();
        let request = |after| ListRequest {
            path: RemotePath { segments: vec![] },
            paged: true,
            after,
        };
        let first = list(&share, request(None)).unwrap();
        assert_eq!(first.listing.entries.len(), 512);
        let second = list(&share, request(first.next)).unwrap();
        assert!(second.next.is_none());
        assert_eq!(second.listing.entries.len(), 3);
        let names: Vec<_> = first
            .listing
            .entries
            .into_iter()
            .chain(second.listing.entries)
            .map(|entry| entry.name)
            .collect();
        assert_eq!(
            names,
            (0..515).map(|i| format!("item-{i:04}")).collect::<Vec<_>>()
        );
    }

    #[test]
    fn rejects_traversal_and_state_inside_share() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("share");
        let state = root.join("state");
        fs::create_dir_all(&state).unwrap();
        assert!(ensure_state_outside_share(&root, &state).is_err());
        assert!(ensure_state_outside_share(&root, temp.path()).is_ok());
        assert!(relative_path(RemotePath {
            segments: vec!["..".into(), "outside".into()]
        })
        .is_err());
        assert!(relative_path(RemotePath {
            segments: vec!["nested/file.txt".into()]
        })
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn directory_links_cannot_escape_share() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("share");
        fs::create_dir(&root).unwrap();
        std::os::unix::fs::symlink(temp.path(), root.join("outside")).unwrap();
        let share = make_share(&root, "token").unwrap();
        assert!(list(
            &share,
            ListRequest {
                path: RemotePath {
                    segments: vec!["outside".into()]
                },
                paged: true,
                after: None
            }
        )
        .is_err());
    }
}
