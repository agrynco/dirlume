use super::{
    bounded, comparison, history_edits, line, merge, oid, run, success, working_changes, writes,
    Change, GitError, WorkingChange, STATUS_LIMIT,
};
use serde::{Deserialize, Serialize};
use std::path::Path;
use writes::{IndexSnapshot, WriteError};

type WriteResult<T> = std::result::Result<T, WriteError>;

#[derive(Deserialize, Serialize)]
pub struct StashEntry {
    hash: String,
    position: usize,
    subject: String,
}

#[derive(Serialize)]
pub struct StashChange {
    base: Option<String>,
    target: String,
    change: Change,
}

#[derive(Serialize)]
pub struct StashPreview {
    combined: Vec<StashChange>,
    staged: Vec<StashChange>,
    working: Vec<StashChange>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StashAction {
    Apply,
    Pop,
    Drop,
}

#[derive(Serialize)]
pub struct StashResult {
    changes: Vec<WorkingChange>,
    error: Option<String>,
}

fn list(git: &Path, root: &Path) -> WriteResult<Vec<StashEntry>> {
    merge::verify_worktree(git, root)?;
    let exists = run(git, root, &["reflog", "exists", "refs/stash"])?;
    if exists.status.code() == Some(1) && exists.stderr.is_empty() {
        return Ok(Vec::new());
    }
    merge::execute(exists)?;
    let data = bounded(
        git,
        root,
        &[
            "log",
            "-g",
            "-z",
            "--no-notes",
            "--no-show-signature",
            "--format=%H%x00%gs",
            "refs/stash",
            "--",
        ],
        STATUS_LIMIT,
    )?
    .ok_or(GitError::Unreadable)?;
    let text = String::from_utf8_lossy(&data);
    let fields = text.split_terminator('\0').collect::<Vec<_>>();
    let (entries, remainder) = fields.as_chunks::<2>();
    if !remainder.is_empty() {
        return Err(GitError::Unreadable.into());
    }
    entries
        .iter()
        .enumerate()
        .map(|(position, fields)| {
            Ok(StashEntry {
                hash: oid(fields[0])?.into(),
                position,
                subject: fields[1].into(),
            })
        })
        .collect()
}

fn selector(git: &Path, root: &Path, entry: &StashEntry) -> WriteResult<String> {
    let reference = format!("stash@{{{}}}", entry.position);
    let current = run(git, root, &["rev-parse", "--verify", "--quiet", &reference])?;
    if !current.status.success() || line(current.stdout)? != oid(&entry.hash)? {
        return Err(WriteError::Stale);
    }
    Ok(reference)
}

fn inspect(git: &Path, root: &Path, entry: &StashEntry) -> WriteResult<StashPreview> {
    merge::verify_worktree(git, root)?;
    selector(git, root, entry)?;
    let hash = oid(&entry.hash)?;
    let revisions = line(success(run(
        git,
        root,
        &["rev-list", "--parents", "-1", hash, "--"],
    )?)?)?;
    let parents = revisions
        .split_whitespace()
        .skip(1)
        .map(oid)
        .collect::<super::Result<Vec<_>>>()?;
    let [base, index, untracked @ ..] = parents.as_slice() else {
        return Err(GitError::Unreadable.into());
    };
    let files = |base: Option<&str>, target: &str| -> WriteResult<Vec<StashChange>> {
        Ok(comparison::changed_paths(git, root, base, target)?
            .into_iter()
            .map(|change| StashChange {
                base: base.map(str::to_owned),
                target: target.to_owned(),
                change,
            })
            .collect())
    };
    let mut combined = files(Some(base), hash)?;
    if let Some(untracked) = untracked.first() {
        combined.extend(files(None, untracked)?);
    }
    Ok(StashPreview {
        combined,
        staged: files(Some(base), index)?,
        working: files(Some(index), hash)?,
    })
}

fn verify_index(git: &Path, root: &Path, expected: &IndexSnapshot) -> WriteResult<()> {
    if writes::review_index(git, root)? != *expected {
        return Err(WriteError::Stale);
    }
    Ok(())
}

fn create(
    git: &Path,
    root: &Path,
    expected: &IndexSnapshot,
    message: &str,
    untracked: bool,
) -> WriteResult<()> {
    verify_index(git, root, expected)?;
    if message.contains('\0') {
        return Err(WriteError::UnsupportedChange);
    }
    let mut args = vec!["stash", "push"];
    if untracked {
        args.push("--include-untracked");
    }
    if !message.trim().is_empty() {
        args.extend(["--message", message.trim()]);
    }
    merge::execute(run(git, root, &args)?)
}

fn change(
    git: &Path,
    root: &Path,
    expected: &IndexSnapshot,
    entry: &StashEntry,
    action: StashAction,
    restore_index: bool,
) -> WriteResult<StashResult> {
    if matches!(action, StashAction::Drop) {
        merge::verify_worktree(git, root)?;
        let reference = selector(git, root, entry)?;
        merge::execute(run(git, root, &["stash", "drop", &reference])?)?;
        return Ok(StashResult {
            changes: working_changes(git, root)?,
            error: None,
        });
    }
    verify_index(git, root, expected)?;
    selector(git, root, entry)?;
    let mut args = vec!["stash", "apply"];
    if restore_index {
        args.push("--index");
    }
    args.push(oid(&entry.hash)?);
    let applied = merge::execute(run(git, root, &args)?);
    let changes = working_changes(git, root)?;
    if let Err(error) = applied {
        return match error {
            WriteError::Failed(message) => Ok(StashResult {
                changes,
                error: Some(if message.is_empty() {
                    "Git could not apply the stash.".into()
                } else {
                    message
                }),
            }),
            other => Err(other),
        };
    }
    let error = if matches!(action, StashAction::Pop) {
        match selector(git, root, entry)
            .and_then(|reference| merge::execute(run(git, root, &["stash", "drop", &reference])?))
        {
            Ok(()) => None,
            Err(_) => Some(
                "The stash was applied. Its entry could not be removed from the reflog.".into(),
            ),
        }
    } else {
        None
    };
    Ok(StashResult { changes, error })
}

#[tauri::command]
pub async fn git_stashes(root: String) -> WriteResult<Vec<StashEntry>> {
    history_edits::write(root, list).await
}

#[tauri::command]
pub async fn git_stash_preview(root: String, entry: StashEntry) -> WriteResult<StashPreview> {
    history_edits::write(root, move |git, root| inspect(git, root, &entry)).await
}

#[tauri::command]
pub async fn git_create_stash(
    root: String,
    expected: IndexSnapshot,
    message: String,
    untracked: bool,
) -> WriteResult<()> {
    history_edits::write(root, move |git, root| {
        create(git, root, &expected, &message, untracked)
    })
    .await
}

#[tauri::command]
pub async fn git_update_stash(
    root: String,
    expected: IndexSnapshot,
    entry: StashEntry,
    action: StashAction,
    restore_index: bool,
) -> WriteResult<StashResult> {
    history_edits::write(root, move |git, root| {
        change(git, root, &expected, &entry, action, restore_index)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn restores_the_index_and_working_tree_and_checks_the_selected_reflog_entry() {
        let git = super::super::executable().unwrap();
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let cli = |args: &[&str]| super::super::tests::git(root, args);
        cli(&["init", "--initial-branch=main"]);
        cli(&["config", "user.email", "fixture@example.test"]);
        cli(&["config", "user.name", "Dirlume Fixture"]);
        cli(&["config", "commit.gpgsign", "false"]);
        cli(&["config", "core.autocrlf", "false"]);
        fs::write(root.join("note.txt"), "base\n").unwrap();
        cli(&["add", "--", "note.txt"]);
        cli(&["commit", "-m", "Base"]);
        fs::write(root.join("note.txt"), "staged\n").unwrap();
        cli(&["add", "--", "note.txt"]);
        fs::write(root.join("note.txt"), "working\n").unwrap();
        fs::write(root.join("new.txt"), "untracked\n").unwrap();
        create(
            &git,
            root,
            &writes::review_index(&git, root).unwrap(),
            "Partly staged",
            true,
        )
        .unwrap();
        let items = list(&git, root).unwrap();
        assert_eq!(items.len(), 1);
        let first = &items[0];
        let preview = inspect(&git, root, first).unwrap();
        let read_content = |change: &StashChange| {
            let object = format!("{}:{}", change.target, change.change.path);
            line(success(run(&git, root, &["show", &object]).unwrap()).unwrap()).unwrap()
        };
        assert_eq!(preview.staged[0].change.path, "note.txt");
        assert_eq!(read_content(&preview.staged[0]), "staged");
        assert_eq!(read_content(&preview.working[0]), "working");
        assert_eq!(
            preview.working[0].base.as_deref(),
            Some(preview.staged[0].target.as_str())
        );
        let untracked = preview
            .combined
            .iter()
            .find(|version| version.change.path == "new.txt")
            .unwrap();
        assert!(untracked.base.is_none());
        assert_eq!(read_content(untracked), "untracked");
        assert_eq!(fs::read_to_string(root.join("note.txt")).unwrap(), "base\n");
        let result = change(
            &git,
            root,
            &writes::review_index(&git, root).unwrap(),
            first,
            StashAction::Apply,
            true,
        )
        .unwrap();
        assert!(result.error.is_none());
        assert_eq!(cli(&["show", ":note.txt"]), "staged");
        assert_eq!(
            fs::read_to_string(root.join("note.txt")).unwrap(),
            "working\n"
        );
        assert!(root.join("new.txt").exists());
        create(
            &git,
            root,
            &writes::review_index(&git, root).unwrap(),
            "Second entry",
            true,
        )
        .unwrap();
        assert!(matches!(
            change(
                &git,
                root,
                &writes::review_index(&git, root).unwrap(),
                first,
                StashAction::Drop,
                true
            ),
            Err(WriteError::Stale)
        ));
        let after = list(&git, root).unwrap();
        assert_eq!(after.len(), 2);
        change(
            &git,
            root,
            &writes::review_index(&git, root).unwrap(),
            &after[0],
            StashAction::Drop,
            true,
        )
        .unwrap();
        let result = change(
            &git,
            root,
            &writes::review_index(&git, root).unwrap(),
            first,
            StashAction::Pop,
            true,
        )
        .unwrap();
        assert!(result.error.is_none());
        assert!(list(&git, root).unwrap().is_empty());
        assert_eq!(cli(&["show", ":note.txt"]), "staged");
        assert_eq!(
            fs::read_to_string(root.join("note.txt")).unwrap(),
            "working\n"
        );

        create(
            &git,
            root,
            &writes::review_index(&git, root).unwrap(),
            "Conflicting stash",
            true,
        )
        .unwrap();
        fs::write(root.join("note.txt"), "other committed edit\n").unwrap();
        cli(&["add", "--", "note.txt"]);
        cli(&["commit", "-m", "Diverged"]);
        let items = list(&git, root).unwrap();
        let result = change(
            &git,
            root,
            &writes::review_index(&git, root).unwrap(),
            &items[0],
            StashAction::Pop,
            false,
        )
        .unwrap();
        assert!(result.error.is_some_and(|message| !message.is_empty()));
        assert!(result
            .changes
            .iter()
            .any(|change| change.status == 'U' && change.path == "note.txt"));
        assert_eq!(list(&git, root).unwrap()[0].hash, items[0].hash);
    }
}
