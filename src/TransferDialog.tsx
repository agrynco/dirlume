import { errorText, locale, t } from "./i18n";
import { Button } from "./Button";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Channel } from "@tauri-apps/api/core";
import { api, describeError, isFileServer, isLockError, isPermissionError, placePath, windowsClient, type ArchivePlace, type ConflictPolicy, type CopyOptions, type Entry, type FilePlace, type FileServer, type TransferConflict, type TransferEntryDetails, type TransferEvent, type TransferProgress, type TransferSource } from "./api";
import { Dialog } from "./Dialog";
import { DialogIconButton } from "./DialogActions";
import { childPlace, formatSize, localPath, type Side } from "./panes";
import { useTimestamps } from "./useTimestamps";
import { PathField } from "./PathField";
import { HistoryField } from "./HistoryField";
import { ElevationButton, LockDialog } from "./ProcessTools";

export interface Transfer {
  kind: "copy" | "move";
  source: FilePlace;
  items: { place: FilePlace; entry: Entry }[];
  target: string;
  remoteDestination?: FileServer;
  archiveDestination?: ArchivePlace;
  chooseOperation?: boolean;
}

type Decision = "overwrite" | "skip";
let nextSession = 0;

export const nextTransferId = () => ++nextSession;

export function itemSource(place: FilePlace, item: Entry): TransferSource {
  if (place.kind === "local") return { kind: "local", directory: place.path, name: item.name };
  if (isFileServer(place)) return { kind: place.kind, connection: place.id, segments: [...place.segments, item.name] };
  if (place.kind === "archive") return { kind: "archive", archive: place.id, segments: [...place.segments, item.name] };
  if (place.kind === "server") {
    return { kind: "server", connection: place.id, segments: [...place.segments, item.name], folder: item.directory };
  }
  const target = childPlace(place, item.name) as typeof place;
  return { kind: "kswitcher", directory: place.directory, peer: place.peer, path: target.path, name: item.name };
}

export function TransferDialog({ transfer, side, showHidden, onClose, onFinished }: {
  transfer: Transfer;
  side: Side;
  showHidden: boolean;
  onClose: () => void;
  onFinished: (success: boolean) => void;
}) {
  const [destination, setDestination] = useState(transfer.target);
  const [multipleDestinations, setMultipleDestinations] = useState(false);
  const [additional, setAdditional] = useState([""]);
  const [access, setAccess] = useState<CopyOptions["access"]>("default");
  const [preserveTimestamps, setPreserveTimestamps] = useState(false);
  const [followLinks, setFollowLinks] = useState(false);
  const [useFilter, setUseFilter] = useState(false);
  const [mask, setMask] = useState("*");
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
  const session = useRef<number | null>(null);
  const cancelled = useRef(false);
  const failedDecision = useRef(false);
  const reportedBytes = useRef(new Map<string, number>());
  const action = useRef<HTMLButtonElement>(null);
  const [moving, setMoving] = useState(transfer.kind === "move");
  const archiveTarget = transfer.archiveDestination;
  const localTarget = !transfer.remoteDestination && !archiveTarget;
  const replaceable = transfer.source.kind === "local" || isFileServer(transfer.source) || transfer.source.kind === "archive";
  const verb = moving ? "Move" : replaceable ? "Copy" : "Download";
  const itemCount = transfer.items.length;
  const manyDestinations = multipleDestinations && !moving;
  const targets = manyDestinations ? [...new Set([destination, ...additional])] : [destination];
  const copies = targets.length * itemCount;
  const localCopy = !moving && localTarget && transfer.items.every(({ place }) => place.kind === "local");
  const singleFile = !manyDestinations && itemCount === 1 && !transfer.items[0].entry.directory;
  const [promptStart, promptEnd] = t(moving ? "Move {0} to:" : verb === "Download" ? "Download {0} to:" : "Copy {0} to:").split("{0}");
  const separator = localTarget && windowsClient ? "\\" : "/";
  const browsePath = singleFile && (destination === transfer.target || /[\\/]$/.test(destination)) && destination
    ? destination.replace(/[\\/]+$/, "") + separator + transfer.items[0].entry.name
    : destination;
  const lockingMove = phase === "done" && windowsClient && blocked?.place.kind === "local" && moving && isLockError(error);

  useEffect(() => {
    if (phase === "done") action.current?.focus();
  }, [phase]);

  useEffect(() => () => {
    const id = session.current;
    session.current = null;
    if (id !== null) void api.finishTransfer(id).catch(() => {});
  }, []);

  async function resolve(answer: Decision) {
    const id = running.current;
    if (id === null || !conflict || answering === conflict) return;
    setAnswering(conflict);
    try {
      await api.resolveTransfer(id, answer, remember);
      setConflict((current) => current === conflict ? null : current);
    } catch (failure) {
      failedDecision.current = true;
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

  function transferEvents(id: number) {
    return new Channel<TransferEvent>((event) => {
      if (session.current !== id || cancelled.current) return;
      if (event.kind === "conflict") {
        setRemember(false);
        setConflict(event.conflict);
        return;
      }
      const path = event.path ?? event.file;
      const previous = reportedBytes.current.get(path) ?? 0;
      if (event.bytes > previous) {
        reportedBytes.current.set(path, event.bytes);
        setBytes((total) => total + event.bytes - previous);
      }
      setProgress(event);
    });
  }

  async function run(retry: boolean) {
    if (running.current !== null) return;
    const previousSession = session.current;
    const id = previousSession ?? nextTransferId();
    session.current = id;
    running.current = id;
    failedDecision.current = false;
    setPhase("working");
    setError("");
    setBlocked(undefined);
    let attempted: Transfer["items"][number] | undefined;
    let finished = false;
    let initialized = previousSession !== null;
    let skippedItems = skipped;
    try {
      if (!initialized) {
        await api.beginTransfer(id);
        initialized = true;
      }
      if (archiveTarget && !cancelled.current) {
        const sources = transfer.items.map(({ place, entry }) => {
          if (place.kind !== "local") throw new Error(t("Choose local files or folders to copy into the archive."));
          return { directory: place.path, name: entry.name };
        });
        const output = transferEvents(id);
        const result = await api.copyIntoArchive(id, archiveTarget, sources, policy, output)
          .finally(() => { output.onmessage = () => {}; });
        const written = result.filter(Boolean).length;
        skippedItems = result.length - written;
        setCompleted(written);
        setSkipped(skippedItems);
        setProcessed(result.length);
        reportedBytes.current.clear();
      }
      const jobs = archiveTarget ? [] : targets.flatMap((destination) => transfer.items.map((item) => ({ destination, item })));
      for (let index = processed; index < jobs.length; index++) {
        if (cancelled.current || session.current !== id) break;
        const { destination, item } = jobs[index];
        attempted = item;
        const { place, entry } = item;
        setProgress({ file: entry.name, bytes: 0, total: null });
        const remoteCopy = !localTarget || isFileServer(transfer.source);
        const target = remoteCopy && !manyDestinations && itemCount === 1 && transfer.target && !/[\\/:]/.test(destination)
          ? transfer.target.replace(/[\\/]+$/, "") + separator + destination
          : destination;
        const request = {
          source: itemSource(place, entry), destination: target, moving,
          ftpDestination: transfer.remoteDestination?.kind === "ftp" ? transfer.remoteDestination.id : undefined,
          sshDestination: transfer.remoteDestination?.kind === "ssh" ? transfer.remoteDestination.id : undefined,
          multiple: itemCount > 1 || manyDestinations, policy, askReadOnly, retry: retry && index === processed,
          copyOptions: localCopy ? { access, preserveTimestamps, followLinks, mask: useFilter ? mask.trim() : undefined } : undefined,
        };
        const output = transferEvents(id);
        const result = await api.transfer(id, request, output).finally(() => { output.onmessage = () => {}; });
        if (result.kind === "completed") setCompleted((count) => count + 1);
        else setSkipped(++skippedItems);
        reportedBytes.current.clear();
        setProcessed(index + 1);
      }
      finished = true;
    } catch (error) {
      if (!cancelled.current) {
        setError(describeError(error));
        setBlocked(attempted);
      }
    } finally {
      if (session.current !== id) {
        await api.finishTransfer(id).catch(() => {});
        return;
      }
      if (finished || cancelled.current || failedDecision.current || !initialized) {
        session.current = null;
        await api.finishTransfer(id).catch(() => {});
      }
      running.current = null;
      setConflict(null);
      const success = finished && !cancelled.current && skippedItems === 0;
      onFinished(success);
      if (success) onClose();
      else setPhase("done");
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (phase === "setup") void run(false);
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
            <div className="field">
              <label htmlFor="transfer-destination" data-tooltip={placePath(itemCount === 1 ? transfer.items[0].place : transfer.source)}>
                {promptStart}<strong>{itemCount === 1 ? transfer.items[0].entry.name : t("{0} selected items", itemCount)}</strong>{promptEnd}
              </label>
              {archiveTarget ? <input id="transfer-destination" type="text" readOnly data-initial-focus value={destination} /> :
              <PathField id="transfer-destination" label={t("Destination")} value={destination} onChange={setDestination}
                required initialFocus selectOnFocus showHidden={showHidden} server={transfer.remoteDestination} includeFiles={singleFile}
                browse={singleFile ? "save" : "folder"} browsePath={browsePath} />}
            </div>
            {manyDestinations && <>
              {additional.map((path, index) => <PathField key={index} id={`transfer-destination-${index + 2}`}
                label={t("Destination {0}", index + 2)} historyKey="transfer-destination" value={path} required
                onChange={(value) => setAdditional((current) => current.map((old, offset) => offset === index ? value : old))}
                showHidden={showHidden} server={transfer.remoteDestination} browse="folder" />)}
              <div className="dialog-action-group">
                <DialogIconButton label={t("Add destination")} onClick={() => setAdditional([...additional, ""])}><Plus /></DialogIconButton>
                <DialogIconButton label={t("Remove last destination")} onClick={() => {
                  if (additional.length === 1) setMultipleDestinations(false);
                  else setAdditional(additional.slice(0, -1));
                }}><Trash2 /></DialogIconButton>
              </div>
            </>}
            {localCopy && <label className="setting"><span>{t("Access rights")}</span>
              <select value={access} onChange={(event) => setAccess(event.target.value as CopyOptions["access"])}>
                <option value="default">{t("Default")}</option>
                <option value="copy">{t("Copy from source")}</option>
                <option value="inherit">{t("Inherit from destination")}</option>
              </select>
            </label>}
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
            {replaceable && localTarget && <label className="field-checkbox">
              <span>{t("Also ask about read-only files")}</span>
              <input type="checkbox" checked={askReadOnly} onChange={(event) => setAskReadOnly(event.target.checked)} />
            </label>}
            {localCopy && <>
              <label className="field-checkbox"><span>{t("Preserve all timestamps")}</span>
                <input type="checkbox" checked={preserveTimestamps} onChange={(event) => setPreserveTimestamps(event.target.checked)} />
              </label>
              <label className="field-checkbox"><span>{t("Copy contents of symbolic links")}</span>
                <input type="checkbox" checked={followLinks} onChange={(event) => setFollowLinks(event.target.checked)} />
              </label>
            </>}
            {!moving && !archiveTarget && <label className="field-checkbox"><span>{t("Process multiple destinations")}</span>
              <input type="checkbox" checked={manyDestinations} onChange={(event) => setMultipleDestinations(event.target.checked)} />
            </label>}
            {localCopy && <>
              <label className="field-checkbox"><span>{t("Use filter")}</span>
                <input type="checkbox" checked={useFilter} onChange={(event) => setUseFilter(event.target.checked)} />
              </label>
              {useFilter && <label className="field">{t("File mask")}
                <HistoryField historyKey="copy-mask" type="text" value={mask} onValueChange={setMask} required placeholder="*.txt" />
              </label>}
            </>}
            {transfer.chooseOperation && <label className="field-checkbox">
              <span>{t("Move instead of copying")}</span>
              <input type="checkbox" checked={moving} onChange={(event) => setMoving(event.target.checked)} />
            </label>}
          </div>
          <footer className="dialog-footer">
            <Button type="button" onClick={onClose}>{t("Cancel")}</Button>
            <Button type="submit" className="primary" disabled={targets.some((path) => !path.trim()) || (localCopy && useFilter && !mask.trim())}>{t(verb)}</Button>
          </footer>
        </form>
      ) : (
        <>
          <div className="dialog-body transfer-body">
                <div className="transfer-meter">
                  <span data-tooltip={progress?.file}>{progress?.file ?? t("Preparing…")}</span>
                  <span>{progress?.total == null ? formatSize(progress?.bytes ?? null) : `${formatSize(progress.bytes)} / ${formatSize(progress.total)}`}</span>
                </div>
                <progress aria-label={t("Current file progress")} max={Math.max(progress?.total ?? 1, 1)}
                  value={progress?.total == null ? (phase === "done" ? 0 : undefined) : progress.total === 0 ? 1 : progress.bytes} />
                <div className="transfer-meter">
                  <span>{t("{0} / {1} items", processed, copies)}{skipped ? ` · ${t("{0} skipped", skipped)}` : ""}</span>
                  <span>{t("{0} transferred", formatSize(bytes))}</span>
                </div>
                <progress aria-label={t("Overall transfer progress")} max={copies} value={processed} />
                {phase === "done" && <p role="status">{t("{0} completed", completed)}{skipped ? `, ${t("{0} skipped", skipped)}` : ""}.</p>}
                {error && <p className="dialog-error" role="alert">{errorText(error)}</p>}
                {lockingMove && <div className="dialog-actions">
                  <Button type="button" onClick={() => {
                    const paths = [placePath(childPlace(blocked.place, blocked.entry.name))];
                    if (/^(?:[a-z]:[\\/]|\\\\)/i.test(destination)) {
                      paths.push(placePath(childPlace(localPath(destination), blocked.entry.name)));
                    }
                    setLockPaths(paths);
                  }}>{t("Find locking processes")}</Button>
                </div>}
                {localTarget && windowsClient && blocked?.place.kind === "local" && isPermissionError(error) &&
                  <ElevationButton directory={blocked.place.path} side={side} selected={blocked.entry.name} />}
          </div>
          <footer className="dialog-footer">
            {phase === "done" && error ? (
              <>
                <Button type="button" onClick={cancel}>{t("Cancel")}</Button>
                <Button ref={action} type="button" className="primary" onClick={() => void run(true)}>{t("Retry")}</Button>
              </>
            ) : phase === "done" ? (
              <Button ref={action} type="button" className="primary" onClick={onClose}>{t("Done")}</Button>
            ) : (
              <Button type="button" onClick={cancel} disabled={canceling}>{canceling ? t("Canceling…") : t("Cancel")}</Button>
            )}
          </footer>
        </>
      )}
    </Dialog>
    {conflict && (
      <Dialog key={conflict.path} title={conflict.directory ? t("Folder already exists") : t("File already exists")} tone="warning" onClose={cancel}>
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
          {conflict.allowRemember && <label className="field-checkbox">
            <span>{t("Remember choice")}</span>
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          </label>}
        </div>
        <footer className="dialog-footer">
          {conflict.replaceable && (
            <Button type="button" className="alert-confirm" disabled={answering === conflict}
              onClick={() => { void resolve("overwrite"); }}>{t(conflict.directory ? "Merge" : "Overwrite")}</Button>
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
