import { errorText, locale, t } from "./i18n";
import { Button } from "./Button";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Channel } from "@tauri-apps/api/core";
import { api, describeError, isFileServer, isWritableServerPlace, isLockError, isPermissionError, placePath, windowsClient, type ArchivePlace, type ConflictPolicy, type CopyOptions, type Entry, type FilePlace, type FtpPlace, type KSwitcherPlace, type WritableServerPlace, type SshPlace, type TransferConflict, type TransferEntryDetails, type TransferEvent, type TransferProgress, type TransferSource } from "./api";
import { Dialog } from "./Dialog";
import { DialogIconButton } from "./DialogActions";
import { childPlace, formatSize, localPath, type Side } from "./panes";
import { useTimestamps } from "./useTimestamps";
import { PathField } from "./PathField";
import { HistoryField } from "./HistoryField";
import { ElevationButton, LockDialog } from "./ProcessTools";
import { SudoDialog } from "./SudoDialog";
import { estimateDelay, estimateInterval, TransferEstimate } from "./transferEstimate";

export interface Transfer {
  kind: "copy" | "move";
  source: FilePlace;
  items: { place: FilePlace; entry: Entry; searchPath?: string; collectionDestination?: string[] }[];
  target: string;
  remoteDestination?: FtpPlace | SshPlace;
  serverDestination?: WritableServerPlace;
  kswitcherDestination?: KSwitcherPlace;
  kswitcherBroker?: boolean;
  archiveDestination?: ArchivePlace;
  chooseOperation?: boolean;
  collection?: { folders: string[][]; unavailable: string[]; needsLocalDestination: boolean };
}

type Decision = "overwrite" | "overwrite_all" | "skip";
let nextSession = 0;

export const nextTransferId = () => ++nextSession;

export function TransferSudoPrompt({ id, request, operation, onClose }: {
  id: number;
  request: Extract<TransferEvent, { kind: "sudo_required" }>;
  operation: "transfer" | "delete";
  onClose: () => void;
}) {
  return <SudoDialog address={request.address} path={request.path} operation={operation}
    onConfirm={(password) => api.authorizeTransferSudo(id, request.ticket, password)}
    onClose={() => {
      onClose();
      void api.declineTransferSudo(id, request.ticket).catch(() => {});
    }} />;
}

function remoteDestinationLabel(place: FtpPlace | SshPlace) {
  const protocol = place.kind === "ssh" ? "SFTP" : "FTP";
  const endpoint = new URL(place.origin);
  const alias = place.address.trim();
  const address = alias && endpoint.port && alias !== endpoint.hostname && alias !== endpoint.host
    ? `${alias} (${endpoint.host})` : endpoint.port ? endpoint.host : alias || endpoint.host;
  return `${protocol} · ${address}`;
}

function estimateLabel(seconds: number | null) {
  if (seconds === null) return t("Estimating time remaining…");
  const unit = seconds >= 3_600 ? "hour" : seconds >= 60 ? "minute" : "second";
  const value = unit === "hour" ? Math.ceil(seconds / 360) / 10 : unit === "minute" ? Math.ceil(seconds / 60) : seconds;
  const duration = new Intl.NumberFormat(locale(), { style: "unit", unit, unitDisplay: "long" }).format(value);
  return t("About {0} remaining", duration);
}

export function itemSource(place: FilePlace, item: Entry): TransferSource {
  if (place.kind === "local") return { kind: "local", directory: place.path, name: item.name };
  if (isFileServer(place)) return { kind: place.kind, connection: place.id, segments: [...place.segments, item.name] };
  if (place.kind === "archive") return { kind: "archive", archive: place.id, segments: [...place.segments, item.name] };
  const metadata = item.modified === null ? {} : { modified: item.modified };
  if (place.kind === "server") {
    return { kind: "server", connection: place.id, segments: [...place.segments, item.name], folder: item.directory, ...metadata,
      ...(isWritableServerPlace(place) ? { writable_server: true } : {}) };
  }
  const target = childPlace(place, item.name) as typeof place;
  return { kind: "kswitcher", directory: place.directory, peer: place.peer, path: target.path, name: item.name,
    folder: item.directory, ...metadata };
}

export function TransferDialog({ transfer, side, showHidden, onClose, onFinished }: {
  transfer: Transfer;
  side: Side;
  showHidden: boolean;
  onClose: () => void;
  onFinished: (success: boolean, movedPaths: readonly string[]) => void;
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
  const [sudo, setSudo] = useState<Extract<TransferEvent, { kind: "sudo_required" }> | null>(null);
  const [remember, setRemember] = useState(false);
  const [answering, setAnswering] = useState<TransferConflict | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [estimatedTime, setEstimatedTime] = useState<string>();
  const running = useRef<number | null>(null);
  const session = useRef<number | null>(null);
  const cancelled = useRef(false);
  const failedDecision = useRef(false);
  const reportedBytes = useRef(new Map<string, number>());
  const estimate = useRef<TransferEstimate | null>(null);
  const action = useRef<HTMLButtonElement>(null);
  const [moving, setMoving] = useState(transfer.kind === "move");
  const archiveTarget = transfer.archiveDestination;
  const serverTarget = transfer.serverDestination;
  const remoteMove = moving && (serverTarget || transfer.items.some(({ place }) =>
    isWritableServerPlace(place) || isFileServer(place) || place.kind === "archive"));
  const sameServerMove = moving && serverTarget && isWritableServerPlace(transfer.source) && transfer.source.share === serverTarget.share;
  const sameArchiveMove = moving && archiveTarget && transfer.source.kind === "archive" && transfer.source.path === archiveTarget.path;
  const kswitcherTarget = transfer.kswitcherDestination;
  const prompt = kswitcherTarget?.capabilities?.conflictPrompt ??
    (transfer.source.kind === "kswitcher" ? transfer.source.capabilities?.conflictPrompt : undefined);
  const localTarget = !transfer.remoteDestination && !archiveTarget && !kswitcherTarget && !serverTarget;
  const replaceable = serverTarget || transfer.collection || transfer.source.kind === "local" || isFileServer(transfer.source) || transfer.source.kind === "archive" ||
    transfer.kswitcherBroker || transfer.items.every(({ place }) => place.kind === "server" || place.kind === "kswitcher");
  const verb = moving ? "Move" : replaceable ? "Copy" : "Download";
  const itemCount = transfer.items.length;
  const manyDestinations = multipleDestinations && !moving && !serverTarget;
  const targets = manyDestinations ? [...new Set([destination, ...additional])] : [destination];
  const copies = targets.length * itemCount;
  const localCopy = !moving && localTarget && transfer.items.every(({ place }) => place.kind === "local");
  const singleFile = !transfer.collection && !manyDestinations && itemCount === 1 && !transfer.items[0].entry.directory;
  const [promptStart, promptEnd] = t(moving ? "Move {0} to:" : verb === "Download" ? "Download {0} to:" : "Copy {0} to:").split("{0}");
  const separator = kswitcherTarget || localTarget && windowsClient ? "\\" : "/";
  const browsePath = singleFile && (destination === transfer.target || /[\\/]$/.test(destination)) && destination
    ? destination.replace(/[\\/]+$/, "") + separator + transfer.items[0].entry.name
    : destination;
  const lockingMove = phase === "done" && windowsClient && blocked?.place.kind === "local" && moving && isLockError(error);
  const visibleEstimate = phase === "working" && !conflict ? estimatedTime : undefined;

  useEffect(() => {
    if (phase === "done") action.current?.focus();
  }, [phase]);

  useEffect(() => {
    const current = estimate.current;
    if (phase !== "working" || !current) return;
    current.setPaused(conflict !== null, performance.now());
    if (conflict) {
      setEstimatedTime(undefined);
      return;
    }
    let timer = 0;
    const update = () => {
      if (current !== estimate.current || cancelled.current) return;
      const now = performance.now();
      const elapsed = current.elapsed(now);
      if (elapsed >= estimateDelay) setEstimatedTime(estimateLabel(current.remainingSeconds(now)));
      timer = window.setTimeout(update, elapsed < estimateDelay ? estimateDelay - elapsed : estimateInterval);
    };
    update();
    return () => window.clearTimeout(timer);
  }, [phase, conflict]);

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
    setEstimatedTime(undefined);
    setConflict(null);
    setSudo(null);
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
      if (event.kind === "sudo_required") {
        setSudo(event);
        return;
      }
      estimate.current?.progress(event, performance.now());
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
    const archiveCopy = !moving && transfer.items.every(({ place }) => place.kind === "local") ? archiveTarget : undefined;
    const jobs = archiveCopy ? [] : targets.flatMap((destination) => transfer.items.map((item) => ({ destination, item })));
    estimate.current = new TransferEstimate(archiveCopy ? [null] : jobs.slice(processed).map(({ item }) => item.entry), performance.now());
    setEstimatedTime(undefined);
    setPhase("working");
    setError("");
    setBlocked(undefined);
    let attempted: Transfer["items"][number] | undefined;
    let finished = false;
    let initialized = previousSession !== null;
    let skippedItems = skipped;
    const movedPaths: string[] = [];
    try {
      if (!initialized) {
        await api.beginTransfer(id, {
          moving, source: placePath(transfer.source), destination: targets.join(", "),
          multipleDestinations: manyDestinations && targets.length > 1,
        });
        initialized = true;
      }
      if (transfer.collection?.folders.length && !cancelled.current) {
        for (const target of targets) {
          if (cancelled.current) break;
          await api.prepareCollectionFolders(target, transfer.collection.folders);
        }
      }
      if (archiveCopy && !cancelled.current) {
        const sources = transfer.items.map(({ place, entry }) => {
          if (place.kind !== "local") throw new Error(t("Choose local files or folders to copy into the archive."));
          return { directory: place.path, name: entry.name };
        });
        const output = transferEvents(id);
        const result = await api.copyIntoArchive(id, archiveCopy, sources, policy, output)
          .finally(() => { output.onmessage = () => {}; });
        const written = result.filter(Boolean).length;
        skippedItems = result.length - written;
        setCompleted(written);
        setSkipped(skippedItems);
        setProcessed(result.length);
        reportedBytes.current.clear();
      }
      for (let index = processed; index < jobs.length; index++) {
        if (cancelled.current || session.current !== id) break;
        const { destination, item } = jobs[index];
        attempted = item;
        const { place, entry } = item;
        setProgress({ file: entry.name, bytes: 0, total: null });
        const remoteCopy = !localTarget || isFileServer(transfer.source) || transfer.kswitcherBroker ||
          (place.kind === "server" || place.kind === "kswitcher") && entry.directory;
        const target = item.collectionDestination?.length
          ? [destination.replace(/[\\/]+$/, ""), ...item.collectionDestination].join(separator)
          : remoteCopy && !manyDestinations && itemCount === 1 && transfer.target && !/[\\/:]/.test(destination)
          ? transfer.target.replace(/[\\/]+$/, "") + separator + destination
          : destination;
        const request = {
          source: itemSource(place, entry), destination: target, moving,
          ftpDestination: transfer.remoteDestination?.kind === "ftp" ? transfer.remoteDestination.id : undefined,
          sshDestination: transfer.remoteDestination?.kind === "ssh" ? transfer.remoteDestination.id : undefined,
          serverDestination: serverTarget?.id,
          archiveDestination: archiveTarget ? { id: archiveTarget.id, segments: archiveTarget.segments } : undefined,
          kswitcherDestination: kswitcherTarget?.peer, kswitcherBroker: transfer.kswitcherBroker,
          multiple: !!transfer.collection || itemCount > 1 || manyDestinations, policy, askReadOnly, retry: retry && index === processed,
          copyOptions: localCopy ? { access, preserveTimestamps, followLinks, mask: useFilter ? mask.trim() : undefined } : undefined,
        };
        const output = transferEvents(id);
        const result = await api.transfer(id, request, output).finally(() => { output.onmessage = () => {}; });
        if (result.kind === "source_retained") {
          setError(t(transfer.kswitcherBroker || isWritableServerPlace(item.place) || isFileServer(item.place) || item.place.kind === "archive" ? "Copied to {0}. Could not finish removing source {1}. {2}" :
            "Uploaded to {0}. Could not remove local source {1}. {2}", result.destination, result.source, errorText(result.error)));
          setBlocked(item);
          return;
        }
        if (result.kind === "completed") {
          if (moving && item.searchPath) movedPaths.push(item.searchPath);
          setCompleted((count) => count + 1);
        } else setSkipped(++skippedItems);
        estimate.current?.finishItem();
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
      estimate.current = null;
      setEstimatedTime(undefined);
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
      setSudo(null);
      const success = finished && !cancelled.current && skippedItems === 0;
      onFinished(success, movedPaths);
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
          <div className="dialog-body transfer-body transfer-options">
            <div className="field">
              <label htmlFor="transfer-destination" data-tooltip={placePath(itemCount === 1 ? transfer.items[0].place : transfer.source)}>
                {transfer.collection ? t("Copy from collection") : <>
                  {promptStart}<strong>{itemCount === 1 ? transfer.items[0].entry.name : t("{0} selected items", itemCount)}</strong>{promptEnd}
                </>}
              </label>
              {transfer.remoteDestination && <span className="muted" id="transfer-connection">
                {remoteDestinationLabel(transfer.remoteDestination)}
              </span>}
              {kswitcherTarget && <span className="muted" id="transfer-connection">{kswitcherTarget.address}</span>}
              {serverTarget && <span className="muted" id="transfer-connection">{serverTarget.address}</span>}
              {archiveTarget ? <input id="transfer-destination" type="text" readOnly data-initial-focus value={destination} /> :
              serverTarget ? <input id="transfer-destination" type="text" aria-label={t("Destination")} aria-describedby="transfer-connection"
                required data-initial-focus value={destination} onChange={(event) => setDestination(event.target.value)} /> :
              <PathField id="transfer-destination" label={t("Destination")} value={destination} onChange={setDestination}
                describedBy={transfer.remoteDestination || kswitcherTarget ? "transfer-connection" : undefined}
                required initialFocus selectOnFocus showHidden={showHidden} server={transfer.remoteDestination}
                kswitcher={kswitcherTarget} includeFiles={singleFile}
                browse={singleFile ? "save" : "folder"} browsePath={browsePath} />}
            </div>
            {!!transfer.collection?.unavailable.length && <div role="status">
              <p>{t("These originals are unavailable. Available items can still be copied.")}</p>
              <ul>{transfer.collection.unavailable.map((message, index) => <li key={index}>{message}</li>)}</ul>
            </div>}
            {transfer.collection?.needsLocalDestination &&
              <p role="status">{t("Choose a local destination for this collection selection.")}</p>}
            {manyDestinations && <>
              {additional.map((path, index) => <PathField key={index} id={`transfer-destination-${index + 2}`}
                label={t("Destination {0}", index + 2)} historyKey="transfer-destination" value={path} required
                onChange={(value) => setAdditional((current) => current.map((old, offset) => offset === index ? value : old))}
                showHidden={showHidden} server={transfer.remoteDestination} kswitcher={kswitcherTarget} browse="folder" />)}
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
                <option value="ask">{t(sameServerMove || sameArchiveMove || transfer.kswitcherBroker && !prompt ? "Stop on conflict" : "Ask")}</option>
                <option value="skip">{t("Skip")}</option>
                {replaceable && !sameServerMove && !sameArchiveMove && <option value="overwrite">{t("Overwrite all")}</option>}
                {replaceable && localTarget && !transfer.kswitcherBroker && !remoteMove && <>
                  <option value="rename">{t("Rename incoming item")}</option>
                  <option value="newer">{t("Overwrite older files only")}</option>
                </>}
              </select>
            </label>
            {replaceable && localTarget && !transfer.kswitcherBroker && <label className="field-checkbox">
              <input type="checkbox" checked={askReadOnly} disabled={policy === "overwrite"} onChange={(event) => setAskReadOnly(event.target.checked)} />
              <span>{t("Also ask about read-only files")}</span>
            </label>}
            {localCopy && <>
              <label className="field-checkbox">
                <input type="checkbox" checked={preserveTimestamps} onChange={(event) => setPreserveTimestamps(event.target.checked)} />
                <span>{t("Preserve all timestamps")}</span>
              </label>
              <label className="field-checkbox">
                <input type="checkbox" checked={followLinks} onChange={(event) => setFollowLinks(event.target.checked)} />
                <span>{t("Copy contents of symbolic links")}</span>
              </label>
            </>}
            {!moving && !archiveTarget && !serverTarget && <label className="field-checkbox">
              <input type="checkbox" checked={manyDestinations} onChange={(event) => setMultipleDestinations(event.target.checked)} />
              <span>{t("Process multiple destinations")}</span>
            </label>}
            {localCopy && <>
              <label className="field-checkbox">
                <input type="checkbox" checked={useFilter} onChange={(event) => setUseFilter(event.target.checked)} />
                <span>{t("Use filter")}</span>
              </label>
              {useFilter && <label className="field">{t("File mask")}
                <HistoryField historyKey="copy-mask" type="text" value={mask} onValueChange={setMask} required placeholder="*.txt" />
              </label>}
            </>}
            {transfer.chooseOperation && <label className="field-checkbox">
              <input type="checkbox" checked={moving} onChange={(event) => setMoving(event.target.checked)} />
              <span>{t("Move instead of copying")}</span>
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
                <progress aria-label={t("Overall transfer progress")} aria-describedby={visibleEstimate ? "transfer-estimate" : undefined}
                  max={copies} value={processed} />
                {visibleEstimate && <div className="transfer-estimate" id="transfer-estimate">{visibleEstimate}</div>}
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
    {sudo && running.current !== null && <TransferSudoPrompt key={sudo.ticket} id={running.current} request={sudo}
      operation="transfer" onClose={() => setSudo((current) => current?.ticket === sudo.ticket ? null : current)} />}
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
          {!conflict.replaceable && <p>{t("Skip this item or choose another destination.")}</p>}
          {conflict.allowRemember && <label className="field-checkbox">
            <span>{t(conflict.confirmReadOnly ? "Remember choice for read-only files" : "Remember choice")}</span>
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          </label>}
        </div>
        <footer className="dialog-footer">
          {conflict.replaceable && (
            <Button type="button" className="alert-confirm" disabled={answering === conflict}
              onClick={() => { void resolve("overwrite"); }}>{t("Overwrite")}</Button>
          )}
          {conflict.replaceable && <Button type="button" disabled={answering === conflict}
            onClick={() => { void resolve("overwrite_all"); }}>{t("Overwrite all")}</Button>}
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
