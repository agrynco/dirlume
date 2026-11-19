import { errorText, locale, t } from "./i18n";
import { Button } from "./Button";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Channel } from "@tauri-apps/api/core";
import { api, describeError, isLockError, isPermissionError, placePath, windowsClient, type ConflictPolicy, type Entry, type Place, type TransferConflict, type TransferEntryDetails, type TransferEvent, type TransferProgress, type TransferSource } from "./api";
import { Dialog } from "./Dialog";
import { childPlace, formatSize, localPath } from "./panes";
import { useTimestamps } from "./useTimestamps";
import { PathField } from "./PathField";
import { ElevationButton, LockDialog } from "./ProcessTools";

export interface Transfer {
  kind: "copy" | "move";
  source: Place;
  items: { place: Place; entry: Entry }[];
  target: string;
  ftpDestination?: number;
  chooseOperation?: boolean;
}

type Decision = "overwrite" | "skip";
let nextSession = 0;

export const nextTransferId = () => ++nextSession;

export function itemSource(place: Place, item: Entry): TransferSource {
  if (place.kind === "local") return { kind: "local", directory: place.path, name: item.name };
  if (place.kind === "ftp") return { kind: "ftp", connection: place.id, segments: [...place.segments, item.name] };
  if (place.kind === "archive") return { kind: "archive", archive: place.id, segments: [...place.segments, item.name] };
  if (place.kind === "server") {
    return { kind: "server", connection: place.id, segments: [...place.segments, item.name], folder: item.directory };
  }
  const target = childPlace(place, item.name) as typeof place;
  return { kind: "kswitcher", directory: place.directory, peer: place.peer, path: target.path, name: item.name };
}

export function TransferDialog({ transfer, showHidden, onClose, onFinished }: {
  transfer: Transfer;
  showHidden: boolean;
  onClose: () => void;
  onFinished: (success: boolean) => void;
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
  const localTarget = transfer.ftpDestination === undefined;
  const replaceable = transfer.source.kind === "local" || transfer.source.kind === "ftp" || transfer.source.kind === "archive";
  const verb = moving ? "Move" : replaceable ? "Copy" : "Download";
  const itemCount = transfer.items.length;
  const singleFile = itemCount === 1 && !transfer.items[0].entry.directory;
  const separator = localTarget && windowsClient ? "\\" : "/";
  const browsePath = singleFile && (destination === transfer.target || /[\\/]$/.test(destination)) && destination
    ? destination.replace(/[\\/]+$/, "") + separator + transfer.items[0].entry.name
    : destination;

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
    const id = nextTransferId();
    running.current = id;
    setPhase("working");
    setError("");
    setBlocked(undefined);
    let attempted: Transfer["items"][number] | undefined;
    let finished = false;
    let skippedItems = skipped;
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
        const ftpCopy = !localTarget || transfer.source.kind === "ftp";
        const target = ftpCopy && itemCount === 1 && transfer.target && !/[\\/:]/.test(destination)
          ? transfer.target.replace(/[\\/]+$/, "") + separator + destination
          : destination;
        const request = {
          source: itemSource(place, entry), destination: target, ftpDestination: transfer.ftpDestination, moving,
          multiple: itemCount > 1, policy, askReadOnly,
        };
        const result = await api.transfer(id, request, output);
        if (result.kind === "completed") setCompleted((count) => count + 1);
        else setSkipped(++skippedItems);
        setProcessed(index + 1);
      }
      finished = true;
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
      const success = finished && !cancelled.current && skippedItems === 0;
      onFinished(success);
      if (success) onClose();
      else setPhase("done");
    }
  }

  const status = error ? "Transfer stopped" : cancelled.current ? "Transfer canceled" : "Transfer complete";
  return (
    <>
    <Dialog title={phase === "done" ? t(status) : phase === "working" ?
      (moving ? t("Moving…") : verb === "Download" ? t("Downloading…") : t("Copying…")) : (moving ? t("Rename or move") : t(verb))}
      onClose={cancel}>
      {phase === "setup" ? (
        <form className="dialog-form" onSubmit={(event) => { void submit(event); }}>
          <div className="dialog-body transfer-body">
            <div className="transfer-source">
              <strong>{itemCount === 1 ? transfer.items[0].entry.name : t("{0} selected items", itemCount)}</strong>
              <span title={placePath(itemCount === 1 ? transfer.items[0].place : transfer.source)}>
                {placePath(itemCount === 1 ? transfer.items[0].place : transfer.source)}
              </span>
            </div>
            <div className="field">
              <label htmlFor="transfer-destination">{t("Destination")}</label>
              <PathField id="transfer-destination" label={t("Destination")} value={destination} onChange={setDestination}
                required initialFocus selectOnFocus showHidden={showHidden} ftp={transfer.ftpDestination} includeFiles={singleFile}
                browse={singleFile ? "save" : "folder"} browsePath={browsePath} />
            </div>
            <label className="setting"><span>{t("Existing files")}</span>
              <select value={policy} onChange={(event) => setPolicy(event.target.value as ConflictPolicy)}>
                <option value="ask">{t("Ask")}</option><option value="skip">{t("Skip")}</option>
                {replaceable && <option value="overwrite">{t("Overwrite")}</option>}
                {replaceable && localTarget && <>
                  <option value="rename">{t("Rename incoming item")}</option>
                  <option value="newer">{t("Overwrite older files only")}</option>
                </>}
              </select>
            </label>
            {replaceable && localTarget && <label className="transfer-checkbox">
              <input type="checkbox" checked={askReadOnly} onChange={(event) => setAskReadOnly(event.target.checked)} /> {t("Also ask about read-only files")}
            </label>}
            {transfer.chooseOperation && <label className="transfer-checkbox">
              <input type="checkbox" checked={moving} onChange={(event) => setMoving(event.target.checked)} /> {t("Move instead of copying")}
            </label>}
          </div>
          <footer className="dialog-footer">
            <Button type="button" onClick={onClose}>{t("Cancel")}</Button>
            <Button type="submit" className="primary" disabled={!destination}>{t(verb)}</Button>
          </footer>
        </form>
      ) : (
        <>
          <div className="dialog-body transfer-body">
                <div className="transfer-meter">
                  <span title={progress?.file}>{progress?.file ?? t("Preparing…")}</span>
                  <span>{progress?.total == null ? formatSize(progress?.bytes ?? null) : `${formatSize(progress.bytes)} / ${formatSize(progress.total)}`}</span>
                </div>
                <progress aria-label={t("Current file progress")} max={Math.max(progress?.total ?? 1, 1)}
                  value={progress?.total == null ? (phase === "done" ? 0 : undefined) : progress.total === 0 ? 1 : progress.bytes} />
                <div className="transfer-meter">
                  <span>{t("{0} / {1} items", processed, itemCount)}{skipped ? ` · ${t("{0} skipped", skipped)}` : ""}</span>
                  <span>{t("{0} transferred", formatSize(bytes))}</span>
                </div>
                <progress aria-label={t("Overall transfer progress")} max={itemCount} value={processed} />
                {phase === "done" && <p role="status">{t("{0} completed", completed)}{skipped ? `, ${t("{0} skipped", skipped)}` : ""}.</p>}
                {error && <p className="dialog-error" role="alert">{errorText(error)}</p>}
                {localTarget && windowsClient && blocked?.place.kind === "local" && isPermissionError(error) &&
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
                    }}>{t("Find locking processes")}</Button>
                    <Button type="button" onClick={() => setPhase("setup")}>{t("Retry")}</Button>
                  </>
                )}
                <Button ref={action} type="button" className="primary" onClick={onClose}>{t("Done")}</Button>
              </>
            ) : (
              <Button type="button" onClick={cancel} disabled={canceling}>{canceling ? t("Canceling…") : t("Cancel")}</Button>
            )}
          </footer>
        </>
      )}
    </Dialog>
    {conflict && (
      <Dialog key={conflict.path} title={conflict.directory ? t("Folder already exists") : t("File already exists")} onClose={cancel}>
        <div className="dialog-body transfer-body">
          <p><strong>{conflict.path}</strong>{conflict.readOnly ? ` ${t("(read-only)")}` : ""}</p>
          <table className="conflict-details">
            <tbody>
              {conflict.incoming && <ConflictDetails label={t("Incoming")} details={conflict.incoming} />}
              <ConflictDetails label={t("Existing")} details={conflict.existing} />
            </tbody>
          </table>
          {conflict.directory && conflict.replaceable && <p>{t("Merge the folders and handle conflicting files individually.")}</p>}
          {!conflict.replaceable && <p>{t("Skip this item or choose another destination.")}</p>}
          {conflict.allowRemember && <label className="transfer-checkbox">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /> {t("Remember choice")}
          </label>}
        </div>
        <footer className="dialog-footer">
          {conflict.replaceable && (
            <Button type="button" className={conflict.directory ? "primary" : "negative"} disabled={answering === conflict}
              onClick={() => { void resolve("overwrite"); }}>{t("Overwrite")}</Button>
          )}
          <Button type="button" data-initial-focus disabled={answering === conflict} onClick={() => { void resolve("skip"); }}>{t("Skip")}</Button>
          <Button type="button" onClick={cancel}>{t("Cancel")}</Button>
        </footer>
      </Dialog>
    )}
    {lockPaths && <LockDialog paths={lockPaths} onClose={() => setLockPaths(null)} />}
    </>
  );
}

function ConflictDetails({ label, details }: { label: string; details: TransferEntryDetails }) {
  const dateLabel = useTimestamps([details.modified]);
  return <tr><th scope="row">{label}</th>
    <td>{details.directory ? t("Folder") : `${details.size.toLocaleString(locale())} B`}</td>
    <td>{dateLabel(details.modified) ?? "–"}</td>
  </tr>;
}
