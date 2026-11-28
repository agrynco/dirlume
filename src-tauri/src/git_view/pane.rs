use std::{path::PathBuf, sync::Arc};

use serde::{Deserialize, Serialize};
use tauri::State;

use super::{
    bounded, directory, executable, file, line, oid, optional_line, parse_working_changes, query,
    run, success, working_changes, worktree_root, ChangeGroup, GitError, Result, WorkingChange,
    PATCH_LIMIT, STATUS_LIMIT, WORKING_STATUS_ARGS,
};
use crate::{
    remote_transfer::UploadSession as _,
    ssh::{self, Connection, Session, SshState},
};

const HEAD_ARGS: &[&str] = &["rev-parse", "--verify", "--quiet", "HEAD"];
const BRANCH_ARGS: &[&str] = &["symbolic-ref", "--quiet", "HEAD"];

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PaneSource {
    Local { directory: String },
    Ssh { id: u32, segments: Vec<String> },
}

enum Reader {
    Local {
        git: PathBuf,
        directory: PathBuf,
    },
    Ssh {
        connection: Arc<Connection>,
        directory: String,
    },
}

impl PaneSource {
    fn reader(self, state: &SshState) -> Result<Reader> {
        match self {
            Self::Local { directory: path } => Ok(Reader::Local {
                git: executable()?,
                directory: directory(&path)?.into(),
            }),
            Self::Ssh { id, segments } => Ok(Reader::Ssh {
                connection: state.connection(id).map_err(|_| GitError::Unreadable)?,
                directory: Session::absolute(&segments).map_err(|_| GitError::Unreadable)?,
            }),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Worktree {
    root: String,
    prefix: String,
    head: Option<String>,
    head_ref: Option<String>,
    metadata: Option<String>,
}

#[derive(Serialize)]
pub struct PaneStatus {
    #[serde(flatten)]
    worktree: Worktree,
    changes: Vec<WorkingChange>,
}

fn ssh_git(
    connection: &Connection,
    directory: &str,
    args: &[&str],
    limit: u64,
) -> Result<ssh::GitOutput> {
    let arguments = args
        .iter()
        .map(|argument| ssh::quote(argument))
        .collect::<Vec<_>>()
        .join(" ");
    let script = format!("CDPATH= cd -- {} || exit 125\n\
        unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS\n\
        LC_ALL=C GIT_OPTIONAL_LOCKS=0 GIT_NO_LAZY_FETCH=1 GIT_ALLOW_PROTOCOL='' GIT_TERMINAL_PROMPT=0 \
        exec git --no-pager -c gc.auto=0 -c core.fsmonitor=false {arguments}", ssh::quote(directory));
    connection
        .git_read(&script, limit as usize)
        .map_err(|_| GitError::Unreadable)
}

fn ssh_result(output: ssh::GitOutput) -> Result<Option<Vec<u8>>> {
    match output.status {
        0 => Ok(output.stdout),
        127 => Err(GitError::MissingGit),
        _ if output.stderr.contains("not a git repository")
            || output.stderr.contains("must be run in a work tree") =>
        {
            Err(GitError::NotRepository)
        }
        _ => Err(GitError::Unreadable),
    }
}

fn ssh_line(
    connection: &Connection,
    directory: &str,
    args: &[&str],
    optional: bool,
) -> Result<Option<String>> {
    let output = ssh_git(connection, directory, args, 64 * 1024)?;
    if optional && output.status == 1 && output.stderr.is_empty() {
        return Ok(None);
    }
    Ok(Some(line(
        ssh_result(output)?.ok_or(GitError::Unreadable)?,
    )?))
}

impl Reader {
    fn root(&self) -> Result<String> {
        match self {
            Self::Local { git, directory } => worktree_root(git, directory),
            Self::Ssh {
                connection,
                directory,
            } => ssh_line(
                connection,
                directory,
                &["rev-parse", "--show-toplevel"],
                false,
            )?
            .filter(|root| root.starts_with('/'))
            .ok_or(GitError::Unreadable),
        }
    }

    fn status(&self) -> Result<PaneStatus> {
        let root = self.root()?;
        let (prefix, head, head_ref, metadata) = match self {
            Self::Local {
                git,
                directory: folder,
            } => {
                let prefix = line(success(run(git, folder, &["rev-parse", "--show-prefix"])?)?)?;
                let tree = directory(&root)?;
                (
                    prefix,
                    optional_line(run(git, tree, HEAD_ARGS)?)?,
                    optional_line(run(git, tree, BRANCH_ARGS)?)?,
                    line(success(run(
                        git,
                        tree,
                        &["rev-parse", "--absolute-git-dir"],
                    )?)?)
                    .ok(),
                )
            }
            Self::Ssh {
                connection,
                directory,
            } => (
                ssh_line(
                    connection,
                    directory,
                    &["rev-parse", "--show-prefix"],
                    false,
                )?
                .ok_or(GitError::Unreadable)?,
                ssh_line(connection, &root, HEAD_ARGS, true)?,
                ssh_line(connection, &root, BRANCH_ARGS, true)?,
                None,
            ),
        };
        let changes = self.changes(&root)?;
        Ok(PaneStatus {
            worktree: Worktree {
                root,
                prefix,
                head,
                head_ref,
                metadata,
            },
            changes,
        })
    }

    fn bytes(&self, root: &str, args: &[&str], limit: u64) -> Result<Option<Vec<u8>>> {
        match self {
            Self::Local { git, .. } => bounded(git, directory(root)?, args, limit),
            Self::Ssh { connection, .. } => ssh_result(ssh_git(connection, root, args, limit)?),
        }
    }

    fn changes(&self, root: &str) -> Result<Vec<WorkingChange>> {
        match self {
            Self::Local { git, .. } => working_changes(git, directory(root)?),
            Self::Ssh { .. } => parse_working_changes(
                self.bytes(root, WORKING_STATUS_ARGS, STATUS_LIMIT)?
                    .ok_or(GitError::Unreadable)?,
            ),
        }
    }

    fn history(&self, root: &str, tip: &str, path: &str, offset: u32) -> Result<file::FileHistory> {
        match self {
            Self::Local { git, .. } => file::file_history(git, directory(root)?, tip, path, offset),
            Self::Ssh { .. } => {
                let limit = file::history_limit(offset);
                let bytes = self
                    .bytes(
                        root,
                        &file::history_args(oid(tip)?, path, &limit),
                        STATUS_LIMIT,
                    )?
                    .ok_or(GitError::Unreadable)?;
                file::parse_file_history(&bytes, offset)
            }
        }
    }

    fn blob(&self, root: &str, hash: Option<String>) -> Result<file::FileContent> {
        let Some(hash) = hash else {
            return Ok(file::FileContent::Missing);
        };
        Ok(self
            .bytes(root, &["cat-file", "blob", oid(&hash)?], PATCH_LIMIT)?
            .map_or(file::FileContent::Oversized, file::file_content))
    }

    fn revision(&self, root: &str, revision: &str, path: &str) -> Result<file::FileContent> {
        match self {
            Self::Local { git, .. } => {
                Ok(file::file_revision(git, directory(root)?, oid(revision)?, path)?.content)
            }
            Self::Ssh { .. } => {
                let entry = self
                    .bytes(
                        root,
                        &[
                            "--literal-pathspecs",
                            "ls-tree",
                            "-z",
                            oid(revision)?,
                            "--",
                            path,
                        ],
                        STATUS_LIMIT,
                    )?
                    .ok_or(GitError::Unreadable)?;
                self.blob(root, file::parse_stored_blob(&entry)?)
            }
        }
    }

    fn index(&self, root: &str, path: &str) -> Result<file::FileContent> {
        let entry = self
            .bytes(
                root,
                &["--literal-pathspecs", "ls-files", "-s", "-z", "--", path],
                STATUS_LIMIT,
            )?
            .ok_or(GitError::Unreadable)?;
        self.blob(root, file::parse_index_blob(&entry)?)
    }

    fn working(&self, root: &str, path: &str) -> Result<file::FileContent> {
        match self {
            Self::Local { .. } => file::working_content(directory(root)?, path),
            Self::Ssh { connection, .. } => {
                let absolute = format!("{}/{}", root.trim_end_matches('/'), path);
                let script = format!("path={}\nroot={}\n\
                    [ -f \"$path\" ] && [ ! -L \"$path\" ] || exit 3\n\
                    real=$(realpath -e -- \"$path\") || exit 125\n\
                    case \"$real\" in \"$root\"/*) exec head -c {} -- \"$real\" ;; *) exit 3 ;; esac",
                    ssh::quote(&absolute), ssh::quote(root.trim_end_matches('/')), PATCH_LIMIT + 1);
                let result = connection
                    .git_read(&script, PATCH_LIMIT as usize)
                    .map_err(|_| GitError::Unreadable)?;
                if result.status == 3 {
                    return Ok(file::FileContent::Missing);
                }
                Ok(ssh_result(result)?.map_or(file::FileContent::Oversized, file::file_content))
            }
        }
    }

    fn diffs(&self, root: &str, path: &str, head: Option<&str>) -> Result<Vec<PaneComparison>> {
        let mut comparisons = Vec::new();
        for change in self
            .changes(root)?
            .into_iter()
            .filter(|change| change.path == path)
        {
            let before = change.previous_path.as_deref().unwrap_or(path);
            valid_path(before)?;
            let versions = if change.status == 'U' {
                None
            } else {
                Some(match self {
                    Self::Local { git, .. } => {
                        file::working_versions(git, directory(root)?, &change, head)?
                    }
                    Self::Ssh { .. } => {
                        let (left, right) = match change.group {
                            ChangeGroup::Staged => (
                                self.revision_or_empty(root, head, before)?,
                                self.index(root, path)?,
                            ),
                            ChangeGroup::Unstaged => {
                                (self.index(root, before)?, self.working(root, path)?)
                            }
                            ChangeGroup::Untracked => {
                                (file::FileContent::Missing, self.working(root, path)?)
                            }
                        };
                        file::WorkingVersions { left, right }
                    }
                })
            };
            comparisons.push(PaneComparison { change, versions });
        }
        Ok(comparisons)
    }

    fn revision_or_empty(
        &self,
        root: &str,
        head: Option<&str>,
        path: &str,
    ) -> Result<file::FileContent> {
        head.map_or(Ok(file::FileContent::Missing), |revision| {
            self.revision(root, revision, path)
        })
    }
}

fn valid_path(path: &str) -> Result<()> {
    if path.contains('\0') || path.split('/').any(|part| matches!(part, "" | "." | "..")) {
        Err(GitError::Unreadable)
    } else {
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PaneRead {
    Diff {
        path: String,
        head: Option<String>,
    },
    Compare {
        path: String,
        revision: String,
        #[serde(rename = "previousPath")]
        previous_path: Option<String>,
    },
    History {
        path: String,
        tip: String,
        offset: u32,
    },
    Revision {
        path: String,
        revision: String,
    },
}

#[derive(Serialize)]
pub struct PaneComparison {
    change: WorkingChange,
    versions: Option<file::WorkingVersions>,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum PaneReadResult {
    Diff(Vec<PaneComparison>),
    Compare(file::WorkingVersions),
    History(file::FileHistory),
    Revision(file::FileContent),
}

#[tauri::command]
pub async fn git_pane_status(state: State<'_, SshState>, source: PaneSource) -> Result<PaneStatus> {
    let reader = source.reader(&state)?;
    query(move || reader.status()).await
}

#[tauri::command]
pub async fn git_pane_read(
    state: State<'_, SshState>,
    source: PaneSource,
    root: String,
    request: PaneRead,
) -> Result<PaneReadResult> {
    let reader = source.reader(&state)?;
    query(move || {
        if reader.root()? != root {
            return Err(GitError::NotRepository);
        }
        let path = match &request {
            PaneRead::Diff { path, .. }
            | PaneRead::Compare { path, .. }
            | PaneRead::History { path, .. }
            | PaneRead::Revision { path, .. } => path,
        };
        valid_path(path)?;
        if matches!(reader, Reader::Local { .. }) {
            super::relative_file(path)?;
        }
        match request {
            PaneRead::Diff { path, head } => Ok(PaneReadResult::Diff(reader.diffs(
                &root,
                &path,
                head.as_deref(),
            )?)),
            PaneRead::Compare {
                path,
                revision,
                previous_path,
            } => {
                let before = previous_path.as_deref().unwrap_or(&path);
                valid_path(before)?;
                Ok(PaneReadResult::Compare(file::WorkingVersions {
                    left: reader.revision(&root, &revision, before)?,
                    right: reader.working(&root, &path)?,
                }))
            }
            PaneRead::History { path, tip, offset } => Ok(PaneReadResult::History(
                reader.history(&root, &tip, &path, offset)?,
            )),
            PaneRead::Revision { path, revision } => Ok(PaneReadResult::Revision(
                reader.revision(&root, &revision, &path)?,
            )),
        }
    })
    .await
}

#[cfg(test)]
pub(crate) fn verify_ssh_git_pane(connection: Arc<Connection>, sftp_only: Arc<Connection>) {
    let script = r#"set -eu
        root=$(mktemp -d)
        cd -- "$root"
        git init -q -b remote
        git config user.name 'Fixture Author'
        git config user.email fixture@example.invalid
        mkdir 'nested ł'
        printf 'committed\n' >"nested ł/it's a file.txt"
        git add .
        git commit -qm 'Initial remote files'
        printf 'staged\n' >"nested ł/it's a file.txt"
        git add .
        printf 'working\n' >"nested ł/it's a file.txt"
        printf '%s\n' "$root""#;
    let initialized = connection.git_read(script, 8192).unwrap();
    assert_eq!(initialized.status, 0, "{}", initialized.stderr);
    let root = line(initialized.stdout.unwrap()).unwrap();
    let directory = format!("{root}/nested ł");
    let reader = Reader::Ssh {
        connection,
        directory,
    };
    let status = reader.status().unwrap();
    assert_eq!(status.worktree.root, root);
    assert_eq!(status.worktree.prefix, "nested ł/");
    assert_eq!(
        status.worktree.head_ref.as_deref(),
        Some("refs/heads/remote")
    );
    let head = status.worktree.head.unwrap();
    let path = "nested ł/it's a file.txt";
    let diff = serde_json::to_value(reader.diffs(&root, path, Some(&head)).unwrap()).unwrap();
    assert_eq!(diff[0]["versions"]["left"]["text"], "committed\n");
    assert_eq!(diff[0]["versions"]["right"]["text"], "staged\n");
    assert_eq!(diff[1]["versions"]["left"]["text"], "staged\n");
    assert_eq!(diff[1]["versions"]["right"]["text"], "working\n");
    let history = serde_json::to_value(reader.history(&root, &head, path, 0).unwrap()).unwrap();
    assert_eq!(history["commits"][0]["subject"], "Initial remote files");
    let restricted = Reader::Ssh {
        connection: sftp_only,
        directory: "/".into(),
    };
    assert!(matches!(restricted.status(), Err(GitError::Unreadable)));
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::git_view::tests::git;

    fn text(content: file::FileContent) -> String {
        match content {
            file::FileContent::Available { text } => text,
            _ => panic!("expected text content"),
        }
    }

    #[test]
    fn reads_local_pane_from_a_linked_worktree_without_writing() {
        let temporary = tempfile::tempdir().unwrap();
        let parent = temporary.path();
        let repository = parent.join("primary");
        fs::create_dir(&repository).unwrap();
        git(&repository, &["init", "-b", "main"]);
        git(&repository, &["config", "user.name", "Fixture Author"]);
        git(
            &repository,
            &["config", "user.email", "fixture@example.invalid"],
        );
        git(&repository, &["config", "commit.gpgsign", "false"]);
        fs::create_dir_all(repository.join("nested ł/removed")).unwrap();
        fs::write(repository.join("nested ł/note.txt"), "committed\n").unwrap();
        fs::write(repository.join("nested ł/removed/file.txt"), "delete me\n").unwrap();
        fs::write(repository.join(".gitignore"), "ignored.txt\n").unwrap();
        git(&repository, &["add", "."]);
        git(&repository, &["commit", "-m", "Initial files"]);
        let linked = parent.join("worktree ł");
        git(
            &repository,
            &["worktree", "add", "-b", "linked", linked.to_str().unwrap()],
        );

        let nested = linked.join("nested ł");
        git(
            &linked,
            &["mv", "nested ł/note.txt", "nested ł/renamed.txt"],
        );
        fs::write(nested.join("renamed.txt"), "working\n").unwrap();
        fs::write(nested.join("untracked.txt"), "new\n").unwrap();
        fs::write(nested.join("ignored.txt"), "ignored\n").unwrap();
        fs::remove_file(nested.join("removed/file.txt")).unwrap();
        let reader = Reader::Local {
            git: executable().unwrap(),
            directory: nested,
        };
        let status = reader.status().unwrap();
        let Worktree {
            root,
            prefix,
            head,
            head_ref,
            metadata,
        } = status.worktree;
        assert_eq!(prefix, "nested ł/");
        assert_eq!(head_ref.as_deref(), Some("refs/heads/linked"));
        assert_ne!(
            root,
            worktree_root(&executable().unwrap(), &repository).unwrap()
        );
        assert!(status
            .changes
            .iter()
            .any(|change| change.path == "nested ł/removed/file.txt" && change.status == 'D'));
        assert!(status
            .changes
            .iter()
            .any(|change| change.path == "nested ł/untracked.txt"));
        assert!(!status
            .changes
            .iter()
            .any(|change| change.path.ends_with("ignored.txt")));
        let index = PathBuf::from(metadata.unwrap()).join("index");
        let baseline = fs::read(&index).unwrap();
        let baseline_modified = fs::metadata(&index).unwrap().modified().unwrap();
        let head = head.unwrap();
        let path = "nested ł/renamed.txt";
        let mut versions = reader.diffs(&root, path, Some(&head)).unwrap().into_iter();
        let staged = versions.next().unwrap();
        assert_eq!(
            staged.change.previous_path.as_deref(),
            Some("nested ł/note.txt")
        );
        let staged = staged.versions.unwrap();
        assert_eq!(text(staged.left), "committed\n");
        assert_eq!(text(staged.right), "committed\n");
        let working = versions.next().unwrap().versions.unwrap();
        assert_eq!(text(working.left), "committed\n");
        assert_eq!(text(working.right), "working\n");
        let history = reader
            .history(&root, &head, "nested ł/note.txt", 0)
            .unwrap();
        let history = serde_json::to_value(history).unwrap();
        assert_eq!(history["commits"][0]["subject"], "Initial files");
        assert_eq!(fs::read(&index).unwrap(), baseline);
        assert_eq!(
            fs::metadata(&index).unwrap().modified().unwrap(),
            baseline_modified
        );
        assert_eq!(git(&linked, &["rev-parse", "HEAD"]), head);
    }
}
