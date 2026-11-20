use std::{
    ffi::OsString,
    fs,
    io::{self, ErrorKind},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use crate::local;

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Policy {
    Ask,
    Skip,
    Overwrite,
    Rename,
    Newer,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Overwrite,
    Skip,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EntryDetails {
    size: u64,
    modified: Option<u64>,
    directory: bool,
}

impl EntryDetails {
    pub fn network(size: Option<u64>, modified: Option<SystemTime>, directory: bool) -> Self {
        Self {
            size: size.unwrap_or(0),
            modified: modified.and_then(|value| {
                value
                    .duration_since(UNIX_EPOCH)
                    .ok()
                    .map(|time| time.as_secs())
            }),
            directory,
        }
    }

    fn from(metadata: &fs::Metadata) -> Self {
        Self {
            size: metadata.len(),
            modified: metadata.modified().ok().and_then(|time| {
                time.duration_since(UNIX_EPOCH)
                    .ok()
                    .map(|time| time.as_secs())
            }),
            directory: metadata.is_dir() && !local::is_link(metadata),
        }
    }

    fn from_ftp(entry: &suppaftp::list::File) -> Self {
        Self {
            size: entry.size() as u64,
            modified: entry
                .modified()
                .duration_since(UNIX_EPOCH)
                .ok()
                .map(|time| time.as_secs()),
            directory: entry.is_directory(),
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    path: String,
    pub directory: bool,
    read_only: bool,
    pub replaceable: bool,
    pub allow_remember: bool,
    incoming: Option<EntryDetails>,
    existing: EntryDetails,
}

impl Conflict {
    pub fn ftp(
        path: &str,
        incoming: &fs::Metadata,
        existing: &suppaftp::list::File,
        replaceable: bool,
    ) -> Self {
        Self::network(
            path.to_owned(),
            incoming,
            EntryDetails::from_ftp(existing),
            replaceable,
        )
    }

    pub fn network(
        path: String,
        incoming: &fs::Metadata,
        existing: EntryDetails,
        replaceable: bool,
    ) -> Self {
        Self {
            path,
            directory: existing.directory,
            read_only: false,
            replaceable,
            allow_remember: replaceable,
            incoming: Some(EntryDetails::from(incoming)),
            existing,
        }
    }

    pub fn remote(target: &Path, existing: &fs::Metadata) -> Self {
        Self {
            path: local::display_path(target)
                .unwrap_or_else(|_| target.to_string_lossy().into_owned()),
            directory: existing.is_dir(),
            read_only: existing.permissions().readonly(),
            replaceable: false,
            allow_remember: false,
            incoming: None,
            existing: EntryDetails::from(existing),
        }
    }
}

#[derive(Clone)]
pub struct Options {
    pub moving: bool,
    pub policy: Policy,
    pub ask_read_only: bool,
    pub copy: local::CopyOptions,
}

pub(crate) struct Incoming {
    details: EntryDetails,
    regular: bool,
    modified: io::Result<SystemTime>,
}

impl Incoming {
    fn local(metadata: &fs::Metadata) -> Self {
        Self {
            details: EntryDetails::from(metadata),
            regular: metadata.is_file() && !local::is_link(metadata),
            modified: metadata.modified(),
        }
    }

    pub(crate) fn ftp(entry: &suppaftp::list::File) -> Self {
        Self {
            details: EntryDetails::from_ftp(entry),
            regular: entry.is_file(),
            modified: Ok(entry.modified()),
        }
    }
}

pub(crate) struct PlannedTarget {
    pub path: PathBuf,
    pub replace: Option<FileRevision>,
    pub merge: Option<same_file::Handle>,
}

pub(crate) fn plan_target(
    target: &Path,
    incoming: Incoming,
    source: Option<&Path>,
    options: &Options,
    ask: &mut (impl FnMut(Conflict) -> io::Result<Decision> + ?Sized),
) -> io::Result<Option<PlannedTarget>> {
    let mut plan = PlannedTarget {
        path: target.to_owned(),
        replace: None,
        merge: None,
    };
    let existing = match fs::symlink_metadata(target) {
        Ok(existing) => existing,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Some(plan)),
        Err(error) => return Err(error),
    };
    if source.is_some_and(|source| same_file::is_same_file(source, target).unwrap_or(false)) {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "Source and destination are the same item.",
        ));
    }
    let read_only = existing.permissions().readonly();
    let existing_directory = existing.is_dir() && !local::is_link(&existing);
    let regular = existing.is_file() && !local::is_link(&existing) && incoming.regular;
    let merge = incoming.details.directory && existing_directory;
    let replaceable = merge || regular;
    let force_ask = read_only
        && options.ask_read_only
        && !matches!(options.policy, Policy::Skip | Policy::Rename);
    let policy = if force_ask {
        Policy::Ask
    } else {
        options.policy
    };
    match policy {
        Policy::Skip => return Ok(None),
        Policy::Rename => {
            plan.path = available_name(target)?;
            return Ok(Some(plan));
        }
        Policy::Newer
            if !incoming.details.directory && incoming.modified? <= existing.modified()? =>
        {
            return Ok(None);
        }
        _ => {}
    }
    if regular {
        plan.replace = Some(FileRevision::capture(target, &existing)?);
    }
    if merge {
        plan.merge = Some(same_file::Handle::from_path(target)?);
    }
    if policy == Policy::Ask || !replaceable {
        let conflict = Conflict {
            path: local::display_path(target)
                .unwrap_or_else(|_| target.to_string_lossy().into_owned()),
            directory: existing_directory,
            read_only,
            replaceable,
            allow_remember: !force_ask && replaceable,
            incoming: Some(incoming.details),
            existing: EntryDetails::from(&existing),
        };
        if matches!(ask(conflict)?, Decision::Skip) {
            return Ok(None);
        }
    }
    if !replaceable {
        return Err(io::Error::new(
            ErrorKind::AlreadyExists,
            "The destination cannot be replaced.",
        ));
    }
    Ok(Some(plan))
}

pub fn transfer(
    source: &Path,
    target: &Path,
    options: &Options,
    mut progress: impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
    mut ask: impl FnMut(Conflict) -> io::Result<Decision>,
) -> io::Result<bool> {
    let target = local::transfer_path(source, target)?;
    transfer_entry(
        source,
        &target,
        options,
        &mut Vec::new(),
        &mut progress,
        &mut ask,
    )
}

// KSwitcher Files tries a same-volume move first. A cross-volume move commits
// each staged file before removing that source and removes only empty folders.
fn transfer_entry(
    source: &Path,
    target: &Path,
    options: &Options,
    ancestors: &mut Vec<PathBuf>,
    progress: &mut impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
    ask: &mut impl FnMut(Conflict) -> io::Result<Decision>,
) -> io::Result<bool> {
    progress(source, 0, None)?;
    let incoming = options.copy.metadata(source)?;
    if !incoming.is_dir() && !options.copy.includes(source) {
        return Ok(false);
    }
    let Some(PlannedTarget {
        path: target,
        replace,
        merge,
    }) = plan_target(
        target,
        Incoming::local(&incoming),
        Some(source),
        options,
        ask,
    )?
    else {
        return Ok(false);
    };

    if options.moving && merge.is_none() {
        progress(source, 0, None)?;
        let result = if let Some(existing) = &replace {
            existing.verify(&target)?;
            local::replace_file(source, &target)
        } else {
            local::move_item(source, target.clone())
        };
        match result {
            Ok(()) => return Ok(true),
            Err(error) if error.kind() == ErrorKind::CrossesDevices => {}
            Err(error) => return Err(error),
        }
    }

    if incoming.is_dir() && !local::is_link(&incoming) && (options.moving || merge.is_some()) {
        progress(source, 0, None)?;
        let source_folder = same_file::Handle::from_path(source)?;
        if let Some(folder) = &merge {
            verify_folder(&target, folder)?;
        } else {
            fs::create_dir(&target)?;
        }
        let target_folder = same_file::Handle::from_path(&target)?;
        let all_transferred =
            local::with_copy_directory(source, &target, &options.copy, ancestors, |ancestors| {
                let entries = fs::read_dir(source)?.collect::<io::Result<Vec<_>>>()?;
                let mut all_transferred = true;
                for entry in entries {
                    verify_source_folder(source, &source_folder, &options.copy)?;
                    verify_folder(&target, &target_folder)?;
                    all_transferred &= transfer_entry(
                        &entry.path(),
                        &target.join(entry.file_name()),
                        options,
                        ancestors,
                        progress,
                        ask,
                    )?;
                }
                if options.copy.preserve_timestamps {
                    verify_folder(&target, &target_folder)?;
                    local::preserve_directory_times(&target, &incoming)?;
                }
                Ok(all_transferred)
            })?;
        if options.moving && all_transferred {
            verify_folder(source, &source_folder)?;
            fs::remove_dir(source)?;
        }
        return Ok(!options.moving || all_transferred);
    }

    let original = if options.moving {
        Some(FileRevision::capture(source, &incoming)?)
    } else {
        None
    };
    local::copy_with_options(
        source,
        &target,
        replace.is_some(),
        &options.copy,
        ancestors,
        |path, bytes, total| {
            progress(path, bytes, total)?;
            if path == source && total.is_none() {
                if let Some(original) = &original {
                    original.verify(source)?;
                }
                if let Some(existing) = &replace {
                    existing.verify(&target)?;
                }
            }
            Ok(())
        },
    )?;
    if let Some(original) = original {
        remove_original(source, &original).map_err(|error| {
            io::Error::other(format!(
                "Copied to {}. Could not remove {}: {error}",
                target.display(),
                source.display()
            ))
        })?;
    }
    Ok(true)
}

fn verify_source_folder(
    path: &Path,
    identity: &same_file::Handle,
    copy: &local::CopyOptions,
) -> io::Result<()> {
    if copy.follow_links
        && fs::metadata(path)?.is_dir()
        && same_file::Handle::from_path(path)? == *identity
    {
        Ok(())
    } else {
        verify_folder(path, identity)
    }
}

pub(crate) fn verify_folder(path: &Path, identity: &same_file::Handle) -> io::Result<()> {
    let current = fs::symlink_metadata(path)?;
    if current.is_dir()
        && !local::is_link(&current)
        && same_file::Handle::from_path(path)? == *identity
    {
        return Ok(());
    }
    Err(io::Error::new(
        ErrorKind::InvalidData,
        format!(
            "The folder changed during the transfer ({}).",
            path.display()
        ),
    ))
}

fn available_name(path: &Path) -> io::Result<PathBuf> {
    let stem = path.file_stem().unwrap_or_default();
    for index in 2..=10_000 {
        let mut name = OsString::from(stem);
        name.push(format!(" ({index})"));
        if let Some(extension) = path.extension() {
            name.push(".");
            name.push(extension);
        }
        let candidate = path.with_file_name(name);
        match fs::symlink_metadata(&candidate) {
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(candidate),
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        ErrorKind::AlreadyExists,
        "No available name was found.",
    ))
}

pub(crate) struct FileRevision {
    identity: same_file::Handle,
    size: u64,
    modified: SystemTime,
}

impl FileRevision {
    pub(crate) fn capture(path: &Path, metadata: &fs::Metadata) -> io::Result<Self> {
        let revision = Self {
            identity: same_file::Handle::from_path(path)?,
            size: metadata.len(),
            modified: metadata.modified()?,
        };
        revision.verify(path)?;
        Ok(revision)
    }

    pub(crate) fn verify(&self, path: &Path) -> io::Result<()> {
        let current = fs::symlink_metadata(path)?;
        if current.is_file()
            && !local::is_link(&current)
            && current.len() == self.size
            && current.modified()? == self.modified
            && same_file::Handle::from_path(path)? == self.identity
        {
            return Ok(());
        }
        Err(io::Error::new(
            ErrorKind::InvalidData,
            format!("The file changed during the transfer ({}).", path.display()),
        ))
    }
}

fn remove_original(source: &Path, original: &FileRevision) -> io::Result<()> {
    original.verify(source)?;
    let parent = source
        .parent()
        .ok_or_else(|| io::Error::other("The source has no parent folder."))?;
    let workspace = tempfile::Builder::new()
        .prefix(".dirlume-move-")
        .tempdir_in(parent)?;
    let staged = workspace
        .path()
        .join(source.file_name().expect("source has a name"));
    local::move_item(source, staged.clone())?;
    // Keep the staged original if it cannot be restored because another file
    // appeared at the source path. Never delete an unverified replacement.
    let recovery = workspace.keep();
    let result = original
        .verify(&staged)
        .and_then(|()| local::with_writable_file(&staged, || fs::remove_file(&staged)));
    if let Err(error) = result {
        if let Err(restore) = local::move_item(&staged, source.to_owned()) {
            return Err(io::Error::other(format!(
                "{error} The original is in {} ({restore}).",
                staged.display()
            )));
        }
        let _ = fs::remove_dir(recovery);
        return Err(error);
    }
    let _ = fs::remove_dir(recovery);
    Ok(())
}
