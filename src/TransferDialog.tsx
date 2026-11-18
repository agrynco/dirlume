import { Button } from "./Button";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Channel } from "@tauri-apps/api/core";
import { api, describeError, isLockError, isPermissionError, placePath, windowsClient, type ConflictPolicy, type Entry, type Place, type TransferConflict, type TransferEntryDetails, type TransferEvent, type TransferProgress, type TransferSource } from "./api";
import { Dialog } from "./Dialog";
import { childPlace, formatDate, formatSize, localPath } from "./panes";
import { ElevationButton, LockDialog } from "./ProcessTools";

export interface Transfer {
  kind: "copy" | "move";
  source: Place;
  items: { place: Place; entry: Entry }[];
  target: string;
  chooseOperation?: boolean;
}

type Decision = "overwrite" | "skip";
let nextSession = 0;
const integer = new Intl.NumberFormat();

function itemSource(place: Place, item: Entry): TransferSource {
  if (place.kind === "local") return { kind: "local", directory: place.path, name: item.name };
  if (place.kind === "server") {
    return { kind: "server", connection: place.id, segments: [...place.segments, item.name], folder: item.directory };
  }
  const target = childPlace(place, item.name) as typeof place;
  return { kind: "kswitcher", directory: place.directory, peer: place.peer, path: target.path, name: item.name };
}

export function TransferDialog({ transfer, onClose, onFinished }: {
  transfer: Transfer;
  onClose: () => void;
  onFinished: () => void;
}) {
  const [destination, setDestination] = useState(transfer.target);
  const [policy, setPolicy] = useState<ConflictPolicy>("ask");
  const [askReadOnly, setAskReadOnly] = useState(true);
  const [phase, setPhase] = useState<"setup" | "working" | "done">("setup");
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [bytes, setBytes] = useState(0);
  const [processed, setProcessed] = useState(0);
  const [completed, setCompleted] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState<Transfer["items"][number]>();
  const [lockPaths, setLockPaths] = useState<string[] | null>(null);
  const [conflict, setConflict] = useState<TransferConflict | null>(null);
  const [remember, setRemember] = useState(false);
  const [answering, setAnswering] = useState<TransferConflict | null>(null);
  const [canceling, setCanceling] = useState(false);
  const running = useRef<number | null>(null);
  const cancelled = useRef(false);
  const action = useRef<HTMLButtonElement>(null);
  const [moving, setMoving] = useState(transfer.kind === "move");
  const verb = moving ? "Move" : transfer.source.kind === "local" ? "Copy" : "Download";
  const itemCount = transfer.items.length;

  useEffect(() => {
    if (phase === "done") action.current?.focus();
  }, [phase]);

  useEffect(() => () => {
    if (running.current !== null) void api.cancelTransfer(running.current).catch(() => {});
  }, []);

  async function resolve(answer: Decision) {
    const id = running.current;
    if (id === null || !conflict || answering === conflict) return;
    setAnswering(conflict);
    try {
      await api.resolveTransfer(id, answer, remember);
      setConflict((current) => current === conflict ? null : current);
    } catch (failure) {
      setError(describeError(failure));
      await api.cancelTransfer(id).catch(() => {});
    } finally {
      setAnswering((current) => current === conflict ? null : current);
    }
  }

  function cancel() {
    if (running.current === null) {
      onClose();
      return;
    }
    cancelled.current = true;
    setCanceling(true);
    setConflict(null);
    void api.cancelTransfer(running.current).catch(() => {});
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (running.current !== null || phase !== "setup") return;
    const id = ++nextSession;
    running.current = id;
    setPhase("working");
    setError("");
    setBlocked(undefined);
    let attempted: Transfer["items"][number] | undefined;
    let totalBytes = bytes;
    let previousBytes = 0;
    const output = new Channel<TransferEvent>();
    output.onmessage = (event) => {
      if (event.kind === "conflict") {
        if (!cancelled.current) { setRemember(false); setConflict(event.conflict); }
        return;
      }
      if (event.bytes === 0) previousBytes = 0;
      totalBytes += Math.max(0, event.bytes - previousBytes);
      previousBytes = event.bytes;
      setBytes(totalBytes);
      setProgress(event);
    };
    try {
      await api.beginTransfer(id);
      for (const [index, item] of transfer.items.entries()) {
        if (index < processed) continue;
        if (cancelled.current) break;
        attempted = item;
        const { place, entry } = item;
        setProgress({ file: entry.name, bytes: 0, total: null });
        previousBytes = 0;
        const request = {
          source: itemSource(place, entry), destination, moving,
          multiple: itemCount > 1, policy, askReadOnly,
        };
        const result = await api.transfer(id, request, output);
        if (result.kind === "completed") setCompleted((count) => count + 1);
        else setSkipped((count) => count + 1);
        setProcessed(index + 1);
      }
    } catch (error) {
      if (!cancelled.current) {
        setError(describeError(error));
        setBlocked(attempted);
      }
    } finally {
      await api.finishTransfer(id).catch(() => {});
      running.current = null;
      output.onmessage = () => {};
      setConflict(null);
      setPhase("done");
      onFinished();
    }
  }

  const status = error ? "Transfer stopped" : cancelled.current ? "Transfer canceled" : "Transfer complete";
  return (
    <>
    <Dialog title={phase === "done" ? status : phase === "working" ?
      (moving ? "Moving…" : verb === "Download" ? "Downloading…" : "Copying…") : (moving ? "Rename or move" : verb)}
      onClose={cancel}>
      {phase === "setup" ? (
        <form className="dialog-form" onSubmit={(event) => { void submit(event); }}>
          <div className="dialog-body transfer-body">
            <div className="transfer-source">
              <strong>{itemCount === 1 ? transfer.items[0].entry.name : `${itemCount} selected items`}</strong>
              <span title={placePath(itemCount === 1 ? transfer.items[0].place : transfer.source)}>
                {placePath(itemCount === 1 ? transfer.items[0].place : transfer.source)}
              </span>
            </div>
            <label className="field">Destination
              <input data-initial-focus type="text" value={destination} required spellCheck={false}
                onFocus={(event) => event.currentTarget.select()} onChange={(event) => setDestination(event.target.value)} />
            </label>
            <label className="setting"><span>Existing files</span>
              <select value={policy} onChange={(event) => setPolicy(event.target.value as ConflictPolicy)}>
                <option value="ask">Ask</option><option value="skip">Skip</option>
                {transfer.source.kind === "local" && <>
                  <option value="overwrite">Overwrite</option>
                  <option value="rename">Rename incoming item</option>
                  <option value="newer">Overwrite older files only</option>
                </>}
              </select>
            </label>
            {transfer.source.kind === "local" && <label className="transfer-checkbox">
              <input type="checkbox" checked={askReadOnly} onChange={(event) => setAskReadOnly(event.target.checked)} /> Also ask about read-only files
            </label>}
            {transfer.chooseOperation && <label className="transfer-checkbox">
              <input type="checkbox" checked={moving} onChange={(event) => setMoving(event.target.checked)} /> Move instead of copying
            </label>}
          </div>
          <footer className="dialog-footer">
            <Button type="button" onClick={onClose}>Cancel</Button>
            <Button type="submit" className="primary" disabled={!destination}>{verb}</Button>
          </footer>
        </form>
      ) : (
        <>
          <div className="dialog-body transfer-body">
                <div className="transfer-meter">
                  <span title={progress?.file}>{progress?.file ?? "Preparing…"}</span>
                  <span>{progress?.total == null ? formatSize(progress?.bytes ?? null) : `${formatSize(progress.bytes)} / ${formatSize(progress.total)}`}</span>
                </div>
                <progress aria-label="Current file progress" max={Math.max(progress?.total ?? 1, 1)}
                  value={progress?.total == null ? (phase === "done" ? 0 : undefined) : progress.total === 0 ? 1 : progress.bytes} />
                <div className="transfer-meter">
                  <span>{processed} / {itemCount} items{skipped ? ` · ${skipped} skipped` : ""}</span>
                  <span>{formatSize(bytes)} transferred</span>
                </div>
                <progress aria-label="Overall transfer progress" max={itemCount} value={processed} />
                {phase === "done" && <p role="status">{completed} completed{skipped ? `, ${skipped} skipped` : ""}.</p>}
                {error && <p className="dialog-error" role="alert">{error}</p>}
                {windowsClient && blocked?.place.kind === "local" && isPermissionError(error) &&
                  <ElevationButton directory={blocked.place.path} />}
          </div>
          <footer className="dialog-footer">
            {phase === "done" ? (
              <>
                {windowsClient && blocked?.place.kind === "local" && moving && isLockError(error) && (
                  <>
                    <Button type="button" onClick={() => {
                      if (!blocked || blocked.place.kind !== "local") return;
                      const paths = [placePath(childPlace(blocked.place, blocked.entry.name))];
                      if (/^(?:[a-z]:[\\/]|\\\\)/i.test(destination)) {
                        paths.push(placePath(childPlace(localPath(destination), blocked.entry.name)));
                      }
                      setLockPaths(paths);
                    }}>Find locking processes</Button>
                    <Button type="button" onClick={() => setPhase("setup")}>Retry</Button>
                  </>
                )}
                <Button ref={action} type="button" className="primary" onClick={onClose}>Done</Button>
              </>
            ) : (
              <Button type="button" onClick={cancel} disabled={canceling}>{canceling ? "Canceling…" : "Cancel"}</Button>
            )}
          </footer>
        </>
      )}
    </Dialog>
    {conflict && (
      <Dialog key={conflict.path} title={conflict.directory ? "Folder already exists" : "File already exists"} onClose={cancel}>
        <div className="dialog-body transfer-body">
          <p><strong>{conflict.path}</strong>{conflict.readOnly ? " (read-only)" : ""}</p>
          <table className="conflict-details">
            <tbody>
              {conflict.incoming && <ConflictDetails label="Incoming" details={conflict.incoming} />}
              <ConflictDetails label="Existing" details={conflict.existing} />
            </tbody>
          </table>
          {conflict.directory && conflict.replaceable && <p>Merge the folders and handle conflicting files individually.</p>}
          {!conflict.replaceable && <p>Skip this item or choose another destination.</p>}
          {conflict.allowRemember && <label className="transfer-checkbox">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /> Remember choice
          </label>}
        </div>
        <footer className="dialog-footer">
          {conflict.replaceable && (
            <Button type="button" className={conflict.directory ? "primary" : "negative"} disabled={answering === conflict}
              onClick={() => { void resolve("overwrite"); }}>{conflict.directory ? "Merge" : "Overwrite"}</Button>
          )}
          <Button type="button" data-initial-focus disabled={answering === conflict} onClick={() => { void resolve("skip"); }}>Skip</Button>
          <Button type="button" onClick={cancel}>Cancel</Button>
        </footer>
      </Dialog>
    )}
    {lockPaths && <LockDialog paths={lockPaths} onClose={() => setLockPaths(null)} />}
    </>
  );
}

function ConflictDetails({ label, details }: { label: string; details: TransferEntryDetails }) {
  return <tr><th scope="row">{label}</th>
    <td>{details.directory ? "Folder" : `${integer.format(details.size)} B`}</td>
    <td>{formatDate(details.modified)}</td>
  </tr>;
}
