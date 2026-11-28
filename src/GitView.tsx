import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { GitCommitHorizontal } from "lucide-react";
import { api, type GitBranch as Branch, type GitBranchAction, type GitBranchRequest, type GitCommit, type GitDetails, type GitHistory, type GitMergeState, type GitRepository, type NamedFile } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { GitChanges } from "./GitChanges";
import { writeError } from "./gitWriteError";
import { GitHistoryTools } from "./GitHistoryTools";
import { GitMerge, gitOperationStatus } from "./GitMerge";
import { GitRepositoryTools } from "./GitRepositoryTools";
import { GitRevisionComparison } from "./GitRevisionComparison";
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

function ChangeDetails({ root, commit, onTarget }: { root: string; commit: GitCommit; onTarget: (hash: string) => void }) {
  const [details, setDetails] = useState<GitDetails | null>(null);
  const [error, setError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => {
    let canceled = false;
    void api.gitDetails(root, commit.hash).then((result) => { if (!canceled) setDetails(result); },
      (error: unknown) => { if (!canceled) setError(gitError(error)); });
    return () => { canceled = true; };
  }, [root, commit.hash]);
  return <section className="git-details" aria-label={t("Commit details")}>
    <header>
      <code title={commit.hash}>{commit.shortHash}</code>
      <Button onClick={() => { void api.copyText(commit.hash).then(() => setCopyStatus(t("Commit hash copied.")),
        () => setCopyStatus(t("Could not copy the commit hash."))); }}>{t("Copy commit hash")}</Button>
      <Button onClick={() => onTarget(commit.hash)}>{t("Use in history actions")}</Button>
    </header>
    {copyStatus && <p role="status">{copyStatus}</p>}
    {error ? <p role="alert">{error}</p> : details ? <>
      <pre>{details.message || commit.subject}</pre>
      <h3>{t(details.merge ? "Changed paths relative to the first parent" : "Changed paths")}</h3>
      {details.changes.length ? <ul>
        {details.changes.map(({ status, path, previousPath }, index) => <li key={index}>
          <span>{t(statusLabels[status] ?? status)}</span>
          <span>{previousPath ? previousPath + " → " + path : path}</span>
        </li>)}
      </ul> : <p>{t("No changed paths.")}</p>}
    </> : <p role="status">{t("Loading commit details…")}</p>}
  </section>;
}

function History({ root, tip, file, onTarget }: { root: string; tip?: string; file?: string; onTarget: (hash: string) => void }) {
  const [result, setResult] = useState<GitHistory>({ commits: [], nextOffset: tip ? 0 : null });
  const [request, setRequest] = useState<{ offset: number } | null>(tip ? { offset: 0 } : null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!tip || !request) return;
    let canceled = false;
    const query = file ? api.gitFileHistory(root, tip, file, request.offset) : api.gitHistory(root, tip, request.offset);
    void query.then((page) => {
      if (!canceled) setResult((current) => ({
        commits: request.offset === 0 ? page.commits : [...current.commits, ...page.commits], nextOffset: page.nextOffset,
      }));
    }, (error: unknown) => {
      if (!canceled) setError(gitError(error));
    }).finally(() => {
      if (!canceled) setRequest(null);
    });
    return () => { canceled = true; };
  }, [root, tip, file, request]);
  const formatDate = useTimestamps(result.commits.map(({ date }) => Math.floor(Date.parse(date) / 1000)));
  return <div className="git-history git-scroll">
    {result.commits.map((commit) => <div className="git-commit" key={commit.hash}>
      <Button type="button" aria-expanded={open === commit.hash} onClick={() => setOpen(open === commit.hash ? null : commit.hash)}>
        <GitCommitHorizontal aria-hidden="true" />
        <span><strong>{commit.subject || t("No subject")}</strong>
          <small>{commit.author}{Number.isFinite(Date.parse(commit.date)) &&
            <> <span aria-hidden="true">·</span> {formatDate(Math.floor(Date.parse(commit.date) / 1000))}</>}</small></span>
        <code>{commit.shortHash}</code>
      </Button>
      {open === commit.hash && <ChangeDetails root={root} commit={commit} onTarget={onTarget} />}
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

function CommitGraph({ root, tip }: { root: string; tip: string }) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [graph, setGraph] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let canceled = false;
    void api.gitCommitGraph(root, tip, query).then((value) => {
      if (!canceled) setGraph(value);
    }, (error: unknown) => { if (!canceled) setError(gitError(error)); });
    return () => { canceled = true; };
  }, [root, tip, query]);
  return <div className="git-scroll git-revision-comparison">
    <form onSubmit={(event) => {
      event.preventDefault();
      if (search.trim() === query) return;
      setGraph(null);
      setError("");
      setQuery(search.trim());
    }}>
      <label className="field">{t("Search commit messages")}
        <input type="search" maxLength={200} value={search} onChange={(event) => setSearch(event.target.value)} />
      </label>
      <Button type="submit">{t("Search")}</Button>
    </form>
    {error ? <p role="alert">{error}</p> : graph === null ? <p role="status">{t("Loading commits…")}</p> :
      graph ? <><p>{t("Showing up to 250 commits.")}</p><pre className="git-patch" tabIndex={0}
        aria-label={t("Commit graph")}>{graph}</pre></> : <p>{t("No matching commits.")}</p>}
  </div>;
}

function Blame({ root, tip, path }: { root: string; tip: string; path: string }) {
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let canceled = false;
    void api.gitFileBlame(root, tip, path).then((result) => { if (!canceled) setResult(result); },
      () => { if (!canceled) setError(true); });
    return () => { canceled = true; };
  }, [root, tip, path]);
  if (error) return <p role="alert">{t("Could not read blame for this path at the selected revision.")}</p>;
  if (result === null) return <p role="status">{t("Reading change…")}</p>;
  return result
    ? <pre className="git-patch" tabIndex={0} aria-label={t("Blame")}>{result}</pre>
    : <p>{t("This file has no lines.")}</p>;
}

function FileRevision({ root, tip, onTarget }: { root: string; tip: string; onTarget: (hash: string) => void }) {
  const [path, setPath] = useState("");
  const [opened, setOpened] = useState<{ path: string; mode: "history" | "blame" }>();
  return <div className="git-scroll git-revision-comparison">
    <form onSubmit={(event) => {
      event.preventDefault();
      if (path) setOpened({ path, mode: "history" });
    }}>
      <label className="field">{t("Path relative to the repository")}
        <input value={path} onChange={(event) => setPath(event.target.value)} required spellCheck={false} autoComplete="off" />
      </label>
      <Button type="submit" disabled={!path}>{t("Show history")}</Button>
      <Button type="button" disabled={!path} onClick={() => setOpened({ path, mode: "blame" })}>{t("Show blame")}</Button>
    </form>
    {opened && (opened.mode === "history"
      ? <History key={opened.path} root={root} tip={tip} file={opened.path} onTarget={onTarget} />
      : <Blame key={opened.path} root={root} tip={tip} path={opened.path} />)}
  </div>;
}

export default function GitView({ path, side, refresh, onRefresh, onClose, onOpen, onOpenWorktree, onTerminal, canEdit }: {
  path: string;
  side: Side;
  refresh: number;
  onRefresh: () => void;
  onClose: () => void;
  onOpen: (file: NamedFile, editing: boolean) => void;
  onOpenWorktree: (path: string) => void;
  onTerminal: (path: string) => void;
  canEdit: (file: NamedFile) => boolean;
}) {
  const [repository, setRepository] = useState<GitRepository | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState("");
  const [changes, setChanges] = useState(false);
  const [historyMode, setHistoryMode] = useState<"history" | "graph" | "file" | "compare" | "merge" | "tools" | "repository">("history");
  const [historyTarget, setHistoryTarget] = useState<string>();
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
  useLayoutEffect(() => { if (!changes) filterField.current?.focus(); }, [changes]);
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
  function useHistoryTarget(hash: string) {
    if (mergeState) {
      setHistoryMode("merge");
      return;
    }
    setHistoryTarget(hash);
    setHistoryMode("tools");
  }
  const allBranches: Branch[] = repository ? [...repository.branches] : [];
  if (repository && !allBranches.some(({ reference }) => reference === checkedOut)) {
    allBranches.unshift({ reference: checkedOut, name: repository.headRef?.replace(/^refs\/heads\//, "") ?? t("Detached HEAD"),
      tip: repository.head ?? "", remote: false });
  }
  const visible = allBranches.filter(({ name }) => name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  function reviewBranch(action: GitBranchAction) {
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
      {rows.map(({ reference, name }) => <Button role="option" key={reference} aria-selected={selected === reference}
        tabIndex={selected === reference || !visible.some((branch) => branch.reference === selected) && reference === visible[0]?.reference ? 0 : -1}
        onFocus={() => setSelected(reference)} onClick={() => setSelected(reference)}>
        <span>{name}</span>{reference === checkedOut && <small>{t("Checked out")}</small>}
      </Button>)}
    </div>;
  }

  const header = <header className="pane-heading">
    <div className="git-tabs" role="group" aria-label={t("Git View")}>
      <Button aria-pressed={!changes} onClick={() => setChanges(false)}>{t("Branches")}</Button>
      <Button aria-pressed={changes} onClick={() => setChanges(true)}>{t("Changes")}</Button>
    </div>
    <Button onClick={onRefresh}>{t("Refresh")}</Button>
    <Button onClick={onClose}>{t("Close Git View")}</Button>
  </header>;
  const location = <div className="git-repository">
    {repository && <strong>{repository.name}</strong>}
    <span title={repository?.root ?? path}>{repository?.root ?? path}</span>
  </div>;
  if (changes && repository && !error) return <GitChanges key={repository.root} root={repository.root}
    side={side} refresh={refresh} selected={selectedChange} onSelect={setSelectedChange} header={header}
    repository={location} onOpen={onOpen} canEdit={canEdit} onRefresh={onRefresh}
    draft={draft?.root === repository.root ? draft.message : ""}
    onDraft={(message) => setDraft({ root: repository.root, message })} />;

  return <>
    <section className={"pane git-pane git-pane-" + side} aria-label={t(changes ? "Changes" : "Branches")} data-help-topic="gitView" data-pane-side={side}>
      {header}
      {location}
      {!changes && <input className="git-filter" ref={filterField} type="search" value={filter} aria-label={t("Filter branches")}
        placeholder={t("Filter branches")} onChange={(event) => setFilter(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" || !visible.length) return;
          event.preventDefault();
          branches.current?.querySelector<HTMLElement>("[role=option][tabindex='0']")?.focus();
        }} />}
      {repository && !error && <div className="git-branch-actions" role="group" aria-label={t("Branch actions")}>
        <Button disabled={!tip || branchWorking || !!mergeState} onClick={() => reviewBranch("create")}>{t(branchActions.create)}</Button>
        {branch?.remote
          ? <Button disabled={branchWorking || !!mergeState} onClick={() => reviewBranch("track")}>{t(branchActions.track)}</Button>
          : <>
            <Button disabled={!branch || selected === checkedOut || branchWorking || !!mergeState} onClick={() => reviewBranch("switch")}>{t(branchActions.switch)}</Button>
            <Button disabled={!branch || branchWorking || !!mergeState} onClick={() => reviewBranch("rename")}>{t(branchActions.rename)}</Button>
            <Button disabled={!branch || selected === checkedOut || branchWorking || !!mergeState} onClick={() => reviewBranch("delete")}>{t(branchActions.delete)}</Button>
          </>}
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
    <section className={"pane git-pane git-pane-" + opposite(side)} aria-label={t("Commit history")} data-help-topic="gitView" data-pane-side={opposite(side)}>
      <header className="pane-heading git-history-heading">
        <span className="pane-title"><GitCommitHorizontal aria-hidden="true" />{t("Commit history")}</span>
        {repository && <span className="git-ref">{branch?.name ?? allBranches.find(({ reference }) => reference === checkedOut)?.name}</span>}
        <div className="git-history-actions">
          <Button disabled={!tip || !!error} aria-pressed={historyMode === "graph"}
            onClick={() => setHistoryMode(historyMode === "graph" ? "history" : "graph")}>{t("Commit graph")}</Button>
          <Button disabled={!tip || !!error} aria-pressed={historyMode === "file"}
            onClick={() => setHistoryMode(historyMode === "file" ? "history" : "file")}>{t("File history")}</Button>
          <Button disabled={!repository || !!error} aria-pressed={historyMode === "compare"}
            onClick={() => setHistoryMode(historyMode === "compare" ? "history" : "compare")}>{t("Compare revisions")}</Button>
          <Button disabled={(!branch || selected === checkedOut) && !mergeState} aria-pressed={historyMode === "merge"}
            onClick={() => setHistoryMode(historyMode === "merge" ? "history" : "merge")}>{t(mergeState ? gitOperationStatus(mergeState.session.operation) : "Merge branch")}</Button>
          <Button disabled={!repository || !!error || !!mergeState} aria-pressed={historyMode === "tools"}
            onClick={() => { setHistoryTarget(undefined); setHistoryMode(historyMode === "tools" ? "history" : "tools"); }}>{t("History actions")}</Button>
          <Button disabled={!repository || !!error} aria-pressed={historyMode === "repository"}
            onClick={() => setHistoryMode(historyMode === "repository" ? "history" : "repository")}>{t("Repository tools")}</Button>
        </div>
      </header>
      {repository && !changes && (historyMode === "merge"
        ? <GitMerge key={repository.root} root={repository.root} source={branch && selected !== checkedOut ? branch.reference : ""}
          state={mergeState} refresh={refresh} onRefresh={onRefresh} onOpen={onOpen} canEdit={canEdit} />
        : historyMode === "tools"
        ? <GitHistoryTools key={repository.root + ":" + (historyTarget ?? "")} repository={repository}
          initialTarget={historyTarget ?? tip} initialRef={historyTarget ? undefined : branch?.reference} onRefresh={onRefresh} />
        : historyMode === "repository"
        ? <GitRepositoryTools key={repository.root} repository={repository} refresh={refresh} onRefresh={onRefresh}
          onOpen={onOpenWorktree} onTerminal={onTerminal} />
        : historyMode === "compare"
        ? <GitRevisionComparison key={repository.root + ":" + selected + ":" + refresh} repository={repository} target={tip} />
        : historyMode === "graph" && tip
          ? <CommitGraph key={tip + ":" + refresh} root={repository.root} tip={tip} />
          : historyMode === "file" && tip
            ? <FileRevision key={tip + ":" + refresh} root={repository.root} tip={tip} onTarget={useHistoryTarget} />
          : <History key={selected + ":" + (tip ?? "") + ":" + refresh} root={repository.root} tip={tip} onTarget={useHistoryTarget} />)}
    </section>
    {branchReview && <Dialog title={t(branchActions[branchReview.request.action])} helpTopic="gitView"
      onClose={branchWorking ? undefined : () => setBranchReview(undefined)} footer={<>
        <Button disabled={branchWorking} onClick={() => setBranchReview(undefined)}>{t("Cancel")}</Button>
        <Button disabled={branchWorking || (["create", "track", "rename"].includes(branchReview.request.action) && !branchReview.request.name?.trim())}
          onClick={() => void applyBranch()}>{t(branchActions[branchReview.request.action])}</Button>
      </>}>
      <p><code>{branchReview.root}</code></p>
      <p>{t("Branch {0}", branchReview.branchName)}</p>
      {branchReview.request.action === "delete" && <p>{t("Git deletes only a branch that has been merged.")}</p>}
      {["create", "track", "rename"].includes(branchReview.request.action) && <label className="field">{t("Branch name")}
        <input value={branchReview.request.name ?? ""} autoFocus autoComplete="off" spellCheck={false}
          disabled={branchWorking} onChange={(event) => setBranchReview({
            ...branchReview, request: { ...branchReview.request, name: event.target.value },
          })} />
      </label>}
    </Dialog>}
  </>;
}
