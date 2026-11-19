use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::{c_void, OsString},
    io,
    os::windows::ffi::OsStringExt,
    ptr, slice,
    sync::OnceLock,
};

use portable_pty::CommandBuilder;
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{WM_NCDESTROY, WM_SETTINGCHANGE},
    },
};
use windows_sys::Win32::{
    Foundation::CloseHandle,
    Security::{TOKEN_DUPLICATE, TOKEN_QUERY},
    System::{
        Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock},
        Threading::{GetCurrentProcess, OpenProcessToken},
    },
};

use crate::diagnostics::{failure, FailureCode};

type Environment = BTreeMap<String, (OsString, OsString)>;
static STARTUP_VARIABLES: OnceLock<BTreeSet<String>> = OnceLock::new();

struct EnvironmentBlock(*mut c_void);

impl Drop for EnvironmentBlock {
    fn drop(&mut self) {
        unsafe { DestroyEnvironmentBlock(self.0) };
    }
}

fn windows_environment() -> io::Result<Environment> {
    let mut token = ptr::null_mut();
    if unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_QUERY | TOKEN_DUPLICATE,
            &mut token,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut block = ptr::null_mut();
    let result = unsafe { CreateEnvironmentBlock(&mut block, token, 0) };
    let error = (result == 0).then(io::Error::last_os_error);
    unsafe { CloseHandle(token) };
    if let Some(error) = error {
        return Err(error);
    }
    let block = EnvironmentBlock(block);
    let mut environment = Environment::new();
    let mut start = block.0.cast::<u16>();
    // Userenv returns a double-NUL-terminated list of UTF-16 name=value strings.
    unsafe {
        while *start != 0 {
            let mut end = start;
            while *end != 0 {
                end = end.add(1);
            }
            let value = slice::from_raw_parts(start, end.offset_from(start) as usize);
            if let Some(equals) = value.iter().position(|&unit| unit == u16::from(b'=')) {
                // Entries beginning with '=' are drive bookkeeping, outside the variable map.
                if equals != 0 {
                    let name = OsString::from_wide(&value[..equals]);
                    let contents = OsString::from_wide(&value[equals + 1..]);
                    environment.insert(name.to_string_lossy().to_uppercase(), (name, contents));
                }
            }
            start = end.add(1);
        }
    }
    Ok(environment)
}

fn merge_environment(
    registered: &BTreeSet<String>,
    mut current: Environment,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
) -> Environment {
    for (name, value) in inherited {
        let key = name.to_string_lossy().to_uppercase();
        if key.starts_with("DIRLUME_") {
            current.insert(key, (name, value));
        } else if !registered.contains(&key) {
            current.entry(key).or_insert((name, value));
        }
    }
    current
}

pub fn variables(refresh: bool) -> io::Result<Vec<(OsString, OsString)>> {
    if refresh {
        let latest = windows_environment()?;
        let registered = STARTUP_VARIABLES.get_or_init(|| latest.keys().cloned().collect());
        Ok(merge_environment(registered, latest, std::env::vars_os())
            .into_values()
            .collect())
    } else {
        Ok(std::env::vars_os().collect())
    }
}

pub fn apply(command: &mut CommandBuilder, refresh: bool) -> io::Result<()> {
    // portable-pty merges the registry into its default environment even with refresh disabled.
    command.env_clear();
    for (name, value) in variables(refresh)? {
        command.env(name, value);
    }
    Ok(())
}

pub fn attach(app: &AppHandle) {
    match windows_environment() {
        Ok(environment) => {
            let _ = STARTUP_VARIABLES.set(environment.into_keys().collect());
        }
        Err(error) => failure("open_terminal", FailureCode::Io, error.raw_os_error()),
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(hwnd) = window.hwnd() else { return };
    let data = Box::into_raw(Box::new(app.clone()));
    let installed =
        unsafe { SetWindowSubclass(HWND(hwnd.0), Some(environment_changed), 1, data as usize) };
    if !installed.as_bool() {
        unsafe { drop(Box::from_raw(data)) };
        failure("open_terminal", FailureCode::Io, None);
    }
}

unsafe extern "system" fn environment_changed(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    data: usize,
) -> LRESULT {
    if message == WM_SETTINGCHANGE && lparam.0 != 0 {
        let area = lparam.0 as *const u16;
        let environment = "Environment".encode_utf16().chain(std::iter::once(0));
        // A setting-change broadcast supplies a null-terminated label. Stop on the first mismatch.
        if environment
            .enumerate()
            .all(|(index, unit)| *area.add(index) == unit)
        {
            let app = &*(data as *const AppHandle);
            let _ = app.emit("terminal-environment-changed", ());
        }
    } else if message == WM_NCDESTROY {
        let _ = RemoveWindowSubclass(window, Some(environment_changed), id);
        drop(Box::from_raw(data as *mut AppHandle));
    }
    DefSubclassProc(window, message, wparam, lparam)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refreshes_registered_variables_and_keeps_process_only_values() {
        let registered = ["PATH", "REMOVED"].map(str::to_owned).into_iter().collect();
        let latest = [
            ("PATH", ("Path", r"C:\\new")),
            ("ADDED", ("Added", "Привіт")),
        ]
        .map(|(key, (name, value))| (key.into(), (name.into(), value.into())))
        .into_iter()
        .collect();
        let inherited = [
            ("PATH", r"C:\\old"),
            ("Removed", "old"),
            ("CustomLauncherValue", "keep"),
            ("DIRLUME_PROMPT_TOKEN", "keep"),
        ]
        .map(|(name, value)| (name.into(), value.into()));
        let result = merge_environment(&registered, latest, inherited);
        assert_eq!(result["PATH"].1, r"C:\\new");
        assert_eq!(result["ADDED"].1, "Привіт");
        assert_eq!(result["CUSTOMLAUNCHERVALUE"].1, "keep");
        assert_eq!(result["DIRLUME_PROMPT_TOKEN"].1, "keep");
        assert!(!result.contains_key("REMOVED"));
    }
}
