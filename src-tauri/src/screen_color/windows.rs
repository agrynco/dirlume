use std::{
    cell::Cell,
    thread,
    time::{Duration, Instant},
};

use tauri::AppHandle;
use windows::Win32::{
    Foundation::{HINSTANCE, LPARAM, LRESULT, POINT, WPARAM},
    Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetPixel, ReleaseDC, SelectObject, CAPTUREBLT, HGDIOBJ, SRCCOPY,
    },
    UI::{
        Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, MOD_NOREPEAT, VK_ESCAPE},
        WindowsAndMessaging::{
            CallNextHookEx, PeekMessageW, SetWindowsHookExW, UnhookWindowsHookEx, HHOOK, MSG,
            MSLLHOOKSTRUCT, PM_REMOVE, WH_MOUSE_LL, WM_HOTKEY, WM_LBUTTONDOWN, WM_LBUTTONUP,
        },
    },
};

use super::Rgb;
use crate::desktop::{blocking, message, Result};

const CANCEL_HOTKEY: i32 = 1;

thread_local! {
    static POINT_DOWN: Cell<Option<POINT>> = const { Cell::new(None) };
    static PICKED: Cell<bool> = const { Cell::new(false) };
}

struct SamplingInput(Option<HHOOK>);

impl Drop for SamplingInput {
    fn drop(&mut self) {
        // Both registrations belong to this worker thread and are used only during the pick.
        unsafe {
            if let Some(hook) = self.0 {
                let _ = UnhookWindowsHookEx(hook);
            }
            let _ = UnregisterHotKey(None, CANCEL_HOTKEY);
        }
    }
}

unsafe extern "system" fn pick_click(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code >= 0 {
        match message.0 as u32 {
            WM_LBUTTONDOWN => {
                // WH_MOUSE_LL supplies a valid MSLLHOOKSTRUCT for this callback.
                let point = unsafe { (*(data.0 as *const MSLLHOOKSTRUCT)).pt };
                POINT_DOWN.set(Some(point));
                return LRESULT(1);
            }
            WM_LBUTTONUP if POINT_DOWN.get().is_some() => {
                PICKED.set(true);
                return LRESULT(1);
            }
            _ => {}
        }
    }
    unsafe { CallNextHookEx(None, code, message, data) }
}

fn sample(point: POINT) -> Result<Rgb> {
    // Copy only the selected pixel, including layered windows, and release the GDI handles here.
    unsafe {
        let device = GetDC(None);
        if device.0.is_null() {
            return Err("Could not read a pixel from the screen.".to_owned());
        }
        let buffer = CreateCompatibleDC(Some(device));
        let bitmap = CreateCompatibleBitmap(device, 1, 1);
        let result = if buffer.0.is_null() || bitmap.0.is_null() {
            Err("Could not read a pixel from the screen.".to_owned())
        } else {
            let previous = SelectObject(buffer, HGDIOBJ(bitmap.0));
            let color = BitBlt(
                buffer,
                0,
                0,
                1,
                1,
                Some(device),
                point.x,
                point.y,
                SRCCOPY | CAPTUREBLT,
            )
            .map(|_| GetPixel(buffer, 0, 0).0)
            .map_err(message);
            SelectObject(buffer, previous);
            color
        };
        if !bitmap.0.is_null() {
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
        }
        if !buffer.0.is_null() {
            let _ = DeleteDC(buffer);
        }
        ReleaseDC(None, device);
        let pixel = result?;
        if pixel == u32::MAX {
            return Err("Could not read a pixel from the screen.".to_owned());
        }
        let [red, green, blue, _] = pixel.to_le_bytes();
        Ok([red, green, blue])
    }
}

fn pick_on_worker() -> Result<Option<Rgb>> {
    POINT_DOWN.set(None);
    PICKED.set(false);
    // Reserve only Escape, and consume the one selection click before it reaches the other app.
    unsafe { RegisterHotKey(None, CANCEL_HOTKEY, MOD_NOREPEAT, u32::from(VK_ESCAPE.0)) }
        .map_err(message)?;
    let mut input = SamplingInput(None);
    let module =
        unsafe { windows_sys::Win32::System::LibraryLoader::GetModuleHandleW(std::ptr::null()) };
    input.0 = Some(
        unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(pick_click), Some(HINSTANCE(module)), 0) }
            .map_err(message)?,
    );
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut event = MSG::default();
    while Instant::now() < deadline {
        while unsafe { PeekMessageW(&mut event, None, 0, 0, PM_REMOVE) }.as_bool() {
            if event.message == WM_HOTKEY && event.wParam.0 == CANCEL_HOTKEY as usize {
                return Ok(None);
            }
        }
        if PICKED.get() {
            return POINT_DOWN.take().map(sample).transpose();
        }
        thread::sleep(Duration::from_millis(8));
    }
    Ok(None)
}

pub(super) async fn pick(_app: AppHandle) -> Result<Option<Rgb>> {
    blocking(pick_on_worker).await
}
