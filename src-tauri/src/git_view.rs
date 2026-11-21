use std::{
    env, fs, io,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitError {
    MissingGit,
    NotRepository,
    Unreadable,
    MissingObject,
}

type Result<T> = std::result::Result<T, GitError>;
const PAGE_SIZE: usize = 50;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    root: String,
    name: String,
    head_ref: Option<String>,
    head: Option<String>,
    branches: Vec<Branch>,
}

#[derive(Serialize)]
struct Branch {
    reference: String,
    name: String,
    tip: String,
    remote: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    commits: Vec<Commit>,
    next_offset: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Commit {
    hash: String,
    short_hash: String,
    author: String,
    date: String,
    subject: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    message: String,
    merge: bool,
    changes: Vec<Change>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Change {
    status: char,
    path: String,
    previous_path: Option<String>,
}

fn executable() -> Result<PathBuf> {
    let path = env::var_os("PATH").unwrap_or_default();
    let mut locations: Vec<_> = env::split_paths(&path)
        .filter(|path| path.is_absolute())
        .collect();
    #[cfg(target_os = "macos")]
    locations.extend([
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
        "/usr/bin".into(),
    ]);
    #[cfg(target_os = "linux")]
    locations.push("/usr/bin".into());
    #[cfg(windows)]
    if let Some(program_files) = env::var_os("ProgramFiles") {
        locations.push(PathBuf::from(program_files).join("Git").join("cmd"));
    }
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    for directory in locations {
        let git = directory.join(name);
        if !git.is_file() {
            continue;
        }
        #[cfg(target_os = "macos")]
        if git == Path::new("/usr/bin/git")
            && env::var_os("DEVELOPER_DIR").is_none()
            && !Command::new("/usr/bin/xcode-select")
                .arg("-p")
                .output()
                .is_ok_and(|output| output.status.success())
        {
            continue;
        }
        return Ok(git);
    }
    Err(GitError::MissingGit)
}

fn run(git: &Path, path: &Path, args: &[&str]) -> Result<Output> {
    let mut command = Command::new(git);
    for (key, _) in env::vars_os() {
        if key
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            command.env_remove(key);
        }
    }
    command
        .current_dir(path)
        .env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_ALLOW_PROTOCOL", "")
        .env("GIT_TERMINAL_PROMPT", "0")
        .args([
            "--no-pager",
            "-c",
            "gc.auto=0",
            "-c",
            "core.fsmonitor=false",
        ])
        .args(args)
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    command.output().map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => GitError::MissingGit,
        _ => GitError::Unreadable,
    })
}

fn success(output: Output) -> Result<Vec<u8>> {
    if output.status.success() {
        return Ok(output.stdout);
    }
    let error = String::from_utf8_lossy(&output.stderr);
    if error.contains("not a git repository") || error.contains("must be run in a work tree") {
        Err(GitError::NotRepository)
    } else if [
        "bad object",
        "could not read",
        "missing",
        "unable to read tree",
        "invalid object",
        "bad tree object",
    ]
    .iter()
    .any(|message| error.contains(message))
    {
        Err(GitError::MissingObject)
    } else {
        Err(GitError::Unreadable)
    }
}

fn line(output: Vec<u8>) -> Result<String> {
    let output = String::from_utf8(output).map_err(|_| GitError::Unreadable)?;
    Ok(output
        .strip_suffix("\r\n")
        .or_else(|| output.strip_suffix('\n'))
        .unwrap_or(&output)
        .to_owned())
}

fn directory(path: &str) -> Result<&Path> {
    let path = crate::local::absolute(path).map_err(|_| GitError::Unreadable)?;
    if fs::metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
        Ok(path)
    } else {
        Err(GitError::Unreadable)
    }
}

fn oid(value: &str) -> Result<&str> {
    if matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(value)
    } else {
        Err(GitError::MissingObject)
    }
}

fn optional_line(output: Output) -> Result<Option<String>> {
    if output.status.code() == Some(1) && output.stderr.is_empty() {
        Ok(None)
    } else {
        line(success(output)?).map(Some)
    }
}

fn repository(git: &Path, path: &Path) -> Result<Repository> {
    let root = line(success(run(git, path, &["rev-parse", "--show-toplevel"])?)?)?;
    let path = directory(&root)?;
    let head_ref = optional_line(run(git, path, &["symbolic-ref", "--quiet", "HEAD"])?)?;
    let head = optional_line(run(
        git,
        path,
        &["rev-parse", "--verify", "--quiet", "HEAD"],
    )?)?;
    let refs = success(run(
        git,
        path,
        &[
            "for-each-ref",
            "--sort=refname",
            "--format=%(refname)%00%(objectname)%00%(symref)",
            "refs/heads/",
            "refs/remotes/",
        ],
    )?)?;
    let branches = String::from_utf8_lossy(&refs)
        .lines()
        .filter_map(|row| {
            let mut fields = row.split('\0');
            let reference = fields.next()?;
            let tip = oid(fields.next()?).ok()?;
            if !fields.next()?.is_empty() {
                return None;
            }
            let (name, remote) = if let Some(name) = reference.strip_prefix("refs/heads/") {
                (name, false)
            } else {
                (reference.strip_prefix("refs/remotes/")?, true)
            };
            Some(Branch {
                reference: reference.into(),
                name: name.into(),
                tip: tip.into(),
                remote,
            })
        })
        .collect();
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&root)
        .to_owned();
    Ok(Repository {
        root,
        name,
        head_ref,
        head,
        branches,
    })
}

fn history(git: &Path, path: &Path, tip: &str, offset: u32) -> Result<History> {
    let tip = oid(tip)?;
    let data = success(run(
        git,
        path,
        &[
            "log",
            "-z",
            "--date-order",
            "--no-color",
            "--no-decorate",
            "--no-notes",
            "--no-show-signature",
            "--format=%H%x00%h%x00%an%x00%aI%x00%s",
            &format!("--skip={offset}"),
            &format!("--max-count={}", PAGE_SIZE + 1),
            tip,
            "--",
        ],
    )?)?;
    let data = String::from_utf8_lossy(&data);
    let mut fields: Vec<_> = data.split('\0').collect();
    if fields.last() == Some(&"") {
        fields.pop();
    }
    let (records, remainder) = fields.as_chunks::<5>();
    if !remainder.is_empty() {
        return Err(GitError::Unreadable);
    }
    let next_offset =
        (records.len() > PAGE_SIZE).then_some(offset.saturating_add(PAGE_SIZE as u32));
    let commits = records
        .iter()
        .take(PAGE_SIZE)
        .map(|fields| Commit {
            hash: fields[0].into(),
            short_hash: fields[1].into(),
            author: fields[2].into(),
            date: fields[3].into(),
            subject: fields[4].into(),
        })
        .collect();
    Ok(History {
        commits,
        next_offset,
    })
}

fn details(git: &Path, path: &Path, hash: &str) -> Result<Details> {
    let hash = oid(hash)?;
    let header = success(run(
        git,
        path,
        &[
            "show",
            "--no-patch",
            "--no-notes",
            "--no-show-signature",
            "--no-color",
            "--format=%P%x00%B",
            hash,
            "--",
        ],
    )?)?;
    let header = String::from_utf8_lossy(&header);
    let (parents, message) = header.split_once('\0').ok_or(GitError::Unreadable)?;
    let mut parents = parents.split_whitespace();
    let parent = parents.next();
    let merge = parents.next().is_some();
    let mut args = vec![
        "diff-tree",
        "-r",
        "-z",
        "--no-commit-id",
        "--name-status",
        "--find-renames",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
    ];
    args.push(if let Some(parent) = parent {
        oid(parent)?
    } else {
        "--root"
    });
    args.extend([hash, "--"]);
    let changed = success(run(git, path, &args)?)?;
    let changed = String::from_utf8_lossy(&changed);
    let mut fields = changed.split_terminator('\0');
    let mut changes = Vec::new();
    while let Some(status) = fields.next() {
        let status = status.chars().next().ok_or(GitError::Unreadable)?;
        let path = fields.next().ok_or(GitError::Unreadable)?;
        let (path, previous_path) = if matches!(status, 'R' | 'C') {
            (
                fields.next().ok_or(GitError::Unreadable)?,
                Some(path.into()),
            )
        } else {
            (path, None)
        };
        changes.push(Change {
            status,
            path: path.into(),
            previous_path,
        });
    }
    Ok(Details {
        message: message.trim_end_matches('\n').into(),
        merge,
        changes,
    })
}

async fn query<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| GitError::Unreadable)?
}

#[tauri::command]
pub async fn git_repository(path: String) -> Result<Repository> {
    query(move || repository(&executable()?, directory(&path)?)).await
}

#[tauri::command]
pub async fn git_history(root: String, tip: String, offset: u32) -> Result<History> {
    query(move || history(&executable()?, directory(&root)?, &tip, offset)).await
}

#[tauri::command]
pub async fn git_details(root: String, hash: String) -> Result<Details> {
    query(move || details(&executable()?, directory(&root)?, &hash)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(repo: &Path, args: &[&str]) -> String {
        let output = run(&executable().unwrap(), repo, args).unwrap();
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        line(output.stdout).unwrap()
    }

    #[test]
    fn reads_pinned_history_merge_details_and_linked_worktrees() {
        let exe = executable().unwrap();
        let fixture = tempfile::tempdir().unwrap();
        let repo = fixture.path().join("repo ł with spaces");
        let sub = repo.join("folder ö");
        fs::create_dir_all(&sub).unwrap();
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Fixture Author"]);
        git(&repo, &["config", "user.email", "fixture@example.invalid"]);
        git(&repo, &["config", "commit.gpgsign", "false"]);
        assert!(repository(&exe, &sub).unwrap().head.is_none());
        fs::write(repo.join("deleted.txt"), "old").unwrap();
        fs::write(repo.join("modified.txt"), "old").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "Initial snapshot"]);
        let initial = git(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["switch", "-c", "topic"]);
        fs::remove_file(repo.join("deleted.txt")).unwrap();
        fs::write(repo.join("modified.txt"), "modified content").unwrap();
        fs::write(repo.join("added-ü.txt"), "new file").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-m", "Feature", "-m", "Full body"]);
        let topic = git(&repo, &["rev-parse", "HEAD"]);
        git(
            &repo,
            &["update-ref", "refs/remotes/origin/topic", &initial],
        );
        git(&repo, &["switch", "main"]);
        for _ in 0..PAGE_SIZE {
            git(&repo, &["commit", "--allow-empty", "-m", "Main history"]);
        }
        git(&repo, &["merge", "--no-ff", "topic", "-m", "Merge feature"]);
        let head = git(&repo, &["rev-parse", "HEAD"]);
        fs::write(repo.join("modified.txt"), "uncommitted").unwrap();
        let status = git(&repo, &["status", "--porcelain=v1"]);
        let index = fs::read(repo.join(".git/index")).unwrap();
        let discovered = repository(&exe, &sub).unwrap();
        assert_eq!(discovered.name, "repo ł with spaces");
        assert_eq!(discovered.head_ref.as_deref(), Some("refs/heads/main"));
        assert_eq!(discovered.head.as_deref(), Some(head.as_str()));
        assert!(discovered
            .branches
            .iter()
            .any(|branch| branch.reference == "refs/heads/topic" && branch.tip == topic));
        assert!(
            discovered
                .branches
                .iter()
                .any(|branch| branch.reference == "refs/remotes/origin/topic"
                    && branch.tip == initial)
        );
        let first = history(&exe, &repo, &head, 0).unwrap();
        assert_eq!(first.commits.len(), PAGE_SIZE);
        assert_eq!(first.commits[0].subject, "Merge feature");
        assert_eq!(first.commits[0].author, "Fixture Author");
        git(&repo, &["update-ref", "refs/heads/main", &topic]);
        let last = history(&exe, &repo, &head, first.next_offset.unwrap()).unwrap();
        assert!(last.next_offset.is_none());
        assert_eq!(last.commits.last().unwrap().subject, "Initial snapshot");
        git(&repo, &["update-ref", "refs/heads/main", &head]);
        assert!(details(&exe, &repo, &topic)
            .unwrap()
            .message
            .contains("Full body"));
        let merge = details(&exe, &repo, &head).unwrap();
        assert!(merge.merge);
        assert_eq!(
            merge
                .changes
                .iter()
                .map(|change| (change.status, change.path.as_str()))
                .collect::<Vec<_>>(),
            [
                ('A', "added-ü.txt"),
                ('D', "deleted.txt"),
                ('M', "modified.txt")
            ]
        );
        assert_eq!(fs::read(repo.join(".git/index")).unwrap(), index);
        assert_eq!(git(&repo, &["rev-parse", "HEAD"]), head);
        assert_eq!(git(&repo, &["status", "--porcelain=v1"]), status);
        let worktree = fixture.path().join("linked worktree");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "--detach",
                worktree.to_str().unwrap(),
                &topic,
            ],
        );
        let linked = repository(&exe, &worktree).unwrap();
        assert_eq!(linked.name, "linked worktree");
        assert!(linked.head_ref.is_none());
        assert_eq!(linked.head.as_deref(), Some(topic.as_str()));
        let shallow = fixture.path().join("shallow");
        let output = Command::new(&exe)
            .current_dir(fixture.path())
            .args([
                "clone",
                "--no-local",
                "--depth",
                "1",
                repo.to_str().unwrap(),
                shallow.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let history = history(&exe, &shallow, &head, 0).unwrap();
        assert_eq!(history.commits.len(), 1);
        assert!(history.next_offset.is_none());
    }

    #[test]
    fn distinguishes_missing_git_repository_and_objects() {
        let exe = executable().unwrap();
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path();
        assert!(matches!(
            repository(&exe, path),
            Err(GitError::NotRepository)
        ));
        assert!(matches!(
            repository(&path.join("missing-git"), path),
            Err(GitError::MissingGit)
        ));
        assert!(matches!(
            directory(path.join("missing-folder").to_str().unwrap()),
            Err(GitError::Unreadable)
        ));
        git(path, &["init", "-b", "main"]);
        git(path, &["config", "extensions.partialClone", "origin"]);
        git(path, &["config", "remote.origin.promisor", "true"]);
        git(
            path,
            &[
                "config",
                "remote.origin.url",
                "https://example.invalid/fixture",
            ],
        );
        assert!(matches!(
            history(&exe, path, &"1".repeat(40), 0),
            Err(GitError::MissingObject)
        ));
    }
}
