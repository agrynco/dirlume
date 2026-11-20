use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;

use crate::desktop::Result;

#[cfg(target_os = "linux")]
#[path = "screen_color/linux.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "screen_color/macos.rs"]
mod platform;
#[cfg(windows)]
#[path = "screen_color/windows.rs"]
mod platform;

type Rgb = [u8; 3];
static SAMPLING: AtomicBool = AtomicBool::new(false);

struct Sampling;

impl Drop for Sampling {
    fn drop(&mut self) {
        SAMPLING.store(false, Ordering::Release);
    }
}

#[tauri::command]
pub async fn pick_screen_color(app: AppHandle) -> Result<Option<String>> {
    if SAMPLING.swap(true, Ordering::AcqRel) {
        return Err("A screen color selection is already active.".to_owned());
    }
    let _sampling = Sampling;
    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    return platform::pick(app)
        .await
        .map(|color| color.map(|[red, green, blue]| format!("#{red:02x}{green:02x}{blue:02x}")));
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = app;
        Err("Screen color selection is unavailable on this platform.".into())
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn srgb(channels: [f64; 3]) -> Rgb {
    channels.map(|value| (value.clamp(0.0, 1.0) * 255.0).round() as u8)
}
