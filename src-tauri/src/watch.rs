use std::{
    collections::HashMap,
    ffi::OsStr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, State};
use tokio_util::sync::CancellationToken;

use crate::{
    desktop::{blocking, message, Result},
    diagnostics::{failure, FailureCode},
    ftp, local, space_analyzer,
};

#[derive(Default)]
pub struct Watches(Mutex<HashMap<u32, RecommendedWatcher>>);

#[derive(Default)]
pub struct Measurements(Mutex<HashMap<u32, Arc<MeasurementStop>>>);

#[derive(Default)]
struct MeasurementStop {
    local: AtomicBool,
    remote: CancellationToken,
}

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
    let stop = Arc::new(MeasurementStop::default());
    state
        .0
        .lock()
        .map_err(message)?
        .insert(id, Arc::clone(&stop));
    let result = blocking(move || {
        let reported_incomplete = AtomicBool::new(false);
        match source {
            MeasurementSource::Local { directory } => {
                let directory = local::absolute(&directory).map_err(message)?;
                for name in &names {
                    local::name_component(name).map_err(message)?;
                }
                let workers = names.len().min(2);
                let names = Mutex::new(names.into_iter());
                thread::scope(|scope| {
                    for _ in 0..workers {
                        scope.spawn(|| {
                            let pending = std::iter::from_fn(|| names.lock().ok()?.next());
                            report_sizes(pending, &output, &reported_incomplete, |name| {
                                space_analyzer::measure_folder(&directory.join(name), &stop.local)
                            });
                        });
                    }
                });
            }
            MeasurementSource::Ftp { segments, .. } => {
                let mut ftp = connection
                    .ok_or("Connect to the FTP server first.")?
                    .open_with_cancel(Some(stop.remote.clone()))?;
                report_sizes(names, &output, &reported_incomplete, |name| {
                    ftp.folder_size(&ftp::child(&segments, name), &stop.local)
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
    names: impl IntoIterator<Item = String>,
    output: &Channel<SizeResult>,
    reported_incomplete: &AtomicBool,
    mut measure: impl FnMut(&str) -> Option<(u64, bool)>,
) {
    for name in names {
        let Some((bytes, incomplete)) = measure(&name) else {
            break;
        };
        if incomplete && !reported_incomplete.swap(true, Ordering::Relaxed) {
            failure("measure_sizes", FailureCode::Incomplete, None);
        }
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
        flag.local.store(true, Ordering::Relaxed);
        flag.remote.cancel();
    }
    Ok(())
}

#[tauri::command]
pub async fn watch_directory(
    id: u32,
    path: String,
    name: Option<String>,
    recursive: Option<bool>,
    changes: Channel<()>,
    state: State<'_, Watches>,
) -> Result<()> {
    let watcher = blocking(move || {
        let directory = local::absolute(&path).map_err(message)?;
        if let Some(name) = &name {
            local::name_component(name).map_err(message)?;
        }
        let watched = directory.to_owned();
        let recursive = recursive.unwrap_or(false);
        let mut watcher = RecommendedWatcher::new(
            move |event: notify::Result<Event>| match event {
                Ok(event)
                    if !matches!(event.kind, EventKind::Access(_))
                        && name.as_deref().is_none_or(|name| {
                            // The parent stays watched when a save replaces the file at this name.
                            event.need_rescan()
                                || event.paths.is_empty()
                                || event.paths.iter().any(|path| {
                                    path == &watched || path.file_name() == Some(OsStr::new(name))
                                })
                        }) =>
                {
                    let _ = changes.send(());
                }
                Err(_) => failure("watch_events", FailureCode::Io, None),
                _ => {}
            },
            notify::Config::default().with_follow_symlinks(!recursive),
        )
        .map_err(message)?;
        watcher
            .watch(
                directory,
                if recursive {
                    RecursiveMode::Recursive
                } else {
                    RecursiveMode::NonRecursive
                },
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
