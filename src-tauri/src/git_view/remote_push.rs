use super::{command, history_edits, line, merge, oid, repository, run, success, writes, GitError};
use serde::{Deserialize, Serialize};
use std::{path::Path, process::Output};
use writes::WriteError;

type WriteResult<T> = std::result::Result<T, WriteError>;

#[derive(Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushReview {
    head: String,
    head_ref: String,
    remote: String,
    destination: String,
    expected: String,
    url: String,
    url_digest: [u8; 32],
}

fn remotes(git: &Path, root: &Path) -> WriteResult<Vec<String>> {
    merge::verify_worktree(git, root)?;
    let raw = line(success(run(git, root, &["remote"])?)?)?;
    Ok(raw.lines().map(str::to_owned).collect())
}

fn push_url(git: &Path, root: &Path, remote: &str) -> WriteResult<String> {
    if remote.starts_with('-') || !remotes(git, root)?.iter().any(|item| item == remote) {
        return Err(WriteError::Stale);
    }
    let urls = line(success(run(
        git,
        root,
        &["remote", "get-url", "--push", "--all", remote],
    )?)?)?;
    let mut urls = urls.lines();
    let url = urls
        .next()
        .filter(|url| !url.is_empty())
        .ok_or(GitError::Unreadable)?;
    if urls.next().is_some() {
        return Err(WriteError::Failed(
            "Select a remote with exactly one push URL.".into(),
        ));
    }
    Ok(url.to_owned())
}

fn display_url(url: &str) -> String {
    let Ok(mut parsed) = reqwest::Url::parse(url) else {
        return url.to_owned();
    };
    if parsed.has_host() && parsed.scheme() != "ssh" {
        let _ = parsed.set_username("");
    }
    let _ = parsed.set_password(None);
    parsed.set_query(None);
    parsed.set_fragment(None);
    parsed.into()
}

fn network(git: &Path, root: &Path, args: &[&str], url: &str) -> WriteResult<Output> {
    let mut result = command(git, root, args)
        .env("GIT_ALLOW_PROTOCOL", "file:git:http:https:ssh")
        .output()?;
    if !result.status.success() {
        result.stderr = String::from_utf8_lossy(&result.stderr)
            .replace(url, &display_url(url))
            .into_bytes();
    }
    Ok(result)
}

fn review(git: &Path, root: &Path, remote: &str, branch: &str) -> WriteResult<PushReview> {
    let repo = repository(git, root)?;
    let head = repo.head.ok_or(WriteError::UnsupportedChange)?;
    let head_ref = repo.head_ref.ok_or(WriteError::Detached)?;
    writes::verify_branch_head(git, root, Some(&head_ref), Some(&head))?;
    let destination = format!("refs/heads/{branch}");
    if !run(git, root, &["check-ref-format", &destination])?
        .status
        .success()
    {
        return Err(WriteError::Failed(
            "Enter a valid destination branch name.".into(),
        ));
    }
    let url = push_url(git, root, remote)?;
    let output = network(
        git,
        root,
        &[
            "ls-remote",
            "--exit-code",
            "--refs",
            "--",
            &url,
            &destination,
        ],
        &url,
    )?;
    if output.status.code() == Some(2) {
        return Err(WriteError::Failed(
            "The destination branch does not exist on this remote.".into(),
        ));
    }
    let bytes = output.stdout.clone();
    merge::execute(output)?;
    let data = line(bytes)?;
    let (expected, actual_ref) = data.split_once('\t').ok_or(GitError::Unreadable)?;
    if actual_ref != destination {
        return Err(WriteError::Stale);
    }
    Ok(PushReview {
        head,
        head_ref,
        remote: remote.into(),
        destination,
        expected: oid(expected)?.into(),
        url: display_url(&url),
        url_digest: url_digest(&url)?,
    })
}

fn url_digest(url: &str) -> WriteResult<[u8; 32]> {
    Ok(ring::digest::digest(&ring::digest::SHA256, url.as_bytes())
        .as_ref()
        .try_into()
        .map_err(|_| GitError::Unreadable)?)
}

fn push(git: &Path, root: &Path, reviewed: &PushReview) -> WriteResult<()> {
    writes::verify_branch_head(git, root, Some(&reviewed.head_ref), Some(&reviewed.head))?;
    let url = push_url(git, root, &reviewed.remote)?;
    if reviewed.url_digest != url_digest(&url)? || reviewed.url != display_url(&url) {
        return Err(WriteError::Stale);
    }
    if !reviewed.destination.starts_with("refs/heads/")
        || !run(git, root, &["check-ref-format", &reviewed.destination])?
            .status
            .success()
    {
        return Err(WriteError::UnsupportedChange);
    }
    let lease = format!(
        "--force-with-lease={}:{}",
        reviewed.destination,
        oid(&reviewed.expected)?
    );
    let refspec = format!("{}:{}", oid(&reviewed.head)?, reviewed.destination);
    let result = network(
        git,
        root,
        &["push", "--porcelain", &lease, "--", &url, &refspec],
        &url,
    )?;
    if !result.status.success() && String::from_utf8_lossy(&result.stdout).contains("(stale info)")
    {
        return Err(WriteError::Stale);
    }
    merge::execute(result)
}

#[tauri::command]
pub async fn git_push_remotes(root: String) -> WriteResult<Vec<String>> {
    history_edits::write(root, remotes).await
}

#[tauri::command]
pub async fn git_push_lease_plan(
    root: String,
    remote: String,
    branch: String,
) -> WriteResult<PushReview> {
    history_edits::write(root, move |git, root| review(git, root, &remote, &branch)).await
}

#[tauri::command]
pub async fn git_push_with_lease(root: String, review: PushReview) -> WriteResult<()> {
    history_edits::write(root, move |git, root| push(git, root, &review)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn refuses_a_changed_lease_and_pushes_to_the_reviewed_branch() {
        let git = super::super::executable().unwrap();
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("local");
        let bare = fixture.path().join("remote.git");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&bare).unwrap();
        let cli = |args: &[&str]| super::super::tests::git(&root, args);
        let remote = |args: &[&str]| super::super::tests::git(&bare, args);
        remote(&["init", "--bare", "-b", "main"]);
        cli(&["init", "-b", "main"]);
        cli(&["config", "user.name", "Fixture"]);
        cli(&["config", "user.email", "fixture@example.invalid"]);
        cli(&["config", "commit.gpgsign", "false"]);
        cli(&["remote", "add", "fixture", bare.to_str().unwrap()]);
        cli(&["commit", "--allow-empty", "-m", "First"]);
        let first = cli(&["rev-parse", "HEAD"]);
        merge::execute(
            network(
                &git,
                &root,
                &["push", "fixture", "main"],
                bare.to_str().unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        cli(&["commit", "--allow-empty", "-m", "Second"]);
        let second = cli(&["rev-parse", "HEAD"]);
        let lease = review(&git, &root, "fixture", "main").unwrap();
        assert_eq!(lease.expected, first);
        remote(&["branch", "side", &first]);
        let tree = cli(&["rev-parse", "HEAD^{tree}"]);
        let remote_tip = cli(&[
            "commit-tree",
            &tree,
            "-p",
            &first,
            "-m",
            "Other contributor",
        ]);
        merge::execute(
            network(
                &git,
                &root,
                &["push", "fixture", &format!("{remote_tip}:refs/heads/main")],
                bare.to_str().unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(matches!(push(&git, &root, &lease), Err(WriteError::Stale)));
        assert_eq!(remote(&["rev-parse", "refs/heads/main"]), remote_tip);
        let advance = review(&git, &root, "fixture", "main").unwrap();
        push(&git, &root, &advance).unwrap();
        assert_eq!(remote(&["rev-parse", "refs/heads/main"]), second);
        assert_eq!(remote(&["rev-parse", "refs/heads/side"]), first);
    }
}
