import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { FileDiff } from "lucide-react";
import { api, type GitBulkPlan, type GitChangeGroup, type GitDiscardPlan, type GitHunkPlan, type GitIndexAction, type GitIndexSnapshot, type GitWorkingChange, type GitWorkingDiff,
  type GitWorkingIndex, type NamedFile } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { bookmarkFile } from "./fileBookmarks";
import { GitStashes } from "./GitStashes";
import { writeError, writeErrors, writeFailure } from "./gitWriteError";
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

function BulkSelection({ root, index, onClose, onRefresh }: {
  root: string; index: GitWorkingIndex; onClose: () => void; onRefresh: () => void;
}) {
  const [action, setAction] = useState<GitIndexAction>("stage");
  const [marked, setMarked] = useState<string[]>([]);
  const [review, setReview] = useState<GitBulkPlan>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const rows = index.changes.filter((row) => (row.group === "staged") === (action === "unstage") &&
    !index.submodules.includes(row.path));
  const verb = action === "stage" ? "Stage selected files" : "Unstage selected files";
  async function next() {
    setPending(true);
    setError("");
    try {
      if (review) {
        await api.gitApplyBulk(root, review);
        onClose();
        onRefresh();
      } else {
        setReview(await api.gitBulkPlan(root, index.snapshot, rows.filter((row) => marked.includes(changeId(row))), action));
      }
    } catch (error) {
      setError(writeError(error));
      setReview(undefined);
      onRefresh();
    } finally {
      setPending(false);
    }
  }
  return <Dialog title={t(review ? verb : "Select changed files")} helpTopic="gitView" wide
    onClose={pending ? undefined : onClose} footer={<>
      <Button disabled={pending} onClick={onClose}>{t("Cancel")}</Button>
      <Button disabled={pending || !marked.length} onClick={() => void next()}>{t(review ? verb : "Review changes")}</Button>
    </>}>
    <p><code>{root}</code></p>
    {error && <p role="alert">{error}</p>}
    {review ? <>
      {action === "stage" && <p>{t("Stage the full working versions of these files, including replacements for any staged versions.")}</p>}
      <ul>{review.changes.map((row) => <li key={changeId(row)}>{changeLabel(row)}</li>)}</ul>
    </> : <>
      <label className="field">{t("Index action")}
        <select value={action} disabled={pending} onChange={(event) => {
          setAction(event.target.value as GitIndexAction);
          setMarked([]);
        }}>
          <option value="stage">{t("Stage")}</option><option value="unstage">{t("Unstage")}</option>
        </select>
      </label>
      <Button disabled={pending || !rows.length} onClick={() =>
        setMarked(marked.length === rows.length ? [] : rows.map(changeId))}>{t(marked.length && marked.length === rows.length ? "Clear selection" : "Select all")}</Button>
      <div className="git-bulk-list">{rows.map((row) => {
        const id = changeId(row);
        return <label key={id} className="field-checkbox">
          <input type="checkbox" disabled={pending} checked={marked.includes(id)} onChange={(event) =>
            setMarked(event.target.checked ? [...marked, id] : marked.filter((path) => path !== id))} />{changeLabel(row)}
        </label>;
      })}</div>
    </>}
  </Dialog>;
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
  const [pending, setPending] = useState<GitIndexAction | "commit" | "review">();
  const [feedback, setFeedback] = useState<{ error: boolean; message: string }>();
  const [replacement, setReplacement] = useState<{ change: GitWorkingChange; snapshot: GitIndexSnapshot }>();
  const [review, setReview] = useState<{ changes: GitWorkingChange[]; snapshot: GitIndexSnapshot; amendMessage?: string }>();
  const [reviewPath, setReviewPath] = useState("");
  const [bulk, setBulk] = useState<GitWorkingIndex>();
  const [stash, setStash] = useState(false);
  const [patchReview, setPatchReview] = useState<{ kind: "hunks"; plan: GitHunkPlan } | { kind: "discard"; plan: GitDiscardPlan }>();
  const [hunk, setHunk] = useState(0);
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
  const amend = review?.amendMessage !== undefined;
  const commitMessage = review?.amendMessage ?? draft;

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
    if (!review || writing.current || !commitMessage.trim()) return;
    writing.current = true;
    setPending("commit");
    setFeedback(undefined);
    try {
      const command = amend ? api.gitAmendChanges : api.gitCommitChanges;
      const hash = await command(root, review.snapshot, commitMessage);
      if (mounted.current) {
        if (!amend) onDraft("");
        setFeedback({ error: false, message: t(amend ? "Amended commit {0}." : "Created commit {0}.", hash) });
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
  async function gitReview(run: () => Promise<void>, refreshAfter = false) {
    if (writing.current) return;
    writing.current = true;
    setPending("review");
    setFeedback(undefined);
    try {
      await run();
    } catch (error) {
      if (mounted.current) setFeedback({ error: true, message: writeError(error) });
      refreshAfter = true;
    } finally {
      writing.current = false;
      if (mounted.current) {
        setPending(undefined);
        if (refreshAfter) {
          refocus.current = change?.path ?? "";
          onRefresh();
        }
      }
    }
  }
  function startAmend(current: GitWorkingIndex) {
    const { head } = current.snapshot;
    if (!head) return;
    void gitReview(async () => {
      const details = await api.gitDetails(root, head);
      setReview({ changes: staged, snapshot: current.snapshot, amendMessage: details.message.trimEnd() });
      setReviewPath("");
    });
  }
  function startPatchReview(kind: "discard" | "hunks", target: GitWorkingChange, snapshot: GitIndexSnapshot) {
    void gitReview(async () => {
      if (kind === "discard") {
        setPatchReview({ kind, plan: await api.gitDiscardPlan(root, snapshot, target) });
      } else {
        const plan = await api.gitHunkPlan(root, snapshot, target);
        if (plan) {
          setHunk(0);
          setPatchReview({ kind, plan });
        } else {
          setFeedback({ error: false, message: t("No independently stageable text hunks.") });
        }
      }
    });
  }
  function applyPatch() {
    if (!patchReview) return;
    setPatchReview(undefined);
    void gitReview(async () => {
      if (patchReview.kind === "hunks") await api.gitApplyHunk(root, patchReview.plan.review, hunk);
      else await api.gitDiscardWorktree(root, patchReview.plan.review);
    }, true);
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
        <Button disabled={!index.snapshot.head || !branchName || index.writeBlocked || !!pending}
          onClick={() => startAmend(index)}>{t("Amend…")}</Button>
        <Button disabled={!rows?.length || index.writeBlocked || !!pending} onClick={() => setBulk(index)}>{t("Select files…")}</Button>
        <Button disabled={!!pending} onClick={() => setStash(true)}>{t("Stashes…")}</Button>
      </div>}
      {index?.writeBlocked && <p className="git-write-feedback">{t(writeErrors.operationInProgress)}</p>}
      {index && !branchName && <p className="git-write-feedback">{t(writeErrors.detached)}</p>}
      {feedback && <p className={"git-write-feedback" + (feedback.error ? " git-error" : "")}
        role={feedback.error ? "alert" : "status"}>{feedback.message}</p>}
      {pending && pending !== "commit" && <p className="git-write-feedback" role="status">
        {t(pending === "review" ? "Working with Git…" : pending === "stage" ? "Staging…" : "Unstaging…")}</p>}
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
        actions={isSubmodule ? <span>{t(writeErrors.unsupportedChange)}</span> : <><Button
          disabled={!!pending || index.writeBlocked} onClick={() => {
            if (change.group !== "staged" && staged.some((row) => row.path === change.path ||
              change.previousPath && row.path === change.previousPath)) {
              setReplacement({ change, snapshot: index.snapshot });
            } else void changeIndex(change, index.snapshot, change.group === "staged" ? "unstage" : "stage", false);
          }}>
          {t(change.group === "staged" ? "Unstage" : "Stage")}
        </Button>
          {change.group !== "untracked" && change.status === "M" &&
            <Button disabled={!!pending || index.writeBlocked} onClick={() => startPatchReview("hunks", change, index.snapshot)}>
              {t(change.group === "staged" ? "Unstage hunk…" : "Stage hunk…")}
            </Button>}
          {change.group !== "staged" && !["R", "C", "U"].includes(change.status) &&
            <Button disabled={!!pending || index.writeBlocked} onClick={() => startPatchReview("discard", change, index.snapshot)}>
              {t("Discard…")}
            </Button>}
        </>} />}
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
    {review && <Dialog title={t(amend ? "Amend current commit" : "Commit staged changes")} helpTopic="gitView" wide onClose={() => {
      if (!writing.current) setReview(undefined);
    }} footer={<>
      <Button disabled={!!pending} onClick={() => setReview(undefined)}>{t("Cancel")}</Button>
      <Button disabled={!!pending || !commitMessage.trim()}
        onClick={() => void commit()}>{t(pending === "commit" ? "Committing…" : amend ? "Amend commit" : "Commit")}</Button>
    </>}>
      <p className="git-commit-context"><strong>{root}</strong><span>{t("Branch {0}", review.snapshot.headRef?.replace(/^refs\/heads\//, "") ?? "")}</span></p>
      {amend && <p>{t("Replace current commit {0}.", review.snapshot.head?.slice(0, 12) ?? "")}</p>}
      <p>{t("Staged files: {0}", review.changes.length)}</p>
      <ul className="git-commit-paths">
        {review.changes.map((row) => <li key={changeId(row)}><Button aria-pressed={reviewPath === changeId(row)}
          disabled={!!pending} onClick={() => setReviewPath(changeId(row))}>{changeLabel(row)}</Button></li>)}
      </ul>
      {selectedReview && <div className="git-commit-diff">
        <Preview key={reviewPath} root={root} change={selectedReview} />
      </div>}
      <label className="field">{t("Commit message")}
        <textarea data-initial-focus value={commitMessage} rows={4} disabled={!!pending} onChange={(event) => {
          if (amend) setReview({ ...review, amendMessage: event.target.value });
          else onDraft(event.target.value);
        }} />
      </label>
    </Dialog>}
    {bulk && <BulkSelection root={root} index={index ?? bulk} onClose={() => setBulk(undefined)} onRefresh={onRefresh} />}
    {stash && <GitStashes root={root} index={index} refresh={refresh} onClose={() => setStash(false)} onRefresh={onRefresh} />}
    {patchReview && <Dialog title={t(patchReview.kind === "discard" ? "Discard working change" : "Review text hunks")}
      helpTopic="gitView" wide onClose={() => setPatchReview(undefined)} footer={<>
        <Button onClick={() => setPatchReview(undefined)}>{t("Cancel")}</Button>
        <Button disabled={!!pending} onClick={applyPatch}>{t(patchReview.kind === "discard" ? "Discard working change" :
          patchReview.plan.review.change.group === "staged" ? "Unstage this hunk" : "Stage this hunk")}</Button>
      </>}>
      <p><code>{root}</code></p><p>{changeLabel(patchReview.plan.review.change)}</p>
      {patchReview.kind === "discard" ? <>
        <p>{t(patchReview.plan.review.change.group === "untracked" ?
          "Remove this untracked file from the working tree." : "Restore the working file from the index. Staged changes are preserved.")}</p>
        {patchReview.plan.diff.fallback ? <p>{t(fallbacks[patchReview.plan.diff.fallback])}</p> :
          <pre className="git-patch" tabIndex={0} aria-label={t("Inline diff")}>{patchReview.plan.diff.patch}</pre>}
      </> : <>
        <label className="field">{t("Hunk")}
          <select value={hunk} onChange={(event) => setHunk(Number(event.target.value))}>
            {patchReview.plan.hunks.map((patch, index) => <option key={index} value={index}>{patch.split("\n", 1)[0]}</option>)}
          </select>
        </label>
        <pre className="git-patch" tabIndex={0} aria-label={t("Inline diff")}>{patchReview.plan.hunks[hunk]}</pre>
      </>}
    </Dialog>}
  </>;
}
