use std::{fs, path::PathBuf, sync::Mutex};

use clipboard_rs::{Clipboard, ClipboardContext};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{
    desktop::{blocking, message, Result},
    local,
};

#[derive(Default)]
pub struct FileClipboard(Mutex<Option<ClipboardContext>>);

#[derive(Deserialize)]
pub struct ClipboardPath {
    pub directory: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct ClipboardItem {
    directory: String,
    entry: local::Entry,
}

fn with_clipboard<T>(
    app: &AppHandle,
    operation: impl FnOnce(&ClipboardContext) -> Result<T>,
) -> Result<T> {
    let state = app.state::<FileClipboard>();
    let mut context = state.0.lock().map_err(message)?;
    if context.is_none() {
        *context = Some(ClipboardContext::new().map_err(message)?);
    }
    operation(context.as_ref().expect("clipboard initialized"))
}

#[tauri::command]
pub async fn copy_path(path: String, app: AppHandle) -> Result<()> {
    blocking(move || with_clipboard(&app, |clipboard| clipboard.set_text(path).map_err(message)))
        .await
}

#[tauri::command]
pub async fn copy_file_references(items: Vec<ClipboardPath>, app: AppHandle) -> Result<()> {
    blocking(move || {
        let paths = items
            .iter()
            .map(|item| {
                let directory = local::absolute(&item.directory).map_err(message)?;
                let path = directory.join(local::name_component(&item.name).map_err(message)?);
                fs::symlink_metadata(&path).map_err(message)?;
                local::display_path(&path).map_err(message)
            })
            .collect::<Result<Vec<_>>>()?;
        if paths.is_empty() {
            return Err("Choose files to copy.".to_owned());
        }
        with_clipboard(&app, |clipboard| {
            clipboard.set_files(paths).map_err(message)
        })
    })
    .await
}

#[tauri::command]
pub async fn clipboard_files(app: AppHandle) -> Result<Vec<ClipboardItem>> {
    blocking(move || {
        let files = with_clipboard(&app, |clipboard| clipboard.get_files().map_err(message))?;
        files
            .into_iter()
            .map(|name| {
                let path = if name.starts_with("file:") {
                    url::Url::parse(&name)
                        .map_err(message)?
                        .to_file_path()
                        .map_err(|()| "The clipboard contains an invalid file path.".to_owned())?
                } else {
                    PathBuf::from(local::absolute(&name).map_err(message)?)
                };
                describe_path(&path, "The clipboard item has no containing folder.")
            })
            .collect()
    })
    .await
}

fn describe_path(path: &std::path::Path, parent_error: &str) -> Result<ClipboardItem> {
    let directory = path.parent().ok_or(parent_error)?;
    Ok(ClipboardItem {
        directory: local::display_path(directory).map_err(message)?,
        entry: local::describe_entry(path).map_err(message)?,
    })
}

#[tauri::command]
pub async fn dropped_files(paths: Vec<String>) -> Result<Vec<ClipboardItem>> {
    blocking(move || {
        let mut seen = std::collections::HashSet::new();
        paths
            .into_iter()
            .filter(|path| seen.insert(path.clone()))
            .map(|path| {
                let path = local::absolute(&path).map_err(message)?;
                describe_path(path, "The dropped item has no containing folder.")
            })
            .collect()
    })
    .await
}
