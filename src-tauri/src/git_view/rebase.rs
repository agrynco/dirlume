use super::{
    bounded, command, history_edits, merge, oid, repository, run, success, writes, Commit,
    GitError, STATUS_LIMIT,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
    process::Output,
};
use writes::{IndexSnapshot, WriteError};

type WriteResult<T> = std::result::Result<T, WriteError>;
const EDIT_MESSAGES: &str = "rebase-merge/dirlume-review.json";

#[derive(Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseReview {
    head: String,
    head_ref: String,
    base: String,
    base_ref: Option<String>,
    index: IndexSnapshot,
}

#[derive(Serialize)]
pub struct RebasePlan {
    review: RebaseReview,
    commits: Vec<Commit>,
    merges: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StepAction {
    Pick,
    Reword,
    Squash,
    Drop,
}

#[derive(Deserialize)]
pub struct RebaseStep {
    hash: String,
    action: StepAction,
    message: Option<String>,
}

fn plan(git: &Path, root: &Path, target: &str) -> WriteResult<RebasePlan> {
    let index = writes::review_index(git, root)?;
    let repo = repository(git, root)?;
    let head = repo.head.ok_or(WriteError::UnsupportedChange)?;
    let head_ref = repo.head_ref.ok_or(WriteError::Detached)?;
    let branch = repo
        .branches
        .iter()
        .find(|branch| branch.reference == target);
    let base_ref = branch.map(|branch| branch.reference.clone());
    let base = history_edits::local_commit(git, root, branch.map_or(target, |branch| &branch.tip))?;
    let common = run(git, root, &["merge-base", &head, &base])?;
    if common.status.code() == Some(1) {
        return Err(WriteError::Failed(
            "The selected base has no commit in common with this branch.".into(),
        ));
    }
    success(common)?;
    let range = format!("{base}..{head}");
    let data = bounded(
        git,
        root,
        &[
            "log",
            "-z",
            "--reverse",
            "--topo-order",
            "--no-color",
            "--no-decorate",
            "--no-notes",
            "--no-show-signature",
            "--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%P",
            &range,
            "--",
        ],
        STATUS_LIMIT,
    )?
    .ok_or(GitError::Unreadable)?;
    let data = String::from_utf8_lossy(&data);
    let fields = data.split_terminator('\0').collect::<Vec<_>>();
    let (rows, remainder) = fields.as_chunks::<6>();
    if !remainder.is_empty() {
        return Err(GitError::Unreadable.into());
    }
    let (mut commits, mut merges) = (Vec::new(), Vec::new());
    for row in rows {
        let hash = oid(row[0])?.to_owned();
        if row[5].split_whitespace().count() > 1 {
            merges.push(hash);
        } else {
            commits.push(Commit {
                hash,
                short_hash: row[1].into(),
                author: row[2].into(),
                date: row[3].into(),
                subject: row[4].into(),
            });
        }
    }
    Ok(RebasePlan {
        review: RebaseReview {
            head,
            head_ref,
            base,
            base_ref,
            index,
        },
        commits,
        merges,
    })
}

fn shell_path(path: &Path) -> WriteResult<String> {
    let path = path.to_str().ok_or(GitError::Unreadable)?;
    #[cfg(windows)]
    let path = path
        .strip_prefix(r"\\?\")
        .unwrap_or(path)
        .replace('\\', "/");
    Ok(format!("'{}'", path.replace('\'', "'\\''")))
}

fn message_editor(
    git: &Path,
    root: &Path,
    scripts: &Path,
    messages: &BTreeMap<String, String>,
) -> WriteResult<String> {
    if messages.is_empty() {
        return Ok("true".into());
    }
    let directory = scripts.join("messages");
    fs::create_dir(&directory)?;
    for (hash, message) in messages {
        fs::write(directory.join(oid(hash)?), message)?;
    }
    let done = writes::git_path(git, root, "rebase-merge/done")?;
    let editor = scripts.join("message-editor.sh");
    let script = format!(
        r#"set -efu
destination=$1
line=$(tail -n 1 {done})
case "$line" in
    reword\ *)
        set -- $line
        key=$2
        case "$key" in ''|*[!0-9a-fA-F]*) exit 1 ;; esac
        message={messages}/"$key"
        if test -f "$message"; then cp "$message" "$destination"; fi
        ;;
esac
"#,
        done = shell_path(&done)?,
        messages = shell_path(&directory)?,
    );
    fs::write(&editor, script)?;
    Ok(format!("sh {}", shell_path(&editor)?))
}

fn apply(
    git: &Path,
    root: &Path,
    reviewed: &RebaseReview,
    steps: &[RebaseStep],
) -> WriteResult<()> {
    let actual = plan(
        git,
        root,
        reviewed.base_ref.as_deref().unwrap_or(&reviewed.base),
    )?;
    if actual.review != *reviewed {
        return Err(WriteError::Stale);
    }
    let mut incoming = actual
        .commits
        .iter()
        .map(|commit| commit.hash.as_str())
        .collect::<BTreeSet<_>>();
    if incoming.len() != steps.len() {
        return Err(WriteError::Stale);
    }
    let mut todo = String::new();
    let mut keeps_commit = false;
    let mut messages = BTreeMap::new();
    for step in steps {
        if !incoming.remove(step.hash.as_str()) {
            return Err(WriteError::Stale);
        }
        let action = match step.action {
            StepAction::Pick => "pick",
            StepAction::Reword => {
                let message = step
                    .message
                    .as_deref()
                    .map(str::trim)
                    .filter(|message| {
                        !message.is_empty() && !message.contains('\0') && message.len() <= 64 * 1024
                    })
                    .ok_or_else(|| {
                        WriteError::Failed(
                            "Enter a replacement message for each reworded commit.".into(),
                        )
                    })?;
                messages.insert(step.hash.clone(), format!("{message}\n"));
                "reword"
            }
            StepAction::Squash if keeps_commit => "squash",
            StepAction::Squash => {
                return Err(WriteError::Failed(
                    "Squash needs an earlier commit to combine with.".into(),
                ))
            }
            StepAction::Drop => "drop",
        };
        keeps_commit |= !matches!(step.action, StepAction::Drop);
        todo.push_str(action);
        todo.push(' ');
        todo.push_str(&step.hash);
        todo.push('\n');
    }
    if todo.is_empty() {
        todo.push_str("noop\n");
    }
    let scripts = tempfile::tempdir()?;
    let todo_path = scripts.path().join("todo");
    fs::write(&todo_path, todo)?;
    let messages_path = scripts.path().join("messages.json");
    fs::write(
        &messages_path,
        serde_json::to_vec(&messages).map_err(|_| GitError::Unreadable)?,
    )?;
    let script = format!(
        "set -eu\ncp {} \"$1\"\ncp {} \"$(dirname \"$1\")/dirlume-review.json\"\n",
        shell_path(&todo_path)?,
        shell_path(&messages_path)?,
    );
    let sequence = scripts.path().join("sequence-editor.sh");
    fs::write(&sequence, script)?;
    let editor = message_editor(git, root, scripts.path(), &messages)?;
    let options = [
        "-c",
        "rebase.abbreviateCommands=false",
        "rebase",
        "--interactive",
        "--force-rebase",
        "--no-rebase-merges",
        "--no-autosquash",
        "--no-autostash",
        "--no-update-refs",
        "--reapply-cherry-picks",
        "--empty=keep",
        "--onto",
        &reviewed.base,
        &reviewed.base,
    ];
    let output = command(git, root, &options)
        .env(
            "GIT_SEQUENCE_EDITOR",
            format!("sh {}", shell_path(&sequence)?),
        )
        .env("GIT_EDITOR", editor)
        .output()?;
    merge::operation_result(git, root, merge::Operation::Rebase, output)
}

pub(super) fn continue_rebase(git: &Path, root: &Path) -> WriteResult<Output> {
    let messages = match fs::read(writes::git_path(git, root, EDIT_MESSAGES)?) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| GitError::Unreadable)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        Err(error) => return Err(error.into()),
    };
    let scripts = tempfile::tempdir()?;
    let editor = message_editor(git, root, scripts.path(), &messages)?;
    Ok(command(
        git,
        root,
        &[
            "-c",
            "rebase.abbreviateCommands=false",
            "rebase",
            "--continue",
        ],
    )
    .env("GIT_EDITOR", editor)
    .output()?)
}

#[tauri::command]
pub async fn git_rebase_plan(root: String, target: String) -> WriteResult<RebasePlan> {
    history_edits::write(root, move |git, root| plan(git, root, &target)).await
}

#[tauri::command]
pub async fn git_start_rebase(
    root: String,
    review: RebaseReview,
    steps: Vec<RebaseStep>,
) -> WriteResult<()> {
    history_edits::write(root, move |git, root| apply(git, root, &review, &steps)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reorders_rewords_squashes_and_drops_the_reviewed_commits() {
        let git = super::super::executable().unwrap();
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let cli = |args: &[&str]| super::super::tests::git(root, args);
        cli(&["init", "-b", "main"]);
        cli(&["config", "user.name", "Fixture"]);
        cli(&["config", "user.email", "fixture@example.invalid"]);
        cli(&["config", "commit.gpgsign", "false"]);
        cli(&["commit", "--allow-empty", "-m", "Base"]);
        cli(&["switch", "-c", "topic"]);
        for name in ["Alpha", "Beta", "Gamma", "Delta"] {
            fs::write(root.join(name), name).unwrap();
            cli(&["add", "--", name]);
            cli(&["commit", "-m", name]);
        }
        let reviewed = plan(&git, root, "refs/heads/main").unwrap();
        assert_eq!(
            reviewed
                .commits
                .iter()
                .map(|commit| commit.subject.as_str())
                .collect::<Vec<_>>(),
            ["Alpha", "Beta", "Gamma", "Delta"]
        );
        let steps = [
            RebaseStep {
                hash: reviewed.commits[1].hash.clone(),
                action: StepAction::Reword,
                message: Some("Reworded Beta".into()),
            },
            RebaseStep {
                hash: reviewed.commits[0].hash.clone(),
                action: StepAction::Squash,
                message: None,
            },
            RebaseStep {
                hash: reviewed.commits[2].hash.clone(),
                action: StepAction::Drop,
                message: None,
            },
            RebaseStep {
                hash: reviewed.commits[3].hash.clone(),
                action: StepAction::Pick,
                message: None,
            },
        ];
        apply(&git, root, &reviewed.review, &steps).unwrap();
        assert_eq!(
            cli(&["log", "--format=%s", "main..HEAD"]),
            "Delta\nReworded Beta"
        );
        assert_eq!(cli(&["branch", "--show-current"]), "topic");
        assert!(root.join("Alpha").exists());
        assert!(root.join("Beta").exists());
        assert!(!root.join("Gamma").exists());
    }

    #[test]
    fn continues_a_conflicted_rebase_with_the_reviewed_message() {
        let git = super::super::executable().unwrap();
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let cli = |args: &[&str]| super::super::tests::git(root, args);
        cli(&["init", "-b", "main"]);
        cli(&["config", "user.name", "Fixture"]);
        cli(&["config", "user.email", "fixture@example.invalid"]);
        cli(&["config", "commit.gpgsign", "false"]);
        cli(&["config", "core.autocrlf", "false"]);
        fs::write(root.join("shared"), "Base\n").unwrap();
        cli(&["add", "--", "shared"]);
        cli(&["commit", "-m", "Base"]);
        cli(&["switch", "-c", "topic"]);
        fs::write(root.join("shared"), "Topic\n").unwrap();
        cli(&["add", "--", "shared"]);
        cli(&["commit", "-m", "Conflicting change"]);
        fs::write(root.join("later"), "Later\n").unwrap();
        cli(&["add", "--", "later"]);
        cli(&["commit", "-m", "Later"]);
        cli(&["switch", "main"]);
        fs::write(root.join("shared"), "Main\n").unwrap();
        cli(&["add", "--", "shared"]);
        cli(&["commit", "-m", "Main change"]);
        cli(&["switch", "topic"]);
        let review = plan(&git, root, "refs/heads/main").unwrap();
        let steps = [
            RebaseStep {
                hash: review.commits[0].hash.clone(),
                action: StepAction::Pick,
                message: None,
            },
            RebaseStep {
                hash: review.commits[1].hash.clone(),
                action: StepAction::Reword,
                message: Some("Later, with the reviewed message".into()),
            },
        ];
        apply(&git, root, &review.review, &steps).unwrap();
        assert_eq!(
            merge::merge_state(&git, root)
                .unwrap()
                .unwrap()
                .conflicts
                .len(),
            1
        );
        fs::write(root.join("shared"), "Resolved\n").unwrap();
        cli(&["add", "--", "shared"]);
        let resumed = merge::merge_state(&git, root).unwrap().unwrap();
        assert!(resumed.conflicts.is_empty());
        merge::finish(&git, root, &resumed.session, false).unwrap();
        assert!(merge::merge_state(&git, root).unwrap().is_none());
        assert_eq!(
            cli(&["log", "-1", "--format=%s"]),
            "Later, with the reviewed message"
        );
        assert_eq!(
            fs::read_to_string(root.join("shared")).unwrap(),
            "Resolved\n"
        );
    }
}
