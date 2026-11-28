use super::{
    bounded, directory, executable, history_range, line, oid, parse_changes, query, relative_file,
    run, success, text_patch, Change, GitError, History, Result, PATCH_LIMIT, STATUS_LIMIT,
};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    base: String,
    target: String,
    base_only: History,
    target_only: History,
    changes: Vec<Change>,
}

#[derive(Serialize)]
pub struct RevisionDiff {
    patch: Option<String>,
    fallback: Option<&'static str>,
}

pub(super) fn resolve_commit(git: &Path, root: &Path, revision: &str) -> Result<String> {
    if ["refs/tags/", "refs/heads/", "refs/remotes/"]
        .iter()
        .any(|prefix| revision.starts_with(prefix))
    {
        if !run(git, root, &["check-ref-format", revision])?
            .status
            .success()
        {
            return Err(GitError::MissingObject);
        }
    } else {
        oid(revision)?;
    }
    // Request an exact commit, peeling an annotated tag without following any remote.
    let output = run(
        git,
        root,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{revision}^{{commit}}"),
        ],
    )?;
    if !output.status.success() {
        return Err(GitError::MissingObject);
    }
    let commit = line(success(output)?)?;
    oid(&commit)?;
    Ok(commit)
}

fn compare(git: &Path, root: &Path, base: &str, target: &str) -> Result<Comparison> {
    let base = resolve_commit(git, root, base)?;
    let target = resolve_commit(git, root, target)?;
    let changes = bounded(
        git,
        root,
        &[
            "diff",
            "--name-status",
            "-z",
            "--no-ext-diff",
            "--no-textconv",
            "--no-relative",
            "--find-renames",
            "--ignore-submodules=none",
            &base,
            &target,
            "--",
        ],
        STATUS_LIMIT,
    )?
    .ok_or(GitError::Unreadable)?;
    Ok(Comparison {
        base_only: unique_history(git, root, &base, &target, 0)?,
        target_only: unique_history(git, root, &target, &base, 0)?,
        base,
        target,
        changes: parse_changes(&changes)?,
    })
}

fn unique_history(
    git: &Path,
    root: &Path,
    included: &str,
    excluded: &str,
    offset: u32,
) -> Result<History> {
    let included = oid(included)?;
    let excluded = oid(excluded)?;
    history_range(git, root, &format!("{excluded}..{included}"), offset)
}

fn revision_diff(
    git: &Path,
    root: &Path,
    base: Option<&str>,
    target: &str,
    path: &str,
    previous_path: Option<&str>,
    reverse: bool,
) -> Result<RevisionDiff> {
    relative_file(path)?;
    let mut args = vec!["--literal-pathspecs"];
    if base.is_some() {
        args.push("diff");
    } else {
        args.extend(["diff-tree", "--root", "-r", "--patch", "--no-commit-id"]);
    }
    args.extend([
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-relative",
        "--find-renames",
        "--ignore-submodules=none",
        "--submodule=short",
    ]);
    if reverse {
        args.push("-R");
    }
    if let Some(base) = base {
        args.push(oid(base)?);
    }
    args.extend([oid(target)?, "--", path]);
    if let Some(previous) = previous_path {
        relative_file(previous)?;
        args.push(previous);
    }
    let result = bounded(git, root, &args, PATCH_LIMIT)?
        .ok_or("oversized")
        .and_then(text_patch)
        .and_then(|patch| {
            if patch
                .lines()
                .any(|line| line.starts_with("Binary files ") && line.ends_with(" differ"))
            {
                Err("binary")
            } else if patch.is_empty() {
                Err("unsupported")
            } else {
                Ok(patch)
            }
        });
    Ok(match result {
        Ok(patch) => RevisionDiff {
            patch: Some(patch),
            fallback: None,
        },
        Err(reason) => RevisionDiff {
            patch: None,
            fallback: Some(reason),
        },
    })
}

#[tauri::command]
pub async fn git_compare_revisions(
    root: String,
    base: String,
    target: String,
) -> Result<Comparison> {
    query(move || compare(&executable()?, directory(&root)?, &base, &target)).await
}

#[tauri::command]
pub async fn git_revision_history(
    root: String,
    included: String,
    excluded: String,
    offset: u32,
) -> Result<History> {
    query(move || {
        unique_history(
            &executable()?,
            directory(&root)?,
            &included,
            &excluded,
            offset,
        )
    })
    .await
}

#[tauri::command]
pub async fn git_revision_diff(
    root: String,
    base: Option<String>,
    target: String,
    path: String,
    previous_path: Option<String>,
    reverse: Option<bool>,
) -> Result<RevisionDiff> {
    query(move || {
        revision_diff(
            &executable()?,
            directory(&root)?,
            base.as_deref(),
            &target,
            &path,
            previous_path.as_deref(),
            reverse.unwrap_or(false),
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_diverged_commits_without_changing_the_worktree() {
        let git = executable().unwrap();
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let run = |args: &[&str]| super::super::tests::git(root, args);
        run(&["init", "-b", "main"]);
        run(&["config", "user.name", "Fixture Author"]);
        run(&["config", "user.email", "fixture@example.invalid"]);
        run(&["config", "commit.gpgsign", "false"]);
        std::fs::write(root.join("shared.txt"), "shared\n").unwrap();
        run(&["add", "--", "shared.txt"]);
        run(&["commit", "-m", "Common"]);
        let initial = run(&["rev-parse", "HEAD"]);
        run(&["switch", "-c", "topic"]);
        std::fs::write(root.join("topic.txt"), "topic\n").unwrap();
        run(&["add", "--", "topic.txt"]);
        run(&["commit", "-m", "Topic"]);
        let target = run(&["rev-parse", "HEAD"]);
        run(&["tag", "-a", "topic-tag", "-m", "Fixture tag"]);
        run(&["switch", "main"]);
        std::fs::write(root.join("main.txt"), "main\n").unwrap();
        run(&["add", "--", "main.txt"]);
        run(&["commit", "-m", "Main"]);
        let base = run(&["rev-parse", "HEAD"]);
        std::fs::write(root.join("shared.txt"), "working\n").unwrap();
        let before = run(&["status", "--porcelain"]);

        let result = compare(&git, root, &base, "refs/tags/topic-tag").unwrap();
        assert_eq!(result.target, target);
        assert_eq!(result.base_only.commits[0].subject, "Main");
        assert_eq!(result.target_only.commits[0].subject, "Topic");
        assert_eq!(result.changes[0].path, "main.txt");
        assert_eq!(result.changes[0].status, 'D');
        assert_eq!(result.changes[1].path, "topic.txt");
        assert_eq!(result.changes[1].status, 'A');
        assert!(
            revision_diff(&git, root, Some(&base), &target, "topic.txt", None, false)
                .unwrap()
                .patch
                .unwrap()
                .contains("+topic")
        );
        assert!(
            revision_diff(&git, root, None, &initial, "shared.txt", None, false)
                .unwrap()
                .patch
                .unwrap()
                .contains("+shared")
        );
        assert!(
            revision_diff(&git, root, None, &initial, "shared.txt", None, true)
                .unwrap()
                .patch
                .unwrap()
                .contains("-shared")
        );
        assert!(
            revision_diff(&git, root, Some(&base), &target, "topic.txt", None, true)
                .unwrap()
                .patch
                .unwrap()
                .contains("-topic")
        );
        assert_eq!(run(&["status", "--porcelain"]), before);
        assert_eq!(run(&["rev-parse", "HEAD"]), base);
        let history = super::super::history_of(&git, root, &target, 0, Some("topic.txt")).unwrap();
        assert_eq!(history.commits[0].subject, "Topic");
        let blamed = super::super::blame(&git, root, &target, "topic.txt").unwrap();
        assert!(blamed.contains("Fixture Author"));
        assert!(blamed.ends_with("topic\n"));
    }
}
