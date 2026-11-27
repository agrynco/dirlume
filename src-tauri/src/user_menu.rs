use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use ring::digest::{digest, SHA256};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::{desktop::blocking, local, message, Result};

mod shell;
mod storage;

const LOCAL_NAME: &str = ".dirlume-menu.json";
const PERSONAL_NAME: &str = "user-menu.json";
const MAX_BYTES: usize = 1024 * 1024;

#[derive(Clone, Default)]
pub struct UserMenus(Arc<Mutex<HashMap<PathBuf, String>>>);

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Entry {
    Command {
        label: String,
        hotkey: String,
        visibility: Visibility,
        mask: String,
        steps: Vec<String>,
        prompts: Vec<Prompt>,
    },
    Submenu {
        label: String,
        hotkey: String,
        children: Vec<Entry>,
    },
    Separator,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Visibility {
    Always,
    Selection,
    File,
    Folder,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    name: String,
    label: String,
    initial: String,
}

#[derive(Serialize, Deserialize)]
struct Document {
    version: u32,
    entries: Vec<Entry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    path: String,
    personal: bool,
    writable: bool,
    revision: Option<String>,
    approved: bool,
    entries: Vec<Entry>,
    error: Option<String>,
}

pub(crate) fn config_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(message)?
        .join(PERSONAL_NAME))
}

fn directory(path: &str) -> Result<PathBuf> {
    let path = local::absolute(path).map_err(message)?;
    let resolved = path.canonicalize().map_err(message)?;
    #[cfg(windows)]
    if !matches!(local::drive_type(&resolved), Some(2 | 3 | 5 | 6)) {
        return Err("Choose a local file pane to use the User Menu.".into());
    }
    #[cfg(unix)]
    if !local_volume(&resolved) {
        return Err("Choose a local file pane to use the User Menu.".into());
    }
    if !resolved.is_dir() {
        return Err("The working folder is unavailable.".into());
    }
    Ok(resolved)
}

#[cfg(unix)]
fn local_volume(path: &Path) -> bool {
    use std::{ffi::CString, mem::MaybeUninit, os::unix::ffi::OsStrExt};

    let Ok(path) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    let mut info = MaybeUninit::<libc::statfs>::zeroed();
    // statfs reads the NUL-terminated path and initializes the result on success.
    if unsafe { libc::statfs(path.as_ptr(), info.as_mut_ptr()) } != 0 {
        return false;
    }
    let info = unsafe { info.assume_init() };
    #[cfg(target_os = "macos")]
    {
        info.f_flags & libc::MNT_LOCAL as u32 != 0
    }
    #[cfg(target_os = "linux")]
    {
        // Network mounts can look like ordinary local paths to the file pane.
        !matches!(
            info.f_type as u32,
            0x6969
                | 0xff53_4d42
                | 0xfe53_4d42
                | 0x517b
                | 0x7375_7245
                | 0x00c3_6400
                | 0x5346_414f
                | 0x0102_1997
        )
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = info;
        true
    }
}

fn sources<'a>(
    folder: &'a Path,
    personal: &Path,
) -> impl Iterator<Item = (PathBuf, bool)> + use<'a> {
    folder.ancestors().enumerate().filter_map(move |(index, folder)| {
        let path = folder.join(LOCAL_NAME);
        (index == 0 || !matches!(path.symlink_metadata(), Err(error) if error.kind() == io::ErrorKind::NotFound))
            .then_some((path, false))
    }).chain(std::iter::once((personal.to_path_buf(), true)))
}

fn allowed_path(folder: &Path, personal: &Path, path: &str) -> Result<(PathBuf, bool)> {
    sources(folder, personal)
        .find(|(candidate, _)| local::display_path(candidate).is_ok_and(|name| name == path))
        .ok_or_else(|| "The menu source is no longer available.".into())
}

fn read(path: &Path) -> io::Result<Option<Vec<u8>>> {
    let meta = match path.symlink_metadata() {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !meta.is_file() {
        return Err(io::Error::other(
            "A menu definition must be a regular file.",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let mut file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other(
            "A menu definition must be a regular file.",
        ));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_BYTES {
        return Err(io::Error::other("The menu definition exceeds 1 MiB."));
    }
    Ok(Some(bytes))
}

fn revision(bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    URL_SAFE_NO_PAD.encode(digest(&SHA256, bytes).as_ref())
}

fn parse(bytes: &[u8]) -> Result<Document> {
    let document: Document = serde_json::from_slice(bytes).map_err(message)?;
    if document.version != 1 {
        return Err("This User Menu format version is unsupported.".into());
    }
    validate(&document.entries, 0)?;
    Ok(document)
}

fn prompt_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn validate(entries: &[Entry], depth: usize) -> Result<()> {
    if depth > 16 || entries.len() > 200 {
        return Err("Too many nested User Menu entries.".into());
    }
    let mut keys = HashSet::new();
    for (label, hotkey) in entries.iter().filter_map(|entry| match entry {
        Entry::Command { label, hotkey, .. } | Entry::Submenu { label, hotkey, .. } => {
            Some((label, hotkey))
        }
        Entry::Separator => None,
    }) {
        if label.trim().is_empty() {
            return Err("Every command and submenu needs a label.".into());
        }
        let key = hotkey.to_ascii_uppercase();
        let usable = key.len() == 1 && key.bytes().all(|x| x.is_ascii_alphanumeric())
            || key
                .strip_prefix('F')
                .and_then(|x| x.parse::<u8>().ok())
                .is_some_and(|n| (1..=24).contains(&n) && key == format!("F{n}"));
        if !key.is_empty() && (!usable || !keys.insert(key)) {
            return Err(format!("Invalid or duplicate hotkey: {hotkey}"));
        }
    }
    for entry in entries {
        match entry {
            Entry::Command { steps, prompts, .. } => {
                if steps.is_empty()
                    || steps.len() > 100
                    || steps
                        .iter()
                        .any(|step| step.trim().is_empty() || step.contains('\0'))
                {
                    return Err("Add between 1 and 100 nonempty shell steps.".into());
                }
                let mut names = HashSet::new();
                if prompts.iter().any(|prompt| {
                    !prompt_name(&prompt.name)
                        || prompt.label.trim().is_empty()
                        || !names.insert(&prompt.name)
                }) {
                    return Err("Prompt names must be unique letters, numbers, or underscores, and each prompt needs a label.".into());
                }
            }
            Entry::Submenu { children, .. } => validate(children, depth + 1)?,
            Entry::Separator => (),
        }
    }
    Ok(())
}

fn load_source(
    path: &Path,
    personal: bool,
    approvals: &HashMap<PathBuf, String>,
) -> Result<Source> {
    let mut source = Source {
        path: local::display_path(path).map_err(message)?,
        personal,
        writable: path.metadata().map_or_else(
            |_| {
                path.parent()
                    .and_then(|parent| parent.metadata().ok())
                    .is_none_or(|meta| !meta.permissions().readonly())
            },
            |meta| !meta.permissions().readonly(),
        ),
        revision: None,
        approved: personal,
        entries: Vec::new(),
        error: None,
    };
    match read(path) {
        Ok(Some(bytes)) => {
            let hash = revision(&bytes);
            match parse(&bytes) {
                Ok(document) => source.entries = document.entries,
                Err(error) => source.error = Some(error),
            }
            source.approved |= approvals.get(path) == Some(&hash);
            source.revision = Some(hash);
        }
        Ok(None) => (),
        Err(error) => source.error = Some(error.to_string()),
    }
    Ok(source)
}

#[tauri::command]
pub async fn user_menu_sources(
    folder: String,
    app: AppHandle,
    state: State<'_, UserMenus>,
) -> Result<Vec<Source>> {
    let menus = state.inner().clone();
    let personal = config_path(&app)?;
    blocking(move || {
        let folder = directory(&folder)?;
        let approvals = menus.0.lock().map_err(message)?;
        sources(&folder, &personal)
            .map(|(path, personal)| load_source(&path, personal, &approvals))
            .collect()
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceVersion {
    folder: String,
    path: String,
    revision: Option<String>,
}

fn checked_read(path: &Path, expected: Option<&str>) -> Result<Option<Vec<u8>>> {
    let bytes = read(path).map_err(message)?;
    if bytes.as_deref().map(revision).as_deref() != expected {
        return Err("The menu definition changed on disk. Reload before continuing.".into());
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn approve_user_menu(
    source: SourceVersion,
    app: AppHandle,
    state: State<'_, UserMenus>,
) -> Result<()> {
    let menus = state.inner().clone();
    let personal = config_path(&app)?;
    blocking(move || {
        let (path, personal) = allowed_path(&directory(&source.folder)?, &personal, &source.path)?;
        let mut approvals = menus.0.lock().map_err(message)?;
        let bytes =
            checked_read(&path, source.revision.as_deref())?.ok_or("The menu file is missing.")?;
        parse(&bytes)?;
        if !personal {
            approvals.insert(path, revision(&bytes));
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn save_user_menu(
    source: SourceVersion,
    entries: Vec<Entry>,
    app: AppHandle,
    state: State<'_, UserMenus>,
) -> Result<Source> {
    let menus = state.inner().clone();
    let personal_path = config_path(&app)?;
    blocking(move || {
        validate(&entries, 0)?;
        let (path, personal) =
            allowed_path(&directory(&source.folder)?, &personal_path, &source.path)?;
        let mut approvals = menus.0.lock().map_err(message)?;
        let bytes = serde_json::to_vec_pretty(&Document {
            version: 1,
            entries,
        })
        .map_err(message)?;
        if bytes.len() > MAX_BYTES {
            return Err("The menu definition exceeds 1 MiB.".into());
        }
        let parent = path.parent().ok_or("The menu has no parent folder.")?;
        if personal {
            fs::create_dir_all(parent).map_err(message)?;
        }
        storage::save(&path, &bytes, source.revision.as_deref())?;
        approvals.remove(&path);
        load_source(&path, personal, &approvals)
    })
    .await
}

pub(crate) use shell::Run;

impl UserMenus {
    pub(crate) fn prepare(
        &self,
        request: Run,
        personal: &Path,
        refresh_environment: bool,
    ) -> Result<(portable_pty::CommandBuilder, String)> {
        let folder = directory(&request.source.folder)?;
        let (path, personal) = allowed_path(&folder, personal, &request.source.path)?;
        let bytes = checked_read(&path, request.source.revision.as_deref())?
            .ok_or("The menu file is missing.")?;
        if !personal
            && self.0.lock().map_err(message)?.get(&path) != request.source.revision.as_ref()
        {
            return Err(
                "Review and approve this version of the folder menu before running commands."
                    .into(),
            );
        }
        let document = parse(&bytes)?;
        shell::prepare(request, &document.entries, &folder, refresh_environment)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_precedence_reads_local_parent_and_personal_in_order() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("parent");
        let folder = root.join("child");
        let personal = fixture.path().join(PERSONAL_NAME);
        fs::create_dir_all(&folder).unwrap();
        fs::write(root.join(LOCAL_NAME), b"invalid").unwrap();
        let paths: Vec<_> = sources(&folder, &personal).take(3).collect();
        assert_eq!(
            paths,
            [
                (folder.join(LOCAL_NAME), false),
                (root.join(LOCAL_NAME), false),
                (personal, true)
            ]
        );
        let invalid = load_source(&paths[1].0, false, &HashMap::new()).unwrap();
        assert!(invalid.error.is_some());
        assert!(!invalid.approved);
    }

    #[test]
    fn saves_an_exact_revision_and_preserves_external_changes() {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join(LOCAL_NAME);
        storage::save(&path, b"first", None).unwrap();
        storage::save(&path, b"saved", Some(&revision(b"first"))).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"saved");
        fs::write(&path, b"external change").unwrap();
        assert!(storage::save(&path, b"draft", Some(&revision(b"saved"))).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"external change");
        assert!(checked_read(&path, Some(&revision(b"saved"))).is_err());
    }
}
