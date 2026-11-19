use std::{
    collections::HashMap,
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc, Arc, Mutex,
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
    diagnostics, ftp, ftp_transfer, kswitcher, local, local_transfer,
    protocol::{BytePage, ByteRequest, Invitation, RemoteListing, RemotePath},
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
        .map_err(|error| {
            if matches!(&error, tauri::Error::JoinError(join) if join.is_panic()) {
                diagnostics::PANIC_REJECTION.to_owned()
            } else {
                message(error)
            }
        })?
}

#[tauri::command]
fn build_version() -> &'static str {
    crate::BUILD_VERSION
}

#[tauri::command]
async fn locations() -> Result<Vec<local::Location>> {
    blocking(|| Ok(local::locations())).await
}

#[tauri::command]
fn requested_location() -> Option<String> {
    let encoded = std::env::args()
        .find_map(|argument| argument.strip_prefix("--open-folder=").map(str::to_owned))?;
    let path = String::from_utf8(URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()?;
    local::absolute(&path).ok()?;
    Some(path)
}

#[tauri::command]
async fn installed_fonts() -> Result<Vec<String>> {
    blocking(|| {
        let mut families = font_kit::source::SystemSource::new()
            .all_families()
            .map_err(message)?;
        families.retain(|name| !name.trim().is_empty());
        families.sort_by_cached_key(|name| name.to_lowercase());
        families.dedup();
        Ok(families)
    })
    .await
}

#[tauri::command]
async fn list_directory(path: String) -> Result<local::Listing> {
    blocking(move || local::list(local::absolute(&path).map_err(message)?).map_err(message)).await
}

fn selected(directory: &str, name: &str) -> io::Result<PathBuf> {
    Ok(local::absolute(directory)?.join(local::name_component(name)?))
}

#[tauri::command]
async fn file_attributes(
    directory: String,
    name: String,
) -> Result<crate::file_attributes::Attributes> {
    blocking(move || {
        let path = selected(&directory, &name).map_err(message)?;
        crate::file_attributes::read(&path).map_err(message)
    })
    .await
}

#[tauri::command]
async fn update_file_attributes(
    directory: String,
    name: String,
    changes: Vec<crate::file_attributes::Change>,
) -> Result<crate::file_attributes::Attributes> {
    blocking(move || {
        let path = selected(&directory, &name).map_err(message)?;
        crate::file_attributes::update(&path, &changes).map_err(message)
    })
    .await
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Operation {
    Open {
        name: String,
    },
    Rename {
        name: String,
        new_name: String,
    },
    CreateFolder {
        name: String,
    },
    CreateFile {
        name: String,
        #[serde(default)]
        encoding: Encoding,
    },
    Recycle {
        name: String,
    },
    Delete {
        name: String,
    },
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
            Operation::CreateFile { name, encoding } => {
                return create_encoded_file(
                    &selected(&directory, &name).map_err(message)?,
                    encoding,
                )
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

    fn request(
        &self,
        action: &str,
        payload: impl Serialize,
        timeout: Duration,
    ) -> Result<Response> {
        let url = self.invitation.address.join(action).map_err(message)?;
        let response = self
            .client
            .post(url)
            .bearer_auth(&self.invitation.token)
            .timeout(timeout)
            .json(&payload)
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
        let response = self.request("v1/list", RemotePath { segments }, Duration::from_secs(20))?;
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
        let response = self.request(
            "v1/download",
            RemotePath { segments },
            Duration::from_secs(60 * 60),
        )?;
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
struct TransferSessions(Mutex<HashMap<u32, Arc<TransferSession>>>);

#[derive(Default)]
struct TransferSession {
    cancelled: AtomicBool,
    pending: Mutex<Option<PendingConflict>>,
    remembered: Mutex<[Option<local_transfer::Decision>; 2]>,
}

struct PendingConflict {
    reply: mpsc::SyncSender<local_transfer::Decision>,
    remember_index: Option<usize>,
    replaceable: bool,
}

impl TransferSession {
    fn cancel(&self) -> Result<()> {
        self.cancelled.store(true, Ordering::Relaxed);
        self.pending.lock().map_err(message)?.take();
        Ok(())
    }

    fn ask(
        &self,
        conflict: local_transfer::Conflict,
        output: &Channel<TransferEvent>,
    ) -> io::Result<local_transfer::Decision> {
        let index = conflict
            .allow_remember
            .then_some(usize::from(conflict.directory));
        if let Some(index) = index {
            if let Some(decision) = self
                .remembered
                .lock()
                .map_err(|error| io::Error::other(message(error)))?[index]
            {
                return Ok(decision);
            }
        }
        let (reply, answer) = mpsc::sync_channel(1);
        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|error| io::Error::other(message(error)))?;
            if self.cancelled.load(Ordering::Relaxed) {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "Transfer canceled.",
                ));
            }
            *pending = Some(PendingConflict {
                reply,
                remember_index: index,
                replaceable: conflict.replaceable,
            });
        }
        if let Err(error) = output.send(TransferEvent::Conflict { conflict }) {
            let _ = self.cancel();
            return Err(io::Error::other(message(error)));
        }
        answer
            .recv()
            .map_err(|_| io::Error::new(io::ErrorKind::Interrupted, "Transfer canceled."))
    }

    fn answer(&self, decision: local_transfer::Decision, remember: bool) -> Result<()> {
        let pending = self
            .pending
            .lock()
            .map_err(message)?
            .take()
            .ok_or("There is no pending conflict.")?;
        if !pending.replaceable && matches!(decision, local_transfer::Decision::Overwrite) {
            return Err("The destination cannot be replaced.".to_owned());
        }
        if let Some(index) = pending.remember_index.filter(|_| remember) {
            self.remembered.lock().map_err(message)?[index] = Some(decision);
        }
        pending.reply.send(decision).map_err(message)
    }
}

impl TransferSessions {
    fn get(&self, id: u32) -> Result<Arc<TransferSession>> {
        self.0
            .lock()
            .map_err(message)?
            .get(&id)
            .cloned()
            .ok_or_else(|| "The transfer session has closed.".to_owned())
    }
}

#[tauri::command]
fn begin_transfer(id: u32, state: State<'_, TransferSessions>) -> Result<()> {
    state
        .0
        .lock()
        .map_err(message)?
        .insert(id, Arc::new(TransferSession::default()));
    Ok(())
}

#[tauri::command]
fn cancel_transfer(id: u32, state: State<'_, TransferSessions>) -> Result<()> {
    if let Ok(session) = state.get(id) {
        session.cancel()?;
    }
    Ok(())
}

#[tauri::command]
fn finish_transfer(id: u32, state: State<'_, TransferSessions>) -> Result<()> {
    if let Some(session) = state.0.lock().map_err(message)?.remove(&id) {
        session.cancel()?;
    }
    Ok(())
}

#[tauri::command]
fn resolve_transfer(
    id: u32,
    decision: local_transfer::Decision,
    remember: bool,
    state: State<'_, TransferSessions>,
) -> Result<()> {
    state.get(id)?.answer(decision, remember)
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
    Ftp {
        connection: u32,
        segments: Vec<String>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferRequest {
    source: TransferSource,
    destination: String,
    ftp_destination: Option<u32>,
    multiple: bool,
    moving: bool,
    policy: local_transfer::Policy,
    ask_read_only: bool,
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
}

fn transfer_outcome(completed: bool) -> TransferOutcome {
    if completed {
        TransferOutcome::Completed
    } else {
        TransferOutcome::Skipped
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum TransferEvent {
    Progress {
        file: String,
        bytes: u64,
        total: Option<u64>,
    },
    Conflict {
        conflict: local_transfer::Conflict,
    },
}

fn transfer_target(
    destination: &str,
    name: &str,
    source: Option<&Path>,
    multiple: bool,
    allow_rename: bool,
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
        || !allow_rename
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

#[tauri::command]
async fn transfer_item(
    id: u32,
    request: TransferRequest,
    output: Channel<TransferEvent>,
    sessions: State<'_, TransferSessions>,
    connections: State<'_, Connections>,
    ftp_state: State<'_, ftp::FtpState>,
) -> Result<TransferOutcome> {
    let session = sessions.get(id)?;
    let connection = match &request.source {
        TransferSource::Server { connection, .. } => Some(connections.get(*connection)?),
        _ => None,
    };
    let ftp_source = match &request.source {
        TransferSource::Ftp { connection, .. } => Some(ftp_state.connection(*connection)?),
        _ => None,
    };
    let ftp_destination = request
        .ftp_destination
        .map(|id| ftp_state.connection(id))
        .transpose()?;
    blocking(move || {
        let (name, source) = match &request.source {
            TransferSource::Local { directory, name } => (
                name.as_str(),
                Some(selected(directory, name).map_err(message)?),
            ),
            TransferSource::Server { segments, .. } | TransferSource::Ftp { segments, .. } => (
                segments.last().ok_or("Choose a remote item.")?.as_str(),
                None,
            ),
            TransferSource::Kswitcher { name, .. } => (name.as_str(), None),
        };
        let mut progress = |path: &Path, bytes, total| {
            if session.cancelled.load(Ordering::Relaxed) {
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
            let _ = output.send(TransferEvent::Progress { file, bytes, total });
            Ok(())
        };
        progress(Path::new(name), 0, None).map_err(message)?;

        let mut ask = |conflict| session.ask(conflict, &output);
        if let Some(ftp_destination) = ftp_destination {
            if request.moving
                || !matches!(
                    request.policy,
                    local_transfer::Policy::Ask
                        | local_transfer::Policy::Skip
                        | local_transfer::Policy::Overwrite
                )
            {
                return Err("Choose a supported FTP copy option.".to_owned());
            }
            let source = source
                .as_deref()
                .ok_or("Choose a local source for the FTP upload.")?;
            let mut ftp = ftp_destination.open()?;
            let target = ftp_transfer::upload_destination(
                &mut ftp,
                &request.destination,
                name,
                request.multiple,
            )?;
            let complete = ftp_transfer::upload(
                &mut ftp,
                source,
                &target,
                request.policy,
                &mut progress,
                &mut ask,
            )?;
            return Ok(transfer_outcome(complete));
        }
        let target = transfer_target(
            &request.destination,
            name,
            source.as_deref(),
            request.multiple,
            source.is_some() || ftp_source.is_some(),
        )
        .map_err(message)?;
        let options = local_transfer::Options {
            moving: request.moving,
            policy: request.policy,
            ask_read_only: request.ask_read_only,
        };
        if let TransferSource::Ftp { segments, .. } = &request.source {
            if request.moving {
                return Err("Use Copy to download FTP items.".to_owned());
            }
            let mut ftp = ftp_source
                .ok_or("Connect to the FTP server first.")?
                .open()?;
            return ftp_transfer::download(&mut ftp, segments, &target, &options, progress, ask)
                .map(transfer_outcome);
        }
        if let Some(source) = source {
            return local_transfer::transfer(&source, &target, &options, progress, ask)
                .map(transfer_outcome)
                .map_err(message);
        }

        match fs::symlink_metadata(&target) {
            Ok(metadata) => {
                if request.policy != local_transfer::Policy::Skip {
                    session
                        .ask(
                            local_transfer::Conflict::remote(&target, &metadata),
                            &output,
                        )
                        .map_err(message)?;
                }
                return Ok(TransferOutcome::Skipped);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(message(error)),
        }

        match request.source {
            TransferSource::Local { .. } | TransferSource::Ftp { .. } => {
                return Err("Choose a supported transfer source.".to_owned())
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

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Encoding {
    #[default]
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
}

#[derive(Deserialize, Serialize)]
struct TextDocument {
    text: String,
    encoding: Encoding,
    #[serde(skip_serializing_if = "Option::is_none")]
    revision: Option<String>,
}

fn open_regular_file(path: &Path) -> Result<fs::File> {
    let metadata = fs::symlink_metadata(path).map_err(message)?;
    if !metadata.is_file() || local::is_link(&metadata) {
        return Err("Choose a regular file.".to_owned());
    }
    fs::File::open(path).map_err(message)
}

fn load_text(path: &Path) -> Result<TextDocument> {
    decode_text(open_regular_file(path)?)
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
    Ok(TextDocument {
        text,
        encoding,
        revision: None,
    })
}

#[tauri::command]
async fn read_text(directory: String, name: String) -> Result<TextDocument> {
    blocking(move || load_text(&selected(&directory, &name).map_err(message)?)).await
}

#[derive(Serialize)]
struct TextLink {
    directory: String,
    name: String,
}

#[tauri::command]
async fn resolve_text_link(directory: String, destination: String) -> Result<TextLink> {
    blocking(move || {
        let path = local::absolute(&directory)
            .map_err(message)?
            .join(destination);
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Link to a file.")?;
        local::name_component(name).map_err(message)?;
        let parent = path.parent().ok_or("Link to a file.")?;
        let parent = fs::canonicalize(parent).map_err(message)?;
        open_regular_file(&parent.join(name))?;
        Ok(TextLink {
            directory: local::display_path(&parent).map_err(message)?,
            name: name.to_owned(),
        })
    })
    .await
}

#[tauri::command]
async fn open_web_link(href: String) -> Result<()> {
    let url = url::Url::parse(&href).map_err(message)?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Only HTTP and HTTPS links can be opened in a browser.".to_owned());
    }
    blocking(move || open::that(url.as_str()).map_err(message)).await
}

#[tauri::command]
async fn read_server_text(
    id: u32,
    segments: Vec<String>,
    state: State<'_, Connections>,
) -> Result<TextDocument> {
    let connection = state.get(id)?;
    blocking(move || {
        decode_text(connection.request(
            "v1/download",
            RemotePath { segments },
            Duration::from_secs(45),
        )?)
    })
    .await
}

#[tauri::command]
async fn read_bytes(directory: String, name: String, offset: u64) -> Result<BytePage> {
    blocking(move || {
        let path = selected(&directory, &name).map_err(message)?;
        local::read_byte_page(open_regular_file(&path)?, offset).map_err(message)
    })
    .await
}

#[tauri::command]
async fn read_server_bytes(
    id: u32,
    segments: Vec<String>,
    offset: u64,
    state: State<'_, Connections>,
) -> Result<BytePage> {
    let connection = state.get(id)?;
    blocking(move || {
        let response = connection.request(
            "v1/bytes",
            ByteRequest { segments, offset },
            Duration::from_secs(20),
        )?;
        let max_response = crate::protocol::BYTE_PAGE_SIZE * 4 + 128;
        serde_json::from_reader(response.take(max_response)).map_err(message)
    })
    .await
}

fn encode_text(encoding: Encoding, text: &str) -> Result<Vec<u8>> {
    let mut buffer = Vec::new();
    match encoding {
        Encoding::Utf8 => buffer.extend_from_slice(text.as_bytes()),
        Encoding::Utf8Bom => {
            buffer.extend_from_slice(&[0xef, 0xbb, 0xbf]);
            buffer.extend_from_slice(text.as_bytes());
        }
        Encoding::Utf16Be | Encoding::Utf16Le => {
            let little = matches!(encoding, Encoding::Utf16Le);
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
    Ok(buffer)
}

fn create_encoded_file(path: &Path, encoding: Encoding) -> Result<()> {
    let bytes = encode_text(encoding, "")?;
    if bytes.is_empty() {
        return fs::File::create_new(path).map(drop).map_err(message);
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Choose a parent folder.".to_owned())?;
    let mut builder = tempfile::Builder::new();
    builder.prefix(".dirlume-text-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(fs::Permissions::from_mode(0o666));
    }
    let mut file = builder.tempfile_in(parent).map_err(message)?;
    file.write_all(&bytes).map_err(message)?;
    // Publish the initialized file only after writing the BOM, without replacing an existing file.
    file.persist_noclobber(path)
        .map(drop)
        .map_err(|error| message(error.error))
}

fn ftp_text_revision(entry: &suppaftp::list::File, bytes: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, bytes);
    format!("{:?}:{}", entry.modified(), URL_SAFE_NO_PAD.encode(digest))
}

fn load_ftp_text(session: &mut ftp::Session, segments: &[String]) -> Result<TextDocument> {
    let before = session.regular(segments)?;
    let length = before.size() as u64;
    if length > TEXT_LIMIT {
        return Err("Text files can be at most 8 MiB.".to_owned());
    }
    let bytes = session.read_limited(segments, 0, length, length)?;
    if session.regular(segments)? != before {
        return Err("The FTP file changed while it was being opened.".to_owned());
    }
    let revision = ftp_text_revision(&before, &bytes);
    let mut document = decode_text(bytes.as_slice())?;
    document.revision = Some(revision);
    Ok(document)
}

#[tauri::command]
async fn read_ftp_text(
    id: u32,
    segments: Vec<String>,
    state: State<'_, ftp::FtpState>,
) -> Result<TextDocument> {
    let connection = state.connection(id)?;
    blocking(move || load_ftp_text(&mut connection.open()?, &segments)).await
}

#[tauri::command]
async fn read_ftp_bytes(
    id: u32,
    segments: Vec<String>,
    offset: u64,
    state: State<'_, ftp::FtpState>,
) -> Result<BytePage> {
    let connection = state.connection(id)?;
    blocking(move || {
        let mut session = connection.open()?;
        let length = session.regular(&segments)?.size() as u64;
        let data =
            session.read_limited(&segments, offset, crate::protocol::BYTE_PAGE_SIZE, length)?;
        Ok(BytePage { length, data })
    })
    .await
}

#[tauri::command]
async fn save_ftp_text(
    id: u32,
    segments: Vec<String>,
    revision: String,
    text: String,
    state: State<'_, ftp::FtpState>,
) -> Result<TextDocument> {
    let connection = state.connection(id)?;
    blocking(move || {
        let mut session = connection.open()?;
        let document = load_ftp_text(&mut session, &segments)?;
        if document.revision.as_deref() != Some(revision.as_str()) {
            return Err("The FTP file changed on the server. Reopen it before saving.".to_owned());
        }
        let buffer = encode_text(document.encoding, &text)?;
        let staged = session.upload_to_stage(&segments, &mut buffer.as_slice(), |_| Ok(()))?;
        let result = (|| {
            if load_ftp_text(&mut session, &segments)?.revision != document.revision {
                return Err(
                    "The FTP file changed on the server. Reopen it before saving.".to_owned(),
                );
            }
            session.rename_stage(&staged, &segments)
        })();
        if let Err(error) = result {
            session.remove_stage(&staged);
            return Err(error);
        }
        let revision = session
            .regular(&segments)
            .ok()
            .map(|entry| ftp_text_revision(&entry, &buffer));
        Ok(TextDocument {
            text,
            encoding: document.encoding,
            revision,
        })
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
        let buffer = encode_text(document.encoding, &text)?;
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
    let _ = rustls::crypto::ring::default_provider().install_default();
    #[cfg(windows)]
    if requested_location().is_some() {
        if let Some(base) = dirs::data_local_dir() {
            std::env::set_var(
                "WEBVIEW2_USER_DATA_FOLDER",
                base.join("io.github.agrynco.dirlume")
                    .join("AdministratorWebView"),
            );
        }
    }
    let context = tauri::generate_context!();
    diagnostics::setup(&context.config().identifier);
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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(crate::updates::PendingUpdate::default())
        .manage(Connections::default())
        .manage(ftp::FtpState::default())
        .manage(TransferSessions::default())
        .manage(terminal::Terminals::default())
        .manage(watch::Watches::default())
        .manage(watch::Measurements::default())
        .manage(crate::processes::ProcessMonitor::default())
        .manage(crate::file_clipboard::FileClipboard::default());
    #[cfg(windows)]
    let builder = builder.manage(crate::windows_shell::ShellIcons::default());
    #[cfg(feature = "ui-automation")]
    let builder = builder.on_page_load(crate::updates::fixture::page_loaded);
    let dispatch: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        diagnostics::report_diagnostic,
        build_version,
        crate::updates::check_for_update,
        crate::updates::install_update,
        #[cfg(feature = "ui-automation")]
        crate::updates::fixture::updater_fixture_result,
        locations,
        requested_location,
        crate::processes::list_processes,
        #[cfg(windows)]
        crate::processes::process_icons,
        crate::processes::terminate_processes,
        crate::file_clipboard::copy_file_references,
        crate::file_clipboard::clipboard_files,
        #[cfg(windows)]
        crate::windows_shell::windows_item_menu,
        #[cfg(windows)]
        crate::windows_shell::open_elevated,
        #[cfg(windows)]
        crate::windows_shell::locking_processes,
        #[cfg(windows)]
        crate::windows_shell::file_icons,
        installed_fonts,
        list_directory,
        file_attributes,
        update_file_attributes,
        operate,
        connect_server,
        list_server,
        disconnect_server,
        ftp::ftp_profiles,
        ftp::ftp_windows_code_page,
        ftp::save_ftp_profile,
        ftp::remove_ftp_profile,
        ftp::connect_ftp,
        ftp::disconnect_ftp,
        ftp::list_ftp,
        ftp::rename_ftp,
        ftp::delete_ftp,
        read_ftp_text,
        read_ftp_bytes,
        save_ftp_text,
        read_text,
        resolve_text_link,
        open_web_link,
        read_server_text,
        read_bytes,
        read_server_bytes,
        save_text,
        open_kswitcher,
        has_kswitcher_bridge,
        kswitcher_peers,
        list_kswitcher,
        begin_transfer,
        cancel_transfer,
        finish_transfer,
        resolve_transfer,
        transfer_item,
        terminal::open_terminal,
        terminal::write_terminal,
        terminal::resize_terminal,
        terminal::close_terminal,
        watch::watch_directory,
        watch::unwatch_directory,
        watch::measure_folders,
        watch::cancel_measurement
    ];
    builder
        .invoke_handler(move |invoke| {
            diagnostics::remember_command(&invoke.message);
            dispatch(invoke)
        })
        .run(context)
        .expect("cannot start Dirlume");
}
