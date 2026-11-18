use std::{
    collections::HashMap,
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{
    blocking::{Client, Response},
    redirect::Policy,
    Certificate,
};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, State};

use crate::{
    kswitcher, local,
    protocol::{Invitation, RemoteListing, RemotePath},
    terminal, watch,
};

pub(crate) type Result<T> = std::result::Result<T, String>;

pub(crate) fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub(crate) async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(message)?
}

#[tauri::command]
async fn locations() -> Result<Vec<local::Location>> {
    blocking(|| Ok(local::locations())).await
}

#[tauri::command]
async fn list_directory(path: String) -> Result<local::Listing> {
    blocking(move || local::list(local::absolute(&path).map_err(message)?).map_err(message)).await
}

fn selected(directory: &str, name: &str) -> io::Result<PathBuf> {
    Ok(local::absolute(directory)?.join(local::name_component(name)?))
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Operation {
    Open { name: String },
    Rename { name: String, new_name: String },
    CreateFolder { name: String },
    CreateFile { name: String },
    Recycle { name: String },
    Delete { name: String },
}

#[tauri::command]
async fn operate(directory: String, operation: Operation) -> Result<()> {
    blocking(move || {
        match operation {
            Operation::Open { name } => open::that(selected(&directory, &name).map_err(message)?),
            Operation::Rename { name, new_name } => local::move_item(
                &selected(&directory, &name).map_err(message)?,
                selected(&directory, &new_name).map_err(message)?,
            ),
            Operation::CreateFolder { name } => {
                fs::create_dir(selected(&directory, &name).map_err(message)?)
            }
            Operation::CreateFile { name } => {
                fs::File::create_new(selected(&directory, &name).map_err(message)?).map(drop)
            }
            Operation::Delete { name } => {
                local::permanently_delete(&selected(&directory, &name).map_err(message)?)
            }
            Operation::Recycle { name } => {
                return trash::delete(selected(&directory, &name).map_err(message)?)
                    .map_err(message)
            }
        }
        .map_err(message)
    })
    .await
}

struct Connection {
    client: Client,
    invitation: Invitation,
}

impl Connection {
    fn connect(invitation: &str) -> Result<Self> {
        let invitation = Invitation::parse(invitation)?;
        let certificate = URL_SAFE_NO_PAD
            .decode(&invitation.certificate)
            .map_err(message)?;
        let client = Client::builder()
            .tls_built_in_root_certs(false)
            .add_root_certificate(Certificate::from_der(&certificate).map_err(message)?)
            .https_only(true)
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(8))
            .build()
            .map_err(message)?;
        Ok(Self { client, invitation })
    }

    fn request(&self, action: &str, segments: Vec<String>, timeout: Duration) -> Result<Response> {
        let url = self.invitation.address.join(action).map_err(message)?;
        let response = self
            .client
            .post(url)
            .bearer_auth(&self.invitation.token)
            .timeout(timeout)
            .json(&RemotePath { segments })
            .send()
            .map_err(message)?;
        if !response.status().is_success() {
            return Err(format!(
                "Dirlume server returned HTTP {}.",
                response.status().as_u16()
            ));
        }
        Ok(response)
    }

    fn list(&self, segments: Vec<String>) -> Result<RemoteListing> {
        let response = self.request("v1/list", segments, Duration::from_secs(20))?;
        let mut bytes = Vec::new();
        const MAX_LISTING: u64 = 32 * 1024 * 1024;
        response
            .take(MAX_LISTING + 1)
            .read_to_end(&mut bytes)
            .map_err(message)?;
        if bytes.len() as u64 > MAX_LISTING {
            return Err("The server returned too many directory entries.".to_owned());
        }
        serde_json::from_slice(&bytes).map_err(message)
    }

    fn download_file(
        &self,
        segments: Vec<String>,
        file: &mut fs::File,
        mut progress: impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
    ) -> Result<()> {
        let name = PathBuf::from(segments.last().cloned().unwrap_or_default());
        let response = self.request("v1/download", segments, Duration::from_secs(60 * 60))?;
        let length = response.content_length();
        local::copy_stream(response, file, length, |bytes, total| {
            progress(&name, bytes, total)
        })
        .map_err(message)
    }

    fn download_tree(
        &self,
        segments: Vec<String>,
        target: &Path,
        progress: &mut impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
    ) -> Result<()> {
        if let Some(name) = segments.last() {
            progress(Path::new(name), 0, None).map_err(message)?;
        }
        let listing = self.list(segments.clone())?;
        if listing.omitted > 0 {
            return Err("The server could not list every item in this folder.".to_owned());
        }
        fs::create_dir(target).map_err(message)?;
        for item in listing.entries {
            if item.link {
                return Err(format!("Cannot download a linked item ({}).", item.name));
            }
            let destination = target.join(local::name_component(&item.name).map_err(message)?);
            let mut path = segments.clone();
            path.push(item.name);
            if item.directory {
                self.download_tree(path, &destination, progress)?;
            } else {
                let mut file = fs::File::create_new(destination).map_err(message)?;
                self.download_file(path, &mut file, &mut *progress)?;
                file.sync_all().map_err(message)?;
            }
        }
        Ok(())
    }
}

#[derive(Default)]
struct TransferSessions(Mutex<HashMap<u32, Arc<AtomicBool>>>);

#[tauri::command]
fn begin_transfer(id: u32, state: State<'_, TransferSessions>) -> Result<()> {
    state
        .0
        .lock()
        .map_err(message)?
        .insert(id, Arc::new(AtomicBool::new(false)));
    Ok(())
}

#[tauri::command]
fn cancel_transfer(id: u32, state: State<'_, TransferSessions>) -> Result<()> {
    if let Some(flag) = state.0.lock().map_err(message)?.get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
fn finish_transfer(id: u32, state: State<'_, TransferSessions>) -> Result<()> {
    state.0.lock().map_err(message)?.remove(&id);
    Ok(())
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum TransferSource {
    Local {
        directory: String,
        name: String,
    },
    Server {
        connection: u32,
        segments: Vec<String>,
        folder: bool,
    },
    Kswitcher {
        directory: String,
        peer: String,
        path: String,
        name: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ConflictPolicy {
    Ask,
    Skip,
    Overwrite,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferRequest {
    source: TransferSource,
    destination: String,
    multiple: bool,
    moving: bool,
    policy: ConflictPolicy,
    ask_read_only: bool,
    approved: Option<String>,
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum TransferOutcome {
    Completed,
    Skipped,
    Conflict {
        path: String,
        bytes: u64,
        read_only: bool,
        replaceable: bool,
        revision: String,
    },
}

#[derive(Clone, Serialize)]
struct TransferProgress {
    file: String,
    bytes: u64,
    total: Option<u64>,
}

fn transfer_target(
    destination: &str,
    name: &str,
    source: Option<&Path>,
    multiple: bool,
) -> io::Result<PathBuf> {
    let name = local::name_component(name)?;
    let path = Path::new(destination);
    let destination = if path.is_absolute() {
        path.to_owned()
    } else if let Some(source) = source.filter(|_| !multiple) {
        source
            .parent()
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Choose an absolute destination.",
                )
            })?
            .join(local::name_component(destination)?)
    } else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Choose an absolute destination folder.",
        ));
    };
    if destination.is_dir() {
        return Ok(destination.join(name));
    }
    if multiple
        || source.is_none()
        || destination
            .as_os_str()
            .to_string_lossy()
            .ends_with(std::path::is_separator)
    {
        return Err(io::Error::new(
            io::ErrorKind::NotADirectory,
            "The destination folder does not exist.",
        ));
    }
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Enter a valid destination name.",
            )
        })?;
    local::name_component(name)?;
    Ok(destination)
}

fn revision(metadata: &fs::Metadata) -> String {
    format!(
        "{:?}:{}:{}",
        metadata.modified().ok(),
        metadata.len(),
        metadata.permissions().readonly()
    )
}

#[tauri::command]
async fn transfer_item(
    id: u32,
    request: TransferRequest,
    output: Channel<TransferProgress>,
    sessions: State<'_, TransferSessions>,
    connections: State<'_, Connections>,
) -> Result<TransferOutcome> {
    let cancelled = sessions
        .0
        .lock()
        .map_err(message)?
        .get(&id)
        .cloned()
        .ok_or_else(|| "The transfer session has closed.".to_owned())?;
    let connection = match &request.source {
        TransferSource::Server { connection, .. } => Some(connections.get(*connection)?),
        _ => None,
    };
    blocking(move || {
        let (name, source) = match &request.source {
            TransferSource::Local { directory, name } => (
                name.as_str(),
                Some(selected(directory, name).map_err(message)?),
            ),
            TransferSource::Server { segments, .. } => (
                segments.last().ok_or("Choose a remote item.")?.as_str(),
                None,
            ),
            TransferSource::Kswitcher { name, .. } => (name.as_str(), None),
        };
        let target = transfer_target(
            &request.destination,
            name,
            source.as_deref(),
            request.multiple,
        )
        .map_err(message)?;
        let mut progress = |path: &Path, bytes, total| {
            if cancelled.load(Ordering::Relaxed) {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "Transfer canceled.",
                ));
            }
            let file = path
                .file_name()
                .unwrap_or(path.as_os_str())
                .to_string_lossy()
                .into_owned();
            let _ = output.send(TransferProgress { file, bytes, total });
            Ok(())
        };
        progress(Path::new(name), 0, None).map_err(message)?;

        let mut replace = None;
        match fs::symlink_metadata(&target) {
            Ok(metadata) => {
                if let Some(source) = &source {
                    if same_file::is_same_file(source, &target).unwrap_or(false) {
                        return Err("Source and destination are the same item.".into());
                    }
                }
                if matches!(request.policy, ConflictPolicy::Skip) {
                    return Ok(TransferOutcome::Skipped);
                }
                let read_only = metadata.permissions().readonly();
                let replaceable = metadata.is_file()
                    && !local::is_link(&metadata)
                    && source
                        .as_ref()
                        .and_then(|path| fs::symlink_metadata(path).ok())
                        .is_some_and(|metadata| metadata.is_file() && !local::is_link(&metadata));
                let current = revision(&metadata);
                let approved = request.approved.as_deref() == Some(&current);
                let overwrite = request.approved.is_none()
                    && matches!(request.policy, ConflictPolicy::Overwrite)
                    && (!read_only || !request.ask_read_only);
                if !replaceable || (!approved && !overwrite) {
                    return Ok(TransferOutcome::Conflict {
                        path: target.to_string_lossy().into_owned(),
                        bytes: metadata.len(),
                        read_only,
                        replaceable,
                        revision: current,
                    });
                }
                replace = Some(current);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(message(error)),
        }

        match request.source {
            TransferSource::Local { .. } => {
                let source = source.ok_or("Choose a local item.")?;
                if request.moving {
                    if replace.is_some() {
                        fs::rename(source, target).map_err(message)?;
                    } else {
                        local::move_item(&source, target).map_err(message)?;
                    }
                } else {
                    local::copy_to(&source, &target, replace.is_some(), |path, bytes, total| {
                        if total.is_none()
                            && path == source
                            && replace.is_some()
                            && fs::symlink_metadata(&target).ok().as_ref().map(revision) != replace
                        {
                            return Err(io::Error::new(
                                io::ErrorKind::AlreadyExists,
                                "The destination changed during the copy.",
                            ));
                        }
                        progress(path, bytes, total)
                    })
                    .map_err(message)?;
                }
            }
            TransferSource::Server {
                segments, folder, ..
            } => {
                let connection = connection.ok_or("Connect to the server first.")?;
                if folder {
                    let parent = target
                        .parent()
                        .ok_or("Choose a local destination folder.")?;
                    let workspace = tempfile::tempdir_in(parent).map_err(message)?;
                    let staged = workspace.path().join("download");
                    connection.download_tree(segments, &staged, &mut progress)?;
                    progress(&target, 0, None).map_err(message)?;
                    renamest::rename_exclusive(staged, target).map_err(message)?;
                } else {
                    download_to(&target, |file| {
                        connection.download_file(segments, file, &mut progress)
                    })?;
                }
            }
            TransferSource::Kswitcher {
                directory,
                peer,
                path,
                ..
            } => {
                kswitcher::download(&directory, &peer, &path, target)?;
            }
        }
        Ok(TransferOutcome::Completed)
    })
    .await
}

#[derive(Default)]
struct Connections {
    next: AtomicU32,
    connections: Mutex<HashMap<u32, std::sync::Arc<Connection>>>,
}

impl Connections {
    fn get(&self, id: u32) -> Result<std::sync::Arc<Connection>> {
        self.connections
            .lock()
            .map_err(message)?
            .get(&id)
            .cloned()
            .ok_or_else(|| "Connect to the Dirlume server first.".to_owned())
    }
}

#[derive(Serialize)]
struct Connected {
    id: u32,
    address: String,
    listing: RemoteListing,
}

#[tauri::command]
async fn connect_server(invitation: String, state: State<'_, Connections>) -> Result<Connected> {
    let (connection, listing) = blocking(move || {
        let connection = Connection::connect(&invitation)?;
        let listing = connection.list(Vec::new())?;
        Ok((connection, listing))
    })
    .await?;
    let id = state.next.fetch_add(1, Ordering::Relaxed);
    let address = connection
        .invitation
        .address
        .host_str()
        .unwrap_or_default()
        .to_owned();
    state
        .connections
        .lock()
        .map_err(message)?
        .insert(id, std::sync::Arc::new(connection));
    Ok(Connected {
        id,
        address,
        listing,
    })
}

#[tauri::command]
async fn list_server(
    id: u32,
    segments: Vec<String>,
    state: State<'_, Connections>,
) -> Result<RemoteListing> {
    let connection = state.get(id)?;
    blocking(move || connection.list(segments)).await
}

#[tauri::command]
async fn disconnect_server(id: u32, state: State<'_, Connections>) -> Result<()> {
    let connection = state.connections.lock().map_err(message)?.remove(&id);
    // reqwest's blocking client owns a runtime and must also be dropped outside an async context.
    blocking(move || {
        drop(connection);
        Ok(())
    })
    .await
}

fn download_to(path: &Path, write: impl FnOnce(&mut fs::File) -> Result<()>) -> Result<()> {
    local::ensure_absent(path).map_err(message)?;
    let directory = path
        .parent()
        .ok_or_else(|| "Choose a local destination folder.".to_owned())?;
    let mut staged = tempfile::NamedTempFile::new_in(directory).map_err(message)?;
    write(staged.as_file_mut())?;
    staged.as_file().sync_all().map_err(message)?;
    staged.persist_noclobber(path).map_err(message)?;
    Ok(())
}

const TEXT_LIMIT: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Encoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
}

#[derive(Deserialize, Serialize)]
struct TextDocument {
    text: String,
    encoding: Encoding,
}

fn load_text(path: &Path) -> Result<TextDocument> {
    let metadata = fs::symlink_metadata(path).map_err(message)?;
    if !metadata.is_file() || local::is_link(&metadata) {
        return Err("Choose a regular text file.".to_owned());
    }
    decode_text(fs::File::open(path).map_err(message)?)
}

fn decode_text(reader: impl Read) -> Result<TextDocument> {
    let mut bytes = Vec::new();
    reader
        .take(TEXT_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(message)?;
    if bytes.len() as u64 > TEXT_LIMIT {
        return Err("Text files can be at most 8 MiB.".to_owned());
    }
    let (text, encoding) = if let Some(bytes) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        (
            String::from_utf8(bytes.to_vec()).map_err(message)?,
            Encoding::Utf8Bom,
        )
    } else if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let little = bytes[0] == 0xff;
        let (chunks, remainder) = bytes[2..].as_chunks::<2>();
        if !remainder.is_empty() {
            return Err("The UTF-16 file ends with an incomplete character.".to_owned());
        }
        let words: Vec<_> = chunks
            .iter()
            .map(|&pair| {
                if little {
                    u16::from_le_bytes(pair)
                } else {
                    u16::from_be_bytes(pair)
                }
            })
            .collect();
        (
            String::from_utf16(&words).map_err(message)?,
            if little {
                Encoding::Utf16Le
            } else {
                Encoding::Utf16Be
            },
        )
    } else {
        (
            String::from_utf8(bytes).map_err(|_| {
                "The file is outside the supported UTF-8 and UTF-16 text formats.".to_owned()
            })?,
            Encoding::Utf8,
        )
    };
    if text.contains('\0') {
        return Err("The file contains binary data.".to_owned());
    }
    Ok(TextDocument { text, encoding })
}

#[tauri::command]
async fn read_text(directory: String, name: String) -> Result<TextDocument> {
    blocking(move || load_text(&selected(&directory, &name).map_err(message)?)).await
}

#[tauri::command]
async fn read_server_text(
    id: u32,
    segments: Vec<String>,
    state: State<'_, Connections>,
) -> Result<TextDocument> {
    let connection = state.get(id)?;
    blocking(move || {
        decode_text(connection.request("v1/download", segments, Duration::from_secs(45))?)
    })
    .await
}

#[tauri::command]
async fn save_text(directory: String, name: String, original: String, text: String) -> Result<()> {
    blocking(move || {
        let path = selected(&directory, &name).map_err(message)?;
        let document = load_text(&path)?;
        if document.text != original {
            return Err("The file changed on disk. Reopen it before saving.".to_owned());
        }
        let mut buffer = Vec::new();
        match document.encoding {
            Encoding::Utf8 => buffer.extend_from_slice(text.as_bytes()),
            Encoding::Utf8Bom => {
                buffer.extend_from_slice(&[0xef, 0xbb, 0xbf]);
                buffer.extend_from_slice(text.as_bytes());
            }
            Encoding::Utf16Be | Encoding::Utf16Le => {
                let little = matches!(document.encoding, Encoding::Utf16Le);
                buffer.extend_from_slice(if little { &[0xff, 0xfe] } else { &[0xfe, 0xff] });
                for word in text.encode_utf16() {
                    buffer.extend_from_slice(&if little {
                        word.to_le_bytes()
                    } else {
                        word.to_be_bytes()
                    });
                }
            }
        }
        if buffer.len() as u64 > TEXT_LIMIT {
            return Err("Text files can be at most 8 MiB.".to_owned());
        }
        let metadata = fs::metadata(&path).map_err(message)?;
        let mut staged =
            tempfile::NamedTempFile::new_in(local::absolute(&directory).map_err(message)?)
                .map_err(message)?;
        staged.write_all(&buffer).map_err(message)?;
        staged
            .as_file()
            .set_permissions(metadata.permissions())
            .map_err(message)?;
        staged.as_file().sync_all().map_err(message)?;
        staged.persist(path).map_err(message)?;
        Ok(())
    })
    .await
}

#[tauri::command]
async fn open_kswitcher(directory: String) -> Result<()> {
    blocking(move || kswitcher::launch(&directory)).await
}

#[tauri::command]
async fn has_kswitcher_bridge(directory: String) -> Result<bool> {
    blocking(move || kswitcher::available(&directory)).await
}

#[tauri::command]
async fn kswitcher_peers(directory: String) -> Result<Vec<kswitcher::Peer>> {
    blocking(move || kswitcher::peers(&directory)).await
}

#[tauri::command]
async fn list_kswitcher(
    directory: String,
    peer: String,
    path: String,
) -> Result<kswitcher::Listing> {
    blocking(move || kswitcher::list(&directory, &peer, &path)).await
}

pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(all(windows, feature = "ui-automation"))]
    let context = {
        let mut context = context;
        if let Some(port) = std::env::var("DIRLUME_CDP_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|port| *port > 0)
        {
            if let Some(window) = context
                .config_mut()
                .app
                .windows
                .iter_mut()
                .find(|window| window.label == "main")
            {
                let existing = window.additional_browser_args.take().unwrap_or_default();
                window.additional_browser_args = Some(format!(
                    "{existing} --remote-debugging-address=127.0.0.1 --remote-debugging-port={port}"
                ));
            }
        }
        context
    };
    tauri::Builder::default()
        .manage(Connections::default())
        .manage(TransferSessions::default())
        .manage(terminal::Terminals::default())
        .manage(watch::Watches::default())
        .manage(watch::Measurements::default())
        .invoke_handler(tauri::generate_handler![
            locations,
            list_directory,
            operate,
            connect_server,
            list_server,
            disconnect_server,
            read_text,
            read_server_text,
            save_text,
            open_kswitcher,
            has_kswitcher_bridge,
            kswitcher_peers,
            list_kswitcher,
            begin_transfer,
            cancel_transfer,
            finish_transfer,
            transfer_item,
            terminal::open_terminal,
            terminal::write_terminal,
            terminal::resize_terminal,
            terminal::close_terminal,
            watch::watch_directory,
            watch::unwatch_directory,
            watch::measure_folders,
            watch::cancel_measurement
        ])
        .run(context)
        .expect("cannot start Dirlume");
}
