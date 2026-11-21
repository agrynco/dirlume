use std::{fs, path::PathBuf, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{webview::PageLoadPayload, AppHandle, LogicalSize, Manager, PhysicalPosition, Webview};

use crate::desktop::{message, Result as DesktopResult};

use super::{restore_update, PendingUpdate, UpdateOffer, MANIFEST_FAILED};

#[derive(Deserialize)]
pub struct UpdateFixture {
    result: PathBuf,
    phase: PathBuf,
    expected: String,
    reject: bool,
    #[serde(default)]
    replacement_failure: bool,
    #[serde(default)]
    check_clipboard: bool,
    #[serde(default)]
    check_screen_color: bool,
    #[serde(default)]
    restart_check: bool,
    #[serde(default)]
    offline_launch: bool,
    #[serde(default)]
    debian_url: Option<String>,
    metadata: serde_json::Value,
}

pub fn read(app: &AppHandle) -> Option<UpdateFixture> {
    if app.config().identifier != "io.github.agrynco.dirlume.updater-smoke" {
        return None;
    }
    let path = std::env::args_os()
        .skip_while(|argument| argument != "--updater-fixture")
        .nth(1)?;
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

impl UpdateFixture {
    pub(super) fn history_directory(&self) -> Option<PathBuf> {
        let name = if self.debian_url.is_some() {
            "debian-release-highlights"
        } else {
            "release-highlights"
        };
        Some(self.result.parent()?.join(name))
    }

    pub fn offer(
        self,
        app: &AppHandle,
        pending: &PendingUpdate,
    ) -> Result<Option<UpdateOffer>, &'static str> {
        let highlights = super::release_highlights(self.metadata["notes"].as_str());
        if self.offline_launch || app.package_info().version.to_string() == self.expected {
            return Ok(None);
        }
        if let Some(url) = self.debian_url {
            return Ok(Some(UpdateOffer::Debian {
                version: self.expected,
                url,
                highlights,
            }));
        }
        let Some(mut update) = restore_update(app, "https://localhost/latest.json", self.metadata)?
        else {
            return Ok(None);
        };
        if update.download_url.scheme() != "http"
            || update.download_url.host_str() != Some("127.0.0.1")
            || update.version != self.expected
        {
            return Err(MANIFEST_FAILED);
        }
        update.no_proxy = true;
        pending.offer(update, highlights).map(Some)
    }
}

pub fn page_loaded(webview: &Webview, payload: &PageLoadPayload<'_>) {
    if payload.event() != tauri::webview::PageLoadEvent::Finished || webview.label() != "main" {
        return;
    }
    let app = webview.app_handle();
    let Some(fixture) = read(app) else {
        return;
    };
    let upgraded = app.package_info().version.to_string() == fixture.expected;
    let _ = fs::write(
        &fixture.phase,
        format!("{}: loading the main WebView", app.package_info().version),
    );
    #[cfg(windows)]
    let portable = crate::portable::root().is_some();
    #[cfg(not(windows))]
    let portable = false;
    let script = include_str!("../../../scripts/updater-smoke-webview.js");
    let test = serde_json::json!({
        "upgraded": upgraded,
        "portable": portable,
        "reject": fixture.reject,
        "replacementFailure": fixture.replacement_failure,
        "checkClipboard": fixture.check_clipboard,
        "checkScreenColor": fixture.check_screen_color,
        "fixtureDirectory": fixture.result.parent(),
        "version": fixture.expected,
        "highlights": fixture.metadata["notes"].as_str().map(|body| super::release_highlights(Some(body))),
        "restartCheck": fixture.restart_check,
        "offlineLaunch": fixture.offline_launch,
        "debian": fixture.debian_url.is_some(),
    });
    let _ = webview.eval(format!("({script})({test});"));
}

#[tauri::command]
pub fn updater_fixture_phase(app: AppHandle, phase: String) -> DesktopResult<()> {
    let fixture = read(&app).ok_or("Missing updater fixture configuration")?;
    fs::write(
        fixture.phase,
        format!("{}: {phase}", app.package_info().version),
    )
    .map_err(message)
}

#[tauri::command]
pub fn updater_fixture_result(app: AppHandle, error: Option<String>) -> Result<(), String> {
    #[derive(Serialize)]
    struct Report {
        version: String,
        error: Option<String>,
    }
    let fixture = read(&app).ok_or_else(|| "Missing updater fixture configuration".to_string())?;
    let report = Report {
        version: app.package_info().version.to_string(),
        error,
    };
    let bytes = serde_json::to_vec(&report).map_err(|error| error.to_string())?;
    fs::write(fixture.result, bytes).map_err(|error| error.to_string())?;
    app.exit(i32::from(report.error.is_some()));
    Ok(())
}

async fn wait_for_window(
    action: &str,
    mut ready: impl FnMut() -> DesktopResult<bool>,
) -> DesktopResult<()> {
    for _ in 0..200 {
        if ready()? {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err(format!("Timed out waiting for {action}."))
}

#[cfg(target_os = "macos")]
async fn activate_installed_bundle() -> DesktopResult<()> {
    // The updater reopens the bundle in the background on macOS.
    crate::desktop::blocking(|| {
        let executable = std::env::current_exe().map_err(message)?;
        let bundle = executable
            .ancestors()
            .nth(3)
            .filter(|path| path.extension().is_some_and(|extension| extension == "app"))
            .ok_or("Missing the installed updater fixture bundle")?;
        let result = std::process::Command::new("/usr/bin/open")
            .arg(bundle)
            .output()
            .map_err(message)?;
        if !result.status.success() {
            return Err(String::from_utf8_lossy(&result.stderr).into_owned());
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn updater_fixture_normal_window(app: AppHandle) -> DesktopResult<()> {
    read(&app).ok_or("Missing updater fixture configuration")?;
    let main = app
        .get_webview_window("main")
        .ok_or("Missing main window")?;
    wait_for_window("the main window to become visible", || {
        main.is_visible().map_err(message)
    })
    .await?;
    if main.is_maximized().map_err(message)? {
        main.unmaximize().map_err(message)?;
    }
    main.set_size(LogicalSize::new(780, 480)).map_err(message)?;
    main.center().map_err(message)?;
    main.set_focus().map_err(message)?;
    #[cfg(target_os = "macos")]
    {
        activate_installed_bundle().await?;
        wait_for_window("the installed application to activate", || {
            main.is_focused().map_err(message)
        })
        .await?;
    }
    wait_for_window("a resizable main window in its normal state", || {
        Ok(main.is_resizable().map_err(message)?
            && !main.is_maximized().map_err(message)?
            && !main.is_fullscreen().map_err(message)?)
    })
    .await
}

#[tauri::command]
pub async fn updater_fixture_options_window(app: AppHandle) -> DesktopResult<()> {
    read(&app).ok_or("Missing updater fixture configuration")?;
    let main = app
        .get_webview_window("main")
        .ok_or("Missing main window")?;
    wait_for_window("the native Options window to appear", || {
        app.get_webview_window("options")
            .map_or(Ok(false), |window| window.is_visible().map_err(message))
    })
    .await?;
    let options = app
        .get_webview_window("options")
        .ok_or("Missing Options window")?;
    if !options.is_decorated().map_err(message)? || !options.is_resizable().map_err(message)? {
        return Err("Expected a decorated, resizable Options window.".to_owned());
    }

    let monitor = main
        .current_monitor()
        .map_err(message)?
        .ok_or("Missing main window monitor")?;
    let origin = monitor.work_area().position;
    let original = main.outer_position().map_err(message)?;
    let original_size = main.inner_size().map_err(message)?;
    main.set_size(LogicalSize::new(760, 460)).map_err(message)?;
    main.set_position(PhysicalPosition::new(origin.x + 188, origin.y + 48))
        .map_err(message)?;
    options
        .set_position(PhysicalPosition::new(origin.x + 32, origin.y + 96))
        .map_err(message)?;
    wait_for_window("Options to move beyond the main window", || {
        let position = options.outer_position().map_err(message)?;
        let main_position = main.outer_position().map_err(message)?;
        Ok(
            position.x.abs_diff(origin.x + 32) <= 8
                && main_position.x.abs_diff(origin.x + 188) <= 8,
        )
    })
    .await?;

    let moved = options.outer_position().map_err(message)?;
    main.set_position(PhysicalPosition::new(origin.x + 248, origin.y + 48))
        .map_err(message)?;
    wait_for_window("the main window to move independently of Options", || {
        Ok(main
            .outer_position()
            .map_err(message)?
            .x
            .abs_diff(origin.x + 248)
            <= 8)
    })
    .await?;
    if options.outer_position().map_err(message)? != moved
        || !options.is_visible().map_err(message)?
    {
        return Err("Options did not stay visible in its independent position.".to_owned());
    }
    crate::desktop::set_appearance_picker(options.clone(), true).await?;
    wait_for_window("the appearance picker to focus the main window", || {
        Ok(!options.is_visible().map_err(message)? && main.is_focused().map_err(message)?)
    })
    .await?;
    crate::desktop::set_appearance_picker(main.clone(), false).await?;
    wait_for_window("the appearance picker to return focus to Options", || {
        Ok(options.is_visible().map_err(message)? && options.is_focused().map_err(message)?)
    })
    .await?;
    options.close().map_err(message)?;
    main.set_size(original_size).map_err(message)?;
    main.set_position(original).map_err(message)?;
    #[cfg(target_os = "macos")]
    {
        activate_installed_bundle().await?;
        main.set_focus().map_err(message)?;
        wait_for_window(
            "the main window to regain focus after closing Options",
            || main.is_focused().map_err(message),
        )
        .await?;
    }
    Ok(())
}
