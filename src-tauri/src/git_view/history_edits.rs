use super::{
    bounded, details, directory, executable, line, merge, oid, parse_changes, repository, run,
    success, working_changes, writes, Change, GitError, WorkingChange, STATUS_LIMIT,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, path::Path};
use writes::{IndexSnapshot, WriteError};

type WriteResult<T> = std::result::Result<T, WriteError>;

#[derive(Clone, Copy, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HistoryAction {
    CherryPick,
    Revert,
    SoftReset,
    MixedReset,
    HardReset,
}

#[derive(Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryReview {
    action: HistoryAction,
    head: String,
    head_ref: Option<String>,
    target: String,
    parent: Option<usize>,
    index: IndexSnapshot,
    tracked_changes: Option<[u8; 32]>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPlan {
    review: HistoryReview,
    parents: Vec<String>,
    paths: Vec<Change>,
    local_changes: Vec<WorkingChange>,
}

pub(super) fn local_commit(git: &Path, root: &Path, target: &str) -> WriteResult<String> {
    let target = format!("{}^{{commit}}", oid(target.trim())?);
    let resolved = line(success(run(
        git,
        root,
        &["rev-parse", "--verify", "--end-of-options", &target],
    )?)?)?;
    Ok(oid(&resolved)?.to_owned())
}

fn git_bytes(git: &Path, root: &Path, args: &[&str]) -> WriteResult<Vec<u8>> {
    bounded(git, root, args, STATUS_LIMIT)?.ok_or_else(|| {
        WriteError::Failed("The repository change list is too large to review safely.".into())
    })
}

fn protect_untracked(git: &Path, root: &Path, target: &str) -> WriteResult<()> {
    let paths = git_bytes(git, root, &["ls-tree", "-r", "--name-only", "-z", target])?;
    let files = git_bytes(git, root, &["ls-files", "--others", "-z"])?;
    let normalize = |path: &str| {
        if cfg!(windows) || cfg!(target_os = "macos") {
            path.to_lowercase()
        } else {
            path.to_owned()
        }
    };
    let normalize_paths = |data: &[u8]| -> WriteResult<BTreeSet<String>> {
        Ok(std::str::from_utf8(data)
            .map_err(|_| GitError::Unreadable)?
            .split_terminator('\0')
            .map(normalize)
            .collect())
    };
    let targets = normalize_paths(&paths)?;
    for file in normalize_paths(&files)? {
        let parent_collision = file
            .match_indices('/')
            .any(|(end, _)| targets.contains(&file[..end]));
        let prefix = format!("{file}/");
        let child_collision = targets
            .range(prefix.clone()..)
            .next()
            .is_some_and(|path| path.starts_with(&prefix));
        if parent_collision || child_collision || targets.contains(&file) {
            return Err(WriteError::Failed(
                "A file outside the index would be overwritten. Move it before resetting.".into(),
            ));
        }
    }
    Ok(())
}

fn review(
    git: &Path,
    root: &Path,
    action: HistoryAction,
    target: &str,
    parent: Option<usize>,
) -> WriteResult<HistoryPlan> {
    let index = writes::review_index(git, root)?;
    let repo = repository(git, root)?;
    let head = repo.head.ok_or(WriteError::UnsupportedChange)?;
    let target = local_commit(git, root, target)?;
    let replay = matches!(action, HistoryAction::CherryPick | HistoryAction::Revert);
    let mut parents = Vec::new();
    let paths = if replay {
        let line = line(success(run(
            git,
            root,
            &["rev-list", "--parents", "-n", "1", &target],
        )?)?)?;
        parents = line
            .split_whitespace()
            .skip(1)
            .map(|object| oid(object).map(str::to_owned))
            .collect::<super::Result<Vec<_>>>()?;
        if parent.is_some_and(|parent| parent == 0 || parent > parents.len()) {
            return Err(WriteError::UnsupportedChange);
        }
        if let Some(parent) = parent {
            changed_paths(git, root, &parents[parent - 1], &target)?
        } else if parents.len() > 1 {
            Vec::new()
        } else {
            details(git, root, &target)?.changes
        }
    } else {
        if parent.is_some() {
            return Err(WriteError::UnsupportedChange);
        }
        changed_paths(git, root, &head, &target)?
    };
    let tracked_changes = if action == HistoryAction::HardReset {
        protect_untracked(git, root, &target)?;
        let changes = git_bytes(
            git,
            root,
            &[
                "diff",
                "--binary",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--ignore-submodules=none",
                "--",
            ],
        )?;
        Some(
            ring::digest::digest(&ring::digest::SHA256, &changes)
                .as_ref()
                .try_into()
                .map_err(|_| GitError::Unreadable)?,
        )
    } else {
        None
    };
    Ok(HistoryPlan {
        review: HistoryReview {
            action,
            head,
            head_ref: repo.head_ref,
            target,
            parent,
            index,
            tracked_changes,
        },
        parents,
        paths,
        local_changes: working_changes(git, root)?,
    })
}

pub(super) fn changed_paths(
    git: &Path,
    root: &Path,
    from: &str,
    to: &str,
) -> WriteResult<Vec<Change>> {
    let raw = git_bytes(
        git,
        root,
        &[
            "diff",
            "--name-status",
            "-z",
            "--find-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--no-relative",
            from,
            to,
            "--",
        ],
    )?;
    Ok(parse_changes(&raw)?)
}

fn apply(git: &Path, root: &Path, examined: &HistoryReview) -> WriteResult<()> {
    let current = review(
        git,
        root,
        examined.action,
        &examined.target,
        examined.parent,
    )?;
    if current.review != *examined {
        return Err(WriteError::Stale);
    }
    let target = examined.target.as_str();
    match examined.action {
        HistoryAction::CherryPick | HistoryAction::Revert => {
            if current.parents.len() > 1 && examined.parent.is_none() {
                return Err(WriteError::Failed(
                    "Select the mainline parent of this merge commit.".into(),
                ));
            }
            let (subcommand, operation) = if examined.action == HistoryAction::CherryPick {
                ("cherry-pick", merge::Operation::CherryPick)
            } else {
                ("revert", merge::Operation::Revert)
            };
            let parent = examined.parent.map(|parent| format!("--mainline={parent}"));
            let mut args = vec![subcommand, "--no-edit"];
            args.extend(parent.as_deref());
            args.extend(["--", target]);
            merge::operation_result(git, root, operation, run(git, root, &args)?)
        }
        HistoryAction::SoftReset | HistoryAction::MixedReset | HistoryAction::HardReset => {
            let mode = match examined.action {
                HistoryAction::SoftReset => "--soft",
                HistoryAction::MixedReset => "--mixed",
                _ => "--hard",
            };
            merge::execute(run(
                git,
                root,
                &["reset", mode, "--no-recurse-submodules", target, "--"],
            )?)
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflogEntry {
    hash: String,
    selector: String,
    action: String,
    subject: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reflog {
    entries: Vec<ReflogEntry>,
    next_offset: Option<u32>,
}

fn reflog(git: &Path, root: &Path, offset: u32) -> WriteResult<Reflog> {
    merge::verify_worktree(git, root)?;
    let exists = run(git, root, &["reflog", "exists", "HEAD"])?;
    if exists.status.code() == Some(1) && exists.stderr.is_empty() {
        return Ok(Reflog {
            entries: Vec::new(),
            next_offset: None,
        });
    }
    merge::execute(exists)?;
    let skip = format!("--skip={offset}");
    let limit = format!("--max-count={}", super::PAGE_SIZE + 1);
    let bytes = git_bytes(
        git,
        root,
        &[
            "log",
            "-g",
            "-z",
            "--no-notes",
            "--no-show-signature",
            "--date=iso-strict",
            "--format=%H%x00%gD%x00%gs%x00%s",
            &skip,
            &limit,
            "HEAD",
            "--",
        ],
    )?;
    let content = String::from_utf8_lossy(&bytes);
    let fields = content.split_terminator('\0').collect::<Vec<_>>();
    let (entries, remainder) = fields.as_chunks::<4>();
    if !remainder.is_empty() {
        return Err(GitError::Unreadable.into());
    }
    Ok(Reflog {
        next_offset: (entries.len() > super::PAGE_SIZE)
            .then(|| offset.saturating_add(super::PAGE_SIZE as u32)),
        entries: entries
            .iter()
            .take(super::PAGE_SIZE)
            .map(|fields| ReflogEntry {
                hash: fields[0].into(),
                selector: fields[1].into(),
                action: fields[2].into(),
                subject: fields[3].into(),
            })
            .collect(),
    })
}

fn recover(git: &Path, root: &Path, target: &str, name: &str) -> WriteResult<()> {
    merge::verify_worktree(git, root)?;
    let target = local_commit(git, root, target)?;
    let reference = format!("refs/heads/{name}");
    if name.is_empty()
        || name.starts_with('-')
        || !run(git, root, &["check-ref-format", &reference])?
            .status
            .success()
    {
        return Err(WriteError::Failed(
            "Enter a valid local branch name.".into(),
        ));
    }
    merge::execute(run(
        git,
        root,
        &["branch", "--no-track", "--", name, &target],
    )?)
}

pub(super) async fn write<T: Send + 'static>(
    root: String,
    task: impl FnOnce(&Path, &Path) -> WriteResult<T> + Send + 'static,
) -> WriteResult<T> {
    tauri::async_runtime::spawn_blocking(move || task(&executable()?, directory(&root)?))
        .await
        .map_err(|error| WriteError::Failed(error.to_string()))?
}

#[tauri::command]
pub async fn git_history_plan(
    root: String,
    action: HistoryAction,
    target: String,
    parent: Option<usize>,
) -> WriteResult<HistoryPlan> {
    write(root, move |git, root| {
        review(git, root, action, &target, parent)
    })
    .await
}

#[tauri::command]
pub async fn git_edit_history(root: String, review: HistoryReview) -> WriteResult<()> {
    write(root, move |git, root| apply(git, root, &review)).await
}

#[tauri::command]
pub async fn git_reflog(root: String, offset: u32) -> WriteResult<Reflog> {
    write(root, move |git, root| reflog(git, root, offset)).await
}

#[tauri::command]
pub async fn git_recover_commit(root: String, target: String, name: String) -> WriteResult<()> {
    write(root, move |git, root| recover(git, root, &target, &name)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn replays_commits_and_recovers_an_unreachable_tip() {
        let git = executable().unwrap();
        let store = tempfile::tempdir().unwrap();
        let source = store.path().join("source");
        fs::create_dir(&source).unwrap();
        let cli = |args: &[&str]| super::super::tests::git(&source, args);
        cli(&["init", "-b", "main"]);
        cli(&["config", "user.name", "Fixture"]);
        cli(&["config", "user.email", "fixture@example.invalid"]);
        cli(&["config", "commit.gpgsign", "false"]);
        cli(&["commit", "--allow-empty", "-m", "Base"]);
        let base = cli(&["rev-parse", "HEAD"]);
        cli(&["switch", "-c", "topic"]);
        fs::write(source.join("topic.txt"), "topic").unwrap();
        cli(&["add", "--", "topic.txt"]);
        cli(&["commit", "-m", "Topic"]);
        let topic = cli(&["rev-parse", "HEAD"]);
        cli(&["switch", "main"]);
        let pick = review(&git, &source, HistoryAction::CherryPick, &topic, None).unwrap();
        apply(&git, &source, &pick.review).unwrap();
        assert_eq!(
            fs::read_to_string(source.join("topic.txt")).unwrap(),
            "topic"
        );
        let picked = cli(&["rev-parse", "HEAD"]);
        let revert = review(&git, &source, HistoryAction::Revert, &picked, None).unwrap();
        apply(&git, &source, &revert.review).unwrap();
        assert!(!source.join("topic.txt").exists());
        let reverted = cli(&["rev-parse", "HEAD"]);
        let reset = review(&git, &source, HistoryAction::SoftReset, &base, None).unwrap();
        apply(&git, &source, &reset.review).unwrap();
        assert_eq!(cli(&["rev-parse", "HEAD"]), base);
        let entries = reflog(&git, &source, 0).unwrap();
        assert!(entries.entries.iter().any(|entry| entry.hash == reverted));
        recover(&git, &source, &reverted, "rescued").unwrap();
        assert_eq!(cli(&["rev-parse", "rescued"]), reverted);
    }

    #[test]
    fn checks_worktree_contents_before_hard_reset() {
        let git = executable().unwrap();
        let store = tempfile::tempdir().unwrap();
        let source = store.path().join("source");
        let linked = store.path().join("linked");
        fs::create_dir(&source).unwrap();
        let cli = |args: &[&str]| super::super::tests::git(&source, args);
        let worktree = |args: &[&str]| super::super::tests::git(&linked, args);
        cli(&["init", "-b", "main"]);
        cli(&["config", "user.name", "Fixture"]);
        cli(&["config", "user.email", "fixture@example.invalid"]);
        cli(&["config", "commit.gpgsign", "false"]);
        fs::write(source.join("tracked.txt"), "base").unwrap();
        fs::write(source.join("original.txt"), "keep").unwrap();
        cli(&["add", "."]);
        cli(&["commit", "-m", "Base"]);
        let base = cli(&["rev-parse", "HEAD"]);
        cli(&["worktree", "add", "-b", "topic", linked.to_str().unwrap()]);
        worktree(&["rm", "original.txt"]);
        worktree(&["commit", "-m", "Remove original"]);
        let topic = worktree(&["rev-parse", "HEAD"]);
        fs::write(linked.join("tracked.txt"), "review me").unwrap();
        let reset = review(&git, &linked, HistoryAction::HardReset, &base, None).unwrap();
        fs::write(linked.join("tracked.txt"), "newer edit").unwrap();
        assert!(matches!(
            apply(&git, &linked, &reset.review),
            Err(WriteError::Stale)
        ));
        fs::write(linked.join("original.txt"), "untracked collision").unwrap();
        assert!(matches!(
            review(&git, &linked, HistoryAction::HardReset, &base, None),
            Err(WriteError::Failed(_))
        ));
        assert_eq!(
            fs::read_to_string(linked.join("original.txt")).unwrap(),
            "untracked collision"
        );
        fs::rename(linked.join("original.txt"), linked.join("saved.txt")).unwrap();
        let mixed = review(&git, &linked, HistoryAction::MixedReset, &base, None).unwrap();
        apply(&git, &linked, &mixed.review).unwrap();
        assert_eq!(
            fs::read_to_string(linked.join("tracked.txt")).unwrap(),
            "newer edit"
        );
        let reset = review(&git, &linked, HistoryAction::HardReset, &base, None).unwrap();
        apply(&git, &linked, &reset.review).unwrap();
        assert_eq!(
            fs::read_to_string(linked.join("tracked.txt")).unwrap(),
            "base"
        );
        assert_eq!(
            fs::read_to_string(linked.join("saved.txt")).unwrap(),
            "untracked collision"
        );
        assert_ne!(worktree(&["rev-parse", "HEAD"]), topic);
        assert_eq!(cli(&["rev-parse", "HEAD"]), base);
    }
}
