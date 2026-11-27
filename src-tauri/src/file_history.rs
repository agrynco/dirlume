use std::{
    collections::VecDeque,
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    desktop::{blocking, message, Result},
    local,
    local_transfer::{verify_folder, FileRevision},
};

const LIMIT: usize = 50;
const UNSUPPORTED: &str = "Undo requires regular local files, one destination, and no overwrites.";

#[derive(Clone, Default)]
pub(crate) struct History(Arc<Mutex<Entries>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationStart {
    moving: bool,
    source: String,
    destination: String,
    multiple_destinations: bool,
}

#[derive(Default)]
struct Entries {
    items: VecDeque<Batch>,
    redo: Vec<u32>,
    pending: Option<(u32, Direction)>,
}

struct Batch {
    id: u32,
    start: OperationStart,
    time: u64,
    active: bool,
    cancelled: bool,
    rows: Vec<HistoryRow>,
    changes: Vec<Commit>,
    unsupported: bool,
    interrupted: bool,
    undone: bool,
    error: Option<String>,
}

#[derive(Clone)]
pub(crate) struct Tracker {
    history: History,
    id: u32,
}

pub(crate) struct Commit {
    source: PathBuf,
    destination: PathBuf,
    proof: Option<Proof>,
    undone: bool,
}

impl Commit {
    pub(crate) fn new(source: &Path, destination: &Path, proof: Option<Proof>) -> Self {
        Self {
            source: source.to_owned(),
            destination: destination.to_owned(),
            proof,
            undone: false,
        }
    }
}

pub(crate) struct Proof {
    original: FileRevision,
    copy: Option<(FileRevision, local::CopyOptions)>,
    source_parent: same_file::Handle,
    destination_parent: same_file::Handle,
}

impl Proof {
    pub(crate) fn original(
        source: &Path,
        target: &Path,
        metadata: &fs::Metadata,
    ) -> io::Result<Self> {
        let source_parent = checked_parent(source)?;
        let destination_parent = checked_parent(target)?;
        if !local_filesystem(source_parent) || !local_filesystem(destination_parent) {
            return Err(io::ErrorKind::Unsupported.into());
        }
        Ok(Self {
            original: FileRevision::capture(source, metadata)?,
            copy: None,
            source_parent: same_file::Handle::from_path(source_parent)?,
            destination_parent: same_file::Handle::from_path(destination_parent)?,
        })
    }

    pub(crate) fn copied_to(
        mut self,
        source: &Path,
        staged: &Path,
        options: local::CopyOptions,
    ) -> io::Result<Self> {
        self.original.verify(source)?;
        let copied = FileRevision::capture(staged, &fs::symlink_metadata(staged)?)?;
        self.copy = Some((copied, options));
        Ok(self)
    }
}

fn checked_parent(path: &Path) -> io::Result<&Path> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("The parent folder is unavailable."))?;
    let canonical = parent.canonicalize()?;
    #[cfg(windows)]
    let same_path = display(&canonical).eq_ignore_ascii_case(&display(parent));
    #[cfg(not(windows))]
    let same_path = canonical == parent;
    if !parent.is_dir() || !same_path {
        return Err(io::Error::other(
            "The parent folder is unavailable or has been redirected.",
        ));
    }
    Ok(parent)
}

#[cfg(target_os = "linux")]
fn check_trash(path: &Path) -> io::Result<()> {
    use std::{
        ffi::CString,
        os::unix::{ffi::OsStrExt, fs::MetadataExt},
    };

    let home = std::env::var_os("XDG_DATA_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|value| !value.is_empty())
                .map(|home| PathBuf::from(home).join(".local/share"))
        })
        .ok_or_else(|| io::Error::other("The system Trash is unavailable."))?
        .join("Trash");
    let device = fs::metadata(path)?.dev();
    let writable = |directory: &Path| {
        directory.is_dir()
            && CString::new(directory.as_os_str().as_bytes()).is_ok_and(|path| {
                // access reads the NUL-terminated path during this call.
                unsafe { libc::access(path.as_ptr(), libc::W_OK | libc::X_OK) == 0 }
            })
    };
    if trash::os_limited::trash_folders().is_ok_and(|folders| {
        folders.iter().any(|folder| {
            fs::metadata(folder).is_ok_and(|info| info.dev() == device)
                && ["", "files", "info"].iter().all(|name| {
                    let path = folder.join(name);
                    writable(&path) || !path.exists() && writable(folder)
                })
        })
    }) {
        return Ok(());
    }
    if let Some(parent) = home.ancestors().find(|ancestor| ancestor.exists()) {
        if fs::metadata(parent).is_ok_and(|info| info.dev() == device)
            && writable(parent)
            && (!home.exists()
                || ["files", "info"].iter().all(|name| {
                    let path = home.join(name);
                    !path.exists() || writable(&path)
                }))
        {
            return Ok(());
        }
    }
    Err(io::Error::other("The system Trash is unavailable."))
}

#[cfg(windows)]
fn check_trash(_: &Path) -> io::Result<()> {
    trash::os_limited::is_empty()
        .map(|_| ())
        .map_err(io::Error::other)
}

#[cfg(target_os = "macos")]
fn check_trash(path: &Path) -> io::Result<()> {
    use std::{
        ffi::{CStr, CString, OsStr},
        mem::MaybeUninit,
        os::unix::{ffi::OsStrExt, fs::MetadataExt},
    };

    let device = fs::metadata(path)?.dev();
    let home_trash = dirs::home_dir().map(|home| home.join(".Trash"));
    let input = CString::new(path.as_os_str().as_bytes())?;
    let mut info = MaybeUninit::<libc::statfs>::zeroed();
    // statfs fills this structure for the path and includes the mounted root.
    let mounted = if unsafe { libc::statfs(input.as_ptr(), info.as_mut_ptr()) } == 0 {
        let info = unsafe { info.assume_init() };
        let name = unsafe { CStr::from_ptr(info.f_mntonname.as_ptr()) }.to_bytes();
        // geteuid reports the identity used by the per-volume Trash directory.
        Some(
            Path::new(OsStr::from_bytes(name))
                .join(".Trashes")
                .join(unsafe { libc::geteuid() }.to_string()),
        )
    } else {
        None
    };
    let available = [home_trash, mounted].into_iter().flatten().any(|trash| {
        trash
            .ancestors()
            .find(|node| node.exists())
            .is_some_and(|directory| {
                directory.is_dir()
                    && fs::metadata(directory).is_ok_and(|metadata| metadata.dev() == device)
                    && CString::new(directory.as_os_str().as_bytes()).is_ok_and(|path| {
                        // access reads the NUL-terminated directory path during this call.
                        unsafe { libc::access(path.as_ptr(), libc::W_OK | libc::X_OK) == 0 }
                    })
            })
    });
    if available {
        Ok(())
    } else {
        Err(io::Error::other("The system Trash is unavailable."))
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn check_trash(_: &Path) -> io::Result<()> {
    Err(io::Error::other("The system Trash is unavailable."))
}

#[cfg(windows)]
fn local_filesystem(path: &Path) -> bool {
    matches!(local::drive_type(path), Some(2 | 3 | 6))
}

#[cfg(unix)]
fn local_filesystem(path: &Path) -> bool {
    use std::{ffi::CString, mem::MaybeUninit, os::unix::ffi::OsStrExt};
    let Ok(path) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    let mut info = MaybeUninit::<libc::statfs>::zeroed();
    // statfs reads a NUL-terminated path and initializes the result on success.
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
        // Linux has no MNT_LOCAL flag. Restrict reversals to known local filesystems.
        matches!(
            info.f_type as u32,
            0xef53
                | 0x5846_5342
                | 0x9123_683e
                | 0xf2f5_2010
                | 0x2fc1_2fc1
                | 0x4d44
                | 0x2011_bab0
                | 0x0102_1994
        ) || cfg!(test) && info.f_type as u32 == 0x794c_7630
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = info;
        false
    }
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Direction {
    Undo,
    Redo,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryRow {
    pub(crate) source: String,
    pub(crate) destination: String,
    pub(crate) outcome: &'static str,
    pub(crate) error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryBatch {
    id: u32,
    moving: bool,
    source: String,
    destination: String,
    time: u64,
    outcome: &'static str,
    rows: Vec<HistoryRow>,
    reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryView {
    entries: Vec<HistoryBatch>,
    undo: Option<u32>,
    redo: Option<u32>,
    pending: Option<Direction>,
    changed: bool,
}

impl History {
    pub(crate) fn begin(&self, id: u32, start: OperationStart) -> Result<Tracker> {
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let mut entries = self.0.lock().map_err(message)?;
        entries.items.push_front(Batch {
            id,
            time,
            active: true,
            cancelled: false,
            unsupported: start.multiple_destinations,
            start,
            rows: Vec::new(),
            changes: Vec::new(),
            interrupted: false,
            undone: false,
            error: None,
        });
        if entries.items.len() > LIMIT {
            if let Some(expired) = entries.items.pop_back() {
                entries.redo.retain(|&id| id != expired.id);
                if entries.pending.is_some_and(|(id, _)| id == expired.id) {
                    entries.pending = None;
                }
            }
        }
        Ok(Tracker {
            history: self.clone(),
            id,
        })
    }
}

impl Tracker {
    pub(crate) fn record(&self, row: HistoryRow, mut commits: Vec<Commit>, untracked_change: bool) {
        let Ok(mut entries) = self.history.0.lock() else {
            return;
        };
        if !commits.is_empty() || untracked_change {
            entries.redo.clear();
            if let Some((id, _)) = entries.pending.take() {
                if let Some(batch) = entries.items.iter_mut().find(|batch| batch.id == id) {
                    batch.interrupted = true;
                }
            }
        }
        let Some(batch) = entries.items.iter_mut().find(|batch| batch.id == self.id) else {
            return;
        };
        if commits.len() == 1 && display(&commits[0].source) == row.source {
            let commit = &commits[0];
            batch.rows.push(HistoryRow {
                destination: display(&commit.destination),
                ..row
            });
        } else {
            batch.rows.push(row);
            batch.rows.extend(commits.iter().map(|commit| HistoryRow {
                source: display(&commit.source),
                destination: display(&commit.destination),
                outcome: "completed",
                error: None,
            }));
        }
        batch.unsupported |=
            untracked_change || commits.iter().any(|commit| commit.proof.is_none());
        batch.changes.append(&mut commits);
    }

    pub(crate) fn finish(&self, cancelled: bool) {
        if let Ok(mut entries) = self.history.0.lock() {
            if let Some(batch) = entries.items.iter_mut().find(|batch| batch.id == self.id) {
                batch.active = false;
                batch.cancelled = cancelled;
            }
        }
    }
}

pub(crate) fn display(path: &Path) -> String {
    local::display_path(path).unwrap_or_else(|_| path.to_string_lossy().into_owned())
}

impl Entries {
    fn candidate(&self, direction: Direction) -> Option<u32> {
        if self.items.iter().any(|batch| batch.active) {
            return None;
        }
        if let Some((id, pending)) = self.pending {
            return (pending == direction).then_some(id);
        }
        match direction {
            Direction::Undo => self
                .items
                .iter()
                .find(|batch| {
                    !batch.undone
                        && !batch.unsupported
                        && !batch.interrupted
                        && !batch.changes.is_empty()
                })
                .map(|batch| batch.id),
            Direction::Redo => self.redo.last().copied(),
        }
    }

    fn view(&self, changed: bool) -> HistoryView {
        HistoryView {
            undo: self.candidate(Direction::Undo),
            redo: self.candidate(Direction::Redo),
            pending: self.pending.map(|(_, direction)| direction),
            changed,
            entries: self
                .items
                .iter()
                .map(|batch| HistoryBatch {
                    id: batch.id,
                    moving: batch.start.moving,
                    source: batch.start.source.clone(),
                    destination: batch.start.destination.clone(),
                    time: batch.time,
                    rows: {
                        let mut rows = batch.rows.clone();
                        if let Some((_, direction)) = self.pending.filter(|(id, _)| *id == batch.id)
                        {
                            rows.extend(batch.changes.iter().map(|change| HistoryRow {
                                source: display(&change.source),
                                destination: display(&change.destination),
                                outcome: if change.undone == (direction == Direction::Undo) {
                                    "reversed"
                                } else {
                                    "pending"
                                },
                                error: None,
                            }));
                        }
                        rows
                    },
                    outcome: if batch.active {
                        "running"
                    } else if batch.interrupted
                        || self.pending.is_some_and(|(id, _)| id == batch.id)
                    {
                        "partial"
                    } else if batch.undone {
                        "undone"
                    } else if batch.cancelled {
                        "cancelled"
                    } else if batch.rows.iter().any(|row| row.outcome == "failed") {
                        "failed"
                    } else if batch.rows.iter().all(|row| row.outcome == "skipped") {
                        "skipped"
                    } else {
                        "completed"
                    },
                    reason: batch.error.clone().or_else(|| {
                        if batch.unsupported {
                            Some(UNSUPPORTED.into())
                        } else if batch.interrupted {
                            Some("A later transfer ended the partial retry.".into())
                        } else {
                            None
                        }
                    }),
                })
                .collect(),
        }
    }

    fn apply(&mut self, direction: Direction, expected: u32) -> Result<HistoryView> {
        if self.candidate(direction) != Some(expected) {
            return Err("The next file operation has changed. Reopen the history.".into());
        }
        let batch = self
            .items
            .iter_mut()
            .find(|batch| batch.id == expected)
            .expect("candidate");
        let undone = direction == Direction::Undo;
        let check = batch
            .changes
            .iter()
            .filter(|change| change.undone != undone)
            .try_for_each(|change| {
                change
                    .check(direction)
                    .map_err(|error| change.failure(direction, error))
            });
        if let Err(error) = check {
            batch.error = Some(error);
            return Ok(self.view(false));
        }
        batch.error = None;
        let mut changed = false;
        let mut indices: Vec<_> = (0..batch.changes.len()).collect();
        if undone {
            indices.reverse();
        }
        for index in indices {
            let change = &mut batch.changes[index];
            if change.undone == undone {
                continue;
            }
            if let Err(error) = change.apply(direction) {
                batch.error = Some(change.failure(direction, error));
                if changed {
                    self.pending = Some((expected, direction));
                }
                return Ok(self.view(changed));
            }
            changed = true;
            change.undone = undone;
        }
        batch.undone = undone;
        self.pending = None;
        if undone {
            self.redo.push(expected);
        } else {
            self.redo.pop();
        }
        Ok(self.view(changed))
    }
}

impl Commit {
    fn paths(&self, direction: Direction) -> (&Path, &Path) {
        match direction {
            Direction::Undo => (&self.destination, &self.source),
            Direction::Redo => (&self.source, &self.destination),
        }
    }

    fn failure(&self, direction: Direction, error: io::Error) -> String {
        let (from, to) = self.paths(direction);
        format!("{} → {}. {error}", display(from), display(to))
    }

    fn check(&self, direction: Direction) -> io::Result<()> {
        let proof = self
            .proof
            .as_ref()
            .ok_or_else(|| io::Error::other(UNSUPPORTED))?;
        verify_folder(
            checked_parent(&self.destination)?,
            &proof.destination_parent,
        )?;
        if direction == Direction::Redo || proof.copy.is_none() {
            verify_folder(checked_parent(&self.source)?, &proof.source_parent)?;
        }
        let (from, to) = self.paths(direction);
        if let (Direction::Undo, Some((copy, _))) = (direction, &proof.copy) {
            copy.verify(from)?;
            return check_trash(from);
        }
        proof.original.verify(from)?;
        local::ensure_absent(to)
    }

    fn apply(&mut self, direction: Direction) -> io::Result<()> {
        self.check(direction)?;
        let proof = self.proof.as_mut().expect("verified proof");
        if let Some((copy, options)) = &mut proof.copy {
            return match direction {
                Direction::Undo => {
                    crate::local_transfer::with_verified_original(&self.destination, copy, |path| {
                        trash::delete(path).map_err(io::Error::other)
                    })
                }
                Direction::Redo => {
                    let revision = local::copy_with_options(
                        &self.source,
                        &self.destination,
                        false,
                        options,
                        &mut Vec::new(),
                        |_, _, total| {
                            if total.is_none() {
                                proof.original.verify(&self.source)
                            } else {
                                Ok(())
                            }
                        },
                        |staged| {
                            verify_folder(
                                checked_parent(&self.destination)?,
                                &proof.destination_parent,
                            )?;
                            FileRevision::capture(staged, &fs::symlink_metadata(staged)?)
                        },
                    )?;
                    *copy = revision;
                    Ok(())
                }
            };
        }
        let (from, to) = match direction {
            Direction::Undo => (&self.destination, &self.source),
            Direction::Redo => (&self.source, &self.destination),
        };
        crate::local_transfer::with_verified_original(from, &proof.original, |staged| {
            let parent = if direction == Direction::Undo {
                &proof.source_parent
            } else {
                &proof.destination_parent
            };
            verify_folder(checked_parent(to)?, parent)?;
            local::move_item(staged, to.clone())
        })
    }
}

#[tauri::command]
pub(crate) fn file_operation_history(history: State<'_, History>) -> Result<HistoryView> {
    Ok(history.0.lock().map_err(message)?.view(false))
}

#[tauri::command]
pub(crate) async fn reverse_file_operation(
    direction: Direction,
    expected: u32,
    history: State<'_, History>,
) -> Result<HistoryView> {
    let history = history.inner().clone();
    blocking(move || {
        history
            .0
            .lock()
            .map_err(message)?
            .apply(direction, expected)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_transfer::{self, MoveResume, Options, Policy};

    fn track(
        history: &History,
        id: u32,
        source: &Path,
        destination: &Path,
        moving: bool,
    ) -> Tracker {
        history
            .begin(
                id,
                OperationStart {
                    moving,
                    source: display(source),
                    destination: display(destination),
                    multiple_destinations: false,
                },
            )
            .unwrap()
    }

    fn transfer(tracker: &Tracker, source: &Path, destination: &Path, moving: bool) {
        let options = Options {
            moving,
            policy: Policy::Ask,
            ask_read_only: false,
            copy: Default::default(),
        };
        let mut resume = MoveResume::default();
        resume.history = Some(Vec::new());
        assert!(local_transfer::transfer(
            source,
            destination,
            &options,
            &mut resume,
            |_, _, _| Ok(()),
            |_| panic!("fixture has no conflicts")
        )
        .unwrap());
        tracker.record(
            HistoryRow {
                source: display(source),
                destination: display(destination),
                outcome: "completed",
                error: None,
            },
            resume.history.take().unwrap(),
            false,
        );
    }

    #[test]
    fn preflights_all_moved_files_and_preserves_redo_for_a_skipped_transfer() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let from = root.join("from");
        let to = root.join("to");
        fs::create_dir(&from).unwrap();
        fs::create_dir(&to).unwrap();
        fs::write(from.join("a"), "a").unwrap();
        fs::write(from.join("b"), "b").unwrap();
        let history = History::default();
        let tracker = track(&history, 1, &from, &to, true);
        for name in ["a", "b"] {
            transfer(&tracker, &from.join(name), &to.join(name), true);
        }
        tracker.finish(false);
        fs::write(from.join("a"), "occupied").unwrap();
        {
            let mut entries = history.0.lock().unwrap();
            assert_eq!(entries.candidate(Direction::Undo), Some(1));
            assert!(!entries.apply(Direction::Undo, 1).unwrap().changed);
            assert!(to.join("a").exists() && to.join("b").exists());
        }
        fs::remove_file(from.join("a")).unwrap();
        assert!(
            history
                .0
                .lock()
                .unwrap()
                .apply(Direction::Undo, 1)
                .unwrap()
                .changed
        );
        let skipped = track(&history, 2, &from, &to, true);
        skipped.record(
            HistoryRow {
                source: display(&from.join("a")),
                destination: display(&to.join("a")),
                outcome: "skipped",
                error: None,
            },
            Vec::new(),
            false,
        );
        skipped.finish(false);
        let mut entries = history.0.lock().unwrap();
        assert!(entries.apply(Direction::Redo, 1).unwrap().changed);
        assert_eq!(fs::read(to.join("a")).unwrap(), b"a");
        assert_eq!(fs::read(to.join("b")).unwrap(), b"b");
        assert!(!from.join("a").exists() && !from.join("b").exists());
    }

    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    #[test]
    #[ignore = "requires an isolated desktop or Trash directory"]
    fn undo_copy_trashes_the_copy_and_redo_recreates_it() {
        assert!(std::env::var_os("DIRLUME_HISTORY_TRASH_FIXTURE").is_some());
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let source = root.join("source");
        let destination = root.join("destination");
        fs::write(&source, "verified content").unwrap();
        let history = History::default();
        let tracker = track(&history, 1, &source, &destination, false);
        transfer(&tracker, &source, &destination, false);
        tracker.finish(false);
        let mut entries = history.0.lock().unwrap();
        assert!(
            entries.apply(Direction::Undo, 1).unwrap().changed,
            "{:?}",
            entries.items[0].error
        );
        assert!(!destination.exists());
        assert_eq!(fs::read(&source).unwrap(), b"verified content");
        #[cfg(target_os = "linux")]
        {
            let trash = trash::os_limited::list().unwrap();
            assert_eq!(trash.len(), 1);
            assert_eq!(trash[0].name, "destination");
        }
        assert!(entries.apply(Direction::Redo, 1).unwrap().changed);
        assert_eq!(fs::read(&destination).unwrap(), b"verified content");
    }
}
