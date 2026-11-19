use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

const HISTORY_SIZE: usize = 32;
const ACTIONS: &[&str] = &[
    "list_directory",
    "operate",
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
        };
        let _ = append(&self.path, &entry);
    }
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
            // A panic can occur while this same thread owns the history lock.
            if let Ok(actions) = log.actions.try_lock() {
                log.write("native_runtime", FailureCode::Panic, None, &actions);
            }
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
