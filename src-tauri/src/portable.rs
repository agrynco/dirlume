use std::{
    env,
    ffi::{OsStr, OsString},
    fs::{self, OpenOptions},
    io::{self, Cursor, ErrorKind, Write},
    os::windows::{fs::MetadataExt, fs::OpenOptionsExt, process::CommandExt},
    path::{Component, Path, PathBuf},
    process::{self, Command},
    sync::{Mutex, OnceLock},
    thread,
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0},
    Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT,
    System::Threading::{OpenProcess, WaitForSingleObject, CREATE_NO_WINDOW, PROCESS_SYNCHRONIZE},
};
use zip::ZipArchive;

pub const UPDATE_TARGET: &str = "windows-x86_64-portable";
const MARKER: &str = ".dirlume-portable";
const EXECUTABLE: &str = "Dirlume.exe";
const SERVER: &str = "dirlume-server.exe";
const SETTINGS: &str = "dirlume-settings.json";
const FAILURE: &str = ".dirlume-update-error";
const STAGE_PREFIX: &str = ".dirlume-update-";
const HELPER_NAME: &str = "apply.exe";
const HELPER_ARG: &str = "--apply-portable-update";
const CLEANUP_ENV: &str = "DIRLUME_PORTABLE_CLEANUP";
const MAX_BUNDLE_SIZE: u64 = 1024 * 1024 * 1024;
const MAX_SETTINGS_SIZE: u64 = 4 * 1024 * 1024;
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

pub fn root() -> Option<&'static Path> {
    static DIRECTORY: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIRECTORY
        .get_or_init(|| {
            let executable = env::current_exe().ok()?;
            let name = executable.file_name()?.to_str()?;
            let directory = executable.parent()?;
            (name.eq_ignore_ascii_case(EXECUTABLE) && directory.join(MARKER).is_file())
                .then(|| directory.to_path_buf())
        })
        .as_deref()
}

pub fn initialize(directory: &Path) {
    env::set_var(
        "WEBVIEW2_USER_DATA_FOLDER",
        directory.join(".dirlume-webview"),
    );
    let cleanup = env::var_os(CLEANUP_ENV);
    env::remove_var(CLEANUP_ENV);
    if let Some(name) = cleanup.filter(|name| {
        name.to_string_lossy().starts_with(STAGE_PREFIX)
            && matches!(
                Path::new(name).components().collect::<Vec<_>>().as_slice(),
                [Component::Normal(_)]
            )
    }) {
        let stage = directory.join(name);
        thread::spawn(move || {
            if ensure_directory(&stage).is_ok() {
                let _ = retry(|| fs::remove_dir_all(&stage));
            }
        });
    }
}

pub fn take_failure(directory: &Path) -> Option<String> {
    let path = directory.join(FAILURE);
    let failure = fs::read_to_string(&path).ok()?;
    let _ = fs::remove_file(path);
    Some(failure)
}

pub fn read_settings(directory: &Path) -> io::Result<Option<serde_json::Value>> {
    let path = directory.join(SETTINGS);
    let _guard = SETTINGS_LOCK
        .lock()
        .map_err(|_| io::Error::other("Settings lock poisoned"))?;
    match fs::metadata(&path) {
        Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_SETTINGS_SIZE => {
            let value: serde_json::Value = serde_json::from_slice(&fs::read(path)?)?;
            if value.is_object() {
                Ok(Some(value))
            } else {
                Err(io::Error::new(
                    ErrorKind::InvalidData,
                    "Invalid portable settings",
                ))
            }
        }
        Ok(_) => Err(io::Error::new(
            ErrorKind::InvalidData,
            "Invalid portable settings",
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn save_settings(directory: &Path, preferences: &serde_json::Value) -> io::Result<()> {
    let _guard = SETTINGS_LOCK
        .lock()
        .map_err(|_| io::Error::other("Settings lock poisoned"))?;
    let json = serde_json::to_vec_pretty(preferences)?;
    if !preferences.is_object() || json.len() as u64 > MAX_SETTINGS_SIZE {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "Invalid portable settings",
        ));
    }
    write_atomic(directory, SETTINGS, &json)
}

fn write_atomic(directory: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(directory.join(name))?;
    Ok(())
}

fn invalid_bundle() -> io::Error {
    io::Error::new(ErrorKind::InvalidData, "Invalid Windows Portable package")
}

fn package_path(path: &Path) -> bool {
    match path.components().collect::<Vec<_>>().as_slice() {
        [Component::Normal(name)] => [EXECUTABLE, MARKER, "LICENSE"]
            .iter()
            .any(|value| *name == OsStr::new(value)),
        [Component::Normal(directory), Component::Normal(name)] => {
            (*directory == OsStr::new("server") && *name == OsStr::new(SERVER))
                || (*directory == OsStr::new("licenses")
                    && Path::new(name).extension() == Some(OsStr::new("txt")))
        }
        _ => false,
    }
}

fn extract(bytes: &[u8], payload: &Path) -> io::Result<()> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(io::Error::other)?;
    let mut remaining = MAX_BUNDLE_SIZE;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(io::Error::other)?;
        let name = entry.enclosed_name().ok_or_else(invalid_bundle)?;
        if entry.is_dir() && (name == Path::new("server") || name == Path::new("licenses")) {
            continue;
        }
        if entry.is_symlink() || !entry.is_file() || !package_path(&name) {
            return Err(invalid_bundle());
        }
        remaining = remaining
            .checked_sub(entry.size())
            .ok_or_else(invalid_bundle)?;
        let target = payload.join(name);
        fs::create_dir_all(target.parent().ok_or_else(invalid_bundle)?)?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)?;
        io::copy(&mut entry, &mut output)?;
    }
    if !payload.join(EXECUTABLE).is_file() || !payload.join(MARKER).is_file() {
        return Err(invalid_bundle());
    }
    Ok(())
}

pub fn stage_update(directory: &Path, bytes: &[u8]) -> io::Result<()> {
    let stage = tempfile::Builder::new()
        .prefix(STAGE_PREFIX)
        .tempdir_in(directory)?;
    extract(bytes, &stage.path().join("payload"))?;
    let helper = stage.path().join(HELPER_NAME);
    fs::copy(directory.join(EXECUTABLE), &helper)?;
    Command::new(&helper)
        .arg(HELPER_ARG)
        .arg(process::id().to_string())
        .args(env::args_os().skip(1))
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()?;
    let _ = stage.keep();
    Ok(())
}

fn ensure_directory(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
        Ok(())
    } else {
        Err(io::Error::new(
            ErrorKind::InvalidData,
            "Unexpected portable directory",
        ))
    }
}

fn ensure_file(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_file() && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
        Ok(())
    } else {
        Err(io::Error::new(
            ErrorKind::InvalidData,
            "Unexpected portable file",
        ))
    }
}

fn retry<T>(mut action: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    for _ in 0..10 {
        match action() {
            Err(error) if matches!(error.raw_os_error(), Some(5 | 32 | 33)) => {
                thread::sleep(Duration::from_millis(150))
            }
            result => return result,
        }
    }
    action()
}

fn wait_for_exit(pid: u32) -> io::Result<()> {
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
            return Ok(());
        }
        return Err(error);
    }
    let wait = unsafe { WaitForSingleObject(handle, 60_000) };
    unsafe { CloseHandle(handle) };
    if wait != WAIT_OBJECT_0 {
        return Err(io::Error::new(ErrorKind::TimedOut, "Dirlume did not exit"));
    }
    Ok(())
}

fn package_files(payload: &Path) -> io::Result<Vec<PathBuf>> {
    ensure_directory(payload)?;
    let mut paths = vec![PathBuf::from(EXECUTABLE), PathBuf::from(MARKER)];
    if payload.join("server").exists() {
        ensure_directory(&payload.join("server"))?;
    }
    for name in [PathBuf::from("LICENSE"), Path::new("server").join(SERVER)] {
        if payload.join(&name).is_file() {
            paths.push(name);
        }
    }
    let licenses = payload.join("licenses");
    if licenses.is_dir() {
        ensure_directory(&licenses)?;
        for item in fs::read_dir(licenses)? {
            let item = item?;
            let name = Path::new("licenses").join(item.file_name());
            if !package_path(&name) {
                return Err(invalid_bundle());
            }
            paths.push(name);
        }
    }
    Ok(paths)
}

struct Replaced {
    path: PathBuf,
    had_original: bool,
    installed: bool,
}

fn replace(directory: &Path, stage: &Path, replaced: &mut Vec<Replaced>) -> io::Result<()> {
    let payload = stage.join("payload");
    for path in package_files(&payload)? {
        let source = payload.join(&path);
        let destination = directory.join(&path);
        ensure_file(&source)?;
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            let parent = directory.join(parent);
            if !parent.exists() {
                fs::create_dir(&parent)?;
            }
            ensure_directory(&parent)?;
        }
        let had_original = match ensure_file(&destination) {
            Ok(()) => true,
            Err(error) if error.kind() == ErrorKind::NotFound => false,
            Err(error) => return Err(error),
        };
        if had_original {
            let backup = stage.join("backup").join(&path);
            fs::create_dir_all(backup.parent().ok_or_else(invalid_bundle)?)?;
            retry(|| fs::rename(&destination, &backup))?;
        }
        replaced.push(Replaced {
            path,
            had_original,
            installed: false,
        });
        retry(|| fs::rename(&source, &destination))?;
        replaced
            .last_mut()
            .expect("replacement was recorded")
            .installed = true;
    }
    Ok(())
}

fn rollback(directory: &Path, stage: &Path, replaced: &[Replaced]) -> io::Result<()> {
    let mut failure = None;
    for item in replaced.iter().rev() {
        let destination = directory.join(&item.path);
        let restored = (|| {
            if item.installed {
                retry(|| fs::rename(&destination, stage.join("payload").join(&item.path)))?;
            }
            if item.had_original {
                retry(|| fs::rename(stage.join("backup").join(&item.path), &destination))?;
            }
            Ok(())
        })();
        if let Err(error) = restored {
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
}

fn restart(directory: &Path, stage: Option<&Path>, arguments: &[OsString]) -> io::Result<()> {
    let mut command = Command::new(directory.join(EXECUTABLE));
    command.current_dir(directory).args(arguments);
    if let Some(name) = stage.and_then(Path::file_name) {
        command.env(CLEANUP_ENV, name);
    }
    command.spawn()?;
    Ok(())
}

fn apply_update(
    directory: &Path,
    stage: &Path,
    pid: u32,
    arguments: &[OsString],
) -> io::Result<()> {
    wait_for_exit(pid)?;
    let lock = directory.join(".dirlume-update.lock");
    let _guard = retry(|| {
        OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .share_mode(0)
            .open(&lock)
    })?;
    let mut replaced = Vec::new();
    if replace(directory, stage, &mut replaced)
        .and_then(|()| restart(directory, Some(stage), arguments))
        .is_ok()
    {
        return Ok(());
    }
    let restored = rollback(directory, stage, &replaced).is_ok();
    let failure = if restored {
        "The portable update failed. Your previous copy and settings are still available."
    } else {
        "The portable update failed. Backup files are in the .dirlume-update folder beside Dirlume.exe."
    };
    let _ = write_atomic(directory, FAILURE, failure.as_bytes());
    restart(directory, restored.then_some(stage), arguments)
}

pub fn maybe_apply_update() {
    let mut arguments = env::args_os().skip(1);
    if arguments.next().as_deref() != Some(OsStr::new(HELPER_ARG)) {
        return;
    }
    let result = (|| {
        let pid = arguments
            .next()
            .and_then(|value| value.to_str()?.parse::<u32>().ok())
            .filter(|pid| *pid != 0)
            .ok_or_else(invalid_bundle)?;
        let executable = env::current_exe()?;
        let stage = executable.parent().ok_or_else(invalid_bundle)?;
        let directory = stage.parent().ok_or_else(invalid_bundle)?;
        if executable.file_name() != Some(OsStr::new(HELPER_NAME))
            || !stage
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with(STAGE_PREFIX))
            || !directory.join(MARKER).is_file()
        {
            return Err(invalid_bundle());
        }
        ensure_directory(stage)?;
        let result = apply_update(directory, stage, pid, &arguments.collect::<Vec<_>>());
        if result.is_err() && !directory.join(FAILURE).is_file() {
            let _ = write_atomic(
                directory,
                FAILURE,
                b"The portable update could not finish. Open Dirlume to continue.",
            );
        }
        result
    })();
    process::exit(i32::from(result.is_err()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::{write::SimpleFileOptions, ZipWriter};

    fn archive(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, data) in files {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn portable_zip_cannot_replace_settings_or_add_arbitrary_files() {
        let folder = tempfile::tempdir().unwrap();
        for name in [SETTINGS, "../outside", "server/other.exe"] {
            let bytes = archive(&[(name, b"payload")]);
            assert!(extract(&bytes, folder.path()).is_err());
        }
        assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 0);
    }

    #[test]
    fn partial_replacement_restores_the_app_and_keeps_settings() {
        let folder = tempfile::tempdir().unwrap();
        let directory = folder.path();
        let stage = directory.join(".dirlume-update-test");
        let preferences = serde_json::json!({ "viewFontSizes": { "left": 23 } });
        save_settings(directory, &preferences).unwrap();
        fs::write(directory.join(EXECUTABLE), "previous exe").unwrap();
        fs::write(directory.join(MARKER), "previous marker").unwrap();
        fs::create_dir(directory.join("LICENSE")).unwrap();
        let bytes = archive(&[
            (EXECUTABLE, b"new exe"),
            (MARKER, b""),
            ("LICENSE", b"license"),
        ]);
        extract(&bytes, &stage.join("payload")).unwrap();
        let mut replaced = Vec::new();
        assert!(replace(directory, &stage, &mut replaced).is_err());
        assert_eq!(fs::read(directory.join(EXECUTABLE)).unwrap(), b"new exe");
        rollback(directory, &stage, &replaced).unwrap();
        assert_eq!(
            fs::read(directory.join(EXECUTABLE)).unwrap(),
            b"previous exe"
        );
        assert_eq!(
            fs::read(directory.join(MARKER)).unwrap(),
            b"previous marker"
        );
        assert_eq!(read_settings(directory).unwrap().unwrap(), preferences);
    }
}
