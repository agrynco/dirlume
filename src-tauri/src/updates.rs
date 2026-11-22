use std::{sync::Mutex, time::Duration};

use reqwest::{header, Client, Response, StatusCode};
use semver::Version;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
use tauri::Manager;
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

use crate::diagnostics::{self, FailureCode};

#[cfg(feature = "ui-automation")]
pub mod fixture;
pub mod highlights;

use highlights::release_highlights;

const RELEASE_API: &str = "https://api.github.com/repos/agrynco/dirlume/releases/latest";
const RELEASE_DOWNLOADS: &str = "https://github.com/agrynco/dirlume/releases/download";
const CHECK_FAILED: &str = "Could not check for updates. Try again later.";
const MANIFEST_FAILED: &str = "The latest release has no compatible update package.";
const INSTALL_FAILED: &str = "Could not download, verify, or install the update. Try again.";

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CheckTrigger {
    Automatic,
    Manual,
    #[default]
    Unknown,
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum PackageTarget {
    Debian,
    AppImage,
    WindowsInstaller,
    WindowsPortable,
    MacosApp,
    Other,
}

impl PackageTarget {
    fn installed(_app: &AppHandle) -> Self {
        if cfg!(windows) {
            #[cfg(windows)]
            let portable = crate::portable::root().is_some();
            #[cfg(not(windows))]
            let portable = false;
            if portable {
                Self::WindowsPortable
            } else {
                Self::WindowsInstaller
            }
        } else if cfg!(target_os = "linux") {
            #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
            if _app.env().appimage.is_none() {
                return Self::Debian;
            }
            Self::AppImage
        } else if cfg!(target_os = "macos") {
            Self::MacosApp
        } else {
            Self::Other
        }
    }

    fn accepts(self, name: &str) -> bool {
        match self {
            Self::Debian => name.ends_with(".deb"),
            Self::AppImage => name.ends_with(".AppImage"),
            Self::WindowsInstaller => name.ends_with(".exe") || name.ends_with(".msi"),
            Self::WindowsPortable => name.ends_with("-portable.zip"),
            Self::MacosApp => name.ends_with(".app.tar.gz"),
            Self::Other => true,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum CheckStage {
    ReleaseApi,
    ReleaseMetadata,
    UpdaterManifest,
    SelectPackage,
    PrepareOffer,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum CheckReason {
    Transport,
    Timeout,
    HttpError,
    RateLimited,
    InvalidReleaseMetadata,
    MissingManifest,
    InvalidManifest,
    MissingTargetAsset,
    IncompatibleTarget,
    VersionMismatch,
    Internal,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckCause {
    stage: CheckStage,
    reason: CheckReason,
    http_status: Option<u16>,
}

impl CheckCause {
    fn new(stage: CheckStage, reason: CheckReason) -> Self {
        Self {
            stage,
            reason,
            http_status: None,
        }
    }

    fn with_status(self, status: StatusCode) -> Self {
        Self {
            http_status: Some(status.as_u16()),
            ..self
        }
    }

    fn request(stage: CheckStage, error: &reqwest::Error, unreadable: CheckReason) -> Self {
        let reason = if error.is_timeout() {
            CheckReason::Timeout
        } else if error.is_decode() {
            unreadable
        } else {
            CheckReason::Transport
        };
        Self {
            stage,
            reason,
            http_status: error.status().map(|status| status.as_u16()),
        }
    }

    fn http(stage: CheckStage, status: StatusCode, headers: &header::HeaderMap) -> Self {
        let reason = if status == StatusCode::TOO_MANY_REQUESTS
            || status == StatusCode::FORBIDDEN
                && (headers.contains_key(header::RETRY_AFTER)
                    || headers
                        .get("x-ratelimit-remaining")
                        .is_some_and(|value| value == "0"))
        {
            CheckReason::RateLimited
        } else if stage == CheckStage::UpdaterManifest && status == StatusCode::NOT_FOUND {
            CheckReason::MissingManifest
        } else {
            CheckReason::HttpError
        };
        Self::new(stage, reason).with_status(status)
    }

    fn from_updater(error: tauri_plugin_updater::Error) -> Self {
        use tauri_plugin_updater::Error;
        match error {
            Error::TargetNotFound(_) | Error::TargetsNotFound(_) => {
                Self::new(CheckStage::SelectPackage, CheckReason::MissingTargetAsset)
            }
            Error::UnsupportedOs | Error::UnsupportedArch | Error::InvalidUpdaterFormat => {
                Self::new(CheckStage::SelectPackage, CheckReason::IncompatibleTarget)
            }
            Error::Serialization(_)
            | Error::Semver(_)
            | Error::UrlParse(_)
            | Error::InsecureTransportProtocol => {
                Self::new(CheckStage::UpdaterManifest, CheckReason::InvalidManifest)
            }
            _ => Self::new(CheckStage::PrepareOffer, CheckReason::Internal),
        }
    }

    fn message(self) -> &'static str {
        if matches!(
            self.stage,
            CheckStage::ReleaseApi | CheckStage::ReleaseMetadata | CheckStage::PrepareOffer
        ) || matches!(self.reason, CheckReason::Transport | CheckReason::Timeout)
        {
            CHECK_FAILED
        } else {
            MANIFEST_FAILED
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckError {
    message: &'static str,
    update_cause: CheckCause,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCheckDetails {
    trigger: CheckTrigger,
    build: &'static str,
    platform: &'static str,
    architecture: &'static str,
    package_target: PackageTarget,
    #[serde(flatten)]
    cause: CheckCause,
}

#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
    body: Option<String>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UpdateOffer {
    Install {
        version: String,
        highlights: Vec<String>,
    },
    Debian {
        version: String,
        url: String,
        highlights: Vec<String>,
    },
}

#[derive(Clone, Serialize)]
pub struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableState {
    preferences: Option<serde_json::Value>,
    settings_error: Option<&'static str>,
    update_error: Option<String>,
}

#[tauri::command]
pub async fn read_portable_state() -> Option<PortableState> {
    #[cfg(windows)]
    if let Some(directory) = crate::portable::root() {
        let (preferences, settings_error) = match crate::portable::read_settings(directory) {
            Ok(preferences) => (preferences, None),
            Err(_) => (
                None,
                Some("Could not read dirlume-settings.json in this portable folder."),
            ),
        };
        return Some(PortableState {
            preferences,
            settings_error,
            update_error: crate::portable::take_failure(directory),
        });
    }
    None
}

#[tauri::command]
pub async fn save_portable_preferences(preferences: serde_json::Value) -> Result<(), &'static str> {
    #[cfg(windows)]
    if let Some(directory) = crate::portable::root() {
        return crate::portable::save_settings(directory, &preferences)
            .map_err(|_| "Could not save dirlume-settings.json in this portable folder.");
    }
    let _ = preferences;
    Ok(())
}

impl PendingUpdate {
    fn offer(&self, update: Update, highlights: Vec<String>) -> Result<UpdateOffer, &'static str> {
        let version = update.version.clone();
        *self.0.lock().map_err(|_| CHECK_FAILED)? = Some(update);
        Ok(UpdateOffer::Install {
            version,
            highlights,
        })
    }
}

fn restore_update(
    app: &AppHandle,
    endpoint: &str,
    metadata: serde_json::Value,
) -> Result<Option<Update>, CheckCause> {
    let builder = app
        .updater_builder()
        .endpoints(vec![
            Url::parse(endpoint).map_err(|error| CheckCause::from_updater(error.into()))?
        ])
        .map_err(CheckCause::from_updater)?;
    #[cfg(windows)]
    let builder = if crate::portable::root().is_some() {
        builder.target(crate::portable::UPDATE_TARGET)
    } else {
        builder
    };
    let updater = builder.build().map_err(CheckCause::from_updater)?;
    let mut update = updater
        .restore_update(metadata)
        .map_err(CheckCause::from_updater)?;
    if let Some(update) = &mut update {
        update.timeout = Some(Duration::from_secs(900));
    }
    Ok(update)
}

impl Release {
    fn newer_version(&self, current: &Version) -> Result<Option<Version>, CheckCause> {
        if self.draft || self.prerelease {
            return Ok(None);
        }
        let version = self
            .tag_name
            .strip_prefix('v')
            .and_then(|tag| Version::parse(tag).ok())
            .ok_or_else(|| {
                CheckCause::new(
                    CheckStage::ReleaseMetadata,
                    CheckReason::InvalidReleaseMetadata,
                )
            })?;
        Ok((version.pre.is_empty()
            && version.build.is_empty()
            && version.cmp_precedence(current).is_gt())
        .then_some(version))
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

    fn matching_asset(
        &self,
        download_base: &str,
        package_url: &Url,
        target: PackageTarget,
    ) -> Result<(), CheckCause> {
        let Some(name) = package_url
            .as_str()
            .strip_prefix(&format!("{download_base}/"))
        else {
            return Err(CheckCause::new(
                CheckStage::SelectPackage,
                CheckReason::IncompatibleTarget,
            ));
        };
        if !self.includes(name) {
            return Err(CheckCause::new(
                CheckStage::SelectPackage,
                CheckReason::MissingTargetAsset,
            ));
        }
        if !target.accepts(name) {
            return Err(CheckCause::new(
                CheckStage::SelectPackage,
                CheckReason::IncompatibleTarget,
            ));
        }
        Ok(())
    }
}

async fn read_metadata<T: DeserializeOwned>(
    response: Response,
    stage: CheckStage,
    unreadable: CheckReason,
) -> Result<T, CheckCause> {
    let status = response.status();
    if !status.is_success() {
        return Err(CheckCause::http(stage, status, response.headers()));
    }
    response
        .json()
        .await
        .map_err(|error| CheckCause::request(stage, &error, unreadable).with_status(status))
}

#[tauri::command]
pub(crate) async fn check_for_update(
    app: AppHandle,
    state: State<'_, PendingUpdate>,
    trigger: Option<CheckTrigger>,
) -> Result<Option<UpdateOffer>, CheckError> {
    #[cfg(feature = "ui-automation")]
    if std::env::var("DIRLUME_TEST_SKIP_UPDATE_CHECK").as_deref() == Ok("1") {
        return Ok(None);
    }
    let target = PackageTarget::installed(&app);
    check_update_offer(&app, &state, target)
        .await
        .map_err(|cause| {
            let details = UpdateCheckDetails {
                trigger: trigger.unwrap_or_default(),
                build: crate::BUILD_VERSION,
                platform: std::env::consts::OS,
                architecture: std::env::consts::ARCH,
                package_target: target,
                cause,
            };
            let code = if cause.reason == CheckReason::Timeout {
                FailureCode::Timeout
            } else {
                FailureCode::NativeError
            };
            diagnostics::update_check(code, &details);
            CheckError {
                message: cause.message(),
                update_cause: cause,
            }
        })
}

async fn check_update_offer(
    app: &AppHandle,
    state: &PendingUpdate,
    target: PackageTarget,
) -> Result<Option<UpdateOffer>, CheckCause> {
    #[cfg(feature = "ui-automation")]
    if let Some(fixture) = fixture::read(app) {
        return fixture
            .offer(app, state)
            .map_err(|_| CheckCause::new(CheckStage::PrepareOffer, CheckReason::Internal));
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("Dirlume desktop updater")
        .build()
        .map_err(|error| {
            CheckCause::request(
                CheckStage::ReleaseApi,
                &error,
                CheckReason::InvalidReleaseMetadata,
            )
        })?;
    let response = client.get(RELEASE_API).send().await.map_err(|error| {
        CheckCause::request(
            CheckStage::ReleaseApi,
            &error,
            CheckReason::InvalidReleaseMetadata,
        )
    })?;
    let release_status = response.status();
    if release_status == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !release_status.is_success() {
        return Err(CheckCause::http(
            CheckStage::ReleaseApi,
            release_status,
            response.headers(),
        ));
    }
    let release: Release = read_metadata(
        response,
        CheckStage::ReleaseMetadata,
        CheckReason::InvalidReleaseMetadata,
    )
    .await?;
    let Some(version) = release
        .newer_version(&app.package_info().version)
        .map_err(|cause| cause.with_status(release_status))?
    else {
        return Ok(None);
    };
    let highlights = release_highlights(release.body.as_deref());
    let download_base = format!("{RELEASE_DOWNLOADS}/v{version}");
    if target == PackageTarget::Debian {
        let package = release.debian_package(&version).ok_or_else(|| {
            CheckCause::new(CheckStage::SelectPackage, CheckReason::MissingTargetAsset)
                .with_status(release_status)
        })?;
        return Ok(Some(UpdateOffer::Debian {
            version: version.to_string(),
            url: format!("{download_base}/{package}"),
            highlights,
        }));
    }
    if !release.includes("latest.json") {
        return Err(
            CheckCause::new(CheckStage::UpdaterManifest, CheckReason::MissingManifest)
                .with_status(release_status),
        );
    }

    let endpoint = format!("{download_base}/latest.json");
    let response = client.get(&endpoint).send().await.map_err(|error| {
        CheckCause::request(
            CheckStage::UpdaterManifest,
            &error,
            CheckReason::InvalidManifest,
        )
    })?;
    let manifest_status = response.status();
    let metadata = read_metadata(
        response,
        CheckStage::UpdaterManifest,
        CheckReason::InvalidManifest,
    )
    .await?;
    let mismatch = || {
        CheckCause::new(CheckStage::SelectPackage, CheckReason::VersionMismatch)
            .with_status(manifest_status)
    };
    let update = restore_update(app, &endpoint, metadata)
        .map_err(|cause| cause.with_status(manifest_status))?
        .ok_or_else(mismatch)?;
    if Version::parse(&update.version).ok().as_ref() != Some(&version) {
        return Err(mismatch());
    }
    release
        .matching_asset(&download_base, &update.download_url, target)
        .map_err(|cause| cause.with_status(manifest_status))?;
    state.offer(update, highlights).map(Some).map_err(|_| {
        CheckCause::new(CheckStage::PrepareOffer, CheckReason::Internal)
            .with_status(manifest_status)
    })
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
    let report_progress = |bytes: usize, total| {
        downloaded += bytes as u64;
        if downloaded == bytes as u64
            || total == Some(downloaded)
            || previous.elapsed() >= Duration::from_millis(100)
        {
            let _ = on_progress.send(UpdateProgress { downloaded, total });
            previous = std::time::Instant::now();
        }
    };
    #[cfg(windows)]
    if let Some(directory) = crate::portable::root() {
        let bytes = update
            .download(report_progress, || {})
            .await
            .map_err(|_| INSTALL_FAILED)?;
        crate::desktop::blocking(move || {
            crate::portable::stage_update(directory, &bytes).map_err(crate::desktop::message)
        })
        .await
        .map_err(|_| {
            "Could not prepare the portable update. The current copy is still available."
        })?;
        app.exit(0);
        return Ok(());
    }
    update
        .download_and_install(report_progress, || {})
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
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    #[test]
    fn update_version_must_be_a_newer_stable_product() {
        let current = Version::parse("1.2.3+123001").unwrap();
        let mut release = Release {
            tag_name: "v1.2.3".into(),
            draft: false,
            prerelease: false,
            assets: vec![],
            body: None,
        };
        assert!(release.newer_version(&current).unwrap().is_none());
        release.tag_name = "v1.2.4-rc.1".into();
        assert!(release.newer_version(&current).unwrap().is_none());
        release.tag_name = "v1.2.4".into();
        assert_eq!(
            release.newer_version(&current).unwrap(),
            Some(Version::new(1, 2, 4))
        );
        release.draft = true;
        assert!(release.newer_version(&current).unwrap().is_none());
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
            body: None,
        };
        assert_eq!(
            release.debian_package(&Version::new(1, 2, 4)),
            Some("Dirlume-1.2.4-build.124001-linux-x64.deb")
        );
        assert!(release.debian_package(&Version::new(1, 2, 5)).is_none());
    }

    #[test]
    fn distinguishes_http_errors_rate_limits_and_missing_manifests() {
        let mut headers = header::HeaderMap::new();
        let forbidden = CheckCause::http(CheckStage::ReleaseApi, StatusCode::FORBIDDEN, &headers);
        assert_eq!(forbidden.reason, CheckReason::HttpError);
        assert_eq!(forbidden.http_status, Some(403));
        headers.insert(
            "x-ratelimit-remaining",
            header::HeaderValue::from_static("0"),
        );
        assert_eq!(
            CheckCause::http(CheckStage::ReleaseApi, StatusCode::FORBIDDEN, &headers).reason,
            CheckReason::RateLimited
        );
        assert_eq!(
            CheckCause::http(
                CheckStage::ReleaseApi,
                StatusCode::TOO_MANY_REQUESTS,
                &headers
            )
            .reason,
            CheckReason::RateLimited
        );
        let missing =
            CheckCause::http(CheckStage::UpdaterManifest, StatusCode::NOT_FOUND, &headers);
        assert_eq!(missing.reason, CheckReason::MissingManifest);
        assert_eq!(missing.http_status, Some(404));
    }

    #[tokio::test]
    async fn distinguishes_transport_timeout_from_unreadable_metadata() {
        let serve = |response: String, delay: Duration| {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let endpoint = format!("http://{}/private-request", listener.local_addr().unwrap());
            let task = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                let _ = stream.read(&mut [0; 1024]);
                thread::sleep(delay);
                let _ = stream.write_all(response.as_bytes());
            });
            (endpoint, task)
        };
        let client = Client::builder().no_proxy().build().unwrap();
        for (response, stage, reason) in [
            (
                "{}",
                CheckStage::ReleaseMetadata,
                CheckReason::InvalidReleaseMetadata,
            ),
            (
                "garbled",
                CheckStage::UpdaterManifest,
                CheckReason::InvalidManifest,
            ),
        ] {
            let body = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                response.len()
            );
            let (endpoint, task) = serve(body, Duration::ZERO);
            let response = client.get(endpoint).send().await.unwrap();
            let failure = read_metadata::<Release>(response, stage, reason)
                .await
                .err()
                .unwrap();
            assert_eq!(
                (failure.stage, failure.reason, failure.http_status),
                (stage, reason, Some(200))
            );
            task.join().unwrap();
        }
        for (delay, timeout, expected) in [
            (
                Duration::ZERO,
                Duration::from_secs(1),
                CheckReason::Transport,
            ),
            (
                Duration::from_millis(200),
                Duration::from_millis(50),
                CheckReason::Timeout,
            ),
        ] {
            let (endpoint, task) = serve(String::new(), delay);
            let error = client
                .get(endpoint)
                .timeout(timeout)
                .send()
                .await
                .unwrap_err();
            let failure = CheckCause::request(
                CheckStage::ReleaseApi,
                &error,
                CheckReason::InvalidReleaseMetadata,
            );
            assert_eq!(failure.reason, expected);
            assert_eq!(failure.http_status, None);
            task.join().unwrap();
        }
    }

    #[test]
    fn distinguishes_a_missing_signed_asset_from_an_incompatible_package() {
        let release: Release = serde_json::from_value(serde_json::json!({
            "tag_name": "v1.2.4", "draft": false, "prerelease": false,
            "assets": [{ "name": "fixture-setup.exe" }, { "name": "fixture.deb" }]
        }))
        .unwrap();
        let base = "https://fixture.invalid/releases/download/v1.2.4";
        let package = |file| Url::parse(&format!("{base}/{file}")).unwrap();
        let target = PackageTarget::WindowsInstaller;
        assert!(release
            .matching_asset(base, &package("fixture-setup.exe"), target)
            .is_ok());
        assert_eq!(
            release
                .matching_asset(base, &package("absent-setup.exe"), target)
                .unwrap_err()
                .reason,
            CheckReason::MissingTargetAsset
        );
        assert_eq!(
            release
                .matching_asset(base, &package("fixture.deb"), target)
                .unwrap_err()
                .reason,
            CheckReason::IncompatibleTarget
        );

        let cause = CheckCause::from_updater(tauri_plugin_updater::Error::TargetNotFound(
            "private-source".into(),
        ));
        let details = UpdateCheckDetails {
            trigger: CheckTrigger::Manual,
            build: crate::BUILD_VERSION,
            platform: "windows",
            architecture: "x86_64",
            package_target: target,
            cause,
        };
        let value = serde_json::to_value(details).unwrap();
        assert_eq!(value["trigger"], "manual");
        assert_eq!(value["stage"], "select_package");
        assert_eq!(value["reason"], "missing_target_asset");
        assert_eq!(value["packageTarget"], "windows_installer");
        assert!(!value.to_string().contains("private-source"));
    }
}
