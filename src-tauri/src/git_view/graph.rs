use super::{
    bounded, command, comparison::resolve_commit, directory, executable, oid, process_error, query,
    run, success, Commit, GitError, Result,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    path::Path,
    process::Stdio,
};

const PAGE_SIZE: usize = 250;
const PAGE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphQuery {
    base: String,
    target: Option<String>,
    search: String,
    offset: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphPage {
    base: String,
    target: Option<String>,
    commits: Vec<GraphCommit>,
    next_offset: Option<u32>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Side {
    Shared,
    Base,
    Target,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphCommit {
    #[serde(flatten)]
    commit: Commit,
    parents: Vec<String>,
    side: Option<Side>,
}

fn comparison_sides(
    git: &Path,
    root: &Path,
    base: &str,
    target: &str,
    commits: &mut [GraphCommit],
) -> Result<()> {
    let mut sides: HashMap<_, _> = commits
        .iter()
        .map(|row| (row.commit.hash.clone(), Side::Shared))
        .collect();
    if base != target && !sides.is_empty() {
        // rev-list streams only the symmetric difference. Page rows absent from it are shared.
        let range = format!("{base}...{target}");
        let mut child = command(git, root, &["rev-list", "--left-right", &range, "--"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(process_error)?;
        let mut remaining = sides.len();
        let result = (|| {
            let stdout = child.stdout.take().ok_or(GitError::Unreadable)?;
            for line in BufReader::new(stdout).lines() {
                let line = line.map_err(process_error)?;
                let (side, hash) = match line.as_bytes().first() {
                    Some(b'<') => (Side::Base, &line[1..]),
                    Some(b'>') => (Side::Target, &line[1..]),
                    _ => return Err(GitError::Unreadable),
                };
                if let Some(value) = sides.get_mut(hash) {
                    *value = side;
                    remaining -= 1;
                    if remaining == 0 {
                        return Ok(true);
                    }
                }
            }
            Ok(false)
        })();
        if !matches!(result, Ok(false)) {
            let _ = child.kill();
        }
        let status = child.wait().map_err(process_error)?;
        if !result? && !status.success() {
            return Err(GitError::Unreadable);
        }
    }
    for commit in commits {
        commit.side = sides.get(&commit.commit.hash).copied();
    }
    Ok(())
}

fn page(git: &Path, root: &Path, request: &GraphQuery) -> Result<GraphPage> {
    let base = resolve_commit(git, root, &request.base)?;
    let target = request
        .target
        .as_deref()
        .map(|revision| resolve_commit(git, root, revision))
        .transpose()?;
    let search = request.search.trim();
    if search.len() > 800 || search.contains('\0') {
        return Err(GitError::Unreadable);
    }
    let grep = format!("--grep={search}");
    let skip = format!("--skip={}", request.offset);
    let limit = format!("--max-count={}", PAGE_SIZE + 1);
    let mut args = vec![
        "log",
        "-z",
        "--topo-order",
        "--no-color",
        "--no-decorate",
        "--no-notes",
        "--no-show-signature",
        "--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%P",
        &skip,
        &limit,
    ];
    if !search.is_empty() {
        args.extend(["--fixed-strings", "--regexp-ignore-case", &grep]);
    }
    args.push(&base);
    if let Some(target) = &target {
        args.push(target);
    }
    args.push("--");
    let data = bounded(git, root, &args, PAGE_BYTES)?.ok_or(GitError::Unreadable)?;
    let data = String::from_utf8_lossy(&data);
    let mut fields: Vec<_> = data.split('\0').collect();
    if fields.last() == Some(&"") {
        fields.pop();
    }
    let (records, remainder) = fields.as_chunks::<6>();
    if !remainder.is_empty() {
        return Err(GitError::Unreadable);
    }
    let mut commits: Vec<_> = records
        .iter()
        .take(PAGE_SIZE)
        .map(|fields| GraphCommit {
            commit: Commit {
                hash: fields[0].into(),
                short_hash: fields[1].into(),
                author: fields[2].into(),
                date: fields[3].into(),
                subject: fields[4].into(),
            },
            parents: fields[5].split_whitespace().map(str::to_owned).collect(),
            side: None,
        })
        .collect();
    if let Some(target) = &target {
        comparison_sides(git, root, &base, target, &mut commits)?;
    }
    Ok(GraphPage {
        base,
        target,
        commits,
        next_offset: (records.len() > PAGE_SIZE)
            .then_some(request.offset.saturating_add(PAGE_SIZE as u32)),
    })
}

#[derive(Serialize)]
pub struct GraphUpstream {
    reference: String,
    tip: String,
}

fn branch_upstream(git: &Path, root: &Path, reference: &str) -> Result<Option<GraphUpstream>> {
    if !reference.starts_with("refs/heads/") || resolve_commit(git, root, reference).is_err() {
        return Ok(None);
    }
    let data = success(run(
        git,
        root,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(upstream)",
            "--",
            reference,
        ],
    )?)?;
    let upstream = String::from_utf8_lossy(&data);
    let Some(upstream) = upstream
        .lines()
        .filter_map(|line| line.split_once('\0'))
        .find_map(|(branch, upstream)| {
            (branch == reference && !upstream.is_empty()).then_some(upstream)
        })
    else {
        return Ok(None);
    };
    let tip = match resolve_commit(git, root, upstream) {
        Ok(tip) => tip,
        Err(GitError::MissingObject) => return Ok(None),
        Err(error) => return Err(error),
    };
    oid(&tip)?;
    Ok(Some(GraphUpstream {
        reference: upstream.into(),
        tip,
    }))
}

#[tauri::command]
pub async fn git_commit_graph(root: String, request: GraphQuery) -> Result<GraphPage> {
    query(move || page(&executable()?, directory(&root)?, &request)).await
}

#[tauri::command]
pub async fn git_graph_upstream(root: String, reference: String) -> Result<Option<GraphUpstream>> {
    query(move || branch_upstream(&executable()?, directory(&root)?, &reference)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Write};

    fn fixture(git: &Path, root: &Path) {
        invoke(git, root, &["init", "-b", "main"]);
        invoke(
            git,
            root,
            &["config", "user.email", "fixture@example.invalid"],
        );
        invoke(git, root, &["config", "user.name", "Fixture Author"]);
    }

    fn invoke(git: &Path, root: &Path, args: &[&str]) -> String {
        let output = run(git, root, args).unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    fn commit(git: &Path, root: &Path, name: &str, subject: &str) -> String {
        fs::write(root.join(name), subject).unwrap();
        invoke(git, root, &["add", "--", name]);
        invoke(git, root, &["commit", "-m", subject]);
        invoke(git, root, &["rev-parse", "HEAD"])
    }

    fn graph(
        git: &Path,
        root: &Path,
        base: &str,
        target: Option<&str>,
        search: &str,
        offset: u32,
    ) -> GraphPage {
        page(
            git,
            root,
            &GraphQuery {
                base: base.into(),
                target: target.map(str::to_owned),
                search: search.into(),
                offset,
            },
        )
        .unwrap()
    }

    #[test]
    fn reads_real_parent_edges_and_classifies_upstream_and_revision_pairs() {
        let git = executable().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fixture(&git, root);
        let common = commit(&git, root, "common", "Root");
        invoke(&git, root, &["switch", "-c", "topic"]);
        let topic = commit(&git, root, "topic", "Feature needle [fix]");
        invoke(&git, root, &["tag", "-a", "tagged", "-m", "Topic tag"]);
        invoke(&git, root, &["switch", "main"]);
        let local = commit(&git, root, "local", "Main");
        invoke(
            &git,
            root,
            &["remote", "add", "origin", root.to_str().unwrap()],
        );
        invoke(
            &git,
            root,
            &["update-ref", "refs/remotes/origin/topic", &topic],
        );
        invoke(
            &git,
            root,
            &["branch", "--set-upstream-to=origin/topic", "main"],
        );
        let upstream = branch_upstream(&git, root, "refs/heads/main")
            .unwrap()
            .unwrap();
        assert_eq!(upstream.reference, "refs/remotes/origin/topic");
        assert_eq!(upstream.tip, topic);
        assert!(branch_upstream(&git, root, "refs/heads/topic")
            .unwrap()
            .is_none());

        let diverged = graph(&git, root, &local, Some("refs/tags/tagged"), "", 0);
        let sides: HashMap<_, _> = diverged
            .commits
            .iter()
            .map(|row| (row.commit.hash.as_str(), row.side))
            .collect();
        assert_eq!(sides.len(), 3);
        assert_eq!(sides[local.as_str()], Some(Side::Base));
        assert_eq!(sides[topic.as_str()], Some(Side::Target));
        assert_eq!(sides[common.as_str()], Some(Side::Shared));
        let found = graph(&git, root, &local, Some(&topic), "NEEDLE [FIX]", 0);
        assert_eq!(found.commits.len(), 1);
        assert_eq!(found.commits[0].parents, [common.as_str()]);
        assert_eq!(found.commits[0].side, Some(Side::Target));

        invoke(
            &git,
            root,
            &["merge", "--no-ff", "topic", "-m", "Merge topic"],
        );
        let merged = invoke(&git, root, &["rev-parse", "HEAD"]);
        let history = graph(&git, root, &merged, None, "", 0);
        assert_eq!(history.commits[0].parents, [local.as_str(), topic.as_str()]);
        assert_eq!(history.commits[0].side, None);
        for (base, target, expected) in [
            (&merged, &topic, Side::Base),
            (&topic, &merged, Side::Target),
        ] {
            let page = graph(&git, root, base, Some(target), "", 0);
            assert_eq!(page.commits.len(), 4);
            assert_eq!(page.commits[0].side, Some(expected));
        }
        assert!(graph(&git, root, &topic, Some(&topic), "", 0)
            .commits
            .iter()
            .all(|row| row.side == Some(Side::Shared)));
        assert_eq!(invoke(&git, root, &["rev-parse", "HEAD"]), merged);
        assert_eq!(invoke(&git, root, &["status", "--porcelain"]), "");
    }

    #[test]
    fn paginates_pinned_history_and_searches_beyond_the_first_page() {
        let git = executable().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fixture(&git, root);
        let main = commit(&git, root, "main", "Unrelated branch");
        let mut import = command(&git, root, &["fast-import", "--quiet"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        {
            let mut input = import.stdin.take().unwrap();
            for step in 0..253 {
                let message = if step == 0 {
                    "Oldest LITERAL [CI]".to_owned()
                } else {
                    format!("Number {step}")
                };
                write!(input, "commit refs/heads/long\ncommitter Fixture Author <fixture@example.invalid> {} +0000\ndata {}\n{message}\n\n",
                    1_500_000_000 + step, message.len()).unwrap();
            }
        }
        assert!(import.wait().unwrap().success());
        let first = graph(&git, root, "refs/heads/long", None, "", 0);
        assert_eq!(first.commits.len(), 250);
        let offset = first.next_offset.unwrap();
        invoke(&git, root, &["update-ref", "refs/heads/long", &main]);
        let second = graph(&git, root, &first.base, None, "", offset);
        assert_eq!(second.commits.len(), 3);
        assert_eq!(second.next_offset, None);
        assert_eq!(
            first.commits.last().unwrap().parents[0],
            second.commits[0].commit.hash
        );
        assert_eq!(
            second.commits.last().unwrap().commit.subject,
            "Oldest LITERAL [CI]"
        );
        let found = graph(&git, root, &first.base, None, "literal [ci]", 0);
        assert_eq!(found.commits.len(), 1);
        assert_eq!(
            found.commits[0].commit.hash,
            second.commits.last().unwrap().commit.hash
        );
        let unrelated = graph(&git, root, &main, Some(&first.base), "", 0);
        assert!(unrelated
            .commits
            .iter()
            .all(|row| row.side != Some(Side::Shared)));
        assert!(unrelated
            .commits
            .iter()
            .any(|row| row.side == Some(Side::Base)));
        assert!(unrelated
            .commits
            .iter()
            .any(|row| row.side == Some(Side::Target)));
    }
}
