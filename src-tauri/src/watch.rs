use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{ipc::Channel, State};

use crate::{
    desktop::{blocking, message, Result},
    local,
};

#[derive(Default)]
pub struct Watches(Mutex<HashMap<u32, RecommendedWatcher>>);

#[derive(Default)]
pub struct Measurements(Mutex<HashMap<u32, Arc<AtomicBool>>>);

#[derive(Clone, Serialize)]
pub struct SizeResult {
    name: String,
    bytes: u64,
    incomplete: bool,
}

#[tauri::command]
pub async fn measure_folders(
    id: u32,
    directory: String,
    names: Vec<String>,
    output: Channel<SizeResult>,
    state: State<'_, Measurements>,
) -> Result<()> {
    let stop = Arc::new(AtomicBool::new(false));
    state
        .0
        .lock()
        .map_err(message)?
        .insert(id, Arc::clone(&stop));
    let result = blocking(move || {
        let directory = local::absolute(&directory).map_err(message)?;
        let paths = names
            .iter()
            .map(|name| local::name_component(name).map(|part| directory.join(part)))
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(message)?;
        for (name, path) in names.into_iter().zip(paths) {
            let Some((bytes, incomplete)) = local::folder_size(&path, &stop) else {
                break;
            };
            let _ = output.send(SizeResult {
                name,
                bytes,
                incomplete,
            });
        }
        Ok(())
    })
    .await;
    state.0.lock().map_err(message)?.remove(&id);
    result
}

#[tauri::command]
pub fn cancel_measurement(id: u32, state: State<'_, Measurements>) -> Result<()> {
    if let Some(flag) = state.0.lock().map_err(message)?.get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub async fn watch_directory(
    id: u32,
    path: String,
    changes: Channel<()>,
    state: State<'_, Watches>,
) -> Result<()> {
    let watcher = blocking(move || {
        let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
            if event.is_ok_and(|event| !matches!(event.kind, EventKind::Access(_))) {
                let _ = changes.send(());
            }
        })
        .map_err(message)?;
        watcher
            .watch(
                local::absolute(&path).map_err(message)?,
                RecursiveMode::NonRecursive,
            )
            .map_err(message)?;
        Ok(watcher)
    })
    .await?;
    state.0.lock().map_err(message)?.insert(id, watcher);
    Ok(())
}

#[tauri::command]
pub async fn unwatch_directory(id: u32, state: State<'_, Watches>) -> Result<()> {
    let watcher = state.0.lock().map_err(message)?.remove(&id);
    blocking(move || {
        drop(watcher);
        Ok(())
    })
    .await
}
