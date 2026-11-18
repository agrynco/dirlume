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
    protocol::{BytePage, ByteRequest, Invitation, RemoteListing, RemotePath},
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

    fn init(directory: &Path, address: Url) -> Result<Self> {
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
        let identity = Self {
            invitation: Invitation {
                address,
                certificate: URL_SAFE_NO_PAD.encode(cert.der()),
                token: URL_SAFE_NO_PAD.encode(token),
            },
            key: signing_key.serialize_der(),
        };
        let mut output = tempfile::NamedTempFile::new_in(directory)?;
        output.write_all(&serde_json::to_vec(&identity)?)?;
        output.as_file().sync_all()?;
        output.persist_noclobber(directory.join("identity.json"))?;
        Ok(identity)
    }
}

struct Share {
    root: Dir,
    authorization: String,
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
fn list(share: &Share, path: RemotePath) -> io::Result<RemoteListing> {
    #[cfg(windows)]
    use cap_std::fs::MetadataExt;

    let directory = share.root.open_dir(relative_path(path)?)?;
    let mut entries = Vec::new();
    let mut omitted = 0;
    for entry in directory.entries()? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                omitted += 1;
                continue;
            }
        };
        let Ok(name) = entry.file_name().into_string() else {
            omitted += 1;
            continue;
        };
        let Ok(metadata) = directory.symlink_metadata(&name) else {
            omitted += 1;
            continue;
        };
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
        entries.push(Entry::new(
            name,
            directory,
            link,
            attributes,
            file.then_some(metadata.len()),
            metadata.modified().ok().map(|time| time.into_std()),
        ));
    }
    Ok(RemoteListing { entries, omitted })
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
    Json(path): Json<RemotePath>,
) -> std::result::Result<Json<RemoteListing>, StatusCode> {
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
    let path = relative_path(path)?;
    if !share.root.symlink_metadata(&path)?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Choose a regular file",
        ));
    }
    let file = share.root.open(path)?;
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
        root: Dir::open_ambient_dir(root, ambient_authority())?,
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
    let certificate = URL_SAFE_NO_PAD.decode(identity.invitation.certificate)?;
    let tls =
        axum_server::tls_rustls::RustlsConfig::from_der(vec![certificate], identity.key).await?;
    let listener = std::net::TcpListener::bind(bind)?;
    listener.set_nonblocking(true)?;
    println!("Dirlume server listening on {bind} for {address}");
    axum_server::from_tcp_rustls(listener, tls)?
        .serve(router(share).into_make_service())
        .await?;
    Ok(())
}

fn router(share: Arc<Share>) -> Router {
    Router::new()
        .route("/v1/list", post(list_directory))
        .route("/v1/download", post(download))
        .route("/v1/bytes", post(read_bytes))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .with_state(share)
}

pub fn invitation(directory: &Path) -> Result<String> {
    Ok(Identity::load(directory)?.invitation.encode()?)
}

#[cfg(test)]
mod tests {
    use super::*;

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
            RemotePath {
                segments: vec!["outside".into()]
            }
        )
        .is_err());
    }
}
