use std::{
    env,
    io::{self, Read, Write},
    mem::size_of,
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    os::windows::{
        ffi::OsStrExt,
        io::{FromRawHandle, OwnedHandle},
    },
    ptr,
    sync::OnceLock,
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use uuid::Uuid;
use windows::{
    core::{w, HRESULT, PCWSTR},
    Win32::UI::{
        Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW},
        WindowsAndMessaging::SW_SHOWNORMAL,
    },
};
use windows_sys::Win32::{
    Foundation::ERROR_CANCELLED,
    Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

use crate::{local, message, Result};

const HANDOFF: &str = "--administrator-window=";
const MAX_WORKSPACE: u64 = 4 * 1024 * 1024;
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Side {
    Left,
    Right,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdministratorWorkspace {
    side: Side,
    directory: String,
    selected: Option<String>,
    other_folder: Option<String>,
    other_analyzer: Option<String>,
    split: f64,
    preferences: serde_json::Value,
}

impl AdministratorWorkspace {
    fn validate(&self) -> io::Result<()> {
        for path in [
            Some(&self.directory),
            self.other_folder.as_ref(),
            self.other_analyzer.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            local::absolute(path)?;
        }
        if let Some(name) = &self.selected {
            local::name_component(name)?;
        }
        if !self.preferences.is_object() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid administrator preferences",
            ));
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsStartup {
    administrator: bool,
    handoff: bool,
    workspace: Option<AdministratorWorkspace>,
    workspace_unavailable: bool,
}

pub fn is_elevated() -> bool {
    static ELEVATED: OnceLock<bool> = OnceLock::new();
    *ELEVATED.get_or_init(|| unsafe {
        let mut token = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }
        let _handle = OwnedHandle::from_raw_handle(token);
        let mut elevation = TOKEN_ELEVATION::default();
        let mut size = 0;
        GetTokenInformation(
            token,
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut size,
        ) != 0
            && elevation.TokenIsElevated != 0
    })
}

#[tauri::command]
pub async fn open_elevated(workspace: AdministratorWorkspace) -> Result<bool> {
    crate::desktop::blocking(move || open(workspace)).await
}

fn open(workspace: AdministratorWorkspace) -> Result<bool> {
    workspace.validate().map_err(message)?;
    let contents = serde_json::to_vec(&workspace).map_err(message)?;
    if contents.len() as u64 > MAX_WORKSPACE {
        return Err("The administrator workspace is too large.".to_owned());
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(message)?;
    listener.set_nonblocking(true).map_err(message)?;
    let port = listener.local_addr().map_err(message)?.port();
    let key = Uuid::new_v4();
    let executable: Vec<u16> = env::current_exe()
        .map_err(message)?
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let argument: Vec<u16> = format!("{HANDOFF}{port}:{key}")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut launch = SHELLEXECUTEINFOW {
        cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOASYNC,
        lpVerb: w!("runas"),
        lpFile: PCWSTR(executable.as_ptr()),
        lpParameters: PCWSTR(argument.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    match unsafe { ShellExecuteExW(&mut launch) } {
        Ok(()) => {}
        Err(error) if error.code() == HRESULT::from_win32(ERROR_CANCELLED) => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Windows did not start an administrator instance. {error}"
            ))
        }
    }
    // Transfer preferences once, after consent, without sharing either WebView profile.
    thread::spawn(move || serve_workspace(listener, key, &contents));
    Ok(true)
}

fn serve_workspace(listener: TcpListener, key: Uuid, contents: &[u8]) -> io::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        let mut client = match listener.accept() {
            Ok((client, _)) => client,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(25));
                continue;
            }
            Err(error) => return Err(error),
        };
        client.set_read_timeout(Some(Duration::from_millis(500)))?;
        let mut presented = [0; 16];
        if client.read_exact(&mut presented).is_ok() && bool::from(presented.ct_eq(key.as_bytes()))
        {
            client.set_write_timeout(Some(TRANSFER_TIMEOUT))?;
            return client.write_all(contents);
        }
    }
    Ok(())
}

fn receive_workspace(request: &str) -> Option<AdministratorWorkspace> {
    let (port, key) = request.split_once(':')?;
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port.parse::<u16>().ok()?));
    let key = Uuid::parse_str(key).ok()?;
    let mut broker = TcpStream::connect_timeout(&address, TRANSFER_TIMEOUT).ok()?;
    broker.set_read_timeout(Some(TRANSFER_TIMEOUT)).ok()?;
    broker.set_write_timeout(Some(TRANSFER_TIMEOUT)).ok()?;
    broker.write_all(key.as_bytes()).ok()?;
    let mut contents = Vec::new();
    broker
        .take(MAX_WORKSPACE + 1)
        .read_to_end(&mut contents)
        .ok()?;
    if contents.len() as u64 > MAX_WORKSPACE {
        return None;
    }
    let workspace: AdministratorWorkspace = serde_json::from_slice(&contents).ok()?;
    workspace.validate().ok()?;
    Some(workspace)
}

pub fn requested_handoff() -> Option<String> {
    env::args().find_map(|arg| arg.strip_prefix(HANDOFF).map(str::to_owned))
}

#[tauri::command]
pub async fn windows_startup(window: tauri::WebviewWindow) -> Result<WindowsStartup> {
    let administrator = is_elevated();
    let main = window.label() == "main";
    crate::desktop::blocking(move || {
        let requested = administrator.then(requested_handoff).flatten();
        let workspace = if main {
            requested.as_deref().and_then(receive_workspace)
        } else {
            None
        };
        Ok(WindowsStartup {
            administrator,
            handoff: requested.is_some(),
            workspace_unavailable: main && requested.is_some() && workspace.is_none(),
            workspace,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gives_the_workspace_only_to_the_matching_handoff() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let key = Uuid::new_v4();
        let contents = serde_json::to_vec(&serde_json::json!({
            "side": "right", "directory": "C:\\fixture", "selected": "Original",
            "otherAnalyzer": "D:\\scan", "split": 60.0, "preferences": {"theme": "dark"},
        }))
        .unwrap();
        let server = thread::spawn(move || serve_workspace(listener, key, &contents).unwrap());
        assert!(receive_workspace(&format!("{port}:{}", Uuid::new_v4())).is_none());
        let workspace = receive_workspace(&format!("{port}:{key}")).unwrap();
        assert!(matches!(workspace.side, Side::Right));
        assert_eq!(workspace.selected.as_deref(), Some("Original"));
        assert_eq!(workspace.other_analyzer.as_deref(), Some("D:\\scan"));
        assert_eq!(workspace.preferences["theme"], "dark");
        server.join().unwrap();
        assert!(receive_workspace(&format!("{port}:{key}")).is_none());
    }
}
