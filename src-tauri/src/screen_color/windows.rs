use std::{
    cell::Cell,
    thread,
    time::{Duration, Instant},
};

use tauri::AppHandle;
use windows::Win32::{
    Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, WPARAM},
    Graphics::{
        Dwm::DwmFlush,
        Gdi::{
            BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
            GetPixel, GetStockObject, ReleaseDC, SelectObject, UpdateWindow, BLACK_BRUSH,
            CAPTUREBLT, HBRUSH, HGDIOBJ, SRCCOPY,
        },
    },
    UI::{
        Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, MOD_NOREPEAT, VK_ESCAPE},
        WindowsAndMessaging::{
            CallNextHookEx, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
            GetCursorInfo, GetSystemMetrics, LoadCursorW, PeekMessageW, RegisterClassW, SetCursor,
            SetLayeredWindowAttributes, SetWindowPos, SetWindowsHookExW, UnhookWindowsHookEx,
            UnregisterClassW, CURSORINFO, HCURSOR, HHOOK, HWND_TOPMOST, IDC_CROSS, LWA_ALPHA, MSG,
            MSLLHOOKSTRUCT, PM_REMOVE, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
            SM_YVIRTUALSCREEN, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, WH_MOUSE_LL,
            WM_HOTKEY, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_SETCURSOR, WNDCLASSW, WS_EX_LAYERED,
            WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
        },
    },
};

use super::Rgb;
use crate::desktop::{blocking, message, Result};

const CANCEL_HOTKEY: i32 = 1;
const CURSOR_CLASS: windows::core::PCWSTR = windows::core::w!("Dirlume.ScreenSampler");

struct SamplingCursor {
    module: HINSTANCE,
    window: HWND,
    previous: Option<HCURSOR>,
}

unsafe extern "system" fn sampler_window(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_SETCURSOR {
        if let Ok(cursor) = unsafe { LoadCursorW(None, IDC_CROSS) } {
            unsafe { SetCursor(Some(cursor)) };
            return LRESULT(1);
        }
    }
    unsafe { DefWindowProcW(window, message, wparam, lparam) }
}

impl SamplingCursor {
    fn open(module: HINSTANCE) -> Result<Self> {
        let cursor = unsafe { LoadCursorW(None, IDC_CROSS) }.map_err(message)?;
        let previous = visible_cursor();
        let class = WNDCLASSW {
            lpfnWndProc: Some(sampler_window),
            hInstance: module,
            hCursor: cursor,
            hbrBackground: HBRUSH(unsafe { GetStockObject(BLACK_BRUSH) }.0),
            lpszClassName: CURSOR_CLASS,
            ..Default::default()
        };
        if unsafe { RegisterClassW(&class) } == 0 {
            return Err(message(std::io::Error::last_os_error()));
        }
        let mut overlay = Self {
            module,
            window: HWND::default(),
            previous: None,
        };
        // A nearly transparent window supplies the cursor across all displays without changing the system cursor scheme.
        overlay.window = unsafe {
            CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                CURSOR_CLASS,
                windows::core::w!(""),
                WS_POPUP,
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
                None,
                None,
                Some(module),
                None,
            )
        }
        .map_err(message)?;
        unsafe {
            SetLayeredWindowAttributes(overlay.window, COLORREF(0), 1, LWA_ALPHA)
                .map_err(message)?;
            // Place the sampler above existing topmost applications without taking keyboard focus.
            SetWindowPos(
                overlay.window,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
            .map_err(message)?;
            let _ = UpdateWindow(overlay.window);
            overlay.previous = previous;
            SetCursor(Some(cursor));
        }
        Ok(overlay)
    }
}

fn visible_cursor() -> Option<HCURSOR> {
    let mut info = CURSORINFO {
        cbSize: std::mem::size_of::<CURSORINFO>() as u32,
        ..Default::default()
    };
    unsafe { GetCursorInfo(&mut info) }
        .ok()
        .map(|()| info.hCursor)
}

impl Drop for SamplingCursor {
    fn drop(&mut self) {
        unsafe {
            if let Some(previous) = self.previous {
                SetCursor(Some(previous));
            }
            if !self.window.0.is_null() {
                let _ = DestroyWindow(self.window);
            }
            let _ = UnregisterClassW(CURSOR_CLASS, Some(self.module));
        }
    }
}

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

fn pick_on_worker(timeout: Duration) -> Result<Option<Rgb>> {
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
    let cursor = SamplingCursor::open(HINSTANCE(module))?;
    let deadline = Instant::now() + timeout;
    let mut event = MSG::default();
    while Instant::now() < deadline {
        while unsafe { PeekMessageW(&mut event, None, 0, 0, PM_REMOVE) }.as_bool() {
            if event.message == WM_HOTKEY && event.wParam.0 == CANCEL_HOTKEY as usize {
                return Ok(None);
            }
            unsafe { DispatchMessageW(&event) };
        }
        if PICKED.get() {
            drop(cursor);
            let _ = unsafe { DwmFlush() };
            return POINT_DOWN.take().map(sample).transpose();
        }
        thread::sleep(Duration::from_millis(8));
    }
    Ok(None)
}

pub(super) async fn pick(_app: AppHandle) -> Result<Option<Rgb>> {
    blocking(|| pick_on_worker(Duration::from_secs(120))).await
}

#[cfg(all(test, feature = "ui-automation"))]
#[test]
fn restores_the_cursor_after_a_sampling_timeout() {
    let cross = unsafe { LoadCursorW(None, IDC_CROSS) }.unwrap();
    let previous = visible_cursor();
    assert_eq!(pick_on_worker(Duration::ZERO).unwrap(), None);
    if previous != Some(cross) {
        assert_ne!(visible_cursor(), Some(cross));
    }
}
