use std::{
    collections::HashMap,
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
    OverwriteAll,
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
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    path: String,
    pub directory: bool,
    read_only: bool,
    pub confirm_read_only: bool,
    pub replaceable: bool,
    pub allow_remember: bool,
    incoming: Option<EntryDetails>,
    existing: EntryDetails,
}

impl Conflict {
    pub fn paired(
        path: String,
        incoming: EntryDetails,
        existing: EntryDetails,
        replaceable: bool,
        read_only: bool,
    ) -> Self {
        Self {
            path,
            directory: existing.directory,
            read_only,
            confirm_read_only: read_only,
            replaceable,
            allow_remember: replaceable,
            incoming: Some(incoming),
            existing,
        }
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
            confirm_read_only: false,
            replaceable,
            allow_remember: replaceable,
            incoming: Some(EntryDetails::from(incoming)),
            existing,
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

    pub(crate) fn remote(entry: &impl crate::remote_transfer::Entry) -> Self {
        Self {
            details: EntryDetails::network(entry.size(), entry.modified(), entry.is_directory()),
            regular: entry.is_file(),
            modified: entry
                .modified()
                .ok_or_else(|| io::Error::other("The source modification time is unavailable.")),
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
    if incoming.details.directory && existing_directory {
        plan.merge = Some(same_file::Handle::from_path(target)?);
        return Ok(Some(plan));
    }
    let force_ask = regular
        && read_only
        && options.ask_read_only
        && matches!(options.policy, Policy::Ask | Policy::Newer);
    let policy = if force_ask
        || (options.policy == Policy::Newer
            && !incoming.details.directory
            && incoming.modified.is_err())
    {
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
    if policy == Policy::Ask || !regular {
        let conflict = Conflict {
            path: local::display_path(target)
                .unwrap_or_else(|_| target.to_string_lossy().into_owned()),
            directory: existing_directory,
            read_only,
            confirm_read_only: force_ask,
            replaceable: regular,
            allow_remember: regular,
            incoming: Some(incoming.details),
            existing: EntryDetails::from(&existing),
        };
        if matches!(ask(conflict)?, Decision::Skip) {
            return Ok(None);
        }
    }
    if !regular {
        return Err(io::Error::new(
            ErrorKind::AlreadyExists,
            "The destination cannot be replaced.",
        ));
    }
    Ok(Some(plan))
}

#[derive(Default)]
pub(crate) struct MoveResume {
    folders: HashMap<PathBuf, MovingFolder>,
    skipped: HashMap<PathBuf, same_file::Handle>,
    pub(crate) history: Option<Vec<crate::file_history::Commit>>,
}

struct MovingFolder {
    source: same_file::Handle,
    destination: same_file::Handle,
    path: PathBuf,
}

pub(crate) fn transfer(
    source: &Path,
    target: &Path,
    options: &Options,
    resume: &mut MoveResume,
    mut progress: impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
    mut ask: impl FnMut(Conflict) -> io::Result<Decision>,
) -> io::Result<bool> {
    let target = local::transfer_path(source, target)?;
    transfer_entry(
        source,
        &target,
        options,
        resume,
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
    resume: &mut MoveResume,
    ancestors: &mut Vec<PathBuf>,
    progress: &mut impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
    ask: &mut impl FnMut(Conflict) -> io::Result<Decision>,
) -> io::Result<bool> {
    progress(source, 0, None)?;
    let incoming = options.copy.metadata(source)?;
    if !incoming.is_dir() && !options.copy.includes(source) {
        // An excluded descendant is outside the requested copy, including during a merge.
        return Ok(!options.moving && !ancestors.is_empty());
    }
    if let Some(skipped) = resume.skipped.get(source) {
        if same_file::Handle::from_path(source).is_ok_and(|current| current == *skipped) {
            return Ok(false);
        }
    }
    let plan = if let Some(previous) = resume.folders.get(source) {
        verify_source_folder(source, &previous.source, &options.copy)?;
        verify_folder(&previous.path, &previous.destination)?;
        Some(PlannedTarget {
            path: previous.path.clone(),
            replace: None,
            merge: Some(same_file::Handle::from_path(&previous.path)?),
        })
    } else {
        plan_target(
            target,
            Incoming::local(&incoming),
            Some(source),
            options,
            ask,
        )?
    };
    let Some(PlannedTarget {
        path: target,
        replace,
        merge,
    }) = plan
    else {
        if options.moving {
            if let Ok(identity) = same_file::Handle::from_path(source) {
                resume.skipped.insert(source.to_owned(), identity);
            }
        }
        return Ok(false);
    };

    if options.moving && merge.is_none() {
        progress(source, 0, None)?;
        let proof = (resume.history.is_some() && ancestors.is_empty() && replace.is_none())
            .then(|| crate::file_history::Proof::original(source, &target, &incoming).ok())
            .flatten();
        let result = if let Some(existing) = &replace {
            existing.verify(&target)?;
            local::replace_file(source, &target)
        } else {
            local::move_item(source, target.clone())
        };
        match result {
            Ok(()) => {
                if let Some(history) = &mut resume.history {
                    history.push(crate::file_history::Commit::new(source, &target, proof));
                }
                return Ok(true);
            }
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
            let builder = fs::DirBuilder::new();
            #[cfg(unix)]
            let builder = {
                use std::os::unix::fs::DirBuilderExt;
                let mut builder = builder;
                builder.mode(0o700);
                builder
            };
            builder.create(&target)?;
            if let Err(error) = local::preserve_access(source, &target, &incoming) {
                let _ = fs::remove_dir(&target);
                return Err(error);
            }
            if let Some(history) = &mut resume.history {
                history.push(crate::file_history::Commit::new(source, &target, None));
            }
        }
        let target_folder = same_file::Handle::from_path(&target)?;
        if options.moving && !resume.folders.contains_key(source) {
            resume.folders.insert(
                source.to_owned(),
                MovingFolder {
                    source: same_file::Handle::from_path(source)?,
                    destination: same_file::Handle::from_path(&target)?,
                    path: target.clone(),
                },
            );
        }
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
                        resume,
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
            if let Some(history) = &mut resume.history {
                history.push(crate::file_history::Commit::new(source, &target, None));
            }
            resume.folders.remove(source);
        }
        return Ok(all_transferred);
    }

    let original = if options.moving {
        Some(FileRevision::capture(source, &incoming)?)
    } else {
        None
    };
    let proof =
        (!options.moving && resume.history.is_some() && ancestors.is_empty() && replace.is_none())
            .then(|| crate::file_history::Proof::original(source, &target, &incoming).ok())
            .flatten();
    let proof = local::copy_with_options(
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
        |staged| {
            Ok(proof.and_then(|proof| proof.copied_to(source, staged, options.copy.clone()).ok()))
        },
    )?;
    if let Some(history) = &mut resume.history {
        history.push(crate::file_history::Commit::new(source, &target, proof));
    }
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

pub(crate) fn remove_original(source: &Path, original: &FileRevision) -> io::Result<()> {
    with_verified_original(source, original, |staged| {
        local::with_writable_file(staged, || fs::remove_file(staged))
    })
}

pub(crate) fn with_verified_original(
    source: &Path,
    original: &FileRevision,
    publish: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<()> {
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
    let result = original.verify(&staged).and_then(|()| publish(&staged));
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cross_volume_move_preserves_the_source_directory() {
        let Some(volume) = std::env::var_os("DIRLUME_CROSS_VOLUME_TEST_ROOT") else {
            return;
        };
        let fixture = tempfile::tempdir().unwrap();
        let target_root = tempfile::tempdir_in(volume).unwrap();
        let source = fixture.path().join("private");
        let target = target_root.path().join("moved");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("note"), "private").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&source, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let options = Options {
            moving: true,
            policy: Policy::Ask,
            ask_read_only: false,
            copy: Default::default(),
        };
        assert!(transfer(
            &source,
            &target,
            &options,
            &mut MoveResume::default(),
            |_, _, _| Ok(()),
            |_| unreachable!()
        )
        .unwrap());
        assert!(!source.exists());
        assert_eq!(fs::read(target.join("note")).unwrap(), b"private");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&target).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }

    #[test]
    fn merge_reports_skipped_children() {
        let fixture = tempfile::tempdir().unwrap();
        let source = fixture.path().join("source");
        let target = fixture.path().join("target");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&target).unwrap();
        fs::create_dir(source.join("nested")).unwrap();
        fs::create_dir(target.join("nested")).unwrap();
        fs::write(source.join("nested/keep"), "incoming").unwrap();
        fs::write(target.join("nested/keep"), "original").unwrap();
        fs::write(target.join("nested/destination-only"), "preserved").unwrap();
        fs::write(source.join("new"), "created").unwrap();
        let options = Options {
            moving: false,
            policy: Policy::Ask,
            ask_read_only: false,
            copy: Default::default(),
        };
        let completed = transfer(
            &source,
            &target,
            &options,
            &mut MoveResume::default(),
            |_, _, _| Ok(()),
            |conflict| {
                assert!(!conflict.directory);
                assert!(conflict.path.ends_with("keep"));
                Ok(Decision::Skip)
            },
        )
        .unwrap();
        assert!(!completed);
        assert_eq!(fs::read(target.join("nested/keep")).unwrap(), b"original");
        assert_eq!(
            fs::read(target.join("nested/destination-only")).unwrap(),
            b"preserved"
        );
        assert_eq!(fs::read(target.join("new")).unwrap(), b"created");
    }

    #[test]
    fn retry_resumes_a_partially_moved_folder_without_prompting() {
        let fixture = tempfile::tempdir().unwrap();
        let source = fixture.path().join("source");
        let target = fixture.path().join("target");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(source.join("one"), "first").unwrap();
        fs::write(source.join("two"), "second").unwrap();
        let options = Options {
            moving: true,
            policy: Policy::Ask,
            ask_read_only: false,
            copy: Default::default(),
        };
        let mut resume = MoveResume::default();
        let result = transfer(
            &source,
            &target,
            &options,
            &mut resume,
            |path, _, _| {
                if path != source && fs::read_dir(&target)?.next().is_some() {
                    return Err(io::Error::other("Fixture blocked the second move"));
                }
                Ok(())
            },
            |_| panic!("An existing folder must merge without a prompt"),
        );
        assert!(result.is_err());
        assert_eq!(fs::read_dir(&source).unwrap().count(), 1);
        assert_eq!(fs::read_dir(&target).unwrap().count(), 1);
        assert!(transfer(
            &source,
            &target,
            &options,
            &mut resume,
            |_, _, _| Ok(()),
            |_| panic!("An existing folder must merge without a prompt")
        )
        .unwrap());
        assert!(!source.exists());
        assert_eq!(fs::read_to_string(target.join("one")).unwrap(), "first");
        assert_eq!(fs::read_to_string(target.join("two")).unwrap(), "second");
    }

    #[test]
    fn overwrite_all_setup_covers_read_only_files_in_nested_folders() {
        for moving in [false, true] {
            let fixture = tempfile::tempdir().unwrap();
            let source = fixture.path().join("source");
            let target = fixture.path().join("target");
            fs::create_dir_all(source.join("nested")).unwrap();
            fs::create_dir_all(target.join("nested")).unwrap();
            for name in ["regular", "nested/readonly"] {
                fs::write(source.join(name), "incoming").unwrap();
                fs::write(target.join(name), "original").unwrap();
            }
            let path = target.join("nested/readonly");
            let mut permissions = fs::metadata(&path).unwrap().permissions();
            permissions.set_readonly(true);
            fs::set_permissions(&path, permissions).unwrap();
            let options = Options {
                moving,
                policy: Policy::Overwrite,
                ask_read_only: true,
                copy: Default::default(),
            };
            assert!(transfer(
                &source,
                &target,
                &options,
                &mut MoveResume::default(),
                |_, _, _| Ok(()),
                |_| panic!("Overwrite all must cover regular and read-only files"),
            )
            .unwrap());
            assert_eq!(fs::read(target.join("regular")).unwrap(), b"incoming");
            assert_eq!(fs::read(path).unwrap(), b"incoming");
            assert_eq!(source.exists(), !moving);
        }
    }
}
