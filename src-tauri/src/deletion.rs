use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{self, ErrorKind},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, State};

use crate::{
    desktop::{blocking_for, message, Result},
    disk_space, local,
};

#[derive(Default)]
pub(crate) struct DeleteJobs(Mutex<HashMap<u32, Arc<Job>>>);

#[derive(Default)]
struct Job {
    cancelled: AtomicBool,
    pending: Mutex<Option<(u64, mpsc::Sender<Decision>)>>,
}

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Decision {
    Retry,
    Skip,
    SkipRemaining,
}

impl Job {
    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
        if let Ok(mut pending) = self.pending.lock() {
            pending.take();
        }
    }

    fn answer(&self, token: u64, decision: Decision) -> Result<()> {
        let mut pending = self.pending.lock().map_err(message)?;
        let Some((_, reply)) = pending.take_if(|(expected, _)| *expected == token) else {
            return Err("This item no longer needs a decision.".into());
        };
        reply.send(decision).map_err(message)
    }

    fn ask(&self, reporter: &mut Reporter<'_>, path: &Path, token: u64) -> Option<Decision> {
        let (reply, answer) = mpsc::channel();
        {
            let mut pending = self.pending.lock().ok()?;
            if self.cancelled() {
                return None;
            }
            *pending = Some((token, reply));
        }
        reporter.send(
            Event::Locked {
                token,
                path: display(path),
            },
            true,
        );
        answer.recv().ok().filter(|_| !self.cancelled())
    }
}

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Selection {
    files: u64,
    folders: u64,
    bytes: u64,
    incomplete: bool,
    available_before: Option<u64>,
}

impl Selection {
    fn total(self) -> u64 {
        self.files + self.folders
    }
}

#[derive(Clone, Copy, Default, Serialize)]
struct Counts {
    completed: u64,
    skipped: u64,
    failed: u64,
    unprocessed: u64,
}

impl Counts {
    fn processed(self) -> u64 {
        self.completed + self.skipped + self.failed
    }

    fn add(&mut self, outcome: Outcome, count: u64) {
        match outcome {
            Outcome::Completed => self.completed += count,
            Outcome::Skipped => self.skipped += count,
            Outcome::Failed => self.failed += count,
            Outcome::Cancelled => {}
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Outcome {
    Completed,
    Skipped,
    Failed,
    Cancelled,
}

#[derive(Serialize)]
struct Failure {
    path: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteResult {
    selection: Selection,
    counts: Counts,
    cancelled: bool,
    available_after: Option<u64>,
    failures: Vec<Failure>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    path: String,
    current_total: u64,
    current_processed: u64,
    counts: Counts,
}

#[derive(Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub(crate) enum Event {
    Preparing {
        selection: Selection,
        path: String,
    },
    Removing {
        selection: Selection,
        progress: Progress,
    },
    Locked {
        token: u64,
        path: String,
    },
}

struct Reporter<'a> {
    job: &'a Job,
    output: &'a mut dyn FnMut(Event) -> bool,
    last: Option<Instant>,
}

impl Reporter<'_> {
    fn send(&mut self, event: Event, force: bool) {
        if force
            || self
                .last
                .is_none_or(|last| last.elapsed() >= Duration::from_millis(60))
        {
            self.last = Some(Instant::now());
            if !(self.output)(event) {
                self.job.cancel();
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Directory,
    File,
    Link,
}

impl Kind {
    fn of(metadata: &fs::Metadata) -> Self {
        if local::is_link(metadata) {
            Self::Link
        } else if metadata.is_dir() {
            Self::Directory
        } else {
            Self::File
        }
    }
}

struct Item {
    path: PathBuf,
    kind: Kind,
    preparation_error: Option<io::Error>,
}

struct Group {
    root: PathBuf,
    items: Vec<Item>,
}

fn display(path: &Path) -> String {
    local::display_path(path).unwrap_or_else(|_| path.to_string_lossy().into_owned())
}

fn checked_metadata(base: &Path, path: &Path) -> io::Result<fs::Metadata> {
    // Check parents again because a folder can be renamed or replaced while the job is paused.
    let relative = path.strip_prefix(base).map_err(io::Error::other)?;
    let mut parent = base.to_path_buf();
    let require_directory = |folder: &Path| {
        if Kind::of(&fs::symlink_metadata(folder)?) == Kind::Directory {
            Ok(())
        } else {
            Err(io::Error::other("A parent folder changed during deletion."))
        }
    };
    require_directory(&parent)?;
    for segment in relative.parent().unwrap_or(Path::new("")).components() {
        parent.push(segment);
        require_directory(&parent)?;
    }
    fs::symlink_metadata(path)
}

fn prepare(
    base: &Path,
    roots: Vec<PathBuf>,
    selection: &mut Selection,
    reporter: &mut Reporter<'_>,
) -> Vec<Group> {
    let mut groups = Vec::with_capacity(roots.len());
    reporter.send(
        Event::Preparing {
            selection: *selection,
            path: display(base),
        },
        true,
    );
    for root in roots {
        let mut items = Vec::new();
        let mut pending = vec![root.clone()];
        while let Some(path) = pending.pop() {
            if reporter.job.cancelled() {
                selection.incomplete = true;
                break;
            }
            let (kind, mut preparation_error) = match checked_metadata(base, &path) {
                Ok(info) => {
                    if info.is_file() && !local::is_link(&info) {
                        selection.bytes = selection.bytes.saturating_add(info.len());
                    }
                    (Kind::of(&info), None)
                }
                Err(error) => (Kind::File, Some(error)),
            };
            if kind == Kind::Directory {
                selection.folders += 1;
                match fs::read_dir(&path) {
                    Ok(children) => {
                        for child in children {
                            if reporter.job.cancelled() {
                                selection.incomplete = true;
                                break;
                            }
                            match child {
                                Ok(child) => pending.push(child.path()),
                                Err(error) => preparation_error = Some(error),
                            }
                        }
                    }
                    Err(error) => preparation_error = Some(error),
                }
            } else {
                selection.files += 1;
            }
            selection.incomplete |= preparation_error.is_some();
            reporter.send(
                Event::Preparing {
                    selection: *selection,
                    path: display(&path),
                },
                false,
            );
            items.push(Item {
                path,
                kind,
                preparation_error,
            });
        }
        // Children precede their parents in the executable plan.
        items.reverse();
        groups.push(Group { root, items });
        if reporter.job.cancelled() {
            break;
        }
    }
    groups
}

struct RemoveError {
    busy: bool,
    message: String,
}

fn busy_code(code: i32) -> bool {
    #[cfg(windows)]
    {
        matches!(
            code as u32,
            32 | 33 | 0x80070020 | 0x80070021 | 0x80270027 | 0x80270028
        )
    }
    #[cfg(unix)]
    {
        matches!(code, libc::EBUSY | libc::ETXTBSY)
    }
}

impl From<io::Error> for RemoveError {
    fn from(error: io::Error) -> Self {
        Self {
            busy: error.raw_os_error().is_some_and(busy_code),
            message: error.to_string(),
        }
    }
}

fn trash_item(path: &Path) -> std::result::Result<(), RemoveError> {
    trash::delete(path).map_err(|error| {
        let busy = match &error {
            trash::Error::Os { code, .. } => busy_code(*code),
            #[cfg(target_os = "linux")]
            trash::Error::FileSystem { source, .. } => source.raw_os_error().is_some_and(busy_code),
            _ => false,
        };
        RemoveError {
            busy,
            message: error.to_string(),
        }
    })
}

struct Batch<'a> {
    base: &'a Path,
    reporter: Reporter<'a>,
    selection: Selection,
    counts: Counts,
    failures: Vec<Failure>,
    skip_locks: bool,
    token: u64,
}

impl Batch<'_> {
    fn progress(&mut self, path: &Path, current_total: u64, current_processed: u64, force: bool) {
        let progress = Progress {
            path: display(path),
            current_total,
            current_processed,
            counts: self.counts,
        };
        self.reporter.send(
            Event::Removing {
                selection: self.selection,
                progress,
            },
            force,
        );
    }

    fn remove(
        &mut self,
        item: &Item,
        mut action: impl FnMut(&fs::Metadata) -> std::result::Result<(), RemoveError>,
    ) -> Outcome {
        loop {
            if self.reporter.job.cancelled() {
                return Outcome::Cancelled;
            }
            let result = checked_metadata(self.base, &item.path)
                .map_err(RemoveError::from)
                .and_then(|metadata| {
                    if Kind::of(&metadata) != item.kind {
                        return Err(
                            io::Error::other("The selected item changed during deletion.").into(),
                        );
                    }
                    action(&metadata)
                });
            match result {
                Ok(()) => return Outcome::Completed,
                Err(error) if error.busy => {
                    if self.skip_locks {
                        return Outcome::Skipped;
                    }
                    self.token += 1;
                    match self
                        .reporter
                        .job
                        .ask(&mut self.reporter, &item.path, self.token)
                    {
                        Some(Decision::Retry) => continue,
                        Some(Decision::Skip) => return Outcome::Skipped,
                        Some(Decision::SkipRemaining) => {
                            self.skip_locks = true;
                            return Outcome::Skipped;
                        }
                        None => return Outcome::Cancelled,
                    }
                }
                Err(error) => return self.failure(&item.path, error.message),
            }
        }
    }

    fn failure(&mut self, path: &Path, message: String) -> Outcome {
        if self.failures.len() < 50 {
            self.failures.push(Failure {
                path: display(path),
                message,
            });
        }
        Outcome::Failed
    }

    fn permanent(&mut self, group: Group) {
        let mut retained = HashSet::new();
        let total = group.items.len() as u64;
        for (index, mut item) in group.items.into_iter().enumerate() {
            if self.reporter.job.cancelled() {
                break;
            }
            self.progress(&item.path, total, index as u64, index == 0);
            if self.reporter.job.cancelled() {
                break;
            }
            let failure = item
                .preparation_error
                .take()
                .filter(|error| !error.raw_os_error().is_some_and(busy_code));
            let outcome = if let Some(error) = failure {
                self.failure(&item.path, error.to_string())
            } else if retained.contains(&item.path) {
                Outcome::Skipped
            } else {
                self.remove(&item, |metadata| {
                    local::remove_entry(&item.path, metadata).map_err(Into::into)
                })
            };
            if outcome == Outcome::Cancelled {
                break;
            }
            self.counts.add(outcome, 1);
            if outcome != Outcome::Completed {
                retained.extend(
                    item.path
                        .ancestors()
                        .skip(1)
                        .take_while(|ancestor| ancestor.starts_with(&group.root))
                        .map(Path::to_owned),
                );
            }
            self.progress(
                &item.path,
                total,
                index as u64 + 1,
                index as u64 + 1 == total,
            );
        }
    }

    fn recycle(&mut self, group: Group) {
        let Some(root) = group.items.last() else {
            return;
        };
        let total = group.items.len() as u64;
        self.progress(&root.path, total, 0, true);
        let outcome = self.remove(root, |_| {
            trash_item(&root.path)?;
            if fs::symlink_metadata(&root.path)
                .is_err_and(|error| error.kind() == ErrorKind::NotFound)
            {
                Ok(())
            } else {
                Err(
                    io::Error::other("The operating system did not move this item to Trash.")
                        .into(),
                )
            }
        });
        if outcome == Outcome::Completed {
            self.counts.add(outcome, total);
        } else {
            let removed = group
                .items
                .iter()
                .filter(|item| {
                    checked_metadata(self.base, &item.path)
                        .is_err_and(|error| error.kind() == ErrorKind::NotFound)
                })
                .count() as u64;
            self.counts.add(Outcome::Completed, removed);
            self.counts.add(outcome, total - removed);
        }
        if outcome != Outcome::Cancelled {
            self.progress(&root.path, total, total, true);
        }
    }
}

fn run(
    base: &Path,
    roots: Vec<PathBuf>,
    permanent: bool,
    job: &Job,
    mut output: impl FnMut(Event) -> bool,
) -> DeleteResult {
    let selected = roots.len() as u64;
    let mut selection = Selection {
        available_before: disk_space::query(base).ok().map(|space| space.available),
        ..Selection::default()
    };
    let mut reporter = Reporter {
        job,
        output: &mut output,
        last: None,
    };
    let groups = prepare(base, roots, &mut selection, &mut reporter);
    let total = if job.cancelled() {
        selection.total().max(selected)
    } else {
        selection.total()
    };
    let mut batch = Batch {
        base,
        reporter,
        selection,
        counts: Counts::default(),
        failures: Vec::new(),
        skip_locks: false,
        token: 0,
    };
    for group in groups {
        if job.cancelled() {
            break;
        }
        if permanent {
            batch.permanent(group);
        } else {
            batch.recycle(group);
        }
    }
    batch.counts.unprocessed = total.saturating_sub(batch.counts.processed());
    DeleteResult {
        selection,
        counts: batch.counts,
        cancelled: job.cancelled(),
        available_after: disk_space::query(base).ok().map(|space| space.available),
        failures: batch.failures,
    }
}

#[tauri::command]
pub(crate) async fn delete_selection(
    id: u32,
    directory: String,
    names: Vec<String>,
    permanent: bool,
    on_progress: Channel<Event>,
    state: State<'_, DeleteJobs>,
) -> Result<DeleteResult> {
    let job = Arc::new(Job::default());
    {
        let mut jobs = state.0.lock().map_err(message)?;
        if jobs.contains_key(&id) {
            return Err("This deletion is already running.".into());
        }
        jobs.insert(id, job.clone());
    }
    let result = blocking_for("delete_selection", move || {
        let base =
            fs::canonicalize(local::absolute(&directory).map_err(message)?).map_err(message)?;
        let mut seen = HashSet::new();
        let mut roots = Vec::new();
        for name in &names {
            let component = local::name_component(name).map_err(message)?;
            if seen.insert(component) {
                roots.push(base.join(component));
            }
        }
        Ok(run(&base, roots, permanent, &job, |event| {
            on_progress.send(event).is_ok()
        }))
    })
    .await;
    state.0.lock().map_err(message)?.remove(&id);
    result
}

#[tauri::command]
pub(crate) fn cancel_deletion(id: u32, state: State<'_, DeleteJobs>) -> Result<()> {
    if let Some(job) = state.0.lock().map_err(message)?.get(&id) {
        job.cancel();
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn resolve_deletion(
    id: u32,
    token: u64,
    decision: Decision,
    state: State<'_, DeleteJobs>,
) -> Result<()> {
    let job = state
        .0
        .lock()
        .map_err(message)?
        .get(&id)
        .cloned()
        .ok_or("This deletion has finished.")?;
    job.answer(token, decision)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(directory.path()).unwrap();
        (directory, base)
    }

    #[test]
    fn can_cancel_preparation_before_touching_any_item() {
        let (_directory, base) = fixture();
        let roots = [base.join("first.txt"), base.join("second.txt")];
        for item in &roots {
            fs::write(item, []).unwrap();
        }
        let job = Job::default();
        let result = run(&base, roots.to_vec(), true, &job, |event| {
            if matches!(event, Event::Preparing { .. }) {
                job.cancel();
            }
            true
        });
        assert!(result.cancelled && result.selection.incomplete);
        assert_eq!(result.counts.completed, 0);
        assert_eq!(result.counts.unprocessed, 2);
        assert!(roots.iter().all(|item| item.exists()));
    }

    #[test]
    fn permanently_deletes_links_without_visiting_their_targets() {
        let (_directory, base) = fixture();
        let outside = tempfile::tempdir().unwrap();
        let file = outside.path().join("keep.txt");
        fs::write(&file, b"keep").unwrap();
        let root = base.join("folder");
        fs::create_dir(&root).unwrap();
        let link = root.join("link");
        #[cfg(windows)]
        junction::create(outside.path(), &link).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();

        let result = run(&base, vec![root.clone()], true, &Job::default(), |_| true);
        assert_eq!(result.selection.total(), 2);
        assert_eq!(result.counts.completed, 2);
        assert!(!root.exists());
        assert_eq!(fs::read(file).unwrap(), b"keep");
    }

    #[cfg(windows)]
    fn lock(path: &Path) -> fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            .share_mode(3)
            .open(path)
            .unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn skip_all_preserves_locked_descendants_and_resets_in_the_next_batch() {
        let (_directory, base) = fixture();
        let group = base.join("folder");
        fs::create_dir(&group).unwrap();
        let nested = group.join("locked.txt");
        let sibling = group.join("removable.txt");
        let first = base.join("first.txt");
        let second_lock = base.join("another-lock.txt");
        let last = base.join("last.txt");
        for path in [&first, &nested, &sibling, &second_lock, &last] {
            fs::write(path, []).unwrap();
        }
        let _nested_lock = lock(&nested);
        let _another_lock = lock(&second_lock);
        let roots = [&first, &group, &second_lock, &last]
            .into_iter()
            .cloned()
            .collect();
        let job = Job::default();
        let mut prompts = 0;
        let result = run(&base, roots, true, &job, |event| {
            if let Event::Locked { token, path } = event {
                prompts += 1;
                assert_eq!(path, display(&nested));
                job.answer(token, Decision::SkipRemaining).unwrap();
            }
            true
        });
        assert_eq!(prompts, 1);
        assert_eq!(result.counts.completed, 3);
        assert_eq!(result.counts.skipped, 3);
        assert_eq!(result.counts.failed, 0);
        assert_eq!(result.counts.unprocessed, 0);
        assert!(group.exists() && nested.exists() && second_lock.exists());
        assert!(!first.exists() && !last.exists() && !sibling.exists());

        let job = Job::default();
        let result = run(&base, vec![second_lock.clone()], true, &job, |event| {
            if let Event::Locked { .. } = event {
                job.cancel();
            }
            true
        });
        assert!(result.cancelled);
        assert_eq!(result.counts.unprocessed, 1);
        assert!(second_lock.exists());
    }

    #[test]
    fn skip_all_locks_does_not_suppress_an_unrelated_permission_error() {
        let (_directory, base) = fixture();
        let make_item = |name| {
            let path = base.join(name);
            fs::write(&path, []).unwrap();
            Item {
                path,
                kind: Kind::File,
                preparation_error: None,
            }
        };
        let first = make_item("locked.txt");
        let denied = make_item("denied.txt");
        let job = Job::default();
        let mut prompts = 0;
        let mut output = |event| {
            if let Event::Locked { token, .. } = event {
                prompts += 1;
                job.answer(token, Decision::SkipRemaining).unwrap();
            }
            true
        };
        let reporter = Reporter {
            job: &job,
            output: &mut output,
            last: None,
        };
        let mut batch = Batch {
            base: &base,
            reporter,
            selection: Selection::default(),
            counts: Counts::default(),
            failures: Vec::new(),
            skip_locks: false,
            token: 0,
        };
        assert!(
            batch.remove(&first, |_| Err(RemoveError {
                busy: true,
                message: "Held open".into()
            })) == Outcome::Skipped
        );
        assert!(
            batch.remove(&denied, |_| Err(io::Error::from(
                ErrorKind::PermissionDenied
            )
            .into()))
                == Outcome::Failed
        );
        assert_eq!(batch.failures.len(), 1);
        assert_eq!(batch.failures[0].path, display(&denied.path));
        assert_eq!(prompts, 1);
    }

    #[cfg(windows)]
    #[test]
    fn retry_resumes_the_same_item_and_leaves_new_files_alone() {
        let (_directory, base) = fixture();
        let before = base.join("before.txt");
        let blocked = base.join("blocked.txt");
        let after = base.join("after.txt");
        for path in [&before, &blocked, &after] {
            fs::write(path, []).unwrap();
        }
        let mut handle = Some(lock(&blocked));
        let job = Job::default();
        let result = run(
            &base,
            vec![before.clone(), blocked.clone(), after.clone()],
            true,
            &job,
            |event| {
                if let Event::Locked { token, .. } = event {
                    assert!(!before.exists());
                    fs::write(&before, b"new file").unwrap();
                    handle.take();
                    assert!(job.answer(token + 1, Decision::Skip).is_err());
                    job.answer(token, Decision::Retry).unwrap();
                }
                true
            },
        );
        assert_eq!(result.counts.completed, 3);
        assert!(!blocked.exists() && !after.exists());
        assert_eq!(fs::read(before).unwrap(), b"new file");
    }
}
