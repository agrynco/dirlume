use super::{
    bounded, command, history_edits, line, merge, oid, relative_file, repository, run, success,
    writes, GitError, STATUS_LIMIT,
};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, process::Output};
use writes::WriteError;

type WriteResult<T> = std::result::Result<T, WriteError>;

pub(super) fn transport(git: &Path, root: &Path, args: &[&str]) -> WriteResult<Output> {
    Ok(command(git, root, args)
        .env("GIT_ALLOW_PROTOCOL", "file:git:http:https:ssh")
        .output()?)
}

#[derive(Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    path: String,
    head: Option<String>,
    branch: Option<String>,
    bare: bool,
    locked: bool,
    prunable: bool,
    primary: bool,
}

fn worktrees(git: &Path, root: &Path) -> WriteResult<Vec<Worktree>> {
    merge::verify_worktree(git, root)?;
    let output = run(git, root, &["worktree", "list", "--porcelain", "-z"])?;
    let (data, separator) = if output.status.code() == Some(129) {
        (
            success(run(
                git,
                root,
                &[
                    "-c",
                    "core.quotePath=false",
                    "worktree",
                    "list",
                    "--porcelain",
                ],
            )?)?,
            '\n',
        )
    } else {
        (success(output)?, '\0')
    };
    if data.len() as u64 > STATUS_LIMIT {
        return Err(GitError::Unreadable.into());
    }
    let text = std::str::from_utf8(&data).map_err(|_| GitError::Unreadable)?;
    let end = format!("{separator}{separator}");
    text.split(&end)
        .filter(|record| !record.is_empty())
        .enumerate()
        .map(|(position, record)| {
            let mut entries = record.split_terminator(separator);
            let path = entries
                .next()
                .and_then(|line| line.strip_prefix("worktree "))
                .ok_or(GitError::Unreadable)?;
            let mut result = Worktree {
                path: path.into(),
                head: None,
                branch: None,
                bare: false,
                locked: false,
                prunable: false,
                primary: position == 0,
            };
            for entry in entries {
                if let Some(head) = entry.strip_prefix("HEAD ") {
                    result.head = Some(oid(head)?.into());
                } else if let Some(branch) = entry.strip_prefix("branch ") {
                    result.branch = Some(branch.into());
                } else if entry == "bare" {
                    result.bare = true;
                } else if entry == "locked" || entry.starts_with("locked ") {
                    result.locked = true;
                } else if entry == "prunable" || entry.starts_with("prunable ") {
                    result.prunable = true;
                }
            }
            Ok(result)
        })
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreate {
    destination: String,
    revision: String,
    expected_commit: String,
    branch: Option<String>,
    detach: bool,
}

fn create_worktree(git: &Path, root: &Path, review: &WorktreeCreate) -> WriteResult<()> {
    merge::verify_worktree(git, root)?;
    let destination = review.destination.trim();
    crate::local::absolute(destination)
        .map_err(|_| WriteError::Failed("Enter an absolute worktree path.".into()))?;
    let state = repository(git, root)?;
    let source = state
        .branches
        .iter()
        .find(|branch| branch.reference == review.revision);
    let source_oid = history_edits::local_commit(
        git,
        root,
        source.map_or(&review.revision, |branch| &branch.tip),
    )?;
    if source_oid != review.expected_commit {
        return Err(WriteError::Stale);
    }
    let mut args = vec!["worktree", "add"];
    let target = if let Some(name) = review.branch.as_deref() {
        if review.detach
            || name.is_empty()
            || name.starts_with('-')
            || !run(
                git,
                root,
                &["check-ref-format", &format!("refs/heads/{name}")],
            )?
            .status
            .success()
        {
            return Err(WriteError::Failed(
                "Enter a valid local branch name.".into(),
            ));
        }
        args.extend(["--no-track", "-b", name]);
        source_oid.as_str()
    } else if review.detach {
        args.push("--detach");
        &source_oid
    } else {
        source
            .filter(|branch| !branch.remote && !branch.name.starts_with('-'))
            .map(|branch| branch.name.as_str())
            .ok_or(WriteError::UnsupportedChange)?
    };
    args.extend(["--", destination, target]);
    merge::execute(run(git, root, &args)?)
}

fn remove_worktree(git: &Path, root: &Path, reviewed: &Worktree) -> WriteResult<()> {
    let actual = worktrees(git, root)?;
    let target = actual
        .iter()
        .find(|worktree| *worktree == reviewed)
        .ok_or(WriteError::Stale)?;
    if target.primary
        || target.locked
        || Path::new(&target.path).canonicalize().ok() == root.canonicalize().ok()
    {
        return Err(WriteError::UnsupportedChange);
    }
    merge::execute(run(git, root, &["worktree", "remove", "--", &target.path])?)
}

#[derive(Deserialize, PartialEq, Serialize)]
pub struct Submodule {
    path: String,
    status: char,
    head: String,
}

fn submodules(git: &Path, root: &Path) -> WriteResult<Vec<Submodule>> {
    merge::verify_worktree(git, root)?;
    if !root.join(".gitmodules").is_file() {
        return Ok(Vec::new());
    }
    let settings = run(
        git,
        root,
        &[
            "config",
            "--file",
            ".gitmodules",
            "-z",
            "--get-regexp",
            r"^submodule\..*\.path$",
        ],
    )?;
    if settings.status.code() == Some(1) && settings.stderr.is_empty() {
        return Ok(Vec::new());
    }
    let settings = String::from_utf8(success(settings)?).map_err(|_| GitError::Unreadable)?;
    settings
        .split_terminator('\0')
        .map(|record| {
            let (_, path) = record.split_once('\n').ok_or(GitError::Unreadable)?;
            relative_file(path)?;
            let report = line(success(run(
                git,
                root,
                &["--literal-pathspecs", "submodule", "status", "--", path],
            )?)?)?;
            let (status, visible) = report.split_at_checked(1).ok_or(GitError::Unreadable)?;
            let head = visible
                .split_whitespace()
                .next()
                .ok_or(GitError::Unreadable)?;
            Ok(Submodule {
                path: path.into(),
                status: status.chars().next().ok_or(GitError::Unreadable)?,
                head: oid(head)?.into(),
            })
        })
        .collect()
}

fn update_submodule(git: &Path, root: &Path, reviewed: &Submodule) -> WriteResult<()> {
    if !submodules(git, root)?.contains(reviewed) {
        return Err(WriteError::Stale);
    }
    merge::execute(transport(
        git,
        root,
        &[
            "--literal-pathspecs",
            "submodule",
            "update",
            "--init",
            "--recursive",
            "--checkout",
            "--",
            &reviewed.path,
        ],
    )?)
}

#[derive(Serialize)]
pub struct LfsState {
    installed: bool,
    version: Option<String>,
    status: Option<String>,
    remotes: Vec<String>,
}

fn lfs_state(git: &Path, root: &Path) -> WriteResult<LfsState> {
    merge::verify_worktree(git, root)?;
    let version = run(git, root, &["lfs", "version"])?;
    if !version.status.success() {
        return Ok(LfsState {
            installed: false,
            version: None,
            status: None,
            remotes: Vec::new(),
        });
    }
    let report = line(success(run(git, root, &["lfs", "status"])?)?)?;
    let remotes = line(success(run(git, root, &["remote"])?)?)?
        .lines()
        .map(str::to_owned)
        .collect();
    Ok(LfsState {
        installed: true,
        version: Some(line(version.stdout)?),
        status: Some(report),
        remotes,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LfsAction {
    Fetch,
    Pull,
    Push,
}

fn lfs_transfer(git: &Path, root: &Path, remote: &str, action: LfsAction) -> WriteResult<()> {
    let state = lfs_state(git, root)?;
    if !state.installed
        || remote.starts_with('-')
        || !state.remotes.iter().any(|name| name == remote)
    {
        return Err(WriteError::Stale);
    }
    let args = match action {
        LfsAction::Fetch => vec!["lfs", "fetch", remote],
        LfsAction::Pull => vec!["lfs", "pull", remote],
        LfsAction::Push => vec!["lfs", "push", remote, "HEAD"],
    };
    merge::execute(transport(git, root, &args)?)
}

#[derive(Deserialize, PartialEq, Serialize)]
pub struct BisectState {
    start: String,
    head: String,
    log: String,
    concluded: bool,
}

fn bisect_concluded(log: &str) -> bool {
    log.lines().any(|line| {
        line == "# only skipped commits left to test"
            || line
                .strip_prefix("# first ")
                .and_then(|result| result.split_once(" commit: ["))
                .and_then(|(_, object)| object.split_once(']'))
                .is_some_and(|(hash, _)| oid(hash).is_ok())
    })
}

fn bisect_state(git: &Path, root: &Path) -> WriteResult<Option<BisectState>> {
    merge::verify_worktree(git, root)?;
    let start = match fs::read_to_string(writes::git_path(git, root, "BISECT_START")?) {
        Ok(content) => content.trim_end().into(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let head = match super::optional_line(run(
        git,
        root,
        &["rev-parse", "--verify", "--quiet", "BISECT_HEAD"],
    )?)? {
        Some(head) => head,
        None => line(success(run(
            git,
            root,
            &["rev-parse", "--verify", "HEAD"],
        )?)?)?,
    };
    oid(&head)?;
    let log = bounded(git, root, &["bisect", "log"], STATUS_LIMIT)?.ok_or(GitError::Unreadable)?;
    let log = String::from_utf8_lossy(&log).into_owned();
    let concluded = bisect_concluded(&log);
    Ok(Some(BisectState {
        start,
        head,
        log,
        concluded,
    }))
}

fn start_bisect(
    git: &Path,
    root: &Path,
    expected_ref: Option<&str>,
    expected_head: &str,
    good: &str,
    bad: &str,
) -> WriteResult<()> {
    writes::verify_branch_head(git, root, expected_ref, Some(expected_head))?;
    let good = history_edits::local_commit(git, root, good)?;
    let bad = history_edits::local_commit(git, root, bad)?;
    if good == bad {
        return Err(WriteError::Failed(
            "Choose different good and bad commits.".into(),
        ));
    }
    merge::execute(run(git, root, &["bisect", "start", &bad, &good, "--"])?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BisectAction {
    Good,
    Bad,
    Skip,
    Reset,
}

fn update_bisect(
    git: &Path,
    root: &Path,
    review: &BisectState,
    action: BisectAction,
) -> WriteResult<()> {
    if bisect_state(git, root)?.as_ref() != Some(review) {
        return Err(WriteError::Stale);
    }
    let verb = match action {
        BisectAction::Good => "good",
        BisectAction::Bad => "bad",
        BisectAction::Skip => "skip",
        BisectAction::Reset => "reset",
    };
    if review.concluded && !matches!(action, BisectAction::Reset) {
        return Err(WriteError::UnsupportedChange);
    }
    let output = run(git, root, &["bisect", verb])?;
    if !output.status.success()
        && !matches!(action, BisectAction::Reset)
        && bisect_state(git, root)?.is_some_and(|state| state.concluded)
    {
        return Ok(());
    }
    merge::execute(output)
}

#[tauri::command]
pub async fn git_worktrees(root: String) -> WriteResult<Vec<Worktree>> {
    history_edits::write(root, worktrees).await
}

#[tauri::command]
pub async fn git_create_worktree(root: String, review: WorktreeCreate) -> WriteResult<()> {
    history_edits::write(root, move |git, root| create_worktree(git, root, &review)).await
}

#[tauri::command]
pub async fn git_remove_worktree(root: String, review: Worktree) -> WriteResult<()> {
    history_edits::write(root, move |git, root| remove_worktree(git, root, &review)).await
}

#[tauri::command]
pub async fn git_submodules(root: String) -> WriteResult<Vec<Submodule>> {
    history_edits::write(root, submodules).await
}

#[tauri::command]
pub async fn git_update_submodule(root: String, review: Submodule) -> WriteResult<()> {
    history_edits::write(root, move |git, root| update_submodule(git, root, &review)).await
}

#[tauri::command]
pub async fn git_lfs_state(root: String) -> WriteResult<LfsState> {
    history_edits::write(root, lfs_state).await
}

#[tauri::command]
pub async fn git_lfs_transfer(root: String, remote: String, action: LfsAction) -> WriteResult<()> {
    history_edits::write(root, move |git, root| {
        lfs_transfer(git, root, &remote, action)
    })
    .await
}

#[tauri::command]
pub async fn git_bisect_state(root: String) -> WriteResult<Option<BisectState>> {
    history_edits::write(root, bisect_state).await
}

#[tauri::command]
pub async fn git_start_bisect(
    root: String,
    expected_ref: Option<String>,
    expected_head: String,
    good: String,
    bad: String,
) -> WriteResult<()> {
    history_edits::write(root, move |git, root| {
        start_bisect(
            git,
            root,
            expected_ref.as_deref(),
            &expected_head,
            &good,
            &bad,
        )
    })
    .await
}

#[tauri::command]
pub async fn git_update_bisect(
    root: String,
    review: BisectState,
    action: BisectAction,
) -> WriteResult<()> {
    history_edits::write(root, move |git, root| {
        update_bisect(git, root, &review, action)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_bisect_results_with_quoted_and_custom_terms() {
        let hash = "a".repeat(40);
        for term in ["bad", "'bad'", "'broken'"] {
            assert!(bisect_concluded(&format!(
                "# first {term} commit: [{hash}] Fixture"
            )));
        }
        assert!(bisect_concluded("# only skipped commits left to test"));
        assert!(!bisect_concluded(&format!(
            "# bad: [{hash}] first bad commit"
        )));
        assert!(!bisect_concluded("# first bad commit: [missing]"));
    }

    fn initialize(root: &Path) {
        let cli = |args: &[&str]| super::super::tests::git(root, args);
        cli(&["init", "--initial-branch=main"]);
        cli(&["config", "user.name", "Fixture"]);
        cli(&["config", "user.email", "fixture@example.invalid"]);
        cli(&["config", "commit.gpgsign", "false"]);
        cli(&["config", "core.autocrlf", "false"]);
        fs::write(root.join("file.txt"), "base").unwrap();
        cli(&["add", "--", "file.txt"]);
        cli(&["commit", "-m", "Base"]);
    }

    #[test]
    fn creates_opens_and_removes_a_clean_linked_worktree() {
        let git = super::super::executable().unwrap();
        let store = tempfile::tempdir().unwrap();
        let root = store.path().join("primary");
        fs::create_dir(&root).unwrap();
        initialize(&root);
        let head = super::super::tests::git(&root, &["rev-parse", "HEAD"]);
        let linked = store.path().join("linked ł worktree");
        let request = WorktreeCreate {
            destination: linked.to_str().unwrap().into(),
            revision: "refs/heads/main".into(),
            expected_commit: head.clone(),
            branch: Some("topic".into()),
            detach: false,
        };
        create_worktree(&git, &root, &request).unwrap();
        let trees = worktrees(&git, &root).unwrap();
        assert_eq!(trees.len(), 2);
        assert!(trees[0].primary);
        assert_eq!(trees[1].branch.as_deref(), Some("refs/heads/topic"));
        assert_eq!(repository(&git, &linked).unwrap().head, Some(head));
        fs::write(linked.join("untracked.txt"), "keep me").unwrap();
        assert!(matches!(
            remove_worktree(&git, &root, &trees[1]),
            Err(WriteError::Failed(_))
        ));
        assert!(linked.join("untracked.txt").exists());
        fs::remove_file(linked.join("untracked.txt")).unwrap();
        remove_worktree(&git, &root, &trees[1]).unwrap();
        assert!(!linked.exists());
        assert_eq!(worktrees(&git, &root).unwrap().len(), 1);
    }

    #[test]
    fn initializes_a_selected_submodule_from_a_disposable_repository() {
        let git = super::super::executable().unwrap();
        let store = tempfile::tempdir().unwrap();
        let root = store.path().join("main");
        let child = store.path().join("module");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&child).unwrap();
        initialize(&root);
        initialize(&child);
        let path = "modules/with space";
        merge::execute(
            transport(
                &git,
                &root,
                &["submodule", "add", "--", child.to_str().unwrap(), path],
            )
            .unwrap(),
        )
        .unwrap();
        super::super::tests::git(&root, &["commit", "-m", "Add module"]);
        super::super::tests::git(&root, &["submodule", "deinit", "--", path]);
        let modules = submodules(&git, &root).unwrap();
        assert_eq!(modules.len(), 1);
        assert_eq!(modules[0].path, path);
        assert_eq!(modules[0].status, '-');
        update_submodule(&git, &root, &modules[0]).unwrap();
        assert_eq!(
            fs::read_to_string(root.join(path).join("file.txt")).unwrap(),
            "base"
        );
        assert_eq!(submodules(&git, &root).unwrap()[0].status, ' ');
    }

    #[test]
    fn resumes_bisect_and_restores_the_original_branch() {
        let git = super::super::executable().unwrap();
        let store = tempfile::tempdir().unwrap();
        let root = store.path();
        initialize(root);
        let cli = |args: &[&str]| super::super::tests::git(root, args);
        let good = cli(&["rev-parse", "HEAD"]);
        let mut first_bad = String::new();
        for revision in 1..5 {
            fs::write(root.join("file.txt"), revision.to_string()).unwrap();
            cli(&["add", "--", "file.txt"]);
            cli(&["commit", "-m", &format!("Revision {revision}")]);
            if revision == 3 {
                first_bad = cli(&["rev-parse", "HEAD"]);
            }
        }
        let bad = cli(&["rev-parse", "HEAD"]);
        start_bisect(&git, root, Some("refs/heads/main"), &bad, &good, &bad).unwrap();
        for _ in 0..5 {
            let state = bisect_state(&git, root).unwrap().unwrap();
            if state.concluded {
                assert!(state.log.contains(&first_bad));
                update_bisect(&git, root, &state, BisectAction::Reset).unwrap();
                assert_eq!(cli(&["branch", "--show-current"]), "main");
                assert_eq!(cli(&["rev-parse", "HEAD"]), bad);
                assert!(bisect_state(&git, root).unwrap().is_none());
                return;
            }
            let revision: u32 = fs::read_to_string(root.join("file.txt"))
                .unwrap()
                .parse()
                .unwrap();
            let action = if revision < 3 {
                BisectAction::Good
            } else {
                BisectAction::Bad
            };
            update_bisect(&git, root, &state, action).unwrap();
        }
        panic!("Git did not finish the disposable bisect");
    }
}
