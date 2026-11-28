use super::{
    bounded, comparison::resolve_commit, directory, executable, oid, optional_line, parse_changes,
    query, relative_file, run, text_patch, working_changes, working_file, worktree_root, Change,
    ChangeGroup, Commit, GitError, Result, WorkingChange, PAGE_SIZE, PATCH_LIMIT, STATUS_LIMIT,
};
use serde::Serialize;
use std::{fs::File, io::Read, path::Path};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistory {
    commits: Vec<FileCommit>,
    next_offset: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileCommit {
    #[serde(flatten)]
    commit: Commit,
    parent: Option<String>,
    merge: bool,
    change: Change,
}

pub(super) fn file_history(
    git: &Path,
    root: &Path,
    tip: &str,
    path: &str,
    offset: u32,
) -> Result<FileHistory> {
    relative_file(path)?;
    // Git's --skip skips rename detection as well as output, losing the old path on later pages.
    let limit = history_limit(offset);
    let data = bounded(
        git,
        root,
        &history_args(oid(tip)?, path, &limit),
        STATUS_LIMIT,
    )?
    .ok_or(GitError::Unreadable)?;
    parse_file_history(&data, offset)
}

pub(super) fn history_limit(offset: u32) -> String {
    format!(
        "--max-count={}",
        (offset as usize).saturating_add(PAGE_SIZE + 1)
    )
}

pub(super) fn history_args<'a>(tip: &'a str, path: &'a str, limit: &'a str) -> [&'a str; 17] {
    [
        "--literal-pathspecs",
        "log",
        "--follow",
        "--show-pulls",
        "--diff-merges=first-parent",
        "--date-order",
        "--no-color",
        "--no-decorate",
        "--no-notes",
        "--no-show-signature",
        "--name-status",
        "-z",
        "--format=%x00%H%x00%h%x00%an%x00%aI%x00%s%x00%P",
        limit,
        tip,
        "--",
        path,
    ]
}

pub(super) fn parse_file_history(data: &[u8], offset: u32) -> Result<FileHistory> {
    let offset = offset as usize;
    let data = String::from_utf8_lossy(data);
    let mut fields = data.split_terminator('\0');
    if fields.next().is_some_and(|marker| !marker.is_empty()) {
        return Err(GitError::Unreadable);
    }
    let mut records = 0;
    let mut commits = Vec::new();
    while let Some(hash) = fields.next() {
        if hash.is_empty() {
            continue;
        }
        oid(hash)?;
        let short_hash = fields.next().ok_or(GitError::Unreadable)?;
        let author = fields.next().ok_or(GitError::Unreadable)?;
        let date = fields.next().ok_or(GitError::Unreadable)?;
        let subject = fields.next().ok_or(GitError::Unreadable)?;
        let mut parents = fields
            .next()
            .ok_or(GitError::Unreadable)?
            .split_whitespace();
        let parent = parents.next().map(oid).transpose()?.map(str::to_owned);
        let merge = parents.next().is_some();
        records += 1;
        let changed = fields
            .by_ref()
            .take_while(|field| !field.is_empty())
            .collect::<Vec<_>>()
            .join("\0");
        if records <= offset || records > offset.saturating_add(PAGE_SIZE) || changed.is_empty() {
            continue;
        }
        let changes = parse_changes(changed.trim_start_matches('\n').as_bytes())?;
        if let Some(change) = changes.into_iter().next() {
            commits.push(FileCommit {
                commit: Commit {
                    hash: hash.into(),
                    short_hash: short_hash.into(),
                    author: author.into(),
                    date: date.into(),
                    subject: subject.into(),
                },
                parent,
                merge,
                change,
            });
        }
    }
    Ok(FileHistory {
        commits,
        next_offset: (records > offset.saturating_add(PAGE_SIZE))
            .then_some((offset as u32).saturating_add(PAGE_SIZE as u32)),
    })
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum FileContent {
    Available { text: String },
    Missing,
    Binary,
    Oversized,
}

#[derive(Serialize)]
pub struct FileRevision {
    revision: String,
    path: String,
    pub(super) content: FileContent,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BlameLine {
    number: u32,
    original: u32,
    hash: String,
    author: String,
    time: i64,
    path: String,
    text: String,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
enum BlameContent {
    Available { lines: Vec<BlameLine> },
    Empty,
    Missing,
    Binary,
    Oversized,
}

#[derive(Serialize)]
pub struct FileBlame {
    revision: String,
    path: String,
    content: BlameContent,
}

fn blame_path(value: &str) -> Result<String> {
    if let Some(value) = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
    {
        let mut bytes = value.bytes();
        let mut path = Vec::with_capacity(value.len());
        while let Some(byte) = bytes.next() {
            let output = if byte == b'\\' {
                match bytes.next() {
                    Some(b'a') => 7,
                    Some(b'b') => 8,
                    Some(b't') => b'\t',
                    Some(b'n') => b'\n',
                    Some(b'v') => 11,
                    Some(b'f') => 12,
                    Some(b'r') => b'\r',
                    Some(escaped @ (b'\\' | b'"')) => escaped,
                    Some(first @ b'0'..=b'3') => {
                        let octal = |value: Option<u8>| {
                            value
                                .filter(|digit| matches!(digit, b'0'..=b'7'))
                                .map(|digit| digit - b'0')
                                .ok_or(GitError::Unreadable)
                        };
                        (first - b'0') * 64 + octal(bytes.next())? * 8 + octal(bytes.next())?
                    }
                    _ => return Err(GitError::Unreadable),
                }
            } else {
                byte
            };
            path.push(output);
        }
        return String::from_utf8(path).map_err(|_| GitError::Unreadable);
    }
    Ok(value.to_owned())
}

fn blame_lines(bytes: &[u8]) -> Result<Vec<BlameLine>> {
    let data = String::from_utf8_lossy(bytes);
    let mut lines = data.split_terminator('\n');
    let mut result = Vec::new();
    while let Some(header) = lines.next() {
        let mut fields = header.split_whitespace();
        let hash = oid(fields.next().ok_or(GitError::Unreadable)?)?.to_owned();
        let mut number = || {
            fields
                .next()
                .and_then(|field| field.parse::<u32>().ok())
                .ok_or(GitError::Unreadable)
        };
        let original = number()?;
        let number = number()?;
        let (mut author, mut time, mut path, mut text) = (None, None, None, None);
        for line in lines.by_ref() {
            if let Some(value) = line.strip_prefix('\t') {
                text = Some(value.strip_suffix('\r').unwrap_or(value).to_owned());
                break;
            }
            if let Some(value) = line.strip_prefix("author ") {
                author = Some(value.to_owned());
            } else if let Some(value) = line.strip_prefix("author-time ") {
                time = value.parse::<i64>().ok();
            } else if let Some(value) = line.strip_prefix("filename ") {
                path = Some(blame_path(value)?);
            }
        }
        let (Some(author), Some(time), Some(path), Some(text)) = (author, time, path, text) else {
            return Err(GitError::Unreadable);
        };
        if original == 0 || number as usize != result.len() + 1 {
            return Err(GitError::Unreadable);
        }
        result.push(BlameLine {
            hash,
            original,
            number,
            author,
            time,
            path,
            text,
        });
    }
    Ok(result)
}

fn file_blame(git: &Path, root: &Path, tip: &str, path: &str) -> Result<FileBlame> {
    let FileRevision {
        revision,
        path,
        content,
    } = file_revision(git, root, tip, path)?;
    let content = match content {
        FileContent::Available { text } if text.is_empty() => BlameContent::Empty,
        FileContent::Available { .. } => match bounded(
            git,
            root,
            &[
                "-c",
                "core.quotePath=false",
                "--literal-pathspecs",
                "blame",
                "--line-porcelain",
                "--no-progress",
                "--encoding=UTF-8",
                &revision,
                "--",
                &path,
            ],
            STATUS_LIMIT,
        )? {
            Some(bytes) => BlameContent::Available {
                lines: blame_lines(&bytes)?,
            },
            None => BlameContent::Oversized,
        },
        FileContent::Missing => BlameContent::Missing,
        FileContent::Binary => BlameContent::Binary,
        FileContent::Oversized => BlameContent::Oversized,
    };
    Ok(FileBlame {
        revision,
        path,
        content,
    })
}

fn stored_blob(git: &Path, root: &Path, revision: &str, path: &str) -> Result<Option<String>> {
    let entry = bounded(
        git,
        root,
        &["--literal-pathspecs", "ls-tree", "-z", revision, "--", path],
        STATUS_LIMIT,
    )?
    .ok_or(GitError::Unreadable)?;
    parse_stored_blob(&entry)
}

pub(super) fn parse_stored_blob(entry: &[u8]) -> Result<Option<String>> {
    let metadata = entry
        .split(|value| *value == b'\t')
        .next()
        .unwrap_or_default();
    let metadata = std::str::from_utf8(metadata).map_err(|_| GitError::Unreadable)?;
    let mut fields = metadata.split_whitespace();
    match (fields.next(), fields.next(), fields.next()) {
        (Some("100644" | "100755"), Some("blob"), Some(hash)) => {
            oid(hash).map(|hash| Some(hash.to_owned()))
        }
        _ => Ok(None),
    }
}

pub(super) fn file_content(bytes: Vec<u8>) -> FileContent {
    match text_patch(bytes) {
        Ok(text) => FileContent::Available { text },
        Err("oversized") => FileContent::Oversized,
        Err(_) => FileContent::Binary,
    }
}

fn blob_content(git: &Path, root: &Path, hash: Option<String>) -> Result<FileContent> {
    match hash {
        Some(hash) => Ok(
            bounded(git, root, &["cat-file", "blob", &hash], PATCH_LIMIT)?
                .map_or(FileContent::Oversized, file_content),
        ),
        None => Ok(FileContent::Missing),
    }
}

pub(super) fn file_revision(
    git: &Path,
    root: &Path,
    revision: &str,
    path: &str,
) -> Result<FileRevision> {
    relative_file(path)?;
    let revision = resolve_commit(git, root, revision)?;
    let content = blob_content(git, root, stored_blob(git, root, &revision, path)?)?;
    Ok(FileRevision {
        revision,
        path: path.into(),
        content,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContext {
    root: String,
    path: String,
    head: Option<String>,
    has_history: bool,
    has_blame: bool,
    has_diff: bool,
}

fn file_context(git: &Path, directory: &Path, name: &str) -> Result<FileContext> {
    let name = crate::local::name_component(name).map_err(|_| GitError::Unreadable)?;
    let file = directory.join(name);
    if !file
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.is_file())
    {
        return Err(GitError::Unreadable);
    }
    let root = worktree_root(git, directory)?;
    let resolved_root = Path::new(&root)
        .canonicalize()
        .map_err(|_| GitError::Unreadable)?;
    let resolved_file = file.canonicalize().map_err(|_| GitError::Unreadable)?;
    let path = resolved_file
        .strip_prefix(resolved_root)
        .map_err(|_| GitError::Unreadable)?
        .components()
        .map(|part| part.as_os_str().to_str().ok_or(GitError::Unreadable))
        .collect::<Result<Vec<_>>>()?
        .join("/");
    if path
        .split('/')
        .next()
        .is_some_and(|part| part.eq_ignore_ascii_case(".git"))
    {
        return Err(GitError::NotRepository);
    }
    relative_file(&path)?;
    let working_root = Path::new(&root);
    let head = optional_line(run(
        git,
        working_root,
        &["rev-parse", "--verify", "--quiet", "HEAD"],
    )?)?;
    let mut has_blame = false;
    let mut has_history = false;
    if let Some(tip) = head.as_deref() {
        let tip = oid(tip)?;
        has_blame = stored_blob(git, working_root, tip, &path)?.is_some();
        has_history = has_blame
            || !file_history(git, working_root, tip, &path, 0)?
                .commits
                .is_empty();
    }
    let has_diff = working_changes(git, working_root)?
        .iter()
        .any(|change| change.path == path || change.previous_path.as_deref() == Some(&path));
    Ok(FileContext {
        root,
        path,
        head,
        has_history,
        has_blame,
        has_diff,
    })
}

pub(super) fn working_content(root: &Path, path: &str) -> Result<FileContent> {
    let Some(path) = working_file(root, relative_file(path)?) else {
        return Ok(FileContent::Missing);
    };
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| GitError::Unreadable)?
        .take(PATCH_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| GitError::Unreadable)?;
    Ok(if bytes.len() as u64 > PATCH_LIMIT {
        FileContent::Oversized
    } else {
        file_content(bytes)
    })
}

#[derive(Serialize)]
pub struct WorkingVersions {
    pub(super) left: FileContent,
    pub(super) right: FileContent,
}

fn index_content(git: &Path, root: &Path, path: &str) -> Result<FileContent> {
    let data = bounded(
        git,
        root,
        &[
            "--literal-pathspecs",
            "ls-files",
            "--stage",
            "-z",
            "--",
            path,
        ],
        STATUS_LIMIT,
    )?
    .ok_or(GitError::Unreadable)?;
    blob_content(git, root, parse_index_blob(&data)?)
}

pub(super) fn parse_index_blob(data: &[u8]) -> Result<Option<String>> {
    for row in data.split(|byte| *byte == 0).filter(|row| !row.is_empty()) {
        let metadata = row
            .split(|byte| *byte == b'\t')
            .next()
            .ok_or(GitError::Unreadable)?;
        let mut fields = std::str::from_utf8(metadata)
            .map_err(|_| GitError::Unreadable)?
            .split_whitespace();
        if let (Some("100644" | "100755"), Some(hash), Some("0")) =
            (fields.next(), fields.next(), fields.next())
        {
            return Ok(Some(oid(hash)?.to_owned()));
        }
    }
    Ok(None)
}

pub(super) fn working_versions(
    git: &Path,
    root: &Path,
    change: &WorkingChange,
    head: Option<&str>,
) -> Result<WorkingVersions> {
    let before = change.previous_path.as_deref().unwrap_or(&change.path);
    relative_file(before)?;
    relative_file(&change.path)?;
    let (left, right) = match change.group {
        ChangeGroup::Staged => {
            let previous = match head {
                Some(head) => stored_blob(git, root, oid(head)?, before)?,
                None => None,
            };
            (
                blob_content(git, root, previous)?,
                index_content(git, root, &change.path)?,
            )
        }
        ChangeGroup::Unstaged => (
            index_content(git, root, before)?,
            working_content(root, &change.path)?,
        ),
        ChangeGroup::Untracked => (FileContent::Missing, working_content(root, &change.path)?),
    };
    Ok(WorkingVersions { left, right })
}

#[tauri::command]
pub async fn git_file_history(
    root: String,
    tip: String,
    path: String,
    offset: u32,
) -> Result<FileHistory> {
    query(move || file_history(&executable()?, directory(&root)?, &tip, &path, offset)).await
}

#[tauri::command]
pub async fn git_file_revision(
    root: String,
    revision: String,
    path: String,
) -> Result<FileRevision> {
    query(move || file_revision(&executable()?, directory(&root)?, &revision, &path)).await
}

#[tauri::command]
pub async fn git_file_blame(root: String, tip: String, path: String) -> Result<FileBlame> {
    query(move || file_blame(&executable()?, directory(&root)?, &tip, &path)).await
}

#[tauri::command]
pub async fn git_file_context(directory: String, name: String) -> Result<FileContext> {
    query(move || file_context(&executable()?, super::directory(&directory)?, &name)).await
}

#[tauri::command]
pub async fn git_working_file_content(root: String, path: String) -> Result<FileContent> {
    query(move || working_content(directory(&root)?, &path)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_view::{command, run, success};
    use std::{fs, io::Write, process::Stdio};

    fn git(git: &Path, root: &Path, args: &[&str]) -> String {
        String::from_utf8(success(run(git, root, args).unwrap()).unwrap())
            .unwrap()
            .trim()
            .into()
    }

    fn fixture(exe: &Path, root: &Path) {
        git(exe, root, &["init", "-b", "main"]);
        git(exe, root, &["config", "user.name", "Fixture"]);
        git(
            exe,
            root,
            &["config", "user.email", "fixture@example.invalid"],
        );
        git(exe, root, &["config", "commit.gpgsign", "false"]);
    }

    #[test]
    fn resolves_file_context_in_a_linked_worktree_and_a_nested_repository() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("outer");
        let linked = tmp.path().join("linked");
        let nested = root.join("independent");
        let subfolder = nested.join("folder");
        let exe = executable().unwrap();
        std::fs::create_dir_all(&subfolder).unwrap();
        fixture(&exe, &root);
        std::fs::write(root.join("note.txt"), "outer content\n").unwrap();
        git(&exe, &root, &["add", "note.txt"]);
        git(&exe, &root, &["commit", "-m", "Outer file"]);
        git(
            &exe,
            &root,
            &["worktree", "add", "-b", "linked", linked.to_str().unwrap()],
        );
        let in_linked = file_context(&exe, &linked, "note.txt").unwrap();
        assert_eq!(
            Path::new(&in_linked.root).canonicalize().unwrap(),
            linked.canonicalize().unwrap()
        );
        assert!(in_linked.has_history && in_linked.has_blame && !in_linked.has_diff);

        fixture(&exe, &nested);
        std::fs::write(subfolder.join("note.txt"), "nested content\n").unwrap();
        let unborn = file_context(&exe, &subfolder, "note.txt").unwrap();
        assert!(
            unborn.head.is_none() && !unborn.has_history && !unborn.has_blame && unborn.has_diff
        );
        git(&exe, &nested, &["add", "folder/note.txt"]);
        git(&exe, &nested, &["commit", "-m", "Nested file"]);
        std::fs::write(subfolder.join("note.txt"), "staged content\n").unwrap();
        git(&exe, &nested, &["add", "folder/note.txt"]);
        std::fs::write(subfolder.join("note.txt"), "working content\n").unwrap();
        let in_nested = file_context(&exe, &subfolder, "note.txt").unwrap();
        assert_eq!(
            Path::new(&in_nested.root).canonicalize().unwrap(),
            nested.canonicalize().unwrap()
        );
        assert_eq!(in_nested.path, "folder/note.txt");
        assert_ne!(in_nested.head, in_linked.head);
        assert!(in_nested.has_history && in_nested.has_blame && in_nested.has_diff);
        let changes = working_changes(&exe, &nested).unwrap();
        let staged = changes
            .iter()
            .find(|change| change.group == ChangeGroup::Staged)
            .unwrap();
        let unstaged = changes
            .iter()
            .find(|change| change.group == ChangeGroup::Unstaged)
            .unwrap();
        let staged = working_versions(&exe, &nested, staged, in_nested.head.as_deref()).unwrap();
        let unstaged = working_versions(&exe, &nested, unstaged, None).unwrap();
        let available = |content| match content {
            FileContent::Available { text } => text,
            _ => panic!("expected text"),
        };
        assert_eq!(
            [available(staged.left), available(staged.right)],
            ["nested content\n", "staged content\n"]
        );
        assert_eq!(
            [available(unstaged.left), available(unstaged.right)],
            ["staged content\n", "working content\n"]
        );
        assert!(
            matches!(working_content(&nested, &in_nested.path).unwrap(), FileContent::Available { text }
            if text == "working content\n")
        );
        assert!(
            matches!(file_revision(&exe, &nested, in_nested.head.as_ref().unwrap(), &in_nested.path).unwrap().content,
            FileContent::Available { text } if text == "nested content\n")
        );
        assert!(working_content(&nested, "../note.txt").is_err());
        std::fs::write(tmp.path().join("outside.txt"), "outside\n").unwrap();
        assert!(matches!(
            file_context(&exe, tmp.path(), "outside.txt"),
            Err(GitError::NotRepository)
        ));
    }

    #[test]
    fn blames_the_stored_version_across_a_rename_and_preserves_line_origins() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let exe = executable().unwrap();
        fixture(&exe, root);
        let cli = |args: &[&str]| git(&exe, root, args);
        let old = "old źródło.txt";
        let new = "new source.txt";
        std::fs::write(
            root.join(old),
            "first stable line\noriginal text\nlast stable line\n",
        )
        .unwrap();
        std::fs::write(root.join("empty.txt"), "").unwrap();
        std::fs::write(root.join("binary.dat"), b"a\0b").unwrap();
        cli(&["add", "."]);
        cli(&["commit", "-m", "First lines"]);
        let original = cli(&["rev-parse", "HEAD"]);
        cli(&["mv", old, new]);
        cli(&["commit", "-m", "Rename source"]);
        cli(&["config", "user.name", "Second author"]);
        std::fs::write(
            root.join(new),
            "first stable line\nnew text\nlast stable line\n",
        )
        .unwrap();
        cli(&["commit", "-am", "Change line two"]);
        let tip = cli(&["rev-parse", "HEAD"]);
        std::fs::write(root.join(new), "local file contents\n").unwrap();
        let blamed = file_blame(&exe, root, &tip, new).unwrap();
        assert_eq!(blamed.revision, tip);
        let BlameContent::Available { lines } = blamed.content else {
            panic!("expected committed lines");
        };
        assert_eq!(lines.len(), 3);
        assert_eq!(
            (&*lines[0].author, &*lines[0].hash, &*lines[0].path),
            ("Fixture", original.as_str(), old)
        );
        assert_eq!(
            (&*lines[1].author, &*lines[1].hash, &*lines[1].path),
            ("Second author", tip.as_str(), new)
        );
        assert_eq!(
            (lines[1].original, lines[1].number, &*lines[1].text),
            (2, 2, "new text")
        );
        assert!(lines[0].time > 0);
        assert!(matches!(
            file_blame(&exe, root, &tip, "empty.txt").unwrap().content,
            BlameContent::Empty
        ));
        assert!(matches!(
            file_blame(&exe, root, &tip, "binary.dat").unwrap().content,
            BlameContent::Binary
        ));
        assert!(matches!(
            file_blame(&exe, root, &tip, old).unwrap().content,
            BlameContent::Missing
        ));
        assert_eq!(
            blame_path(r#""path\twith\040quotes\".txt""#).unwrap(),
            "path\twith quotes\".txt"
        );
    }

    #[test]
    fn follows_renamed_and_deleted_paths_across_pages() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let exe = executable().unwrap();
        fixture(&exe, root);
        let mut process = command(&exe, root, &["fast-import", "--quiet"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        {
            let mut input = process.stdin.take().unwrap();
            let mut add = |time: u32, subject: &str, changes: &str| {
                write!(input, "commit refs/heads/main\ncommitter Fixture <fixture@example.invalid> {time} +0000\ndata {}\n{subject}\n{changes}\n\n", subject.len()).unwrap();
            };
            add(1, "Root file", "M 100644 inline old.txt\ndata 8\noriginal");
            add(2, "Rename the file", "R old.txt new.txt");
            for number in 0..49 {
                let content = format!("revision {number}");
                add(
                    number + 3,
                    &content,
                    &format!("M 100644 inline new.txt\ndata {}\n{content}", content.len()),
                );
            }
            add(60, "Delete the file", "D new.txt");
        }
        assert!(process.wait().unwrap().success());
        let head = git(&exe, root, &["rev-parse", "HEAD"]);
        let first = file_history(&exe, root, &head, "new.txt", 0).unwrap();
        assert_eq!(first.commits.len(), 50);
        assert_eq!(first.commits[0].change.status, 'D');
        let next = file_history(&exe, root, &head, "new.txt", first.next_offset.unwrap()).unwrap();
        assert_eq!(next.commits.len(), 2);
        assert_eq!(
            next.commits[0].change.previous_path.as_deref(),
            Some("old.txt")
        );
        assert_eq!(next.commits[0].change.path, "new.txt");
        let last = file_history(&exe, root, &head, "new.txt", 51).unwrap();
        assert_eq!(last.commits[0].change.path, "old.txt");
        assert_eq!(last.commits[0].change.status, 'A');
        assert!(last.commits[0].parent.is_none());
        assert!(matches!(
            file_revision(&exe, root, &head, "new.txt").unwrap().content,
            FileContent::Missing
        ));
        let original = file_revision(&exe, root, &last.commits[0].commit.hash, "old.txt").unwrap();
        assert!(matches!(original.content, FileContent::Available { text } if text == "original"));
    }

    #[test]
    fn compares_a_merge_to_its_first_parent_and_reports_content_limits() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let exe = executable().unwrap();
        fixture(&exe, root);
        git(&exe, root, &["commit", "--allow-empty", "-m", "Root"]);
        let parent = git(&exe, root, &["rev-parse", "HEAD"]);
        git(&exe, root, &["switch", "-c", "topic"]);
        fs::write(root.join("file.txt"), "new content\n").unwrap();
        fs::write(root.join("binary"), [0_u8, 1, 2]).unwrap();
        fs::write(root.join("large"), vec![b'x'; PATCH_LIMIT as usize + 1]).unwrap();
        git(&exe, root, &["add", "."]);
        git(&exe, root, &["commit", "-m", "Topic change"]);
        git(&exe, root, &["switch", "main"]);
        git(
            &exe,
            root,
            &["merge", "--no-ff", "topic", "-m", "Merge the file"],
        );
        let head = git(&exe, root, &["rev-parse", "HEAD"]);
        let history = file_history(&exe, root, &head, "file.txt", 0).unwrap();
        let selected = &history.commits[0];
        assert_eq!(selected.commit.hash, head);
        assert!(selected.merge);
        assert_eq!(selected.parent.as_deref(), Some(parent.as_str()));
        assert_eq!(selected.change.status, 'A');
        assert!(matches!(
            file_revision(&exe, root, &head, "binary").unwrap().content,
            FileContent::Binary
        ));
        assert!(matches!(
            file_revision(&exe, root, &head, "large").unwrap().content,
            FileContent::Oversized
        ));
    }
}
