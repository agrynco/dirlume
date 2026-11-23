import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { GitCommitHorizontal } from "lucide-react";
import { api, type GitBranch as Branch, type GitCommit, type GitDetails, type GitHistory, type GitRepository, type NamedFile } from "./api";
import { Button } from "./Button";
import { GitChanges } from "./GitChanges";
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

function ChangeDetails({ root, commit }: { root: string; commit: GitCommit }) {
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

function History({ root, tip }: { root: string; tip?: string }) {
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
      <Button type="button" aria-expanded={open === commit.hash} onClick={() => setOpen(open === commit.hash ? null : commit.hash)}>
        <GitCommitHorizontal aria-hidden="true" />
        <span><strong>{commit.subject || t("No subject")}</strong>
          <small>{commit.author}{Number.isFinite(Date.parse(commit.date)) &&
            <> <span aria-hidden="true">·</span> {formatDate(Math.floor(Date.parse(commit.date) / 1000))}</>}</small></span>
        <code>{commit.shortHash}</code>
      </Button>
      {open === commit.hash && <ChangeDetails root={root} commit={commit} />}
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

export default function GitView({ path, side, refresh, onRefresh, onClose, onOpen, canEdit }: {
  path: string;
  side: Side;
  refresh: number;
  onRefresh: () => void;
  onClose: () => void;
  onOpen: (file: NamedFile, editing: boolean) => void;
  canEdit: (file: NamedFile) => boolean;
}) {
  const [repository, setRepository] = useState<GitRepository | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState("");
  const [changes, setChanges] = useState(false);
  const [selectedChange, setSelectedChange] = useState("");
  const filterField = useRef<HTMLInputElement>(null);
  const branches = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (!changes) filterField.current?.focus(); }, [changes]);
  useEffect(() => {
    let canceled = false;
    setError("");
    void api.gitRepository(path).then((repository) => {
      if (canceled) return;
      setRepository(repository);
      setSelected((current) => repository.branches.some(({ reference }) => reference === current)
        ? current : repository.headRef ?? "HEAD");
    }, (error: unknown) => { if (!canceled) setError(gitError(error)); });
    return () => { canceled = true; };
  }, [path, refresh]);
  const checkedOut = repository?.headRef ?? "HEAD";
  const branch = repository?.branches.find(({ reference }) => reference === selected);
  const tip = branch?.tip ?? (selected === checkedOut ? repository?.head ?? undefined : undefined);
  const allBranches: Branch[] = repository ? [...repository.branches] : [];
  if (repository && !allBranches.some(({ reference }) => reference === checkedOut)) {
    allBranches.unshift({ reference: checkedOut, name: repository.headRef?.replace(/^refs\/heads\//, "") ?? t("Detached HEAD"),
      tip: repository.head ?? "", remote: false });
  }
  const visible = allBranches.filter(({ name }) => name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
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
    repository={location} onOpen={onOpen} canEdit={canEdit} />;

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
      {error ? <p className="pane-empty git-error" role="alert">{error}</p> : repository ?
        <div className="git-scroll" ref={branches} role="listbox" aria-label={t("Git branches")} onKeyDown={handleBranchKeys}>
          {branchGroup(false)}
          {branchGroup(true)}
          {!visible.length && <p className="pane-empty">{t("No matching branches.")}</p>}
        </div> : <p className="pane-empty" role="status">{t("Reading Git repository…")}</p>}
    </section>
    <section className={"pane git-pane git-pane-" + opposite(side)} aria-label={t("Commit history")} data-help-topic="gitView" data-pane-side={opposite(side)}>
      <header className="pane-heading">
        <span className="pane-title"><GitCommitHorizontal aria-hidden="true" />{t("Commit history")}</span>
        {repository && <span className="git-ref">{branch?.name ?? allBranches.find(({ reference }) => reference === checkedOut)?.name}</span>}
      </header>
      {repository && !changes && <History key={selected + ":" + (tip ?? "") + ":" + refresh} root={repository.root} tip={tip} />}
    </section>
  </>;
}
