use super::{
    bounded, directory, executable, line, oid, parse_changes, relative_file, repository, run,
    success, text_patch, working_file, writes, Change, GitError, Result, PATCH_LIMIT, STATUS_LIMIT,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path, process::Output};
use writes::WriteError;

type WriteResult<T> = std::result::Result<T, WriteError>;

#[derive(Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeReview {
    head_ref: String,
    head: String,
    source_ref: String,
    source_tip: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePlan {
    review: MergeReview,
    fast_forward: bool,
    up_to_date: bool,
    changes: Vec<Change>,
}

#[derive(Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeSession {
    head: String,
    sources: Vec<String>,
}

#[derive(Deserialize, PartialEq, Serialize)]
struct Version {
    mode: String,
    oid: String,
}

#[derive(Deserialize, PartialEq, Serialize)]
pub struct MergeConflict {
    path: String,
    base: Option<Version>,
    ours: Option<Version>,
    theirs: Option<Version>,
}

#[derive(Serialize)]
pub struct MergeState {
    session: MergeSession,
    conflicts: Vec<MergeConflict>,
}

#[derive(Serialize)]
pub struct ConflictText {
    text: Option<String>,
    fallback: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictPreview {
    base: Option<ConflictText>,
    ours: Option<ConflictText>,
    theirs: Option<ConflictText>,
    working_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeMode {
    FastForward,
    MergeCommit,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Resolution {
    Ours,
    Theirs,
    Working,
}

fn verify_worktree(git: &Path, root: &Path) -> Result<()> {
    let actual = line(success(run(git, root, &["rev-parse", "--show-toplevel"])?)?)?;
    if Path::new(&actual)
        .canonicalize()
        .map_err(super::process_error)?
        != root.canonicalize().map_err(super::process_error)?
    {
        return Err(GitError::NotRepository);
    }
    Ok(())
}

fn merge_state(git: &Path, root: &Path) -> Result<Option<MergeState>> {
    verify_worktree(git, root)?;
    let path = writes::git_path(git, root, "MERGE_HEAD")?;
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(super::process_error(error)),
    };
    let sources = contents
        .lines()
        .map(|value| oid(value).map(str::to_owned))
        .collect::<Result<Vec<_>>>()?;
    if sources.is_empty() {
        return Err(GitError::Unreadable);
    }
    let head = line(success(run(
        git,
        root,
        &["rev-parse", "--verify", "HEAD"],
    )?)?)?;
    let entries = bounded(git, root, &["ls-files", "--unmerged", "-z"], STATUS_LIMIT)?
        .ok_or(GitError::Unreadable)?;
    let entries = std::str::from_utf8(&entries).map_err(|_| GitError::Unreadable)?;
    let mut conflicts = BTreeMap::<String, MergeConflict>::new();
    for entry in entries.split_terminator('\0') {
        let (metadata, path) = entry.split_once('\t').ok_or(GitError::Unreadable)?;
        let mut fields = metadata.split_whitespace();
        let mode = fields.next().ok_or(GitError::Unreadable)?;
        let hash = oid(fields.next().ok_or(GitError::Unreadable)?)?;
        let stage = fields.next().ok_or(GitError::Unreadable)?;
        let conflict = conflicts
            .entry(path.into())
            .or_insert_with(|| MergeConflict {
                path: path.into(),
                base: None,
                ours: None,
                theirs: None,
            });
        let slot = match stage {
            "1" => &mut conflict.base,
            "2" => &mut conflict.ours,
            "3" => &mut conflict.theirs,
            _ => return Err(GitError::Unreadable),
        };
        *slot = Some(Version {
            mode: mode.into(),
            oid: hash.into(),
        });
    }
    Ok(Some(MergeState {
        session: MergeSession { head, sources },
        conflicts: conflicts.into_values().collect(),
    }))
}

fn branch_review(git: &Path, root: &Path, source: &str) -> WriteResult<MergeReview> {
    verify_worktree(git, root)?;
    let state = repository(git, root)?;
    let head_ref = state.head_ref.ok_or(WriteError::Detached)?;
    let head = state.head.ok_or(WriteError::Stale)?;
    let branch = state
        .branches
        .into_iter()
        .find(|branch| branch.reference == source)
        .ok_or(WriteError::Stale)?;
    Ok(MergeReview {
        head_ref,
        head,
        source_ref: branch.reference,
        source_tip: branch.tip,
    })
}

fn plan(git: &Path, root: &Path, source: &str) -> WriteResult<MergePlan> {
    let review = branch_review(git, root, source)?;
    writes::verify_branch_head(git, root, Some(&review.head_ref), Some(&review.head))?;
    let ancestor = run(git, root, &["merge-base", &review.head, &review.source_tip])?;
    if ancestor.status.code() == Some(1) {
        return Err(WriteError::Failed(
            "The selected branches have no common commit.".into(),
        ));
    }
    let base = line(success(ancestor)?)?;
    let diff = bounded(
        git,
        root,
        &[
            "diff",
            "-z",
            "--name-status",
            "--find-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--no-relative",
            oid(&base)?,
            &review.source_tip,
            "--",
        ],
        STATUS_LIMIT,
    )?
    .ok_or(GitError::Unreadable)?;
    Ok(MergePlan {
        fast_forward: base == review.head,
        up_to_date: base == review.source_tip,
        review,
        changes: parse_changes(&diff)?,
    })
}

fn execute(output: Output) -> WriteResult<()> {
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    Err(WriteError::Failed(detail.trim().to_owned()))
}

fn start(git: &Path, root: &Path, review: &MergeReview, mode: MergeMode) -> WriteResult<()> {
    writes::verify_branch_head(git, root, Some(&review.head_ref), Some(&review.head))?;
    if branch_review(git, root, &review.source_ref)? != *review {
        return Err(WriteError::Stale);
    }
    let option = match mode {
        MergeMode::FastForward => "--ff-only",
        MergeMode::MergeCommit => "--no-ff",
    };
    let output = run(
        git,
        root,
        &["merge", option, "--no-edit", "--", oid(&review.source_tip)?],
    )?;
    if !output.status.success()
        && merge_state(git, root)?.is_some_and(|state| !state.conflicts.is_empty())
    {
        // Conflicts are part of an active merge and can be resolved from its actual state.
        return Ok(());
    }
    execute(output)
}

fn matching_state(git: &Path, root: &Path, session: &MergeSession) -> WriteResult<MergeState> {
    merge_state(git, root)?
        .filter(|state| state.session == *session)
        .ok_or(WriteError::Stale)
}

fn verify_conflict(
    git: &Path,
    root: &Path,
    session: &MergeSession,
    conflict: &MergeConflict,
) -> WriteResult<()> {
    if !matching_state(git, root, session)?
        .conflicts
        .contains(conflict)
    {
        return Err(WriteError::Stale);
    }
    Ok(())
}

fn read_version(
    git: &Path,
    root: &Path,
    version: Option<&Version>,
) -> Result<Option<ConflictText>> {
    let Some(version) = version else {
        return Ok(None);
    };
    if !matches!(version.mode.as_str(), "100644" | "100755") {
        return Ok(Some(ConflictText {
            text: None,
            fallback: Some("unsupported"),
        }));
    }
    let text = bounded(
        git,
        root,
        &["cat-file", "blob", oid(&version.oid)?],
        PATCH_LIMIT,
    )?
    .ok_or("oversized")
    .and_then(text_patch);
    Ok(Some(match text {
        Ok(text) => ConflictText {
            text: Some(text),
            fallback: None,
        },
        Err(reason) => ConflictText {
            text: None,
            fallback: Some(reason),
        },
    }))
}

fn inspect(
    git: &Path,
    root: &Path,
    session: &MergeSession,
    conflict: &MergeConflict,
) -> WriteResult<ConflictPreview> {
    verify_conflict(git, root, session, conflict)?;
    let working_path = working_file(root, relative_file(&conflict.path)?).and_then(|path| {
        let file = fs::File::open(&path).ok()?;
        crate::desktop::decode_text(file).ok()?;
        path.into_os_string().into_string().ok()
    });
    Ok(ConflictPreview {
        base: read_version(git, root, conflict.base.as_ref())?,
        ours: read_version(git, root, conflict.ours.as_ref())?,
        theirs: read_version(git, root, conflict.theirs.as_ref())?,
        working_path,
    })
}

fn resolve(
    git: &Path,
    root: &Path,
    session: &MergeSession,
    conflict: &MergeConflict,
    resolution: Resolution,
) -> WriteResult<()> {
    verify_conflict(git, root, session, conflict)?;
    let path = &conflict.path;
    relative_file(path)?;
    let version = match resolution {
        Resolution::Ours => conflict.ours.as_ref().map(|version| ("--ours", version)),
        Resolution::Theirs => conflict
            .theirs
            .as_ref()
            .map(|version| ("--theirs", version)),
        Resolution::Working => {
            if fs::symlink_metadata(root.join(path)).is_ok_and(|metadata| metadata.is_dir())
                || [&conflict.base, &conflict.ours, &conflict.theirs]
                    .into_iter()
                    .flatten()
                    .any(|version| version.mode == "160000")
            {
                return Err(WriteError::UnsupportedChange);
            }
            return execute(run(git, root, &["--literal-pathspecs", "add", "--", path])?);
        }
    };
    let Some((choice, version)) = version else {
        return execute(run(git, root, &["--literal-pathspecs", "rm", "--", path])?);
    };
    if !matches!(version.mode.as_str(), "100644" | "100755" | "120000") {
        return Err(WriteError::UnsupportedChange);
    }
    execute(run(
        git,
        root,
        &["--literal-pathspecs", "checkout", choice, "--", path],
    )?)?;
    execute(run(git, root, &["--literal-pathspecs", "add", "--", path])?)
}

fn finish(git: &Path, root: &Path, session: &MergeSession, abort: bool) -> WriteResult<()> {
    let state = matching_state(git, root, session)?;
    if abort {
        return execute(run(git, root, &["merge", "--abort"])?);
    }
    if !state.conflicts.is_empty() {
        return Err(WriteError::OperationInProgress);
    }
    execute(run(git, root, &["commit", "--no-edit"])?)
}

async fn write<T: Send + 'static>(
    task: impl FnOnce() -> WriteResult<T> + Send + 'static,
) -> WriteResult<T> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| WriteError::Failed(error.to_string()))?
}

#[tauri::command]
pub async fn git_merge_state(root: String) -> Result<Option<MergeState>> {
    super::query(move || merge_state(&executable()?, directory(&root)?)).await
}

#[tauri::command]
pub async fn git_merge_plan(root: String, source: String) -> WriteResult<MergePlan> {
    write(move || plan(&executable()?, directory(&root)?, &source)).await
}

#[tauri::command]
pub async fn git_start_merge(
    root: String,
    review: MergeReview,
    mode: MergeMode,
) -> WriteResult<()> {
    write(move || start(&executable()?, directory(&root)?, &review, mode)).await
}

#[tauri::command]
pub async fn git_inspect_merge(
    root: String,
    session: MergeSession,
    conflict: MergeConflict,
) -> WriteResult<ConflictPreview> {
    write(move || inspect(&executable()?, directory(&root)?, &session, &conflict)).await
}

#[tauri::command]
pub async fn git_resolve_merge(
    root: String,
    session: MergeSession,
    conflict: MergeConflict,
    resolution: Resolution,
) -> WriteResult<()> {
    write(move || {
        resolve(
            &executable()?,
            directory(&root)?,
            &session,
            &conflict,
            resolution,
        )
    })
    .await
}

#[tauri::command]
pub async fn git_finish_merge(root: String, session: MergeSession, abort: bool) -> WriteResult<()> {
    write(move || finish(&executable()?, directory(&root)?, &session, abort)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn previews_stale_refs_and_recovers_conflicted_merges() {
        let git = executable().unwrap();
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let run = |args: &[&str]| super::super::tests::git(root, args);
        run(&["init", "-b", "main"]);
        run(&["config", "user.name", "Fixture"]);
        run(&["config", "user.email", "fixture@example.invalid"]);
        run(&["config", "commit.gpgsign", "false"]);
        run(&["config", "core.autocrlf", "false"]);
        fs::write(root.join("shared.txt"), "base\n").unwrap();
        run(&["add", "--", "shared.txt"]);
        run(&["commit", "-m", "Base"]);
        run(&["switch", "-c", "topic"]);
        fs::write(root.join("shared.txt"), "topic\n").unwrap();
        run(&["add", "--", "shared.txt"]);
        run(&["commit", "-m", "Topic"]);
        run(&["switch", "main"]);
        let preview = plan(&git, root, "refs/heads/topic").unwrap();
        assert!(preview.fast_forward && !preview.up_to_date);
        assert_eq!(preview.changes[0].path, "shared.txt");
        fs::write(root.join("shared.txt"), "dirty\n").unwrap();
        assert!(start(&git, root, &preview.review, MergeMode::FastForward).is_err());
        assert_eq!(
            fs::read_to_string(root.join("shared.txt")).unwrap(),
            "dirty\n"
        );
        run(&["restore", "--", "shared.txt"]);
        start(&git, root, &preview.review, MergeMode::FastForward).unwrap();
        assert!(merge_state(&git, root).unwrap().is_none());
        assert!(matches!(
            start(&git, root, &preview.review, MergeMode::FastForward),
            Err(WriteError::Stale)
        ));

        run(&["switch", "topic"]);
        fs::write(root.join("shared.txt"), "theirs\n").unwrap();
        run(&["add", "--", "shared.txt"]);
        run(&["commit", "-m", "Their change"]);
        run(&["switch", "main"]);
        fs::write(root.join("shared.txt"), "ours\n").unwrap();
        run(&["add", "--", "shared.txt"]);
        run(&["commit", "-m", "Our change"]);
        let review = plan(&git, root, "refs/heads/topic").unwrap().review;
        let head = run(&["rev-parse", "HEAD"]);
        start(&git, root, &review, MergeMode::MergeCommit).unwrap();
        let active = merge_state(&git, root).unwrap().unwrap();
        let conflict = &active.conflicts[0];
        let versions = inspect(&git, root, &active.session, conflict).unwrap();
        assert_eq!(versions.base.unwrap().text.as_deref(), Some("topic\n"));
        assert_eq!(versions.ours.unwrap().text.as_deref(), Some("ours\n"));
        assert_eq!(versions.theirs.unwrap().text.as_deref(), Some("theirs\n"));
        assert!(matches!(
            finish(&git, root, &active.session, false),
            Err(WriteError::OperationInProgress)
        ));
        finish(&git, root, &active.session, true).unwrap();
        assert_eq!(run(&["rev-parse", "HEAD"]), head);
        assert_eq!(
            fs::read_to_string(root.join("shared.txt")).unwrap(),
            "ours\n"
        );
        assert!(merge_state(&git, root).unwrap().is_none());

        start(&git, root, &review, MergeMode::MergeCommit).unwrap();
        let active = merge_state(&git, root).unwrap().unwrap();
        resolve(
            &git,
            root,
            &active.session,
            &active.conflicts[0],
            Resolution::Theirs,
        )
        .unwrap();
        assert!(merge_state(&git, root)
            .unwrap()
            .unwrap()
            .conflicts
            .is_empty());
        finish(&git, root, &active.session, false).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("shared.txt")).unwrap(),
            "theirs\n"
        );
        assert_eq!(
            run(&["rev-list", "--parents", "-n", "1", "HEAD"])
                .split_whitespace()
                .count(),
            3
        );
    }

    #[test]
    fn uses_git_to_resolve_binary_and_deleted_paths() {
        let git = executable().unwrap();
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let run = |args: &[&str]| super::super::tests::git(root, args);
        run(&["init", "-b", "main"]);
        run(&["config", "user.name", "Fixture"]);
        run(&["config", "user.email", "fixture@example.invalid"]);
        run(&["config", "commit.gpgsign", "false"]);
        run(&["config", "core.autocrlf", "false"]);
        fs::write(root.join("file.bin"), [0, 1]).unwrap();
        fs::write(root.join("remove.txt"), "initial\n").unwrap();
        fs::write(root.join("rename.txt"), "rename fixture\n").unwrap();
        run(&["add", "--", "file.bin", "remove.txt", "rename.txt"]);
        run(&["commit", "-m", "Base"]);
        run(&["switch", "-c", "topic"]);
        fs::write(root.join("file.bin"), [0, 2]).unwrap();
        fs::write(root.join("remove.txt"), "edited on topic\n").unwrap();
        run(&["mv", "--", "rename.txt", "renamed.txt"]);
        run(&["commit", "-am", "Topic"]);
        run(&["switch", "main"]);
        fs::write(root.join("file.bin"), [0, 3]).unwrap();
        run(&["rm", "--", "remove.txt", "rename.txt"]);
        run(&["commit", "-am", "Main"]);
        let review = plan(&git, root, "refs/heads/topic").unwrap().review;
        start(&git, root, &review, MergeMode::MergeCommit).unwrap();
        let state = merge_state(&git, root).unwrap().unwrap();
        assert_eq!(state.conflicts.len(), 3);
        let binary = state
            .conflicts
            .iter()
            .find(|conflict| conflict.path == "file.bin")
            .unwrap();
        let removed = state
            .conflicts
            .iter()
            .find(|conflict| conflict.path == "remove.txt")
            .unwrap();
        let renamed = state
            .conflicts
            .iter()
            .find(|conflict| conflict.path == "renamed.txt")
            .unwrap();
        assert_eq!(
            inspect(&git, root, &state.session, binary)
                .unwrap()
                .theirs
                .unwrap()
                .fallback,
            Some("binary")
        );
        assert!(inspect(&git, root, &state.session, removed)
            .unwrap()
            .ours
            .is_none());
        resolve(&git, root, &state.session, binary, Resolution::Theirs).unwrap();
        resolve(&git, root, &state.session, removed, Resolution::Ours).unwrap();
        resolve(&git, root, &state.session, renamed, Resolution::Theirs).unwrap();
        finish(&git, root, &state.session, false).unwrap();
        assert_eq!(fs::read(root.join("file.bin")).unwrap(), [0, 2]);
        assert!(!root.join("remove.txt").exists());
        assert!(!root.join("rename.txt").exists());
        assert_eq!(
            fs::read_to_string(root.join("renamed.txt")).unwrap(),
            "rename fixture\n"
        );
    }
}
