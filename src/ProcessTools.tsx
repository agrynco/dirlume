import { useEffect, useRef, useState } from "react";
import { api, describeError, type ProcessInfo } from "./api";
import { Dialog } from "./Dialog";
import { formatSize, type Side } from "./panes";

export function ElevationButton({ directory }: { directory: string }) {
  const [error, setError] = useState("");
  return (
    <div className="elevation-action">
      <button type="button" onClick={() => {
        setError("");
        void api.openElevated(directory).catch((failure: unknown) => setError(describeError(failure)));
      }}>Open as administrator</button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

const processKey = ({ pid, started }: ProcessInfo) => `${pid}-${started}`;
const byProcessName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function Processes({ items, selected, onChange, showUsage, id, size }: {
  items: ProcessInfo[];
  selected: string[];
  onChange: (selected: string[]) => void;
  showUsage?: boolean;
  id?: string;
  size: number;
}) {
  return (
    <select id={id} aria-label={showUsage ? "Running processes" : "Locking processes"} multiple size={size} value={selected}
      onChange={(event) => onChange(Array.from(event.currentTarget.selectedOptions, ({ value }) => value))}>
      {items.map((process) => (
        <option value={processKey(process)} key={processKey(process)} disabled={!process.canTerminate}>
          {showUsage ? `${String(process.pid).padStart(6)}    ${process.cpu.toFixed(1).padStart(6)}%    ${formatSize(process.memory).padStart(10)}    ${process.name}` :
            `${process.name || "Process"} (PID ${process.pid})`}
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
    <Dialog title="End processes" onClose={() => { if (!working) onClose(); }}>
      <div className="dialog-body end-processes">
        <p className="delete-warning">Ending processes may cause unsaved work to be lost.</p>
        <ul>{items.map(({ pid, name }) => <li key={pid}>{name || "Process"} (PID {pid})</li>)}</ul>
        {error && <p className="dialog-error process-error" role="alert">{error}</p>}
      </div>
      <footer className="dialog-footer">
        <button type="button" data-initial-focus disabled={working} onClick={onClose}>Cancel</button>
        <button type="button" className="negative" disabled={working} onClick={() => { void end(); }}>End {items.length === 1 ? "process" : `${items.length} processes`}</button>
      </footer>
    </Dialog>
  );
}

export function ProcessBrowser({ side }: { side: Side }) {
  const [items, setItems] = useState<ProcessInfo[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [ending, setEnding] = useState<ProcessInfo[]>([]);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const marked = items.filter((process) => process.canTerminate && selected.includes(processKey(process)));
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
          setItems(processes.sort((a, b) => byProcessName.compare(a.name, b.name) || a.pid - b.pid));
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

  return (
    <div className="process-browser">
      <p className="process-columns" aria-hidden="true">   PID       CPU        Memory    Process</p>
      <Processes id={`${side}-files`} items={items} selected={selected} onChange={setSelected} showUsage size={12} />
      {error && <p role="alert" className="pane-error">{error}</p>}
      <div className="pane-footer"><span>{items.length} processes</span>
        <button type="button" disabled={!marked.length} onClick={() => setEnding(marked)}>End selected</button></div>
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
      <Dialog title="Processes using these files" onClose={onClose}>
        <div className="dialog-body end-processes">
          {error ? <p role="alert" className="dialog-error">{error}</p> :
            items === null ? <p role="status">Checking files…</p> :
            !items.length ? <p role="status">Windows found no processes using these files.</p> :
            <Processes items={items} selected={selected} onChange={setSelected} size={8} />}
          {partial && <p>Only some files could be checked.</p>}
        </div>
        <footer className="dialog-footer">
          <button type="button" onClick={onClose}>Close</button>
          <button type="button" disabled={!items?.some((process) => process.canTerminate)}
            onClick={() => setSelected(items?.filter((process) => process.canTerminate).map(processKey) ?? [])}>Select all</button>
          <button type="button" className="negative" disabled={!marked.length} onClick={() => setEnding(true)}>End selected</button>
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
