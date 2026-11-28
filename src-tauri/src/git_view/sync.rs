use super::{
    directory, executable, history_edits, line, merge, oid, optional_line, remote_push, repository,
    run, success, workspace, writes, GitError,
};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, process::Output};
use writes::WriteError;

type WriteResult<T> = std::result::Result<T, WriteError>;

fn redact(mut text: String, urls: &[String]) -> String {
    for url in urls {
        text = text.replace(url, &remote_push::display_url(url));
    }
    text
}

fn report(output: Output, urls: &[String]) -> WriteResult<String> {
    let status = output.status;
    let stdout = redact(String::from_utf8_lossy(&output.stdout).trim().into(), urls);
    let stderr = redact(String::from_utf8_lossy(&output.stderr).trim().into(), urls);
    let detail = [stdout, stderr]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if status.success() {
        return Ok(detail);
    }
    Err(WriteError::Failed(if detail.is_empty() {
        format!("Git exited with {status}.")
    } else {
        detail
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SetupAction {
    Clone,
    Init,
    Open,
}

fn url_input(value: &str) -> WriteResult<&str> {
    let value = value.trim();
    if value.is_empty() || value.starts_with('-') || value.contains(['\0', '\n', '\r']) {
        return Err(WriteError::Failed(
            "Enter a repository URL or local path.".into(),
        ));
    }
    Ok(value)
}

fn setup(git: &Path, action: SetupAction, path: &str, url: Option<&str>) -> WriteResult<String> {
    let path = path.trim();
    let target = crate::local::absolute(path)
        .map_err(|_| WriteError::Failed("Enter an absolute repository folder path.".into()))?;
    if matches!(action, SetupAction::Open) {
        return Ok(repository(git, directory(path)?)?.root);
    }
    let parent = target
        .ancestors()
        .find(|ancestor| ancestor.is_dir())
        .ok_or(GitError::Unreadable)?;
    if matches!(action, SetupAction::Clone) {
        if target.exists() && (!target.is_dir() || fs::read_dir(target)?.next().is_some()) {
            return Err(WriteError::Failed(
                "Choose an empty destination folder for the clone.".into(),
            ));
        }
        let url = url_input(url.unwrap_or_default())?;
        let output = workspace::transport(git, parent, &["clone", "--", url, path])?;
        if let Err(error) = report(output, &[url.into()]) {
            if target.join(".git").exists() {
                let WriteError::Failed(message) = error else {
                    return Err(error);
                };
                return Err(WriteError::PartialClone {
                    path: path.into(),
                    message,
                });
            }
            return Err(error);
        }
    } else {
        report(run(git, parent, &["init", "--", path])?, &[])?;
    }
    Ok(repository(git, directory(path)?)?.root)
}

#[derive(Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    name: String,
    fetch_urls: Vec<String>,
    push_urls: Vec<String>,
    stamp: [u8; 32],
}

fn urls(git: &Path, root: &Path, name: &str, push: bool) -> WriteResult<Vec<String>> {
    let mut args = vec!["remote", "get-url", "--all"];
    if push {
        args.push("--push");
    }
    args.push(name);
    let value = line(success(run(git, root, &args)?)?)?;
    Ok(value.lines().map(str::to_owned).collect())
}

fn remote(git: &Path, root: &Path, name: &str) -> WriteResult<(Remote, Vec<String>)> {
    let fetch = urls(git, root, name, false)?;
    let push = urls(git, root, name, true)?;
    let configuration = serde_json::to_vec(&(&fetch, &push)).map_err(|_| GitError::Unreadable)?;
    let stamp = ring::digest::digest(&ring::digest::SHA256, &configuration)
        .as_ref()
        .try_into()
        .map_err(|_| GitError::Unreadable)?;
    Ok((
        Remote {
            name: name.into(),
            fetch_urls: fetch
                .iter()
                .map(|value| remote_push::display_url(value))
                .collect(),
            push_urls: push
                .iter()
                .map(|value| remote_push::display_url(value))
                .collect(),
            stamp,
        },
        fetch.into_iter().chain(push).collect(),
    ))
}

fn remotes(git: &Path, root: &Path) -> WriteResult<Vec<Remote>> {
    remote_push::remotes(git, root)?
        .iter()
        .map(|name| remote(git, root, name).map(|(remote, _)| remote))
        .collect()
}

fn verify_remote(git: &Path, root: &Path, expected: &Remote) -> WriteResult<Vec<String>> {
    if expected.name.starts_with('-') || !remote_push::remotes(git, root)?.contains(&expected.name)
    {
        return Err(WriteError::Stale);
    }
    let (current, urls) = remote(git, root, &expected.name)?;
    if current != *expected {
        return Err(WriteError::Stale);
    }
    Ok(urls)
}

fn name_input<'a>(git: &Path, root: &Path, value: &'a str) -> WriteResult<&'a str> {
    let value = value.trim();
    if value.is_empty()
        || value.starts_with('-')
        || !run(
            git,
            root,
            &["check-ref-format", &format!("refs/remotes/{value}/HEAD")],
        )?
        .status
        .success()
    {
        return Err(WriteError::Failed("Enter a valid Git remote name.".into()));
    }
    Ok(value)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoteAction {
    Add,
    Rename,
    SetFetchUrl,
    SetPushUrl,
    ClearPushUrl,
    Remove,
}

fn configure(
    git: &Path,
    root: &Path,
    action: RemoteAction,
    reviewed: Option<&Remote>,
    value: &str,
    url: Option<&str>,
) -> WriteResult<()> {
    merge::verify_worktree(git, root)?;
    if matches!(action, RemoteAction::Add) {
        let name = name_input(git, root, value)?;
        let url = url_input(url.unwrap_or_default())?;
        report(
            run(git, root, &["remote", "add", "--", name, url])?,
            &[url.into()],
        )?;
        return Ok(());
    }
    let remote = reviewed.ok_or(WriteError::Stale)?;
    let mut urls = verify_remote(git, root, remote)?;
    let name = remote.name.as_str();
    let output = match action {
        RemoteAction::Rename => run(
            git,
            root,
            &[
                "remote",
                "rename",
                "--",
                name,
                name_input(git, root, value)?,
            ],
        )?,
        RemoteAction::Remove => run(git, root, &["remote", "remove", "--", name])?,
        RemoteAction::ClearPushUrl => {
            let key = format!("remote.{name}.pushurl");
            let output = run(git, root, &["config", "--local", "--unset-all", &key])?;
            if output.status.code() == Some(5) && output.stderr.is_empty() {
                return Ok(());
            }
            output
        }
        RemoteAction::SetFetchUrl | RemoteAction::SetPushUrl => {
            let value = url_input(url.unwrap_or_default())?;
            urls.push(value.into());
            let suffix = if matches!(action, RemoteAction::SetFetchUrl) {
                "url"
            } else {
                "pushurl"
            };
            let key = format!("remote.{name}.{suffix}");
            run(
                git,
                root,
                &["config", "--local", "--replace-all", &key, value],
            )?
        }
        RemoteAction::Add => unreachable!(),
    };
    report(output, &urls)?;
    Ok(())
}

fn fetch(git: &Path, root: &Path, remote: &Remote, prune: bool) -> WriteResult<String> {
    let urls = verify_remote(git, root, remote)?;
    let pruning = if prune { "--prune" } else { "--no-prune" };
    let args = ["fetch", pruning, "--no-prune-tags", "--", &remote.name];
    report(workspace::transport(git, root, &args)?, &urls)
}

#[derive(Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Upstream {
    head_ref: Option<String>,
    head: Option<String>,
    reference: Option<String>,
    remote: Option<String>,
    remote_ref: Option<String>,
    tip: Option<String>,
}

fn upstream(git: &Path, root: &Path) -> WriteResult<Upstream> {
    merge::verify_worktree(git, root)?;
    let repo = repository(git, root)?;
    let mut state = Upstream {
        head_ref: repo.head_ref,
        head: repo.head,
        reference: None,
        remote: None,
        remote_ref: None,
        tip: None,
    };
    let Some(reference) = state.head_ref.as_deref() else {
        return Ok(state);
    };
    let raw = line(success(run(
        git,
        root,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)",
            "--",
            reference,
        ],
    )?)?)?;
    for row in raw.lines() {
        let fields = row.split('\0').collect::<Vec<_>>();
        let [actual, tracked, remote, remote_ref] = fields.as_slice() else {
            return Err(GitError::Unreadable.into());
        };
        if *actual == reference && !tracked.is_empty() {
            state.reference = Some((*tracked).into());
            state.remote = (!remote.is_empty()).then(|| (*remote).into());
            state.remote_ref = (!remote_ref.is_empty()).then(|| (*remote_ref).into());
            state.tip = optional_line(run(
                git,
                root,
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    "--end-of-options",
                    tracked,
                ],
            )?)?;
            break;
        }
    }
    Ok(state)
}

fn set_upstream(
    git: &Path,
    root: &Path,
    expected: &Upstream,
    reference: Option<&str>,
) -> WriteResult<()> {
    if upstream(git, root)? != *expected {
        return Err(WriteError::Stale);
    }
    writes::verify_branch_head(
        git,
        root,
        expected.head_ref.as_deref(),
        expected.head.as_deref(),
    )?;
    if expected.head_ref.is_none() {
        return Err(WriteError::Detached);
    }
    let output = if let Some(reference) = reference {
        let repo = repository(git, root)?;
        if !repo
            .branches
            .iter()
            .any(|branch| branch.remote && branch.reference == reference)
        {
            return Err(WriteError::Stale);
        }
        run(
            git,
            root,
            &["branch", &format!("--set-upstream-to={reference}")],
        )?
    } else {
        run(git, root, &["branch", "--unset-upstream"])?
    };
    merge::execute(output)
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefReview {
    remote: Remote,
    push_url: String,
    source: Option<String>,
    object: Option<String>,
    destination: String,
    delete_tip: Option<String>,
}

fn ref_format(git: &Path, root: &Path, reference: &str) -> WriteResult<()> {
    if !reference.starts_with("refs/heads/") && !reference.starts_with("refs/tags/")
        || !run(git, root, &["check-ref-format", reference])?
            .status
            .success()
    {
        return Err(WriteError::Failed(
            "Enter a valid branch or tag reference.".into(),
        ));
    }
    Ok(())
}

fn local_ref(git: &Path, root: &Path, reference: &str) -> WriteResult<String> {
    ref_format(git, root, reference)?;
    let value = line(success(run(
        git,
        root,
        &["show-ref", "--verify", "--hash", "--", reference],
    )?)?)?;
    Ok(oid(&value)?.into())
}

fn review_ref(
    git: &Path,
    root: &Path,
    remote: Remote,
    source: Option<String>,
    destination: String,
) -> WriteResult<RefReview> {
    let urls = verify_remote(git, root, &remote)?;
    let push_url = remote_push::push_url(git, root, &remote.name)?;
    ref_format(git, root, &destination)?;
    let object = source
        .as_deref()
        .map(|source| local_ref(git, root, source))
        .transpose()?;
    let delete_tip = if source.is_none() {
        let output = workspace::transport(
            git,
            root,
            &[
                "ls-remote",
                "--exit-code",
                "--refs",
                "--",
                &push_url,
                &destination,
            ],
        )?;
        if output.status.code() == Some(2) {
            return Err(WriteError::Failed(
                "The remote reference no longer exists.".into(),
            ));
        }
        let data = line(output.stdout.clone())?;
        report(output, &urls)?;
        let (id, name) = data.split_once('\t').ok_or(GitError::Unreadable)?;
        if name != destination {
            return Err(WriteError::Stale);
        }
        Some(oid(id)?.into())
    } else {
        let source = source.as_deref().unwrap_or_default();
        if source.starts_with("refs/tags/") != destination.starts_with("refs/tags/") {
            return Err(WriteError::UnsupportedChange);
        }
        None
    };
    Ok(RefReview {
        remote,
        push_url: remote_push::display_url(&push_url),
        source,
        object,
        destination,
        delete_tip,
    })
}

fn transfer(git: &Path, root: &Path, reviewed: &RefReview) -> WriteResult<String> {
    let urls = verify_remote(git, root, &reviewed.remote)?;
    let name = reviewed.remote.name.as_str();
    let url = remote_push::push_url(git, root, name)?;
    if reviewed.push_url != remote_push::display_url(&url) {
        return Err(WriteError::Stale);
    }
    ref_format(git, root, &reviewed.destination)?;
    let mirror = format!("remote.{name}.mirror=false");
    let mut args = vec!["-c", &mirror, "push", "--porcelain", "--no-follow-tags"];
    let lease;
    let refspec = match (&reviewed.source, &reviewed.object, &reviewed.delete_tip) {
        (Some(source), Some(object), None) => {
            if local_ref(git, root, source)? != *object
                || source.starts_with("refs/tags/")
                    != reviewed.destination.starts_with("refs/tags/")
            {
                return Err(WriteError::Stale);
            }
            format!("{object}:{}", reviewed.destination)
        }
        (None, None, Some(expected)) => {
            lease = format!(
                "--force-with-lease={}:{}",
                reviewed.destination,
                oid(expected)?
            );
            args.push(&lease);
            format!(":{}", reviewed.destination)
        }
        _ => return Err(WriteError::UnsupportedChange),
    };
    args.extend(["--", name, &refspec]);
    let output = workspace::transport(git, root, &args)?;
    if !output.status.success() && String::from_utf8_lossy(&output.stdout).contains("(stale info)")
    {
        return Err(WriteError::Stale);
    }
    report(output, &urls)
}

#[tauri::command]
pub async fn git_repository_setup(
    action: SetupAction,
    path: String,
    url: Option<String>,
) -> WriteResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        setup(&executable()?, action, &path, url.as_deref())
    })
    .await
    .map_err(|error| WriteError::Failed(error.to_string()))?
}

#[tauri::command]
pub async fn git_remotes(root: String) -> WriteResult<Vec<Remote>> {
    history_edits::write(root, remotes).await
}

#[tauri::command]
pub async fn git_configure_remote(
    root: String,
    action: RemoteAction,
    remote: Option<Remote>,
    value: String,
    url: Option<String>,
) -> WriteResult<()> {
    history_edits::write(root, move |git, root| {
        configure(git, root, action, remote.as_ref(), &value, url.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn git_fetch_remote(root: String, remote: Remote, prune: bool) -> WriteResult<String> {
    history_edits::write(root, move |git, root| fetch(git, root, &remote, prune)).await
}

#[tauri::command]
pub async fn git_upstream(root: String) -> WriteResult<Upstream> {
    history_edits::write(root, upstream).await
}

#[tauri::command]
pub async fn git_set_upstream(
    root: String,
    expected: Upstream,
    reference: Option<String>,
) -> WriteResult<()> {
    history_edits::write(root, move |git, root| {
        set_upstream(git, root, &expected, reference.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn git_remote_ref_review(
    root: String,
    remote: Remote,
    source: Option<String>,
    destination: String,
) -> WriteResult<RefReview> {
    history_edits::write(root, move |git, root| {
        review_ref(git, root, remote, source, destination)
    })
    .await
}

#[tauri::command]
pub async fn git_transfer_remote_ref(root: String, review: RefReview) -> WriteResult<String> {
    history_edits::write(root, move |git, root| transfer(git, root, &review)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(git: &Path, root: &Path, name: &str) -> Remote {
        remote(git, root, name).unwrap().0
    }

    fn identify(root: &Path) {
        let cli = |args: &[&str]| super::super::tests::git(root, args);
        cli(&["config", "user.name", "Dirlume Fixture"]);
        cli(&["config", "user.email", "fixture@example.test"]);
        cli(&["config", "commit.gpgsign", "false"]);
    }

    #[test]
    fn initializes_clones_and_configures_multiple_remotes_without_touching_files() {
        let git = executable().unwrap();
        let store = tempfile::tempdir().unwrap();
        let root = store.path().join("local");
        let origin = store.path().join("one.git");
        let backup = store.path().join("two.git");
        let clone = store.path().join("clone");
        for path in [&root, &origin, &backup] {
            fs::create_dir(path).unwrap();
        }
        fs::write(root.join("note.txt"), "existing file").unwrap();
        let path = root.to_str().unwrap();
        setup(&git, SetupAction::Init, path, None).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("note.txt")).unwrap(),
            "existing file"
        );
        let state = upstream(&git, &root).unwrap();
        assert!(state.head_ref.is_some());
        assert!(state.head.is_none());
        identify(&root);
        let cli = |args: &[&str]| super::super::tests::git(&root, args);
        cli(&["symbolic-ref", "HEAD", "refs/heads/main"]);
        cli(&["add", "--", "note.txt"]);
        cli(&["commit", "-m", "Initial commit"]);
        for destination in [&origin, &backup] {
            super::super::tests::git(destination, &["init", "--bare", "--initial-branch=main"]);
        }
        configure(
            &git,
            &root,
            RemoteAction::Add,
            None,
            "origin",
            origin.to_str(),
        )
        .unwrap();
        configure(
            &git,
            &root,
            RemoteAction::Add,
            None,
            "second",
            backup.to_str(),
        )
        .unwrap();
        assert_eq!(remotes(&git, &root).unwrap().len(), 2);
        let second = get(&git, &root, "second");
        configure(
            &git,
            &root,
            RemoteAction::Rename,
            Some(&second),
            "backup",
            None,
        )
        .unwrap();
        let reviewed = get(&git, &root, "backup");
        configure(
            &git,
            &root,
            RemoteAction::SetPushUrl,
            Some(&reviewed),
            "",
            origin.to_str(),
        )
        .unwrap();
        let current = get(&git, &root, "backup");
        assert_ne!(current.fetch_urls, current.push_urls);
        assert!(matches!(
            configure(&git, &root, RemoteAction::Remove, Some(&reviewed), "", None),
            Err(WriteError::Stale)
        ));
        configure(
            &git,
            &root,
            RemoteAction::ClearPushUrl,
            Some(&current),
            "",
            None,
        )
        .unwrap();
        let current = get(&git, &root, "backup");
        assert_eq!(current.fetch_urls, current.push_urls);
        configure(
            &git,
            &root,
            RemoteAction::SetFetchUrl,
            Some(&current),
            "",
            origin.to_str(),
        )
        .unwrap();
        assert_eq!(
            get(&git, &root, "backup").fetch_urls,
            get(&git, &root, "origin").fetch_urls
        );
        let source = "refs/heads/main".to_string();
        let push = review_ref(
            &git,
            &root,
            get(&git, &root, "origin"),
            Some(source.clone()),
            source,
        )
        .unwrap();
        transfer(&git, &root, &push).unwrap();
        let result = setup(
            &git,
            SetupAction::Clone,
            clone.to_str().unwrap(),
            origin.to_str(),
        )
        .unwrap();
        assert_eq!(
            Path::new(&result).canonicalize().unwrap(),
            clone.canonicalize().unwrap()
        );
        assert_eq!(
            fs::read_to_string(clone.join("note.txt")).unwrap(),
            "existing file"
        );
        assert!(matches!(
            setup(
                &git,
                SetupAction::Clone,
                clone.to_str().unwrap(),
                origin.to_str()
            ),
            Err(WriteError::Failed(_))
        ));
        let opened = setup(&git, SetupAction::Open, clone.to_str().unwrap(), None).unwrap();
        assert_eq!(opened, result);
        cli(&["switch", "--detach", "HEAD"]);
        assert!(upstream(&git, &root).unwrap().head_ref.is_none());
    }

    #[test]
    fn fetches_prunes_and_checks_writes_to_the_reviewed_remote_refs() {
        let git = executable().unwrap();
        let store = tempfile::tempdir().unwrap();
        let root = store.path().join("local");
        let origin = store.path().join("origin.git");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&origin).unwrap();
        let local = |args: &[&str]| super::super::tests::git(&root, args);
        let remote_cli = |args: &[&str]| super::super::tests::git(&origin, args);
        local(&["init", "--initial-branch=main"]);
        remote_cli(&["init", "--bare", "--initial-branch=main"]);
        identify(&root);
        local(&["commit", "--allow-empty", "-m", "Initial"]);
        let base = local(&["rev-parse", "HEAD"]);
        configure(
            &git,
            &root,
            RemoteAction::Add,
            None,
            "origin",
            origin.to_str(),
        )
        .unwrap();
        let publish = |source: &str, destination: &str| {
            review_ref(
                &git,
                &root,
                get(&git, &root, "origin"),
                Some(source.into()),
                destination.into(),
            )
            .unwrap()
        };
        transfer(&git, &root, &publish("refs/heads/main", "refs/heads/main")).unwrap();
        remote_cli(&["branch", "outdated", &base]);
        fetch(&git, &root, &get(&git, &root, "origin"), false).unwrap();
        let state = upstream(&git, &root).unwrap();
        assert!(state.reference.is_none());
        set_upstream(&git, &root, &state, Some("refs/remotes/origin/main")).unwrap();
        let state = upstream(&git, &root).unwrap();
        assert_eq!(state.tip.as_deref(), Some(base.as_str()));
        assert_eq!(state.remote.as_deref(), Some("origin"));
        remote_cli(&["branch", "-d", "outdated"]);
        fetch(&git, &root, &get(&git, &root, "origin"), true).unwrap();
        assert!(!run(
            &git,
            &root,
            &["show-ref", "--verify", "refs/remotes/origin/outdated"]
        )
        .unwrap()
        .status
        .success());
        local(&["tag", "-m", "Fixture", "v1"]);
        let tag = publish("refs/tags/v1", "refs/tags/v1");
        transfer(&git, &root, &tag).unwrap();
        assert_eq!(
            remote_cli(&["rev-parse", "refs/tags/v1"]),
            local(&["rev-parse", "refs/tags/v1"])
        );
        transfer(
            &git,
            &root,
            &publish("refs/heads/main", "refs/heads/disposable"),
        )
        .unwrap();
        let delete = || {
            review_ref(
                &git,
                &root,
                get(&git, &root, "origin"),
                None,
                "refs/heads/disposable".into(),
            )
            .unwrap()
        };
        let old = delete();
        let tree = local(&["rev-parse", "HEAD^{tree}"]);
        let remote_tip = local(&["commit-tree", &tree, "-p", &base, "-m", "Other contributor"]);
        local(&["branch", "other", &remote_tip]);
        transfer(
            &git,
            &root,
            &publish("refs/heads/other", "refs/heads/disposable"),
        )
        .unwrap();
        assert!(matches!(
            transfer(&git, &root, &old),
            Err(WriteError::Stale)
        ));
        assert_eq!(
            remote_cli(&["rev-parse", "refs/heads/disposable"]),
            remote_tip
        );
        transfer(&git, &root, &delete()).unwrap();
        assert!(!run(
            &git,
            &origin,
            &["show-ref", "--verify", "refs/heads/disposable"]
        )
        .unwrap()
        .status
        .success());
        transfer(&git, &root, &publish("refs/heads/other", "refs/heads/main")).unwrap();
        local(&["commit", "--allow-empty", "-m", "Local diverged"]);
        assert!(
            matches!(transfer(&git, &root, &publish("refs/heads/main", "refs/heads/main")),
            Err(WriteError::Failed(message)) if message.contains("[rejected]"))
        );
        assert_eq!(remote_cli(&["rev-parse", "refs/heads/main"]), remote_tip);
    }
}
