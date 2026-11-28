import { useEffect, useId, useState } from "react";
import { api, type GitBisectAction, type GitBisectState, type GitLfsAction, type GitLfsState, type GitRepository,
  type GitSubmodule, type GitWorktree, type GitWorktreeCreate } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { writeError } from "./gitWriteError";
import { t } from "./i18n";

const tabs = { worktrees: "Worktrees", submodules: "Submodules", lfs: "Git LFS", bisect: "Bisect" } as const;
type Tab = keyof typeof tabs;
const submoduleStatus: Record<string, string> = {
  " ": "Initialized", "-": "Not initialized", "+": "Different commit checked out", U: "Conflict",
};
const lfsLabels: Record<GitLfsAction, string> = { fetch: "Fetch LFS objects", pull: "Pull LFS files", push: "Push LFS objects" };
const bisectLabels = { good: "Mark good", bad: "Mark bad", skip: "Skip revision" } as const;

type Review = {
  title: string;
  context: string[];
  explanation?: string;
  apply: () => Promise<void>;
};

function WorktreeForm({ repository, onPrepare, pending }: {
  repository: GitRepository; onPrepare: (review: GitWorktreeCreate) => void; pending: boolean;
}) {
  const [destination, setDestination] = useState("");
  const [mode, setMode] = useState<"branch" | "existing" | "detached">("branch");
  const [revision, setRevision] = useState(repository.headRef ?? repository.head ?? "");
  const [branch, setBranch] = useState("");
  const source = repository.branches.find(({ reference }) => reference === revision);
  const tip = source?.tip ?? (revision === repository.head ? repository.head : null);
  const valid = destination.trim() && tip && (mode === "branch" ? branch.trim() : mode === "detached" || source && !source.remote);
  return <form onSubmit={(event) => {
    event.preventDefault();
    if (valid) onPrepare({ destination: destination.trim(), revision, expectedCommit: tip,
      branch: mode === "branch" ? branch.trim() : null, detach: mode === "detached" });
  }}>
    <label className="field">{t("Worktree path")}
      <input value={destination} disabled={pending} autoComplete="off" spellCheck={false}
        onChange={(event) => setDestination(event.target.value)} />
    </label>
    <label className="field">{t("Checkout mode")}
      <select value={mode} disabled={pending} onChange={(event) => setMode(event.target.value as typeof mode)}>
        <option value="branch">{t("New branch")}</option>
        <option value="existing">{t("Existing local branch")}</option>
        <option value="detached">{t("Detached HEAD")}</option>
      </select>
    </label>
    <label className="field">{t("Starting revision")}
      <select value={revision} disabled={pending} onChange={(event) => setRevision(event.target.value)}>
        {repository.head && !repository.headRef && <option value={repository.head}>HEAD · {repository.head.slice(0, 12)}</option>}
        {repository.branches.map(({ reference }) => <option key={reference}>{reference}</option>)}
      </select>
    </label>
    {mode === "branch" && <label className="field">{t("Branch name")}
      <input value={branch} disabled={pending} autoComplete="off" spellCheck={false} onChange={(event) => setBranch(event.target.value)} />
    </label>}
    <Button type="submit" disabled={!valid || pending}>{t("Create linked worktree")}</Button>
  </form>;
}

export function GitRepositoryTools({ repository, refresh, onRefresh, onOpen, onTerminal }: {
  repository: GitRepository; refresh: number; onRefresh: () => void;
  onOpen: (path: string) => void; onTerminal: (path: string) => void;
}) {
  const root = repository.root;
  const revisions = useId();
  const [picked, setPicked] = useState<Tab>();
  const [worktrees, setWorktrees] = useState<GitWorktree[]>();
  const [submodules, setSubmodules] = useState<GitSubmodule[]>();
  const [lfs, setLfs] = useState<GitLfsState>();
  const [bisect, setBisect] = useState<GitBisectState | null>();
  const [remote, setRemote] = useState("");
  const [good, setGood] = useState("");
  const [bad, setBad] = useState(repository.head ?? "");
  const [review, setReview] = useState<Review>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const tab = picked ?? (bisect ? "bisect" : "worktrees");
  useEffect(() => {
    let canceled = false;
    void api.gitBisectState(root).then((state) => { if (!canceled) setBisect(state); },
      (error: unknown) => { if (!canceled) setError(writeError(error)); });
    return () => { canceled = true; };
  }, [root, refresh]);
  useEffect(() => {
    let canceled = false;
    const fail = (error: unknown) => { if (!canceled) setError(writeError(error)); };
    if (tab === "worktrees") void api.gitWorktrees(root).then((trees) => { if (!canceled) setWorktrees(trees); }, fail);
    else if (tab === "submodules") void api.gitSubmodules(root).then((modules) => { if (!canceled) setSubmodules(modules); }, fail);
    else if (tab === "lfs") void api.gitLfsState(root).then((state) => {
      if (!canceled) {
        setLfs(state);
        setRemote((current) => state.remotes.includes(current) ? current : state.remotes[0] ?? "");
      }
    }, fail);
    return () => { canceled = true; };
  }, [root, tab, refresh]);

  async function execute() {
    if (!review || pending) return;
    setPending(true);
    setError("");
    setResult("");
    try {
      await review.apply();
      setResult(t("Git operation completed."));
    } catch (error) {
      setError(writeError(error));
    } finally {
      setReview(undefined);
      setPending(false);
      onRefresh();
    }
  }
  function updateBisect(action: GitBisectAction, title: string) {
    if (!bisect) return;
    setReview({ title, context: [bisect.head],
      explanation: action === "reset" ? "Restore the original checkout when Git ends the bisect." : undefined,
      apply: () => api.gitUpdateBisect(root, bisect, action) });
  }

  return <div className="git-scroll git-revision-comparison" aria-label={t("Repository tools")}>
    <p><code>{root}</code></p>
    <div className="git-branch-actions" role="group" aria-label={t("Repository tools")}>
      {(Object.keys(tabs) as Tab[]).map((name) => <Button key={name} aria-pressed={tab === name} disabled={pending}
        onClick={() => { setPicked(name); setError(""); setResult(""); }}>{t(tabs[name])}</Button>)}
      <Button onClick={() => onTerminal(root)}>{t("Open terminal at worktree")}</Button>
    </div>
    {pending && <p role="status">{t("Working with Git…")}</p>}
    {error && <p role="alert">{error}</p>}
    {result && <p role="status">{result}</p>}
    {tab === "worktrees" && <>
      {worktrees ? <ul className="git-rebase-list">{worktrees.map((tree) =>
        <li key={tree.path}>
          <p><code>{tree.path}</code></p>
          <p>{tree.branch ?? t(tree.bare ? "Bare repository" : "Detached HEAD")}
            {tree.head && <> · <code title={tree.head}>{tree.head.slice(0, 12)}</code></>}
            {tree.primary && <> · {t("Primary worktree")}</>}
            {tree.locked && <> · {t("Locked worktree")}</>}
            {tree.prunable && <> · {t("Missing worktree")}</>}
          </p>
          <div className="git-branch-actions">
            <Button disabled={pending || tree.path === root || tree.bare || tree.prunable}
              onClick={() => onOpen(tree.path)}>{t("Open worktree")}</Button>
            <Button disabled={pending || tree.path === root || tree.primary || tree.locked}
              onClick={() => setReview({ title: "Remove worktree", context: [tree.path],
                explanation: "Git checks for local changes before removing this worktree.",
                apply: () => api.gitRemoveWorktree(root, tree) })}>{t("Remove worktree")}</Button>
          </div>
        </li>)}</ul> : <p role="status">{t("Reading worktrees…")}</p>}
      {repository.head && <WorktreeForm repository={repository} pending={pending} onPrepare={(request) =>
        setReview({ title: "Create linked worktree", context: [request.destination, request.revision,
          request.expectedCommit, request.branch ?? t(request.detach ? "Detached HEAD" : "Existing local branch")],
        apply: () => api.gitCreateWorktree(root, request) })} />}
    </>}
    {tab === "submodules" && (submodules ? submodules.length ? <ul className="git-rebase-list">
      {submodules.map((item) => <li key={item.path}>
        <p><code>{item.path}</code></p>
        <p>{t(submoduleStatus[item.status] ?? "Unknown")} · <code title={item.head}>{item.head.slice(0, 12)}</code></p>
        <Button disabled={pending || item.status === "U"} onClick={() => setReview({
          title: item.status === "-" ? "Initialize submodule" : "Update submodule", context: [item.path],
          explanation: "Check out the recorded commit in this submodule and its nested submodules.",
          apply: () => api.gitUpdateSubmodule(root, item),
        })}>{t(item.status === "-" ? "Initialize submodule" : "Update submodule")}</Button>
      </li>)}</ul> : <p>{t("No submodules.")}</p> : <p role="status">{t("Reading submodules…")}</p>)}
    {tab === "lfs" && (!lfs ? <p role="status">{t("Reading Git LFS status…")}</p> : !lfs.installed
      ? <p>{t("Git LFS is not installed.")}</p> : <>
        <p><code>{lfs.version}</code></p>
        <pre className="git-patch" tabIndex={0} aria-label={t("Git LFS status")}>{lfs.status}</pre>
        {lfs.remotes.length ? <>
          <label className="field">{t("Remote")}
            <select value={remote} disabled={pending} onChange={(event) => setRemote(event.target.value)}>
              {lfs.remotes.map((name) => <option key={name}>{name}</option>)}
            </select>
          </label>
          <div className="git-branch-actions">
            {(Object.keys(lfsLabels) as GitLfsAction[]).map((action) => <Button disabled={pending || !remote} key={action}
              onClick={() => setReview({ title: lfsLabels[action], context: [remote],
                apply: () => api.gitLfsTransfer(root, remote, action) })}>{t(lfsLabels[action])}</Button>)}
          </div>
        </> : <p>{t("No Git remotes are configured.")}</p>}
      </>)}
    {tab === "bisect" && (bisect === undefined ? <p role="status">{t("Reading bisect state…")}</p> : bisect ? <>
      <p role="status">{t(bisect.concluded ? "Git bisect has a result." : "Bisect in progress")}</p>
      <p>{t("Revision under test")} <code title={bisect.head}>{bisect.head.slice(0, 12)}</code></p>
      <div className="git-branch-actions">
        {(Object.keys(bisectLabels) as (keyof typeof bisectLabels)[]).map((action) =>
          <Button key={action} disabled={pending || bisect.concluded} onClick={() => updateBisect(action, bisectLabels[action])}>
            {t(bisectLabels[action])}</Button>)}
        <Button disabled={pending} onClick={() => updateBisect("reset", bisect.concluded ? "Finish bisect" : "Abort bisect")}>
          {t(bisect.concluded ? "Finish bisect" : "Abort bisect")}</Button>
      </div>
      <pre className="git-patch" tabIndex={0} aria-label={t("Bisect log")}>{bisect.log}</pre>
    </> : <form onSubmit={(event) => {
      event.preventDefault();
      const head = repository.head;
      if (head && good.trim() && bad.trim()) setReview({ title: "Start bisect", context: [good.trim(), bad.trim()],
        apply: () => api.gitStartBisect(root, repository.headRef, head, good.trim(), bad.trim()) });
    }}>
      <label className="field">{t("Known good commit")}<input list={revisions} value={good} disabled={pending}
        autoComplete="off" spellCheck={false} onChange={(event) => setGood(event.target.value)} /></label>
      <label className="field">{t("Known bad commit")}<input list={revisions} value={bad} disabled={pending}
        autoComplete="off" spellCheck={false} onChange={(event) => setBad(event.target.value)} /></label>
      <datalist id={revisions}>{[...new Set(repository.branches.map(({ tip }) => tip))].map((hash) => <option key={hash} value={hash} />)}</datalist>
      <Button type="submit" disabled={pending || !repository.head || !good.trim() || !bad.trim()}>{t("Start bisect")}</Button>
    </form>)}
    {review && <Dialog title={t(review.title)} helpTopic="gitView" onClose={pending ? undefined : () => setReview(undefined)}
      footer={<><Button disabled={pending} onClick={() => setReview(undefined)}>{t("Cancel")}</Button>
        <Button disabled={pending} onClick={() => void execute()}>{t(review.title)}</Button></>}>
      <p><code>{root}</code></p>
      {review.context.map((value, index) => <p key={index}><code>{value}</code></p>)}
      {review.explanation && <p>{t(review.explanation)}</p>}
    </Dialog>}
  </div>;
}
