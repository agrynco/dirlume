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
        Self::start_with_roots(roots, ip).await
    }

    pub(crate) async fn start_computer(
        locations: impl Fn() -> Vec<(String, PathBuf)> + Send + Sync + 'static,
        ip: std::net::IpAddr,
    ) -> Result<Self> {
        let roots: ComputerLocations = Arc::new(locations);
        let initial = Arc::clone(&roots);
        if spawn_blocking(move || available_computer_locations(&initial).is_empty()).await? {
            return Err("There are no accessible local drives.".into());
        }
        Self::start_with_roots(ShareRoots::Computer(roots), ip).await
    }

    async fn start_with_roots(roots: ShareRoots, ip: std::net::IpAddr) -> Result<Self> {
        let listener = std::net::TcpListener::bind(SocketAddr::new(ip, 0))?;
        listener.set_nonblocking(true)?;
        let address = advertised_url(&ip.to_string(), listener.local_addr()?.port())?;
        let identity = Identity::generate(address.clone())?;
        let share = Arc::new(Share {
            roots,
            authorization: format!("Bearer {}", identity.invitation.token),
        });
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
    let router = router.route("/v1/drives", post(computer_drives));
    router
        .layer(DefaultBodyLimit::max(64 * 1024))
        .with_state(share)
}

#[cfg(feature = "desktop")]
async fn computer_drives(
    State(share): State<Arc<Share>>,
    headers: HeaderMap,
) -> std::result::Result<Json<Vec<ComputerDrive>>, StatusCode> {
    share.authorize(&headers)?;
    spawn_blocking(move || {
        let ShareRoots::Computer(roots) = &share.roots else {
            return Err(StatusCode::NOT_FOUND);
        };
        Ok(Json(
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
