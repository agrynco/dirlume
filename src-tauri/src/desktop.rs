use std::{
    collections::HashMap,
    fs,
    future::Future,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{redirect::Policy, Certificate, Client, Response};
use serde::{Deserialize, Serialize};
use tauri::{
    ipc::Channel, Emitter, Manager, State, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;
use tokio_util::sync::CancellationToken;

use crate::{
    diagnostics::{self, ReadCause, ReadReason, ReadStage, ReadSurface},
    ftp, local, local_transfer,
    protocol::{BytePage, ByteRequest, Invitation, RemoteListing, RemotePath},
    remote_transfer, ssh, terminal, watch,
};

pub(crate) use crate::{message, Result};

#[derive(Deserialize, Serialize)]
struct DiagramWindowData {
    image: String,
    width: Option<f64>,
    height: Option<f64>,
    scale: f64,
}

#[tauri::command]
async fn open_tool_window(
    main: WebviewWindow,
    title: String,
    width: Option<f64>,
    height: Option<f64>,
    comparison: Option<serde_json::Value>,
    initial_page: Option<String>,
    diagram: Option<DiagramWindowData>,
) -> Result<()> {
    if main.label() != "main" {
        return Err("Open this window from the main Dirlume window.".into());
    }
    let app = main.app_handle();
    static NEXT_WINDOW: AtomicU32 = AtomicU32::new(1);
    let label = match (&comparison, &diagram) {
        (Some(_), _) => format!("compare-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed)),
        (_, Some(_)) => format!("diagram-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed)),
        _ => "options".to_owned(),
    };
    if let Some(window) = app.get_webview_window(&label) {
        if let Some(page) = initial_page {
            app.emit_to(label.as_str(), "dirlume:options-page", page)
                .map_err(message)?;
        }
        window.unminimize().map_err(message)?;
        window.show().map_err(message)?;
        return window.set_focus().map_err(message);
    }

    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .ok_or("The main window configuration is missing.")?;
    config.label = label;
    config.title = title;
    config.min_width = Some(600.0);
    config.min_height = Some(380.0);
    let (max_width, max_height) = main
        .current_monitor()
        .map_err(message)?
        .map(|monitor| {
            let area = monitor
                .work_area()
                .size
                .to_logical::<f64>(monitor.scale_factor());
            (
                (area.width - 32.0).max(600.0),
                (area.height - 48.0).max(380.0),
            )
        })
        .unwrap_or((1400.0, 960.0));
    config.width = width
        .filter(|value| value.is_finite())
        .unwrap_or(1040.0)
        .clamp(600.0, max_width);
    config.height = height
        .filter(|value| value.is_finite())
        .unwrap_or(670.0)
        .clamp(380.0, max_height);
    config.center = true;
    config.decorations = true;
    config.resizable = true;
    config.maximizable = true;
    config.minimizable = true;
    config.closable = true;
    let mut builder = WebviewWindowBuilder::from_config(app, &config).map_err(message)?;
    let wait_for_close = comparison.is_some() || diagram.is_some();
    if let Some(comparison) = comparison {
        builder = builder
            .parent(&main)
            .map_err(message)?
            .initialization_script(format!("window.__dirlumeComparison = {comparison};"));
    } else if let Some(diagram) = diagram {
        let diagram = serde_json::to_string(&diagram).map_err(message)?;
        builder = builder.initialization_script(format!("window.__dirlumeDiagram = {diagram};"));
    } else if let Some(page) = initial_page {
        let page = serde_json::to_string(&page).map_err(message)?;
        builder = builder.initialization_script(format!("window.__dirlumeOptionsPage = {page};"));
    }
    let window = builder.build().map_err(message)?;
    if wait_for_close {
        let (closed, receiver) = tokio::sync::oneshot::channel();
        let closed = Mutex::new(Some(closed));
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) {
                if let Some(sender) = closed.lock().ok().and_then(|mut sender| sender.take()) {
                    let _ = sender.send(());
                }
            }
        });
        if app.get_webview_window(window.label()).is_some() {
            let _ = receiver.await;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn set_appearance_picker(window: WebviewWindow, picking: bool) -> Result<()> {
    let app = window.app_handle();
    if picking && window.label() != "options"
        || !picking && window.label() != "main" && !window.label().starts_with("compare-")
    {
        return Err("The appearance picker cannot switch from this window.".into());
    }
    let options = app
        .get_webview_window("options")
        .ok_or("Options is no longer open.")?;
    if !picking {
        options.show().map_err(message)?;
        return options.set_focus().map_err(message);
    }
    let main = app
        .get_webview_window("main")
        .ok_or("The main window is no longer open.")?;
    main.unminimize().map_err(message)?;
    options.hide().map_err(message)?;
    if let Err(error) = main.show().and_then(|_| main.set_focus()) {
        let _ = options.show();
        let _ = options.set_focus();
        return Err(message(error));
    }
    Ok(())
}

pub(crate) async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    blocking_worker(None, task).await
}

pub(crate) async fn blocking_for<T: Send + 'static>(
    command: &'static str,
    task: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    blocking_worker(Some(command), task).await
}

async fn blocking_worker<T: Send + 'static>(
    command: Option<&'static str>,
    task: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(move || {
        diagnostics::worker(command, task).map_err(message)?
    })
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

const SETTINGS_ARCHIVE_LIMIT: u64 = 4 * 1024 * 1024;

fn read_settings_archive_file(path: &Path) -> Result<String> {
    if !fs::metadata(path).map_err(message)?.is_file() {
        return Err("The settings file is invalid.".to_owned());
    }
    let file = fs::File::open(path).map_err(message)?;
    let mut bytes = Vec::new();
    file.take(SETTINGS_ARCHIVE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(message)?;
    if bytes.len() as u64 > SETTINGS_ARCHIVE_LIMIT {
        return Err("The settings file is too large.".to_owned());
    }
    String::from_utf8(bytes).map_err(|_| "The settings file is invalid.".to_owned())
}

fn write_settings_archive_file(path: &Path, contents: &str) -> Result<()> {
    if contents.len() as u64 > SETTINGS_ARCHIVE_LIMIT {
        return Err("The settings file is too large.".to_owned());
    }
    let directory = path.parent().ok_or("Choose a parent folder.")?;
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(message)?;
    file.write_all(contents.as_bytes()).map_err(message)?;
    file.as_file().sync_all().map_err(message)?;
    file.persist(path).map_err(message)?;
    Ok(())
}

#[tauri::command]
async fn read_settings_archive(window: tauri::Window, title: String) -> Result<Option<String>> {
    blocking(move || {
        let dialog = window.dialog().file();
        #[cfg(any(windows, target_os = "macos"))]
        let dialog = dialog.set_parent(&window);
        let Some(path) = dialog
            .set_title(title)
            .add_filter("JSON", &["json"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = path.into_path().map_err(message)?;
        read_settings_archive_file(&path).map(Some)
    })
    .await
}

#[tauri::command]
async fn write_settings_archive(
    window: tauri::Window,
    title: String,
    contents: String,
) -> Result<bool> {
    blocking(move || {
        let Some(path) = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title(title)
            .set_file_name("dirlume-settings.json")
            .add_filter("JSON", &["json"])
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = path.into_path().map_err(message)?;
        write_settings_archive_file(&path, &contents)?;
        Ok(true)
    })
    .await
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
async fn computer_name() -> Option<String> {
    if let Some(name) = std::env::var("COMPUTERNAME")
        .ok()
        .filter(|name| !name.trim().is_empty())
    {
        return Some(name);
    }
    blocking(|| {
        let output = std::process::Command::new("hostname")
            .output()
            .map_err(message)?;
        Ok(output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
            .filter(|name| !name.is_empty()))
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn list_directory(path: String) -> Result<local::Listing> {
    blocking_for("list_directory", move || {
        local::list(local::absolute(&path).map_err(message)?).map_err(message)
    })
    .await
}

#[tauri::command]
async fn disk_space(path: String) -> Result<crate::disk_space::DiskSpace> {
    blocking(move || {
        crate::disk_space::query(local::absolute(&path).map_err(message)?).map_err(message)
    })
    .await
}

pub(crate) fn selected(directory: &str, name: &str) -> io::Result<PathBuf> {
    Ok(local::absolute(directory)?.join(local::name_component(name)?))
}

#[derive(serde::Deserialize)]
struct PanelMetadataRequest {
    directory: String,
    name: String,
    owner: bool,
    links: bool,
    #[serde(default, rename = "sortFields")]
    sort_fields: Vec<crate::file_attributes::SortField>,
}

#[tauri::command]
async fn stream_sort_supported(directory: String) -> Result<bool> {
    blocking(move || {
        let directory = local::absolute(&directory).map_err(message)?;
        Ok(crate::file_attributes::stream_sort_supported(directory))
    })
    .await
}

#[tauri::command]
async fn panel_metadata(
    items: Vec<PanelMetadataRequest>,
) -> Result<Vec<crate::file_attributes::PanelMetadata>> {
    blocking(move || {
        if items.len() > 64 {
            return Err("Too many file metadata requests.".into());
        }
        Ok(items
            .into_iter()
            .map(|item| {
                selected(&item.directory, &item.name).map_or_else(
                    |_| crate::file_attributes::PanelMetadata::default(),
                    |path| {
                        crate::file_attributes::PanelMetadata::read(
                            &path,
                            item.owner,
                            item.links,
                            &item.sort_fields,
                        )
                    },
                )
            })
            .collect())
    })
    .await
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
    OpenDirectory,
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
            Operation::OpenDirectory => {
                let path = local::absolute(&directory).map_err(message)?;
                if !fs::metadata(path).map_err(message)?.is_dir() {
                    return Err("The selected path is not a directory.".to_owned());
                }
                open::that(path)
            }
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

#[cfg(test)]
mod file_open_tests {
    use super::*;

    #[tokio::test]
    async fn local_open_hands_unicode_path_to_the_default_application() {
        if std::env::var("DIRLUME_VERIFY_FILE_OPEN").as_deref() != Ok("1") {
            return;
        }
        let fixture = tempfile::tempdir().unwrap();
        let directory = fixture.path().join("Open request fixture");
        fs::create_dir(&directory).unwrap();
        let name = "Звіт дня.txt";
        fs::write(directory.join(name), "Dirlume file open fixture\n").unwrap();
        operate(
            directory.to_str().unwrap().to_owned(),
            Operation::Open {
                name: name.to_owned(),
            },
        )
        .await
        .unwrap();
    }
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

    async fn request(
        &self,
        action: &str,
        payload: impl Serialize,
        timeout: Duration,
    ) -> Result<Response> {
        self.request_with_timeout(action, payload, Some(timeout))
            .await
    }

    async fn request_with_timeout(
        &self,
        action: &str,
        payload: impl Serialize,
        timeout: Option<Duration>,
    ) -> Result<Response> {
        let url = self.invitation.address.join(action).map_err(message)?;
        let mut request = self
            .client
            .post(url)
            .bearer_auth(&self.invitation.token)
            .json(&payload);
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        let response = request.send().await.map_err(message)?;
        if !response.status().is_success() {
            return Err(format!(
                "Dirlume server returned HTTP {}.",
                response.status().as_u16()
            ));
        }
        Ok(response)
    }

    async fn list(&self, segments: Vec<String>) -> Result<RemoteListing> {
        let mut request = crate::protocol::ListRequest {
            path: RemotePath { segments },
            paged: true,
            after: None,
        };
        let mut result = RemoteListing {
            entries: Vec::new(),
            omitted: 0,
        };
        loop {
            let response = self
                .request("v1/list", &request, Duration::from_secs(20))
                .await?;
            const MAX_LISTING: usize = 32 * 1024 * 1024;
            let bytes = collect_response(response, MAX_LISTING + 1).await?;
            if bytes.len() > MAX_LISTING {
                return Err("The server returned too many directory entries.".to_owned());
            }
            let page: crate::protocol::ListPage =
                serde_json::from_slice(&bytes).map_err(message)?;
            let paged = page.next.is_some() || request.after.is_some();
            if paged
                && page
                    .listing
                    .entries
                    .windows(2)
                    .any(|pair| pair[0].name >= pair[1].name)
                || page.next.as_ref().is_some_and(|next| {
                    next.is_empty() || request.after.as_ref().is_some_and(|after| next <= after)
                })
                || page.listing.entries.iter().any(|entry| {
                    request
                        .after
                        .as_ref()
                        .is_some_and(|after| entry.name <= *after)
                        || page.next.as_ref().is_some_and(|next| entry.name > *next)
                })
            {
                return Err("The server returned an invalid directory page.".to_owned());
            }
            result.omitted = result
                .omitted
                .checked_add(page.listing.omitted)
                .ok_or("Invalid directory entry count.")?;
            result.entries.extend(page.listing.entries);
            request.after = page.next;
            if request.after.is_none() {
                return Ok(result);
            }
        }
    }

    fn download_file(
        &self,
        segments: Vec<String>,
        file: &mut fs::File,
        session: &TransferSession,
        mut progress: impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
    ) -> Result<()> {
        let name = PathBuf::from(segments.last().cloned().unwrap_or_default());
        tauri::async_runtime::block_on(session.interrupt(async {
            let mut response = self
                .request(
                    "v1/download",
                    RemotePath { segments },
                    Duration::from_secs(60 * 60),
                )
                .await?;
            let length = response.content_length();
            let mut written = 0;
            let mut last_display = Instant::now();
            progress(&name, 0, length).map_err(message)?;
            while let Some(chunk) = response.chunk().await.map_err(message)? {
                session.ensure_running().map_err(message)?;
                file.write_all(&chunk).map_err(message)?;
                written += chunk.len() as u64;
                if last_display.elapsed() >= Duration::from_millis(50) {
                    progress(&name, written, length).map_err(message)?;
                    last_display = Instant::now();
                }
            }
            if length.is_some_and(|expected| expected != written) {
                return Err("The source changed or the transfer was incomplete.".to_owned());
            }
            progress(&name, written, length).map_err(message)
        }))
    }

    fn download_tree(
        &self,
        segments: Vec<String>,
        target: &Path,
        session: &TransferSession,
        progress: &mut impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
    ) -> Result<()> {
        if let Some(name) = segments.last() {
            progress(Path::new(name), 0, None).map_err(message)?;
        }
        let listing =
            tauri::async_runtime::block_on(session.interrupt(self.list(segments.clone())))?;
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
                self.download_tree(path, &destination, session, progress)?;
            } else {
                let mut file = fs::File::create_new(destination).map_err(message)?;
                self.download_file(path, &mut file, session, &mut *progress)?;
                file.sync_all().map_err(message)?;
            }
        }
        Ok(())
    }
}

async fn collect_response(mut response: Response, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    while bytes.len() < limit {
        let Some(chunk) = response.chunk().await.map_err(message)? else {
            break;
        };
        bytes.extend_from_slice(&chunk[..chunk.len().min(limit - bytes.len())]);
    }
    Ok(bytes)
}

#[derive(Default)]
struct TransferSessions(Mutex<HashMap<u32, Arc<TransferSession>>>);

#[derive(Default)]
struct TransferSession {
    cancelled: CancellationToken,
    pending: Mutex<Option<PendingConflict>>,
    remembered: Mutex<[Option<local_transfer::Decision>; 2]>,
    local: Mutex<LocalTransferAttempt>,
    ssh_move: Mutex<Option<SshMoveAttempt>>,
    history: Option<crate::file_history::Tracker>,
}

struct SshMoveAttempt {
    source: PathBuf,
    original: local_transfer::FileRevision,
    target: Vec<String>,
    connection: u32,
    destination: String,
}

#[derive(Default)]
struct LocalTransferAttempt {
    destination: Option<PathBuf>,
    resume: local_transfer::MoveResume,
}

struct PendingConflict {
    reply: mpsc::SyncSender<local_transfer::Decision>,
    remember_index: Option<usize>,
    replaceable: bool,
}

impl TransferSession {
    fn ensure_running(&self) -> io::Result<()> {
        if self.cancelled.is_cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "Transfer canceled.",
            ));
        }
        Ok(())
    }

    async fn interrupt<T>(&self, operation: impl Future<Output = Result<T>>) -> Result<T> {
        self.cancelled
            .run_until_cancelled(operation)
            .await
            .unwrap_or_else(|| Err("Transfer canceled.".to_owned()))
    }

    fn cancel(&self) -> Result<()> {
        self.cancelled.cancel();
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
            .then_some(usize::from(conflict.confirm_read_only));
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
            self.ensure_running()?;
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
        if !pending.replaceable && !matches!(decision, local_transfer::Decision::Skip) {
            return Err("The destination cannot be replaced.".to_owned());
        }
        if matches!(decision, local_transfer::Decision::OverwriteAll) {
            self.remembered
                .lock()
                .map_err(message)?
                .fill(Some(local_transfer::Decision::Overwrite));
        } else if let Some(index) = pending.remember_index.filter(|_| remember) {
            self.remembered.lock().map_err(message)?[index] = Some(decision);
        }
        pending.reply.send(decision).map_err(message)
    }
}

#[cfg(test)]
mod transfer_conflict_tests {
    use super::*;
    use local_transfer::Decision;

    #[test]
    fn read_only_choices_are_independent_until_overwrite_all() {
        fn reply(session: &TransferSession, index: usize, decision: Decision, remember: bool) {
            let (reply, answer) = mpsc::sync_channel(1);
            *session.pending.lock().unwrap() = Some(PendingConflict {
                reply,
                remember_index: Some(index),
                replaceable: true,
            });
            session.answer(decision, remember).unwrap();
            answer.recv().unwrap();
        }

        let transfer = TransferSession::default();
        reply(&transfer, 0, Decision::Overwrite, true);
        assert!(matches!(
            *transfer.remembered.lock().unwrap(),
            [Some(Decision::Overwrite), None]
        ));
        reply(&transfer, 1, Decision::Skip, false);
        assert!(transfer.remembered.lock().unwrap()[1].is_none());
        reply(&transfer, 1, Decision::Skip, true);
        assert!(matches!(
            *transfer.remembered.lock().unwrap(),
            [Some(Decision::Overwrite), Some(Decision::Skip)]
        ));
        reply(&transfer, 1, Decision::OverwriteAll, false);
        assert!(matches!(
            *transfer.remembered.lock().unwrap(),
            [Some(Decision::Overwrite), Some(Decision::Overwrite)]
        ));
        assert!(TransferSession::default()
            .remembered
            .lock()
            .unwrap()
            .iter()
            .all(Option::is_none));
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
fn begin_transfer(
    id: u32,
    history: Option<crate::file_history::OperationStart>,
    file_history: State<'_, crate::file_history::History>,
    state: State<'_, TransferSessions>,
) -> Result<()> {
    let history = history
        .map(|start| file_history.begin(id, start))
        .transpose()?;
    state.0.lock().map_err(message)?.insert(
        id,
        Arc::new(TransferSession {
            history,
            ..Default::default()
        }),
    );
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
        if let Some(tracker) = &session.history {
            tracker.finish(session.cancelled.is_cancelled());
        }
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
        peer: String,
        path: String,
        name: String,
    },
    Ftp {
        connection: u32,
        segments: Vec<String>,
    },
    Archive {
        archive: u32,
        segments: Vec<String>,
    },
    Ssh {
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
    ssh_destination: Option<u32>,
    multiple: bool,
    moving: bool,
    policy: local_transfer::Policy,
    ask_read_only: bool,
    #[serde(default)]
    retry: bool,
    #[serde(default)]
    copy_options: local::CopyOptions,
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
    SourceRetained {
        destination: String,
        source: String,
        error: String,
    },
}

#[derive(Deserialize)]
struct ArchiveCopySource {
    directory: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ArchiveChange {
    Folder { parent: Vec<String>, name: String },
    Rename { segments: Vec<String>, name: String },
}

#[tauri::command]
async fn change_archive(
    id: u32,
    archive: u32,
    change: ArchiveChange,
    output: Channel<u8>,
    sessions: State<'_, TransferSessions>,
    archives: State<'_, crate::archives::Archives>,
) -> Result<()> {
    let session = sessions.get(id)?;
    let archive = archives.get(archive)?;
    blocking(move || {
        let progress = |percent| {
            session.ensure_running()?;
            let _ = output.send(percent);
            Ok(())
        };
        let mut archive = archive.lock().map_err(message)?;
        match change {
            ArchiveChange::Folder { parent, name } => {
                archive.create_folder(&parent, &name, progress)
            }
            ArchiveChange::Rename { segments, name } => {
                archive.rename_entry(&segments, &name, progress)
            }
        }
    })
    .await
}

#[tauri::command]
#[expect(
    clippy::too_many_arguments,
    reason = "Tauri injects transfer and archive state"
)]
async fn copy_into_archive(
    id: u32,
    archive: u32,
    segments: Vec<String>,
    sources: Vec<ArchiveCopySource>,
    policy: local_transfer::Policy,
    output: Channel<TransferEvent>,
    sessions: State<'_, TransferSessions>,
    archives: State<'_, crate::archives::Archives>,
) -> Result<Vec<bool>> {
    let session = sessions.get(id)?;
    let archive = archives.get(archive)?;
    blocking(move || {
        let sources = sources
            .into_iter()
            .map(|source| {
                Ok((
                    selected(&source.directory, &source.name).map_err(message)?,
                    source.name,
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        let progress = |path: &Path, bytes, total| {
            session.ensure_running()?;
            report_transfer_progress(&output, path, bytes, total);
            Ok(())
        };
        let ask = |conflict| session.ask(conflict, &output);
        let result = archive
            .lock()
            .map_err(message)?
            .copy_into(&segments, &sources, policy, progress, ask);
        if let Some(tracker) = &session.history {
            for (index, (path, name)) in sources.iter().enumerate() {
                let written = result
                    .as_ref()
                    .ok()
                    .and_then(|items| items.get(index))
                    .copied();
                let mut target = segments.clone();
                target.push(name.clone());
                tracker.record(
                    crate::file_history::HistoryRow {
                        source: crate::file_history::display(path),
                        destination: target.join("/"),
                        outcome: match written {
                            Some(true) => "completed",
                            Some(false) => "skipped",
                            None => "failed",
                        },
                        error: result.as_ref().err().cloned(),
                    },
                    Vec::new(),
                    written == Some(true),
                );
            }
        }
        result
    })
    .await
}

fn report_transfer_progress(
    output: &Channel<TransferEvent>,
    path: &Path,
    bytes: u64,
    total: Option<u64>,
) {
    let file = path
        .file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned();
    let _ = output.send(TransferEvent::Progress {
        file,
        path: path.to_string_lossy().into_owned(),
        bytes,
        total,
    });
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
        path: String,
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

fn upload_remote<S: remote_transfer::UploadSession>(
    mut remote: S,
    request: &TransferRequest,
    name: &str,
    source: &Path,
    progress: &mut impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
    ask: &mut impl FnMut(local_transfer::Conflict) -> io::Result<local_transfer::Decision>,
    committed: &mut impl FnMut(&Path, &Path),
) -> Result<TransferOutcome> {
    let target = remote_transfer::upload_destination(
        &mut remote,
        &request.destination,
        name,
        request.multiple,
    )?;
    remote_transfer::upload(
        &mut remote,
        source,
        &target,
        request.policy,
        progress,
        ask,
        committed,
    )
    .map(transfer_outcome)
}

fn move_to_ssh(
    remote: &mut ssh::Session,
    request: &TransferRequest,
    source: &Path,
    target_name: &str,
    session: &TransferSession,
    progress: &mut impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
    ask: &mut impl FnMut(local_transfer::Conflict) -> io::Result<local_transfer::Decision>,
) -> Result<TransferOutcome> {
    let connection = request
        .ssh_destination
        .ok_or("Choose an SSH destination.")?;
    let mut attempt = session.ssh_move.lock().map_err(message)?;
    if !request.retry {
        *attempt = None;
    }
    let retry_cleanup = attempt.is_some();
    if let Some(previous) = &*attempt {
        if previous.source != source
            || previous.connection != connection
            || previous.destination != request.destination
        {
            return Err("The transfer no longer matches the completed SSH upload.".to_owned());
        }
    } else {
        let metadata = fs::symlink_metadata(source).map_err(message)?;
        if !metadata.is_file() || local::is_link(&metadata) {
            return Err("Choose regular local files to move to an SSH/SFTP folder.".to_owned());
        }
        let original = local_transfer::FileRevision::capture(source, &metadata).map_err(message)?;
        let target = remote_transfer::upload_destination(
            remote,
            &request.destination,
            target_name,
            request.multiple,
        )?;
        if !remote_transfer::upload(
            remote,
            source,
            &target,
            request.policy,
            progress,
            ask,
            &mut |_, _| {},
        )? {
            return Ok(TransferOutcome::Skipped);
        }
        *attempt = Some(SshMoveAttempt {
            source: source.to_owned(),
            original,
            target,
            connection,
            destination: request.destination.clone(),
        });
    }
    let completed = attempt.as_ref().expect("successful SSH upload");
    let result = (|| {
        if retry_cleanup {
            session.ensure_running().map_err(message)?;
            completed.original.verify(source).map_err(message)?;
            let mut input = fs::File::open(source).map_err(message)?;
            remote.verify_uploaded_contents(&completed.target, &mut input, || {
                session.ensure_running().map_err(message)
            })?;
            session.ensure_running().map_err(message)?;
        }
        // Once the remote upload commits, finish this item before moving on.
        local_transfer::remove_original(source, &completed.original).map_err(message)
    })();
    if let Err(error) = result {
        return Ok(TransferOutcome::SourceRetained {
            destination: format!("/{}", completed.target.join("/")),
            source: local::display_path(source).unwrap_or_else(|_| source.display().to_string()),
            error,
        });
    }
    *attempt = None;
    Ok(TransferOutcome::Completed)
}

#[cfg(test)]
pub(crate) fn verify_ssh_moves(remote: &mut ssh::Session, local_root: &Path, remote_root: &Path) {
    use local_transfer::{FileRevision, Policy};
    type Progress<'a> = dyn FnMut(&Path, u64, Option<u64>) -> io::Result<()> + 'a;
    let session = TransferSession::default();
    let mut request = TransferRequest {
        source: TransferSource::Local {
            directory: local::display_path(local_root).unwrap(),
            name: "move-source.txt".to_owned(),
        },
        destination: "/".to_owned(),
        ftp_destination: None,
        ssh_destination: Some(12),
        multiple: false,
        moving: true,
        policy: Policy::Ask,
        ask_read_only: false,
        retry: false,
        copy_options: Default::default(),
    };
    let mut ask = |_| panic!("Unexpected transfer decision.");
    let source = local_root.join("move-source.txt");
    let target = remote_root.join("move-source.txt");
    let run = |remote: &mut ssh::Session,
               request: &TransferRequest,
               progress: &mut Progress<'_>,
               ask: &mut _| {
        move_to_ssh(
            remote,
            request,
            &source,
            "move-source.txt",
            &session,
            &mut |path, bytes, total| progress(path, bytes, total),
            ask,
        )
    };
    fs::write(&source, b"local source").unwrap();
    assert!(matches!(
        run(remote, &request, &mut |_, _, _| Ok(()), &mut ask),
        Ok(TransferOutcome::Completed)
    ));
    assert!(!source.exists());
    assert_eq!(fs::read(&target).unwrap(), b"local source");

    fs::write(&source, b"another file").unwrap();
    request.policy = Policy::Skip;
    assert!(matches!(
        run(remote, &request, &mut |_, _, _| Ok(()), &mut ask),
        Ok(TransferOutcome::Skipped)
    ));
    assert_eq!(fs::read(&source).unwrap(), b"another file");
    assert_eq!(fs::read(&target).unwrap(), b"local source");

    request.policy = Policy::Ask;
    fs::remove_file(&target).unwrap();
    assert!(run(
        remote,
        &request,
        &mut |_, bytes, _| {
            if bytes == 0 {
                Ok(())
            } else {
                Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "Transfer canceled.",
                ))
            }
        },
        &mut ask
    )
    .is_err());
    assert!(!target.exists());
    assert_eq!(fs::read(&source).unwrap(), b"another file");

    request.retry = true;
    let record_attempt = || {
        *session.ssh_move.lock().unwrap() = Some(SshMoveAttempt {
            source: source.clone(),
            original: FileRevision::capture(&source, &fs::symlink_metadata(&source).unwrap())
                .unwrap(),
            target: vec!["move-source.txt".to_owned()],
            connection: 12,
            destination: "/".to_owned(),
        })
    };
    record_attempt();
    fs::write(&target, b"external edit").unwrap();
    assert!(matches!(
        run(remote, &request, &mut |_, _, _| Ok(()), &mut ask),
        Ok(TransferOutcome::SourceRetained { destination, error, .. })
          if destination == "/move-source.txt" && error.contains("SSH file changed")
    ));
    assert_eq!(fs::read(&target).unwrap(), b"external edit");
    assert_eq!(fs::read(&source).unwrap(), b"another file");
    fs::write(&target, b"another file").unwrap();
    assert!(matches!(
        run(remote, &request, &mut |_, _, _| Ok(()), &mut ask),
        Ok(TransferOutcome::Completed)
    ));
    assert!(!source.exists());
    assert_eq!(fs::read(&target).unwrap(), b"another file");
    fs::write(&source, b"another file").unwrap();
    record_attempt();
    fs::write(&source, b"new local contents").unwrap();
    assert!(matches!(
        run(remote, &request, &mut |_, _, _| Ok(()), &mut ask),
        Ok(TransferOutcome::SourceRetained { .. })
    ));
    assert_eq!(fs::read(&source).unwrap(), b"new local contents");
    assert_eq!(fs::read(&target).unwrap(), b"another file");
}

#[tauri::command]
#[expect(
    clippy::too_many_arguments,
    reason = "Tauri injects the independently managed transfer sources"
)]
async fn transfer_item(
    id: u32,
    request: TransferRequest,
    output: Channel<TransferEvent>,
    sessions: State<'_, TransferSessions>,
    connections: State<'_, Connections>,
    ftp_state: State<'_, ftp::FtpState>,
    archives: State<'_, crate::archives::Archives>,
    ssh_state: State<'_, ssh::SshState>,
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
    let archive = match &request.source {
        TransferSource::Archive { archive, .. } => Some(archives.get(*archive)?),
        _ => None,
    };
    let ssh_source = match &request.source {
        TransferSource::Ssh { connection, .. } => Some(ssh_state.connection(*connection)?),
        _ => None,
    };
    let ftp_destination = request
        .ftp_destination
        .map(|id| ftp_state.connection(id))
        .transpose()?;
    let ssh_destination = request
        .ssh_destination
        .map(|id| ssh_state.connection(id))
        .transpose()?;
    if ftp_destination.is_some() && ssh_destination.is_some() {
        return Err("Choose a single remote connection for the copy.".to_owned());
    }
    blocking(move || {
        use crate::file_history::{display, HistoryRow};
        let mut actual_source = match &request.source {
            TransferSource::Local { directory, name } => display(&Path::new(directory).join(name)),
            TransferSource::Server { segments, .. }
            | TransferSource::Ftp { segments, .. }
            | TransferSource::Ssh { segments, .. }
            | TransferSource::Archive { segments, .. } => format!("/{}", segments.join("/")),
            TransferSource::Kswitcher { path, .. } => path.clone(),
        };
        let mut actual_destination = request.destination.clone();
        let mut commits = Vec::new();
        let mut local_recorded = false;
        let result = (|| {
            let mut committed = |source: &Path, destination: &Path| {
                if session.history.is_some() {
                    commits.push(crate::file_history::Commit::new(source, destination, None));
                }
            };
            let (name, source) = match &request.source {
                TransferSource::Local { directory, name } => (
                    name.as_str(),
                    Some(selected(directory, name).map_err(message)?),
                ),
                TransferSource::Server { segments, .. }
                | TransferSource::Ftp { segments, .. }
                | TransferSource::Ssh { segments, .. }
                | TransferSource::Archive { segments, .. } => (
                    segments.last().ok_or("Choose a remote item.")?.as_str(),
                    None,
                ),
                TransferSource::Kswitcher { name, .. } => (name.as_str(), None),
            };
            let mut progress = |path: &Path, bytes, total| {
                session.ensure_running()?;
                report_transfer_progress(&output, path, bytes, total);
                Ok(())
            };
            progress(Path::new(name), 0, None).map_err(message)?;

            let mut ask = |conflict| session.ask(conflict, &output);
            if ftp_destination.is_some() || ssh_destination.is_some() {
                let protocol = if ssh_destination.is_some() {
                    "SSH"
                } else {
                    "FTP"
                };
                if (request.moving && ftp_destination.is_some())
                    || !matches!(
                        request.policy,
                        local_transfer::Policy::Ask
                            | local_transfer::Policy::Skip
                            | local_transfer::Policy::Overwrite
                    )
                {
                    return Err(format!("Choose a supported {protocol} copy option."));
                }
                let source = source
                    .as_deref()
                    .ok_or_else(|| format!("Choose a local source for the {protocol} upload."))?;
                if let Some(connection) = ssh_destination {
                    if request.moving {
                        return move_to_ssh(
                            &mut connection.open_with_cancel(Some(session.cancelled.clone()))?,
                            &request,
                            source,
                            name,
                            &session,
                            &mut progress,
                            &mut ask,
                        );
                    }
                    return upload_remote(
                        connection.open_with_cancel(Some(session.cancelled.clone()))?,
                        &request,
                        name,
                        source,
                        &mut progress,
                        &mut ask,
                        &mut committed,
                    );
                }
                if let Some(connection) = ftp_destination {
                    return upload_remote(
                        connection.open_with_cancel(Some(session.cancelled.clone()))?,
                        &request,
                        name,
                        source,
                        &mut progress,
                        &mut ask,
                        &mut committed,
                    );
                }
            }
            let mut local = source
                .as_ref()
                .map(|_| session.local.lock())
                .transpose()
                .map_err(message)?;
            if let Some(local) = local.as_mut().filter(|_| !request.retry) {
                **local = LocalTransferAttempt::default();
            }
            let target = match local.as_ref().and_then(|local| local.destination.clone()) {
                Some(path) => path,
                None => transfer_target(
                    &request.destination,
                    name,
                    source.as_deref(),
                    request.multiple,
                    source.is_some()
                        || ftp_source.is_some()
                        || ssh_source.is_some()
                        || archive.is_some(),
                )
                .map_err(message)?,
            };
            actual_destination = display(&target);
            let options = local_transfer::Options {
                moving: request.moving,
                policy: request.policy,
                ask_read_only: request.ask_read_only,
                copy: if request.moving || source.is_none() {
                    local::CopyOptions::default()
                } else {
                    request.copy_options
                },
            };
            if let TransferSource::Archive { segments, .. } = &request.source {
                if request.moving {
                    return Err("Use Copy to extract an archive item.".to_owned());
                }
                let archive = archive.ok_or("Open the archive first.")?;
                return archive
                    .lock()
                    .map_err(message)?
                    .copy_to(segments, &target, &options, progress, ask, committed)
                    .map(transfer_outcome);
            }
            if let TransferSource::Ftp { segments, .. } = &request.source {
                if request.moving {
                    return Err("Use Copy to download FTP items.".to_owned());
                }
                let mut ftp = ftp_source
                    .ok_or("Connect to the FTP server first.")?
                    .open_with_cancel(Some(session.cancelled.clone()))?;
                return remote_transfer::download(
                    &mut ftp, segments, &target, &options, progress, ask, committed,
                )
                .map(transfer_outcome);
            }
            if let Some(connection) = ssh_source {
                if request.moving {
                    return Err("Use Copy to download SSH items.".to_owned());
                }
                if let TransferSource::Ssh { segments, .. } = &request.source {
                    return remote_transfer::download(
                        &mut connection.open_with_cancel(Some(session.cancelled.clone()))?,
                        segments,
                        &target,
                        &options,
                        progress,
                        ask,
                        committed,
                    )
                    .map(transfer_outcome);
                }
            }
            if let (Some(source), Some(mut local)) = (source, local) {
                actual_source = display(&source);
                local.destination = Some(target.clone());
                local.resume.history = session.history.as_ref().map(|_| Vec::new());
                let result = local_transfer::transfer(
                    &source,
                    &target,
                    &options,
                    &mut local.resume,
                    progress,
                    ask,
                )
                .map(transfer_outcome)
                .map_err(message);
                commits = local.resume.history.take().unwrap_or_default();
                local_recorded = true;
                return result;
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
                TransferSource::Local { .. }
                | TransferSource::Ftp { .. }
                | TransferSource::Ssh { .. }
                | TransferSource::Archive { .. } => {
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
                        connection.download_tree(segments, &staged, &session, &mut progress)?;
                        progress(&target, 0, None).map_err(message)?;
                        renamest::rename_exclusive(staged, target).map_err(message)?;
                    } else {
                        download_to(&target, &session, |file| {
                            connection.download_file(segments, file, &session, &mut progress)
                        })?;
                    }
                }
                TransferSource::Kswitcher { peer, path, .. } => {
                    download_to(&target, &session, |file| {
                        tokio::runtime::Handle::current().block_on(crate::kswitcher_lan::download(
                            &peer,
                            &path,
                            file,
                            |bytes, total| progress(&target, bytes, total),
                        ))
                    })?;
                }
            }
            Ok(TransferOutcome::Completed)
        })();
        if let Some(tracker) = &session.history {
            let (outcome, error, known_change) = match &result {
                Ok(TransferOutcome::Completed) => ("completed", None, true),
                Ok(TransferOutcome::Skipped) => ("skipped", None, false),
                Ok(TransferOutcome::SourceRetained {
                    error,
                    destination,
                    source,
                }) => {
                    actual_source = source.clone();
                    actual_destination = destination.clone();
                    ("failed", Some(error.clone()), true)
                }
                Err(error) => ("failed", Some(error.clone()), false),
            };
            tracker.record(
                HistoryRow {
                    source: actual_source,
                    destination: actual_destination,
                    outcome,
                    error,
                },
                commits,
                known_change && !local_recorded,
            );
        }
        result
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
    origin: String,
    share: String,
    listing: RemoteListing,
}

fn server_invitation_entry(credential: uuid::Uuid) -> Result<keyring::Entry> {
    keyring::Entry::new("Dirlume Server", &credential.to_string()).map_err(message)
}

#[tauri::command]
async fn save_server_invitation(invitation: String) -> Result<uuid::Uuid> {
    blocking(move || {
        let invitation = zeroize::Zeroizing::new(invitation);
        crate::protocol::Invitation::parse(&invitation)?;
        let credential = uuid::Uuid::new_v4();
        server_invitation_entry(credential)?
            .set_password(invitation.trim())
            .map_err(|_| "Could not save the invitation in the system credential store.")?;
        Ok(credential)
    })
    .await
}

#[tauri::command]
async fn remove_server_invitation(credential: uuid::Uuid) -> Result<()> {
    blocking(
        move || match server_invitation_entry(credential)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => {
                Err("Could not remove the invitation from the system credential store.".to_owned())
            }
        },
    )
    .await
}

async fn read_server_invitation(credential: uuid::Uuid) -> Result<zeroize::Zeroizing<String>> {
    blocking(move || {
        server_invitation_entry(credential)?
            .get_password()
            .map(zeroize::Zeroizing::new)
            .map_err(|_| "Could not read the saved invitation. Edit the connection to replace its invitation.".to_owned())
    })
    .await
}

#[tauri::command]
async fn list_saved_computer_drives(
    credential: uuid::Uuid,
) -> Result<Vec<crate::server::ComputerDrive>> {
    let invitation = read_server_invitation(credential).await?;
    let connection = Connection::connect(&invitation)?;
    computer_drive_metadata(&connection).await
}

#[tauri::command]
async fn list_connected_computer_drives(
    id: u32,
    state: State<'_, Connections>,
) -> Result<Vec<crate::server::ComputerDrive>> {
    let connection = state.get(id)?;
    computer_drive_metadata(&connection).await
}

async fn computer_drive_metadata(
    connection: &Connection,
) -> Result<Vec<crate::server::ComputerDrive>> {
    let response = connection
        .request("v1/drives", (), Duration::from_secs(5))
        .await?;
    serde_json::from_slice(&collect_response(response, 1024 * 1024).await?).map_err(message)
}

#[tauri::command]
async fn verify_computer_pairing(invitation: String) -> Result<()> {
    let invitation = zeroize::Zeroizing::new(invitation);
    let connection = Connection::connect(&invitation)?;
    connection
        .request("v1/drives", (), Duration::from_secs(5))
        .await?;
    Ok(())
}

#[tauri::command]
async fn connect_saved_server(
    credential: uuid::Uuid,
    segments: Option<Vec<String>>,
    state: State<'_, Connections>,
) -> Result<Connected> {
    let invitation = read_server_invitation(credential).await?;
    open_server(&invitation, segments.unwrap_or_default(), &state).await
}

#[tauri::command]
async fn connect_server(invitation: String, state: State<'_, Connections>) -> Result<Connected> {
    open_server(&invitation, Vec::new(), &state).await
}

async fn open_server(
    invitation: &str,
    segments: Vec<String>,
    state: &Connections,
) -> Result<Connected> {
    let connection = Connection::connect(invitation)?;
    let listing = connection.list(segments).await?;
    let id = state.next.fetch_add(1, Ordering::Relaxed);
    let address = connection
        .invitation
        .address
        .host_str()
        .unwrap_or_default()
        .to_owned();
    let origin = connection.invitation.address.origin().ascii_serialization();
    let identity = format!(
        "{}\n{}",
        connection.invitation.address, connection.invitation.certificate
    );
    let digest = ring::digest::digest(&ring::digest::SHA256, identity.as_bytes());
    let share = URL_SAFE_NO_PAD.encode(digest.as_ref());
    state
        .connections
        .lock()
        .map_err(message)?
        .insert(id, std::sync::Arc::new(connection));
    Ok(Connected {
        id,
        address,
        origin,
        share,
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
    connection.list(segments).await
}

#[tauri::command]
async fn disconnect_server(id: u32, state: State<'_, Connections>) -> Result<()> {
    state.connections.lock().map_err(message)?.remove(&id);
    Ok(())
}

fn download_to(
    path: &Path,
    session: &TransferSession,
    write: impl FnOnce(&mut fs::File) -> Result<()>,
) -> Result<()> {
    local::ensure_absent(path).map_err(message)?;
    let directory = path
        .parent()
        .ok_or_else(|| "Choose a local destination folder.".to_owned())?;
    let mut staged = tempfile::NamedTempFile::new_in(directory).map_err(message)?;
    write(staged.as_file_mut())?;
    staged.as_file().sync_all().map_err(message)?;
    session.ensure_running().map_err(message)?;
    staged.persist_noclobber(path).map_err(message)?;
    Ok(())
}

#[cfg(test)]
mod server_download_tests {
    use super::*;
    use std::{net::TcpListener, thread};

    #[tokio::test]
    async fn desktop_computer_share_lists_and_opens_separate_drive_roots() {
        let fixture = tempfile::tempdir().unwrap();
        let first = fixture.path().join("first");
        let second = fixture.path().join("second");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        fs::write(first.join("first.txt"), "first drive").unwrap();
        fs::write(second.join("second.txt"), "second drive").unwrap();
        let roots = vec![("C:".into(), first), ("D:".into(), second)];
        let ip = "127.0.0.1".parse().unwrap();
        let mut host = crate::server::DesktopServer::start_computer(roots, ip)
            .await
            .unwrap();
        let guest = Connection::connect(&host.invitation).unwrap();
        let response = guest
            .request("v1/drives", (), Duration::from_secs(5))
            .await
            .unwrap();
        let drives: serde_json::Value =
            serde_json::from_slice(&collect_response(response, 4096).await.unwrap()).unwrap();
        assert_eq!(drives[0]["name"], "C:");
        assert!(drives[0]["total"].as_u64().is_some_and(|total| total > 0));
        let devices = guest.list(Vec::new()).await.unwrap().entries;
        assert_eq!(
            devices
                .iter()
                .map(|drive| drive.name.as_str())
                .collect::<Vec<_>>(),
            ["C:", "D:"]
        );
        assert!(devices.iter().all(|drive| drive.directory));
        for (drive, expected) in [("C:", "first.txt"), ("D:", "second.txt")] {
            let entries = guest.list(vec![drive.into()]).await.unwrap().entries;
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].name, expected);
        }
        assert!(guest.list(vec!["E:".into()]).await.is_err());
        assert!(guest.list(vec!["C:".into(), "..".into()]).await.is_err());
        host.stop().await.unwrap();
    }

    #[tokio::test]
    async fn desktop_share_accepts_pinned_tls_and_revokes_access_on_stop() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("shared folder ł");
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("nested/file.txt"), "test file").unwrap();
        fs::write(fixture.path().join("outside.txt"), "outside").unwrap();
        let ip = "127.0.0.1".parse().unwrap();
        let mut host = crate::server::DesktopServer::start(&root, ip)
            .await
            .unwrap();
        let guest = Connection::connect(&host.invitation).unwrap();
        let entries = guest.list(Vec::new()).await.unwrap().entries;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "nested");
        let path = RemotePath {
            segments: vec!["nested".into(), "file.txt".into()],
        };
        let response = guest
            .request("v1/download", &path, Duration::from_secs(3))
            .await
            .unwrap();
        assert_eq!(response.bytes().await.unwrap().as_ref(), b"test file");
        let parent = RemotePath {
            segments: vec!["..".into(), "outside.txt".into()],
        };
        assert!(guest
            .request("v1/download", &parent, Duration::from_secs(3))
            .await
            .is_err());
        assert!(guest
            .request("v1/write", &path, Duration::from_secs(3))
            .await
            .is_err());
        let mut wrong_token = Invitation::parse(&host.invitation).unwrap();
        wrong_token.token = URL_SAFE_NO_PAD.encode([0; 32]);
        let unauthorized = Connection::connect(&wrong_token.encode().unwrap()).unwrap();
        assert!(matches!(unauthorized.list(Vec::new()).await, Err(error) if error.contains("401")));
        host.stop().await.unwrap();
        assert!(guest
            .request("v1/download", &path, Duration::from_secs(3))
            .await
            .is_err());
        let restarted = crate::server::DesktopServer::start(&root, ip)
            .await
            .unwrap();
        let new_invitation = Invitation::parse(&restarted.invitation).unwrap();
        assert_ne!(new_invitation.token, guest.invitation.token);
        assert_ne!(new_invitation.certificate, guest.invitation.certificate);
    }

    #[test]
    fn cancel_interrupts_stalled_server_headers_and_body_without_publishing() {
        for send_headers in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = format!("http://{}/", listener.local_addr().unwrap());
            let (started, stalled) = mpsc::sync_channel(1);
            let (release, released) = mpsc::channel::<()>();
            let (received_headers, response) = mpsc::sync_channel(1);
            let (received_chunk, partial) = mpsc::sync_channel(1);
            let peer = thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = [0; 1024];
                assert_ne!(socket.read(&mut request).unwrap(), 0);
                if send_headers {
                    socket
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 128\r\n\r\n")
                        .unwrap();
                    response.recv_timeout(Duration::from_secs(5)).unwrap();
                    // Send the partial body after the progress reporting interval.
                    thread::sleep(Duration::from_millis(75));
                    socket.write_all(b"partial").unwrap();
                }
                started.send(()).unwrap();
                released.recv_timeout(Duration::from_secs(10)).ok();
            });
            let temp = tempfile::tempdir().unwrap();
            let destination = temp.path().join("download.bin");
            let (result, done) = mpsc::sync_channel(1);
            let session = Arc::new(TransferSession::default());
            let transfer = thread::spawn({
                let destination = destination.clone();
                let session = Arc::clone(&session);
                move || {
                    let connection = Connection {
                        client: Client::builder().no_proxy().build().unwrap(),
                        invitation: Invitation {
                            address: address.parse().unwrap(),
                            certificate: String::new(),
                            token: String::new(),
                        },
                    };
                    let downloaded = download_to(&destination, &session, |file| {
                        connection.download_file(
                            vec!["download.bin".to_owned()],
                            file,
                            &session,
                            |_, bytes, _| {
                                if bytes == 0 {
                                    let _ = received_headers.try_send(());
                                } else {
                                    let _ = received_chunk.try_send(bytes);
                                }
                                Ok(())
                            },
                        )
                    });
                    result.send(downloaded).unwrap();
                }
            });
            stalled.recv_timeout(Duration::from_secs(5)).unwrap();
            if send_headers {
                assert_eq!(partial.recv_timeout(Duration::from_secs(5)).unwrap(), 7);
            }
            session.cancel().unwrap();
            let cancelled = done.recv_timeout(Duration::from_secs(2));
            drop(release);
            peer.join().unwrap();
            assert_eq!(cancelled.unwrap().unwrap_err(), "Transfer canceled.");
            transfer.join().unwrap();
            assert!(!destination.exists());
            assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
        }
    }
}

pub(crate) const TEXT_LIMIT: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Encoding {
    #[default]
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct TextDocument {
    pub(crate) text: String,
    pub(crate) encoding: Encoding,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) revision: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TextReadFailure {
    message: String,
    read_cause: ReadCause,
}

impl TextReadFailure {
    fn new(stage: ReadStage, reason: ReadReason, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            read_cause: ReadCause {
                stage,
                reason,
                os_code: None,
            },
        }
    }

    fn io(stage: ReadStage, error: io::Error) -> Self {
        let os_code = error.raw_os_error();
        let reason = if cfg!(windows) && matches!(os_code, Some(32 | 33)) {
            ReadReason::SharingViolation
        } else {
            match error.kind() {
                io::ErrorKind::NotFound => ReadReason::MissingFile,
                io::ErrorKind::PermissionDenied => ReadReason::AccessDenied,
                _ => ReadReason::Io,
            }
        };
        Self {
            message: message(error),
            read_cause: ReadCause {
                stage,
                reason,
                os_code,
            },
        }
    }
}

fn read_regular_file(path: &Path) -> std::result::Result<fs::File, TextReadFailure> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| TextReadFailure::io(ReadStage::Open, error))?;
    if !metadata.is_file() || local::is_link(&metadata) {
        return Err(TextReadFailure::new(
            ReadStage::Open,
            ReadReason::NonRegularFile,
            "Choose a regular file.",
        ));
    }
    fs::File::open(path).map_err(|error| TextReadFailure::io(ReadStage::Open, error))
}

pub(crate) fn open_regular_file(path: &Path) -> Result<fs::File> {
    read_regular_file(path).map_err(|error| error.message)
}

fn load_text(path: &Path) -> Result<TextDocument> {
    decode_text(open_regular_file(path)?)
}

pub(crate) fn decode_text(reader: impl Read) -> Result<TextDocument> {
    decode_local_text(reader).map_err(|error| error.message)
}

fn decode_local_text(reader: impl Read) -> std::result::Result<TextDocument, TextReadFailure> {
    let unsupported = |message: String| {
        TextReadFailure::new(ReadStage::Decode, ReadReason::UnsupportedEncoding, message)
    };
    let mut bytes = Vec::new();
    reader
        .take(TEXT_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| TextReadFailure::io(ReadStage::Read, error))?;
    if bytes.len() as u64 > TEXT_LIMIT {
        return Err(TextReadFailure::new(
            ReadStage::Read,
            ReadReason::SizeLimit,
            "Text files can be at most 8 MiB.",
        ));
    }
    let (text, encoding) = if let Some(bytes) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        (
            String::from_utf8(bytes.to_vec()).map_err(|error| unsupported(message(error)))?,
            Encoding::Utf8Bom,
        )
    } else if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let little = bytes[0] == 0xff;
        let (chunks, remainder) = bytes[2..].as_chunks::<2>();
        if !remainder.is_empty() {
            return Err(unsupported(
                "The UTF-16 file ends with an incomplete character.".to_owned(),
            ));
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
            String::from_utf16(&words).map_err(|error| unsupported(message(error)))?,
            if little {
                Encoding::Utf16Le
            } else {
                Encoding::Utf16Be
            },
        )
    } else {
        (
            String::from_utf8(bytes).map_err(|_| {
                unsupported(
                    "The file is outside the supported UTF-8 and UTF-16 text formats.".to_owned(),
                )
            })?,
            Encoding::Utf8,
        )
    };
    if text.contains('\0') {
        return Err(TextReadFailure::new(
            ReadStage::Decode,
            ReadReason::BinaryContent,
            "The file contains binary data.",
        ));
    }
    Ok(TextDocument {
        text,
        encoding,
        revision: None,
    })
}

#[derive(Serialize)]
#[serde(untagged)]
enum LocalTextRead {
    Text(TextDocument),
    Binary { page: BytePage },
}

fn byte_page_looks_binary(data: &[u8]) -> bool {
    !data.starts_with(&[0xff, 0xfe])
        && !data.starts_with(&[0xfe, 0xff])
        && (data.contains(&0)
            || std::str::from_utf8(data).is_err_and(|error| error.error_len().is_some()))
}

fn finish_local_text_read(
    result: std::result::Result<TextDocument, TextReadFailure>,
    surface: Option<ReadSurface>,
    read_page: impl FnOnce() -> std::result::Result<BytePage, TextReadFailure>,
) -> std::result::Result<LocalTextRead, TextReadFailure> {
    let failure = match result {
        Ok(document) => return Ok(LocalTextRead::Text(document)),
        Err(error) => error,
    };
    let cause = failure.read_cause;
    let undecodable = matches!(
        cause.reason,
        ReadReason::BinaryContent | ReadReason::UnsupportedEncoding
    );
    if surface == Some(ReadSurface::QuickView)
        && (undecodable || cause.reason == ReadReason::SizeLimit)
    {
        match read_page() {
            Ok(page) if page.length == 0 => {
                diagnostics::file_read(surface, cause, None, true);
                return Ok(LocalTextRead::Text(TextDocument {
                    text: String::new(),
                    encoding: Encoding::Utf8,
                    revision: None,
                }));
            }
            Ok(page) if undecodable || byte_page_looks_binary(&page.data) => {
                diagnostics::file_read(surface, cause, None, true);
                return Ok(LocalTextRead::Binary { page });
            }
            Ok(_) => {
                let fallback = ReadCause {
                    stage: ReadStage::ByteProbe,
                    reason: ReadReason::NotBinary,
                    os_code: None,
                };
                diagnostics::file_read(surface, cause, Some(fallback), false);
                return Err(failure);
            }
            Err(error) => {
                diagnostics::file_read(surface, cause, Some(error.read_cause), false);
                return Err(error);
            }
        }
    }
    diagnostics::file_read(surface, cause, None, false);
    Err(failure)
}

#[tauri::command]
async fn read_text(
    directory: String,
    name: String,
    surface: Option<ReadSurface>,
) -> std::result::Result<LocalTextRead, TextReadFailure> {
    let result = blocking_for("read_text", move || {
        let path = match selected(&directory, &name) {
            Ok(path) => path,
            Err(error) => {
                let error = TextReadFailure::io(ReadStage::Select, error);
                diagnostics::file_read(surface, error.read_cause, None, false);
                return Ok(Err(error));
            }
        };
        let result = match read_regular_file(&path).and_then(decode_local_text) {
            // A new log entry would trigger another read in the live Viewer.
            Err(error) if diagnostics::is_log_file(&path) => return Ok(Err(error)),
            result => result,
        };
        Ok(finish_local_text_read(result, surface, || {
            local::read_byte_page(read_regular_file(&path)?, 0)
                .map_err(|error| TextReadFailure::io(ReadStage::Read, error))
        }))
    })
    .await;
    result.map_err(|message| {
        let panicked = message == diagnostics::PANIC_REJECTION;
        let error = TextReadFailure::new(ReadStage::Unknown, ReadReason::Unknown, message);
        if !panicked {
            diagnostics::file_read(surface, error.read_cause, None, false);
        }
        error
    })?
}

#[cfg(test)]
mod text_read_tests {
    use super::*;

    #[test]
    fn a_regular_text_edit_can_save_past_the_paging_threshold() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("threshold.txt");
        fs::write(&path, "original").unwrap();
        let text = "x".repeat(TEXT_LIMIT as usize + 1);
        save_local_text(&path, "original", &text).unwrap();
        assert_eq!(fs::read(&path).unwrap(), text.as_bytes());
    }

    #[test]
    fn classifies_file_selection_open_and_decoding_failures() {
        let folder = tempfile::tempdir().unwrap();
        let missing = read_regular_file(&folder.path().join("missing.txt")).unwrap_err();
        assert_eq!(missing.read_cause.reason, ReadReason::MissingFile);
        assert!(missing.read_cause.os_code.is_some());
        let directory = read_regular_file(folder.path()).unwrap_err();
        assert_eq!(directory.read_cause.reason, ReadReason::NonRegularFile);

        let denied = io::Error::from_raw_os_error(if cfg!(windows) { 5 } else { 13 });
        let denied = TextReadFailure::io(ReadStage::Open, denied).read_cause;
        assert_eq!(denied.reason, ReadReason::AccessDenied);
        assert_eq!(denied.stage, ReadStage::Open);
        assert_eq!(denied.os_code, Some(if cfg!(windows) { 5 } else { 13 }));
        let io_error = io::Error::from_raw_os_error(if cfg!(windows) { 1117 } else { 5 });
        assert_eq!(
            TextReadFailure::io(ReadStage::Read, io_error)
                .read_cause
                .reason,
            ReadReason::Io
        );

        for (bytes, reason) in [
            (&[0, 65][..], ReadReason::BinaryContent),
            (&[0xff][..], ReadReason::UnsupportedEncoding),
            (&[0xff, 0xfe, 0][..], ReadReason::UnsupportedEncoding),
        ] {
            assert_eq!(
                decode_local_text(bytes).err().unwrap().read_cause.reason,
                reason
            );
        }
        assert_eq!(
            decode_local_text(&b"readable"[..]).unwrap().text,
            "readable"
        );
        let oversized = decode_local_text(io::repeat(b'a').take(TEXT_LIMIT + 1))
            .err()
            .unwrap();
        assert_eq!(oversized.read_cause.reason, ReadReason::SizeLimit);
        assert!(
            TextReadFailure::new(ReadStage::Unknown, ReadReason::Unknown, "other")
                .read_cause
                .os_code
                .is_none()
        );
    }

    #[test]
    fn quick_view_uses_binary_fallback_and_preserves_a_failed_probe() {
        let primary = || decode_local_text(&[0, 65][..]);
        let surface = Some(ReadSurface::QuickView);
        let recovered = finish_local_text_read(primary(), surface, || {
            Ok(BytePage {
                length: 2,
                data: vec![0, 65],
            })
        })
        .unwrap();
        assert!(matches!(recovered, LocalTextRead::Binary { page } if page.data == [0, 65]));
        let failed = finish_local_text_read(primary(), surface, || {
            Err(TextReadFailure::io(
                ReadStage::Open,
                io::ErrorKind::NotFound.into(),
            ))
        })
        .err()
        .unwrap();
        assert_eq!(failed.read_cause.reason, ReadReason::MissingFile);
        let editor = finish_local_text_read(primary(), Some(ReadSurface::Editor), || {
            panic!("unexpected fallback")
        });
        assert_eq!(
            editor.err().unwrap().read_cause.reason,
            ReadReason::BinaryContent
        );
        assert!(!byte_page_looks_binary(&[b'a', 0xe2, 0x82]));
        assert!(byte_page_looks_binary(&[b'a', 0xff]));
        assert!(!byte_page_looks_binary(&[0xff, 0xfe, 0]));
    }

    #[cfg(windows)]
    #[test]
    fn preserves_windows_sharing_violation_code() {
        use std::os::windows::fs::OpenOptionsExt;
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("locked.txt");
        let _lock = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        let failure = read_regular_file(&path).unwrap_err();
        assert_eq!(failure.read_cause.reason, ReadReason::SharingViolation);
        assert_eq!(failure.read_cause.os_code, Some(32));
    }
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
    let response = connection
        .request(
            "v1/download",
            RemotePath { segments },
            Duration::from_secs(45),
        )
        .await?;
    let bytes = collect_response(response, TEXT_LIMIT as usize + 1).await?;
    decode_text(bytes.as_slice())
}

#[tauri::command]
async fn open_server_text_pages(
    id: u32,
    segments: Vec<String>,
    connections: State<'_, Connections>,
    state: State<'_, crate::text_pages::Documents>,
) -> Result<Option<crate::text_pages::PageInfo>> {
    use crate::text_pages::{Document, Source};
    use tokio::io::AsyncWriteExt as _;

    let connection = connections.get(id)?;
    let idle = Duration::from_secs(45);
    let mut response = tokio::time::timeout(
        idle,
        connection.request_with_timeout("v1/download", RemotePath { segments }, None),
    )
    .await
    .map_err(message)??;
    let length = response
        .content_length()
        .ok_or("The server did not report the file size.")?;
    if length <= TEXT_LIMIT {
        return Ok(None);
    }
    let file = blocking(|| tempfile::tempfile().map_err(message)).await?;
    let mut file = tokio::fs::File::from_std(file);
    let mut received = 0;
    while let Some(chunk) = tokio::time::timeout(idle, response.chunk())
        .await
        .map_err(message)?
        .map_err(message)?
    {
        received += chunk.len() as u64;
        if received > length {
            return Err("The server file changed while it was being opened.".into());
        }
        file.write_all(&chunk).await.map_err(message)?;
    }
    if received != length {
        return Err("The server file changed while it was being opened.".into());
    }
    file.flush().await.map_err(message)?;
    let file = file.into_std().await;
    let document = blocking(move || Document::new(Source::ReadOnly, file, None)).await?;
    state.insert(document).map(Some)
}

const PREVIEW_IMAGE_LIMIT: usize = 16 * 1024 * 1024;

pub(crate) fn check_preview_image_size(length: u64) -> Result<()> {
    if length > PREVIEW_IMAGE_LIMIT as u64 {
        return Err("Quick View supports images up to 16 MiB.".into());
    }
    Ok(())
}

pub(crate) fn load_preview_image(path: &Path) -> Result<Vec<u8>> {
    let file = open_regular_file(path)?;
    check_preview_image_size(file.metadata().map_err(message)?.len())?;
    let mut bytes = Vec::new();
    file.take(PREVIEW_IMAGE_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(message)?;
    check_preview_image_size(bytes.len() as u64)?;
    Ok(bytes)
}

#[cfg(test)]
mod preview_image_tests {
    use super::{load_preview_image, PREVIEW_IMAGE_LIMIT};
    use std::fs;

    #[test]
    fn returns_file_bytes_and_rejects_directories_and_oversized_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preview.png");
        let bytes = b"\x89PNG\r\n\x1a\n";
        fs::write(&path, bytes).unwrap();
        assert_eq!(load_preview_image(&path).unwrap(), bytes);
        assert!(load_preview_image(directory.path()).is_err());

        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(PREVIEW_IMAGE_LIMIT as u64 + 1).unwrap();
        drop(file);
        assert_eq!(
            load_preview_image(&path).unwrap_err(),
            "Quick View supports images up to 16 MiB."
        );
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum PreviewImageSource {
    Local { directory: String, name: String },
    Server { id: u32, segments: Vec<String> },
    Ftp { id: u32, segments: Vec<String> },
    Ssh { id: u32, segments: Vec<String> },
    Archive { id: u32, segments: Vec<String> },
}

#[tauri::command]
async fn read_preview_image(
    source: PreviewImageSource,
    servers: State<'_, Connections>,
    ftp: State<'_, ftp::FtpState>,
    ssh: State<'_, ssh::SshState>,
    archives: State<'_, crate::archives::Archives>,
) -> Result<tauri::ipc::Response> {
    let bytes = match source {
        PreviewImageSource::Local { directory, name } => {
            blocking(move || load_preview_image(&selected(&directory, &name).map_err(message)?))
                .await?
        }
        PreviewImageSource::Server { id, segments } => {
            let response = servers
                .get(id)?
                .request(
                    "v1/download",
                    RemotePath { segments },
                    Duration::from_secs(45),
                )
                .await?;
            collect_response(response, PREVIEW_IMAGE_LIMIT + 1).await?
        }
        PreviewImageSource::Ftp { id, segments } => {
            let connection = ftp.connection(id)?;
            blocking(move || {
                let mut session = connection.open()?;
                let length = session.regular(&segments)?.size() as u64;
                check_preview_image_size(length)?;
                session.read_limited(&segments, 0, length, length)
            })
            .await?
        }
        PreviewImageSource::Ssh { id, segments } => {
            let connection = ssh.connection(id)?;
            blocking(move || {
                let mut session = connection.open()?;
                let entry = session.regular(&segments)?;
                let length = remote_transfer::Entry::size(&entry)
                    .ok_or("The SSH server did not report the file size.")?;
                check_preview_image_size(length)?;
                session
                    .read_limited(&segments, 0, length)
                    .map_err(Into::into)
            })
            .await?
        }
        PreviewImageSource::Archive { id, segments } => {
            let archive = archives.get(id)?;
            blocking(move || archive.lock().map_err(message)?.preview_image(&segments)).await?
        }
    };
    check_preview_image_size(bytes.len() as u64)?;
    Ok(tauri::ipc::Response::new(bytes))
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
    let response = connection
        .request(
            "v1/bytes",
            ByteRequest { segments, offset },
            Duration::from_secs(20),
        )
        .await?;
    let max_response = crate::protocol::BYTE_PAGE_SIZE as usize * 4 + 128;
    let bytes = collect_response(response, max_response).await?;
    serde_json::from_slice(&bytes).map_err(message)
}

pub(crate) fn encode_text(encoding: Encoding, text: &str) -> Vec<u8> {
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
    buffer
}

fn create_encoded_file(path: &Path, encoding: Encoding) -> Result<()> {
    let bytes = encode_text(encoding, "");
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

fn ssh_text_revision(entry: &ssh::Entry, bytes: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, bytes);
    format!("{:?}:{}", entry.revision(), URL_SAFE_NO_PAD.encode(digest))
}

fn load_ssh_text(
    session: &mut ssh::Session,
    segments: &[String],
) -> ssh::SftpResult<(TextDocument, ssh::Entry)> {
    let before = session.regular(segments)?;
    let length = remote_transfer::Entry::size(&before)
        .ok_or("The SSH server did not report the file size.")?;
    if length > TEXT_LIMIT {
        return Err("Text files can be at most 8 MiB.".into());
    }
    let bytes = session.read_limited(segments, 0, length)?;
    if session.regular(segments)? != before {
        return Err("The SSH file changed while it was being opened.".into());
    }
    let mut document = decode_text(bytes.as_slice())?;
    document.revision = Some(ssh_text_revision(&before, &bytes));
    Ok((document, before))
}

#[tauri::command]
async fn read_ssh_text(
    id: u32,
    segments: Vec<String>,
    sudo_password: Option<String>,
    state: State<'_, ssh::SshState>,
) -> Result<TextDocument> {
    let sudo_password = sudo_password.map(zeroize::Zeroizing::new);
    let connection = state.connection(id)?;
    blocking(move || {
        connection.text_operation(sudo_password, true, |session| {
            load_ssh_text(session, &segments).map(|(document, _)| document)
        })
    })
    .await
}

#[tauri::command]
async fn read_ssh_bytes(
    id: u32,
    segments: Vec<String>,
    offset: u64,
    state: State<'_, ssh::SshState>,
) -> Result<BytePage> {
    let connection = state.connection(id)?;
    blocking(move || {
        let mut session = connection.open()?;
        let before = session.regular(&segments)?;
        let length = remote_transfer::Entry::size(&before)
            .ok_or("The SSH server did not report the file size.")?;
        let data = session.read_limited(
            &segments,
            offset.min(length),
            crate::protocol::BYTE_PAGE_SIZE.min(length.saturating_sub(offset)),
        )?;
        if session.regular(&segments)? != before {
            return Err("The SSH file changed during the read.".to_owned());
        }
        Ok(BytePage { length, data })
    })
    .await
}

#[tauri::command]
async fn save_ssh_text(
    id: u32,
    segments: Vec<String>,
    revision: String,
    text: String,
    sudo_password: Option<String>,
    state: State<'_, ssh::SshState>,
) -> Result<TextDocument> {
    let sudo_password = sudo_password.map(zeroize::Zeroizing::new);
    let connection = state.connection(id)?;
    blocking(move || {
        let (encoding, revision) = connection.text_operation(sudo_password, false, |session| {
            let (document, original) = load_ssh_text(session, &segments)?;
            let changed = "The SSH file changed on the server. Reopen it before saving.";
            if document.revision.as_deref() != Some(revision.as_str()) {
                return Err(changed.into());
            }
            let bytes = encode_text(document.encoding, &text);
            session.replace_text(&segments, &original, bytes.as_slice(), |session| {
                if load_ssh_text(session, &segments)?.0.revision == document.revision {
                    Ok(())
                } else {
                    Err(changed.into())
                }
            })?;
            let revision = session
                .regular(&segments)
                .ok()
                .map(|entry| ssh_text_revision(&entry, &bytes));
            Ok((document.encoding, revision))
        })?;
        Ok(TextDocument {
            text,
            encoding,
            revision,
        })
    })
    .await
}

fn load_ftp_text(session: &mut ftp::Session, segments: &[String]) -> Result<TextDocument> {
    let before = session.regular(segments)?;
    let length = before.size() as u64;
    if length > TEXT_LIMIT {
        return Err("Text files can be at most 8 MiB.".into());
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
        let buffer = encode_text(document.encoding, &text);
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
    blocking_for("save_text", move || {
        let path = selected(&directory, &name).map_err(message)?;
        save_local_text(&path, &original, &text)
    })
    .await
}

pub(crate) fn lock_local_save(path: &Path) -> Result<std::sync::MutexGuard<'static, ()>> {
    use std::hash::{DefaultHasher, Hash, Hasher};
    static SAVES: [Mutex<()>; 64] = [const { Mutex::new(()) }; 64];
    let mut hash = DefaultHasher::new();
    same_file::Handle::from_path(path)
        .map_err(message)?
        .hash(&mut hash);
    SAVES[(hash.finish() % SAVES.len() as u64) as usize]
        .lock()
        .map_err(message)
}

fn save_local_text(path: &Path, original: &str, text: &str) -> Result<()> {
    let _guard = lock_local_save(path)?;
    let metadata = fs::symlink_metadata(path).map_err(message)?;
    let revision = local_transfer::FileRevision::capture(path, &metadata).map_err(message)?;
    fs::OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(message)?;
    let document = load_text(path)?;
    if document.text != original {
        return Err("The file changed on disk. Reopen it before saving.".to_owned());
    }
    let parent = path.parent().ok_or("Choose a parent folder.")?;
    let workspace = local::staging_directory(parent).map_err(message)?;
    let mut staged = tempfile::NamedTempFile::new_in(workspace.path()).map_err(message)?;
    #[cfg(windows)]
    local::preserve_access(path, staged.path(), &metadata).map_err(message)?;
    staged
        .write_all(&encode_text(document.encoding, text))
        .map_err(message)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o6000 != 0 {
            return Err("Edit this file with a tool that supports special permissions.".into());
        }
        local::preserve_access(path, staged.path(), &metadata).map_err(message)?;
    }
    staged.as_file().sync_all().map_err(message)?;
    let current = load_text(path)?;
    if current.text != original || current.encoding != document.encoding {
        return Err("The file changed on disk. Reopen it before saving.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let current = fs::symlink_metadata(path).map_err(message)?;
        if (current.ctime(), current.ctime_nsec()) != (metadata.ctime(), metadata.ctime_nsec()) {
            return Err("The file changed on disk. Reopen it before saving.".into());
        }
    }
    revision.verify(path).map_err(message)?;
    publish_local_replacement(path, staged)
}

pub(crate) fn publish_local_replacement(
    path: &Path,
    staged: tempfile::NamedTempFile,
) -> Result<()> {
    #[cfg(unix)]
    staged.persist(path).map_err(message)?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
        let wide = |path: &Path| {
            path.as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>()
        };
        let staged = staged.into_temp_path();
        let target = wide(path);
        let replacement = wide(&staged);
        // ReplaceFile merges security and named streams from the destination.
        if unsafe {
            ReplaceFileW(
                target.as_ptr(),
                replacement.as_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null(),
                std::ptr::null(),
            )
        } == 0
        {
            return Err(message(io::Error::last_os_error()));
        }
    }
    Ok(())
}

#[tauri::command]
async fn save_text_as(path: String, encoding: Encoding, text: String) -> Result<()> {
    blocking(move || {
        let path = local::absolute(&path).map_err(message)?;
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Enter a file name.")?;
        local::name_component(name).map_err(message)?;
        let directory = path.parent().ok_or("Choose a parent folder.")?;
        let mut staged = tempfile::NamedTempFile::new_in(directory).map_err(message)?;
        staged
            .write_all(&encode_text(encoding, &text))
            .map_err(message)?;
        staged.as_file().sync_all().map_err(message)?;
        staged.persist_noclobber(path).map_err(|error| {
            if error.error.kind() == io::ErrorKind::AlreadyExists {
                "A file already exists at that path. Choose a new file name.".to_owned()
            } else {
                message(error.error)
            }
        })?;
        Ok(())
    })
    .await
}

#[tauri::command]
async fn kswitcher_peers() -> Result<serde_json::Value> {
    crate::kswitcher_lan::peers().await
}

#[tauri::command]
async fn list_kswitcher(peer: String, path: String) -> Result<crate::kswitcher_lan::Listing> {
    crate::kswitcher_lan::list(&peer, &path).await
}

pub fn run() {
    #[cfg(windows)]
    crate::portable::maybe_apply_update();
    let _ = rustls::crypto::ring::default_provider().install_default();
    let context = tauri::generate_context!();
    #[cfg(windows)]
    {
        let administrator = crate::windows_elevation::is_elevated();
        if let Some(directory) = crate::portable::root() {
            crate::portable::initialize(directory, administrator);
        } else if administrator
            && (crate::windows_elevation::requested_handoff().is_some()
                || std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none())
        {
            if let Some(base) = dirs::data_local_dir() {
                std::env::set_var(
                    "WEBVIEW2_USER_DATA_FOLDER",
                    base.join(&context.config().identifier)
                        .join("AdministratorWebView"),
                );
            }
        }
    }
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
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, WindowEvent::Destroyed) {
                for (label, tool) in window.app_handle().webview_windows() {
                    if label == "options"
                        || label.starts_with("compare-")
                        || label.starts_with("diagram-")
                    {
                        let _ = tool.destroy();
                    }
                }
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(crate::updates::PendingUpdate::default())
        .manage(Connections::default())
        .manage(crate::desktop_share::DesktopShare::default())
        .manage(crate::archives::Archives::default())
        .manage(crate::archive_create::ArchiveJobs::default())
        .manage(crate::deletion::DeleteJobs::default())
        .manage(ftp::FtpState::default())
        .manage(ssh::SshState::default())
        .manage(crate::netbox_connection::Requests::default())
        .manage(TransferSessions::default())
        .manage(crate::file_history::History::default())
        .manage(terminal::Terminals::default())
        .manage(watch::Watches::default())
        .manage(watch::Measurements::default())
        .manage(crate::space_analyzer::Scans::default())
        .manage(Arc::new(crate::completion::CompletionQueue::default()))
        .manage(crate::processes::ProcessMonitor::default())
        .manage(crate::mcp::McpService::default())
        .manage(crate::image_edit::ImageEdits::default())
        .manage(crate::text_pages::Documents::default())
        .manage(crate::file_clipboard::FileClipboard::default());
    #[cfg(windows)]
    let builder = builder.manage(crate::windows_shell::ShellIcons::default());
    #[cfg(windows)]
    let builder = builder.setup(|app| {
        #[cfg(windows)]
        if let Some(window) = tauri::Manager::get_webview_window(app, "main") {
            window.set_decorations(false)?;
        }
        crate::windows_environment::attach(app.handle());
        Ok(())
    });
    #[cfg(feature = "ui-automation")]
    let builder = builder.on_page_load(crate::updates::fixture::page_loaded);
    let dispatch: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        diagnostics::report_diagnostic,
        diagnostics::error_log,
        diagnostics::clear_error_log,
        build_version,
        read_settings_archive,
        write_settings_archive,
        open_tool_window,
        crate::netbox_connection::begin_netbox_request,
        crate::netbox_connection::finish_netbox_request,
        set_appearance_picker,
        crate::updates::check_for_update,
        crate::updates::highlights::installed_release,
        crate::updates::highlights::acknowledge_release,
        crate::updates::read_windows_settings,
        crate::updates::save_windows_preferences,
        crate::updates::install_update,
        #[cfg(feature = "ui-automation")]
        crate::updates::fixture::updater_fixture_result,
        #[cfg(feature = "ui-automation")]
        crate::updates::fixture::updater_fixture_phase,
        #[cfg(feature = "ui-automation")]
        crate::updates::fixture::updater_fixture_normal_window,
        #[cfg(feature = "ui-automation")]
        crate::updates::fixture::updater_fixture_options_window,
        locations,
        requested_location,
        crate::processes::list_processes,
        #[cfg(windows)]
        crate::processes::process_icons,
        crate::processes::terminate_processes,
        crate::mcp::start_mcp,
        crate::mcp::stop_mcp,
        crate::mcp::mcp_connection,
        crate::mcp::mcp_decision,
        crate::mcp::mcp_result,
        crate::file_clipboard::copy_file_references,
        crate::file_clipboard::clipboard_files,
        crate::file_clipboard::copy_path,
        crate::file_clipboard::clipboard_text,
        crate::screen_color::pick_screen_color,
        crate::file_clipboard::dropped_files,
        #[cfg(windows)]
        crate::windows_shell::windows_item_menu,
        #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
        crate::smb::connect_smb,
        #[cfg(windows)]
        crate::windows_elevation::open_elevated,
        #[cfg(windows)]
        crate::windows_elevation::windows_startup,
        #[cfg(windows)]
        crate::windows_shell::locking_processes,
        #[cfg(windows)]
        crate::windows_shell::file_icons,
        installed_fonts,
        computer_name,
        list_directory,
        disk_space,
        crate::space_analyzer::space_mount,
        crate::space_analyzer::volume_information,
        crate::space_analyzer::scan_local_space,
        crate::space_analyzer::cancel_space_scan,
        crate::git_view::git_repository,
        crate::git_view::git_history,
        crate::git_view::git_working_changes,
        crate::git_view::git_working_diff,
        crate::git_view::writes::git_index_state,
        crate::git_view::writes::git_update_index,
        crate::git_view::writes::git_commit_changes,
        crate::git_view::git_details,
        crate::environment::environment_scope,
        crate::environment::environment_value,
        crate::environment::save_environment,
        crate::timestamps::format_timestamps,
        panel_metadata,
        stream_sort_supported,
        file_attributes,
        update_file_attributes,
        operate,
        crate::archive_create::archive_capabilities,
        crate::archive_create::create_archive,
        crate::archive_create::cancel_archive,
        crate::archives::open_archive,
        crate::archives::close_archive,
        crate::archives::list_archive,
        crate::archives::read_archive_text,
        crate::archives::read_archive_bytes,
        crate::archives::save_archive_text,
        crate::archives::delete_archive_entries,
        change_archive,
        copy_into_archive,
        crate::folders::create_folders,
        crate::desktop_share::active_desktop_share,
        connect_server,
        crate::desktop_share::start_desktop_computer_share,
        crate::desktop_share::stop_desktop_share,
        connect_saved_server,
        list_saved_computer_drives,
        list_connected_computer_drives,
        verify_computer_pairing,
        save_server_invitation,
        remove_server_invitation,
        list_server,
        disconnect_server,
        ftp::ftp_profiles,
        ftp::ftp_windows_code_page,
        ftp::test_ftp_connection,
        ftp::save_ftp_profile,
        ftp::remove_ftp_profile,
        ftp::connect_ftp,
        ftp::disconnect_ftp,
        ftp::list_ftp,
        ftp::search_ftp,
        ftp::cancel_ftp_search,
        ftp::rename_ftp,
        ftp::delete_ftp,
        ssh::profiles::ssh_profiles,
        ssh::profiles::save_ssh_profile,
        ssh::profiles::remove_ssh_profile,
        ssh::connect_ssh,
        ssh::test_ssh_connection,
        ssh::disconnect_ssh,
        ssh::list_ssh,
        ssh::delete_ssh,
        read_ftp_text,
        read_ftp_bytes,
        save_ftp_text,
        read_ssh_text,
        read_ssh_bytes,
        save_ssh_text,
        read_text,
        crate::text_pages::open_local_text_pages,
        crate::text_pages::open_ftp_text_pages,
        crate::text_pages::open_ssh_text_pages,
        crate::archives::open_archive_text_pages,
        open_server_text_pages,
        crate::text_pages::read_text_page,
        crate::text_pages::edit_text_page,
        crate::text_pages::save_text_pages,
        crate::text_pages::close_text_pages,
        read_preview_image,
        crate::image_edit::open_image_edit,
        crate::image_edit::read_image_edit,
        crate::image_edit::save_image_edit,
        crate::image_edit::close_image_edit,
        resolve_text_link,
        open_web_link,
        read_server_text,
        read_bytes,
        read_server_bytes,
        save_text,
        save_text_as,
        kswitcher_peers,
        list_kswitcher,
        begin_transfer,
        crate::file_history::file_operation_history,
        crate::file_history::reverse_file_operation,
        crate::deletion::delete_selection,
        crate::deletion::cancel_deletion,
        crate::deletion::resolve_deletion,
        cancel_transfer,
        finish_transfer,
        resolve_transfer,
        transfer_item,
        terminal::open_terminal,
        crate::completion::complete_command,
        crate::completion::complete_ssh_terminal,
        crate::completion::complete_ssh_command,
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

#[cfg(test)]
mod settings_archive_tests {
    use super::{read_settings_archive_file, write_settings_archive_file, SETTINGS_ARCHIVE_LIMIT};
    use std::fs;

    #[test]
    fn round_trips_utf8_and_preserves_the_previous_file_when_export_is_too_large() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("settings.json");
        let original = r#"{"name":"Вечір"}"#;
        let updated = r#"{"name":"Après-midi"}"#;
        write_settings_archive_file(&path, original).unwrap();
        assert_eq!(read_settings_archive_file(&path).unwrap(), original);
        write_settings_archive_file(&path, updated).unwrap();
        let oversized = "x".repeat(SETTINGS_ARCHIVE_LIMIT as usize + 1);
        assert!(write_settings_archive_file(&path, &oversized).is_err());
        assert_eq!(read_settings_archive_file(&path).unwrap(), updated);
        fs::write(&path, oversized).unwrap();
        assert!(read_settings_archive_file(&path).is_err());
        fs::write(&path, [0xff]).unwrap();
        assert!(read_settings_archive_file(&path).is_err());
    }
}

#[cfg(test)]
mod local_save_tests {
    use super::*;
    #[test]
    fn competing_saves_accept_only_one_writer() {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("note.txt");
        fs::write(&path, "original").unwrap();
        let start = std::sync::Barrier::new(2);
        let results = std::thread::scope(|scope| {
            let worker = |value| {
                start.wait();
                save_local_text(&path, "original", value)
            };
            let left = scope.spawn(move || worker("left"));
            let right = scope.spawn(move || worker("right"));
            [left.join().unwrap(), right.join().unwrap()]
        });
        assert_eq!(
            results.iter().filter(|item| item.is_ok()).count(),
            1,
            "{results:?}"
        );
        assert!(matches!(
            fs::read_to_string(path).unwrap().as_str(),
            "left" | "right"
        ));
    }
    #[cfg(unix)]
    #[test]
    fn save_preserves_private_mode() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("private");
        fs::write(&path, "first").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        save_local_text(&path, "first", "second").unwrap();
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
