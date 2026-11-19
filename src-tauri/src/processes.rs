use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

use crate::desktop::{blocking, message, Result};

#[derive(Default)]
pub struct ProcessMonitor {
    system: Mutex<Option<System>>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessId {
    pub pid: u32,
    pub started: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    #[serde(flatten)]
    pub id: ProcessId,
    pub name: String,
    pub cpu: f32,
    pub memory: u64,
    pub executable: Option<String>,
    pub can_terminate: bool,
}

impl From<&sysinfo::Process> for ProcessInfo {
    fn from(process: &sysinfo::Process) -> Self {
        let pid = process.pid().as_u32();
        Self {
            id: ProcessId {
                pid,
                started: process.start_time(),
            },
            name: process.name().to_string_lossy().into_owned(),
            cpu: process.cpu_usage(),
            memory: process.memory(),
            executable: process
                .exe()
                .filter(|path| path.is_absolute())
                .map(|path| path.to_string_lossy().into_owned()),
            can_terminate: terminable(pid),
        }
    }
}

fn terminable(pid: u32) -> bool {
    pid > 4 && pid != std::process::id()
}

fn refresh(
    app: &tauri::AppHandle,
    selection: ProcessesToUpdate<'_>,
    collect: impl FnOnce(&System) -> Vec<ProcessInfo>,
) -> Result<Vec<ProcessInfo>> {
    use tauri::Manager;
    let state = app.state::<ProcessMonitor>();
    let mut slot = state.system.lock().map_err(message)?;
    if slot.is_none() {
        *slot = Some(System::new().map_err(message)?);
    }
    let system = slot.as_mut().expect("process monitor initialized");
    system.refresh_processes_specifics(
        selection,
        true,
        ProcessRefreshKind::nothing()
            .with_cpu()
            .with_memory()
            .with_exe(sysinfo::UpdateKind::OnlyIfNotSet),
    );
    Ok(collect(system))
}

#[tauri::command]
pub async fn list_processes(app: tauri::AppHandle) -> Result<Vec<ProcessInfo>> {
    blocking(move || {
        refresh(&app, ProcessesToUpdate::All, |system| {
            system.processes().values().map(ProcessInfo::from).collect()
        })
    })
    .await
}

#[cfg(windows)]
pub fn refresh_lock_owners(
    app: &tauri::AppHandle,
    owners: Vec<ProcessInfo>,
) -> Result<Vec<ProcessInfo>> {
    if owners.is_empty() {
        return Ok(owners);
    }
    let pids: Vec<_> = owners
        .iter()
        .map(|owner| sysinfo::Pid::from_u32(owner.id.pid))
        .collect();
    refresh(app, ProcessesToUpdate::Some(&pids), |system| {
        owners
            .into_iter()
            .zip(&pids)
            .map(|(owner, pid)| {
                let Some(process) = system
                    .process(*pid)
                    .filter(|process| process.start_time() == owner.id.started)
                else {
                    return owner;
                };
                let mut details = ProcessInfo::from(process);
                details.can_terminate &= owner.can_terminate;
                details
            })
            .collect()
    })
}

#[cfg(windows)]
#[tauri::command]
pub async fn process_icons(
    ids: Vec<ProcessId>,
    app: tauri::AppHandle,
) -> Result<Vec<Option<String>>> {
    use tauri::Manager;
    blocking(move || {
        let state = app.state::<ProcessMonitor>();
        let paths = {
            let system = state.system.lock().map_err(message)?;
            ids.iter()
                .map(|id| {
                    system
                        .as_ref()
                        .and_then(|system| system.process(sysinfo::Pid::from_u32(id.pid)))
                        .filter(|process| process.start_time() == id.started)
                        .and_then(sysinfo::Process::exe)
                        .map(std::path::Path::to_path_buf)
                })
                .collect::<Vec<_>>()
        };
        let icons = app.state::<crate::windows_shell::ShellIcons>();
        Ok(paths
            .into_iter()
            .map(|path| path.and_then(|path| icons.icon(&path)))
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn terminate_processes(ids: Vec<ProcessId>) -> Result<Vec<String>> {
    blocking(move || {
        #[cfg(not(windows))]
        use sysinfo::Pid;
        #[cfg(not(windows))]
        let pids = ids
            .iter()
            .map(|id| Pid::from_u32(id.pid))
            .collect::<Vec<_>>();
        #[cfg(not(windows))]
        let mut system = System::new().map_err(message)?;
        #[cfg(not(windows))]
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            true,
            ProcessRefreshKind::nothing(),
        );
        let mut errors = Vec::new();
        for id in ids {
            if !terminable(id.pid) {
                errors.push(format!("PID {} cannot be terminated from Dirlume.", id.pid));
                continue;
            }
            #[cfg(windows)]
            if let Err(error) = crate::windows_shell::end_process(id) {
                errors.push(format!("PID {}: {error}", id.pid));
            }
            #[cfg(not(windows))]
            if let Some(process) = system.process(Pid::from_u32(id.pid)) {
                if process.start_time() != id.started || id.started == 0 {
                    errors.push(format!(
                        "PID {} no longer identifies the selected process.",
                        id.pid
                    ));
                } else if !process.kill() {
                    errors.push(format!(
                        "Unable to terminate {} (PID {}).",
                        process.name().to_string_lossy(),
                        id.pid
                    ));
                }
            }
        }
        Ok(errors)
    })
    .await
}
