use std::{ffi::OsStr, io, os::windows::ffi::OsStrExt, path::Path, ptr};

use windows::Win32::{
    Foundation::{LPARAM, WPARAM},
    UI::{
        Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW},
        WindowsAndMessaging::{
            SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, SW_HIDE, WM_SETTINGCHANGE,
        },
    },
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS,
    },
    Globalization::{CompareStringOrdinal, CSTR_EQUAL},
    System::{
        Registry::{
            RegCloseKey, RegCreateKeyExW, RegEnumValueW, RegOpenKeyExW, RegSetValueExW, HKEY,
            HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_EXPAND_SZ,
            REG_SZ,
        },
        Threading::{WaitForSingleObject, INFINITE},
    },
};

use super::{Definition, Edit, Information, Scope, ValueKind, HELPER};

const USER_PATH: &str = "Environment";
const MACHINE_PATH: &str = r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment";

fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}

fn key_location(scope: Scope) -> (HKEY, &'static str, String) {
    if scope == Scope::User {
        (HKEY_CURRENT_USER, USER_PATH, r"HKCU\Environment".into())
    } else {
        (
            HKEY_LOCAL_MACHINE,
            MACHINE_PATH,
            format!(r"HKLM\{MACHINE_PATH}"),
        )
    }
}

struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe { RegCloseKey(self.0) };
    }
}

fn key(scope: Scope, access: u32, create: bool) -> io::Result<Key> {
    let (root, location, _) = key_location(scope);
    let location = wide(location);
    let mut handle = ptr::null_mut();
    let status = unsafe {
        if create {
            RegCreateKeyExW(
                root,
                location.as_ptr(),
                0,
                ptr::null(),
                0,
                access,
                ptr::null(),
                &mut handle,
                ptr::null_mut(),
            )
        } else {
            RegOpenKeyExW(root, location.as_ptr(), 0, access, &mut handle)
        }
    };
    check(status)?;
    Ok(Key(handle))
}

fn check(status: u32) -> io::Result<()> {
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(status as i32))
    }
}

pub(super) fn same_name(left: &str, right: &str) -> bool {
    let left = wide(left);
    let right = wide(right);
    unsafe {
        CompareStringOrdinal(
            left.as_ptr(),
            (left.len() - 1) as i32,
            right.as_ptr(),
            (right.len() - 1) as i32,
            1,
        ) == CSTR_EQUAL
    }
}

pub(super) fn valid_name(name: &str) -> bool {
    !name.is_empty() && !name.contains(['=', '\0']) && name.encode_utf16().count() <= 16_383
}

pub(super) fn valid_value(value: &str, _: ValueKind) -> bool {
    !value.contains('\0') && value.encode_utf16().count() <= 32_767
}

pub(super) fn definitions(scope: Scope) -> io::Result<Vec<Definition>> {
    let key = match key(scope, KEY_QUERY_VALUE, false) {
        Ok(key) => key,
        Err(error) if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) => {
            return Ok(Vec::new())
        }
        Err(error) => return Err(error),
    };
    let (_, _, source) = key_location(scope);
    let mut name = vec![0u16; 16_384];
    let mut value = vec![0u16; 32_768];
    let mut rows = Vec::new();
    for index in 0.. {
        let mut name_length = name.len() as u32;
        let mut byte_length = (value.len() * 2) as u32;
        let mut value_type = 0;
        let status = unsafe {
            RegEnumValueW(
                key.0,
                index,
                name.as_mut_ptr(),
                &mut name_length,
                ptr::null(),
                &mut value_type,
                value.as_mut_ptr().cast(),
                &mut byte_length,
            )
        };
        match status {
            ERROR_NO_MORE_ITEMS => break,
            ERROR_MORE_DATA => continue,
            _ => check(status)?,
        }
        let kind = match value_type {
            REG_SZ => ValueKind::Literal,
            REG_EXPAND_SZ => ValueKind::Expandable,
            _ => continue,
        };
        let content = &value[..(byte_length as usize / 2)];
        let content = content.strip_suffix(&[0]).unwrap_or(content);
        let Ok(name) = String::from_utf16(&name[..name_length as usize]) else {
            continue;
        };
        let Ok(value) = String::from_utf16(content) else {
            continue;
        };
        if valid_name(&name) && valid_value(&value, kind) {
            rows.push(Definition {
                name,
                value,
                kind,
                source: source.clone(),
                overridden_by: None,
            });
        }
    }
    Ok(rows)
}

pub(super) fn write(scope: Scope, edit: &Edit) -> io::Result<()> {
    let key = key(scope, KEY_SET_VALUE, scope == Scope::User)?;
    let name = wide(&edit.name);
    let value = wide(&edit.value);
    let kind = if edit.kind == ValueKind::Expandable {
        REG_EXPAND_SZ
    } else {
        REG_SZ
    };
    check(unsafe {
        RegSetValueExW(
            key.0,
            name.as_ptr(),
            0,
            kind,
            value.as_ptr().cast(),
            (value.len() * 2) as u32,
        )
    })?;
    let environment = wide("Environment");
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            WPARAM(0),
            LPARAM(environment.as_ptr() as isize),
            SMTO_ABORTIFHUNG,
            250,
            None,
        );
    }
    Ok(())
}

pub(super) fn info(scope: Scope) -> io::Result<Information> {
    Ok(Information {
        target: key_location(scope).2,
        activation: "Open a new PowerShell session with Refresh environment enabled to load the saved definitions.",
        startup_file: None,
        integration_enabled: false,
        expandable: true,
    })
}

pub(super) fn integrate(_: Scope) -> io::Result<()> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

pub(super) fn needs_admin() -> bool {
    key(Scope::System, KEY_SET_VALUE, false).is_err()
}

pub(super) fn elevate(request: &Path) -> io::Result<bool> {
    use windows::core::PCWSTR;

    let executable = wide(std::env::current_exe()?);
    let request = request.as_os_str().encode_wide();
    let args: Vec<_> = format!("{HELPER} \"")
        .encode_utf16()
        .chain(request)
        .chain([u16::from(b'"'), 0])
        .collect();
    let mut start = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        lpVerb: windows::core::w!("runas"),
        lpFile: PCWSTR(executable.as_ptr()),
        lpParameters: PCWSTR(args.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    if let Err(error) = unsafe { ShellExecuteExW(&mut start) } {
        if error.code().0 as u16 == 1223 {
            return Ok(false);
        }
        return Err(io::Error::other("Environment authorization failed."));
    }
    let handle = start.hProcess.0;
    unsafe {
        WaitForSingleObject(handle, INFINITE);
        CloseHandle(handle);
    }
    Ok(true)
}
