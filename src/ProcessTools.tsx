import { countText, errorText, locale, t } from "./i18n";
import { Button } from "./Button";
import { ColumnMenu, columnMenuBindings, type ColumnMenuAnchor } from "./ColumnMenu";
import { ColumnResizeHandle, clampColumnWidth } from "./ColumnResizeHandle";
import { QuickSearch, useQuickSearch } from "./QuickSearch";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Cpu } from "lucide-react";
import { api, describeError, type ProcessInfo } from "./api";
import { Dialog } from "./Dialog";
import { FileContextMenu } from "./FileContextMenu";
import { formatSize, type Side } from "./panes";
import { bindingMatches, eventShortcut } from "./preferences";
import { useWindowsIcons } from "./useWindowsIcons";

export function ElevationButton({ directory }: { directory: string }) {
  const [error, setError] = useState("");
  return (
    <div className="elevation-action">
      <Button type="button" onClick={() => {
        setError("");
        void api.openElevated(directory).catch((failure: unknown) => setError(describeError(failure)));
      }}>{t("Open as administrator")}</Button>
      {error && <p role="alert">{errorText(error)}</p>}
    </div>
  );
}

const processKey = ({ pid, started }: ProcessInfo) => `${pid}-${started}`;
const byProcessName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function Processes({ items, selected, onChange }: {
  items: ProcessInfo[];
  selected: string[];
  onChange: (selected: string[]) => void;
}) {
  return (
    <select aria-label={t("Locking processes")} multiple size={8} value={selected}
      onChange={(event) => onChange(Array.from(event.currentTarget.selectedOptions, ({ value }) => value))}>
      {items.map((process) => (
        <option value={processKey(process)} key={processKey(process)} disabled={!process.canTerminate}>
          {process.name || t("Process")} (PID {process.pid})
        </option>
      ))}
    </select>
  );
}

function EndProcesses({ items, onClose, onFinished, onAttempted }: {
  items: ProcessInfo[];
  onClose: () => void;
  onFinished: () => void;
  onAttempted?: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  async function end() {
    if (working) return;
    setWorking(true);
    setError("");
    try {
      const errors = await api.terminateProcesses(items.map(({ pid, started }) => ({ pid, started })));
      if (errors.length) setError(errors.join("\n"));
      else onFinished();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      onAttempted?.();
      setWorking(false);
    }
  }

  return (
    <Dialog title={t("End processes")} tone="warning" onClose={() => { if (!working) onClose(); }}>
      <div className="dialog-body end-processes">
        <p className="delete-warning">{t("Ending processes may cause unsaved work to be lost.")}</p>
        <ul>{items.map(({ pid, name }) => <li key={pid}>{name || t("Process")} (PID {pid})</li>)}</ul>
        {error && <p className="dialog-error process-error" role="alert">{errorText(error)}</p>}
      </div>
      <footer className="dialog-footer">
        <Button type="button" data-initial-focus disabled={working} onClick={onClose}>{t("Cancel")}</Button>
        <Button type="button" className="alert-confirm" disabled={working} onClick={() => { void end(); }}>
          {items.length === 1 ? t("End process") : t("End {0}", countText(items.length, "process"))}
        </Button>
      </footer>
    </Dialog>
  );
}

const processColumns = [
  { key: "name", label: "Process", min: 82, width: 156 },
  { key: "pid", label: "PID", min: 52, width: 76 },
  { key: "cpu", label: "CPU", min: 53, width: 77 },
  { key: "memory", label: "Memory", min: 64, width: 104 },
  { key: "executable", label: "Executable path", min: 115, width: 230 },
] as const;
type ProcessColumn = (typeof processColumns)[number]["key"];
type ProcessWidths = Partial<Record<ProcessColumn, number>>;

function processColumnsKey(side: Side) {
  return `dirlume.process-columns.${side}`;
}

function hiddenProcessColumns(side: Side): ProcessColumn[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(processColumnsKey(side)) ?? "[]");
    const hidden = Array.isArray(value) ? processColumns.filter(({ key }) => value.includes(key)).map(({ key }) => key) : [];
    return hidden.length < processColumns.length ? hidden : [];
  } catch { return []; }
}

function readProcessWidths(side: Side): ProcessWidths {
  const widths: ProcessWidths = {};
  try {
    const saved = JSON.parse(localStorage.getItem(`dirlume.process-widths.${side}`) ?? "null") as ProcessWidths | null;
    for (const { key, min } of processColumns) {
      const value = saved?.[key];
      if (typeof value === "number" && Number.isFinite(value)) widths[key] = clampColumnWidth(value, min);
    }
  } catch { /* Use the default widths. */ }
  return widths;
}

function processCpu(cpu: number) {
  return cpu.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";
}

function ProcessProperties({ process, onClose, onEnd }: {
  process: ProcessInfo;
  onClose: () => void;
  onEnd: () => void;
}) {
  return <Dialog title={t("Process properties")} onClose={onClose}>
    <div className="dialog-body">
      <dl className="process-properties">
        <dt>{t("Process")}</dt><dd>{process.name || t("Process")}</dd>
        <dt>{t("PID")}</dt><dd>{process.pid}</dd>
        <dt>{t("CPU")}</dt><dd>{processCpu(process.cpu)}</dd>
        <dt>{t("Memory")}</dt><dd>{formatSize(process.memory)}</dd>
        <dt>{t("Executable path")}</dt><dd>{process.executable ?? "—"}</dd>
      </dl>
    </div>
    <footer className="dialog-footer">
      <Button type="button" data-initial-focus onClick={onClose}>{t("Close")}</Button>
      <Button type="button" className="negative" disabled={!process.canTerminate} onClick={onEnd}>{t("End process")}</Button>
    </footer>
  </Dialog>;
}

export function ProcessBrowser({ side, lockingPath, menuShortcut, onShowExecutable, onFeedback, onClose }: {
  side: Side;
  lockingPath?: string;
  menuShortcut: readonly string[];
  onShowExecutable: (path: string) => Promise<void>;
  onFeedback: (text: string, error?: boolean) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<ProcessInfo[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [ending, setEnding] = useState<ProcessInfo[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [partial, setPartial] = useState(false);
  const [properties, setProperties] = useState<ProcessInfo | null>(null);
  const [rowMenu, setRowMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const [revision, setRevision] = useState(0);
  const [quickSearch, setQuickSearch] = useQuickSearch(side);
  const [sort, setSort] = useState<{ column: ProcessColumn; asc: boolean }>({ column: "name", asc: true });
  const [focused, setFocused] = useState("");
  const [hidden, setHidden] = useState(() => hiddenProcessColumns(side));
  const [widths, setWidths] = useState(() => readProcessWidths(side));
  const [columnsAnchor, setColumnsAnchor] = useState<ColumnMenuAnchor | null>(null);
  const displayed = processColumns.filter(({ key }) => !hidden.includes(key));
  const fillName = widths.name === undefined && !hidden.includes("name");
  const tableWidth = displayed.reduce((sum, column) => sum + (widths[column.key] ?? column.width), 0);
  const anchor = useRef("");
  const table = useRef<HTMLTableElement>(null);
  const visible = useMemo(() => {
    const { column, asc } = sort;
    return [...items].sort((a, b) => {
        const order = column === "name" ? byProcessName.compare(a.name, b.name) :
          column === "executable" ? byProcessName.compare(a.executable ?? "", b.executable ?? "") : a[column] - b[column];
        return (asc ? order : -order) || a.pid - b.pid;
      });
  }, [items, sort]);
  const processIcons = useMemo(() => new Map(visible.map((item) => [processKey(item), { pid: item.pid, started: item.started }])), [visible]);
  const icons = useWindowsIcons(processIcons, api.processIcons);
  const marked = visible.filter((process) => process.canTerminate && selected.includes(processKey(process)));
  const focusedProcess = visible.find((process) => processKey(process) === focused);
  const menuProcess = rowMenu && items.find((process) => processKey(process) === rowMenu.key);
  const endRequest = useRef(() => {});
  endRequest.current = () => { if (marked.length) setEnding(marked); };

  useEffect(() => {
    setItems([]);
    setLoaded(false);
    setPartial(false);
    setError("");
    setSelected([]);
    setFocused("");
    setProperties(null);
    setRowMenu(null);
    setQuickSearch(null);
  }, [lockingPath]);

  useEffect(() => {
    if (rowMenu && !menuProcess) {
      setRowMenu(null);
      table.current?.focus({ preventScroll: true });
    }
  }, [menuProcess, rowMenu]);

  useEffect(() => {
    let closed = false;
    let pending = false;
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const { processes, incomplete } = lockingPath
          ? await api.lockingProcesses([lockingPath]) : { processes: await api.listProcesses(), incomplete: false };
        if (!closed) {
          setItems(processes);
          setLoaded(true);
          setPartial(incomplete);
          setError("");
        }
      } catch (failure) {
        if (!closed) setError(describeError(failure));
      } finally {
        pending = false;
      }
    }
    void refresh();
    const timer = lockingPath ? undefined : window.setInterval(() => { void refresh(); }, 2000);
    return () => { closed = true; window.clearInterval(timer); };
  }, [lockingPath, revision]);

  useEffect(() => {
    const element = document.getElementById(`${side}-pane`);
    const end = () => endRequest.current();
    element?.addEventListener("dirlume-end-processes", end);
    return () => element?.removeEventListener("dirlume-end-processes", end);
  }, [side]);

  function changeSelection(index: number, range: boolean, toggle: boolean) {
    const item = visible[index];
    if (!item) return;
    const key = processKey(item);
    const from = visible.findIndex((process) => processKey(process) === anchor.current);
    setFocused(key);
    if (range && from >= 0) {
      setSelected(visible.slice(Math.min(from, index), Math.max(from, index) + 1).filter((process) => process.canTerminate).map(processKey));
    } else {
      anchor.current = key;
      if (!item.canTerminate) {
        if (!toggle) setSelected([]);
      } else if (toggle) {
        setSelected((previous) => previous.includes(key) ? previous.filter((id) => id !== key) : [...previous, key]);
      } else setSelected([key]);
    }
  }

  function toggleColumn(key: ProcessColumn) {
    const showing = hidden.includes(key);
    if (!showing && displayed.length < 2) return;
    const next = showing ? hidden.filter((column) => column !== key) : [...hidden, key];
    setHidden(next);
    try { localStorage.setItem(processColumnsKey(side), JSON.stringify(next)); } catch { /* Keep the current layout. */ }
  }

  function resizeColumn(key: ProcessColumn, width: number | undefined, persist: boolean) {
    const next = { ...widths };
    if (width === undefined) delete next[key];
    else {
      const currentNameWidth = table.current?.querySelector(".process-col-name")?.getBoundingClientRect().width;
      if (key !== "name" && fillName && currentNameWidth) next.name = clampColumnWidth(currentNameWidth, processColumns[0].min);
      next[key] = width;
    }
    setWidths(next);
    if (persist) {
      try { localStorage.setItem(`dirlume.process-widths.${side}`, JSON.stringify(next)); } catch { /* Keep the current layout. */ }
    }
  }

  function focusTable() {
    table.current?.focus({ preventScroll: true });
  }

  function openRowMenu(process: ProcessInfo, x: number, y: number) {
    if (!loaded) return;
    focusTable();
    const key = processKey(process);
    setFocused(key);
    setRowMenu({ key, x, y });
  }

  function copyProcessValue(value: string, success: string) {
    setRowMenu(null);
    focusTable();
    void api.copyText(value).then(() => onFeedback(success), (error: unknown) => {
      onFeedback(t("Could not copy process details. {0}", errorText(describeError(error))), true);
    });
  }

  function showExecutable(path: string) {
    setRowMenu(null);
    focusTable();
    void onShowExecutable(path).catch((error: unknown) => onFeedback(describeError(error), true));
  }

  return (
    <div className="process-browser" onContextMenu={(event) => event.preventDefault()}>
      {lockingPath && <div className="locking-process-target">
        <span data-tooltip={lockingPath}>{t("Locking processes for {0}", lockingPath)}</span>
        <Button type="button" onClick={() => setRevision((previous) => previous + 1)}>{t("Refresh")}</Button>
        <Button type="button" onClick={onClose}>{t("Back to files")}</Button>
      </div>}
      <div className="process-scroll">
        <table ref={table} id={`${side}-files`} className="process-table file-list" tabIndex={0}
          style={{ width: fillName ? `max(100%, ${tableWidth}px)` : tableWidth }}
          role="grid" aria-label={t("Running processes")} aria-multiselectable="true"
          aria-activedescendant={focused && visible.some((item) => processKey(item) === focused) ? `${side}-process-${focused}` : undefined}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (bindingMatches(menuShortcut, eventShortcut(event))) {
              event.preventDefault();
              event.stopPropagation();
              if (!focusedProcess) return;
              const bounds = document.getElementById(`${side}-process-${focused}`)?.getBoundingClientRect();
              if (bounds) openRowMenu(focusedProcess, bounds.left + 12, bounds.bottom);
              return;
            }
            if (!visible.length) return;
            const index = visible.findIndex((item) => processKey(item) === focused);
            const next = event.key === "Home" ? 0 : event.key === "End" ? visible.length - 1 :
              event.key === "ArrowDown" ? Math.min(visible.length - 1, index + 1) :
              event.key === "ArrowUp" ? Math.max(0, index - 1) : event.key === " " ? Math.max(0, index) : null;
            if (next === null) return;
            event.preventDefault();
            event.stopPropagation();
            changeSelection(next, event.shiftKey, event.key === " ");
            document.getElementById(`${side}-process-${processKey(visible[next])}`)?.scrollIntoView({ block: "nearest" });
          }}>
          <colgroup>{displayed.map(({ key, width }) =>
            <col key={key} style={{ width: key === "name" && fillName ? undefined : widths[key] ?? width }} />)}</colgroup>
          <thead {...columnMenuBindings<HTMLTableSectionElement>((_header, anchor) => setColumnsAnchor(anchor))}><tr>{displayed.map(({ key, label, min }) => (
            <th key={key} scope="col" className={`process-col-${key}`}
              aria-sort={sort.column === key ? sort.asc ? "ascending" : "descending" : undefined}>
              <Button type="button" onClick={() => setSort({ column: key, asc: sort.column === key ? !sort.asc : ["name", "pid", "executable"].includes(key) })}>
                {t(label)}{sort.column === key && (sort.asc ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />)}
              </Button>
              <ColumnResizeHandle label={label} min={min} width={widths[key]}
                onResize={(width, persist) => resizeColumn(key, width, persist)} onReset={() => resizeColumn(key, undefined, true)} />
            </th>
          ))}</tr></thead>
          <tbody>{visible.map((process, index) => {
            const key = processKey(process);
            const icon = icons.get(key);
            const values = {
              name: <span>
                {icon ? <img className="process-icon" src={`data:image/png;base64,${icon}`} alt="" /> : <Cpu aria-hidden="true" />}
                <span>{process.name || t("Process")}</span>
              </span>,
              pid: process.pid,
              cpu: processCpu(process.cpu),
              memory: formatSize(process.memory),
              executable: process.executable ?? "—",
            };
            return <tr key={key} id={`${side}-process-${key}`} aria-selected={selected.includes(key)}
              data-current={focused === key} onClick={(event) => {
                changeSelection(index, event.shiftKey, event.ctrlKey || event.metaKey);
                focusTable();
              }} onContextMenu={(event) => {
                event.preventDefault();
                openRowMenu(process, event.clientX, event.clientY);
              }}>
              {displayed.map(({ key }) => <td key={key} className={`process-cell-${key}`}
                data-tooltip={key === "name" ? process.name : key === "executable" ? process.executable ?? undefined : undefined}>{values[key]}</td>)}
            </tr>;
          })}</tbody>
        </table>
        {!visible.length && <p className="pane-empty">{error ? t("Could not list processes.") :
          loaded ? t(lockingPath ? "Windows found no processes using these files." : "No running processes.") :
            t(lockingPath ? "Checking files…" : "Loading processes…")}</p>}
      </div>
      {quickSearch !== null && <QuickSearch side={side} query={quickSearch} current={focused}
        items={visible.map((process) => ({ id: processKey(process), name: process.name }))}
        onChange={setQuickSearch} onMatch={(key) => {
          setFocused(key);
          document.getElementById(`${side}-process-${key}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
        }}
        onAccept={(key) => changeSelection(visible.findIndex((process) => processKey(process) === key), false, false)}
        onClose={() => setQuickSearch(null)} focusList={() => table.current?.focus({ preventScroll: true })} />}
      {columnsAnchor && <ColumnMenu anchor={columnsAnchor} onClose={() => setColumnsAnchor(null)}
        fallback={() => table.current?.querySelector("thead button")} choices={processColumns.map(({ key, label }) => ({
          key, label, checked: !hidden.includes(key), disabled: displayed.length === 1 && !hidden.includes(key),
          toggle: () => toggleColumn(key),
        }))} />}
      {rowMenu && menuProcess && <FileContextMenu x={rowMenu.x} y={rowMenu.y} label="Process actions"
        onClose={() => setRowMenu(null)} onReturn={focusTable}>
        <div className="process-menu-heading" role="presentation">
          <strong>{menuProcess.name || t("Process")}</strong><span>PID {menuProcess.pid}</span>
        </div>
        <Button type="button" role="menuitem" onClick={() => { focusTable(); setRowMenu(null); setProperties(menuProcess); }}>{t("Properties")}</Button>
        {!lockingPath && <Button type="button" role="menuitem" disabled={!menuProcess.executable}
          onClick={() => { if (menuProcess.executable) showExecutable(menuProcess.executable); }}>{t("Show in other pane")}</Button>}
        <Button type="button" role="menuitem" onClick={() => copyProcessValue(String(menuProcess.pid), "PID copied to the clipboard.")}>{t("Copy PID")}</Button>
        <Button type="button" role="menuitem" disabled={!menuProcess.executable}
          onClick={() => { if (menuProcess.executable) copyProcessValue(menuProcess.executable, "Path copied to the clipboard."); }}>{t("Copy executable path")}</Button>
        <div role="separator" className="main-menu-separator" />
        <Button type="button" role="menuitem" disabled={!menuProcess.canTerminate}
          onClick={() => { focusTable(); setRowMenu(null); setEnding([menuProcess]); }}>{t("End process…")}</Button>
      </FileContextMenu>}
      {partial && <p role="status" className="pane-error">{t("Only some files could be checked.")}</p>}
      {error && <p role="alert" className="pane-error">{errorText(error)}</p>}
      <div className="pane-footer"><span>{countText(items.length, "process")}</span>
        <Button type="button" disabled={!focusedProcess} onClick={() => setProperties(focusedProcess ?? null)}>{t("Properties")}</Button>
        <Button type="button" disabled={!marked.length} onClick={() => setEnding(marked)}>{t("End selected")}</Button></div>
      {properties && <ProcessProperties process={properties} onClose={() => setProperties(null)} onEnd={() => setEnding([properties])} />}
      {ending.length > 0 && (
        <EndProcesses items={ending} onClose={() => setEnding([])} onAttempted={() => setRevision((previous) => previous + 1)} onFinished={() => {
          const ended = new Set(ending.map(processKey));
          setEnding([]);
          setProperties(null);
          setSelected((current) => current.filter((key) => !ended.has(key)));
        }} />
      )}
    </div>
  );
}

export function LockDialog({ paths, onClose }: { paths: string[]; onClose: () => void }) {
  const [items, setItems] = useState<ProcessInfo[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [partial, setPartial] = useState(false);
  const [ending, setEnding] = useState(false);
  const [revision, setRevision] = useState(0);
  const marked = items?.filter((process) => process.canTerminate && selected.includes(processKey(process))) ?? [];

  useEffect(() => {
    let canceled = false;
    setError("");
    setItems(null);
    void api.lockingProcesses(paths).then(
      ({ processes, incomplete }) => { if (!canceled) { setItems(processes); setPartial(incomplete); } },
      (failure: unknown) => { if (!canceled) setError(describeError(failure)); },
    );
    return () => { canceled = true; };
  }, [paths, revision]);

  return (
    <>
      <Dialog title={t("Processes using these files")} onClose={onClose}>
        <div className="dialog-body end-processes">
          {error ? <p role="alert" className="dialog-error">{errorText(error)}</p> :
            items === null ? <p role="status">{t("Checking files…")}</p> :
            !items.length ? <p role="status">{t("Windows found no processes using these files.")}</p> :
            <Processes items={items} selected={selected} onChange={setSelected} />}
          {partial && <p>{t("Only some files could be checked.")}</p>}
          <div className="dialog-actions dialog-actions-end">
            <Button type="button" disabled={!items?.some((process) => process.canTerminate)}
              onClick={() => setSelected(items?.filter((process) => process.canTerminate).map(processKey) ?? [])}>{t("Select all")}</Button>
          </div>
        </div>
        <footer className="dialog-footer">
          <Button type="button" onClick={onClose}>{t("Close")}</Button>
          <Button type="button" className="negative" disabled={!marked.length} onClick={() => setEnding(true)}>{t("End selected")}</Button>
        </footer>
      </Dialog>
      {ending && <EndProcesses items={marked} onClose={() => setEnding(false)} onFinished={() => {
        setEnding(false);
        setSelected([]);
        setRevision((previous) => previous + 1);
      }} />}
    </>
  );
}
