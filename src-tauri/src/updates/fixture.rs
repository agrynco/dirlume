use std::{fs, path::PathBuf, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{webview::PageLoadPayload, AppHandle, LogicalSize, Manager, PhysicalPosition, Webview};

use crate::desktop::{message, Result as DesktopResult};

use super::{restore_update, PendingUpdate, UpdateOffer, MANIFEST_FAILED};

#[derive(Deserialize)]
pub struct UpdateFixture {
    result: PathBuf,
    expected: String,
    reject: bool,
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
    pub fn offer(
        self,
        app: &AppHandle,
        pending: &PendingUpdate,
    ) -> Result<Option<UpdateOffer>, &'static str> {
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
        pending.offer(update).map(Some)
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
    let script = include_str!("../../../scripts/updater-smoke-webview.js");
    let _ = webview.eval(format!("({script})({upgraded}, {});", fixture.reject));
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

async fn wait_for_window(mut ready: impl FnMut() -> DesktopResult<bool>) -> DesktopResult<()> {
    for _ in 0..100 {
        if ready()? {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err("The native Options window did not reach the expected state.".to_owned())
}

#[tauri::command]
pub async fn updater_fixture_options_window(app: AppHandle) -> DesktopResult<()> {
    read(&app).ok_or("Missing updater fixture configuration")?;
    let main = app
        .get_webview_window("main")
        .ok_or("Missing main window")?;
    wait_for_window(|| {
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
    wait_for_window(|| {
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
    wait_for_window(|| {
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
    options.close().map_err(message)?;
    main.set_size(original_size).map_err(message)?;
    main.set_position(original).map_err(message)
}
