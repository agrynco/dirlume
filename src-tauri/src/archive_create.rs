use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs, io,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::SystemTime,
};

use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, State};

use crate::{
    archive_engine::{self, archive_args, Engine},
    desktop::{blocking, message, Result},
    ftp::matches_mask,
    local,
    local_transfer::FileRevision,
};

#[derive(Default)]
pub struct ArchiveJobs(Mutex<HashMap<u32, Arc<AtomicBool>>>);

#[derive(Serialize)]
pub struct Capabilities {
    formats: Vec<String>,
    sfx: bool,
}

#[tauri::command]
pub async fn archive_capabilities() -> Result<Capabilities> {
    blocking(|| {
        let engine = Engine::find()?;
        Ok(Capabilities {
            formats: engine.formats()?,
            sfx: engine.sfx_module().is_some(),
        })
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateArchive {
    directory: String,
    names: Vec<String>,
    destination: String,
    format: String,
    append_extension: bool,
    level: u8,
    method: String,
    solid: bool,
    password: Option<String>,
    encrypt_headers: bool,
    volume_bytes: Option<u64>,
    self_extracting: bool,
    exclude: String,
    open_for_writing: bool,
    keep_warnings: bool,
    delete_sources: bool,
    overwrite: bool,
}

#[derive(Serialize)]
pub struct CreatedArchive {
    paths: Vec<String>,
    warning: String,
}

pub const EXISTS: &str = "The destination archive already exists.";

#[tauri::command]
pub async fn create_archive(
    id: u32,
    request: CreateArchive,
    output: Channel<u8>,
    jobs: State<'_, ArchiveJobs>,
) -> Result<CreatedArchive> {
    let stopped = Arc::new(AtomicBool::new(false));
    {
        let mut running = jobs.0.lock().map_err(message)?;
        if running.contains_key(&id) {
            return Err("An archive operation is already running.".to_owned());
        }
        running.insert(id, Arc::clone(&stopped));
    }
    let result = blocking(move || create(request, stopped, output)).await;
    jobs.0.lock().map_err(message)?.remove(&id);
    result
}

#[tauri::command]
pub fn cancel_archive(id: u32, jobs: State<'_, ArchiveJobs>) -> Result<()> {
    if let Some(stopped) = jobs.0.lock().map_err(message)?.get(&id) {
        stopped.store(true, Ordering::Relaxed);
    }
    Ok(())
}

fn running(stopped: &AtomicBool) -> io::Result<()> {
    if stopped.load(Ordering::Relaxed) {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "Archive creation canceled.",
        ));
    }
    Ok(())
}

fn create(
    request: CreateArchive,
    stopped: Arc<AtomicBool>,
    output: Channel<u8>,
) -> Result<CreatedArchive> {
    let engine = Engine::find()?;
    let directory = local::absolute(&request.directory)
        .map_err(message)?
        .canonicalize()
        .map_err(message)?;
    if request.names.is_empty() || !engine.formats()?.contains(&request.format) {
        return Err("Choose archive inputs and a supported format.".to_owned());
    }
    let method_options = match request.format.as_str() {
        "7z" => &["", "LZMA2", "LZMA", "PPMd", "BZip2", "Copy"][..],
        "zip" => &["", "Deflate", "Deflate64", "BZip2", "Copy"][..],
        _ => &[""][..],
    };
    if !method_options.contains(&request.method.as_str())
        || request.level > 9
        || request.volume_bytes == Some(0)
    {
        return Err("Choose valid archive settings.".to_owned());
    }
    let password = request
        .password
        .as_deref()
        .filter(|password| !password.is_empty());
    archive_engine::validate_password(password)?;
    if (password.is_some() && !matches!(request.format.as_str(), "7z" | "zip"))
        || (request.encrypt_headers && (password.is_none() || request.format != "7z"))
    {
        return Err("The selected format does not support these encryption settings.".to_owned());
    }
    let sfx = if request.self_extracting {
        if request.format != "7z" || request.volume_bytes.is_some() {
            return Err("Choose a single 7z file for a self-extracting archive.".to_owned());
        }
        Some(
            engine
                .sfx_module()
                .ok_or("The self-extracting module is unavailable.")?,
        )
    } else {
        None
    };

    let suffix = if sfx.is_some() {
        "exe"
    } else {
        &request.format
    };
    let target = archive_destination(
        &directory,
        &request.destination,
        suffix,
        request.append_extension,
    )?;
    let parent = target
        .parent()
        .ok_or("Choose an archive destination folder.")?;
    let existing = match fs::symlink_metadata(&target) {
        Ok(metadata) => {
            if !request.overwrite || request.volume_bytes.is_some() {
                return Err(EXISTS.to_owned());
            }
            if !metadata.is_file() || local::is_link(&metadata) {
                return Err("Choose a regular file as the archive destination.".to_owned());
            }
            Some(FileRevision::capture(&target, &metadata).map_err(message)?)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(message(error)),
    };
    let roots: Vec<_> = request
        .names
        .iter()
        .map(|name| {
            local::name_component(name)
                .map(Path::to_owned)
                .map_err(message)
        })
        .collect::<Result<_>>()?;
    for root in &roots {
        let path = directory.join(root);
        let metadata = fs::symlink_metadata(&path).map_err(message)?;
        if same_file::is_same_file(&path, &target).unwrap_or(false)
            || (metadata.is_dir() && parent.starts_with(&path))
        {
            return Err("Choose an archive destination outside the selected inputs.".to_owned());
        }
    }
    let patterns: Vec<Vec<char>> = request
        .exclude
        .split(';')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_lowercase().chars().collect())
        .collect();
    let snapshot = scan(&directory, &roots, &patterns, &stopped)?;
    if snapshot.is_empty() {
        return Err("No files or folders match the archive inputs.".to_owned());
    }
    let selected: Vec<_> = if patterns.is_empty() {
        roots
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect()
    } else {
        snapshot
            .iter()
            .filter(|(_, value)| !value.directory || value.empty)
            .map(|(path, _)| path.to_string_lossy().into_owned())
            .collect()
    };
    if selected.is_empty() {
        return Err("No files or folders match the archive inputs.".to_owned());
    }
    let temp = tempfile::tempdir_in(parent).map_err(message)?;
    let staged = temp.path().join(format!("archive.{suffix}"));
    let list = archive_engine::list_file(temp.path(), selected)?;
    let mut command = engine.command("a");
    command
        .current_dir(&directory)
        .args(["-sae", "-spd", "-bso0", "-bsp2", "-bse2"])
        .arg(format!("-t{}", request.format));
    if matches!(request.format.as_str(), "7z" | "zip") {
        command.arg(format!("-mx={}", request.level));
    }
    if !request.method.is_empty() {
        let switch = if request.format == "zip" {
            "-mm="
        } else {
            "-m0="
        };
        command.arg(format!("{switch}{}", request.method));
    }
    if request.format == "7z" {
        command.arg(if request.solid { "-ms=on" } else { "-ms=off" });
    }
    if password.is_some() {
        command.arg("-p");
        if request.format == "zip" {
            command.arg("-mem=AES256");
        }
    }
    if request.encrypt_headers {
        command.arg("-mhe=on");
    }
    if request.open_for_writing {
        command.arg("-ssw");
    }
    if let Some(size) = request.volume_bytes {
        command.arg(format!("-v{size}b"));
    }
    if let Some(module) = sfx {
        command.arg(archive_engine::at("-sfx", &module));
    }
    command.arg(archive_engine::at("-i@", &list));
    archive_args(&mut command, &staged);
    let mut reported = None;
    let compressed = archive_engine::run(&mut command, password, io::sink(), |percent| {
        running(&stopped)?;
        if reported != Some(percent) {
            reported = Some(percent);
            let _ = output.send(percent);
        }
        Ok(())
    })?;
    let warned = compressed.warned();
    compressed.checked(request.keep_warnings)?;

    let paths = if let Some(revision) = existing {
        sync_file(&staged)?;
        running(&stopped).map_err(message)?;
        revision.verify(&target).map_err(message)?;
        local::replace_file(&staged, &target).map_err(message)?;
        vec![target]
    } else if request.volume_bytes.is_some() {
        publish_volumes(&staged, &target, &stopped)?
    } else {
        sync_file(&staged)?;
        running(&stopped).map_err(message)?;
        renamest::rename_exclusive(&staged, &target).map_err(message)?;
        vec![target]
    };
    let mut warning = if warned {
        "7-Zip reported warnings. Source items were kept.".to_owned()
    } else {
        String::new()
    };
    if request.delete_sources && !warned && running(&stopped).is_ok() {
        // Do not remove items which were excluded, changed, or added during compression.
        let current = scan(&directory, &roots, &patterns, &stopped);
        if !current.is_ok_and(|current| current == snapshot) {
            warning = "An input changed. The archive was created and the source items were kept."
                .to_owned();
        } else if let Err(error) =
            discard_inputs(&directory, &roots, &snapshot, patterns.is_empty())
        {
            warning = format!("The archive was created, but some input items could not be moved to Trash. {error}");
        }
    }
    let _ = output.send(100);
    Ok(CreatedArchive {
        paths: paths
            .iter()
            .map(|path| {
                local::display_path(path).unwrap_or_else(|_| path.to_string_lossy().into_owned())
            })
            .collect(),
        warning,
    })
}

fn archive_destination(
    directory: &Path,
    input: &str,
    suffix: &str,
    append: bool,
) -> Result<PathBuf> {
    if input.trim().is_empty() {
        return Err("Enter an archive destination.".to_owned());
    }
    let path = Path::new(input);
    if !path.is_absolute()
        && (path.has_root() || matches!(path.components().next(), Some(Component::Prefix(_))))
    {
        return Err("Enter an absolute or relative archive path.".to_owned());
    }
    let path = directory.join(path);
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Enter an archive filename.")?;
    local::name_component(filename).map_err(message)?;
    let parent = path
        .parent()
        .ok_or("Choose an archive destination folder.")?
        .canonicalize()
        .map_err(message)?;
    let has_extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(suffix));
    if append && !has_extension {
        Ok(parent.join(format!("{filename}.{suffix}")))
    } else {
        Ok(parent.join(filename))
    }
}

#[derive(PartialEq)]
struct Signature {
    size: u64,
    modified: Option<SystemTime>,
    directory: bool,
    empty: bool,
}

fn scan(
    directory: &Path,
    roots: &[PathBuf],
    patterns: &[Vec<char>],
    stopped: &AtomicBool,
) -> Result<BTreeMap<PathBuf, Signature>> {
    let mut files = BTreeMap::new();
    let mut pending = roots.to_vec();
    let mut visited = HashSet::new();
    while let Some(name) = pending.pop() {
        running(stopped).map_err(message)?;
        let basename = name
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("An input name cannot be represented as Unicode.")?;
        if patterns
            .iter()
            .any(|pattern| matches_mask(pattern, basename))
            || !visited.insert(name.clone())
        {
            continue;
        }
        let path = directory.join(&name);
        let metadata = fs::symlink_metadata(&path).map_err(message)?;
        if local::is_link(&metadata) || (!metadata.is_file() && !metadata.is_dir()) {
            return Err("Only regular files and folders can be archived.".to_owned());
        }
        let mut empty = false;
        if metadata.is_dir() {
            let before = pending.len();
            for entry in fs::read_dir(path).map_err(message)? {
                pending.push(name.join(entry.map_err(message)?.file_name()));
            }
            empty = before == pending.len();
        }
        files.insert(
            name,
            Signature {
                size: metadata.len(),
                modified: metadata.modified().ok(),
                directory: metadata.is_dir(),
                empty,
            },
        );
    }
    Ok(files)
}

fn discard_inputs(
    directory: &Path,
    roots: &[PathBuf],
    all: &BTreeMap<PathBuf, Signature>,
    unfiltered: bool,
) -> Result<()> {
    if unfiltered {
        trash::delete_all(roots.iter().map(|path| directory.join(path))).map_err(message)
    } else {
        trash::delete_all(
            all.iter()
                .filter(|(_, value)| !value.directory || value.empty)
                .map(|(path, _)| directory.join(path)),
        )
        .map_err(message)
    }
}

fn sync_file(path: &Path) -> Result<()> {
    fs::OpenOptions::new()
        .write(true)
        .open(path)
        .and_then(|file| file.sync_all())
        .map_err(message)
}

fn publish_volumes(staged: &Path, target: &Path, stopped: &AtomicBool) -> Result<Vec<PathBuf>> {
    let workspace = staged
        .parent()
        .ok_or("The archive staging folder is unavailable.")?;
    let base = staged
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Use a valid archive name.")?;
    let mut files = Vec::new();
    for item in fs::read_dir(workspace).map_err(message)? {
        let item = item.map_err(message)?;
        let name = item.file_name();
        if let Some(suffix) = name
            .to_str()
            .and_then(|name| name.strip_prefix(base))
            .filter(|suffix| {
                suffix.strip_prefix('.').is_some_and(|number| {
                    number.len() >= 3 && number.bytes().all(|value| value.is_ascii_digit())
                })
            })
        {
            let suffix = suffix.to_owned();
            let mut path = target.as_os_str().to_os_string();
            path.push(suffix);
            let path = PathBuf::from(path);
            local::ensure_absent(&path).map_err(message)?;
            let source = item.path();
            sync_file(&source)?;
            let identity = same_file::Handle::from_path(&source).map_err(message)?;
            files.push((source, path, identity));
        }
    }
    if files.is_empty() {
        return Err("7-Zip did not produce archive volumes.".to_owned());
    }
    files.sort_by(|left, right| left.1.cmp(&right.1));
    for (moved, (source, path, _)) in files.iter().enumerate() {
        let published = running(stopped).and_then(|()| renamest::rename_exclusive(source, path));
        if let Err(error) = published {
            for (source, path, identity) in &files[..moved] {
                if same_file::Handle::from_path(path).is_ok_and(|actual| actual == *identity) {
                    let _ = renamest::rename_exclusive(path, source);
                }
            }
            return Err(message(error));
        }
    }
    Ok(files.into_iter().map(|(_, path, _)| path).collect())
}
