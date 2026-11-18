import { useEffect, useRef, useState, type FormEvent } from "react";
import { Channel } from "@tauri-apps/api/core";
import { api, describeError, placePath, type ConflictPolicy, type Entry, type Place, type TransferConflict, type TransferProgress, type TransferSource } from "./api";
import { Dialog } from "./Dialog";
import { childPlace, formatSize } from "./panes";

export interface Transfer {
  kind: "copy" | "move";
  source: Place;
  items: Entry[];
  target: string;
}

type Decision = "overwrite" | "skip" | "cancel";
let nextSession = 0;

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
  const [conflict, setConflict] = useState<TransferConflict | null>(null);
  const [canceling, setCanceling] = useState(false);
  const running = useRef<number | null>(null);
  const cancelled = useRef(false);
  const decision = useRef<((answer: Decision) => void) | null>(null);
  const action = useRef<HTMLButtonElement>(null);
  const conflictCancel = useRef<HTMLButtonElement>(null);
  const moving = transfer.kind === "move";
  const verb = moving ? "Move" : transfer.source.kind === "local" ? "Copy" : "Download";
  const itemCount = transfer.items.length;

  useEffect(() => {
    if (phase === "done") action.current?.focus();
    if (conflict) conflictCancel.current?.focus();
  }, [phase, conflict]);

  function resolve(answer: Decision) {
    decision.current?.(answer);
    decision.current = null;
    setConflict(null);
  }

  function cancel() {
    if (running.current === null) {
      onClose();
      return;
    }
    cancelled.current = true;
    setCanceling(true);
    resolve("cancel");
    void api.cancelTransfer(running.current).catch(() => {});
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (running.current !== null || phase !== "setup") return;
    const id = ++nextSession;
    running.current = id;
    setPhase("working");
    let totalBytes = 0;
    let previousBytes = 0;
    const output = new Channel<TransferProgress>();
    output.onmessage = (event) => {
      if (event.bytes === 0) previousBytes = 0;
      totalBytes += Math.max(0, event.bytes - previousBytes);
      previousBytes = event.bytes;
      setBytes(totalBytes);
      setProgress(event);
    };
    try {
      await api.beginTransfer(id);
      for (const [index, item] of transfer.items.entries()) {
        if (cancelled.current) break;
        setProgress({ file: item.name, bytes: 0, total: null });
        previousBytes = 0;
        const request = {
          source: itemSource(transfer.source, item), destination, moving,
          multiple: itemCount > 1, policy, askReadOnly, approved: null as string | null,
        };
        let result = await api.transfer(id, request, output);
        while (result.kind === "conflict" && !cancelled.current) {
          const current = result;
          const answer = await new Promise<Decision>((resolve) => {
            decision.current = resolve;
            setConflict(current);
          });
          if (answer === "cancel") break;
          if (answer === "skip") { result = { kind: "skipped" }; break; }
          result = await api.transfer(id, { ...request, approved: current.revision }, output);
        }
        if (result.kind === "conflict") break;
        if (result.kind === "completed") setCompleted((count) => count + 1);
        else setSkipped((count) => count + 1);
        setProcessed(index + 1);
      }
    } catch (error) {
      if (!cancelled.current) setError(describeError(error));
    } finally {
      await api.finishTransfer(id).catch(() => {});
      running.current = null;
      output.onmessage = () => {};
      setPhase("done");
      onFinished();
    }
  }

  const status = error ? "Transfer stopped" : cancelled.current ? "Transfer canceled" : "Transfer complete";
  return (
    <Dialog title={phase === "done" ? status : conflict ? "File already exists" : phase === "working" ?
      (moving ? "Moving…" : verb === "Download" ? "Downloading…" : "Copying…") : (moving ? "Rename or move" : verb)}
      onClose={cancel}>
      {phase === "setup" ? (
        <form className="dialog-form" onSubmit={(event) => { void submit(event); }}>
          <div className="dialog-body transfer-body">
            <div className="transfer-source">
              <strong>{itemCount === 1 ? transfer.items[0].name : `${itemCount} selected items`}</strong>
              <span title={placePath(transfer.source)}>{placePath(transfer.source)}</span>
            </div>
            <label className="field">Destination
              <input data-initial-focus type="text" value={destination} required spellCheck={false}
                onFocus={(event) => event.currentTarget.select()} onChange={(event) => setDestination(event.target.value)} />
            </label>
            <label className="setting"><span>Existing files</span>
              <select value={policy} onChange={(event) => setPolicy(event.target.value as ConflictPolicy)}>
                <option value="ask">Ask</option><option value="skip">Skip</option>
                {transfer.source.kind === "local" && <option value="overwrite">Overwrite</option>}
              </select>
            </label>
            {transfer.source.kind === "local" && <label className="transfer-checkbox">
              <input type="checkbox" checked={askReadOnly} onChange={(event) => setAskReadOnly(event.target.checked)} /> Also ask about read-only files
            </label>}
          </div>
          <footer className="dialog-footer">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary" disabled={!destination}>{verb}</button>
          </footer>
        </form>
      ) : (
        <>
          <div className="dialog-body transfer-body">
            {conflict ? (
              <>
                <p><strong>{conflict.path}</strong></p>
                <p>{formatSize(conflict.bytes)}{conflict.readOnly ? " · Read-only" : ""}</p>
                {!conflict.replaceable && <p>Skip this item or choose another destination.</p>}
              </>
            ) : (
              <>
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
              </>
            )}
          </div>
          <footer className="dialog-footer">
            {phase === "done" ? (
              <button ref={action} type="button" className="primary" onClick={onClose}>Done</button>
            ) : (
              <>
                <button ref={conflictCancel} type="button" onClick={cancel} disabled={canceling}>{canceling ? "Canceling…" : "Cancel"}</button>
                {conflict && <button type="button" onClick={() => resolve("skip")}>Skip</button>}
                {conflict?.replaceable && <button type="button" className="negative" onClick={() => resolve("overwrite")}>Overwrite</button>}
              </>
            )}
          </footer>
        </>
      )}
    </Dialog>
  );
}
