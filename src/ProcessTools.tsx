import { countText, errorText, locale, t } from "./i18n";
import { Button } from "./Button";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Cpu, Search } from "lucide-react";
import { api, describeError, type ProcessInfo } from "./api";
import { Dialog } from "./Dialog";
import { formatSize, type Side } from "./panes";
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

function EndProcesses({ items, onClose, onFinished }: {
  items: ProcessInfo[];
  onClose: () => void;
  onFinished: () => void;
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
      setWorking(false);
    }
  }

  return (
    <Dialog title={t("End processes")} onClose={() => { if (!working) onClose(); }}>
      <div className="dialog-body end-processes">
        <p className="delete-warning">{t("Ending processes may cause unsaved work to be lost.")}</p>
        <ul>{items.map(({ pid, name }) => <li key={pid}>{name || t("Process")} (PID {pid})</li>)}</ul>
        {error && <p className="dialog-error process-error" role="alert">{errorText(error)}</p>}
      </div>
      <footer className="dialog-footer">
        <Button type="button" data-initial-focus disabled={working} onClick={onClose}>{t("Cancel")}</Button>
        <Button type="button" className="negative" disabled={working} onClick={() => { void end(); }}>
          {items.length === 1 ? t("End process") : t("End {0}", countText(items.length, "process"))}
        </Button>
      </footer>
    </Dialog>
  );
}

const processColumns = [
  { key: "name", label: "Process" }, { key: "pid", label: "PID" },
  { key: "cpu", label: "CPU" }, { key: "memory", label: "Memory" },
] as const;
type ProcessColumn = (typeof processColumns)[number]["key"];

export function ProcessBrowser({ side }: { side: Side }) {
  const [items, setItems] = useState<ProcessInfo[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [ending, setEnding] = useState<ProcessInfo[]>([]);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ column: ProcessColumn; asc: boolean }>({ column: "name", asc: true });
  const [focused, setFocused] = useState("");
  const anchor = useRef("");
  const table = useRef<HTMLTableElement>(null);
  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const { column, asc } = sort;
    return items.filter((process) => !query || process.name.toLowerCase().includes(query) || String(process.pid).includes(query))
      .sort((a, b) => {
        const order = column === "name" ? byProcessName.compare(a.name, b.name) : a[column] - b[column];
        return (asc ? order : -order) || a.pid - b.pid;
      });
  }, [filter, items, sort]);
  const processIcons = useMemo(() => new Map(visible.map((item) => [processKey(item), { pid: item.pid, started: item.started }])), [visible]);
  const icons = useWindowsIcons(processIcons, api.processIcons);
  const marked = visible.filter((process) => process.canTerminate && selected.includes(processKey(process)));
  const endRequest = useRef(() => {});
  endRequest.current = () => { if (marked.length) setEnding(marked); };

  useEffect(() => {
    let closed = false;
    let pending = false;
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const processes = await api.listProcesses();
        if (!closed) {
          setItems(processes);
          setError("");
        }
      } catch (failure) {
        if (!closed) setError(describeError(failure));
      } finally {
        pending = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    return () => { closed = true; window.clearInterval(timer); };
  }, [revision]);

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

  return (
    <div className="process-browser">
      <label className="process-search">
        <Search aria-hidden="true" />
        <input type="search" aria-label={t("Find process")} placeholder={t("Find by name or PID")} value={filter} onChange={(event) => {
          setFilter(event.target.value);
          setFocused("");
          setSelected([]);
          anchor.current = "";
        }} />
      </label>
      <div className="process-scroll">
        <table ref={table} id={`${side}-files`} className="process-table file-list" tabIndex={0}
          role="grid" aria-label={t("Running processes")} aria-multiselectable="true"
          aria-activedescendant={focused && visible.some((item) => processKey(item) === focused) ? `${side}-process-${focused}` : undefined}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget || !visible.length) return;
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
          <thead><tr>{processColumns.map(({ key, label }) => (
            <th key={key} scope="col" className={`process-col-${key}`}
              aria-sort={sort.column === key ? sort.asc ? "ascending" : "descending" : undefined}>
              <Button type="button" onClick={() => setSort({ column: key, asc: sort.column === key ? !sort.asc : key === "name" || key === "pid" })}>
                {t(label)}{sort.column === key && (sort.asc ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />)}
              </Button>
            </th>
          ))}</tr></thead>
          <tbody>{visible.map((process, index) => {
            const key = processKey(process);
            const icon = icons.get(key);
            return <tr key={key} id={`${side}-process-${key}`} aria-selected={selected.includes(key)}
              data-current={focused === key} onClick={(event) => {
                changeSelection(index, event.shiftKey, event.ctrlKey || event.metaKey);
                table.current?.focus({ preventScroll: true });
              }}>
              <td className="process-cell-name" title={process.name}><span>
                {icon ? <img className="process-icon" src={`data:image/png;base64,${icon}`} alt="" /> : <Cpu aria-hidden="true" />}
                <span>{process.name || t("Process")}</span>
              </span></td>
              <td>{process.pid}</td><td>{process.cpu.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%</td><td>{formatSize(process.memory)}</td>
            </tr>;
          })}</tbody>
        </table>
        {!visible.length && <p className="pane-empty">{filter ? t("No processes match the search.") : t("Loading processes…")}</p>}
      </div>
      {error && <p role="alert" className="pane-error">{errorText(error)}</p>}
      <div className="pane-footer"><span>{filter ? t("{0} of {1}", visible.length, countText(items.length, "process")) : countText(items.length, "process")}</span>
        <Button type="button" disabled={!marked.length} onClick={() => setEnding(marked)}>{t("End selected")}</Button></div>
      {ending.length > 0 && (
        <EndProcesses items={ending} onClose={() => setEnding([])} onFinished={() => {
          setEnding([]);
          setSelected([]);
          setRevision((previous) => previous + 1);
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
        </div>
        <footer className="dialog-footer">
          <Button type="button" onClick={onClose}>{t("Close")}</Button>
          <Button type="button" disabled={!items?.some((process) => process.canTerminate)}
            onClick={() => setSelected(items?.filter((process) => process.canTerminate).map(processKey) ?? [])}>{t("Select all")}</Button>
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
