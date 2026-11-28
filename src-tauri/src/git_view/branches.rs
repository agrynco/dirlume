use super::{directory, executable, line, repository, run, writes, Repository};
use serde::Deserialize;
use std::path::Path;
use writes::WriteError;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BranchAction {
    Create,
    Track,
    Switch,
    Rename,
    Delete,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRequest {
    action: BranchAction,
    expected_head_ref: Option<String>,
    expected_head: Option<String>,
    reference: Option<String>,
    tip: Option<String>,
    name: Option<String>,
}

fn update(git: &Path, root: &Path, request: &BranchRequest) -> Result<Repository, WriteError> {
    writes::verify_branch_head(
        git,
        root,
        request.expected_head_ref.as_deref(),
        request.expected_head.as_deref(),
    )?;
    let state = repository(git, root)?;
    let source = match request.reference.as_deref() {
        Some(reference) => Some(
            state
                .branches
                .iter()
                .find(|branch| {
                    branch.reference == reference
                        && Some(branch.tip.as_str()) == request.tip.as_deref()
                })
                .ok_or(WriteError::Stale)?,
        ),
        None => None,
    };
    let local = || {
        source
            .filter(|branch| !branch.remote)
            .ok_or(WriteError::Stale)
    };
    let name = || -> Result<&str, WriteError> {
        let name = request
            .name
            .as_deref()
            .filter(|name| !name.starts_with('-') && !name.is_empty())
            .ok_or(WriteError::UnsupportedChange)?;
        let reference = format!("refs/heads/{name}");
        if !run(git, root, &["check-ref-format", &reference])?
            .status
            .success()
        {
            return Err(WriteError::Failed(
                "Enter a valid local branch name.".into(),
            ));
        }
        Ok(name)
    };
    let output = match request.action {
        BranchAction::Create => {
            let tip = source
                .map(|branch| branch.tip.as_str())
                .or(state.head.as_deref())
                .ok_or(WriteError::Stale)?;
            run(git, root, &["branch", "--no-track", "--", name()?, tip])
        }
        BranchAction::Track => {
            let branch = source
                .filter(|branch| branch.remote)
                .ok_or(WriteError::Stale)?;
            run(
                git,
                root,
                &["switch", "--track", "-c", name()?, "--", &branch.reference],
            )
        }
        BranchAction::Switch => run(git, root, &["switch", "--no-guess", "--", &local()?.name]),
        BranchAction::Rename => run(
            git,
            root,
            &["branch", "--move", "--", &local()?.name, name()?],
        ),
        BranchAction::Delete => run(git, root, &["branch", "--delete", "--", &local()?.name]),
    }?;
    if !output.status.success() {
        return Err(WriteError::Failed(
            line(output.stderr).unwrap_or_default().trim().to_owned(),
        ));
    }
    Ok(repository(git, root)?)
}

#[tauri::command]
pub async fn git_update_branch(
    root: String,
    request: BranchRequest,
) -> Result<Repository, WriteError> {
    tauri::async_runtime::spawn_blocking(move || {
        update(&executable()?, directory(&root)?, &request)
    })
    .await
    .map_err(|error| WriteError::Failed(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manages_branches_and_rejects_a_stale_review() {
        let git = executable().unwrap();
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let run = |args: &[&str]| super::super::tests::git(root, args);
        run(&["init", "-b", "main"]);
        run(&["config", "user.name", "Fixture"]);
        run(&["config", "user.email", "fixture@example.invalid"]);
        run(&["config", "commit.gpgsign", "false"]);
        std::fs::write(root.join("file.txt"), "first\n").unwrap();
        run(&["add", "--", "file.txt"]);
        run(&["commit", "-m", "Initial"]);
        let tip = run(&["rev-parse", "HEAD"]);
        let mut request = BranchRequest {
            action: BranchAction::Create,
            expected_head_ref: Some("refs/heads/main".into()),
            expected_head: Some(tip.clone()),
            reference: Some("refs/heads/main".into()),
            tip: Some(tip.clone()),
            name: Some("topic".into()),
        };
        assert!(update(&git, root, &request)
            .unwrap()
            .branches
            .iter()
            .any(|branch| branch.name == "topic"));
        request.action = BranchAction::Rename;
        request.reference = Some("refs/heads/topic".into());
        request.name = Some("renamed".into());
        update(&git, root, &request).unwrap();
        request.reference = Some("refs/heads/renamed".into());
        request.action = BranchAction::Switch;
        std::fs::write(root.join("file.txt"), "working\n").unwrap();
        let switched = update(&git, root, &request).unwrap();
        assert_eq!(switched.head_ref.as_deref(), Some("refs/heads/renamed"));
        assert_eq!(
            std::fs::read_to_string(root.join("file.txt")).unwrap(),
            "working\n"
        );
        request.action = BranchAction::Delete;
        assert!(matches!(
            update(&git, root, &request),
            Err(WriteError::Stale)
        ));
        request.expected_head_ref = switched.head_ref;
        request.reference = Some("refs/heads/main".into());
        assert!(!update(&git, root, &request)
            .unwrap()
            .branches
            .iter()
            .any(|branch| branch.name == "main"));
        run(&["remote", "add", "origin", "."]);
        run(&["update-ref", "refs/remotes/origin/topic", &tip]);
        request.action = BranchAction::Track;
        request.reference = Some("refs/remotes/origin/topic".into());
        request.name = Some("tracking".into());
        let tracked = update(&git, root, &request).unwrap();
        assert_eq!(tracked.head_ref.as_deref(), Some("refs/heads/tracking"));
        assert_eq!(
            run(&["rev-parse", "--symbolic-full-name", "@{upstream}"]),
            "refs/remotes/origin/topic"
        );
    }
}
