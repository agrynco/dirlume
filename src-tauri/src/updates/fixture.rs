use std::{fs, path::PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{webview::PageLoadPayload, AppHandle, Manager, Webview};

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
        key: &str,
    ) -> Result<Option<UpdateOffer>, &'static str> {
        let Some(mut update) =
            restore_update(app, key, "https://localhost/latest.json", self.metadata)?
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
