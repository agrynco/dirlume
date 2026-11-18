use std::{
    collections::HashMap,
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, Ordering},
        Mutex,
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
use tauri::State;

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
    Copy { name: String, target: String },
    Move { name: String, target: String },
    Rename { name: String, new_name: String },
    CreateFolder { name: String },
    Recycle { name: String },
}

#[tauri::command]
async fn operate(directory: String, operation: Operation) -> Result<()> {
    blocking(move || {
        match operation {
            Operation::Open { name } => open::that(selected(&directory, &name).map_err(message)?),
            Operation::Copy { name, target } => local::copy_into(
                &selected(&directory, &name).map_err(message)?,
                local::absolute(&target).map_err(message)?,
            ),
            Operation::Move { name, target } => local::move_item(
                &selected(&directory, &name).map_err(message)?,
                selected(&target, &name).map_err(message)?,
            ),
            Operation::Rename { name, new_name } => local::move_item(
                &selected(&directory, &name).map_err(message)?,
                selected(&directory, &new_name).map_err(message)?,
            ),
            Operation::CreateFolder { name } => {
                fs::create_dir(selected(&directory, &name).map_err(message)?)
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

    fn download_file(&self, segments: Vec<String>, file: &mut fs::File) -> Result<()> {
        let mut response = self.request("v1/download", segments, Duration::from_secs(60 * 60))?;
        let length = response.content_length();
        let bytes = io::copy(&mut response, file).map_err(message)?;
        if length.is_some_and(|length| length != bytes) {
            return Err("The download was incomplete.".to_owned());
        }
        Ok(())
    }

    fn download_tree(&self, segments: Vec<String>, target: &Path) -> Result<()> {
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
                self.download_tree(path, &destination)?;
            } else {
                let mut file = fs::File::create_new(destination).map_err(message)?;
                self.download_file(path, &mut file)?;
                file.sync_all().map_err(message)?;
            }
        }
        Ok(())
    }
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

#[tauri::command]
async fn download_server(
    id: u32,
    segments: Vec<String>,
    target: String,
    directory: bool,
    state: State<'_, Connections>,
) -> Result<()> {
    let connection = state.get(id)?;
    blocking(move || {
        let name = segments
            .last()
            .ok_or_else(|| "Choose a file or folder to download.".to_owned())?;
        let path = selected(&target, name).map_err(message)?;
        if !directory {
            return download_to(&path, |file| connection.download_file(segments, file));
        }
        local::ensure_absent(&path).map_err(message)?;
        let workspace =
            tempfile::tempdir_in(local::absolute(&target).map_err(message)?).map_err(message)?;
        let staged = workspace.path().join("download");
        connection.download_tree(segments, &staged)?;
        renamest::rename_exclusive(staged, path).map_err(message)
    })
    .await
}

pub(crate) fn download_to(
    path: &Path,
    write: impl FnOnce(&mut fs::File) -> Result<()>,
) -> Result<()> {
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

#[tauri::command]
async fn download_kswitcher(
    directory: String,
    peer: String,
    path: String,
    name: String,
    target: String,
) -> Result<()> {
    blocking(move || {
        kswitcher::download(
            &directory,
            &peer,
            &path,
            selected(&target, &name).map_err(message)?,
        )
    })
    .await
}

pub fn run() {
    tauri::Builder::default()
        .manage(Connections::default())
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
            download_server,
            read_text,
            read_server_text,
            save_text,
            open_kswitcher,
            has_kswitcher_bridge,
            kswitcher_peers,
            list_kswitcher,
            download_kswitcher,
            terminal::open_terminal,
            terminal::write_terminal,
            terminal::resize_terminal,
            terminal::close_terminal,
            watch::watch_directory,
            watch::unwatch_directory,
            watch::measure_folders,
            watch::cancel_measurement
        ])
        .run(tauri::generate_context!())
        .expect("cannot start Dirlume");
}
