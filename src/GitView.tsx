import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Bug, Check, Copy, Eye, FileClock, FolderGit2, GitBranch, GitBranchPlus, GitCommitHorizontal, GitCompareArrows,
  GitFork, GitMerge as MergeIcon, History as HistoryIcon, Network, Pencil, RotateCw, Search, Settings, Trash2, Undo2, Upload, X } from "lucide-react";
import { api, type GitBranch as Branch, type GitBranchAction, type GitBranchRequest, type GitCommit, type GitDetails, type GitFileLaunch, type GitHistory, type GitMergeState, type GitRepository, type NamedFile } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { GitActionButtons, GitActionMenuProvider, useGitMenu, type GitAction } from "./GitActions";
import { GitBlameViewer } from "./GitBlameViewer";
import { GitChanges } from "./GitChanges";
import { GitCommitGraph } from "./GitCommitGraph";
import { GitFileHistory } from "./GitFileHistory";
import { writeError } from "./gitWriteError";
import { GitHistoryTools, type HistoryAction } from "./GitHistoryTools";
import { GitMerge, gitOperationStatus } from "./GitMerge";
import { GitRepositoryTools } from "./GitRepositoryTools";
import { GitRepositorySetup } from "./GitRepositorySetup";
import { GitRevisionComparison, GitRevisionChange } from "./GitRevisionComparison";
import { GitSyncTools } from "./GitSyncTools";
import { GitWorkingComparison } from "./GitWorkingComparison";
import type { ComparisonShortcuts } from "./TextTools";
import { t } from "./i18n";
import { useTimestamps } from "./useTimestamps";
import { opposite, type Side } from "./panes";

function gitError(error: unknown) {
  switch (error instanceof Error ? error.message : error) {
    case "missingGit": return t("Git is unavailable. Install Git and open Git View again.");
    case "notRepository": return t("This folder is outside a Git working tree.");
    case "missingObject": return t("A required Git object is missing from this local repository.");
    default: return t("Could not read the Git repository.");
  }
}

const statusLabels: Readonly<Record<string, string>> = {
  A: "Added", M: "Modified", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed",
};

const branchActions: Record<GitBranchAction, string> = {
  create: "Create branch", track: "Create tracking branch and switch", switch: "Switch branch",
  rename: "Rename branch", delete: "Delete branch",
};
const branchIcons = { create: GitBranchPlus, track: GitFork, switch: GitBranch, rename: Pencil, delete: Trash2 };
const branchHints = {
  create: "Create a branch from the selected revision.",
  track: "Create and check out a local tracking branch.",
  switch: "Check out the selected local branch.",
  rename: "Rename the selected local branch.",
  delete: "Review deletion of the selected local branch.",
};

type HistoricalPath = { path: string; tip: string; mode: "history" | "blame" };
type InspectCommit = {
  shortcuts: ComparisonShortcuts;
  actions: (commit: GitCommit, showDetails?: () => void) => GitAction[];
  openPath: (target: HistoricalPath) => void;
  copy: (value: string, message: string) => void;
};

function ChangeDetails({ root, commit, onTarget, inspect, highlight }: {
  root: string; commit: GitCommit; onTarget?: (hash: string) => void; inspect: InspectCommit; highlight?: string;
}) {
  const menu = useGitMenu();
  const [details, setDetails] = useState<GitDetails | null>(null);
  const [error, setError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [diff, setDiff] = useState<GitDetails["changes"][number]>();
  const detailActions: GitAction[] = [
    { label: "Copy commit hash", icon: Copy, run: () => {
      void api.copyText(commit.hash).then(() => setCopyStatus(t("Commit hash copied.")),
        () => setCopyStatus(t("Could not copy the commit hash.")));
    } },
    ...(onTarget ? [{ label: "Use in history actions", icon: HistoryIcon, run: () => onTarget(commit.hash) }] : []),
  ];
  useEffect(() => {
    let canceled = false;
    void api.gitDetails(root, commit.hash).then((result) => { if (!canceled) setDetails(result); },
      (error: unknown) => { if (!canceled) setError(gitError(error)); });
    return () => { canceled = true; };
  }, [root, commit.hash]);
  return <section className="git-details" aria-label={t("Commit details")}>
    <header {...menu(inspect.actions(commit), commit.shortHash)}>
      <code title={commit.hash}>{commit.shortHash}</code>
      <GitActionButtons actions={detailActions} />
    </header>
    {copyStatus && <p role="status">{copyStatus}</p>}
    {error ? <p role="alert">{error}</p> : details ? <>
      <pre>{details.message || commit.subject}</pre>
      <h3>{t(details.merge ? "Changed paths relative to the first parent" : "Changed paths")}</h3>
      {details.changes.length ? <ul>
        {details.changes.map((change) => {
          const { status, path, previousPath } = change;
          const historicalTip = status === "D" ? details.firstParent : commit.hash;
          const historicalPath = status === "D" ? previousPath ?? path : path;
          return <li key={path} tabIndex={0} data-highlight={path === highlight || previousPath === highlight || undefined} {...menu([
            { label: "Show change", icon: GitCompareArrows, run: () => setDiff(change) },
            { label: "File history", icon: FileClock, run: () => inspect.openPath({ path, tip: commit.hash, mode: "history" }) },
            { label: "Show blame", icon: Search, disabled: !historicalTip,
              run: () => { if (historicalTip) inspect.openPath({ path: historicalPath, tip: historicalTip, mode: "blame" }); } },
            { label: "Copy path", icon: Copy, run: () => inspect.copy(path, "Path copied to the clipboard.") },
          ], previousPath ? previousPath + " → " + path : path)}>
            <span>{t(statusLabels[status] ?? status)}</span>
            <span>{previousPath ? previousPath + " → " + path : path}</span>
          </li>;
        })}
      </ul> : <p>{t("No changed paths.")}</p>}
      {diff && <Dialog title={t("Change preview")} helpTopic="gitView" wide onClose={() => setDiff(undefined)}>
        <div className="dialog-body">
          <p>{diff.previousPath ? diff.previousPath + " → " + diff.path : diff.path}</p>
          <GitRevisionChange root={root} base={details.firstParent ?? null} target={commit.hash} change={diff} shortcuts={inspect.shortcuts} />
        </div>
      </Dialog>}
    </> : <p role="status">{t("Loading commit details…")}</p>}
  </section>;
}

function History({ root, tip, onTarget, inspect }: {
  root: string; tip?: string; onTarget: (hash: string) => void; inspect: InspectCommit;
}) {
  const menu = useGitMenu();
  const [result, setResult] = useState<GitHistory>({ commits: [], nextOffset: tip ? 0 : null });
  const [request, setRequest] = useState<{ offset: number } | null>(tip ? { offset: 0 } : null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!tip || !request) return;
    let canceled = false;
    void api.gitHistory(root, tip, request.offset).then((page) => {
      if (!canceled) setResult((current) => ({
        commits: request.offset === 0 ? page.commits : [...current.commits, ...page.commits], nextOffset: page.nextOffset,
      }));
    }, (error: unknown) => {
      if (!canceled) setError(gitError(error));
    }).finally(() => {
      if (!canceled) setRequest(null);
    });
    return () => { canceled = true; };
  }, [root, tip, request]);
  const formatDate = useTimestamps(result.commits.map(({ date }) => Math.floor(Date.parse(date) / 1000)));
  return <div className="git-history git-scroll">
    {result.commits.map((commit) => <div className="git-commit" key={commit.hash}>
      <Button type="button" aria-expanded={open === commit.hash} onClick={() => setOpen(open === commit.hash ? null : commit.hash)}
        {...menu(inspect.actions(commit, () => setOpen(commit.hash)), commit.shortHash)}>
        <GitCommitHorizontal aria-hidden="true" />
        <span><strong>{commit.subject || t("No subject")}</strong>
          <small>{commit.author}{Number.isFinite(Date.parse(commit.date)) &&
            <> <span aria-hidden="true">·</span> {formatDate(Math.floor(Date.parse(commit.date) / 1000))}</>}</small></span>
        <code>{commit.shortHash}</code>
      </Button>
      {open === commit.hash && <ChangeDetails root={root} commit={commit} onTarget={onTarget} inspect={inspect} />}
    </div>)}
    {request && <p className="pane-empty" role="status">{t("Loading commits…")}</p>}
    {error && <p className="pane-empty git-error" role="alert">{error}</p>}
    {!request && !error && !result.commits.length && <p className="pane-empty">{t("No commits yet")}</p>}
    {!request && result.nextOffset !== null && <Button className="git-load-more" onClick={() => {
      setError("");
      if (result.nextOffset !== null) setRequest({ offset: result.nextOffset });
    }}>{t(error ? "Retry" : "Load more")}</Button>}
  </div>;
}

export default function GitView(props: GitViewProps & { menuShortcut: readonly string[] }) {
  return <GitActionMenuProvider shortcut={props.menuShortcut} revision={props.refresh}><GitViewContent {...props} /></GitActionMenuProvider>;
}

type GitViewProps = {
  path: string;
  side: Side;
  refresh: number;
  onRefresh: () => void;
  onClose: () => void;
  onOpen: (file: NamedFile, editing: boolean) => void;
  onOpenWorktree: (path: string) => void;
  onTerminal: (path: string) => void;
  canEdit: (file: NamedFile) => boolean;
  file?: GitFileLaunch;
  compareShortcuts: ComparisonShortcuts;
};

function GitViewContent({ path, side, refresh, onRefresh, onClose, onOpen, onOpenWorktree, onTerminal, canEdit, file, compareShortcuts }: GitViewProps) {
  const menu = useGitMenu();
  const [repository, setRepository] = useState<GitRepository | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState("");
  const [changes, setChanges] = useState(file?.action === "diff");
  const [historyMode, setHistoryMode] = useState<"history" | "graph" | "file" | "compare" | "merge" | "tools" | "repository" | "sync">
    (file?.action === "history" ? "file" : "history");
  const [historyTarget, setHistoryTarget] = useState<{ revision: string; action?: HistoryAction }>();
  const [compareTarget, setCompareTarget] = useState<string>();
  const [fileTarget, setFileTarget] = useState<HistoricalPath | undefined>(file?.action === "history" ?
    { path: file.path, tip: file.head, mode: "history" } : undefined);
  const [blameTarget, setBlameTarget] = useState<{ path: string; tip: string } | undefined>(file?.action === "blame" ?
    { path: file.path, tip: file.head } : undefined);
  const [bisectTarget, setBisectTarget] = useState<{ field: "good" | "bad"; revision: string }>();
  const [syncTarget, setSyncTarget] = useState<{ reference?: string; action: "push" | "upstream" | "delete" }>();
  const [pull, setPull] = useState<{ method: "merge" | "rebase"; upstream: string }>();
  const [setup, setSetup] = useState(false);
  const [mergeState, setMergeState] = useState<GitMergeState | null>(null);
  const [selectedChange, setSelectedChange] = useState("");
  const [draft, setDraft] = useState<{ root: string; message: string }>();
  const [branchReview, setBranchReview] = useState<{ request: GitBranchRequest; root: string; branchName: string }>();
  const [branchWorking, setBranchWorking] = useState(false);
  const [branchFailure, setBranchFailure] = useState("");
  const [branchFeedback, setBranchFeedback] = useState("");
  const filterField = useRef<HTMLInputElement>(null);
  const branches = useRef<HTMLDivElement>(null);
  const knownRepository = useRef<{ path: string; root: string }>(null);
  const fileHistoryOpen = historyMode === "file";
  useLayoutEffect(() => { if (!changes && !fileHistoryOpen) filterField.current?.focus(); }, [changes, fileHistoryOpen]);
  useEffect(() => {
    let canceled = false;
    setError("");
    const root = knownRepository.current?.path === path ? knownRepository.current.root : path;
    void api.gitRepository(root).then((repository) => {
      if (canceled) return;
      knownRepository.current = { path, root: repository.root };
      setRepository(repository);
      setSelected((current) => repository.branches.some(({ reference }) => reference === current)
        ? current : repository.headRef ?? "HEAD");
    }, (error: unknown) => { if (!canceled) setError(gitError(error)); });
    return () => { canceled = true; };
  }, [path, refresh]);
  const root = repository?.root;
  useEffect(() => {
    if (!root) return;
    let canceled = false;
    void api.gitMergeState(root).then((state) => {
      if (canceled) return;
      setMergeState(state);
      if (state) setHistoryMode("merge");
    }, () => { if (!canceled) setMergeState(null); });
    return () => { canceled = true; };
  }, [root, refresh]);
  const checkedOut = repository?.headRef ?? "HEAD";
  const branch = repository?.branches.find(({ reference }) => reference === selected);
  const tip = branch?.tip ?? (selected === checkedOut ? repository?.head ?? undefined : undefined);
  function useHistoryTarget(hash: string, action?: HistoryAction) {
    if (mergeState) {
      setHistoryMode("merge");
      return;
    }
    setPull(undefined);
    setHistoryTarget({ revision: hash, action });
    setHistoryMode("tools");
  }
  function compareRevision(revision: string) {
    setCompareTarget(revision);
    setHistoryMode("compare");
  }
  function copy(value: string, message: string) {
    setBranchFailure("");
    setBranchFeedback("");
    void api.copyText(value).then(() => setBranchFeedback(t(message)),
      () => setBranchFailure(t("Could not copy to the clipboard.")));
  }
  function openSync(action: NonNullable<typeof syncTarget>["action"], reference?: string) {
    setSyncTarget({ action, reference });
    setHistoryMode("sync");
  }
  const inspect: InspectCommit = {
    shortcuts: { ...compareShortcuts, swapShortcut: [] },
    actions: (commit, showDetails) => [
      ...(showDetails ? [{ label: "Show commit details", icon: Eye, run: showDetails }] : []),
      { label: "Copy commit hash", icon: Copy, run: () => copy(commit.hash, "Commit hash copied.") },
      { label: "Compare revisions", icon: GitCompareArrows, run: () => compareRevision(commit.hash) },
      { label: "Cherry-pick commit", icon: Check, disabled: !!mergeState, run: () => useHistoryTarget(commit.hash, "cherryPick") },
      { label: "Revert commit", icon: Undo2, disabled: !!mergeState, run: () => useHistoryTarget(commit.hash, "revert") },
      { label: "Rebase onto this revision…", icon: GitFork, disabled: !!mergeState, run: () => useHistoryTarget(commit.hash, "rebase") },
      ...(["good", "bad"] as const).map((field) => ({
        label: field === "good" ? "Use as known good commit" : "Use as known bad commit", icon: Bug,
        run: () => { setBisectTarget({ field, revision: commit.hash }); setHistoryMode("repository"); },
      })),
      ...([["softReset", "Soft reset"], ["mixedReset", "Mixed reset"], ["hardReset", "Hard reset"]] as const)
        .map(([action, label]) => ({ label, icon: Undo2, destructive: true, disabled: !!mergeState,
          run: () => useHistoryTarget(commit.hash, action) })),
    ],
    openPath: (target) => {
      if (target.mode === "blame") setBlameTarget({ path: target.path, tip: target.tip });
      else { setBlameTarget(undefined); setFileTarget(target); setHistoryMode("file"); }
    },
    copy,
  };
  const allBranches: Branch[] = repository ? [...repository.branches] : [];
  if (repository && !allBranches.some(({ reference }) => reference === checkedOut)) {
    allBranches.unshift({ reference: checkedOut, name: repository.headRef?.replace(/^refs\/heads\//, "") ?? t("Detached HEAD"),
      tip: repository.head ?? "", remote: false });
  }
  const visible = allBranches.filter(({ name }) => name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  function reviewBranch(action: GitBranchAction, branch: Branch | undefined) {
    if (!repository || branchWorking) return;
    setBranchFailure("");
    setBranchFeedback("");
    setBranchReview({
      root: repository.root,
      branchName: branch?.name ?? (repository.headRef?.replace(/^refs\/heads\//, "") || t("Detached HEAD")),
      request: {
        action, expectedHeadRef: repository.headRef, expectedHead: repository.head,
        reference: branch?.reference ?? null, tip: branch?.tip ?? null,
        name: action === "rename" ? branch?.name ?? "" : action === "track" ? branch?.name.split("/").slice(1).join("/") ?? "" : "",
      },
    });
  }

  async function applyBranch() {
    if (!branchReview || branchWorking) return;
    const { root, request } = branchReview;
    setBranchWorking(true);
    setBranchFailure("");
    try {
      const updated = await api.gitUpdateBranch(root, { ...request, name: request.name?.trim() || null });
      setRepository(updated);
      setSelected(request.action === "rename" || request.action === "create"
        ? "refs/heads/" + request.name?.trim() : updated.headRef ?? "HEAD");
      setBranchReview(undefined);
      setBranchFeedback(t("Branch updated."));
      onRefresh();
    } catch (error) {
      setBranchFailure(writeError(error));
      setBranchReview(undefined);
      onRefresh();
    } finally {
      setBranchWorking(false);
    }
  }
  function handleBranchKeys(event: KeyboardEvent) {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const current = visible.findIndex(({ reference }) => reference === selected);
    const next = event.key === "ArrowDown" ? current + 1 : event.key === "ArrowUp" ? current - 1 :
      event.key === "Home" ? 0 : event.key === "End" ? visible.length - 1 : null;
    if (next === null || !visible.length) return;
    const index = Math.max(0, Math.min(next, visible.length - 1));
    event.preventDefault();
    branches.current?.querySelectorAll<HTMLElement>("[role=option]")[index]?.focus();
  }

  function branchGroup(remote: boolean) {
    const rows = visible.filter((branch) => branch.remote === remote);
    const label = t(remote ? "Remote-tracking branches" : "Local branches");
    return rows.length > 0 && <div className="git-branch-group" role="group" aria-label={label}>
      <h3>{label}</h3>
      {rows.map((row) => {
        const { reference, name } = row;
        return <Button role="option" key={reference} aria-selected={selected === reference}
        tabIndex={selected === reference || !visible.some((branch) => branch.reference === selected) && reference === visible[0]?.reference ? 0 : -1}
        onFocus={() => setSelected(reference)} onClick={() => setSelected(reference)}
        {...menu(branchMenu(row), name)}>
        <span>{name}</span>{reference === checkedOut && <small>{t("Checked out")}</small>}
      </Button>; })}
    </div>;
  }

  function branchCommands(branch: Branch | undefined, reference: string): GitAction[] {
    const locked = branchWorking || !!mergeState;
    const commands: GitBranchAction[] = branch?.remote ? ["create", "track"] : ["create", "switch", "rename", "delete"];
    return commands.map((action) => ({
      label: branchActions[action], icon: branchIcons[action], tooltip: branchHints[action], destructive: action === "delete",
      disabled: locked || (action === "create" ? !(branch?.tip ?? (reference === checkedOut ? repository?.head : null)) :
        !branch || (action === "switch" || action === "delete") && reference === checkedOut),
      run: () => reviewBranch(action, branch),
    }));
  }
  function branchMenu(row: Branch): GitAction[] {
    const { reference, name, tip, remote } = row;
    const realBranch = repository?.branches.find((branch) => branch.reference === reference);
    return [
      { label: "Show history", icon: HistoryIcon, run: () => { setSelected(reference); setHistoryMode("history"); } },
      { label: "Copy branch name", icon: Copy, run: () => copy(name, "Branch name copied.") },
      { label: "Compare revisions", icon: GitCompareArrows, disabled: !tip, run: () => compareRevision(realBranch?.reference ?? tip) },
      ...branchCommands(realBranch, reference),
      { label: "Merge into current branch…", icon: MergeIcon, disabled: !realBranch || reference === checkedOut || !!mergeState,
        run: () => { setSelected(reference); setPull(undefined); setHistoryMode("merge"); } },
      { label: "Rebase onto this revision…", icon: GitFork, disabled: !tip || reference === checkedOut || !!mergeState,
        run: () => useHistoryTarget(tip, "rebase") },
      ...(remote ? [
        { label: "Set upstream", icon: Network, disabled: !!mergeState || !repository?.headRef,
          run: () => openSync("upstream", reference) },
        { label: "Delete remote branch", icon: Trash2, destructive: true, disabled: !!mergeState || name.endsWith("/HEAD"),
          run: () => openSync("delete", reference) },
      ] : realBranch ? [
        { label: "Push branch", icon: Upload, disabled: !!mergeState, run: () => openSync("push", reference) },
      ] : []),
    ];
  }
  const refreshAction: GitAction = { label: "Refresh", icon: RotateCw, run: onRefresh };
  const closeAction: GitAction = { label: "Close Git View", icon: X, run: onClose };
  const setupAction: GitAction = { label: "Repository setup…", icon: FolderGit2, run: () => setSetup(true) };
  const paneActions: GitAction[] = [
    { label: "Branches", icon: GitBranch, pressed: !changes, run: () => setChanges(false) },
    { label: "Changes", icon: Pencil, pressed: changes, run: () => setChanges(true) },
    refreshAction, setupAction, closeAction,
  ];
  const historyActions: GitAction[] = [
    { label: "Commit graph", icon: Network, pressed: historyMode === "graph", disabled: !tip || !!error,
      run: () => setHistoryMode(historyMode === "graph" ? "history" : "graph") },
    { label: "File history", icon: FileClock, pressed: historyMode === "file", disabled: !tip || !!error,
      run: () => { setFileTarget(undefined); setHistoryMode(historyMode === "file" ? "history" : "file"); } },
    { label: "Compare revisions", icon: GitCompareArrows, pressed: historyMode === "compare", disabled: !repository || !!error,
      run: () => { setCompareTarget(undefined); setHistoryMode(historyMode === "compare" ? "history" : "compare"); } },
    { label: mergeState ? gitOperationStatus(mergeState.session.operation) : "Merge branch", icon: MergeIcon,
      pressed: historyMode === "merge", disabled: (!branch || selected === checkedOut) && !mergeState && pull?.method !== "merge",
      run: () => { setPull(undefined); setHistoryMode(historyMode === "merge" ? "history" : "merge"); } },
    { label: "History actions", icon: HistoryIcon, pressed: historyMode === "tools", disabled: !repository || !!error || !!mergeState,
      run: () => { setPull(undefined); setHistoryTarget(undefined); setHistoryMode(historyMode === "tools" ? "history" : "tools"); } },
    { label: "Repository tools", icon: Settings, pressed: historyMode === "repository", disabled: !repository || !!error,
      run: () => { setBisectTarget(undefined); setHistoryMode(historyMode === "repository" ? "history" : "repository"); } },
    { label: "Synchronize repository", icon: Upload, pressed: historyMode === "sync", disabled: !repository || !!error || !!mergeState,
      run: () => { setSyncTarget(undefined); setHistoryMode(historyMode === "sync" ? "history" : "sync"); } },
  ];
  const header = <header className="pane-heading">
    <div className="git-tabs" role="group" aria-label={t("Git View")}>
      <GitActionButtons actions={paneActions.slice(0, 2)} />
    </div>
    <GitActionButtons actions={[refreshAction, closeAction]} />
  </header>;
  const fileDiff = file?.action === "diff" ? file.path : undefined;
  const fileDiffActions = [refreshAction, closeAction];
  const fileDiffHeader = <header className="pane-heading"><span className="pane-title">{t("Show diff")}</span>
    <GitActionButtons actions={fileDiffActions} /></header>;
  const location = <div className="git-repository">
    {repository && <strong>{repository.name}</strong>}
    <span title={repository?.root ?? path}>{repository?.root ?? path}</span>
  </div>;
  const historyHeader = <header className="pane-heading git-history-heading" {...menu([refreshAction, ...historyActions])}>
    <span className="pane-title"><GitCommitHorizontal aria-hidden="true" />{t("Commit history")}</span>
    {repository && <span className="git-ref">{branch?.name ?? allBranches.find(({ reference }) => reference === checkedOut)?.name}</span>}
    <div className="git-history-actions"><GitActionButtons actions={historyActions} /></div>
  </header>;
  if (changes && repository && !error) return <GitChanges key={repository.root} root={repository.root} pathScope={fileDiff}
    side={side} refresh={refresh} selected={selectedChange} onSelect={setSelectedChange} header={fileDiff ? fileDiffHeader : header}
    paneActions={fileDiff ? fileDiffActions : paneActions}
    repository={location} onOpen={onOpen} canEdit={canEdit} onRefresh={onRefresh}
    compareShortcuts={{ ...compareShortcuts, swapShortcut: [] }}
    draft={draft?.root === repository.root ? draft.message : ""}
    onDraft={(message) => setDraft({ root: repository.root, message })} />;
  const fileTip = fileTarget?.tip ?? tip;
  const blameViewer = repository && blameTarget && <GitBlameViewer key={JSON.stringify([repository.root, blameTarget])}
    root={repository.root} revision={blameTarget.tip} path={blameTarget.path}
    onClose={file?.action === "blame" && historyMode === "history" ? onClose : () => setBlameTarget(undefined)}
    renderDetails={(line) => <ChangeDetails key={line.hash} root={repository.root} highlight={line.path}
      commit={{ hash: line.hash, shortHash: line.hash.slice(0, 12), author: line.author, subject: "", date: "" }}
      inspect={{ ...inspect, actions: (commit) => inspect.actions(commit).filter(({ label }) => label === "Copy commit hash") }}
    />} />;
  if (fileHistoryOpen && repository && fileTip) return <>
    <GitFileHistory key={JSON.stringify([repository.root, fileTarget])}
      repository={repository} tip={fileTip} side={side} initial={fileTarget} refresh={refresh} historyHeader={historyHeader}
      previewControls={<GitActionButtons actions={[refreshAction, closeAction]} />} commitActions={inspect.actions}
      onBlame={(path, tip) => setBlameTarget({ path, tip })} compareShortcuts={{ ...compareShortcuts, swapShortcut: [] }} />
    {blameViewer}
  </>;

  return <>
    {blameViewer}
    {repository && file?.action === "compare" && <GitWorkingComparison repository={repository} path={file.path} head={file.head}
      onClose={onClose} shortcuts={compareShortcuts} />}
    <section className={"pane git-pane git-pane-" + side} aria-label={t(changes ? "Changes" : "Branches")} data-help-topic="gitView" data-pane-side={side}
      tabIndex={-1} {...menu(paneActions)}>
      {header}
      {location}
      <div className="git-branch-actions">
        <GitActionButtons actions={[setupAction]} />
      </div>
      {!changes && <input className="git-filter" ref={filterField} type="search" value={filter} aria-label={t("Filter branches")}
        placeholder={t("Filter branches")} onChange={(event) => setFilter(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" || !visible.length) return;
          event.preventDefault();
          branches.current?.querySelector<HTMLElement>("[role=option][tabindex='0']")?.focus();
        }} />}
      {repository && !error && <div className="git-branch-actions" role="group" aria-label={t("Branch actions")}>
        <GitActionButtons actions={branchCommands(branch, selected)} />
      </div>}
      {branchFailure && <p className="git-error" role="alert">{branchFailure}</p>}
      {branchFeedback && <p role="status">{branchFeedback}</p>}
      {error ? <p className="pane-empty git-error" role="alert">{error}</p> : repository ?
        <div className="git-scroll" ref={branches} role="listbox" aria-label={t("Git branches")} onKeyDown={handleBranchKeys}>
          {branchGroup(false)}
          {branchGroup(true)}
          {!visible.length && <p className="pane-empty">{t("No matching branches.")}</p>}
        </div> : <p className="pane-empty" role="status">{t("Reading Git repository…")}</p>}
    </section>
    <section className={"pane git-pane git-pane-" + opposite(side)} aria-label={t("Commit history")} data-help-topic="gitView" data-pane-side={opposite(side)}
      tabIndex={-1} {...menu([refreshAction, ...historyActions])}>
      {historyHeader}
      {repository && !changes && (historyMode === "merge"
        ? <GitMerge key={repository.root} root={repository.root} source={pull?.method === "merge" ? pull.upstream :
          branch && selected !== checkedOut ? branch.reference : ""}
          state={mergeState} refresh={refresh} onRefresh={onRefresh} onOpen={onOpen} canEdit={canEdit} />
        : historyMode === "tools"
        ? <GitHistoryTools key={JSON.stringify([repository.root, pull?.upstream, historyTarget])} repository={repository}
          initialTarget={historyTarget?.revision ?? tip}
          initialRef={pull?.method === "rebase" ? pull.upstream : historyTarget ? undefined : branch?.reference}
          initialAction={pull?.method === "rebase" ? "rebase" : historyTarget?.action} onRefresh={onRefresh} shortcuts={inspect.shortcuts} />
        : historyMode === "repository"
        ? <GitRepositoryTools key={JSON.stringify([repository.root, bisectTarget])} repository={repository} refresh={refresh}
          bisectTarget={bisectTarget} onRefresh={onRefresh} onOpen={onOpenWorktree} onTerminal={onTerminal} />
        : historyMode === "sync"
        ? <GitSyncTools key={JSON.stringify([repository.root, syncTarget])} repository={repository} refresh={refresh} onRefresh={onRefresh}
          initial={syncTarget} onCompare={compareRevision} onCopyRef={(reference) => copy(reference, "Reference copied.")}
          onPull={(method, upstream) => { setPull({ method, upstream }); setHistoryTarget(undefined);
            setHistoryMode(method === "merge" ? "merge" : "tools"); }} />
        : historyMode === "compare"
        ? <GitRevisionComparison key={JSON.stringify([repository.root, compareTarget ?? selected, refresh])}
          repository={repository} target={compareTarget ?? tip} commitActions={inspect.actions} onInspectPath={inspect.openPath} shortcuts={inspect.shortcuts}
          onCopyPath={(path) => copy(path, "Path copied to the clipboard.")}
          renderDetails={(commit) => <ChangeDetails root={repository.root} commit={commit} onTarget={useHistoryTarget} inspect={inspect} />} />
        : historyMode === "graph" && tip
          ? <GitCommitGraph key={JSON.stringify([repository.root, selected, tip, refresh])}
            repository={repository} tip={tip} branch={branch} commitActions={inspect.actions}
            renderDetails={(commit) => <ChangeDetails root={repository.root} commit={commit}
              onTarget={useHistoryTarget} inspect={inspect} />} />
          : <History key={selected + ":" + (tip ?? "") + ":" + refresh} root={repository.root}
            tip={tip} onTarget={useHistoryTarget} inspect={inspect} />)}
    </section>
    {setup && <GitRepositorySetup initialPath={repository?.root ?? path} onClose={() => setSetup(false)}
      onOpen={(folder) => { setSetup(false); onOpenWorktree(folder); onRefresh(); }} />}
    {branchReview && <Dialog title={t(branchActions[branchReview.request.action])} helpTopic="gitView"
      onClose={branchWorking ? undefined : () => setBranchReview(undefined)} footer={<>
        <Button disabled={branchWorking} data-initial-focus={branchReview.request.action === "delete" || undefined}
          onClick={() => setBranchReview(undefined)}>{t("Cancel")}</Button>
        <Button disabled={branchWorking || (["create", "track", "rename"].includes(branchReview.request.action) && !branchReview.request.name?.trim())}
          className={branchReview.request.action === "delete" ? "negative" : undefined}
          onClick={() => void applyBranch()}>{t(branchActions[branchReview.request.action])}</Button>
      </>}>
      <div className="dialog-body git-tools-review">
        <p>{t("Branch {0}", branchReview.branchName)}</p>
        <p><code>{branchReview.root}</code></p>
        {branchReview.request.action === "delete" && <p>{t("Git deletes only a branch that has been merged.")}</p>}
        {["create", "track", "rename"].includes(branchReview.request.action) && <label className="field">{t("Branch name")}
          <input value={branchReview.request.name ?? ""} autoFocus autoComplete="off" spellCheck={false}
            disabled={branchWorking} onChange={(event) => setBranchReview({
              ...branchReview, request: { ...branchReview.request, name: event.target.value },
            })} />
        </label>}
      </div>
    </Dialog>}
  </>;
}
