use std::{sync::Mutex, time::Duration};

use semver::Version;
use serde::{Deserialize, Serialize};
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
use tauri::Manager;
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

#[cfg(feature = "ui-automation")]
pub mod fixture;

const RELEASE_API: &str = "https://api.github.com/repos/agrynco/dirlume/releases/latest";
const RELEASE_DOWNLOADS: &str = "https://github.com/agrynco/dirlume/releases/download";
const CHECK_FAILED: &str = "Could not check for updates. Try again later.";
const MANIFEST_FAILED: &str = "The latest release has no compatible update package.";
const INSTALL_FAILED: &str = "Could not download, verify, or install the update. Try again.";

#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UpdateOffer {
    Install { version: String },
    Debian { version: String, url: String },
}

#[derive(Clone, Serialize)]
pub struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

impl PendingUpdate {
    fn offer(&self, update: Update) -> Result<UpdateOffer, &'static str> {
        let version = update.version.clone();
        *self.0.lock().map_err(|_| CHECK_FAILED)? = Some(update);
        Ok(UpdateOffer::Install { version })
    }
}

fn restore_update(
    app: &AppHandle,
    endpoint: &str,
    metadata: serde_json::Value,
) -> Result<Option<Update>, &'static str> {
    let updater = app
        .updater_builder()
        .endpoints(vec![Url::parse(endpoint).map_err(|_| MANIFEST_FAILED)?])
        .map_err(|_| MANIFEST_FAILED)?
        .build()
        .map_err(|_| MANIFEST_FAILED)?;
    let mut update = updater
        .restore_update(metadata)
        .map_err(|_| MANIFEST_FAILED)?;
    if let Some(update) = &mut update {
        update.timeout = Some(Duration::from_secs(900));
    }
    Ok(update)
}

impl Release {
    fn newer_version(&self, current: &Version) -> Option<Version> {
        let version = Version::parse(self.tag_name.strip_prefix('v')?).ok()?;
        (!self.draft
            && !self.prerelease
            && version.pre.is_empty()
            && version.build.is_empty()
            && version.cmp_precedence(current).is_gt())
        .then_some(version)
    }

    fn includes(&self, name: &str) -> bool {
        self.assets.iter().any(|asset| asset.name == name)
    }

    fn debian_package(&self, version: &Version) -> Option<&str> {
        let prefix = format!("Dirlume-{version}-build.");
        self.assets.iter().find_map(|Asset { name }| {
            let number = name.strip_prefix(&prefix)?.strip_suffix("-linux-x64.deb")?;
            (!number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()))
                .then_some(name.as_str())
        })
    }
}

#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    state: State<'_, PendingUpdate>,
) -> Result<Option<UpdateOffer>, &'static str> {
    #[cfg(feature = "ui-automation")]
    if std::env::var("DIRLUME_TEST_SKIP_UPDATE_CHECK").as_deref() == Ok("1") {
        return Ok(None);
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    let debian = app.env().appimage.is_none();
    #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
    let debian = false;
    #[cfg(feature = "ui-automation")]
    if let Some(fixture) = fixture::read(&app) {
        return fixture.offer(&app, &state);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("Dirlume desktop updater")
        .build()
        .map_err(|_| CHECK_FAILED)?;
    let response = client
        .get(RELEASE_API)
        .send()
        .await
        .map_err(|_| CHECK_FAILED)?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let release: Release = response
        .error_for_status()
        .map_err(|_| CHECK_FAILED)?
        .json()
        .await
        .map_err(|_| CHECK_FAILED)?;
    let Some(version) = release.newer_version(&app.package_info().version) else {
        return Ok(None);
    };
    let download_base = format!("{RELEASE_DOWNLOADS}/v{version}");
    if debian {
        let package = release.debian_package(&version).ok_or(MANIFEST_FAILED)?;
        return Ok(Some(UpdateOffer::Debian {
            version: version.to_string(),
            url: format!("{download_base}/{package}"),
        }));
    }
    if !release.includes("latest.json") {
        return Err(MANIFEST_FAILED);
    }

    let endpoint = format!("{download_base}/latest.json");
    let metadata = client
        .get(&endpoint)
        .send()
        .await
        .map_err(|_| CHECK_FAILED)?
        .error_for_status()
        .map_err(|_| MANIFEST_FAILED)?
        .json()
        .await
        .map_err(|_| MANIFEST_FAILED)?;
    let update = restore_update(&app, &endpoint, metadata)?.ok_or(MANIFEST_FAILED)?;
    let version = version.to_string();
    let package = update
        .download_url
        .as_str()
        .strip_prefix(&format!("{download_base}/"));
    if update.version != version || !package.is_some_and(|name| release.includes(name)) {
        return Err(MANIFEST_FAILED);
    }
    state.offer(update).map(Some)
}

#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    state: State<'_, PendingUpdate>,
    version: String,
    on_progress: Channel<UpdateProgress>,
) -> Result<(), &'static str> {
    let update = state
        .0
        .lock()
        .map_err(|_| INSTALL_FAILED)?
        .take()
        .filter(|update| update.version == version)
        .ok_or(INSTALL_FAILED)?;
    let mut downloaded = 0;
    let mut previous = std::time::Instant::now();
    update
        .download_and_install(
            |bytes, total| {
                downloaded += bytes as u64;
                if downloaded == bytes as u64
                    || total == Some(downloaded)
                    || previous.elapsed() >= Duration::from_millis(100)
                {
                    let _ = on_progress.send(UpdateProgress { downloaded, total });
                    previous = std::time::Instant::now();
                }
            },
            || {},
        )
        .await
        .map_err(|_| INSTALL_FAILED)?;
    if !cfg!(windows) {
        app.request_restart();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_version_must_be_a_newer_stable_product() {
        let current = Version::parse("1.2.3+123001").unwrap();
        let mut release = Release {
            tag_name: "v1.2.3".into(),
            draft: false,
            prerelease: false,
            assets: vec![],
        };
        assert!(release.newer_version(&current).is_none());
        release.tag_name = "v1.2.4-rc.1".into();
        assert!(release.newer_version(&current).is_none());
        release.tag_name = "v1.2.4".into();
        assert_eq!(release.newer_version(&current), Some(Version::new(1, 2, 4)));
        release.draft = true;
        assert!(release.newer_version(&current).is_none());
    }

    #[test]
    fn debian_offer_matches_the_release_version_and_architecture() {
        let release = Release {
            tag_name: "v1.2.4".into(),
            draft: false,
            prerelease: false,
            assets: [
                "Dirlume-1.2.3-build.123001-linux-x64.deb",
                "Dirlume-1.2.4-build.124001-linux-arm64.deb",
                "Dirlume-1.2.4-build.124001-linux-x64.deb.sha256",
                "Dirlume-1.2.4-build.124001-linux-x64.deb",
            ]
            .into_iter()
            .map(|name| Asset { name: name.into() })
            .collect(),
        };
        assert_eq!(
            release.debian_package(&Version::new(1, 2, 4)),
            Some("Dirlume-1.2.4-build.124001-linux-x64.deb")
        );
    }
}
