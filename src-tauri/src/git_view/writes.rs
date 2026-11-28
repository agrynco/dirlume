use super::{
    bounded_command, command, directory, executable, line, oid, optional_line, process_error, run,
    success, working_changes, ChangeGroup, GitError, Result, WorkingChange, STATUS_LIMIT,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    ffi::OsString,
    fmt::Write as _,
    fs::{self, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tempfile::{TempDir, TempPath};

#[derive(Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSnapshot {
    head_ref: Option<String>,
    head: Option<String>,
    index: String,
    git_dir: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexState {
    snapshot: IndexSnapshot,
    write_blocked: bool,
    submodules: Vec<String>,
}

#[derive(Serialize)]
pub struct WorkingIndex {
    #[serde(flatten)]
    index: IndexState,
    changes: Vec<WorkingChange>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IndexAction {
    Stage,
    Unstage,
}

fn change_paths(change: &WorkingChange) -> WriteResult<Vec<&str>> {
    super::relative_file(&change.path)?;
    let mut paths = vec![change.path.as_str()];
    if change.status == 'R' {
        let previous = change.previous_path.as_deref().ok_or(WriteError::Stale)?;
        super::relative_file(previous)?;
        paths.push(previous);
    }
    Ok(paths)
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "detail", rename_all = "camelCase")]
pub enum WriteError {
    Stale,
    Busy,
    OperationInProgress,
    Detached,
    GitTooOld,
    UnsupportedChange,
    ConfirmReplacement,
    EmptyCommit,
    PartialClone { path: String, message: String },
    Failed(String),
}

type WriteResult<T> = std::result::Result<T, WriteError>;

pub(super) fn verify_branch_head(
    git: &Path,
    root: &Path,
    head_ref: Option<&str>,
    head: Option<&str>,
) -> WriteResult<()> {
    let state = snapshot(git, root)?;
    if state.write_blocked {
        return Err(WriteError::OperationInProgress);
    }
    if state.snapshot.head_ref.as_deref() != head_ref || state.snapshot.head.as_deref() != head {
        return Err(WriteError::Stale);
    }
    Ok(())
}

impl From<GitError> for WriteError {
    fn from(error: GitError) -> Self {
        let detail = match error {
            GitError::MissingGit => "Git is unavailable.",
            GitError::NotRepository => "This folder is outside a Git working tree.",
            GitError::Unreadable => "Could not read the Git repository.",
            GitError::MissingObject => {
                "A required Git object is missing from this local repository."
            }
        };
        Self::Failed(detail.into())
    }
}

impl From<io::Error> for WriteError {
    fn from(error: io::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

pub(super) fn git_path(git: &Path, root: &Path, name: &str) -> Result<PathBuf> {
    let path = line(success(run(
        git,
        root,
        &["rev-parse", "--git-path", name],
    )?)?)?;
    Ok(root.join(path))
}

const INDEX_ARGS: &[&str] = &["ls-files", "--stage", "-z"];

fn index_entries(process: Command) -> Result<String> {
    let entries = bounded_command(process, STATUS_LIMIT)?.ok_or(GitError::Unreadable)?;
    String::from_utf8(entries).map_err(|_| GitError::Unreadable)
}

fn index_records(entries: &str) -> impl Iterator<Item = (&str, &str)> {
    entries
        .split_terminator('\0')
        .filter_map(|entry| entry.split_once('\t'))
}

fn snapshot(git: &Path, root: &Path) -> Result<IndexState> {
    let actual_root = line(success(run(git, root, &["rev-parse", "--show-toplevel"])?)?)?;
    if Path::new(&actual_root)
        .canonicalize()
        .map_err(process_error)?
        != root.canonicalize().map_err(process_error)?
    {
        return Err(GitError::NotRepository);
    }
    let git_dir = line(success(run(
        git,
        root,
        &["rev-parse", "--absolute-git-dir"],
    )?)?)?;
    let git_dir = PathBuf::from(git_dir);
    let head_ref = optional_line(run(git, root, &["symbolic-ref", "--quiet", "HEAD"])?)?;
    let head = optional_line(run(
        git,
        root,
        &["rev-parse", "--verify", "--quiet", "HEAD"],
    )?)?;
    let stage = index_entries(command(git, root, INDEX_ARGS))?;
    let mut index = String::new();
    for byte in ring::digest::digest(&ring::digest::SHA256, stage.as_bytes()).as_ref() {
        write!(index, "{byte:02x}").map_err(|_| GitError::Unreadable)?;
    }
    let mut unmerged = false;
    let mut submodules = Vec::new();
    for (metadata, path) in index_records(&stage) {
        unmerged |= !metadata.ends_with(" 0");
        if metadata.starts_with("160000 ") {
            submodules.push(path.to_owned());
        }
    }
    let operation = [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-apply",
        "rebase-merge",
        "sequencer",
        "BISECT_START",
    ]
    .iter()
    .any(|name| git_dir.join(name).exists());
    Ok(IndexState {
        snapshot: IndexSnapshot {
            head_ref,
            head,
            index,
            git_dir,
        },
        write_blocked: unmerged || operation,
        submodules,
    })
}

pub(super) fn review_index(git: &Path, root: &Path) -> WriteResult<IndexSnapshot> {
    let state = snapshot(git, root)?;
    if state.write_blocked {
        return Err(WriteError::OperationInProgress);
    }
    Ok(state.snapshot)
}

struct IndexWrite {
    index: PathBuf,
    lock: TempPath,
    copy: PathBuf,
    temporary: TempDir,
}

impl IndexWrite {
    fn open(index: PathBuf) -> WriteResult<Self> {
        let mut lock_path = OsString::from(index.as_os_str());
        lock_path.push(".lock");
        let lock_path = PathBuf::from(lock_path);
        let handle = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
            .map_err(|error| match error.kind() {
                io::ErrorKind::AlreadyExists => WriteError::Busy,
                _ => error.into(),
            })?;
        drop(handle);
        let lock = TempPath::try_from_path(lock_path)?;
        let parent = index.parent().ok_or(GitError::Unreadable)?;
        let temporary = tempfile::Builder::new()
            .prefix("dirlume-git-")
            .tempdir_in(parent)?;
        let copy = temporary.path().join("index");
        match fs::copy(&index, &copy) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound && !index.exists() => {}
            Err(error) => return Err(error.into()),
        }
        Ok(Self {
            index,
            lock,
            copy,
            temporary,
        })
    }

    fn command(&self, git: &Path, root: &Path, args: &[&str]) -> Command {
        let mut options = vec!["-c", "core.splitIndex=false"];
        options.extend_from_slice(args);
        let mut process = command(git, root, &options);
        process.env("GIT_INDEX_FILE", &self.copy);
        process
    }

    fn save(self) -> WriteResult<()> {
        fs::copy(&self.copy, &self.lock)?;
        OpenOptions::new()
            .write(true)
            .open(&self.lock)?
            .sync_all()?;
        self.lock
            .persist(&self.index)
            .map_err(|error| error.error)?;
        Ok(())
    }
}

fn checked_snapshot(git: &Path, root: &Path, expected: &IndexSnapshot) -> WriteResult<IndexState> {
    let current = snapshot(git, root)?;
    if &current.snapshot != expected {
        return Err(WriteError::Stale);
    }
    if current.write_blocked {
        return Err(WriteError::OperationInProgress);
    }
    Ok(current)
}

fn operation_output(mut process: Command) -> WriteResult<Vec<u8>> {
    let mut stdout = tempfile::tempfile()?;
    let mut stderr = tempfile::tempfile()?;
    let status = process
        .stdout(Stdio::from(stdout.try_clone()?))
        .stderr(Stdio::from(stderr.try_clone()?))
        .status()?;
    use std::io::{Seek, SeekFrom};
    if status.success() {
        stdout.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        stdout.take(16_384).read_to_end(&mut bytes)?;
        return Ok(bytes);
    }
    stderr.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    stderr.take(16_384).read_to_end(&mut bytes)?;
    let message = String::from_utf8_lossy(&bytes);
    let mut detail = message.trim().to_owned();
    if detail.is_empty() {
        stdout.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        stdout.take(16_384).read_to_end(&mut bytes)?;
        detail = String::from_utf8_lossy(&bytes).trim().into();
    }
    if detail.is_empty() {
        detail = format!("Git exited with {status}.");
    }
    Err(WriteError::Failed(detail))
}

fn update_index(
    git: &Path,
    root: &Path,
    expected: &IndexSnapshot,
    change: WorkingChange,
    action: IndexAction,
    replace: bool,
) -> WriteResult<()> {
    update_selection(git, root, expected, &[change], action, replace, None)
}

fn update_selection(
    git: &Path,
    root: &Path,
    expected: &IndexSnapshot,
    selected: &[WorkingChange],
    action: IndexAction,
    replace: bool,
    reviewed: Option<&[FileStamp]>,
) -> WriteResult<()> {
    if selected.is_empty() {
        return Err(WriteError::UnsupportedChange);
    }
    let transaction = IndexWrite::open(git_path(git, root, "index")?)?;
    let state = checked_snapshot(git, root, expected)?;
    let changes = working_changes(git, root)?;
    let mut paths = BTreeSet::new();
    for change in selected {
        let compatible = match action {
            IndexAction::Stage => change.group != ChangeGroup::Staged,
            IndexAction::Unstage => change.group == ChangeGroup::Staged,
        };
        if !compatible || !changes.contains(change) {
            return Err(WriteError::Stale);
        }
        paths.extend(change_paths(change)?);
    }
    if let Some(reviewed) = reviewed {
        if worktree_stamps(git, root, selected)? != reviewed {
            return Err(WriteError::Stale);
        }
    }
    if paths.iter().any(|path| {
        state.submodules.iter().any(|item| item == path)
            || fs::symlink_metadata(root.join(path)).is_ok_and(|metadata| metadata.is_dir())
    }) {
        return Err(WriteError::UnsupportedChange);
    }
    let mut args = match (action, state.snapshot.head.as_deref()) {
        (IndexAction::Stage, _) => {
            if !replace
                && changes.iter().any(|row| {
                    row.group == ChangeGroup::Staged && paths.contains(&row.path.as_str())
                })
            {
                return Err(WriteError::ConfirmReplacement);
            }
            vec!["add", "-A"]
        }
        (IndexAction::Unstage, Some(head)) => {
            vec!["reset", "--quiet", head]
        }
        (IndexAction::Unstage, None) => {
            vec!["rm", "--cached", "--force", "--quiet"]
        }
    };
    args.insert(0, "--literal-pathspecs");
    args.push("--");
    args.extend(paths.iter().copied());
    let before = index_entries(transaction.command(git, root, INDEX_ARGS))?;
    operation_output(transaction.command(git, root, &args))?;
    let after = index_entries(transaction.command(git, root, INDEX_ARGS))?;
    let unrelated = |path: &str| !paths.contains(path);
    if !index_records(&before)
        .filter(|&(_, path)| unrelated(path))
        .eq(index_records(&after).filter(|&(_, path)| unrelated(path)))
    {
        return Err(WriteError::UnsupportedChange);
    }
    if matches!(action, IndexAction::Stage)
        && index_records(&after)
            .any(|(metadata, path)| !unrelated(path) && metadata.starts_with("160000 "))
    {
        return Err(WriteError::UnsupportedChange);
    }
    if let Some(reviewed) = reviewed {
        if worktree_stamps(git, root, selected)? != reviewed {
            return Err(WriteError::Stale);
        }
    }
    checked_snapshot(git, root, expected)?;
    transaction.save()
}

#[derive(Deserialize, PartialEq, Serialize)]
struct FileStamp {
    path: String,
    content: Option<String>,
    executable: bool,
    symlink: bool,
}

fn worktree_stamps(
    git: &Path,
    root: &Path,
    changes: &[WorkingChange],
) -> WriteResult<Vec<FileStamp>> {
    let mut paths = BTreeSet::new();
    for change in changes
        .iter()
        .filter(|change| change.group != ChangeGroup::Staged)
    {
        paths.extend(change_paths(change)?);
    }
    paths
        .into_iter()
        .map(|path| {
            let (content, executable, symlink) = match fs::symlink_metadata(root.join(path)) {
                Ok(metadata) if metadata.is_file() => {
                    if super::working_file(root, Path::new(path)).is_none() {
                        return Err(WriteError::UnsupportedChange);
                    }
                    #[cfg(unix)]
                    let executable = {
                        use std::os::unix::fs::PermissionsExt;
                        metadata.permissions().mode() & 0o111 != 0
                    };
                    #[cfg(not(unix))]
                    let executable = false;
                    (
                        Some(line(operation_output(command(
                            git,
                            root,
                            &["hash-object", "--no-filters", "--", path],
                        ))?)?),
                        executable,
                        false,
                    )
                }
                Ok(metadata) if metadata.is_symlink() => (
                    Some(
                        fs::read_link(root.join(path))?
                            .to_str()
                            .ok_or(GitError::Unreadable)?
                            .to_owned(),
                    ),
                    false,
                    true,
                ),
                Ok(_) => return Err(WriteError::UnsupportedChange),
                Err(error) if error.kind() == io::ErrorKind::NotFound => (None, false, false),
                Err(error) => return Err(error.into()),
            };
            Ok(FileStamp {
                path: path.into(),
                content,
                executable,
                symlink,
            })
        })
        .collect()
}

#[derive(Deserialize, Serialize)]
pub struct BulkPlan {
    expected: IndexSnapshot,
    changes: Vec<WorkingChange>,
    action: IndexAction,
    stamps: Vec<FileStamp>,
}

fn bulk_plan(
    git: &Path,
    root: &Path,
    expected: IndexSnapshot,
    changes: Vec<WorkingChange>,
    action: IndexAction,
) -> WriteResult<BulkPlan> {
    checked_snapshot(git, root, &expected)?;
    let actual = working_changes(git, root)?;
    if changes.is_empty() || !changes.iter().all(|change| actual.contains(change)) {
        return Err(WriteError::Stale);
    }
    let stamps = worktree_stamps(git, root, &changes)?;
    Ok(BulkPlan {
        expected,
        changes,
        action,
        stamps,
    })
}

#[derive(Deserialize, Serialize)]
pub struct HunkReview {
    expected: IndexSnapshot,
    change: WorkingChange,
    stamp: [u8; 32],
}

#[derive(Serialize)]
pub struct HunkPlan {
    review: HunkReview,
    hunks: Vec<String>,
}

fn hunk_patch(git: &Path, root: &Path, change: &WorkingChange) -> WriteResult<Option<String>> {
    if change.status != 'M' || change.group == ChangeGroup::Untracked {
        return Ok(None);
    }
    super::relative_file(&change.path)?;
    let mut args = vec![
        "--literal-pathspecs",
        "diff",
        "--patch",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--no-relative",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--ignore-submodules=none",
        "--submodule=short",
    ];
    if change.group == ChangeGroup::Staged {
        args.push("--cached");
    }
    args.extend(["--", &change.path]);
    let bytes = super::bounded(git, root, &args, super::PATCH_LIMIT)?;
    Ok(bytes
        .and_then(|bytes| super::text_patch(bytes).ok())
        .filter(|patch| {
            patch.starts_with("diff --git ")
                && !patch.lines().any(|line| {
                    line.starts_with("old mode ")
                        || line.starts_with("new mode ")
                        || line.starts_with("Submodule ")
                })
        }))
}

fn hunk_ranges(patch: &str) -> Vec<usize> {
    patch
        .match_indices("\n@@ ")
        .map(|(position, _)| position + 1)
        .chain(std::iter::once(patch.len()))
        .collect()
}

fn patch_stamp(patch: &str) -> WriteResult<[u8; 32]> {
    Ok(
        ring::digest::digest(&ring::digest::SHA256, patch.as_bytes())
            .as_ref()
            .try_into()
            .map_err(|_| GitError::Unreadable)?,
    )
}

fn hunk_plan(
    git: &Path,
    root: &Path,
    expected: IndexSnapshot,
    change: WorkingChange,
) -> WriteResult<Option<HunkPlan>> {
    let state = checked_snapshot(git, root, &expected)?;
    if state.submodules.contains(&change.path) || !working_changes(git, root)?.contains(&change) {
        return Ok(None);
    }
    let Some(patch) = hunk_patch(git, root, &change)? else {
        return Ok(None);
    };
    let ranges = hunk_ranges(&patch);
    if ranges.len() < 2 {
        return Ok(None);
    }
    let hunks = ranges
        .windows(2)
        .map(|ends| patch[ends[0]..ends[1]].to_owned())
        .collect();
    let review = HunkReview {
        expected,
        change,
        stamp: patch_stamp(&patch)?,
    };
    Ok(Some(HunkPlan { review, hunks }))
}

fn apply_hunk(git: &Path, root: &Path, review: &HunkReview, index: usize) -> WriteResult<()> {
    let transaction = IndexWrite::open(git_path(git, root, "index")?)?;
    let state = checked_snapshot(git, root, &review.expected)?;
    if state.submodules.contains(&review.change.path)
        || !working_changes(git, root)?.contains(&review.change)
    {
        return Err(WriteError::Stale);
    }
    let patch = hunk_patch(git, root, &review.change)?.ok_or(WriteError::Stale)?;
    if patch_stamp(&patch)? != review.stamp {
        return Err(WriteError::Stale);
    }
    let ranges = hunk_ranges(&patch);
    let range = ranges
        .windows(2)
        .nth(index)
        .ok_or(WriteError::UnsupportedChange)?;
    let selected = format!("{}{}", &patch[..ranges[0]], &patch[range[0]..range[1]]);
    let file = transaction.temporary.path().join("reviewed.patch");
    fs::write(&file, selected)?;
    let mut args = vec!["apply", "--cached", "--whitespace=nowarn"];
    if review.change.group == ChangeGroup::Staged {
        args.push("--reverse");
    }
    let mut process = transaction.command(git, root, &args);
    process.arg("--").arg(file);
    let before = index_entries(transaction.command(git, root, INDEX_ARGS))?;
    operation_output(process)?;
    let after = index_entries(transaction.command(git, root, INDEX_ARGS))?;
    let unrelated = |path: &str| path != review.change.path;
    if !index_records(&before)
        .filter(|&(_, path)| unrelated(path))
        .eq(index_records(&after).filter(|&(_, path)| unrelated(path)))
    {
        return Err(WriteError::UnsupportedChange);
    }
    if hunk_patch(git, root, &review.change)?.as_deref() != Some(&patch) {
        return Err(WriteError::Stale);
    }
    checked_snapshot(git, root, &review.expected)?;
    transaction.save()
}

#[derive(Deserialize, Serialize)]
pub struct DiscardReview {
    expected: IndexSnapshot,
    change: WorkingChange,
    stamps: Vec<FileStamp>,
}

#[derive(Serialize)]
pub struct DiscardPlan {
    review: DiscardReview,
    diff: super::WorkingDiff,
}

fn review_discard(
    git: &Path,
    root: &Path,
    expected: IndexSnapshot,
    change: WorkingChange,
) -> WriteResult<DiscardPlan> {
    let state = checked_snapshot(git, root, &expected)?;
    if change.group == ChangeGroup::Staged
        || matches!(change.status, 'R' | 'C' | 'U')
        || state.submodules.contains(&change.path)
    {
        return Err(WriteError::UnsupportedChange);
    }
    if !working_changes(git, root)?.contains(&change) {
        return Err(WriteError::Stale);
    }
    let stamps = worktree_stamps(git, root, std::slice::from_ref(&change))?;
    let diff = super::working_diff(git, root, &change, false)?;
    if worktree_stamps(git, root, std::slice::from_ref(&change))? != stamps {
        return Err(WriteError::Stale);
    }
    Ok(DiscardPlan {
        review: DiscardReview {
            expected,
            change,
            stamps,
        },
        diff,
    })
}

fn discard(git: &Path, root: &Path, review: DiscardReview) -> WriteResult<()> {
    let transaction = IndexWrite::open(git_path(git, root, "index")?)?;
    let reviewed = review_discard(git, root, review.expected, review.change)?;
    if reviewed.review.stamps != review.stamps {
        return Err(WriteError::Stale);
    }
    let change = reviewed.review.change;
    let args = if change.group == ChangeGroup::Untracked {
        vec!["--literal-pathspecs", "clean", "-f", "--", &change.path]
    } else {
        vec![
            "--literal-pathspecs",
            "restore",
            "--worktree",
            "--",
            &change.path,
        ]
    };
    operation_output(transaction.command(git, root, &args))?;
    Ok(())
}

// Git calls the prepared hook after locking the branch update and before writing
// the new reference. Validate the commit object itself so a hook that stages a
// different tree cannot publish it, even when that hook succeeds.
const REFERENCE_HOOK: &str = r#"#!/bin/sh
set -eu
refs=$(mktemp "$DIRLUME_GIT_TEMP/refs.XXXXXX")
trap 'rm -f "$refs"' EXIT
cat > "$refs"
original="$DIRLUME_GIT_HOOKS/reference-transaction"
if [ -x "$original" ]; then
    "$original" "$@" < "$refs"
fi
[ "$1" = prepared ] || exit 0
matched=
while read -r old new ref; do
    [ "$ref" = HEAD ] && continue
    if [ "$ref" != "$DIRLUME_GIT_BRANCH" ] || [ "$old" != "$DIRLUME_GIT_PARENT" ]; then
        printf '%s\n' 'The checked-out Git branch changed. Review the staged changes again.' >&2
        exit 1
    fi
    tree=$(git rev-parse --verify "$new^{tree}")
    if [ "$tree" != "$DIRLUME_GIT_TREE" ]; then
        printf '%s\n' 'A Git hook changed the staged files. The reviewed commit was canceled.' >&2
        exit 1
    fi
    matched=$new
done < "$refs"
if [ -z "$matched" ]; then
    printf '%s\n' 'Git did not update the reviewed branch.' >&2
    exit 1
fi
printf '%s\n' "$matched" > "$DIRLUME_GIT_TEMP/commit"
"#;

fn create_hook(path: &Path, script: &str) -> WriteResult<()> {
    fs::write(path, script)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn commit_changes(
    git: &Path,
    root: &Path,
    expected: &IndexSnapshot,
    message: &str,
) -> WriteResult<String> {
    write_commit(git, root, expected, message, false)
}

fn write_commit(
    git: &Path,
    root: &Path,
    expected: &IndexSnapshot,
    message: &str,
    amend: bool,
) -> WriteResult<String> {
    if message.trim().is_empty() || message.contains('\0') {
        return Err(WriteError::EmptyCommit);
    }
    let branch = expected
        .head_ref
        .as_deref()
        .filter(|name| name.starts_with("refs/heads/"))
        .ok_or(WriteError::Detached)?;
    let version = line(success(run(git, root, &["--version"])?)?)?;
    let version = version.strip_prefix("git version ").unwrap_or_default();
    let mut version = version
        .split('.')
        .filter_map(|part| part.parse::<u32>().ok());
    if (
        version.next().unwrap_or_default(),
        version.next().unwrap_or_default(),
    ) < (2, 29)
    {
        return Err(WriteError::GitTooOld);
    }
    let transaction = IndexWrite::open(git_path(git, root, "index")?)?;
    checked_snapshot(git, root, expected)?;
    if amend && expected.head.is_none()
        || !amend
            && !working_changes(git, root)?
                .iter()
                .any(|row| row.group == ChangeGroup::Staged)
    {
        return Err(WriteError::EmptyCommit);
    }
    let tree = line(operation_output(transaction.command(
        git,
        root,
        &["write-tree"],
    ))?)?;
    oid(&tree)?;
    let original_hooks = git_path(git, root, "hooks")?;
    let hooks = transaction.temporary.path().join("hooks");
    fs::create_dir(&hooks)?;
    for name in [
        "pre-commit",
        "prepare-commit-msg",
        "commit-msg",
        "post-commit",
        "post-index-change",
    ] {
        create_hook(
            &hooks.join(name),
            &format!(
                "#!/bin/sh\noriginal=\"$DIRLUME_GIT_HOOKS/{name}\"\n[ -x \"$original\" ] || exit 0\nexec \"$original\" \"$@\"\n"
            ),
        )?;
    }
    create_hook(&hooks.join("reference-transaction"), REFERENCE_HOOK)?;
    let message_file = transaction.temporary.path().join("message");
    fs::write(&message_file, message)?;
    checked_snapshot(git, root, expected)?;
    let no_parent = "0".repeat(tree.len());
    let hooks_option = format!(
        "core.hooksPath={}",
        hooks.to_string_lossy().replace('\\', "/")
    );
    let mut args = vec!["-c", &hooks_option, "commit"];
    if amend {
        args.extend(["--amend", "--allow-empty"]);
    }
    args.push("--file");
    let mut process = transaction.command(git, root, &args);
    process
        .arg(&message_file)
        .env("DIRLUME_GIT_BRANCH", branch)
        .env(
            "DIRLUME_GIT_PARENT",
            expected.head.as_deref().unwrap_or(&no_parent),
        )
        .env("DIRLUME_GIT_TREE", &tree)
        .env("DIRLUME_GIT_TEMP", transaction.temporary.path())
        .env("DIRLUME_GIT_HOOKS", original_hooks);
    let result = operation_output(process);
    let after = snapshot(git, root)?;
    let committed = fs::read_to_string(transaction.temporary.path().join("commit")).ok();
    if after.snapshot.head_ref.as_deref() == Some(branch) {
        if let (Some(head), Some(committed)) = (after.snapshot.head, committed) {
            if head == committed.trim() {
                return Ok(line(success(run(
                    git,
                    root,
                    &["rev-parse", "--short", &head],
                )?)?)?);
            }
        }
    }
    result?;
    Err(WriteError::Failed(
        "Could not verify the commit result. Refresh Git View and review the branch history."
            .into(),
    ))
}

async fn write_query<T: Send + 'static>(
    operation: impl FnOnce() -> WriteResult<T> + Send + 'static,
) -> WriteResult<T> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| WriteError::Failed(error.to_string()))?
}

#[tauri::command]
pub async fn git_index_state(root: String) -> Result<WorkingIndex> {
    super::query(move || {
        let git = executable()?;
        let root = directory(&root)?;
        let before = snapshot(&git, root)?;
        let changes = working_changes(&git, root)?;
        let index = snapshot(&git, root)?;
        if before.snapshot != index.snapshot {
            return Err(GitError::Unreadable);
        }
        Ok(WorkingIndex { index, changes })
    })
    .await
}

#[tauri::command]
pub async fn git_update_index(
    root: String,
    expected: IndexSnapshot,
    change: WorkingChange,
    action: IndexAction,
    replace: bool,
) -> WriteResult<()> {
    write_query(move || {
        update_index(
            &executable()?,
            directory(&root)?,
            &expected,
            change,
            action,
            replace,
        )
    })
    .await
}

#[tauri::command]
pub async fn git_bulk_plan(
    root: String,
    expected: IndexSnapshot,
    changes: Vec<WorkingChange>,
    action: IndexAction,
) -> WriteResult<BulkPlan> {
    super::history_edits::write(root, move |git, root| {
        bulk_plan(git, root, expected, changes, action)
    })
    .await
}

#[tauri::command]
pub async fn git_apply_bulk(root: String, plan: BulkPlan) -> WriteResult<()> {
    super::history_edits::write(root, move |git, root| {
        update_selection(
            git,
            root,
            &plan.expected,
            &plan.changes,
            plan.action,
            true,
            Some(&plan.stamps),
        )
    })
    .await
}

#[tauri::command]
pub async fn git_hunk_plan(
    root: String,
    expected: IndexSnapshot,
    change: WorkingChange,
) -> WriteResult<Option<HunkPlan>> {
    super::history_edits::write(root, move |git, root| {
        hunk_plan(git, root, expected, change)
    })
    .await
}

#[tauri::command]
pub async fn git_apply_hunk(root: String, review: HunkReview, index: usize) -> WriteResult<()> {
    super::history_edits::write(root, move |git, root| apply_hunk(git, root, &review, index)).await
}

#[tauri::command]
pub async fn git_discard_plan(
    root: String,
    expected: IndexSnapshot,
    change: WorkingChange,
) -> WriteResult<DiscardPlan> {
    super::history_edits::write(root, move |git, root| {
        review_discard(git, root, expected, change)
    })
    .await
}

#[tauri::command]
pub async fn git_discard_worktree(root: String, review: DiscardReview) -> WriteResult<()> {
    super::history_edits::write(root, move |git, root| discard(git, root, review)).await
}

#[tauri::command]
pub async fn git_amend_changes(
    root: String,
    expected: IndexSnapshot,
    message: String,
) -> WriteResult<String> {
    super::history_edits::write(root, move |git, root| {
        write_commit(git, root, &expected, &message, true)
    })
    .await
}

#[tauri::command]
pub async fn git_commit_changes(
    root: String,
    expected: IndexSnapshot,
    message: String,
) -> WriteResult<String> {
    write_query(move || commit_changes(&executable()?, directory(&root)?, &expected, &message))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(git: &Path, root: &Path, args: &[&str]) -> String {
        line(success(run(git, root, args).unwrap()).unwrap()).unwrap()
    }

    fn fixture() -> (PathBuf, TempDir) {
        let executable = executable().unwrap();
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        git(&executable, root, &["init", "--initial-branch=main"]);
        git(
            &executable,
            root,
            &["config", "user.name", "Dirlume Fixture"],
        );
        git(
            &executable,
            root,
            &["config", "user.email", "fixture@example.test"],
        );
        git(&executable, root, &["config", "commit.gpgsign", "false"]);
        git(&executable, root, &["config", "core.autocrlf", "false"]);
        let hooks = root.join(".git").join("hooks");
        git(
            &executable,
            root,
            &["config", "core.hooksPath", hooks.to_str().unwrap()],
        );
        (executable, fixture)
    }

    #[test]
    fn stages_and_unstages_a_hunk_without_changing_the_working_file() {
        let (exe, fixture) = fixture();
        let root = fixture.path();
        let original = (0..35)
            .map(|line| format!("line {line}\n"))
            .collect::<String>();
        fs::write(root.join("partial.txt"), &original).unwrap();
        git(&exe, root, &["add", "--", "partial.txt"]);
        git(&exe, root, &["commit", "-m", "Base"]);
        let edited = original
            .replace("line 2\n", "first edit\n")
            .replace("line 29\n", "last edit\n");
        fs::write(root.join("partial.txt"), &edited).unwrap();
        let plan = hunk_plan(
            &exe,
            root,
            review_index(&exe, root).unwrap(),
            change(&exe, root, "partial.txt", ChangeGroup::Unstaged),
        )
        .unwrap()
        .unwrap();
        assert_eq!(plan.hunks.len(), 2);
        apply_hunk(&exe, root, &plan.review, 0).unwrap();
        let staged = git(&exe, root, &["diff", "--cached"]);
        assert!(staged.contains("+first edit"));
        assert!(!staged.contains("last edit"));
        assert!(git(&exe, root, &["diff"]).contains("+last edit"));
        assert_eq!(
            fs::read_to_string(root.join("partial.txt")).unwrap(),
            edited
        );
        let plan = hunk_plan(
            &exe,
            root,
            review_index(&exe, root).unwrap(),
            change(&exe, root, "partial.txt", ChangeGroup::Staged),
        )
        .unwrap()
        .unwrap();
        apply_hunk(&exe, root, &plan.review, 0).unwrap();
        assert!(git(&exe, root, &["diff", "--cached"]).is_empty());
        let plan = hunk_plan(
            &exe,
            root,
            review_index(&exe, root).unwrap(),
            change(&exe, root, "partial.txt", ChangeGroup::Unstaged),
        )
        .unwrap()
        .unwrap();
        fs::write(
            root.join("partial.txt"),
            edited.replace("first edit", "new content"),
        )
        .unwrap();
        assert!(matches!(
            apply_hunk(&exe, root, &plan.review, 0),
            Err(WriteError::Stale)
        ));
        assert!(git(&exe, root, &["diff", "--cached"]).is_empty());
    }

    #[test]
    fn reviews_bulk_changes_discard_and_amend_on_a_partly_staged_tree() {
        let (exe, fixture) = fixture();
        let root = fixture.path();
        for path in ["a.txt", "b.txt", "other.txt"] {
            fs::write(root.join(path), "base\n").unwrap();
        }
        git(&exe, root, &["add", "."]);
        git(&exe, root, &["commit", "-m", "Base"]);
        fs::write(root.join("other.txt"), "already staged\n").unwrap();
        git(&exe, root, &["add", "--", "other.txt"]);
        for path in ["a.txt", "b.txt"] {
            fs::write(root.join(path), "bulk review\n").unwrap();
        }
        let selected = || {
            ["a.txt", "b.txt"]
                .iter()
                .map(|path| change(&exe, root, path, ChangeGroup::Unstaged))
                .collect::<Vec<_>>()
        };
        let plan = bulk_plan(
            &exe,
            root,
            review_index(&exe, root).unwrap(),
            selected(),
            IndexAction::Stage,
        )
        .unwrap();
        fs::write(root.join("b.txt"), "new bulk contents\n").unwrap();
        assert!(matches!(
            update_selection(
                &exe,
                root,
                &plan.expected,
                &plan.changes,
                plan.action,
                true,
                Some(&plan.stamps)
            ),
            Err(WriteError::Stale)
        ));
        assert_eq!(
            git(&exe, root, &["diff", "--cached", "--name-only"]),
            "other.txt"
        );
        let plan = bulk_plan(
            &exe,
            root,
            review_index(&exe, root).unwrap(),
            selected(),
            IndexAction::Stage,
        )
        .unwrap();
        update_selection(
            &exe,
            root,
            &plan.expected,
            &plan.changes,
            plan.action,
            true,
            Some(&plan.stamps),
        )
        .unwrap();
        assert_eq!(
            git(&exe, root, &["diff", "--cached", "--name-only"]),
            "a.txt\nb.txt\nother.txt"
        );
        fs::write(root.join("a.txt"), "discard me\n").unwrap();
        let view = || {
            review_discard(
                &exe,
                root,
                review_index(&exe, root).unwrap(),
                change(&exe, root, "a.txt", ChangeGroup::Unstaged),
            )
            .unwrap()
        };
        let plan = view();
        fs::write(root.join("a.txt"), "new working edit\n").unwrap();
        assert!(matches!(
            discard(&exe, root, plan.review),
            Err(WriteError::Stale)
        ));
        assert_eq!(
            fs::read_to_string(root.join("a.txt")).unwrap(),
            "new working edit\n"
        );
        discard(&exe, root, view().review).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("a.txt")).unwrap(),
            "bulk review\n"
        );
        let staged = ["a.txt", "b.txt"]
            .iter()
            .map(|path| change(&exe, root, path, ChangeGroup::Staged))
            .collect();
        let plan = bulk_plan(
            &exe,
            root,
            review_index(&exe, root).unwrap(),
            staged,
            IndexAction::Unstage,
        )
        .unwrap();
        update_selection(
            &exe,
            root,
            &plan.expected,
            &plan.changes,
            plan.action,
            true,
            Some(&plan.stamps),
        )
        .unwrap();
        assert_eq!(
            git(&exe, root, &["diff", "--cached", "--name-only"]),
            "other.txt"
        );
        write_commit(
            &exe,
            root,
            &review_index(&exe, root).unwrap(),
            "Amended base",
            true,
        )
        .unwrap();
        assert_eq!(git(&exe, root, &["rev-list", "--count", "HEAD"]), "1");
        assert_eq!(
            git(&exe, root, &["log", "-1", "--format=%s"]),
            "Amended base"
        );
        assert_eq!(
            git(&exe, root, &["show", "HEAD:other.txt"]),
            "already staged"
        );
        assert_eq!(
            fs::read_to_string(root.join("b.txt")).unwrap(),
            "new bulk contents\n"
        );
    }

    fn change(git: &Path, root: &Path, path: &str, group: ChangeGroup) -> WorkingChange {
        working_changes(git, root)
            .unwrap()
            .into_iter()
            .find(|row| row.path == path && row.group == group)
            .unwrap()
    }

    #[test]
    fn stages_unstages_and_commits_with_an_unborn_branch() {
        let (executable, fixture) = fixture();
        let root = fixture.path();
        let name = "review [one].txt";
        fs::write(root.join(name), "reviewed\n").unwrap();
        fs::write(root.join("other.txt"), "outside the commit\n").unwrap();
        let original = snapshot(&executable, root).unwrap().snapshot;
        update_index(
            &executable,
            root,
            &original,
            change(&executable, root, name, ChangeGroup::Untracked),
            IndexAction::Stage,
            false,
        )
        .unwrap();
        let staged = snapshot(&executable, root).unwrap().snapshot;
        assert!(matches!(
            commit_changes(&executable, root, &original, "stale"),
            Err(WriteError::Stale)
        ));
        update_index(
            &executable,
            root,
            &staged,
            change(&executable, root, name, ChangeGroup::Staged),
            IndexAction::Unstage,
            false,
        )
        .unwrap();
        assert_eq!(fs::read_to_string(root.join(name)).unwrap(), "reviewed\n");
        update_index(
            &executable,
            root,
            &original,
            change(&executable, root, name, ChangeGroup::Untracked),
            IndexAction::Stage,
            false,
        )
        .unwrap();
        fs::write(root.join(name), "unstaged\n").unwrap();
        assert!(matches!(
            update_index(
                &executable,
                root,
                &staged,
                change(&executable, root, name, ChangeGroup::Unstaged),
                IndexAction::Stage,
                false,
            ),
            Err(WriteError::ConfirmReplacement)
        ));
        let commit = commit_changes(&executable, root, &staged, "The reviewed files").unwrap();
        assert_eq!(
            commit,
            git(&executable, root, &["rev-parse", "--short", "HEAD"])
        );
        assert_eq!(
            git(&executable, root, &["ls-tree", "--name-only", "HEAD"]),
            name
        );
        assert_eq!(
            git(&executable, root, &["show", &format!("HEAD:{name}")]),
            "reviewed"
        );
        assert_eq!(fs::read_to_string(root.join(name)).unwrap(), "unstaged\n");
    }

    #[test]
    fn rejects_a_hook_that_changes_the_reviewed_tree() {
        let (executable, fixture) = fixture();
        let root = fixture.path();
        fs::write(root.join("reviewed"), "reviewed").unwrap();
        fs::write(root.join("hook-extra"), "not reviewed").unwrap();
        git(&executable, root, &["add", "--", "reviewed"]);
        let hooks = root.join("custom hooks");
        fs::create_dir(&hooks).unwrap();
        git(
            &executable,
            root,
            &["config", "core.hooksPath", "custom hooks"],
        );
        create_hook(
            &hooks.join("pre-commit"),
            "#!/bin/sh\nset -e\ngit add -- hook-extra\n",
        )
        .unwrap();
        let expected = snapshot(&executable, root).unwrap().snapshot;
        let error = commit_changes(&executable, root, &expected, "Must be rejected").unwrap_err();
        assert!(
            matches!(error, WriteError::Failed(detail) if detail.contains("changed the staged files"))
        );
        assert!(snapshot(&executable, root).unwrap().snapshot == expected);
        assert_eq!(
            git(&executable, root, &["diff", "--cached", "--name-only"]),
            "reviewed"
        );
    }

    #[test]
    fn restores_both_rename_paths_and_keeps_linked_worktree_commits_separate() {
        let (executable, fixture) = fixture();
        let root = fixture.path();
        fs::write(root.join("from.txt"), "original").unwrap();
        git(&executable, root, &["add", "--", "from.txt"]);
        git(&executable, root, &["commit", "-m", "Initial"]);
        let original_head = git(&executable, root, &["rev-parse", "HEAD"]);
        let fixture = tempfile::tempdir().unwrap();
        let linked = fixture.path();
        git(
            &executable,
            root,
            &["worktree", "add", "-b", "topic", linked.to_str().unwrap()],
        );
        git(&executable, linked, &["mv", "--", "from.txt", "to.txt"]);
        let review = snapshot(&executable, linked).unwrap().snapshot;
        let lock = git_path(&executable, linked, "index.lock").unwrap();
        fs::write(&lock, "").unwrap();
        assert!(matches!(
            commit_changes(&executable, linked, &review, "Locked"),
            Err(WriteError::Busy)
        ));
        fs::remove_file(lock).unwrap();
        update_index(
            &executable,
            linked,
            &review,
            change(&executable, linked, "to.txt", ChangeGroup::Staged),
            IndexAction::Unstage,
            false,
        )
        .unwrap();
        assert!(!linked.join("from.txt").exists());
        assert_eq!(
            fs::read_to_string(linked.join("to.txt")).unwrap(),
            "original"
        );
        assert_eq!(
            git(
                &executable,
                linked,
                &["ls-files", "--stage", "--", "to.txt"]
            ),
            ""
        );
        git(&executable, linked, &["add", "-A"]);
        let review = snapshot(&executable, linked).unwrap().snapshot;
        let committed =
            commit_changes(&executable, linked, &review, "Rename in linked worktree").unwrap();
        assert_eq!(
            committed,
            git(&executable, linked, &["rev-parse", "--short", "HEAD"])
        );
        assert_eq!(
            git(&executable, linked, &["ls-tree", "--name-only", "HEAD"]),
            "to.txt"
        );
        assert_eq!(
            git(&executable, root, &["rev-parse", "HEAD"]),
            original_head
        );
    }
}
