import { errorText, locale, t } from "./i18n";
import { Button } from "./Button";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Channel } from "@tauri-apps/api/core";
import { api, describeError, isFileServer, isWritableServerPlace, isLockError, isPermissionError, kswitcherPath, placePath, windowsClient, type ArchivePlace, type ConflictPolicy, type CopyOptions, type Entry, type FilePlace, type FtpPlace, type GoogleDrivePlace, type KSwitcherPlace, type WritableServerPlace, type SshPlace, type TransferConflict, type TransferEntryDetails, type TransferEvent, type TransferProgress, type TransferSource } from "./api";
import { Dialog } from "./Dialog";
import { DialogIconButton } from "./DialogActions";
import { childPlace, formatSize, localPath, readPlace, type Side } from "./panes";
import { useTimestamps } from "./useTimestamps";
import { PathField } from "./PathField";
import { HistoryField } from "./HistoryField";
import { ElevationButton, LockDialog } from "./ProcessTools";
import { SudoDialog } from "./SudoDialog";
import { estimateDelay, estimateInterval, TransferEstimate } from "./transferEstimate";
import { isLocalMovePath, movePath, resolveMoveDestination, type MoveDestination } from "./moveDestination";

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
  googleDriveDestination?: GoogleDrivePlace;
  moveTarget?: FilePlace;
  connectedPlaces?: readonly FilePlace[];
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
  if (place.kind === "googleDrive") return { kind: "google_drive", profile: place.id, item: item.name, name: item.googleDrive?.name ?? item.name,
    parent: place.folders.at(-1)?.id ?? "root", folder: item.directory };
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

async function prepareRemoteCollectionFolders(id: number, root: FilePlace, paths: string[][], stopped: () => boolean) {
  const folders = new Map<string, FilePlace>([[JSON.stringify([]), root]]);
  for (const path of paths) {
    if (stopped()) break;
    const name = path.at(-1)!;
    const parent = folders.get(JSON.stringify(path.slice(0, -1)));
    if (!parent) throw new Error(t("Could not open {0}.", path.slice(0, -1).join("/")));
    const listing = (await readPlace(parent)).listing;
    if (stopped()) break;
    const matches = listing.entries.filter((entry) => (entry.googleDrive?.name ?? entry.name) === name);
    if (matches.length > 1 || matches.some((entry) => !entry.directory || entry.link)) {
      throw new Error(t("Choose a unique destination folder. {0}", path.join("/")));
    }
    if (parent.kind === "googleDrive") {
      const item = matches[0]?.name ?? await api.changeGoogleDrive(parent.id, {
        kind: "createFolder", parent: parent.folders.at(-1)?.id ?? "root", name,
      });
      if (!item) throw new Error(t("Could not open {0}.", name));
      folders.set(JSON.stringify(path), { ...parent, folders: [...parent.folders, { id: item, name }] });
      continue;
    }
    if (!matches.length) {
      if (isWritableServerPlace(parent)) await api.changeServerItem(parent, [name], { kind: "folder" });
      else if (isFileServer(parent)) await api.createRemoteFolder(parent, name);
      else if (parent.kind === "archive" && parent.canAdd) {
        const progress = new Channel<number>(() => {});
        try { await api.changeArchive(id, parent.id, { kind: "folder", parent: parent.segments, name }, progress); }
        finally { progress.onmessage = () => {}; }
      } else if (parent.kind === "kswitcher" && parent.capabilities?.write) {
        await api.changeKSwitcher(parent.peer, kswitcherPath(parent.path, name), { kind: "create_folder" });
      } else throw new Error(t("This source is read-only."));
    }
    const folder = childPlace(parent, name);
    if (folder.kind === "smbRoot") throw new Error(t("Could not open {0}.", name));
    folders.set(JSON.stringify(path), folder);
  }
  return folders;
}

export function TransferDialog({ transfer, side, showHidden, onClose, onFinished, onRename }: {
  transfer: Transfer;
  side: Side;
  showHidden: boolean;
  onClose: () => void;
  onFinished: (success: boolean, movedPaths: readonly string[], destination?: MoveDestination) => void;
  onRename?: (name: string) => Promise<void>;
}) {
  const driveTarget = transfer.googleDriveDestination;
  const driveAccount = driveTarget?.email || driveTarget?.address;
  const driveRoot = driveAccount ? `${driveAccount}:/${t("My Drive")}` : undefined;
  const resolveEnteredMove = transfer.kind === "move";
  const defaultDestination = resolveEnteredMove && transfer.moveTarget ? movePath(transfer.moveTarget)
    : driveAccount ? `${driveAccount}:/${transfer.target}` : transfer.target;
  const [destination, setDestination] = useState(defaultDestination);
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
  const [driveNotes, setDriveNotes] = useState<string[]>([]);
  const [checkingDestination, setCheckingDestination] = useState(false);
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
  const resolvedDestination = useRef<{ profile: string; parent: string } | undefined>(undefined);
  const resolvedMove = useRef<MoveDestination | undefined>(undefined);
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
  const localTarget = resolveEnteredMove ? isLocalMovePath(destination)
    : !transfer.remoteDestination && !archiveTarget && !kswitcherTarget && !serverTarget && !driveTarget;
  const replaceable = serverTarget || transfer.collection || transfer.source.kind === "local" || isFileServer(transfer.source) || transfer.source.kind === "archive" || transfer.source.kind === "googleDrive" ||
    transfer.kswitcherBroker || transfer.items.every(({ place }) => place.kind === "server" || place.kind === "kswitcher");
  const verb = moving ? "Move" : replaceable ? "Copy" : "Download";
  const itemCount = transfer.items.length;
  const driveSource = transfer.source.kind === "googleDrive";
  const remoteCollectionRoot = transfer.collection?.folders.length ?
    driveTarget ?? archiveTarget ?? serverTarget ?? kswitcherTarget ?? transfer.remoteDestination : undefined;
  const manyDestinations = multipleDestinations && !moving && !serverTarget && !driveSource && !driveTarget && !remoteCollectionRoot;
  const targets = manyDestinations ? [...new Set([destination, ...additional])] : [destination];
  const copies = targets.length * itemCount;
  const localCopy = !moving && localTarget && transfer.items.every(({ place }) => place.kind === "local");
  const singleFile = !transfer.collection && !manyDestinations && itemCount === 1 && !transfer.items[0].entry.directory;
  const [promptStart, promptEnd] = t(moving ? "Move {0} to:" : verb === "Download" ? "Download {0} to:" : "Copy {0} to:").split("{0}");
  const renameName = moving && onRename && destination !== defaultDestination && destination.trim() &&
    destination !== "." && destination !== ".." && !/[\\/:]/.test(destination) ? destination : null;
  const qualifiedDrivePath = !!driveRoot && (destination === driveRoot || destination.startsWith(driveRoot + "/"));
  const localPathEntered = !!driveTarget && isLocalMovePath(destination);
  const unsupportedDestination = !resolveEnteredMove && !renameName && (!!archiveTarget && destination !== defaultDestination ||
    !!driveTarget && !qualifiedDrivePath && !localPathEntered || !!remoteCollectionRoot && destination !== defaultDestination);
  const submitDisabled = checkingDestination || unsupportedDestination || targets.some((path) => !path.trim()) ||
    (localCopy && useFilter && !mask.trim());
  const focusMove = transfer.kind === "move" && !submitDisabled;
  const [setupPromptStart, setupPromptEnd] = moving && onRename
    ? t("Rename or move {0} to:").split("{0}") : [promptStart, promptEnd];
  const showConnection = !resolveEnteredMove || destination === defaultDestination;
  const connectionLabel = !showConnection ? undefined : transfer.remoteDestination
    ? remoteDestinationLabel(transfer.remoteDestination) : kswitcherTarget?.address ?? serverTarget?.address;
  const separator = kswitcherTarget || localTarget && windowsClient ? "\\" : "/";
  const browsePath = singleFile && (destination === transfer.target || /[\\/]$/.test(destination)) && destination
    ? destination.replace(/[\\/]+$/, "") + separator + (transfer.items[0].entry.googleDrive?.name ?? transfer.items[0].entry.name)
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
    if (checkingDestination) return;
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

  async function resolveGoogleDriveDestination(path: string) {
    if (!driveTarget || !driveRoot || !qualifiedDrivePath) return undefined;
    const profile = driveTarget.id;
    if (path === defaultDestination) return { profile, parent: driveTarget.folders.at(-1)?.id ?? "root" };
    let parent = "root";
    for (const segment of path.slice(driveRoot.length).split("/").filter(Boolean)) {
      if (cancelled.current) return undefined;
      const matches = (await api.listGoogleDrive(profile, parent)).filter((item) => item.directory && item.name === segment);
      if (matches.length !== 1) throw new Error(t("Choose a unique Google Drive folder. {0}", segment));
      parent = matches[0].id;
    }
    return { profile, parent };
  }

  async function run(retry: boolean, driveDestination = resolvedDestination.current) {
    if (running.current !== null) return;
    const previousSession = session.current;
    const id = previousSession ?? nextTransferId();
    session.current = id;
    running.current = id;
    failedDecision.current = false;
    const archiveCopy = !moving && !remoteCollectionRoot && transfer.items.every(({ place }) => place.kind === "local") ? archiveTarget : undefined;
    const move = resolvedMove.current;
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
    let driveIssues = false;
    let preparedFolders: Map<string, FilePlace> | undefined;
    if (!retry) setDriveNotes([]);
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
        if (remoteCollectionRoot) preparedFolders = await prepareRemoteCollectionFolders(id, remoteCollectionRoot,
          transfer.collection.folders, () => cancelled.current);
        else for (const target of targets) {
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
        setProgress({ file: entry.googleDrive?.name ?? entry.name, bytes: 0, total: null });
        const remoteCopy = driveSource || !localTarget || isFileServer(transfer.source) || transfer.kswitcherBroker ||
          (place.kind === "server" || place.kind === "kswitcher") && entry.directory;
        const prepared = preparedFolders?.get(JSON.stringify(item.collectionDestination ?? []));
        const target = move?.path ?? (prepared ? placePath(prepared) : item.collectionDestination?.length
          ? [destination.replace(/[\\/]+$/, ""), ...item.collectionDestination].join(separator)
          : remoteCopy && !manyDestinations && itemCount === 1 && transfer.target && !/[\\/:]/.test(destination)
          ? transfer.target.replace(/[\\/]+$/, "") + separator + destination
          : destination);
        const remote = move ? move.remote : isFileServer(prepared) ? prepared : transfer.remoteDestination;
        const server = move ? move.server : isWritableServerPlace(prepared) ? prepared : serverTarget;
        const archive = move ? move.archive : prepared?.kind === "archive" ? prepared : archiveTarget;
        const request = {
          source: itemSource(place, entry), destination: target, moving,
          ftpDestination: remote?.kind === "ftp" ? remote.id : undefined,
          sshDestination: remote?.kind === "ssh" ? remote.id : undefined,
          serverDestination: server?.id,
          archiveDestination: archive ? { id: archive.id, segments: archive.segments } : undefined,
          googleDriveDestination: move ? move.googleDrive : prepared?.kind === "googleDrive" ?
            { profile: prepared.id, parent: prepared.folders.at(-1)?.id ?? "root" } : driveDestination,
          kswitcherDestination: (move ? move.kswitcher : kswitcherTarget)?.peer,
          kswitcherBroker: move ? move.broker : transfer.kswitcherBroker,
          multiple: !!transfer.collection || itemCount > 1 || manyDestinations, policy, askReadOnly, retry: retry && index === processed,
          copyOptions: localCopy ? { access, preserveTimestamps, followLinks, mask: useFilter ? mask.trim() : undefined } : undefined,
        };
        const output = transferEvents(id);
        const driveToLocal = place.kind === "googleDrive" && !request.googleDriveDestination &&
          !remote && !server && !archive && !request.kswitcherDestination && !request.kswitcherBroker;
        let result;
        try {
          result = await api.transfer(id, request, output);
        } catch (error) {
          if (!driveToLocal || jobs.length === 1 || cancelled.current) throw error;
          driveIssues = true;
          const name = entry.googleDrive?.name ?? entry.name;
          const detail = errorText(describeError(error));
          setDriveNotes((notes) => [...notes, `${name} — ${detail}`]);
          setSkipped(++skippedItems);
        } finally {
          output.onmessage = () => {};
        }
        if (result?.kind === "source_retained") {
          if (driveToLocal) {
            driveIssues = true;
            setDriveNotes((notes) => [...notes, `${result.source} — ${errorText(result.error)}`]);
            setCompleted((count) => count + 1);
          } else {
            setError(t(transfer.kswitcherBroker || item.place.kind !== "local" ? "Copied to {0}. Could not finish removing source {1}. {2}" :
              "Uploaded to {0}. Could not remove local source {1}. {2}", result.destination, result.source, errorText(result.error)));
            setBlocked(item);
            return;
          }
        }
        if (result?.kind === "completed") {
          if (moving && item.searchPath) movedPaths.push(item.searchPath);
          setCompleted((count) => count + 1);
        } else if (result?.kind === "skipped") setSkipped(++skippedItems);
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
      const success = finished && !cancelled.current && skippedItems === 0 && !driveIssues;
      onFinished(success, movedPaths, move);
      if (success) onClose();
      else setPhase("done");
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (phase !== "setup" || checkingDestination || unsupportedDestination) return;
    setCheckingDestination(true);
    setError("");
    try {
      if (renameName && onRename) {
        await onRename(renameName);
        onClose();
      } else {
        if (resolveEnteredMove) {
          const target = await resolveMoveDestination(destination, transfer.moveTarget, transfer.connectedPlaces ?? [], transfer.source, itemCount > 1);
          for (const { place, entry } of transfer.items) {
            if (entry.link && (place.kind !== "local" || target.googleDrive || target.remote || target.server || target.archive || target.kswitcher || target.broker)) {
              throw new Error(t("Choose files or folders without symbolic links."));
            }
            if (target.googleDrive && place.kind !== "local" && place.kind !== "googleDrive") {
              throw new Error(t("Choose local or Google Drive items to transfer to Google Drive."));
            }
            if (place.kind === "googleDrive" && !target.googleDrive) {
              if (target.remote || target.server || target.archive || target.kswitcher) {
                throw new Error(t("Choose a local folder or a Google Drive folder as the destination."));
              }
            }
          }
          resolvedMove.current = target;
        } else {
          resolvedDestination.current = await resolveGoogleDriveDestination(destination);
        }
        void run(false, resolvedDestination.current);
      }
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setCheckingDestination(false);
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
          <div className="dialog-body transfer-body transfer-options">
            <div className="field">
              <label htmlFor="transfer-destination" data-tooltip={placePath(itemCount === 1 ? transfer.items[0].place : transfer.source)}>
                {transfer.collection ? t("Copy from collection") : <>
                  {setupPromptStart}<strong>{itemCount === 1 ? (transfer.items[0].entry.googleDrive?.name ?? transfer.items[0].entry.name) : t("{0} selected items", itemCount)}</strong>{setupPromptEnd}
                </>}
              </label>
              {connectionLabel && <span className="muted" id="transfer-connection">{connectionLabel}</span>}
              {remoteCollectionRoot ? <input id="transfer-destination" type="text" readOnly value={destination}
                aria-label={t("Destination")} aria-describedby="collection-remote-destination" /> :
              archiveTarget || driveTarget || resolveEnteredMove && (serverTarget || transfer.remoteDestination || kswitcherTarget) ? <input id="transfer-destination" type="text"
                aria-label={t("Destination")} aria-describedby={connectionLabel ? "transfer-connection" : undefined}
                readOnly={(!resolveEnteredMove && !driveTarget && !onRename) || checkingDestination}
                data-initial-focus={!focusMove || undefined} value={destination}
                onFocus={(event) => { if (resolveEnteredMove || driveTarget || onRename) event.currentTarget.select(); }} onChange={(event) => {
                  setDestination(event.target.value);
                  setError("");
                }} /> :
              serverTarget ? <input id="transfer-destination" type="text" aria-label={t("Destination")} aria-describedby="transfer-connection"
                required data-initial-focus={!focusMove || undefined} value={destination} onChange={(event) => setDestination(event.target.value)} /> :
              <PathField id="transfer-destination" label={t("Destination")} value={destination} onChange={setDestination}
                describedBy={connectionLabel ? "transfer-connection" : undefined}
                required initialFocus={!focusMove} selectOnFocus showHidden={showHidden} server={transfer.remoteDestination}
                kswitcher={kswitcherTarget} includeFiles={singleFile}
                browse={singleFile ? "save" : "folder"} browsePath={browsePath} />}
            </div>
            {remoteCollectionRoot && <p id="collection-remote-destination">{t("Open the destination folder in the other pane before copying a collection.")}</p>}
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
            {!moving && !archiveTarget && !serverTarget && !driveSource && !driveTarget && !remoteCollectionRoot && <label className="field-checkbox">
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
            {error && <p className="dialog-error" role="alert">{errorText(error)}</p>}
            {unsupportedDestination && <p className="dialog-error" role="status">{t(driveTarget
              ? "Enter a Google Drive path, an absolute local path, or a new name."
              : "Enter a new name or keep the destination shown when the dialog opened.")}</p>}
          </div>
          <footer className="dialog-footer">
            <Button type="button" disabled={checkingDestination} onClick={onClose}>{t("Cancel")}</Button>
            <Button type="submit" className="primary" data-initial-focus={focusMove || undefined}
              disabled={submitDisabled}>{t(renameName ? "Rename" : verb)}</Button>
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
                {phase === "done" && driveNotes.length > 0 && <ul>{driveNotes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
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
