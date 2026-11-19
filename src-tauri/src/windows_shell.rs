use std::{
    cell::RefCell,
    collections::BTreeMap,
    fs,
    os::windows::{
        ffi::OsStrExt,
        io::{FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    ptr,
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use tauri::WebviewWindow;
use windows::{
    core::{w, Interface, PCSTR, PCWSTR, PWSTR},
    Win32::{
        Foundation::{
            ERROR_MORE_DATA, ERROR_SUCCESS, FILETIME, HWND, LPARAM, LRESULT, POINT, WPARAM,
        },
        System::{
            Com::{CoTaskMemFree, IBindCtx},
            RestartManager::{
                RmCritical, RmEndSession, RmGetList, RmRegisterResources, RmStartSession,
                RM_PROCESS_INFO,
            },
            Threading::{
                GetProcessTimes, IsProcessCritical, OpenProcess, TerminateProcess,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
            },
        },
        UI::{
            Shell::{
                DefSubclassProc, IContextMenu, IContextMenu2, IContextMenu3, IShellFolder,
                RemoveWindowSubclass, SHBindToParent, SHParseDisplayName, SetWindowSubclass,
                ShellExecuteW, CMF_NORMAL, CMINVOKECOMMANDINFO,
            },
            WindowsAndMessaging::{
                CreatePopupMenu, DestroyMenu, GetCursorPos, SetForegroundWindow, TrackPopupMenuEx,
                SW_SHOWNORMAL, TPM_RETURNCMD, TPM_RIGHTBUTTON, WM_DRAWITEM, WM_INITMENUPOPUP,
                WM_MEASUREITEM, WM_MENUCHAR,
            },
        },
    },
};

use crate::{
    desktop::{message, Result},
    local,
    processes::{ProcessId, ProcessInfo},
};

struct MenuHandlers(Option<IContextMenu3>, Option<IContextMenu2>);

thread_local! {
    static MENU_HANDLERS: RefCell<Option<MenuHandlers>> = const { RefCell::new(None) };
}

unsafe extern "system" fn menu_messages(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _: usize,
    _: usize,
) -> LRESULT {
    if matches!(
        msg,
        WM_INITMENUPOPUP | WM_DRAWITEM | WM_MEASUREITEM | WM_MENUCHAR
    ) {
        let result = MENU_HANDLERS.with(|handlers| {
            let handlers = handlers.borrow();
            let MenuHandlers(v3, v2) = handlers.as_ref()?;
            let mut result = LRESULT(0);
            if let Some(v3) = v3 {
                unsafe { v3.HandleMenuMsg2(msg, wparam, lparam, Some(&mut result)) }.ok()?;
            } else if let Some(v2) = v2 {
                unsafe { v2.HandleMenuMsg(msg, wparam, lparam) }.ok()?;
            } else {
                return None;
            }
            Some(result)
        });
        if let Some(result) = result {
            return result;
        }
    }
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[derive(PartialEq, Eq, Hash)]
enum IconKey {
    Type(String),
    File(PathBuf, u64, Option<std::time::SystemTime>),
}

#[derive(Default)]
pub struct ShellIcons(std::sync::Mutex<std::collections::HashMap<IconKey, Option<String>>>);

impl ShellIcons {
    pub fn icon(&self, path: &Path) -> Option<String> {
        let extension = path.extension()?.to_str()?.to_ascii_lowercase();
        let key = if matches!(
            extension.as_str(),
            "exe" | "dll" | "ico" | "lnk" | "com" | "msi" | "cpl" | "ani" | "cur" | "scr"
        ) {
            let metadata = fs::metadata(path).ok()?;
            IconKey::File(path.to_owned(), metadata.len(), metadata.modified().ok())
        } else {
            IconKey::Type(extension)
        };
        let mut cache = self.0.lock().ok()?;
        if cache.len() >= 1024 && !cache.contains_key(&key) {
            cache.clear();
        }
        cache.entry(key).or_insert_with(|| shell_icon(path)).clone()
    }
}

#[tauri::command]
pub async fn file_icons(
    items: Vec<crate::file_clipboard::ClipboardPath>,
    app: tauri::AppHandle,
) -> Result<Vec<Option<String>>> {
    use tauri::Manager;
    crate::desktop::blocking(move || {
        let icons = app.state::<ShellIcons>();
        Ok(items
            .iter()
            .map(|item| {
                let directory = local::absolute(&item.directory).ok()?;
                let name = local::name_component(&item.name).ok()?;
                icons.icon(&directory.join(name))
            })
            .collect())
    })
    .await
}

fn shell_icon(path: &Path) -> Option<String> {
    use base64::engine::general_purpose::STANDARD;
    use windows::Win32::{
        Foundation::SIZE,
        Graphics::Gdi::{
            CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
            BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        },
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
        UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_ICONONLY},
    };

    let path = wide(path);
    // This runs on a blocking worker. Release the shell object and GDI
    // handles before leaving this COM apartment.
    let (rgba, width, height) = unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().ok()?;
        let pixels = (|| {
            let item: IShellItemImageFactory =
                SHCreateItemFromParsingName(PCWSTR(path.as_ptr()), None::<&IBindCtx>).ok()?;
            let bitmap = item
                .GetImage(SIZE { cx: 24, cy: 24 }, SIIGBF_ICONONLY)
                .ok()?;
            let image = (|| {
                let mut object = BITMAP::default();
                if GetObjectW(
                    bitmap.into(),
                    size_of::<BITMAP>() as i32,
                    Some((&mut object as *mut BITMAP).cast()),
                ) == 0
                {
                    return None;
                }
                let (width, height) = (object.bmWidth, object.bmHeight.abs());
                if !(1..=256).contains(&width) || !(1..=256).contains(&height) {
                    return None;
                }
                let mut info = BITMAPINFO {
                    bmiHeader: BITMAPINFOHEADER {
                        biSize: size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: width,
                        biHeight: -height,
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB.0,
                        ..Default::default()
                    },
                    ..Default::default()
                };
                let mut pixels = vec![0u8; width as usize * height as usize * 4];
                let dc = CreateCompatibleDC(None);
                if dc.is_invalid() {
                    return None;
                }
                let lines = GetDIBits(
                    dc,
                    bitmap,
                    0,
                    height as u32,
                    Some(pixels.as_mut_ptr().cast()),
                    &mut info,
                    DIB_RGB_COLORS,
                );
                let _ = DeleteDC(dc);
                (lines == height).then_some((pixels, width as u32, height as u32))
            })();
            let _ = DeleteObject(bitmap.into());
            image
        })();
        CoUninitialize();
        pixels?
    };

    let mut rgba = rgba;
    let (pixels, _) = rgba.as_chunks_mut::<4>();
    if !pixels.iter().any(|pixel| pixel[3] != 0) {
        return None;
    }
    for pixel in pixels {
        pixel.swap(0, 2);
        let alpha = u16::from(pixel[3]);
        if (1..255).contains(&alpha) {
            for channel in &mut pixel[..3] {
                *channel = (u16::from(*channel) * 255 / alpha).min(255) as u8;
            }
        }
    }
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.write_header().ok()?.write_image_data(&rgba).ok()?;
    }
    Some(STANDARD.encode(bytes))
}

fn show_item_menu(hwnd: HWND, path: &Path) -> Result<()> {
    if MENU_HANDLERS.with(|handlers| handlers.borrow().is_some()) {
        return Err("A Windows context menu is already open.".to_owned());
    }
    let path = wide(path);
    // The Tauri window owns the UI thread and its COM apartment. The PIDL is
    // kept alive through menu invocation; the subclass is confined to the menu.
    unsafe {
        let mut item = ptr::null_mut();
        SHParseDisplayName(PCWSTR(path.as_ptr()), None::<&IBindCtx>, &mut item, 0, None)
            .map_err(message)?;
        let result = (|| {
            let mut child = ptr::null_mut();
            let folder: IShellFolder = SHBindToParent(item, Some(&mut child)).map_err(message)?;
            let context: IContextMenu = folder
                .GetUIObjectOf(hwnd, &[child], None)
                .map_err(message)?;
            let menu = CreatePopupMenu().map_err(message)?;
            let selected = (|| {
                context
                    .QueryContextMenu(menu, 0, 1, 0x7fff, CMF_NORMAL)
                    .ok()
                    .map_err(message)?;
                let mut cursor = POINT::default();
                GetCursorPos(&mut cursor).map_err(message)?;
                let _ = SetForegroundWindow(hwnd);
                MENU_HANDLERS.with(|handlers| {
                    *handlers.borrow_mut() =
                        Some(MenuHandlers(context.cast().ok(), context.cast().ok()))
                });
                let subclass_id = menu_messages as *const () as usize;
                let installed =
                    SetWindowSubclass(hwnd, Some(menu_messages), subclass_id, 0).as_bool();
                let selected = TrackPopupMenuEx(
                    menu,
                    (TPM_RETURNCMD | TPM_RIGHTBUTTON).0,
                    cursor.x,
                    cursor.y,
                    hwnd,
                    None,
                )
                .0;
                if installed {
                    let _ = RemoveWindowSubclass(hwnd, Some(menu_messages), subclass_id);
                }
                MENU_HANDLERS.with(|handlers| handlers.borrow_mut().take());
                Ok::<_, String>(selected)
            })();
            let _ = DestroyMenu(menu);
            let selected = selected?;
            if selected != 0 {
                let invoke = CMINVOKECOMMANDINFO {
                    cbSize: size_of::<CMINVOKECOMMANDINFO>() as u32,
                    hwnd,
                    lpVerb: PCSTR((selected as usize - 1) as *const u8),
                    nShow: SW_SHOWNORMAL.0,
                    ..Default::default()
                };
                context.InvokeCommand(&invoke).map_err(message)?;
            }
            Ok(())
        })();
        CoTaskMemFree(Some(item.cast()));
        result
    }
}

#[tauri::command]
pub async fn windows_item_menu(
    window: WebviewWindow,
    directory: String,
    name: String,
) -> Result<()> {
    let path = local::absolute(&directory)
        .map_err(message)?
        .join(local::name_component(&name).map_err(message)?);
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let selected_window = window.clone();
    window
        .run_on_main_thread(move || {
            let result = selected_window
                .hwnd()
                .map_err(message)
                .and_then(|hwnd| show_item_menu(hwnd, &path));
            let _ = sender.send(result);
        })
        .map_err(message)?;
    crate::desktop::blocking(move || receiver.recv().map_err(message)?).await
}

#[tauri::command]
pub fn open_elevated(directory: String) -> Result<()> {
    local::absolute(&directory).map_err(message)?;
    let executable = wide(&std::env::current_exe().map_err(message)?);
    let argument: Vec<u16> = format!("--open-folder={}", URL_SAFE_NO_PAD.encode(directory))
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let status = unsafe {
        ShellExecuteW(
            None,
            w!("runas"),
            PCWSTR(executable.as_ptr()),
            PCWSTR(argument.as_ptr()),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if status.0 as usize <= 32 {
        return Err("Windows did not start an administrator instance.".to_owned());
    }
    Ok(())
}

struct RestartSession(u32);

fn process_started(time: FILETIME) -> u64 {
    let ticks = (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
    ticks.saturating_sub(116_444_736_000_000_000) / 10_000_000
}

pub fn end_process(id: ProcessId) -> Result<()> {
    // Keep the same handle from the identity and critical-process checks
    // through termination, so a recycled PID cannot target another process.
    unsafe {
        let process = OpenProcess(
            PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
            false,
            id.pid,
        )
        .map_err(message)?;
        let _owned = OwnedHandle::from_raw_handle(process.0);
        let (mut created, mut exited, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user)
            .map_err(message)?;
        if id.started == 0 || process_started(created) != id.started {
            return Err("The process no longer matches the selected entry.".to_owned());
        }
        let mut critical = windows::core::BOOL(0);
        IsProcessCritical(process, &mut critical).map_err(message)?;
        if critical.as_bool() {
            return Err("Windows reports that this is a critical system process.".to_owned());
        }
        TerminateProcess(process, 1).map_err(message)
    }
}

impl Drop for RestartSession {
    fn drop(&mut self) {
        let _ = unsafe { RmEndSession(self.0) };
    }
}

fn lock_owners(paths: &[PathBuf]) -> Result<Vec<RM_PROCESS_INFO>> {
    let mut id = 0;
    let mut key = [0u16; 33];
    let status = unsafe { RmStartSession(&mut id, None, PWSTR(key.as_mut_ptr())) };
    if status != ERROR_SUCCESS {
        return Err(message(std::io::Error::from_raw_os_error(status.0 as i32)));
    }
    let session = RestartSession(id);
    let names = paths.iter().map(|path| wide(path)).collect::<Vec<_>>();
    let names = names
        .iter()
        .map(|name| PCWSTR(name.as_ptr()))
        .collect::<Vec<_>>();
    let status = unsafe { RmRegisterResources(session.0, Some(&names), None, None) };
    if status != ERROR_SUCCESS {
        return Err(message(std::io::Error::from_raw_os_error(status.0 as i32)));
    }
    let mut entries = Vec::<RM_PROCESS_INFO>::new();
    for _ in 0..4 {
        let mut needed = 0;
        let mut count = entries.len() as u32;
        let mut reboot = 0;
        let buffer = (!entries.is_empty()).then_some(entries.as_mut_ptr());
        let status = unsafe { RmGetList(session.0, &mut needed, &mut count, buffer, &mut reboot) };
        if status == ERROR_SUCCESS {
            entries.truncate(count as usize);
            return Ok(entries);
        }
        if status != ERROR_MORE_DATA {
            return Err(message(std::io::Error::from_raw_os_error(status.0 as i32)));
        }
        entries.resize(needed as usize, RM_PROCESS_INFO::default());
    }
    Err("The list of processes using the file changed. Try again.".to_owned())
}

#[derive(serde::Serialize)]
pub struct LockReport {
    processes: Vec<ProcessInfo>,
    incomplete: bool,
}

#[tauri::command]
pub async fn locking_processes(paths: Vec<String>, app: tauri::AppHandle) -> Result<LockReport> {
    crate::desktop::blocking(move || {
        let mut pending = paths
            .iter()
            .map(|path| local::absolute(path).map(Path::to_owned).map_err(message))
            .collect::<Result<Vec<_>>>()?;
        let mut files = Vec::new();
        let mut incomplete = false;
        while let Some(path) = pending.pop() {
            match fs::symlink_metadata(&path) {
                Ok(metadata) if local::is_link(&metadata) => {}
                Ok(metadata) if metadata.is_file() => files.push(path),
                Ok(metadata) if metadata.is_dir() => match fs::read_dir(path) {
                    Ok(entries) => {
                        for entry in entries {
                            match entry {
                                Ok(entry) => pending.push(entry.path()),
                                Err(_) => incomplete = true,
                            }
                        }
                    }
                    Err(_) => incomplete = true,
                },
                _ => incomplete = true,
            }
            if files.len() >= 4096 && !pending.is_empty() {
                incomplete = true;
                break;
            }
        }
        let mut owners = BTreeMap::new();
        for files in files.chunks(128) {
            for entry in lock_owners(files)? {
                let process = entry.Process;
                let pid = process.dwProcessId;
                let end = entry
                    .strAppName
                    .iter()
                    .position(|&unit| unit == 0)
                    .unwrap_or(entry.strAppName.len());
                owners.entry(pid).or_insert_with(|| ProcessInfo {
                    id: ProcessId {
                        pid,
                        started: process_started(process.ProcessStartTime),
                    },
                    name: String::from_utf16_lossy(&entry.strAppName[..end]),
                    cpu: 0.0,
                    memory: 0,
                    executable: None,
                    can_terminate: pid > 4
                        && pid != std::process::id()
                        && entry.ApplicationType != RmCritical,
                });
            }
        }
        Ok(LockReport {
            processes: crate::processes::refresh_lock_owners(&app, owners.into_values().collect())?,
            incomplete,
        })
    })
    .await
}
