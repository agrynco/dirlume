use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, State};

use crate::{
    desktop::{blocking, message, Result},
    ftp, local,
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

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MeasurementSource {
    Local {
        directory: String,
    },
    Ftp {
        connection: u32,
        segments: Vec<String>,
    },
}

#[tauri::command]
pub async fn measure_folders(
    id: u32,
    source: MeasurementSource,
    names: Vec<String>,
    output: Channel<SizeResult>,
    state: State<'_, Measurements>,
    ftp_state: State<'_, ftp::FtpState>,
) -> Result<()> {
    let connection = match &source {
        MeasurementSource::Ftp { connection, .. } => Some(ftp_state.connection(*connection)?),
        MeasurementSource::Local { .. } => None,
    };
    let stop = Arc::new(AtomicBool::new(false));
    state
        .0
        .lock()
        .map_err(message)?
        .insert(id, Arc::clone(&stop));
    let result = blocking(move || {
        match source {
            MeasurementSource::Local { directory } => {
                let directory = local::absolute(&directory).map_err(message)?;
                for name in &names {
                    local::name_component(name).map_err(message)?;
                }
                report_sizes(names, &output, |name| {
                    local::folder_size(&directory.join(name), &stop)
                });
            }
            MeasurementSource::Ftp { segments, .. } => {
                let mut ftp = connection
                    .ok_or("Connect to the FTP server first.")?
                    .open()?;
                report_sizes(names, &output, |name| {
                    ftp.folder_size(&ftp::child(&segments, name), &stop)
                });
            }
        }
        Ok(())
    })
    .await;
    state.0.lock().map_err(message)?.remove(&id);
    result
}

fn report_sizes(
    names: Vec<String>,
    output: &Channel<SizeResult>,
    mut measure: impl FnMut(&str) -> Option<(u64, bool)>,
) {
    for name in names {
        let Some((bytes, incomplete)) = measure(&name) else {
            break;
        };
        let _ = output.send(SizeResult {
            name,
            bytes,
            incomplete,
        });
    }
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
