import { useEffect, useId, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Bug, Check, CircleDot, CloudDownload, FolderOpen, GitBranchPlus, HardDrive,
  Layers, Package, Square, StepForward, Terminal, Trash2, X } from "lucide-react";
import { api, type GitBisectAction, type GitBisectState, type GitLfsAction, type GitLfsState, type GitRepository,
  type GitSubmodule, type GitWorktree, type GitWorktreeCreate } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { GitActionButtons, useGitMenu, type GitAction } from "./GitActions";
import { writeError } from "./gitWriteError";
import { t } from "./i18n";

const tabs = { worktrees: "Worktrees", submodules: "Submodules", lfs: "Git LFS", bisect: "Bisect" } as const;
const tabIcons = { worktrees: HardDrive, submodules: Layers, lfs: Package, bisect: Bug };
const tabHints = {
  worktrees: "Show linked worktrees.",
  submodules: "Inspect and update submodules.",
  lfs: "Inspect or transfer Git LFS objects.",
  bisect: "Find the commit that introduced a regression.",
};
type Tab = keyof typeof tabs;
const submoduleStatus: Record<string, string> = {
  " ": "Initialized", "-": "Not initialized", "+": "Different commit checked out", U: "Conflict",
};
const lfsLabels: Record<GitLfsAction, string> = { fetch: "Fetch LFS objects", pull: "Pull LFS files", push: "Push LFS objects" };
const lfsIcons = { fetch: CloudDownload, pull: ArrowDownToLine, push: ArrowUpFromLine };
const bisectLabels = { good: "Mark good", bad: "Mark bad", skip: "Skip revision" } as const;
const bisectIcons = { good: Check, bad: X, skip: StepForward } as const;

type Review = {
  title: string;
  fields: { label: string; value: string }[];
  destructive?: boolean;
  explanation?: string;
  apply: () => Promise<void>;
};

function WorktreeForm({ repository, onPrepare, pending }: {
  repository: GitRepository; onPrepare: (review: GitWorktreeCreate) => void; pending: boolean;
}) {
  const menu = useGitMenu();
  const [destination, setDestination] = useState("");
  const [mode, setMode] = useState<"branch" | "existing" | "detached">("branch");
  const [revision, setRevision] = useState(repository.headRef ?? repository.head ?? "");
  const [branch, setBranch] = useState("");
  const source = repository.branches.find(({ reference }) => reference === revision);
  const tip = source?.tip ?? (revision === repository.head ? repository.head : null);
  const valid = destination.trim() && tip && (mode === "branch" ? branch.trim() : mode === "detached" || source && !source.remote);
  function prepare() {
    if (valid) onPrepare({ destination: destination.trim(), revision, expectedCommit: tip,
      branch: mode === "branch" ? branch.trim() : null, detach: mode === "detached" });
  }
  const create: GitAction = { label: "Create linked worktree", icon: GitBranchPlus, disabled: !valid || pending, run: prepare, submit: true };
  return <form {...menu([create])} onSubmit={(event) => { event.preventDefault(); prepare(); }}>
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
    <GitActionButtons actions={[create]} />
  </form>;
}

export function GitRepositoryTools({ repository, refresh, bisectTarget, onRefresh, onOpen, onTerminal }: {
  repository: GitRepository; refresh: number; onRefresh: () => void;
  bisectTarget?: { field: "good" | "bad"; revision: string };
  onOpen: (path: string) => void; onTerminal: (path: string) => void;
}) {
  const menu = useGitMenu();
  const root = repository.root;
  const revisions = useId();
  const [picked, setPicked] = useState<Tab | undefined>(bisectTarget ? "bisect" : undefined);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>();
  const [submodules, setSubmodules] = useState<GitSubmodule[]>();
  const [lfs, setLfs] = useState<GitLfsState>();
  const [bisect, setBisect] = useState<GitBisectState | null>();
  const [remote, setRemote] = useState("");
  const [good, setGood] = useState(bisectTarget?.field === "good" ? bisectTarget.revision : "");
  const [bad, setBad] = useState(bisectTarget?.field === "bad" ? bisectTarget.revision : repository.head ?? "");
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
    setReview({ title, fields: [{ label: "Revision under test", value: bisect.head }],
      explanation: action === "reset" ? "Restore the original checkout when Git ends the bisect." : undefined,
      apply: () => api.gitUpdateBisect(root, bisect, action) });
  }
  const repositoryActions: GitAction[] = [
    ...(Object.keys(tabs) as Tab[]).map((name) => ({
      label: tabs[name], icon: tabIcons[name], tooltip: tabHints[name], pressed: name === tab, disabled: pending,
      run: () => { setPicked(name); setError(""); setResult(""); },
    })),
    { label: "Open terminal at worktree", icon: Terminal, tooltip: "Open the built-in terminal in this worktree.", run: () => onTerminal(root) },
  ];
  function worktreeActions(tree: GitWorktree): GitAction[] {
    return [
      { label: "Open worktree", icon: FolderOpen, disabled: pending || tree.path === root || tree.bare || tree.prunable,
        run: () => onOpen(tree.path) },
      { label: "Remove worktree", icon: Trash2, destructive: true, disabled: pending || tree.path === root || tree.primary || tree.locked,
        run: () => setReview({ title: "Remove worktree", destructive: true,
          fields: [
            { label: "Worktree folder to remove", value: tree.path },
            { label: "Checked-out revision", value: tree.branch?.replace(/^refs\/heads\//, "") ??
              (tree.head ? `${t("Detached HEAD")} · ${tree.head}` : t("Detached HEAD")) },
          ],
          explanation: "Git removes the worktree folder and keeps its branch. Local changes prevent removal.",
          apply: () => api.gitRemoveWorktree(root, tree) }) },
    ];
  }
  const lfsActions: GitAction[] = (Object.keys(lfsLabels) as GitLfsAction[]).map((action) => ({
    label: lfsLabels[action], icon: lfsIcons[action], disabled: pending || !remote,
    run: () => setReview({ title: lfsLabels[action], fields: [{ label: "Remote name", value: remote }],
      apply: () => api.gitLfsTransfer(root, remote, action) }),
  }));
  const bisectEnd = bisect?.concluded ? "Finish bisect" : "Abort bisect";
  const bisectActions: GitAction[] = [
    ...(Object.keys(bisectLabels) as (keyof typeof bisectLabels)[]).map((action) => ({
      label: bisectLabels[action], icon: bisectIcons[action], disabled: pending || !!bisect?.concluded,
      run: () => updateBisect(action, bisectLabels[action]),
    })),
    { label: bisectEnd, icon: Square, disabled: pending, destructive: !bisect?.concluded, run: () => updateBisect("reset", bisectEnd) },
  ];
  const startBisect: GitAction = {
    label: "Start bisect", icon: CircleDot, disabled: pending || !repository.head || !good.trim() || !bad.trim(), submit: true,
    run: () => {
      const head = repository.head;
      if (head && good.trim() && bad.trim()) setReview({ title: "Start bisect", fields: [
        { label: "Known good commit", value: good.trim() },
        { label: "Known bad commit", value: bad.trim() },
      ], apply: () => api.gitStartBisect(root, repository.headRef, head, good.trim(), bad.trim()) });
    },
  };

  return <div className="git-scroll git-revision-comparison" aria-label={t("Repository tools")} tabIndex={-1}
    {...menu([...repositoryActions, ...(tab === "bisect" ? bisect ? bisectActions : [startBisect] :
      tab === "lfs" && lfs?.installed ? lfsActions : [])])}>
    <p><code>{root}</code></p>
    <div className="git-branch-actions" role="group" aria-label={t("Repository tools")}>
      <GitActionButtons actions={repositoryActions} />
    </div>
    {pending && <p role="status">{t("Working with Git…")}</p>}
    {error && <p role="alert">{error}</p>}
    {result && <p role="status">{result}</p>}
    {tab === "worktrees" && <>
      {worktrees ? <ul className="git-rebase-list git-worktrees">{worktrees.map((tree) => {
        const actions = worktreeActions(tree);
        return <li key={tree.path} tabIndex={0} {...menu([
          ...actions,
          { label: "Open terminal at worktree", icon: Terminal, disabled: pending || tree.bare || tree.prunable,
            run: () => onTerminal(tree.path) },
        ], tree.path)}>
          <p><code>{tree.path}</code></p>
          <p>{tree.branch ?? t(tree.bare ? "Bare repository" : "Detached HEAD")}
            {tree.head && <> · <code title={tree.head}>{tree.head.slice(0, 12)}</code></>}
            {tree.primary && <> · {t("Primary worktree")}</>}
            {tree.locked && <> · {t("Locked worktree")}</>}
            {tree.prunable && <> · {t("Missing worktree")}</>}
          </p>
          <div className="git-branch-actions">
            <GitActionButtons actions={actions} />
          </div>
        </li>; })}</ul> : <p role="status">{t("Reading worktrees…")}</p>}
      {repository.head && <WorktreeForm repository={repository} pending={pending} onPrepare={(request) =>
        setReview({ title: "Create linked worktree", fields: [
          { label: "Worktree path", value: request.destination },
          { label: "Starting revision", value: request.revision },
          { label: "Starting commit", value: request.expectedCommit },
          request.branch !== null ? { label: "Branch name", value: request.branch } :
            { label: "Checkout mode", value: t(request.detach ? "Detached HEAD" : "Existing local branch") },
        ],
        apply: () => api.gitCreateWorktree(root, request) })} />}
    </>}
    {tab === "submodules" && (submodules ? submodules.length ? <ul className="git-rebase-list">
      {submodules.map((item) => {
        const label = item.status === "-" ? "Initialize submodule" : "Update submodule";
        const actions: GitAction[] = [{ label, icon: Layers, disabled: pending || item.status === "U",
          run: () => setReview({ title: label, fields: [{ label: "Submodule path", value: item.path }],
            explanation: "Check out the recorded commit in this submodule and its nested submodules.",
            apply: () => api.gitUpdateSubmodule(root, item) }) }];
        return <li key={item.path} tabIndex={0} {...menu(actions, item.path)}>
        <p><code>{item.path}</code></p>
        <p>{t(submoduleStatus[item.status] ?? "Unknown")} · <code title={item.head}>{item.head.slice(0, 12)}</code></p>
        <GitActionButtons actions={actions} />
      </li>; })}</ul> : <p>{t("No submodules.")}</p> : <p role="status">{t("Reading submodules…")}</p>)}
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
            <GitActionButtons actions={lfsActions} />
          </div>
        </> : <p>{t("No Git remotes are configured.")}</p>}
      </>)}
    {tab === "bisect" && (bisect === undefined ? <p role="status">{t("Reading bisect state…")}</p> : bisect ? <>
      <p role="status">{t(bisect.concluded ? "Git bisect has a result." : "Bisect in progress")}</p>
      <p>{t("Revision under test")} <code title={bisect.head}>{bisect.head.slice(0, 12)}</code></p>
      <div className="git-branch-actions">
        <GitActionButtons actions={bisectActions} />
      </div>
      <pre className="git-patch" tabIndex={0} aria-label={t("Bisect log")}>{bisect.log}</pre>
    </> : <form onSubmit={(event) => { event.preventDefault(); startBisect.run(); }}>
      <label className="field">{t("Known good commit")}<input list={revisions} value={good} disabled={pending}
        autoComplete="off" spellCheck={false} onChange={(event) => setGood(event.target.value)} /></label>
      <label className="field">{t("Known bad commit")}<input list={revisions} value={bad} disabled={pending}
        autoComplete="off" spellCheck={false} onChange={(event) => setBad(event.target.value)} /></label>
      <datalist id={revisions}>{[...new Set(repository.branches.map(({ tip }) => tip))].map((hash) => <option key={hash} value={hash} />)}</datalist>
      <GitActionButtons actions={[startBisect]} />
    </form>)}
    {review && <Dialog title={t(review.title)} helpTopic="gitView" tone={review.destructive ? "warning" : undefined}
      onClose={pending ? undefined : () => setReview(undefined)}
      footer={<><Button disabled={pending} data-initial-focus={review.destructive || undefined}
        onClick={() => setReview(undefined)}>{t("Cancel")}</Button>
        <Button disabled={pending} className={review.destructive ? "negative" : undefined}
          onClick={() => void execute()}>{t(review.title)}</Button></>}>
      <div className="dialog-body git-tools-review">
        <dl>
          {[...review.fields, { label: "Repository folder", value: root }].map(({ label, value }) => <div key={label}>
            <dt>{t(label)}</dt>
            <dd><code>{value}</code></dd>
          </div>)}
        </dl>
        {review.explanation && <p>{t(review.explanation)}</p>}
      </div>
    </Dialog>}
  </div>;
}
