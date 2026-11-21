use std::{
    cell::RefCell,
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::Write,
    panic::{self, AssertUnwindSafe, PanicHookInfo},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

#[tauri::command]
pub async fn error_log() -> crate::desktop::Result<Option<String>> {
    crate::desktop::blocking(|| {
        let log = LOG
            .get()
            .ok_or("The diagnostics directory is unavailable.")?;
        let metadata = match fs::metadata(&log.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(crate::desktop::message(error)),
        };
        if metadata.len() == 0 {
            return Ok(None);
        }
        crate::local::display_path(&log.path)
            .map(Some)
            .map_err(crate::desktop::message)
    })
    .await
}

const HISTORY_SIZE: usize = 32;
const ACTIONS: &[&str] = &[
    "list_directory",
    "file_attributes",
    "update_file_attributes",
    "operate",
    "create_folders",
    "archive_capabilities",
    "create_archive",
    "cancel_archive",
    "open_archive",
    "list_archive",
    "read_archive_text",
    "read_archive_bytes",
    "save_archive_text",
    "delete_archive_entries",
    "open_file",
    "rename_item",
    "create_file",
    "create_folder",
    "recycle_item",
    "delete_item",
    "connect_server",
    "list_server",
    "connect_ftp",
    "list_ftp",
    "search_ftp",
    "cancel_ftp_search",
    "save_ftp_profile",
    "remove_ftp_profile",
    "rename_ftp",
    "delete_ftp",
    "read_text",
    "save_text",
    "read_ftp_text",
    "save_ftp_text",
    "read_server_text",
    "copy_file_references",
    "clipboard_files",
    "begin_transfer",
    "transfer_item",
    "resolve_transfer",
    "cancel_transfer",
    "measure_folders",
    "open_terminal",
    "complete_command",
    "close_terminal",
    "check_for_update",
    "install_update",
    "open_elevated",
    "open_web_link",
    "open_kswitcher",
    "list_kswitcher",
    "terminate_processes",
];
const OTHER_OPERATIONS: &[&str] = &[
    "build_version",
    "locations",
    "requested_location",
    "disk_space",
    "list_processes",
    "process_icons",
    "file_icons",
    "locking_processes",
    "windows_item_menu",
    "disconnect_server",
    "ftp_profiles",
    "ftp_windows_code_page",
    "disconnect_ftp",
    "read_ftp_bytes",
    "resolve_text_link",
    "read_bytes",
    "read_server_bytes",
    "has_kswitcher_bridge",
    "kswitcher_peers",
    "installed_fonts",
    "show_window",
    "write_terminal",
    "resize_terminal",
    "watch_directory",
    "unwatch_directory",
    "cancel_measurement",
    "finish_transfer",
    "desktop_action",
    "javascript",
    "react_render",
    "render_mermaid",
    "folder_picker",
    "load_preferences",
    "load_workspace",
    "save_workspace",
    "watch_events",
    "measure_sizes",
    "read_terminal",
    "wait_terminal",
    "native_runtime",
];

static LOG: OnceLock<Diagnostics> = OnceLock::new();
pub const PANIC_REJECTION: &str = "An internal operation panicked.";

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCode {
    NativeError,
    OsError,
    PermissionDenied,
    NotFound,
    Timeout,
    Panic,
    Io,
    Incomplete,
    JavascriptError,
    TypeError,
    SyntaxError,
    RangeError,
    UnhandledRejection,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct Action {
    timestamp_ms: u64,
    operation: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry<'a> {
    timestamp_ms: u64,
    operation: &'static str,
    code: FailureCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    os_code: Option<i32>,
    recent_actions: &'a VecDeque<Action>,
    #[serde(skip_serializing_if = "Option::is_none")]
    panic: Option<&'a PanicDetails>,
}

#[derive(Serialize)]
struct PanicSource {
    path: String,
    line: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum PanicOutcome {
    Unknown,
    Recovered,
}

#[derive(Serialize)]
struct PanicDetails {
    build: &'static str,
    platform: &'static str,
    architecture: &'static str,
    source: Option<PanicSource>,
    subsystem: Option<&'static str>,
    command: Option<&'static str>,
    outcome: PanicOutcome,
}

struct WorkerScope {
    command: Option<&'static str>,
    panics: Vec<(u64, PanicDetails, VecDeque<Action>)>,
}

thread_local! {
    static WORKER_SCOPE: RefCell<Option<WorkerScope>> = const { RefCell::new(None) };
}

fn panic_source(file: &str, line: u32) -> Option<PanicSource> {
    if file.len() > 512 || line == 0 {
        return None;
    }
    let normalized = file.replace('\\', "/");
    let manifest = env!("CARGO_MANIFEST_DIR").replace('\\', "/");
    let relative = normalized.strip_prefix("src-tauri/").unwrap_or_else(|| {
        normalized
            .strip_prefix(&manifest)
            .and_then(|path| path.strip_prefix('/'))
            .unwrap_or(&normalized)
    });
    let known = include_str!(concat!(env!("OUT_DIR"), "/panic-sources.txt"));
    if relative.len() > 160 || !known.lines().any(|path| path == relative) {
        return None;
    }
    Some(PanicSource {
        path: format!("src-tauri/{relative}"),
        line,
    })
}

struct Diagnostics {
    path: PathBuf,
    actions: Mutex<VecDeque<Action>>,
}

impl Diagnostics {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            actions: Mutex::new(VecDeque::with_capacity(HISTORY_SIZE)),
        }
    }

    fn remember(&self, operation: &'static str) {
        if let Ok(mut actions) = self.actions.lock() {
            if actions.len() == HISTORY_SIZE {
                actions.pop_front();
            }
            actions.push_back(Action {
                timestamp_ms: timestamp(),
                operation,
            });
        }
    }

    fn write(
        &self,
        operation: &'static str,
        code: FailureCode,
        os_code: Option<i32>,
        actions: &VecDeque<Action>,
    ) {
        let entry = Entry {
            timestamp_ms: timestamp(),
            operation,
            code,
            os_code: os_code.filter(|code| matches!(code, 1..=65535)),
            recent_actions: actions,
            panic: None,
        };
        let _ = append(&self.path, &entry);
    }

    fn write_panic(&self, timestamp_ms: u64, details: &PanicDetails, actions: &VecDeque<Action>) {
        let entry = Entry {
            timestamp_ms,
            operation: "native_runtime",
            code: FailureCode::Panic,
            os_code: None,
            recent_actions: actions,
            panic: Some(details),
        };
        let _ = append(&self.path, &entry);
    }

    fn capture_panic(&self, info: &PanicHookInfo<'_>) {
        let timestamp_ms = timestamp();
        let source = info
            .location()
            .and_then(|location| panic_source(location.file(), location.line()));
        let actions = self
            .actions
            .try_lock()
            .map(|actions| actions.clone())
            .unwrap_or_default();
        let mut entry = Some((
            PanicDetails {
                build: crate::BUILD_VERSION,
                platform: std::env::consts::OS,
                architecture: std::env::consts::ARCH,
                source,
                subsystem: None,
                command: None,
                outcome: PanicOutcome::Unknown,
            },
            actions,
        ));
        let _ = WORKER_SCOPE.try_with(|scope| {
            let Ok(mut current) = scope.try_borrow_mut() else {
                return;
            };
            let Some(scope) = current.as_mut() else {
                return;
            };
            let Some((mut details, actions)) = entry.take() else {
                return;
            };
            details.subsystem = Some("desktop_worker");
            details.command = scope.command;
            scope.panics.push((timestamp_ms, details, actions));
        });
        if let Some((details, actions)) = entry {
            self.write_panic(timestamp_ms, &details, &actions);
        }
    }
}

fn run_worker<T>(
    log: Option<&Diagnostics>,
    command: Option<&'static str>,
    task: impl FnOnce() -> T,
) -> Result<T, &'static str> {
    let previous = WORKER_SCOPE.replace(Some(WorkerScope {
        command: command.and_then(operation_name),
        panics: Vec::new(),
    }));
    let result = panic::catch_unwind(AssertUnwindSafe(task));
    if let (Some(log), Some(scope)) = (log, WORKER_SCOPE.replace(previous)) {
        for (timestamp_ms, mut details, actions) in scope.panics {
            details.outcome = PanicOutcome::Recovered;
            log.write_panic(timestamp_ms, &details, &actions);
        }
    }
    result.map_err(|_| PANIC_REJECTION)
}

pub(crate) fn worker<T>(
    command: Option<&'static str>,
    task: impl FnOnce() -> T,
) -> Result<T, &'static str> {
    run_worker(LOG.get(), command, task)
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn append(path: &Path, entry: &Entry<'_>) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut line = serde_json::to_vec(entry)?;
    line.push(b'\n');
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(&line)
}

fn operation_name(operation: &str) -> Option<&'static str> {
    ACTIONS
        .iter()
        .chain(OTHER_OPERATIONS)
        .copied()
        .find(|name| *name == operation)
}

pub fn setup(identifier: &str) {
    #[cfg(feature = "ui-automation")]
    let fixture = std::env::var_os("DIRLUME_TEST_DIAGNOSTICS_DIR").map(PathBuf::from);
    #[cfg(not(feature = "ui-automation"))]
    let fixture: Option<PathBuf> = None;
    let root =
        fixture.or_else(|| dirs::data_local_dir().map(|root| root.join(identifier).join("logs")));
    let Some(root) = root else { return };
    if LOG
        .set(Diagnostics::new(root.join("diagnostics.jsonl")))
        .is_err()
    {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(log) = LOG.get() {
            log.capture_panic(info);
        }
        previous(info);
    }));
}

pub fn remember_command(message: &tauri::ipc::InvokeMessage<tauri::Wry>) {
    let command = message.command();
    let operation = if command == "operate" {
        let detail = match message.payload() {
            tauri::ipc::InvokeBody::Json(value) => value["operation"]["kind"].as_str(),
            _ => None,
        };
        operation_detail(detail)
    } else {
        command
    };
    if let (Some(log), Some(operation)) = (
        LOG.get(),
        ACTIONS.iter().copied().find(|name| *name == operation),
    ) {
        log.remember(operation);
    }
}

fn operation_detail(detail: Option<&str>) -> &'static str {
    match detail {
        Some("open") => "open_file",
        Some("rename") => "rename_item",
        Some("create_file") => "create_file",
        Some("create_folder") => "create_folder",
        Some("recycle") => "recycle_item",
        Some("delete") => "delete_item",
        _ => "operate",
    }
}

pub fn failure(operation: &str, code: FailureCode, os_code: Option<i32>) {
    if let (Some(log), Some(operation)) = (LOG.get(), operation_name(operation)) {
        if let Ok(actions) = log.actions.lock() {
            log.write(operation, code, os_code, &actions);
        }
    }
}

#[tauri::command]
pub async fn report_diagnostic(
    operation: String,
    code: FailureCode,
    os_code: Option<i32>,
    detail: Option<String>,
) {
    let operation = if operation == "operate" {
        operation_detail(detail.as_deref())
    } else {
        &operation
    };
    failure(operation, code, os_code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panic_reports_are_bounded_and_distinguish_recovered_workers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("diagnostics.jsonl");
        let log = std::sync::Arc::new(Diagnostics::new(path.clone()));
        let thread = std::thread::current().id();
        let previous = std::sync::Arc::new(panic::take_hook());
        let other_hook = previous.clone();
        let hook_log = log.clone();
        panic::set_hook(Box::new(move |info| {
            if std::thread::current().id() == thread {
                hook_log.capture_panic(info);
            } else {
                other_hook(info);
            }
        }));

        let line = std::cell::Cell::new(0);
        let recovered = run_worker::<()>(Some(&log), Some("read_text"), || {
            line.set(line!() + 1);
            panic!("private fixture payload")
        });
        let other_log = log.clone();
        let other = std::thread::spawn(move || other_log.remember("list_ftp")).join();
        let unscoped_worker =
            run_worker::<()>(Some(&log), None, || panic!("unrelated fixture payload"));
        let history_guard = log.actions.lock().unwrap();
        let unknown = panic::catch_unwind(|| panic!("C:\\private\\fixture.txt"));
        drop(history_guard);
        panic::set_hook(Box::new(move |info| previous(info)));

        assert_eq!(recovered, Err(PANIC_REJECTION));
        assert!(other.is_ok());
        assert_eq!(unscoped_worker, Err(PANIC_REJECTION));
        assert!(unknown.is_err());
        let raw = fs::read_to_string(path).unwrap();
        assert!(!raw.contains("payload") && !raw.contains("private") && !raw.contains("backtrace"));
        let entries: Vec<serde_json::Value> = raw
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(entries.len(), 3);
        let first = &entries[0];
        assert_eq!(first["operation"], "native_runtime");
        assert_eq!(first["code"], "panic");
        assert_eq!(first["recentActions"], serde_json::json!([]));
        assert_eq!(first["panic"]["build"], crate::BUILD_VERSION);
        assert_eq!(first["panic"]["platform"], std::env::consts::OS);
        assert_eq!(first["panic"]["architecture"], std::env::consts::ARCH);
        assert_eq!(
            first["panic"]["source"]["path"],
            "src-tauri/src/diagnostics.rs"
        );
        assert_eq!(first["panic"]["source"]["line"], line.get());
        assert_eq!(first["panic"]["source"].as_object().unwrap().len(), 2);
        assert_eq!(first["panic"]["subsystem"], "desktop_worker");
        assert_eq!(first["panic"]["command"], "read_text");
        assert_eq!(first["panic"]["outcome"], "recovered");
        assert_eq!(entries[1]["recentActions"][0]["operation"], "list_ftp");
        assert!(entries[1]["panic"]["command"].is_null());
        assert_eq!(entries[2]["recentActions"], serde_json::json!([]));
        assert_eq!(entries[2]["panic"]["outcome"], "unknown");
        assert!(entries[2]["panic"]["subsystem"].is_null());
        assert!(entries[2]["panic"]["command"].is_null());
        assert!(panic_source("/home/build/other/src/diagnostics.rs", 1).is_none());
        assert!(panic_source("src/../src/diagnostics.rs", 1).is_none());
        assert!(panic_source(&"x".repeat(513), 1).is_none());
        assert!(panic_source("src/diagnostics.rs", 0).is_none());
    }

    #[test]
    fn retains_recent_actions_in_order_and_writes_only_for_failure() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("diagnostics.jsonl");
        let log = Diagnostics::new(path.clone());
        log.remember("connect_ftp");
        for _ in 0..HISTORY_SIZE - 1 {
            log.remember("list_directory");
        }
        log.remember("save_text");
        assert!(!path.exists());
        log.write(
            "save_text",
            FailureCode::OsError,
            Some(5),
            &log.actions.lock().unwrap(),
        );
        let restarted = Diagnostics::new(path.clone());
        restarted.write("javascript", FailureCode::TypeError, None, &VecDeque::new());
        let file = fs::read_to_string(path).unwrap();
        let entries: Vec<serde_json::Value> = file
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let actions = entries[0]["recentActions"].as_array().unwrap();
        assert_eq!(actions.len(), HISTORY_SIZE);
        assert_eq!(actions[0]["operation"], "list_directory");
        assert_eq!(actions[HISTORY_SIZE - 1]["operation"], "save_text");
        assert_eq!(entries[0]["osCode"], 5);
        assert_eq!(entries[1]["recentActions"], serde_json::json!([]));
        assert_eq!(operation_name("password123"), None);
    }
}
