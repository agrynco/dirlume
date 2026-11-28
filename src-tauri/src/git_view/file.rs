use super::{
    bounded, comparison::resolve_commit, directory, executable, oid, parse_changes, query,
    relative_file, text_patch, Change, Commit, GitError, Result, PAGE_SIZE, PATCH_LIMIT,
    STATUS_LIMIT,
};
use serde::Serialize;
use std::path::Path;

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

fn file_history(
    git: &Path,
    root: &Path,
    tip: &str,
    path: &str,
    offset: u32,
) -> Result<FileHistory> {
    relative_file(path)?;
    let offset = offset as usize;
    // Git's --skip skips rename detection as well as output, losing the old path on later pages.
    let limit = format!("--max-count={}", offset.saturating_add(PAGE_SIZE + 1));
    let data = bounded(
        git,
        root,
        &[
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
            &limit,
            oid(tip)?,
            "--",
            path,
        ],
        STATUS_LIMIT,
    )?
    .ok_or(GitError::Unreadable)?;
    let data = String::from_utf8_lossy(&data);
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
enum FileContent {
    Available { text: String },
    Missing,
    Binary,
    Oversized,
}

#[derive(Serialize)]
pub struct FileRevision {
    revision: String,
    path: String,
    content: FileContent,
}

fn file_revision(git: &Path, root: &Path, revision: &str, path: &str) -> Result<FileRevision> {
    relative_file(path)?;
    let revision = resolve_commit(git, root, revision)?;
    let entry = bounded(
        git,
        root,
        &[
            "--literal-pathspecs",
            "ls-tree",
            "-z",
            &revision,
            "--",
            path,
        ],
        STATUS_LIMIT,
    )?
    .ok_or(GitError::Unreadable)?;
    let metadata = entry
        .split(|value| *value == b'\t')
        .next()
        .unwrap_or_default();
    let metadata = std::str::from_utf8(metadata).map_err(|_| GitError::Unreadable)?;
    let mut fields = metadata.split_whitespace();
    let content = match (fields.next(), fields.next(), fields.next()) {
        (Some("100644" | "100755"), Some("blob"), Some(hash)) => {
            match bounded(git, root, &["cat-file", "blob", oid(hash)?], PATCH_LIMIT)? {
                Some(bytes) => match text_patch(bytes) {
                    Ok(text) => FileContent::Available { text },
                    Err("oversized") => FileContent::Oversized,
                    Err(_) => FileContent::Binary,
                },
                None => FileContent::Oversized,
            }
        }
        _ => FileContent::Missing,
    };
    Ok(FileRevision {
        revision,
        path: path.into(),
        content,
    })
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
