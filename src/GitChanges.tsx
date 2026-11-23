import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { FileDiff } from "lucide-react";
import { api, type GitChangeGroup, type GitWorkingChange, type GitWorkingDiff, type NamedFile } from "./api";
import { Button } from "./Button";
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

function Preview({ root, change, onOpen, canEdit }: {
  root: string;
  change: GitWorkingChange;
  onOpen: (file: NamedFile, editing: boolean) => void;
  canEdit: (file: NamedFile) => boolean;
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
      {file && (diff?.workingText || imageType(file.name)) && <div className="git-change-actions">
        <Button onClick={() => onOpen(file, false)}>{t("Open in Viewer")}</Button>
        {canEdit(file) && <Button onClick={() => onOpen(file, true)}>{t("Open in Editor")}</Button>}
      </div>}
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

export function GitChanges({ side, root, refresh, selected, onSelect, header, repository, onOpen, canEdit }: {
  side: Side;
  root: string;
  refresh: number;
  selected: string;
  onSelect: (id: string) => void;
  header: ReactNode;
  repository: ReactNode;
  onOpen: (file: NamedFile, editing: boolean) => void;
  canEdit: (file: NamedFile) => boolean;
}) {
  const [filter, setFilter] = useState("");
  const [result, setResult] = useState<{ refresh: number; rows: GitWorkingChange[] | null }>();
  const list = useRef<HTMLDivElement>(null);
  const filterField = useRef<HTMLInputElement>(null);
  useEffect(() => { filterField.current?.focus(); }, []);
  useEffect(() => {
    let canceled = false;
    void api.gitWorkingChanges(root).then((rows) => { if (!canceled) setResult({ refresh, rows }); },
      () => { if (!canceled) setResult({ refresh, rows: null }); });
    return () => { canceled = true; };
  }, [root, refresh]);
  const rows = result?.refresh === refresh ? result.rows : undefined;
  const groups = (Object.keys(groupLabels) as GitChangeGroup[]).map((group) => ({
    group, rows: (rows ?? []).filter((row) => row.group === group &&
      changeLabel(row).toLocaleLowerCase().includes(filter.toLocaleLowerCase())),
  }));
  const visible = groups.flatMap(({ rows }) => rows);
  const change = visible.find((row) => changeId(row) === selected) ?? visible[0];
  const current = change ? changeId(change) : "";
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
      {change && <Preview key={JSON.stringify([root, refresh, current])} root={root} change={change} onOpen={onOpen} canEdit={canEdit} />}
    </section>
  </>;
}
