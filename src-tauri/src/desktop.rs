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
    time::{Duration, Instant, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{redirect::Policy, Certificate, Client, Response};
use serde::{Deserialize, Serialize};
use tauri::{
    ipc::Channel, AppHandle, Emitter, Manager, State, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_dialog::DialogExt;
use tokio_util::sync::CancellationToken;

use crate::{
    diagnostics::{self, ReadCause, ReadReason, ReadStage, ReadSurface},
    ftp, local, local_transfer,
    protocol::{BytePage, ByteRequest, Invitation, RemoteListing, RemotePath},
    remote_transfer, ssh, terminal, watch,
};

pub(crate) use crate::text_format::{encode as encode_text, Encoding, TEXT_LIMIT};
pub(crate) use crate::{message, Result};

#[path = "desktop_lan_transfer.rs"]
mod lan_transfer;
#[path = "desktop_remote_transfer.rs"]
mod remote_provider_transfer;
#[cfg(test)]
pub(crate) use remote_provider_transfer::verify_file_server_relays;
#[path = "desktop_ssh_transfer.rs"]
mod ssh_transfer;

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
    blocking(|| Ok(crate::protocol::computer_name()))
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
        let response = request.send().await.map_err(|error| {
            if error.is_connect() || error.is_timeout() {
                "Could not reach the Dirlume server.".to_owned()
            } else {
                message(error)
            }
        })?;
        if response.status() == reqwest::StatusCode::NOT_FOUND
            && matches!(action, "v1/list" | "v1/download" | "v1/bytes")
        {
            return Err("The requested remote drive, folder, or file is unavailable.".into());
        }
        if !response.status().is_success() {
            return Err(format!(
                "Dirlume server returned HTTP {}.",
                response.status().as_u16()
            ));
        }
        Ok(response)
    }

    async fn list(&self, segments: Vec<String>) -> Result<RemoteListing> {
        self.list_with_access(segments)
            .await
            .map(|(listing, _)| listing)
    }

    async fn list_with_access(&self, segments: Vec<String>) -> Result<(RemoteListing, bool)> {
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
            let writable = response
                .headers()
                .get(crate::protocol::SHARE_WRITABLE_HEADER)
                .is_some_and(|value| value == "true");
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
                return Ok((result, writable));
            }
        }
    }

    fn download_file(
        &self,
        segments: Vec<String>,
        file: &mut impl Write,
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
                finish_downloaded_file(&file, item.modified).map_err(message)?;
            }
        }
        Ok(())
    }

    fn copy_folder(
        &self,
        segments: Vec<String>,
        target: &Path,
        session: &TransferSession,
        options: &local_transfer::Options,
        progress: impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
        ask: impl FnMut(local_transfer::Conflict) -> io::Result<local_transfer::Decision>,
    ) -> Result<TransferOutcome> {
        copy_downloaded_item(
            target,
            session,
            options,
            progress,
            ask,
            |staged, progress| self.download_tree(segments, staged, session, progress),
        )
    }
}

fn copy_downloaded_item<P>(
    target: &Path,
    session: &TransferSession,
    options: &local_transfer::Options,
    mut progress: P,
    ask: impl FnMut(local_transfer::Conflict) -> io::Result<local_transfer::Decision>,
    download: impl FnOnce(&Path, &mut P) -> Result<()>,
) -> Result<TransferOutcome>
where
    P: FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
{
    let parent = target
        .parent()
        .ok_or("Choose a local destination folder.")?;
    let workspace = tempfile::tempdir_in(parent).map_err(message)?;
    let staged = workspace.path().join("download");
    download(&staged, &mut progress)?;
    session.ensure_running().map_err(message)?;

    // Only the temporary local copy is moved. The remote folder is untouched.
    let options = local_transfer::Options {
        moving: true,
        ..options.clone()
    };
    local_transfer::transfer(
        &staged,
        target,
        &options,
        &mut local_transfer::MoveResume::default(),
        progress,
        ask,
    )
    .map(transfer_outcome)
    .map_err(message)
}

fn download_kswitcher_tree(
    peer: &str,
    path: &str,
    target: &Path,
    session: &TransferSession,
    progress: &mut impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
) -> Result<()> {
    let listing =
        tauri::async_runtime::block_on(session.interrupt(crate::kswitcher_lan::list(peer, path)))?;
    if listing.omitted > 0 {
        return Err("The server could not list every item in this folder.".to_owned());
    }
    fs::create_dir(target).map_err(message)?;
    for item in listing.entries {
        session.ensure_running().map_err(message)?;
        if item.link {
            return Err(format!("Cannot download a linked item ({}).", item.name));
        }
        let destination = target.join(local::name_component(&item.name).map_err(message)?);
        let child = format!("{}\\{}", path.trim_end_matches(['/', '\\']), item.name);
        if item.directory {
            download_kswitcher_tree(peer, &child, &destination, session, progress)?;
        } else {
            let mut file = fs::File::create_new(destination).map_err(message)?;
            tauri::async_runtime::block_on(session.interrupt(crate::kswitcher_lan::download(
                peer,
                &child,
                &mut file,
                |bytes, total| progress(Path::new(&item.name), bytes, total),
            )))?;
            finish_downloaded_file(&file, item.modified).map_err(message)?;
        }
    }
    Ok(())
}

fn finish_downloaded_file(file: &fs::File, modified: Option<i64>) -> io::Result<()> {
    if let Some(modified) = modified.and_then(|seconds| {
        let duration = Duration::from_secs(seconds.unsigned_abs());
        if seconds < 0 {
            UNIX_EPOCH.checked_sub(duration)
        } else {
            UNIX_EPOCH.checked_add(duration)
        }
    }) {
        file.set_times(fs::FileTimes::new().set_modified(modified))?;
    }
    file.sync_all()
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
    sudo: ssh_transfer::SudoRequest,
    remembered: Mutex<[Option<local_transfer::Decision>; 2]>,
    local: Mutex<LocalTransferAttempt>,
    upload_move: Mutex<Option<UploadMoveAttempt>>,
    history: Option<crate::file_history::Tracker>,
}

struct UploadMoveAttempt {
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
        self.sudo.cancel()?;
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

#[tauri::command]
async fn authorize_transfer_sudo(
    id: u32,
    ticket: uuid::Uuid,
    password: String,
    state: State<'_, TransferSessions>,
) -> Result<()> {
    let session = state.get(id)?;
    let password = zeroize::Zeroizing::new(password);
    blocking(move || session.sudo.authorize(ticket, password, &session)).await
}

#[tauri::command]
fn decline_transfer_sudo(
    id: u32,
    ticket: uuid::Uuid,
    state: State<'_, TransferSessions>,
) -> Result<()> {
    state.get(id)?.sudo.answer(ticket, false)
}

#[derive(Deserialize)]
struct SshDeletion {
    segments: Vec<String>,
    recursive: bool,
    recycle: bool,
}

#[tauri::command]
async fn delete_ssh(
    id: u32,
    request: SshDeletion,
    job: u32,
    output: Channel<TransferEvent>,
    state: State<'_, ssh::SshState>,
    sessions: State<'_, TransferSessions>,
) -> Result<()> {
    let connection = state.connection(id)?;
    let transfer = sessions.get(job)?;
    blocking(move || {
        ssh_transfer::SshTransfer::open(&connection, false, &transfer, &output)?.remove(
            &request.segments,
            request.recursive,
            request.recycle,
        )
    })
    .await
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum TransferSource {
    GoogleDrive {
        profile: uuid::Uuid,
        item: String,
        name: String,
    },
    Local {
        directory: String,
        name: String,
    },
    Server {
        connection: u32,
        segments: Vec<String>,
        folder: bool,
        modified: Option<i64>,
        #[serde(default)]
        writable_server: bool,
    },
    Kswitcher {
        peer: String,
        path: String,
        name: String,
        #[serde(default)]
        folder: bool,
        modified: Option<i64>,
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
struct ArchiveDestination {
    id: u32,
    segments: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferRequest {
    source: TransferSource,
    destination: String,
    ftp_destination: Option<u32>,
    ssh_destination: Option<u32>,
    server_destination: Option<u32>,
    archive_destination: Option<ArchiveDestination>,
    kswitcher_destination: Option<String>,
    #[serde(default)]
    kswitcher_broker: bool,
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
    Folder {
        parent: Vec<String>,
        name: String,
    },
    Text {
        parent: Vec<String>,
        name: String,
        encoding: Encoding,
    },
    Rename {
        segments: Vec<String>,
        name: String,
    },
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
            ArchiveChange::Text {
                parent,
                name,
                encoding,
            } => archive.create_text(&parent, &name, encoding, progress),
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
    SudoRequired {
        ticket: uuid::Uuid,
        address: String,
        path: String,
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

trait VerifiedUpload: remote_transfer::UploadSession {
    fn verify_uploaded(
        &mut self,
        target: &[String],
        input: &mut fs::File,
        session: &TransferSession,
    ) -> Result<()>;
}

impl VerifiedUpload for ssh::Session {
    fn verify_uploaded(
        &mut self,
        target: &[String],
        input: &mut fs::File,
        session: &TransferSession,
    ) -> Result<()> {
        self.verify_uploaded_contents(target, input, || session.ensure_running().map_err(message))
    }
}

impl VerifiedUpload for ftp::Session {
    fn verify_uploaded(
        &mut self,
        target: &[String],
        input: &mut fs::File,
        session: &TransferSession,
    ) -> Result<()> {
        let original = crate::ftp_transfer::local_digest(input, || session.ensure_running())?;
        let uploaded = crate::ftp_transfer::file_digest(self, target, || session.ensure_running())?;
        if original.as_ref() != uploaded.as_ref() {
            return Err("The local file differs from the uploaded FTP copy.".to_owned());
        }
        Ok(())
    }
}

fn move_ftp_to_local(
    ftp: &mut ftp::Session,
    source: &[String],
    target: &Path,
    transfer: &TransferSession,
    options: &local_transfer::Options,
    progress: impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
    ask: impl FnMut(local_transfer::Conflict) -> io::Result<local_transfer::Decision>,
) -> Result<TransferOutcome> {
    let mut cleanup = None;
    let outcome = copy_downloaded_item(
        target,
        transfer,
        options,
        progress,
        ask,
        |staged, progress| {
            let temporary = local_transfer::Options {
                moving: false,
                policy: local_transfer::Policy::Skip,
                ask_read_only: true,
                copy: local::CopyOptions::default(),
            };
            if !remote_transfer::download(
                ftp,
                source,
                staged,
                &temporary,
                progress,
                |_| Ok(local_transfer::Decision::Skip),
                |_, _| {},
            )? {
                return Err("Could not stage the complete FTP move source.".to_owned());
            }
            cleanup = Some(crate::ftp_transfer::MoveCleanup::capture(
                ftp,
                source,
                staged,
                || transfer.ensure_running(),
            )?);
            Ok(())
        },
    )?;
    if let (TransferOutcome::Completed, Some(cleanup)) = (&outcome, cleanup) {
        if let Err(error) = cleanup.finish(ftp, || transfer.ensure_running()) {
            return Ok(TransferOutcome::SourceRetained {
                source: format!("/{}", source.join("/")),
                destination: crate::file_history::display(target),
                error,
            });
        }
    }
    Ok(outcome)
}

enum LocalOriginal {
    Folder(same_file::Handle),
    File(local_transfer::FileRevision),
}

struct LocalMoveItem {
    path: PathBuf,
    target: Vec<String>,
    original: LocalOriginal,
}

fn collect_local_move(
    source: &Path,
    target: &[String],
    transfer: &TransferSession,
    items: &mut Vec<LocalMoveItem>,
) -> Result<()> {
    transfer.ensure_running().map_err(message)?;
    let metadata = fs::symlink_metadata(source).map_err(message)?;
    if local::is_link(&metadata) || (!metadata.is_file() && !metadata.is_dir()) {
        return Err("Choose local files and folders without symbolic links.".to_owned());
    }
    let original = if metadata.is_dir() {
        let folder = same_file::Handle::from_path(source).map_err(message)?;
        for entry in fs::read_dir(source).map_err(message)? {
            local_transfer::verify_folder(source, &folder).map_err(message)?;
            let entry = entry.map_err(message)?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "A filename cannot be represented as Unicode.")?;
            let child = [target, &[name]].concat();
            collect_local_move(&entry.path(), &child, transfer, items)?;
        }
        LocalOriginal::Folder(folder)
    } else {
        LocalOriginal::File(
            local_transfer::FileRevision::capture(source, &metadata).map_err(message)?,
        )
    };
    items.push(LocalMoveItem {
        path: source.to_owned(),
        target: target.to_vec(),
        original,
    });
    Ok(())
}

fn move_local_folder<S: VerifiedUpload>(
    client: &mut S,
    source: &Path,
    target: &[String],
    policy: local_transfer::Policy,
    transfer: &TransferSession,
    progress: &mut impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
    ask: &mut impl FnMut(local_transfer::Conflict) -> io::Result<local_transfer::Decision>,
) -> Result<TransferOutcome> {
    let mut items = Vec::new();
    collect_local_move(source, target, transfer, &mut items)?;
    if !remote_transfer::upload(
        client,
        source,
        target,
        policy,
        progress,
        ask,
        &mut |_, _| {},
    )? {
        return Ok(TransferOutcome::Skipped);
    }
    for item in items {
        let result = remove_local_move_item(item, transfer, |target, mut input| {
            client.verify_uploaded(target, &mut input, transfer)
        });
        if let Err(error) = result {
            return Ok(TransferOutcome::SourceRetained {
                source: crate::file_history::display(source),
                destination: format!("/{}", target.join("/")),
                error,
            });
        }
    }
    Ok(TransferOutcome::Completed)
}

fn remove_local_move_item(
    item: LocalMoveItem,
    transfer: &TransferSession,
    verify_copy: impl FnOnce(&[String], fs::File) -> Result<()>,
) -> Result<()> {
    transfer.ensure_running().map_err(message)?;
    match item.original {
        LocalOriginal::Folder(original) => {
            local_transfer::verify_folder(&item.path, &original).map_err(message)?;
            fs::remove_dir(&item.path).map_err(message)
        }
        LocalOriginal::File(original) => {
            original.verify(&item.path).map_err(message)?;
            verify_copy(&item.target, fs::File::open(&item.path).map_err(message)?)?;
            transfer.ensure_running().map_err(message)?;
            local_transfer::remove_original(&item.path, &original).map_err(message)
        }
    }
}

fn move_local_to_archive(
    archive: &mut crate::archives::Archive,
    source: &Path,
    name: &str,
    request: &TransferRequest,
    transfer: &TransferSession,
    progress: impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
    ask: impl FnMut(local_transfer::Conflict) -> io::Result<local_transfer::Decision>,
) -> Result<TransferOutcome> {
    let segments = &request
        .archive_destination
        .as_ref()
        .ok_or("Choose a destination archive.")?
        .segments;
    let target = remote_transfer::child(segments, name);
    let mut items = Vec::new();
    collect_local_move(source, &target, transfer, &mut items)?;
    let Some(copy) = archive.copy_for_move(
        segments,
        (source.to_owned(), name.to_owned()),
        request.policy,
        progress,
        ask,
    )?
    else {
        return Ok(TransferOutcome::Skipped);
    };
    for item in items {
        let result = archive.verify().and_then(|()| {
            remove_local_move_item(item, transfer, |target, input| {
                copy.verify_file(target, input, || transfer.ensure_running())?;
                archive.verify()
            })
        });
        if let Err(error) = result {
            return Ok(TransferOutcome::SourceRetained {
                source: crate::file_history::display(source),
                destination: format!("{}/{name}", request.destination.trim_end_matches('/')),
                error,
            });
        }
    }
    Ok(TransferOutcome::Completed)
}

fn transfer_archive_member(
    source: &Arc<Mutex<crate::archives::Archive>>,
    target: &Arc<Mutex<crate::archives::Archive>>,
    segments: &[String],
    request: &TransferRequest,
    mut progress: impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
    mut ask: impl FnMut(local_transfer::Conflict) -> io::Result<local_transfer::Decision>,
) -> Result<TransferOutcome> {
    let parent = &request
        .archive_destination
        .as_ref()
        .ok_or("Choose a destination archive.")?
        .segments;
    let name = segments.last().ok_or("Choose an archive entry.")?;
    let destination = remote_transfer::child(parent, name);
    if Arc::ptr_eq(source, target) {
        if destination == segments {
            return Ok(TransferOutcome::Skipped);
        }
        if destination.starts_with(segments) || segments.starts_with(&destination) {
            return Err("Choose an archive destination outside the source folder.".to_owned());
        }
        if request.moving {
            let mut archive = source.lock().map_err(message)?;
            if request.policy == local_transfer::Policy::Skip
                && archive
                    .list(parent)?
                    .entries
                    .iter()
                    .any(|entry| &entry.name == name)
            {
                return Ok(TransferOutcome::Skipped);
            }
            archive.relocate_entry(segments, parent, name, |_| {
                progress(Path::new(name), 0, None)
            })?;
            return Ok(TransferOutcome::Completed);
        }
    }
    let temp = tempfile::tempdir().map_err(message)?;
    let staged = temp
        .path()
        .join(local::name_component(name).map_err(message)?);
    let version = {
        let archive = source.lock().map_err(message)?;
        if request.moving && !archive.is_writable() {
            return Err("The archive is read-only.".to_owned());
        }
        let options = local_transfer::Options {
            moving: false,
            policy: local_transfer::Policy::Skip,
            ask_read_only: true,
            copy: local::CopyOptions::default(),
        };
        if !archive.copy_to(
            segments,
            &staged,
            &options,
            &mut progress,
            &mut ask,
            |_, _| {},
        )? {
            return Ok(TransferOutcome::Skipped);
        }
        archive.generation().to_owned()
    };
    let copied = target.lock().map_err(message)?.copy_into(
        parent,
        &[(staged, name.clone())],
        request.policy,
        &mut progress,
        &mut ask,
    )?;
    if copied.first() != Some(&true) {
        return Ok(TransferOutcome::Skipped);
    }
    if request.moving {
        let removed = source.lock().map_err(message).and_then(|mut archive| {
            archive.remove_moved_member(segments, &version, || progress(Path::new(name), 0, None))
        });
        if let Err(error) = removed {
            return Ok(TransferOutcome::SourceRetained {
                source: format!("/{}", segments.join("/")),
                destination: format!("{}/{name}", request.destination.trim_end_matches('/')),
                error,
            });
        }
    }
    Ok(TransferOutcome::Completed)
}

#[cfg(test)]
pub(crate) fn verify_ftp_folder_moves(ftp: &mut ftp::Session, host: &Path) {
    use crate::local_transfer::{Decision, Policy};
    let transfer = TransferSession::default();
    let fixture = tempfile::tempdir().unwrap();
    let input = fixture.path().join("Move fixture");
    fs::create_dir_all(input.join("nested/empty")).unwrap();
    fs::write(input.join("nested/note.txt"), b"FTP contents").unwrap();
    let remote = ["Move fixture".to_owned()];
    let mut progress = |_: &Path, _, _| Ok(());
    let mut ask = |_| panic!("unexpected conflict");
    assert!(matches!(
        move_local_folder(
            ftp,
            &input,
            &remote,
            Policy::Ask,
            &transfer,
            &mut progress,
            &mut ask
        )
        .unwrap(),
        TransferOutcome::Completed,
    ));
    assert!(!input.exists());
    assert_eq!(
        fs::read(host.join("Move fixture/nested/note.txt")).unwrap(),
        b"FTP contents"
    );
    fs::create_dir_all(input.join("nested")).unwrap();
    fs::write(input.join("nested/note.txt"), b"Keep the existing file").unwrap();
    let options = local_transfer::Options {
        moving: true,
        policy: Policy::Ask,
        ask_read_only: true,
        copy: Default::default(),
    };
    assert!(matches!(
        move_ftp_to_local(
            ftp,
            &remote,
            &input,
            &transfer,
            &options,
            &mut progress,
            |_| Ok(Decision::Skip)
        )
        .unwrap(),
        TransferOutcome::Skipped,
    ));
    assert_eq!(
        fs::read(host.join("Move fixture/nested/note.txt")).unwrap(),
        b"FTP contents"
    );
    assert_eq!(
        fs::read(input.join("nested/note.txt")).unwrap(),
        b"Keep the existing file"
    );
    let output = fixture.path().join("Move output");
    assert!(matches!(
        move_ftp_to_local(ftp, &remote, &output, &transfer, &options, progress, ask).unwrap(),
        TransferOutcome::Completed,
    ));
    assert!(!host.join("Move fixture").exists());
    assert_eq!(
        fs::read(output.join("nested/note.txt")).unwrap(),
        b"FTP contents"
    );
    assert!(output.join("nested/empty").is_dir());
}

fn move_uploaded_file<S: VerifiedUpload>(
    remote: &mut S,
    request: &TransferRequest,
    source: &Path,
    target_name: &str,
    session: &TransferSession,
    progress: &mut impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
    ask: &mut impl FnMut(local_transfer::Conflict) -> io::Result<local_transfer::Decision>,
) -> Result<TransferOutcome> {
    let connection = request
        .ssh_destination
        .or(request.server_destination)
        .or(request.ftp_destination)
        .ok_or("Choose a remote destination.")?;
    let mut attempt = session.upload_move.lock().map_err(message)?;
    if !request.retry {
        *attempt = None;
    }
    let retry_cleanup = attempt.is_some();
    if let Some(previous) = &*attempt {
        if previous.source != source
            || previous.connection != connection
            || previous.destination != request.destination
        {
            return Err(format!(
                "The transfer no longer matches the completed {} upload.",
                S::SOURCE
            ));
        }
    } else {
        let metadata = fs::symlink_metadata(source).map_err(message)?;
        if !metadata.is_file() || local::is_link(&metadata) {
            return Err(if S::SOURCE == "SSH" {
                "Choose regular local files to move to an SSH/SFTP folder.".to_owned()
            } else {
                format!(
                    "Choose regular local files to move to a {} folder.",
                    S::SOURCE
                )
            });
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
        *attempt = Some(UploadMoveAttempt {
            source: source.to_owned(),
            original,
            target,
            connection,
            destination: request.destination.clone(),
        });
    }
    let completed = attempt.as_ref().expect("successful remote upload");
    let result = (|| {
        if retry_cleanup || S::SOURCE == "FTP" {
            session.ensure_running().map_err(message)?;
            completed.original.verify(source).map_err(message)?;
            let mut input = fs::File::open(source).map_err(message)?;
            remote.verify_uploaded(&completed.target, &mut input, session)?;
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
pub(crate) fn verify_lan_folder_move(invitation: &str, drive: &str, host: &Path) {
    let connection = Connection::connect(invitation).unwrap();
    let transfer = TransferSession::default();
    let mut client = lan_transfer::LanTransfer {
        connection: &connection,
        transfer: &transfer,
    };
    let fixture = tempfile::tempdir().unwrap();
    let source = fixture.path().join("Move fixture");
    fs::create_dir_all(source.join("nested")).unwrap();
    fs::write(source.join("nested/note.txt"), b"Move the tree").unwrap();
    let target = [drive.to_owned(), "Move fixture".to_owned()];
    let mut progress = |_: &Path, _, _| Ok(());
    let result = move_local_folder(
        &mut client,
        &source,
        &target,
        local_transfer::Policy::Ask,
        &transfer,
        &mut progress,
        &mut |_| panic!("Unexpected conflict"),
    )
    .unwrap();
    assert!(matches!(result, TransferOutcome::Completed));
    assert!(!source.exists());
    let remote = host.join("Move fixture/nested");
    assert_eq!(fs::read(remote.join("note.txt")).unwrap(), b"Move the tree");

    connection
        .download_tree(target.to_vec(), &source, &transfer, &mut progress)
        .unwrap();
    let cleanup = lan_transfer::MoveCleanup::capture(&mut client, &source, &target).unwrap();
    fs::write(remote.join("new.txt"), b"Created after copying").unwrap();
    let result = cleanup.finish(&client, &target, crate::file_history::display(&source));
    assert!(matches!(result, TransferOutcome::SourceRetained { .. }));
    assert!(!remote.join("note.txt").exists());
    assert_eq!(
        fs::read(source.join("nested/note.txt")).unwrap(),
        b"Move the tree"
    );
    assert_eq!(
        fs::read(remote.join("new.txt")).unwrap(),
        b"Created after copying"
    );
}

#[cfg(test)]
pub(crate) fn verify_sftp_sudo_transfer(connection: Arc<ssh::Connection>) {
    use remote_transfer::Session as _;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use zeroize::Zeroizing;

    let transfer = Arc::new(TransferSession::default());
    let denied = Arc::new(AtomicUsize::new(0));
    let output = {
        let transfer = Arc::clone(&transfer);
        let denied = Arc::clone(&denied);
        Channel::new(move |body| {
            let event: serde_json::Value = body.deserialize().unwrap();
            assert_eq!(event["kind"], "sudo_required");
            assert_eq!(
                event["path"],
                "/srv/dirlume-target/batch/protected/protected.txt"
            );
            let ticket = serde_json::from_value(event["ticket"].clone()).unwrap();
            denied.fetch_add(1, Ordering::Relaxed);
            assert!(transfer
                .sudo
                .authorize(
                    ticket,
                    Zeroizing::new("fixture-incorrect".to_owned()),
                    &transfer,
                )
                .is_err());
            transfer
                .sudo
                .authorize(
                    ticket,
                    Zeroizing::new("fixture-login".to_owned()),
                    &transfer,
                )
                .unwrap();
            Ok(())
        })
    };
    let fixture = tempfile::tempdir().unwrap();
    let source = fixture.path().join("batch");
    fs::create_dir_all(source.join("protected")).unwrap();
    fs::write(source.join("ordinary.txt"), b"ordinary upload").unwrap();
    fs::write(source.join("protected/protected.txt"), b"protected upload").unwrap();
    let target = ["srv", "dirlume-target", "batch"].map(str::to_owned);
    let mut remote =
        ssh_transfer::SshTransfer::open(&connection, false, &transfer, &output).unwrap();
    let mut commits = Vec::new();
    assert!(remote_transfer::upload(
        &mut remote,
        &source,
        &target,
        local_transfer::Policy::Ask,
        &mut |_, _, _| Ok(()),
        &mut |_| panic!("An unexpected overwrite was requested"),
        &mut |_, path| commits.push(path.to_owned()),
    )
    .unwrap());
    assert_eq!(commits.len(), 2);
    assert_eq!(denied.load(Ordering::Relaxed), 1);

    let protected = ["srv", "dirlume-read.txt"].map(str::to_owned);
    let output_path = fixture.path().join("download.txt");
    let options = local_transfer::Options {
        moving: false,
        policy: local_transfer::Policy::Ask,
        ask_read_only: true,
        copy: local::CopyOptions::default(),
    };
    let mut reader =
        ssh_transfer::SshTransfer::open(&connection, true, &transfer, &output).unwrap();
    assert!(remote_transfer::download(
        &mut reader,
        &protected,
        &output_path,
        &options,
        |_, _, _| Ok(()),
        |_| panic!("An unexpected overwrite was requested"),
        |_, _| {},
    )
    .unwrap());
    assert_eq!(fs::read(output_path).unwrap(), b"protected read\n");
    let deletion = ["srv", "dirlume-delete"].map(str::to_owned);
    remote.remove(&deletion, true, false).unwrap();
    assert!(remote.stat(&deletion).unwrap().is_none());

    let local_move = fixture.path().join("local-move");
    fs::create_dir_all(local_move.join("nested")).unwrap();
    fs::write(
        local_move.join("nested/test.txt"),
        b"move an uploaded folder",
    )
    .unwrap();
    let remote_move = ["srv", "dirlume-target", "local-move"].map(str::to_owned);
    let result = move_local_folder(
        &mut remote,
        &local_move,
        &remote_move,
        local_transfer::Policy::Ask,
        &transfer,
        &mut |_, _, _| Ok(()),
        &mut |_| panic!("An unexpected overwrite was requested"),
    )
    .unwrap();
    assert!(matches!(result, TransferOutcome::Completed));
    assert!(!local_move.exists());
    let mut leaf = remote_move.to_vec();
    leaf.extend(["nested".to_owned(), "test.txt".to_owned()]);
    assert!(remote.stat(&leaf).unwrap().is_some());

    let remote_source = ["srv", "dirlume-move"].map(str::to_owned);
    let downloaded = fixture.path().join("moved-download");
    let result = reader
        .move_to_local(
            &remote_source,
            &downloaded,
            &options,
            |_, _, _| Ok(()),
            |_| panic!("An unexpected overwrite was requested"),
        )
        .unwrap();
    assert!(matches!(result, TransferOutcome::Completed));
    assert_eq!(
        fs::read(downloaded.join("nested/test.txt")).unwrap(),
        b"move protected folder\n"
    );
    assert!(remote.stat(&remote_source).unwrap().is_none());
    assert_eq!(denied.load(Ordering::Relaxed), 1);
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
        server_destination: None,
        archive_destination: None,
        kswitcher_destination: None,
        kswitcher_broker: false,
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
        move_uploaded_file(
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
        *session.upload_move.lock().unwrap() = Some(UploadMoveAttempt {
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
    app: AppHandle,
) -> Result<TransferOutcome> {
    let session = sessions.get(id)?;
    let from_drive = matches!(request.source, TransferSource::GoogleDrive { .. });
    if from_drive
        && (request.moving
            || request.multiple
            || request.kswitcher_broker
            || request.server_destination.is_some()
            || request.ftp_destination.is_some()
            || request.ssh_destination.is_some()
            || request.archive_destination.is_some()
            || request.kswitcher_destination.is_some())
    {
        return Err("Copy one Google Drive file to a local folder.".into());
    }
    if request.server_destination.is_none()
        && request.ftp_destination.is_none()
        && request.ssh_destination.is_none()
        && request.archive_destination.is_none()
        && request.kswitcher_broker
        && matches!(
            &request.source,
            TransferSource::Local { .. } | TransferSource::Kswitcher { .. }
        )
    {
        return session
            .interrupt(transfer_kswitcher(&request, &session, &output))
            .await
            .map(|(outcome, _)| outcome);
    }
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
    let server_destination = request
        .server_destination
        .map(|id| connections.get(id))
        .transpose()?;
    let archive_destination = request
        .archive_destination
        .as_ref()
        .map(|destination| archives.get(destination.id))
        .transpose()?;
    if [
        ftp_destination.is_some(),
        ssh_destination.is_some(),
        server_destination.is_some(),
        archive_destination.is_some(),
        request.kswitcher_destination.is_some(),
    ]
    .into_iter()
    .filter(|present| *present)
    .count()
        > 1
    {
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
            TransferSource::GoogleDrive { name, .. } => format!("Google Drive/{name}"),
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
                TransferSource::Kswitcher { name, .. }
                | TransferSource::GoogleDrive { name, .. } => (name.as_str(), None),
            };
            let mut progress = |path: &Path, bytes, total| {
                session.ensure_running()?;
                report_transfer_progress(&output, path, bytes, total);
                Ok(())
            };
            progress(Path::new(name), 0, None).map_err(message)?;

            let mut ask = |conflict| session.ask(conflict, &output);
            use remote_provider_transfer::{Endpoint, Relay};
            let relay_source: Option<(Endpoint<'_>, &[String])> = match &request.source {
                TransferSource::Ftp { segments, .. } => ftp_source
                    .as_deref()
                    .map(|item| (Endpoint::Ftp(item), segments.as_slice())),
                TransferSource::Ssh { segments, .. } => ssh_source
                    .as_ref()
                    .map(|item| (Endpoint::Ssh(item), segments.as_slice())),
                TransferSource::Server { segments, .. } => connection
                    .as_deref()
                    .map(|item| (Endpoint::Server(item), segments.as_slice())),
                TransferSource::Archive { segments, .. } => archive
                    .as_deref()
                    .map(|item| (Endpoint::Archive(item), segments.as_slice())),
                TransferSource::Kswitcher { peer, name, .. } => {
                    Some((Endpoint::Kswitcher(peer), std::slice::from_ref(name)))
                }
                _ => None,
            };
            let relay_destination = ftp_destination
                .as_deref()
                .map(Endpoint::Ftp)
                .or_else(|| ssh_destination.as_ref().map(Endpoint::Ssh))
                .or_else(|| server_destination.as_deref().map(Endpoint::Server))
                .or_else(|| archive_destination.as_deref().map(Endpoint::Archive))
                .or_else(|| {
                    request
                        .kswitcher_destination
                        .as_deref()
                        .map(Endpoint::Kswitcher)
                });
            if let (Some((source, segments)), Some(destination)) = (relay_source, relay_destination)
            {
                if !matches!(
                    (&source, &destination),
                    (Endpoint::Server(_), Endpoint::Server(_))
                        | (Endpoint::Archive(_), Endpoint::Archive(_))
                ) {
                    return Relay {
                        request: &request,
                        transfer: &session,
                        output: &output,
                    }
                    .run(
                        source,
                        segments,
                        destination,
                        &mut progress,
                        &mut ask,
                    );
                }
            }
            if let Some(destination) = archive_destination {
                if let TransferSource::Archive { segments, .. } = &request.source {
                    let archive = archive.as_ref().ok_or("Open the source archive first.")?;
                    return transfer_archive_member(
                        archive,
                        &destination,
                        segments,
                        &request,
                        progress,
                        ask,
                    );
                }
                let source = source
                    .as_deref()
                    .filter(|_| request.moving)
                    .ok_or("Choose local files or folders to move into the archive.")?;
                actual_source = display(source);
                let mut archive = destination.lock().map_err(message)?;
                return move_local_to_archive(
                    &mut archive,
                    source,
                    name,
                    &request,
                    &session,
                    progress,
                    ask,
                );
            }
            if let Some(destination) = server_destination {
                if let TransferSource::Server {
                    writable_server: true,
                    segments,
                    ..
                } = &request.source
                {
                    if request.moving
                        && connection.as_ref().is_some_and(|server| {
                            server.invitation.certificate == destination.invitation.certificate
                        })
                    {
                        let mut client = lan_transfer::LanTransfer {
                            connection: &destination,
                            transfer: &session,
                        };
                        let target = remote_transfer::upload_destination(
                            &mut client,
                            &request.destination,
                            name,
                            request.multiple,
                        )?;
                        if &target == segments {
                            return Ok(TransferOutcome::Skipped);
                        }
                        use remote_transfer::Session;
                        if request.policy == local_transfer::Policy::Skip
                            && client.stat(&target)?.is_some()
                        {
                            return Ok(TransferOutcome::Skipped);
                        }
                        let result = client.change(
                            segments,
                            crate::protocol::LanChange::Move {
                                destination: target,
                            },
                        );
                        match result {
                            Ok(()) => return Ok(TransferOutcome::Completed),
                            Err(error) if error == crate::protocol::LAN_MOVE_CROSSES_VOLUMES => {}
                            Err(error) => return Err(error),
                        }
                    }
                }
                if let Some(source) = source.as_deref().filter(|_| request.moving) {
                    let mut client = lan_transfer::LanTransfer {
                        connection: &destination,
                        transfer: &session,
                    };
                    let metadata = fs::symlink_metadata(source).map_err(message)?;
                    if metadata.is_dir() && !local::is_link(&metadata) {
                        let target = remote_transfer::upload_destination(
                            &mut client,
                            &request.destination,
                            name,
                            request.multiple,
                        )?;
                        return move_local_folder(
                            &mut client,
                            source,
                            &target,
                            request.policy,
                            &session,
                            &mut progress,
                            &mut ask,
                        );
                    }
                    return move_uploaded_file(
                        &mut client,
                        &request,
                        source,
                        name,
                        &session,
                        &mut progress,
                        &mut ask,
                    );
                }
                let remote_move = if request.moving {
                    let TransferSource::Server {
                        writable_server: true,
                        segments,
                        ..
                    } = &request.source
                    else {
                        return Err(
                            "Choose files or folders on a writable Dirlume share.".to_owned()
                        );
                    };
                    let client = lan_transfer::LanTransfer {
                        connection: connection
                            .as_ref()
                            .ok_or("Connect to the Dirlume share first.")?,
                        transfer: &session,
                    };
                    Some((client, segments))
                } else {
                    None
                };
                let staging;
                let staged;
                let source = if let Some(path) = source.as_deref() {
                    path
                } else {
                    staging = tempfile::tempdir().map_err(message)?;
                    staged = staging
                        .path()
                        .join(local::name_component(name).map_err(message)?);
                    match &request.source {
                        TransferSource::Server {
                            segments,
                            folder,
                            modified,
                            ..
                        } => {
                            let server = connection
                                .as_ref()
                                .ok_or("Connect to the Dirlume server first.")?;
                            if server.invitation.certificate == destination.invitation.certificate {
                                let mut client = lan_transfer::LanTransfer {
                                    connection: &destination,
                                    transfer: &session,
                                };
                                let target = remote_transfer::upload_destination(
                                    &mut client,
                                    &request.destination,
                                    name,
                                    request.multiple,
                                )?;
                                if segments
                                    .iter()
                                    .zip(&target)
                                    .all(|(source, target)| source.eq_ignore_ascii_case(target))
                                    && target.len() >= segments.len()
                                {
                                    return Err(
                                        "Choose a destination outside the source item.".to_owned()
                                    );
                                }
                            }
                            if *folder {
                                server.download_tree(
                                    segments.clone(),
                                    &staged,
                                    &session,
                                    &mut progress,
                                )?;
                            } else {
                                let mut file = fs::File::create_new(&staged).map_err(message)?;
                                server.download_file(
                                    segments.clone(),
                                    &mut file,
                                    &session,
                                    &mut progress,
                                )?;
                                finish_downloaded_file(&file, *modified).map_err(message)?;
                            }
                        }
                        TransferSource::Kswitcher {
                            peer, path, folder, ..
                        } => {
                            if *folder {
                                download_kswitcher_tree(
                                    peer,
                                    path,
                                    &staged,
                                    &session,
                                    &mut progress,
                                )?;
                            } else {
                                let mut file = fs::File::create_new(&staged).map_err(message)?;
                                tauri::async_runtime::block_on(session.interrupt(
                                    crate::kswitcher_lan::download(
                                        peer,
                                        path,
                                        &mut file,
                                        |bytes, total| progress(Path::new(name), bytes, total),
                                    ),
                                ))?;
                            }
                        }
                        _ => return Err("Choose a supported transfer source.".to_owned()),
                    }
                    &staged
                };
                let mut client = lan_transfer::LanTransfer {
                    connection: &destination,
                    transfer: &session,
                };
                if let Some((mut remote, segments)) = remote_move {
                    let cleanup =
                        lan_transfer::MoveCleanup::capture(&mut remote, source, segments)?;
                    let target = remote_transfer::upload_destination(
                        &mut client,
                        &request.destination,
                        name,
                        request.multiple,
                    )?;
                    if !remote_transfer::upload(
                        &mut client,
                        source,
                        &target,
                        request.policy,
                        &mut progress,
                        &mut ask,
                        &mut |_, _| {},
                    )? {
                        return Ok(TransferOutcome::Skipped);
                    }
                    return Ok(cleanup.finish(&remote, segments, format!("/{}", target.join("/"))));
                }
                return upload_remote(
                    client,
                    &request,
                    name,
                    source,
                    &mut progress,
                    &mut ask,
                    &mut committed,
                );
            }
            if ftp_destination.is_some() || ssh_destination.is_some() {
                let protocol = if ssh_destination.is_some() {
                    "SSH"
                } else {
                    "FTP"
                };
                if !matches!(
                    request.policy,
                    local_transfer::Policy::Ask
                        | local_transfer::Policy::Skip
                        | local_transfer::Policy::Overwrite
                ) {
                    return Err(format!("Choose a supported {protocol} copy option."));
                }
                let source = source.as_deref().ok_or_else(|| {
                    format!("Choose a supported source for the {protocol} upload.")
                })?;
                if let Some(connection) = ssh_destination {
                    let mut remote =
                        ssh_transfer::SshTransfer::open(&connection, false, &session, &output)?;
                    if request.moving {
                        let metadata = fs::symlink_metadata(source).map_err(message)?;
                        if metadata.is_dir() && !local::is_link(&metadata) {
                            let target = remote_transfer::upload_destination(
                                &mut remote,
                                &request.destination,
                                name,
                                request.multiple,
                            )?;
                            return move_local_folder(
                                &mut remote,
                                source,
                                &target,
                                request.policy,
                                &session,
                                &mut progress,
                                &mut ask,
                            );
                        }
                        return move_uploaded_file(
                            &mut remote,
                            &request,
                            source,
                            name,
                            &session,
                            &mut progress,
                            &mut ask,
                        );
                    }
                    return upload_remote(
                        remote,
                        &request,
                        name,
                        source,
                        &mut progress,
                        &mut ask,
                        &mut committed,
                    );
                }
                if let Some(connection) = ftp_destination {
                    let mut remote =
                        connection.open_with_cancel(Some(session.cancelled.clone()))?;
                    if request.moving {
                        let metadata = fs::symlink_metadata(source).map_err(message)?;
                        if metadata.is_dir() && !local::is_link(&metadata) {
                            let target = remote_transfer::upload_destination(
                                &mut remote,
                                &request.destination,
                                name,
                                request.multiple,
                            )?;
                            return move_local_folder(
                                &mut remote,
                                source,
                                &target,
                                request.policy,
                                &session,
                                &mut progress,
                                &mut ask,
                            );
                        }
                        return move_uploaded_file(
                            &mut remote,
                            &request,
                            source,
                            name,
                            &session,
                            &mut progress,
                            &mut ask,
                        );
                    }
                    return upload_remote(
                        remote,
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
            let remote_folder = matches!(
                &request.source,
                TransferSource::Server { folder: true, .. }
                    | TransferSource::Kswitcher { folder: true, .. }
            );
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
                        || archive.is_some()
                        || remote_folder
                        || from_drive,
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
                let archive = archive.ok_or("Open the archive first.")?;
                let mut archive = archive.lock().map_err(message)?;
                if request.moving {
                    use crate::archives::MoveOutcome;
                    return archive
                        .move_to(segments, &target, &options, progress, ask, committed)
                        .map(|outcome| match outcome {
                            MoveOutcome::Completed => TransferOutcome::Completed,
                            MoveOutcome::Skipped => TransferOutcome::Skipped,
                            MoveOutcome::SourceRetained(error) => TransferOutcome::SourceRetained {
                                destination: display(&target),
                                source: format!("/{}", segments.join("/")),
                                error,
                            },
                        });
                }
                return archive
                    .copy_to(segments, &target, &options, progress, ask, committed)
                    .map(transfer_outcome);
            }
            if let TransferSource::Ftp { segments, .. } = &request.source {
                let mut ftp = ftp_source
                    .ok_or("Connect to the FTP server first.")?
                    .open_with_cancel(Some(session.cancelled.clone()))?;
                if request.moving {
                    return move_ftp_to_local(
                        &mut ftp, segments, &target, &session, &options, progress, ask,
                    );
                }
                return remote_transfer::download(
                    &mut ftp, segments, &target, &options, progress, ask, committed,
                )
                .map(transfer_outcome);
            }
            if let Some(connection) = ssh_source {
                if let TransferSource::Ssh { segments, .. } = &request.source {
                    let mut remote =
                        ssh_transfer::SshTransfer::open(&connection, true, &session, &output)?;
                    if request.moving {
                        return remote.move_to_local(segments, &target, &options, progress, ask);
                    }
                    return remote_transfer::download(
                        &mut remote,
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

            match request.source {
                TransferSource::GoogleDrive {
                    profile,
                    item,
                    name,
                } => copy_downloaded_item(
                    &target,
                    &session,
                    &options,
                    progress,
                    ask,
                    |staged, progress| {
                        let modified = tauri::async_runtime::block_on(session.interrupt(
                            crate::google_drive::download(
                                &app,
                                profile,
                                &item,
                                staged,
                                |bytes, total| progress(Path::new(&name), bytes, total),
                            ),
                        ))?;
                        let file = fs::File::options()
                            .write(true)
                            .open(staged)
                            .map_err(message)?;
                        finish_downloaded_file(&file, modified).map_err(message)
                    },
                ),
                TransferSource::Server {
                    segments,
                    folder,
                    modified,
                    writable_server,
                    ..
                } => {
                    if request.moving && !writable_server {
                        return Err("This source is read-only.".to_owned());
                    }
                    let connection = connection.ok_or("Connect to the server first.")?;
                    if folder && !request.moving {
                        return connection
                            .copy_folder(segments, &target, &session, &options, progress, ask);
                    }
                    let mut client = lan_transfer::LanTransfer {
                        connection: &connection,
                        transfer: &session,
                    };
                    let mut cleanup = None;
                    let outcome = copy_downloaded_item(
                        &target,
                        &session,
                        &options,
                        progress,
                        ask,
                        |staged, progress| {
                            if folder {
                                connection.download_tree(
                                    segments.clone(),
                                    staged,
                                    &session,
                                    progress,
                                )?;
                            } else {
                                let mut file = fs::File::create_new(staged).map_err(message)?;
                                connection.download_file(
                                    segments.clone(),
                                    &mut file,
                                    &session,
                                    progress,
                                )?;
                                finish_downloaded_file(&file, modified).map_err(message)?;
                            }
                            if request.moving {
                                cleanup = Some(lan_transfer::MoveCleanup::capture(
                                    &mut client,
                                    staged,
                                    &segments,
                                )?);
                            }
                            Ok(())
                        },
                    )?;
                    if matches!(outcome, TransferOutcome::Completed) {
                        if let Some(cleanup) = cleanup {
                            return Ok(cleanup.finish(&client, &segments, display(&target)));
                        }
                    }
                    Ok(outcome)
                }
                TransferSource::Kswitcher {
                    peer,
                    path,
                    folder,
                    name,
                    modified,
                } => {
                    if request.moving {
                        return Err("This source is read-only.".to_owned());
                    }
                    copy_downloaded_item(
                        &target,
                        &session,
                        &options,
                        progress,
                        ask,
                        |staged, progress| {
                            if folder {
                                return download_kswitcher_tree(
                                    &peer, &path, staged, &session, progress,
                                );
                            }
                            let mut file = fs::File::create_new(staged).map_err(message)?;
                            tauri::async_runtime::block_on(session.interrupt(
                                crate::kswitcher_lan::download(
                                    &peer,
                                    &path,
                                    &mut file,
                                    |bytes, total| progress(Path::new(&name), bytes, total),
                                ),
                            ))?;
                            finish_downloaded_file(&file, modified).map_err(message)
                        },
                    )
                }
                _ => Err("Choose a supported transfer source.".to_owned()),
            }
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

async fn transfer_kswitcher(
    request: &TransferRequest,
    session: &Arc<TransferSession>,
    output: &Channel<TransferEvent>,
) -> Result<(TransferOutcome, PathBuf)> {
    use crate::kswitcher_lan::Endpoint;
    use local_transfer::Policy;
    if request.ftp_destination.is_some()
        || request.ssh_destination.is_some()
        || request.server_destination.is_some()
        || request.archive_destination.is_some()
    {
        return Err("Choose a local or KSwitcher LAN destination.".into());
    }
    let (source_peer, source_path, name) = match &request.source {
        TransferSource::Local { directory, name } => (
            None,
            Path::new(directory).join(local::name_component(name).map_err(message)?),
            name.as_str(),
        ),
        TransferSource::Kswitcher {
            peer, path, name, ..
        } => (Some(peer.as_str()), PathBuf::from(path), name.as_str()),
        _ => return Err("Choose a local or KSwitcher LAN source.".into()),
    };
    let target_peer = request.kswitcher_destination.as_deref();
    let target_path = if let Some(peer) = target_peer {
        let destination = Path::new(&request.destination);
        if crate::kswitcher_lan::destination_is_folder(peer, destination).await? {
            destination.join(local::name_component(name).map_err(message)?)
        } else if request.multiple || request.destination.ends_with(std::path::is_separator) {
            return Err("The destination folder does not exist.".into());
        } else {
            destination.to_path_buf()
        }
    } else {
        transfer_target(
            &request.destination,
            name,
            Some(&source_path),
            request.multiple,
            true,
        )
        .map_err(message)?
    };
    let source = Endpoint {
        peer: source_peer,
        path: source_path.to_str().ok_or("Choose a valid source.")?,
    };
    let target = Endpoint {
        peer: target_peer,
        path: target_path
            .to_str()
            .ok_or("Choose an absolute destination.")?,
    };
    let conflict = match request.policy {
        Policy::Ask => {
            let peer = source_peer
                .or(target_peer)
                .ok_or("Choose a KSwitcher LAN location.")?;
            if crate::kswitcher_lan::capabilities(peer)
                .await?
                .conflict_prompt
            {
                "ask"
            } else {
                "fail"
            }
        }
        Policy::Skip => "skip",
        Policy::Overwrite => "replace",
        _ => return Err("Choose a supported KSwitcher copy option.".into()),
    };
    let result = crate::kswitcher_lan::transfer(
        source,
        target,
        request.moving,
        conflict,
        |path, bytes, total| {
            session.ensure_running()?;
            report_transfer_progress(output, Path::new(path), bytes, Some(total));
            Ok(())
        },
        |collision| {
            let session = Arc::clone(session);
            let output = output.clone();
            let details = |file: crate::kswitcher_lan::TransferMetadata| {
                let modified =
                    file.modified
                        .checked_sub(116_444_736_000_000_000)
                        .and_then(|ticks| {
                            UNIX_EPOCH.checked_add(Duration::from_secs(ticks / 10_000_000))
                        });
                const DIRECTORY: u32 = 0x10;
                local_transfer::EntryDetails::network(
                    Some(file.size),
                    modified,
                    file.attributes & DIRECTORY != 0,
                )
            };
            const READ_ONLY: u32 = 0x01;
            let read_only = collision.existing.attributes & READ_ONLY != 0;
            let prompt = local_transfer::Conflict::paired(
                collision.path,
                details(collision.incoming),
                details(collision.existing),
                collision.replaceable,
                read_only,
            );
            blocking(move || session.ask(prompt, &output).map_err(message))
        },
    )
    .await?;
    let outcome = match result {
        crate::kswitcher_lan::TransferResult::Finished(copied) => transfer_outcome(copied),
        crate::kswitcher_lan::TransferResult::SourceCleanupFailed(error) => {
            TransferOutcome::SourceRetained {
                destination: target_path.to_string_lossy().into_owned(),
                source: source_path.to_string_lossy().into_owned(),
                error,
            }
        }
    };
    Ok((outcome, target_path))
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
    writable: bool,
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
    sharing: State<'_, crate::desktop_share::DesktopShare>,
) -> Result<Vec<crate::server::ComputerDrive>> {
    let invitation = read_server_invitation(credential).await?;
    let connection = Connection::connect(&invitation)?;
    sharing.check_pairing_target(&connection.invitation).await?;
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

#[tauri::command]
async fn list_lan_group_drives(
    peer: String,
    sharing: State<'_, crate::desktop_share::DesktopShare>,
) -> Result<Vec<crate::server::ComputerDrive>> {
    let invitation = sharing.group_invitation(&peer).await?;
    computer_drive_metadata(&Connection::connect(&invitation)?).await
}

#[tauri::command]
async fn connect_lan_group_peer(
    peer: String,
    segments: Vec<String>,
    sharing: State<'_, crate::desktop_share::DesktopShare>,
    state: State<'_, Connections>,
) -> Result<Connected> {
    let invitation = sharing.group_invitation(&peer).await?;
    open_server(&invitation, segments, &state).await
}

#[tauri::command]
async fn change_lan_item(
    id: u32,
    segments: Vec<String>,
    change: crate::protocol::LanChange,
    state: State<'_, Connections>,
) -> Result<()> {
    let connection = state.get(id)?;
    let action = crate::protocol::LanChangeRequest { segments, change };
    let response = connection
        .request("v1/lan/change", action, Duration::from_secs(15))
        .await?;
    serde_json::from_slice::<Result<()>>(&collect_response(response, 8 * 1024).await?)
        .map_err(message)?
}

#[tauri::command]
async fn save_lan_text(
    id: u32,
    segments: Vec<String>,
    revision: String,
    text: String,
    state: State<'_, Connections>,
) -> Result<String> {
    if text.len() as u64 > TEXT_LIMIT {
        return Err("The file is too large to edit in this remote editor.".to_owned());
    }
    let connection = state.get(id)?;
    let request = crate::protocol::LanTextSave {
        segments,
        revision,
        text,
    };
    let response = connection
        .request("v1/lan/save-text", request, Duration::from_secs(45))
        .await?;
    serde_json::from_slice::<Result<String>>(&collect_response(response, 8 * 1024).await?)
        .map_err(message)?
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
async fn verify_computer_pairing(
    invitation: String,
    sharing: State<'_, crate::desktop_share::DesktopShare>,
) -> Result<String> {
    let invitation = zeroize::Zeroizing::new(invitation);
    let connection = Connection::connect(&invitation)?;
    sharing.check_pairing_target(&connection.invitation).await?;
    let response = connection
        .request("v1/drives", (), Duration::from_secs(5))
        .await?;
    Ok(pairing_computer_name(&connection, &response))
}

fn pairing_computer_name(connection: &Connection, response: &Response) -> String {
    response
        .headers()
        .get(crate::protocol::COMPUTER_NAME_HEADER)
        .filter(|value| value.len() <= 340)
        .and_then(|value| URL_SAFE_NO_PAD.decode(value.as_bytes()).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .filter(|name| !name.trim().is_empty() && !name.chars().any(char::is_control))
        .unwrap_or_else(|| {
            connection
                .invitation
                .address
                .host_str()
                .unwrap_or_default()
                .to_owned()
        })
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
    let (listing, writable) = connection.list_with_access(segments).await?;
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
        writable,
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

#[cfg(test)]
mod server_download_tests {
    use super::*;
    use std::{net::TcpListener, thread};

    #[tokio::test]
    async fn copies_a_paired_computers_folder_into_an_existing_local_folder() {
        let source = tempfile::tempdir().unwrap();
        let published = source.path().join("project");
        fs::create_dir_all(published.join("nested/empty")).unwrap();
        fs::write(published.join("nested/report.txt"), "remote").unwrap();
        let destination = tempfile::tempdir().unwrap();
        let target = destination.path().join("project");
        fs::create_dir_all(target.join("nested")).unwrap();
        fs::write(target.join("nested/report.txt"), "local").unwrap();
        fs::write(target.join("keep.txt"), "unchanged").unwrap();

        let root = source.path().to_owned();
        let mut host = crate::server::DesktopServer::start_computer(
            move || vec![("Drive".into(), root.clone())],
            "127.0.0.1".parse().unwrap(),
        )
        .await
        .unwrap();
        let guest = Connection::connect(&host.invitation).unwrap();
        let copied = tokio::task::spawn_blocking(move || {
            let options = local_transfer::Options {
                moving: false,
                policy: local_transfer::Policy::Overwrite,
                ask_read_only: false,
                copy: local::CopyOptions::default(),
            };
            guest.copy_folder(
                vec!["Drive".into(), "project".into()],
                &target,
                &TransferSession::default(),
                &options,
                |_, _, _| Ok(()),
                |_| panic!("Overwrite should not prompt for a conflict"),
            )
        })
        .await
        .unwrap()
        .unwrap();
        assert!(matches!(copied, TransferOutcome::Completed));
        let target = destination.path().join("project");
        assert!(target.join("nested/empty").is_dir());
        assert_eq!(
            fs::read_to_string(target.join("nested/report.txt")).unwrap(),
            "remote"
        );
        assert_eq!(
            fs::read_to_string(target.join("keep.txt")).unwrap(),
            "unchanged"
        );
        assert!(published.join("nested/report.txt").is_file());
        host.stop().await.unwrap();
    }

    #[tokio::test]
    async fn desktop_computer_share_lists_and_opens_separate_drive_roots() {
        let fixture = tempfile::tempdir().unwrap();
        let first = fixture.path().join("first");
        let second = fixture.path().join("second");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        fs::write(first.join("first.txt"), "first drive").unwrap();
        fs::write(second.join("second.txt"), "second drive").unwrap();
        let roots = Arc::new(Mutex::new(vec![("C:".into(), first)]));
        let host_roots = Arc::clone(&roots);
        let ip = "127.0.0.1".parse().unwrap();
        let mut host = crate::server::DesktopServer::start_computer(
            move || host_roots.lock().unwrap().clone(),
            ip,
        )
        .await
        .unwrap();
        let guest = Connection::connect(&host.invitation).unwrap();
        let response = guest
            .request("v1/drives", (), Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(
            pairing_computer_name(&guest, &response),
            crate::protocol::computer_name().unwrap_or_else(|| "127.0.0.1".into())
        );
        let drives: serde_json::Value =
            serde_json::from_slice(&collect_response(response, 4096).await.unwrap()).unwrap();
        assert_eq!(drives[0]["name"], "C:");
        assert_eq!(drives.as_array().unwrap().len(), 1);
        assert!(drives[0]["total"].as_u64().is_some_and(|total| total > 0));
        roots.lock().unwrap().push(("D:".into(), second));
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
        roots.lock().unwrap().retain(|(drive, _)| drive != "C:");
        assert_eq!(guest.list(Vec::new()).await.unwrap().entries[0].name, "D:");
        assert_eq!(
            guest.list(vec!["C:".into()]).await.err().as_deref(),
            Some("The requested remote drive, folder, or file is unavailable.")
        );
        assert!(guest.list(vec!["D:".into()]).await.is_ok());
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
                    let options = local_transfer::Options {
                        moving: false,
                        policy: local_transfer::Policy::Ask,
                        ask_read_only: true,
                        copy: local::CopyOptions::default(),
                    };
                    let downloaded = copy_downloaded_item(
                        &destination,
                        &session,
                        &options,
                        |_, bytes, _| {
                            if bytes == 0 {
                                let _ = received_headers.try_send(());
                            } else {
                                let _ = received_chunk.try_send(bytes);
                            }
                            Ok(())
                        },
                        |_| panic!("No destination was published"),
                        |staged, progress| {
                            let mut file = fs::File::create_new(staged).map_err(message)?;
                            connection.download_file(
                                vec!["download.bin".into()],
                                &mut file,
                                &session,
                                progress,
                            )
                        },
                    );
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
            assert!(matches!(cancelled.unwrap(), Err(error) if error == "Transfer canceled."));
            transfer.join().unwrap();
            assert!(!destination.exists());
            assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
        }
    }
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
    use crate::text_format::DecodeError;
    let (text, encoding) = crate::text_format::decode(bytes).map_err(|error| match error {
        DecodeError::Unsupported(message) => {
            TextReadFailure::new(ReadStage::Decode, ReadReason::UnsupportedEncoding, message)
        }
        DecodeError::Binary => TextReadFailure::new(
            ReadStage::Decode,
            ReadReason::BinaryContent,
            "The file contains binary data.",
        ),
    })?;
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
    let mut document = decode_text(bytes.as_slice())?;
    document.revision = Some(crate::protocol::lan_text_revision(&bytes));
    Ok(document)
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
    sudo_password: Option<String>,
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
            let password = sudo_password.map(zeroize::Zeroizing::new);
            blocking(move || {
                connection.text_operation(password, true, |session| {
                    let entry = session.regular(&segments)?;
                    let length = remote_transfer::Entry::size(&entry)
                        .ok_or("The SSH server did not report the file size.")?;
                    check_preview_image_size(length)?;
                    let bytes = session.read_limited(&segments, 0, length)?;
                    if session.regular(&segments)? != entry {
                        return Err("The SSH file changed during the read.".into());
                    }
                    Ok(bytes)
                })
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

#[tauri::command]
async fn create_ftp_text_file(
    id: u32,
    segments: Vec<String>,
    encoding: Encoding,
    state: State<'_, ftp::FtpState>,
) -> Result<()> {
    let connection = state.connection(id)?;
    blocking(move || {
        connection
            .open()?
            .create_file(&segments, &encode_text(encoding, ""))
    })
    .await
}

#[tauri::command]
async fn create_ssh_text_file(
    id: u32,
    segments: Vec<String>,
    encoding: Encoding,
    sudo_password: Option<String>,
    state: State<'_, ssh::SshState>,
) -> Result<()> {
    let connection = state.connection(id)?;
    let password = sudo_password.map(zeroize::Zeroizing::new);
    blocking(move || {
        let bytes = encode_text(encoding, "");
        connection.text_operation(password, false, |session| {
            session.create_file(&segments, &bytes)
        })
    })
    .await
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
    sudo_password: Option<String>,
    state: State<'_, ssh::SshState>,
) -> Result<BytePage> {
    let connection = state.connection(id)?;
    let password = sudo_password.map(zeroize::Zeroizing::new);
    blocking(move || {
        connection.text_operation(password, true, |session| {
            let before = session.regular(&segments)?;
            let length = remote_transfer::Entry::size(&before)
                .ok_or("The SSH server did not report the file size.")?;
            let data = session.read_limited(
                &segments,
                offset.min(length),
                crate::protocol::BYTE_PAGE_SIZE.min(length.saturating_sub(offset)),
            )?;
            if session.regular(&segments)? != before {
                return Err("The SSH file changed during the read.".into());
            }
            Ok(BytePage { length, data })
        })
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
        let staged =
            session.upload_to_stage(&segments, &mut std::io::Cursor::new(&buffer), |_| Ok(()))?;
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

#[tauri::command]
async fn kswitcher_capabilities(peer: String) -> Result<crate::kswitcher_lan::Capabilities> {
    crate::kswitcher_lan::capabilities(&peer).await
}

#[tauri::command]
async fn change_kswitcher(
    peer: String,
    path: String,
    change: crate::kswitcher_lan::Change,
) -> Result<()> {
    crate::kswitcher_lan::change(&peer, &path, change).await
}

#[tauri::command]
async fn read_kswitcher_text(peer: String, path: String) -> Result<TextDocument> {
    crate::kswitcher_lan::read_text(&peer, &path).await
}

#[tauri::command]
async fn read_kswitcher_preview(peer: String, path: String) -> Result<tauri::ipc::Response> {
    let bytes = crate::kswitcher_lan::preview(&peer, &path).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn read_kswitcher_bytes(peer: String, path: String, offset: u64) -> Result<BytePage> {
    let bytes = crate::kswitcher_lan::preview(&peer, &path).await?;
    let length = bytes.len() as u64;
    let data = bytes
        .into_iter()
        .skip(offset.min(length) as usize)
        .take(crate::protocol::BYTE_PAGE_SIZE as usize)
        .collect();
    Ok(BytePage { length, data })
}

#[tauri::command]
async fn save_kswitcher_text(
    peer: String,
    path: String,
    revision: String,
    text: String,
    encoding: Encoding,
) -> Result<TextDocument> {
    crate::kswitcher_lan::save_text(&peer, &path, &revision, text, encoding).await
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
        .manage(crate::desktop_share::DesktopShare::new(
            &context.config().identifier,
        ))
        .manage(crate::archives::Archives::default())
        .manage(crate::archive_create::ArchiveJobs::default())
        .manage(crate::deletion::DeleteJobs::default())
        .manage(ftp::FtpState::default())
        .manage(crate::google_drive::DriveState::default())
        .manage(ssh::SshState::default())
        .manage(crate::netbox_connection::Requests::default())
        .manage(TransferSessions::default())
        .manage(crate::file_history::History::default())
        .manage(terminal::Terminals::default())
        .manage(crate::user_menu::UserMenus::default())
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
    let builder = builder.setup(|app| {
        #[cfg(windows)]
        if let Some(window) = tauri::Manager::get_webview_window(app, "main") {
            window.set_decorations(false)?;
        }
        #[cfg(windows)]
        crate::windows_environment::attach(app.handle());
        crate::desktop_share::restore_group_on_start(app.handle());
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
        crate::folders::prepare_collection_folders,
        crate::desktop_share::active_desktop_share,
        crate::desktop_share::lan_group_status,
        crate::desktop_share::set_lan_group_writable,
        crate::desktop_share::start_lan_group,
        crate::desktop_share::copy_lan_group_code,
        crate::desktop_share::list_lan_group_peers,
        crate::desktop_share::leave_lan_group,
        list_lan_group_drives,
        connect_lan_group_peer,
        change_lan_item,
        save_lan_text,
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
        crate::google_drive::google_drive_profiles,
        crate::google_drive::sign_in_google_drive,
        crate::google_drive::cancel_google_drive_sign_in,
        crate::google_drive::rename_google_drive,
        crate::google_drive::remove_google_drive,
        crate::google_drive::list_google_drive,
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
        ftp::create_ftp_folder,
        create_ftp_text_file,
        ftp::delete_ftp,
        ssh::profiles::ssh_profiles,
        ssh::profiles::save_ssh_profile,
        ssh::profiles::remove_ssh_profile,
        ssh::connect_ssh,
        ssh::test_ssh_connection,
        ssh::disconnect_ssh,
        ssh::list_ssh,
        delete_ssh,
        ssh::create_ssh_folder,
        ssh::rename_ssh,
        create_ssh_text_file,
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
        kswitcher_capabilities,
        change_kswitcher,
        read_kswitcher_text,
        read_kswitcher_preview,
        read_kswitcher_bytes,
        save_kswitcher_text,
        begin_transfer,
        crate::file_history::file_operation_history,
        crate::file_history::reverse_file_operation,
        crate::deletion::delete_selection,
        crate::deletion::cancel_deletion,
        crate::deletion::resolve_deletion,
        cancel_transfer,
        finish_transfer,
        resolve_transfer,
        authorize_transfer_sudo,
        decline_transfer_sudo,
        transfer_item,
        terminal::open_terminal,
        crate::user_menu::user_menu_sources,
        crate::user_menu::approve_user_menu,
        crate::user_menu::save_user_menu,
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
