use std::{
    fs::{self, OpenOptions},
    io,
    path::{Path, PathBuf},
};

use semver::{BuildMetadata, Version};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const BUNDLED: &str = include_str!(concat!(env!("OUT_DIR"), "/release-highlights.json"));
const HEADING: &str = "## What's new";
const MAX_HIGHLIGHTS: usize = 8;
const MAX_HIGHLIGHT_LENGTH: usize = 240;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRelease {
    version: String,
    highlights: Vec<String>,
    show_on_startup: bool,
}

fn valid_highlights(highlights: Vec<String>) -> Vec<String> {
    if highlights.len() > MAX_HIGHLIGHTS
        || highlights.iter().any(|line| {
            line.is_empty()
                || line.chars().count() > MAX_HIGHLIGHT_LENGTH
                || line.chars().any(char::is_control)
        })
    {
        return Vec::new();
    }
    highlights
}

pub(super) fn release_highlights(body: Option<&str>) -> Vec<String> {
    let Some(body) = body else { return Vec::new() };
    valid_highlights(
        body.lines()
            .skip_while(|line| line.trim() != HEADING)
            .skip(1)
            .skip_while(|line| line.is_empty())
            .map_while(|line| line.strip_prefix("- "))
            .map(str::trim)
            .map(str::to_owned)
            .collect(),
    )
}

fn product_version(app: &AppHandle) -> Version {
    let mut version = app.package_info().version.clone();
    version.build = BuildMetadata::EMPTY;
    version
}

fn bundled_highlights(document: &str, installed: &Version) -> Vec<String> {
    #[derive(Deserialize)]
    struct VersionedHighlights {
        version: String,
        highlights: Vec<String>,
    }
    let Some(release) = serde_json::from_str::<VersionedHighlights>(document)
        .ok()
        .filter(|release| release.version == installed.to_string())
    else {
        return Vec::new();
    };
    valid_highlights(release.highlights)
}

fn history_directory(app: &AppHandle) -> Result<PathBuf, tauri::Error> {
    #[cfg(feature = "ui-automation")]
    if let Some(directory) = std::env::var_os("DIRLUME_TEST_HIGHLIGHTS_DIR") {
        return Ok(PathBuf::from(directory));
    }
    #[cfg(windows)]
    if let Some(directory) = crate::portable::root() {
        return Ok(directory.join("release-highlights"));
    }
    #[cfg(feature = "ui-automation")]
    if let Some(directory) =
        super::fixture::read(app).and_then(|fixture| fixture.history_directory())
    {
        return Ok(directory);
    }
    Ok(app.path().app_config_dir()?.join("release-highlights"))
}

fn is_unseen(directory: &Path, version: &Version) -> io::Result<bool> {
    if !version.pre.is_empty() {
        return Ok(false);
    }
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let previous = name.to_str().and_then(|name| Version::parse(name).ok());
        if previous.is_some_and(|previous| {
            previous.pre.is_empty() && !previous.cmp_precedence(version).is_lt()
        }) && entry.file_type()?.is_file()
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn acknowledge(directory: &Path, version: &Version) -> io::Result<()> {
    if !is_unseen(directory, version)? {
        return Ok(());
    }
    fs::create_dir_all(directory)?;
    // Separate immutable markers let overlapping app runs preserve the highest acknowledged version.
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join(version.to_string()))
    {
        Ok(marker) => marker.sync_all(),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub async fn installed_release(app: AppHandle) -> InstalledRelease {
    let version = product_version(&app);
    let highlights = bundled_highlights(BUNDLED, &version);
    let show_on_startup = !highlights.is_empty()
        && history_directory(&app)
            .ok()
            .and_then(|directory| is_unseen(&directory, &version).ok())
            .unwrap_or(false);
    InstalledRelease {
        version: version.to_string(),
        highlights,
        show_on_startup,
    }
}

#[tauri::command]
pub async fn acknowledge_release(app: AppHandle) -> Result<(), &'static str> {
    const FAILED: &str = "Could not save your What's new preference.";
    let version = product_version(&app);
    if bundled_highlights(BUNDLED, &version).is_empty() {
        return Ok(());
    }
    acknowledge(&history_directory(&app).map_err(|_| FAILED)?, &version).map_err(|_| FAILED)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_reads_bundled_highlights_for_the_installed_product() {
        let bundled = r#"{"version":"1.2.3","highlights":["The installed version."]}"#;
        assert_eq!(
            bundled_highlights(bundled, &Version::new(1, 2, 3)),
            ["The installed version."]
        );
        assert!(bundled_highlights(bundled, &Version::new(1, 2, 4)).is_empty());
        assert!(bundled_highlights("null", &Version::new(1, 2, 3)).is_empty());
    }

    #[test]
    fn only_reads_the_current_highlights_section_from_release_notes() {
        let body =
            "## What's new\r\n\r\n- First change\r\n- Second change\r\n\r\n## Downloads\r\n- Other";
        assert_eq!(
            release_highlights(Some(body)),
            ["First change", "Second change"]
        );
        assert!(release_highlights(Some("## Downloads\n- Installer")).is_empty());
        assert!(release_highlights(None).is_empty());
        assert!(release_highlights(Some("## What's new\n- \t")).is_empty());
    }

    #[test]
    fn acknowledging_stable_versions_handles_restart_rollback_and_other_installations() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("first");
        let second = root.path().join("second");
        let older = Version::new(1, 2, 3);
        let current = Version::new(1, 4, 0);
        assert!(is_unseen(&first, &older).unwrap());
        acknowledge(&first, &current).unwrap();
        acknowledge(&first, &older).unwrap();
        assert!(!is_unseen(&first, &current).unwrap());
        assert!(!is_unseen(&first, &older).unwrap());
        assert!(!is_unseen(&first, &Version::parse("1.4.0+57").unwrap()).unwrap());
        assert!(!is_unseen(&first, &Version::parse("1.5.0-rc.1").unwrap()).unwrap());
        assert!(is_unseen(&first, &Version::new(1, 5, 0)).unwrap());
        assert!(is_unseen(&second, &current).unwrap());
        assert_eq!(fs::read_dir(&first).unwrap().count(), 1);
    }
}
