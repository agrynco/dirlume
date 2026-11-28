import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { FileDiff } from "lucide-react";
import { api, type GitChangeGroup, type GitIndexAction, type GitIndexSnapshot, type GitWorkingChange, type GitWorkingDiff,
  type GitWorkingIndex, type NamedFile } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { bookmarkFile } from "./fileBookmarks";
import { imageType } from "./ImageViewport";
import { t } from "./i18n";
import { opposite, type Side } from "./panes";

const groupLabels: Record<GitChangeGroup, string> = {
  staged: "Staged", unstaged: "Unstaged", untracked: "Untracked",
};
const statusLabels: Readonly<Record<string, string>> = {
  "?": "New", A: "Added", M: "Modified", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed", U: "Conflict",
};
const fallbacks: Record<NonNullable<GitWorkingDiff["fallback"]>, string> = {
  binary: "A text diff is unavailable for binary content.",
  conflict: "A text diff is unavailable for this conflict.",
  oversized: "This change is too large to preview.",
  unsupported: "A text diff is unavailable for this change.",
};

const changeId = ({ group, path }: GitWorkingChange) => JSON.stringify([group, path]);
const changeLabel = ({ path, previousPath }: GitWorkingChange) => previousPath ? previousPath + " → " + path : path;

function Preview({ root, change, onOpen, canEdit, actions }: {
  root: string;
  change: GitWorkingChange;
  onOpen?: (file: NamedFile, editing: boolean) => void;
  canEdit?: (file: NamedFile) => boolean;
  actions?: ReactNode;
}) {
  const [diff, setDiff] = useState<GitWorkingDiff | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let canceled = false;
    void api.gitWorkingDiff(root, change).then((result) => { if (!canceled) setDiff(result); },
      () => { if (!canceled) setError(true); });
    return () => { canceled = true; };
  }, [root, change]);
  const file = diff?.workingPath ? bookmarkFile(diff.workingPath) : null;
  const comparison = change.group === "staged" ? diff?.unborn ? "Empty tree → Index" : "HEAD → Index" :
    change.group === "unstaged" ? "Index → Working file" : "New working file";
  return <>
    <div className="git-change-summary">
      <strong>{changeLabel(change)}</strong>
      <span>{t(comparison)}</span>
      <div className="git-change-actions">
        {actions}
        {file && onOpen && (diff?.workingText || imageType(file.name)) && <>
          <Button onClick={() => onOpen(file, false)}>{t("Open in Viewer")}</Button>
          {canEdit?.(file) && <Button onClick={() => onOpen(file, true)}>{t("Open in Editor")}</Button>}
        </>}
      </div>
    </div>
    {error ? <p className="pane-empty git-error" role="alert">{t("Could not read this change.")}</p> :
      !diff ? <p className="pane-empty" role="status">{t("Reading change…")}</p> :
      diff.fallback ? <p className="pane-empty">{t(fallbacks[diff.fallback])}</p> :
      <pre className="git-patch" tabIndex={0} aria-label={t("Inline diff")}><code>
        {(diff.patch ?? "").match(/[^\n]*\n|[^\n]+$/g)?.map((line, index) =>
          <span key={index} data-diff={line.startsWith("+") && !line.startsWith("+++") ? "added" :
            line.startsWith("-") && !line.startsWith("---") ? "removed" : undefined}>{line}</span>)}
      </code></pre>}
  </>;
}

const writeErrors: Record<string, string> = {
  stale: "The checked-out branch or staged changes changed. Review the refreshed changes and try again.",
  busy: "The Git index is locked. Finish the other Git operation and refresh.",
  operationInProgress: "Finish the current Git operation or resolve its conflicts before writing changes.",
  detached: "Switch to a branch to create a commit.",
  unsupportedChange: "Use Git in a terminal to change this submodule or directory entry.",
  emptyCommit: "Stage files and enter a commit message first.",
  gitTooOld: "Update Git to 2.29 or newer to commit from Git View.",
};

function writeFailure(error: unknown) {
  return (error instanceof Error ? error.cause : error) as { kind?: string; detail?: string } | null;
}

export function writeError(error: unknown) {
  const failure = writeFailure(error);
  const message = failure?.kind ? writeErrors[failure.kind] : undefined;
  return message ? t(message) : t(failure?.detail || "Git could not complete the operation.");
}

export function GitChanges({ side, root, refresh, selected, onSelect, header, repository, onOpen, canEdit, onRefresh,
  draft, onDraft }: {
  side: Side;
  root: string;
  refresh: number;
  selected: string;
  onSelect: (id: string) => void;
  header: ReactNode;
  repository: ReactNode;
  onOpen: (file: NamedFile, editing: boolean) => void;
  canEdit: (file: NamedFile) => boolean;
  onRefresh: () => void;
  draft: string;
  onDraft: (message: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [result, setResult] = useState<{ refresh: number; index: GitWorkingIndex | null }>();
  const [pending, setPending] = useState<GitIndexAction | "commit">();
  const [feedback, setFeedback] = useState<{ error: boolean; message: string }>();
  const [replacement, setReplacement] = useState<{ change: GitWorkingChange; snapshot: GitIndexSnapshot }>();
  const [review, setReview] = useState<{ changes: GitWorkingChange[]; snapshot: GitIndexSnapshot }>();
  const [reviewPath, setReviewPath] = useState("");
  const mounted = useRef(false);
  const writing = useRef(false);
  const refocus = useRef<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const filterField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    mounted.current = true;
    filterField.current?.focus();
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let canceled = false;
    void api.gitIndexState(root).then((index) => { if (!canceled) setResult({ refresh, index }); },
      () => { if (!canceled) setResult({ refresh, index: null }); });
    return () => { canceled = true; };
  }, [root, refresh]);
  const index = result?.refresh === refresh ? result.index : undefined;
  const rows = index === null ? null : index?.changes;
  const staged = rows?.filter((row) => row.group === "staged") ?? [];
  const branchName = index?.snapshot.headRef?.replace(/^refs\/heads\//, "");
  const groups = (Object.keys(groupLabels) as GitChangeGroup[]).map((group) => ({
    group, rows: (rows ?? []).filter((row) => row.group === group &&
      changeLabel(row).toLocaleLowerCase().includes(filter.toLocaleLowerCase())),
  }));
  const visible = groups.flatMap(({ rows }) => rows);
  const change = visible.find((row) => changeId(row) === selected) ?? visible[0];
  const current = change ? changeId(change) : "";
  const isSubmodule = !!(change && index?.submodules.includes(change.path));
  const selectedReview = review?.changes.find((row) => changeId(row) === reviewPath);

  useLayoutEffect(() => {
    if (!index || refocus.current === null) return;
    const id = refocus.current;
    refocus.current = null;
    const options = [...(list.current?.querySelectorAll<HTMLElement>("[role=option]") ?? [])];
    const target = options.find((row) => row.dataset.gitPath === id) ??
      options.find((row) => row.tabIndex === 0) ?? filterField.current;
    target?.focus();
  }, [current, index]);

  async function changeIndex(target: GitWorkingChange, snapshot: GitIndexSnapshot, action: GitIndexAction, replace: boolean) {
    if (writing.current) return;
    writing.current = true;
    setPending(action);
    setFeedback(undefined);
    try {
      await api.gitUpdateIndex(root, snapshot, target, action, replace);
      if (mounted.current) {
        refocus.current = target.path;
        onRefresh();
      }
    } catch (error) {
      if (!mounted.current) return;
      if (writeFailure(error)?.kind === "confirmReplacement") setReplacement({ change: target, snapshot });
      else {
        setFeedback({ error: true, message: writeError(error) });
        refocus.current = target.path;
        onRefresh();
      }
    } finally {
      writing.current = false;
      if (mounted.current) setPending(undefined);
    }
  }

  async function commit() {
    if (!review || writing.current || !draft.trim()) return;
    writing.current = true;
    setPending("commit");
    setFeedback(undefined);
    try {
      const hash = await api.gitCommitChanges(root, review.snapshot, draft);
      if (mounted.current) {
        onDraft("");
        setFeedback({ error: false, message: t("Created commit {0}.", hash) });
      }
    } catch (error) {
      if (mounted.current) setFeedback({ error: true, message: writeError(error) });
    } finally {
      writing.current = false;
      if (mounted.current) {
        setPending(undefined);
        setReview(undefined);
        refocus.current = change?.path ?? "";
        onRefresh();
      }
    }
  }
  function handleKeys(event: KeyboardEvent) {
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    const index = visible.indexOf(change);
    const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 :
      event.key === "Home" ? 0 : event.key === "End" ? visible.length - 1 : null;
    if (next === null || !visible.length) return;
    event.preventDefault();
    list.current?.querySelectorAll<HTMLElement>("[role=option]")[Math.max(0, Math.min(next, visible.length - 1))]?.focus();
  }
  return <>
    <section className={"pane git-pane git-pane-" + side} aria-label={t("Changes")} data-help-topic="gitView" data-pane-side={side}>
      {header}
      {repository}
      {index && <div className="git-index-summary">
        <span title={branchName}>{branchName ? index.snapshot.head ? t("Branch {0}", branchName) :
          t("Branch {0} has no commits yet.", branchName) : t("Detached HEAD")}</span>
        <span>{t("Staged files: {0}", staged.length)}</span>
        <Button disabled={!staged.length || !branchName || index.writeBlocked || !!pending} onClick={() => {
          setReview({ changes: staged, snapshot: index.snapshot });
          setReviewPath("");
        }}>{t("Commit…")}</Button>
      </div>}
      {index?.writeBlocked && <p className="git-write-feedback">{t(writeErrors.operationInProgress)}</p>}
      {index && !branchName && <p className="git-write-feedback">{t(writeErrors.detached)}</p>}
      {feedback && <p className={"git-write-feedback" + (feedback.error ? " git-error" : "")}
        role={feedback.error ? "alert" : "status"}>{feedback.message}</p>}
      {pending && pending !== "commit" && <p className="git-write-feedback" role="status">
        {t(pending === "stage" ? "Staging…" : "Unstaging…")}</p>}
      <input className="git-filter" ref={filterField} type="search" value={filter} aria-label={t("Filter changed paths")}
        placeholder={t("Filter changed paths")} onChange={(event) => setFilter(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" || !change) return;
          event.preventDefault();
          list.current?.querySelector<HTMLElement>("[role=option][tabindex='0']")?.focus();
        }} />
      {rows === undefined ? <p className="pane-empty" role="status">{t("Reading working tree…")}</p> :
        rows === null ? <p className="pane-empty git-error" role="alert">{t("Could not read working tree changes.")}</p> :
        !rows.length ? <p className="pane-empty">{t("Working tree is clean.")}</p> :
        !visible.length ? <p className="pane-empty">{t("No matching changed paths.")}</p> :
        <div className="git-scroll" ref={list} role="listbox" aria-label={t("Changed paths")} onKeyDown={handleKeys}>
          {groups.map(({ group, rows }) => rows.length > 0 && <div className="git-branch-group" role="group"
            key={group} aria-label={t(groupLabels[group])}>
            <h3>{t(groupLabels[group])}</h3>
            {rows.map((row) => {
              const id = changeId(row);
              const label = changeLabel(row);
              return <Button role="option" key={id} aria-selected={current === id} tabIndex={current === id ? 0 : -1}
                data-git-path={row.path}
                onFocus={() => onSelect(id)} onClick={() => onSelect(id)}>
                <span title={label}>{label}</span><small>{t(statusLabels[row.status] ?? row.status)}</small>
              </Button>;
            })}
          </div>)}
        </div>}
    </section>
    <section className={"pane git-pane git-pane-" + opposite(side)} aria-label={t("Change preview")}
      data-help-topic="gitView" data-pane-side={opposite(side)}>
      <header className="pane-heading"><span className="pane-title"><FileDiff aria-hidden="true" />{t("Change preview")}</span></header>
      {change && index && <Preview key={JSON.stringify([root, refresh, current])} root={root} change={change} onOpen={onOpen} canEdit={canEdit}
        actions={isSubmodule ? <span>{t(writeErrors.unsupportedChange)}</span> : <Button
          disabled={!!pending || index.writeBlocked} onClick={() => {
            if (change.group !== "staged" && staged.some((row) => row.path === change.path ||
              change.previousPath && row.path === change.previousPath)) {
              setReplacement({ change, snapshot: index.snapshot });
            } else void changeIndex(change, index.snapshot, change.group === "staged" ? "unstage" : "stage", false);
          }}>
          {t(change.group === "staged" ? "Unstage" : "Stage")}
        </Button>} />}
    </section>
    {replacement && <Dialog title={t("Replace staged changes?")} helpTopic="gitView" onClose={() => setReplacement(undefined)}
      footer={<>
        <Button onClick={() => setReplacement(undefined)}>{t("Cancel")}</Button>
        <Button onClick={() => {
          setReplacement(undefined);
          void changeIndex(replacement.change, replacement.snapshot, "stage", true);
        }}>{t("Replace and stage")}</Button>
      </>}>
      <p>{t("Stage the entire working version of {0} and replace its staged changes?", changeLabel(replacement.change))}</p>
    </Dialog>}
    {review && <Dialog title={t("Commit staged changes")} helpTopic="gitView" wide onClose={() => {
      if (!writing.current) setReview(undefined);
    }} footer={<>
      <Button disabled={!!pending} onClick={() => setReview(undefined)}>{t("Cancel")}</Button>
      <Button disabled={!!pending || !draft.trim()} onClick={() => void commit()}>{t(pending === "commit" ? "Committing…" : "Commit")}</Button>
    </>}>
      <p className="git-commit-context"><strong>{root}</strong><span>{t("Branch {0}", review.snapshot.headRef?.replace(/^refs\/heads\//, "") ?? "")}</span></p>
      <p>{t("Staged files: {0}", review.changes.length)}</p>
      <ul className="git-commit-paths">
        {review.changes.map((row) => <li key={changeId(row)}><Button aria-pressed={reviewPath === changeId(row)}
          disabled={!!pending} onClick={() => setReviewPath(changeId(row))}>{changeLabel(row)}</Button></li>)}
      </ul>
      {selectedReview && <div className="git-commit-diff">
        <Preview key={reviewPath} root={root} change={selectedReview} />
      </div>}
      <label className="field">{t("Commit message")}
        <textarea data-initial-focus value={draft} rows={4} disabled={!!pending} onChange={(event) => onDraft(event.target.value)} />
      </label>
    </Dialog>}
  </>;
}
