import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, FileClock, FileDiff, GitCompareArrows, Search } from "lucide-react";
import { api, type GitCommit, type GitFileCommit, type GitRepository } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { GitActionButtons, useGitMenu, type GitAction } from "./GitActions";
import { GitFileVersions, type GitFileSide } from "./GitFileVersions";
import { RevisionInput } from "./GitRevisionComparison";
import type { ComparisonShortcuts } from "./TextTools";
import { t } from "./i18n";
import { opposite, type Side } from "./panes";

type HistoryPage = { commits: GitFileCommit[]; nextOffset: number | null };

export function GitFileHistory({ repository, tip, side, initial, refresh, historyHeader, previewControls, commitActions, onBlame, compareShortcuts }: {
  repository: GitRepository;
  tip: string;
  side: Side;
  initial?: { path: string };
  refresh: number;
  historyHeader: ReactNode;
  previewControls: ReactNode;
  commitActions: (commit: GitCommit) => GitAction[];
  onBlame: (path: string, revision: string) => void;
  compareShortcuts: ComparisonShortcuts;
}) {
  const menu = useGitMenu();
  const [path, setPath] = useState(initial?.path ?? "");
  const [opened, setOpened] = useState(initial);
  const [history, setHistory] = useState<HistoryPage>();
  const [request, setRequest] = useState<{ offset: number } | undefined>(initial ? { offset: 0 } : undefined);
  const [selected, setSelected] = useState<string>();
  const [comparing, setComparing] = useState(false);
  const [comparison, setComparison] = useState<{ hash: string; revision: string }>();
  const [failedOffset, setFailedOffset] = useState<number>();
  const list = useRef<HTMLDivElement>(null);
  const focusInitialSelection = useRef(!!initial);
  const { root } = repository;
  const previousSource = useRef({ refresh, tip });
  useEffect(() => {
    if (previousSource.current.refresh === refresh && previousSource.current.tip === tip) return;
    previousSource.current = { refresh, tip };
    if (opened) {
      setFailedOffset(undefined);
      setRequest({ offset: 0 });
    }
  }, [opened, refresh, tip]);
  useEffect(() => {
    if (!opened || !request) return;
    let active = true;
    void api.gitFileHistory(root, tip, opened.path, request.offset).then((page) => {
      if (!active) return;
      setHistory((previous) => ({
        ...page, commits: request.offset && previous ? [...previous.commits, ...page.commits] : page.commits,
      }));
      setSelected((current) => request.offset || page.commits.some(({ hash }) => hash === current) ?
        current ?? page.commits[0]?.hash : page.commits[0]?.hash);
    }, () => { if (active) setFailedOffset(request.offset); }).finally(() => { if (active) setRequest(undefined); });
    return () => { active = false; };
  }, [root, tip, opened, request]);
  useLayoutEffect(() => {
    if (!selected || !focusInitialSelection.current) return;
    focusInitialSelection.current = false;
    list.current?.querySelector<HTMLElement>("[role=option][aria-selected=true]")?.focus({ preventScroll: true });
  }, [selected]);
  function open() {
    if (!path.trim()) return;
    setOpened({ path });
    setHistory(undefined);
    setSelected(undefined);
    setComparison(undefined);
    setFailedOffset(undefined);
    setRequest({ offset: 0 });
  }
  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !history?.commits.length) return;
    const index = history.commits.findIndex(({ hash }) => hash === selected);
    const size = history.commits.length;
    const next = event.key === "ArrowDown" ? Math.min(size - 1, index + 1) :
      event.key === "ArrowUp" ? Math.max(0, index - 1) : event.key === "Home" ? 0 : event.key === "End" ? size - 1 : null;
    if (next === null) return;
    event.preventDefault();
    list.current?.querySelectorAll<HTMLElement>("[role=option]")[next]?.focus();
  }
  const row = history?.commits.find(({ hash }) => hash === selected);
  const selectedComparison = comparison?.hash === row?.hash ? comparison : undefined;
  const before: GitFileSide | undefined = row && (selectedComparison ?
    { revision: selectedComparison.revision, path: row.change.path, label: t("Comparison revision") } :
    { revision: row.parent, path: row.change.previousPath ?? row.change.path, absent: row.change.status === "A",
      label: t(row.merge ? "First parent" : "Parent revision") });
  const after: GitFileSide | undefined = row && {
    revision: row.hash, path: row.change.path, absent: row.change.status === "D", label: t("Selected revision"),
  };
  const pathActions: GitAction[] = [
    { label: "Show history", icon: FileClock, disabled: !path.trim(), submit: true, run: open },
    { label: "Show blame", icon: Search, disabled: !path.trim(), run: () => onBlame(path, tip) },
  ];
  const revisionActions: GitAction[] = row ? [
    { label: "Compare with revision…", icon: GitCompareArrows, run: () => setComparing(true) },
    { label: "Show blame", icon: Search, run: () => onBlame(row.change.path, row.hash) },
    ...(selectedComparison ? [{ label: "Show parent comparison", icon: ArrowLeft, run: () => setComparison(undefined) }] : []),
  ] : [];
  return <>
    <section className={"pane git-pane git-pane-" + side} aria-label={t("File revision preview")}
      tabIndex={-1} data-help-topic="gitView" data-pane-side={side} {...menu(revisionActions)}>
      <header className="pane-heading">
        <span className="pane-title"><FileDiff aria-hidden="true" />{t("File revision preview")}</span>
        {previewControls}
      </header>
      {!!revisionActions.length && <div className="git-branch-actions"><GitActionButtons actions={revisionActions} /></div>}
      {row && before && after ? <GitFileVersions key={JSON.stringify([row.hash, before.revision, refresh])} root={root}
        left={before} right={after} shortcuts={compareShortcuts} showRevision /> : <p className="pane-empty">{t("Select a file revision to preview its changes.")}</p>}
    </section>
    <section className={"pane git-pane git-pane-" + opposite(side)} aria-label={t("Commit history")}
      tabIndex={-1} data-help-topic="gitView" data-pane-side={opposite(side)} {...menu(pathActions)}>
      {historyHeader}
      <div className="git-file-history">
        <form onSubmit={(event) => { event.preventDefault(); open(); }}>
          <label className="field">{t("Path relative to the repository")}
            <input value={path} onChange={(event) => setPath(event.target.value)} required spellCheck={false} autoComplete="off" />
          </label>
          <div className="git-branch-actions"><GitActionButtons actions={pathActions} /></div>
        </form>
        {opened && <p className="git-file-history-target">
          <strong>{opened.path}</strong>
          <span>{t("Starting revision")} <code title={tip}>{tip.slice(0, 12)}</code></span>
        </p>}
      </div>
      {failedOffset !== undefined && <p className="git-error git-file-feedback" role="alert">{t("Could not read the file history.")}</p>}
      {history && !history.commits.length && !request && failedOffset === undefined && <p className="git-file-feedback">{t("No commits yet")}</p>}
      <div className="git-scroll git-file-commits" ref={list} role="listbox" aria-label={t("File history")} onKeyDown={moveFocus}>
        {history?.commits.map((commit) => <Button key={commit.hash} role="option" aria-selected={selected === commit.hash}
          tabIndex={selected === commit.hash ? 0 : -1} onFocus={() => setSelected(commit.hash)} onClick={() => setSelected(commit.hash)}
          {...menu([
            { label: "Show change", icon: FileDiff, run: () => setSelected(commit.hash) },
            { label: "Show blame", icon: Search, run: () => onBlame(commit.change.path, commit.hash) },
            ...commitActions(commit),
          ], commit.shortHash)}>
          <strong>{commit.subject || t("No subject")}</strong>
          <code title={commit.hash}>{commit.shortHash}</code>
        </Button>)}
        {request && <p className="git-file-feedback" role="status">{t("Loading commits…")}</p>}
      </div>
      {!request && opened && (failedOffset !== undefined || history?.nextOffset != null) &&
        <div className="git-branch-actions">
          <Button onClick={() => { setFailedOffset(undefined); setRequest({ offset: failedOffset ?? history?.nextOffset ?? 0 }); }}>
            {t(failedOffset === undefined ? "Load more" : "Retry")}
          </Button>
        </div>}
    </section>
    {comparing && row && <Dialog title={t("Compare with revision…")} helpTopic="gitView" onClose={() => setComparing(false)}>
      <form className="dialog-body" onSubmit={(event) => {
        event.preventDefault();
        const choices = new FormData(event.currentTarget);
        const reference = String(choices.get("Comparison reference") ?? "");
        const revision = reference.startsWith("refs/") ? reference : String(choices.get("Comparison revision") ?? "").trim();
        if (!revision) return;
        setComparison({ hash: row.hash, revision });
        setComparing(false);
      }}>
        <RevisionInput label="Comparison revision" choiceName="Comparison reference" initial={repository.head ?? undefined} repository={repository} />
        <div className="dialog-actions">
          <Button type="button" onClick={() => setComparing(false)}>{t("Cancel")}</Button>
          <Button type="submit" className="primary">{t("Compare")}</Button>
        </div>
      </form>
    </Dialog>}
  </>;
}
