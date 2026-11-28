use std::{
    env, fs,
    io::{self, Read},
    path::{Component, Path, PathBuf},
    process::{Command, Output, Stdio},
};

use serde::{Deserialize, Serialize};

pub(crate) mod branches;
pub(crate) mod comparison;
pub(crate) mod file;
pub(crate) mod graph;
pub(crate) mod history_edits;
pub(crate) mod merge;
pub(crate) mod pane;
pub(crate) mod rebase;
pub(crate) mod remote_push;
pub(crate) mod stash;
pub(crate) mod sync;
pub(crate) mod workspace;
pub(crate) mod writes;

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
const STATUS_LIMIT: u64 = 8 * 1024 * 1024;
const PATCH_LIMIT: u64 = 512 * 1024;
const PATCH_LINES: usize = 4000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    root: String,
    name: String,
    head_ref: Option<String>,
    head: Option<String>,
    branches: Vec<Branch>,
    tags: Vec<Tag>,
}

#[derive(Serialize)]
struct Tag {
    reference: String,
    name: String,
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
    first_parent: Option<String>,
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

fn command(git: &Path, path: &Path, args: &[&str]) -> Command {
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
    command
}

fn process_error(error: io::Error) -> GitError {
    match error.kind() {
        io::ErrorKind::NotFound => GitError::MissingGit,
        _ => GitError::Unreadable,
    }
}

fn run(git: &Path, path: &Path, args: &[&str]) -> Result<Output> {
    command(git, path, args).output().map_err(process_error)
}

fn bounded(git: &Path, path: &Path, args: &[&str], limit: u64) -> Result<Option<Vec<u8>>> {
    bounded_command(command(git, path, args), limit)
}

fn bounded_command(mut command: Command, limit: u64) -> Result<Option<Vec<u8>>> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(process_error)?;
    let mut bytes = Vec::new();
    let read = child
        .stdout
        .take()
        .ok_or(GitError::Unreadable)?
        .take(limit + 1)
        .read_to_end(&mut bytes);
    let oversized = bytes.len() as u64 > limit;
    if oversized || read.is_err() {
        let _ = child.kill();
    }
    let status = child.wait().map_err(process_error)?;
    read.map_err(process_error)?;
    if oversized {
        Ok(None)
    } else if status.success() {
        Ok(Some(bytes))
    } else {
        Err(GitError::Unreadable)
    }
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

fn worktree_root(git: &Path, path: &Path) -> Result<String> {
    line(success(run(git, path, &["rev-parse", "--show-toplevel"])?)?)
}

fn repository(git: &Path, path: &Path) -> Result<Repository> {
    let root = worktree_root(git, path)?;
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
    let tags = bounded(
        git,
        path,
        &[
            "for-each-ref",
            "--sort=refname",
            "--format=%(refname)",
            "refs/tags/",
        ],
        STATUS_LIMIT,
    )?
    .ok_or(GitError::Unreadable)?;
    let tags = String::from_utf8_lossy(&tags)
        .lines()
        .filter_map(|reference| {
            Some(Tag {
                reference: reference.into(),
                name: reference.strip_prefix("refs/tags/")?.into(),
            })
        })
        .collect();
    Ok(Repository {
        root,
        name,
        head_ref,
        head,
        branches,
        tags,
    })
}

fn history(git: &Path, path: &Path, tip: &str, offset: u32) -> Result<History> {
    history_range(git, path, oid(tip)?, offset)
}

fn history_range(git: &Path, path: &Path, range: &str, offset: u32) -> Result<History> {
    history_of(git, path, range, offset, None)
}

fn history_of(
    git: &Path,
    path: &Path,
    range: &str,
    offset: u32,
    file: Option<&str>,
) -> Result<History> {
    let skip = format!("--skip={offset}");
    let limit = format!("--max-count={}", PAGE_SIZE + 1);
    let mut args = vec![
        "--literal-pathspecs",
        "log",
        "-z",
        "--date-order",
        "--no-color",
        "--no-decorate",
        "--no-notes",
        "--no-show-signature",
        "--format=%H%x00%h%x00%an%x00%aI%x00%s",
        &skip,
        &limit,
    ];
    if file.is_some() {
        args.push("--follow");
    }
    args.extend([range, "--"]);
    if let Some(file) = file {
        args.push(file);
    }
    let data = success(run(git, path, &args)?)?;
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
    let changes = parse_changes(&success(run(git, path, &args)?)?)?;
    Ok(Details {
        message: message.trim_end_matches('\n').into(),
        merge,
        first_parent: parent.map(str::to_owned),
        changes,
    })
}

fn parse_changes(changed: &[u8]) -> Result<Vec<Change>> {
    let changed = String::from_utf8_lossy(changed);
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
    Ok(changes)
}

async fn query<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| GitError::Unreadable)?
}

#[derive(Clone, Copy, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeGroup {
    Staged,
    Unstaged,
    Untracked,
}

#[derive(Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingChange {
    group: ChangeGroup,
    status: char,
    path: String,
    previous_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingDiff {
    working_path: Option<String>,
    working_text: bool,
    patch: Option<String>,
    fallback: Option<&'static str>,
    unborn: bool,
    versions: Option<file::WorkingVersions>,
}

const WORKING_STATUS_ARGS: &[&str] = &[
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--renames",
    "--ignore-submodules=none",
];

fn working_changes(git: &Path, root: &Path) -> Result<Vec<WorkingChange>> {
    let bytes =
        bounded(git, root, WORKING_STATUS_ARGS, STATUS_LIMIT)?.ok_or(GitError::Unreadable)?;
    parse_working_changes(bytes)
}

fn parse_working_changes(bytes: Vec<u8>) -> Result<Vec<WorkingChange>> {
    let status = String::from_utf8(bytes).map_err(|_| GitError::Unreadable)?;
    let mut records = status.split_terminator('\0');
    let mut changes = Vec::new();
    while let Some(record) = records.next() {
        let (flags, path) = record.split_at_checked(3).ok_or(GitError::Unreadable)?;
        let [index, worktree, b' '] = flags.as_bytes() else {
            return Err(GitError::Unreadable);
        };
        let previous_path = if matches!(index, b'R' | b'C') || matches!(worktree, b'R' | b'C') {
            Some(records.next().ok_or(GitError::Unreadable)?)
        } else {
            None
        };
        let mut push = |group, status| {
            changes.push(WorkingChange {
                group,
                status: char::from(status),
                path: path.into(),
                previous_path: matches!(status, b'R' | b'C')
                    .then_some(previous_path)
                    .flatten()
                    .map(str::to_owned),
            })
        };
        match &flags[..2] {
            "??" => push(ChangeGroup::Untracked, b'?'),
            "!!" => {}
            "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU" => push(ChangeGroup::Unstaged, b'U'),
            _ => {
                if *index != b' ' {
                    push(ChangeGroup::Staged, *index);
                }
                if *worktree != b' ' {
                    push(ChangeGroup::Unstaged, *worktree);
                }
            }
        }
    }
    Ok(changes)
}

fn relative_file(path: &str) -> Result<&Path> {
    let path = Path::new(path);
    if path.as_os_str().is_empty()
        || !path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(GitError::Unreadable);
    }
    Ok(path)
}

fn working_file(root: &Path, relative: &Path) -> Option<PathBuf> {
    let path = root.join(relative);
    let resolved = path.canonicalize().ok()?;
    let resolved_root = root.canonicalize().ok()?;
    let metadata = path.symlink_metadata().ok()?;
    (metadata.is_file() && resolved.starts_with(resolved_root)).then_some(path)
}

fn text_patch(bytes: Vec<u8>) -> std::result::Result<String, &'static str> {
    if bytes.contains(&0) {
        return Err("binary");
    }
    let text = String::from_utf8(bytes).map_err(|_| "binary")?;
    if text.lines().nth(PATCH_LINES).is_some() {
        return Err("oversized");
    }
    Ok(text)
}

fn working_diff(
    git: &Path,
    root: &Path,
    change: &WorkingChange,
    compare: bool,
) -> Result<WorkingDiff> {
    let relative = relative_file(&change.path)?;
    if let Some(previous) = &change.previous_path {
        relative_file(previous)?;
    }
    let working = working_file(root, relative);
    let working_path = working
        .as_ref()
        .filter(|_| change.status != 'D')
        .and_then(|path| path.to_str())
        .map(str::to_owned);
    let working_text = working_path.as_ref().is_some_and(|path| {
        fs::File::open(path).is_ok_and(|file| crate::desktop::decode_text(file).is_ok())
    });
    let head = if change.group == ChangeGroup::Staged {
        optional_line(run(
            git,
            root,
            &["rev-parse", "--verify", "--quiet", "HEAD"],
        )?)?
    } else {
        None
    };
    let unborn = change.group == ChangeGroup::Staged && head.is_none();
    let preview = if change.status == 'U' {
        Err("conflict")
    } else if change.group == ChangeGroup::Untracked {
        if let Some(path) = working {
            let mut bytes = Vec::new();
            fs::File::open(path)
                .and_then(|file| file.take(PATCH_LIMIT + 1).read_to_end(&mut bytes))
                .map_err(|_| GitError::Unreadable)?;
            if bytes.len() as u64 > PATCH_LIMIT {
                Err("oversized")
            } else {
                text_patch(bytes).map(|text| {
                    text.split_inclusive('\n')
                        .map(|line| format!("+{line}"))
                        .collect()
                })
            }
        } else {
            Err("unsupported")
        }
    } else if change.group == ChangeGroup::Unstaged
        && working
            .as_ref()
            .and_then(|path| path.metadata().ok())
            .is_some_and(|metadata| metadata.len() > PATCH_LIMIT)
    {
        Err("oversized")
    } else {
        let mut args = vec![
            "--literal-pathspecs",
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--no-relative",
            "--find-renames",
            "--ignore-submodules=none",
            "--submodule=short",
        ];
        if change.group == ChangeGroup::Staged {
            args.push("--cached");
        }
        args.extend(["--", &change.path]);
        if let Some(previous) = &change.previous_path {
            args.push(previous);
        }
        match bounded(git, root, &args, PATCH_LIMIT)? {
            Some(bytes) => text_patch(bytes).and_then(|patch| {
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
            }),
            None => Err("oversized"),
        }
    };
    let (patch, fallback) = match preview {
        Ok(patch) => (Some(patch), None),
        Err(reason) => (None, Some(reason)),
    };
    let versions = if compare && fallback.is_none() && change.status != 'T' {
        file::working_versions(git, root, change, head.as_deref()).ok()
    } else {
        None
    };
    Ok(WorkingDiff {
        working_path,
        working_text,
        patch,
        fallback,
        unborn,
        versions,
    })
}

#[tauri::command]
pub async fn git_working_changes(root: String) -> Result<Vec<WorkingChange>> {
    query(move || working_changes(&executable()?, directory(&root)?)).await
}

#[tauri::command]
pub async fn git_working_diff(
    root: String,
    change: WorkingChange,
    compare: Option<bool>,
) -> Result<WorkingDiff> {
    query(move || {
        working_diff(
            &executable()?,
            directory(&root)?,
            &change,
            compare.unwrap_or(false),
        )
    })
    .await
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

    pub(super) fn git(repo: &Path, args: &[&str]) -> String {
        let output = run(&executable().unwrap(), repo, args).unwrap();
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        line(output.stdout).unwrap()
    }

    #[test]
    fn separates_index_and_working_tree_without_modifying_either() {
        let exe = executable().unwrap();
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let path = "nested ł.txt";
        git(root, &["init", "-b", "main"]);
        git(root, &["config", "user.name", "Fixture Author"]);
        git(root, &["config", "user.email", "fixture@example.invalid"]);
        git(root, &["config", "commit.gpgsign", "false"]);
        fs::write(root.join(path), "first\n").unwrap();
        git(root, &["add", "--", path]);
        let initial = working_changes(&exe, root).unwrap();
        let added = working_diff(&exe, root, &initial[0], false).unwrap();
        assert!(added.unborn && added.patch.unwrap().contains("+first"));
        fs::write(root.join("move.txt"), "rename content\n").unwrap();
        fs::write(root.join("remove.txt"), "deleted content\n").unwrap();
        git(root, &["add", "--", "move.txt", "remove.txt"]);
        git(root, &["commit", "-m", "Initial"]);
        fs::write(root.join(path), "staged\n").unwrap();
        git(root, &["add", "--", path]);
        fs::write(root.join(path), "working\n").unwrap();
        fs::write(root.join(".gitignore"), "*.ignored\n").unwrap();
        fs::write(root.join("other.ignored"), "private\n").unwrap();
        fs::write(root.join("fresh.txt"), "new\n").unwrap();
        fs::write(root.join("binary"), [0, 1]).unwrap();
        git(root, &["mv", "move.txt", "moved ł.txt"]);
        fs::remove_file(root.join("remove.txt")).unwrap();
        fs::write(root.join("large.bin"), vec![b'a'; PATCH_LIMIT as usize + 1]).unwrap();
        let index = fs::read(root.join(".git/index")).unwrap();
        let changes = working_changes(&exe, root).unwrap();
        assert!(!changes.iter().any(|change| change.path == "other.ignored"));
        let diff = |group, name: &str| {
            let change = changes
                .iter()
                .find(|change| change.path == name && change.group == group)
                .unwrap();
            working_diff(&exe, root, change, false).unwrap()
        };
        let staged = diff(ChangeGroup::Staged, path);
        assert!(!staged.unborn && staged.working_path.is_some());
        assert!(staged.patch.unwrap().contains("+staged"));
        assert!(diff(ChangeGroup::Unstaged, path)
            .patch
            .unwrap()
            .contains("+working"));
        assert_eq!(
            diff(ChangeGroup::Untracked, "fresh.txt").patch.as_deref(),
            Some("+new\n")
        );
        assert_eq!(
            diff(ChangeGroup::Untracked, "binary").fallback,
            Some("binary")
        );
        assert_eq!(
            diff(ChangeGroup::Untracked, "large.bin").fallback,
            Some("oversized")
        );
        let deleted = diff(ChangeGroup::Unstaged, "remove.txt");
        assert!(deleted.working_path.is_none());
        assert!(deleted.patch.unwrap().contains("-deleted content"));
        let rename = changes
            .iter()
            .find(|change| change.path == "moved ł.txt")
            .unwrap();
        assert_eq!(rename.previous_path.as_deref(), Some("move.txt"));
        assert!(working_diff(&exe, root, rename, false)
            .unwrap()
            .patch
            .unwrap()
            .contains("rename from move.txt"));
        assert!(relative_file("../outside.txt").is_err());
        assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
        assert_eq!(fs::read_to_string(root.join(path)).unwrap(), "working\n");
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
