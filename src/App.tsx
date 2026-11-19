import { Button } from "./Button";
import { CommandField } from "./CommandField";
import { clampSplit, SplitDivider } from "./SplitDivider";
import { timestampSeconds, useTimestamps } from "./useTimestamps";
import { commandHistoryGroups, historyLimit, readCommandHistory, saveCommandHistory, type CommandEntry } from "./commandHistory";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import {
  ArrowDownToLine, ArrowLeftRight, CheckSquare, Copy, Eye, EyeOff, FileDiff, FilePlus, FolderPlus, FolderTree,
  Calculator, Pencil, Search, Server, Settings2, Terminal as TerminalIcon, TextCursorInput, Trash2,
} from "lucide-react";
import { Channel, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, connectFtpLocation, describeError, folderLabel, isLockError, isPermissionError, placePath, writableTextPlace, windowsClient, type ArchivePlace, type Entry, type FtpPlace, type KSwitcherPeer, type Listing, type NamedFile, type Operation, type Place, type QuickLocation, type RemotePlace, type SizeResult } from "./api";
import { textEncodingLabels, type AppUpdate, type TerminalCommand, type TerminalSession, type TextEncoding, type UpdateProgress } from "./api";
import { Dialog } from "./Dialog";
import { AttributesDialog } from "./AttributesDialog";
import { FtpDialog } from "./FtpDialog";
import { FolderShortcutsDialog, type FolderShortcutScreen } from "./FolderShortcutsDialog";
import { persistFolderShortcuts, readFolderShortcuts, shortcutFromPlace, type FolderGroup, type FolderShortcut } from "./folderShortcuts";
import { HelpDialog, type HelpTopic } from "./HelpDialog";
import { AboutDialog, MainMenu, type MainMenuHandle, type MenuGroup } from "./MainMenu";
import { McpDialog, McpRequests } from "./McpDialog";
import { Pane } from "./Pane";
import { NewFolderDialog } from "./NewFolderDialog";
import { ArchiveDialog, ArchivePasswordDialog, isArchiveName, passwordError } from "./ArchiveDialog";
import { SearchDialog } from "./SearchDialog";
import { ElevationButton, LockDialog } from "./ProcessTools";
import { Settings } from "./Settings";
import { applyAppearance } from "./appearance";
import { TextWindow, CompareDialog } from "./TextTools";
import type { MarkdownAnchor } from "./MarkdownPreview";
import { TransferDialog, type Transfer } from "./TransferDialog";
import {
  applyListing, childPlace, closeSearchResults, extendKeyboardRange, formatSize, localPath, opposite, paneCursorIndex, paneItem, parentPlace,
  readPlace, selectableRange, showSearchResults, visibleEntries,
  type PaneState, type Side, type SortColumn,
} from "./panes";
import { commandNames, commands, commandScope, eventShortcut, folderGroupCommand, persistPreferences, physicalFolderBinding,
  quickSearchSeed, showShortcut, type Command, type Preferences } from "./preferences";
import { countText, errorText, setLanguage, t } from "./i18n";
import { Message } from "./Message";
import { readWorkspace, restorePane, saveWorkspace, type DocumentWindow, type SavedFtpLocation } from "./workspace";
import { maxViewFontSize, minViewFontSize, type ZoomViewFont } from "./viewFonts";
import { shellArgument } from "./shell";

const TerminalPanel = lazy(() => import("./TerminalPanel"));
const fileDrag = "application/x-dirlume-files";

type NetworkPlace = Extract<RemotePlace, { kind: "server" | "ftp" }>;
type RenameLocation = Extract<Place, { kind: "local" | "ftp" }>;
type RowRename = { side: Side; place: RenameLocation; name: string };

function sameRenameLocation(current: Place | null, place: RenameLocation) {
  return current !== null && current.kind === place.kind && placePath(current) === placePath(place) &&
    (place.kind === "local" || sameConnection(current, place));
}

type ActionModal = (
  | { kind: "rename" | "newFile"; path: string; name: string }
  | { kind: "recycle" | "delete"; path: string; names: string[]; directories?: string[] }
) & { ftp?: FtpPlace; archive?: ArchivePlace };

type Modal =
  | { kind: "settings" }
  | { kind: "connect" | "ftp"; side: Side }
  | { kind: "compare"; left: NamedFile; right: NamedFile }
  | { kind: "transfer"; transfer: Transfer }
  | { kind: "search"; side: Side; place: Place }
  | { kind: "mkdir"; side: Side; place: Extract<Place, { kind: "local" }> }
  | { kind: "createArchive"; side: Side; directory: string; names: string[] }
  | { kind: "archivePassword"; side: Side; path: string }
  | { kind: "fileActions"; side: Side; entry?: Entry }
  | { kind: "attributes"; item: NonNullable<ReturnType<typeof paneItem>> }
  | { kind: "folderShortcuts"; side: Side; screen: FolderShortcutScreen }
  | { kind: "about" | "commandHistory" | "mcp" }
  | { kind: "exit"; update?: AppUpdate }
  | { kind: "update"; update: AppUpdate }
  | { kind: "installUpdate"; version: string }
  | ActionModal;

const rowCommands = {
  firstRow: 0, lastRow: Number.POSITIVE_INFINITY, upRow: -1, downRow: 1, pageUp: -12, pageDown: 12,
  selectUpRow: -1, selectDownRow: 1,
};

function isRangeCommand(command: Command) {
  return command === "selectUpRow" || command === "selectDownRow";
}

function contextHelpTopic(modal: Modal["kind"] | undefined, target: Element | null, editing: boolean | undefined): HelpTopic {
  if (modal === "settings") return "general";
  if (modal === "search") return "search";
  if (target?.closest(".terminal-card, .command-bar")) return "terminal";
  return editing === undefined ? "files" : editing ? "editor" : "viewer";
}

function sameConnection(left: Place | null, right: Place) {
  return (left?.kind === "server" || left?.kind === "ftp" || left?.kind === "archive") && left.kind === right.kind && left.id === right.id;
}

function disconnect(place: NetworkPlace) {
  void (place.kind === "ftp" ? api.disconnectFtp(place.id) : api.disconnect(place.id)).catch(() => {});
}

export default function App({ initialPreferences }: { initialPreferences: Preferences }) {
  const [startup] = useState(readWorkspace);
  const [ready, setReady] = useState(false);
  const [panes, setPanes] = useState(() => ({ left: restorePane(startup?.panels.left), right: restorePane(startup?.panels.right) }));
  const visiblePanes = useRef(panes);
  visiblePanes.current = panes;
  const [rowRename, setRowRename] = useState<RowRename | null>(null);
  const [locations, setLocations] = useState<QuickLocation[]>([]);
  const [active, setActive] = useState<Side>(startup?.active === "right" ? "right" : "left");
  const [processPanels, setProcessPanels] = useState<Record<Side, { path?: string } | null>>({ left: null, right: null });
  const [preferences, setPreferences] = useState(initialPreferences);
  const scheme = preferences.schemes.find(({ id }) => id === preferences.activeScheme) ?? null;
  const theme = scheme?.base ?? preferences.theme;
  const [modal, setModal] = useState<Modal | null>(null);
  const [helpTopic, setHelpTopic] = useState<HelpTopic | null>(null);
  const [availableUpdate, setAvailableUpdate] = useState<AppUpdate | null>(null);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const checkingUpdates = useRef(false);
  const manualUpdateCheck = useRef(false);
  const installingUpdate = useRef(false);
  const [documents, setDocuments] = useState<DocumentWindow[]>(startup?.documents ?? []);
  const [activeDocument, setActiveDocument] = useState<number | null>(startup?.activeDocument ?? null);
  const [linkedAnchor, setLinkedAnchor] = useState<{ id: number; anchor: MarkdownAnchor } | null>(null);
  const nextDocument = useRef(Math.max(0, ...(startup?.documents ?? []).map(({ id }) => id)));
  const dirtyDocuments = useRef(new Set<number>());
  const exitConfirmed = useRef(false);
  const busy = modal?.kind === "transfer";
  const [terminal, setTerminal] = useState<TerminalSession | null>(null);
  const [panelsHidden, setPanelsHidden] = useState(false);
  const [split, setSplit] = useState(Number.isFinite(startup?.split) ? clampSplit(startup!.split) : 50);
  const [commandLine, setCommandLine] = useState("");
  const [pendingCommands, setPendingCommands] = useState<TerminalCommand[]>([]);
  const commandInput = useRef<HTMLTextAreaElement>(null);
  const [historyItems, setHistoryItems] = useState(readCommandHistory);
  const commandTexts = useMemo(() => historyItems.map(({ text }) => text), [historyItems]);
  const historyIndex = useRef(-1);
  const selectionAnchor = useRef<{ left: string | null; right: string | null }>({ left: null, right: null });
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "Ready" });
  const [folderShortcuts, setFolderShortcuts] = useState(readFolderShortcuts);
  const request = useRef({ left: 0, right: 0 });
  const listingPending = useRef({ left: false, right: false });
  const nextSession = useRef(0);
  const watchId = useRef(0);
  const measureId = useRef(0);
  const scans = useRef<{ left: number | null; right: number | null }>({ left: null, right: null });
  const drag = useRef<{ side: Side; source: Place; items: Transfer["items"] } | null>(null);
  const latest = useRef(panes);
  const mainMenu = useRef<MainMenuHandle>(null);
  latest.current = panes;
  const connected = useRef<Record<Side, NetworkPlace | null>>({ left: null, right: null });
  const failedFtp = useRef<Partial<Record<Side, SavedFtpLocation>>>({});
  const pane = panes[active];
  const other = panes[opposite(active)];
  const entries = useMemo(() => ({
    left: visibleEntries(panes.left, preferences.hidden),
    right: visibleEntries(panes.right, preferences.hidden),
  }), [panes, preferences.hidden]);
  const currentRow = entries[active][paneCursorIndex(pane, entries[active])];
  const current = currentRow?.name === ".." ? undefined : currentRow;
  const currentItem = paneItem(pane, current);
  const local = pane.place?.kind === "local" ? pane.place : null;
  const ftp = pane.place?.kind === "ftp" ? pane.place : undefined;
  const archive = pane.place?.kind === "archive" ? pane.place : undefined;
  const otherFtp = !other.search && other.place?.kind === "ftp";
  const canTransfer = Boolean(current && pane.place);
  const helpShortcut = preferences.shortcuts.help;
  const modalKind = modal?.kind;
  const editingDocument = documents.find(({ id }) => id === activeDocument)?.editing;

  const checkUpdates = useCallback(async (manual: boolean) => {
    if (manual) {
      manualUpdateCheck.current = true;
      setStatus({ text: "Checking for updates…" });
    }
    if (checkingUpdates.current) return;
    checkingUpdates.current = true;
    try {
      const update = await api.checkForUpdate(manual);
      if (update) setAvailableUpdate(update);
      if (manualUpdateCheck.current) setStatus({ text: update ? "Ready" : "Dirlume is up to date." });
    } catch (error) {
      if (manualUpdateCheck.current) setStatus({ text: describeError(error), error: true });
    } finally {
      checkingUpdates.current = false;
      manualUpdateCheck.current = false;
    }
  }, []);

  useEffect(() => {
    if (isTauri()) void checkUpdates(false);
  }, [checkUpdates]);

  useEffect(() => {
    if (!availableUpdate || modal || helpTopic) return;
    setModal({ kind: "update", update: availableUpdate });
    setAvailableUpdate(null);
  }, [availableUpdate, modal, helpTopic]);

  useLayoutEffect(() => {
    if (!helpShortcut) return;
    function openHelp(event: WindowEventMap["keydown"]) {
      if (event.defaultPrevented || event.isComposing || eventShortcut(event) !== helpShortcut) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-shortcut-capture]")) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const topic = contextHelpTopic(modalKind, target, editingDocument);
      setHelpTopic((current) => current ?? topic);
    }
    document.addEventListener("keydown", openHelp, true);
    return () => document.removeEventListener("keydown", openHelp, true);
  }, [helpShortcut, modalKind, editingDocument]);

  const updatePane = useCallback((side: Side, updater: (pane: PaneState) => PaneState) => {
    setPanes((previous) => ({ ...previous, [side]: updater(previous[side]) }));
  }, []);

  const cancelScan = useCallback((side: Side) => {
    const previous = scans.current[side];
    if (previous === null) return;
    scans.current[side] = null;
    void api.cancelMeasurement(previous).catch(() => {});
    updatePane(side, (pane) => ({ ...pane, measuring: [] }));
  }, [updatePane]);

  const load = useCallback(async (side: Side, place: Place, action: "push" | "refresh" | "background" | number = "push", reveal?: string) => {
    const background = action === "background";
    if (background && listingPending.current[side]) return false;
    if (!background) cancelScan(side);
    const ticket = ++request.current[side];
    listingPending.current[side] = true;
    if (!background) updatePane(side, (pane) => ({ ...pane, loading: true, error: "", elevationPath: undefined }));
    try {
      const result = await readPlace(place);
      if (ticket !== request.current[side]) return false;
      if (action === "push" || typeof action === "number") delete failedFtp.current[side];
      const found = reveal !== undefined && result.listing.entries.some((entry) => entry.name === reveal);
      if (reveal !== undefined && !found) setStatus({ text: t("File no longer found: {0}", reveal), error: true });
      updatePane(side, (pane) => {
        const listing = applyListing(pane, result.place, result.listing, action);
        return found ? { ...listing, selected: reveal, filter: "", marked: [], keyboardRange: undefined } : listing;
      });
      return true;
    } catch (error) {
      if (ticket === request.current[side]) {
        const text = describeError(error);
        updatePane(side, (pane) => ({ ...pane, loading: false, error: text,
          elevationPath: windowsClient && place.kind === "local" && isPermissionError(text) ? place.path : undefined }));
      }
      return false;
    } finally {
      if (request.current[side] === ticket) listingPending.current[side] = false;
    }
  }, [cancelScan, updatePane]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.locations(), api.requestedLocation()]).then(async ([locations, requested]) => {
      if (cancelled) return;
      setLocations(locations);
      const home = locations[0];
      const alternate = locations.find(({ label }) => label === "Downloads") ?? home;
      if (home && alternate) {
        await Promise.all(([["left", home.path], ["right", alternate.path]] as const).map(async ([side, fallback]) => {
          const requestedFolder = side === "left" && requested ? localPath(requested) : null;
          const saved = startup?.panels[side];
          const savedFtp = !requestedFolder ? saved?.ftp : undefined;
          let failure: string | undefined;
          if (savedFtp) {
            const ticket = ++request.current[side];
            listingPending.current[side] = true;
            updatePane(side, (pane) => ({ ...pane, loading: true }));
            try {
              const { place, listing } = await connectFtpLocation(savedFtp.profileId, savedFtp.segments);
              if (cancelled || request.current[side] !== ticket) {
                disconnect(place);
                return;
              }
              connected.current[side] = place;
              updatePane(side, (pane) => applyListing(pane, place, listing, "push"));
              return;
            } catch (error) {
              if (cancelled || request.current[side] !== ticket) return;
              failure = t("Could not restore the FTP folder.") + " " + errorText(describeError(error));
            } finally {
              if (request.current[side] === ticket) listingPending.current[side] = false;
            }
          }
          const local = requestedFolder ?? saved?.place;
          let ticket = request.current[side] + 1;
          if (!local || !await load(side, local, requestedFolder ? "push" : "refresh")) {
            if (cancelled || (local && request.current[side] !== ticket)) return;
            ticket = request.current[side] + 1;
            await load(side, localPath(fallback));
          }
          if (savedFtp && failure && !cancelled && request.current[side] === ticket) {
            failedFtp.current[side] = savedFtp;
            updatePane(side, (pane) => ({ ...pane, error: failure }));
          }
        }));
      }
    }).catch((error: unknown) => {
      if (!cancelled) setStatus({ text: describeError(error), error: true });
    }).finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [load, startup, updatePane]);

  useEffect(() => {
    if (ready) saveWorkspace(panes, active, split, documents, activeDocument, failedFtp.current);
  }, [ready, panes, active, split, documents, activeDocument]);

  const leftPath = panes.left.place?.kind === "local" ? panes.left.place.path : null;
  const rightPath = panes.right.place?.kind === "local" ? panes.right.place.path : null;
  useEffect(() => {
    const locations = [["left", leftPath], ["right", rightPath]] as const;
    const stopWatching = locations.map(([side, path]) => {
      if (!path) return () => {};
      const id = ++watchId.current;
      let stopped = false;
      let timer: number | undefined;
      const changes = new Channel<null>();
      const refreshWatchedFolder = () => {
        const current = latest.current[side];
        if (stopped || current.place?.kind !== "local" || current.place.path !== path) return;
        if (listingPending.current[side]) timer = window.setTimeout(refreshWatchedFolder, 150);
        else void load(side, current.place, "background");
      };
      changes.onmessage = () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(refreshWatchedFolder, 150);
      };
      const started = api.watchDirectory(id, path, changes);
      void started.catch(() => {});
      return () => {
        stopped = true;
        changes.onmessage = () => {};
        window.clearTimeout(timer);
        void started.then(() => api.unwatchDirectory(id)).catch(() => {});
      };
    });
    return () => stopWatching.forEach((stop) => stop());
  }, [leftPath, rightPath, load]);

  const leftRemote = panes.left.place?.kind !== "local" ? panes.left.place : null;
  const rightRemote = panes.right.place?.kind !== "local" ? panes.right.place : null;
  useEffect(() => {
    if (!leftRemote && !rightRemote) return;
    const timer = window.setInterval(() => {
      for (const side of ["left", "right"] as const) {
        const { place } = latest.current[side];
        if (place && place.kind !== "local") void load(side, place, "background");
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [leftRemote, rightRemote, load]);

  useEffect(() => {
    persistPreferences(preferences);
  }, [preferences]);

  const zoomViewFont: ZoomViewFont = useCallback((view, change, base) => {
    setPreferences((current) => {
      const previous = current.viewFontSizes[view] ?? base;
      const size = Math.max(minViewFontSize, Math.min(maxViewFontSize, previous + change));
      if (size === previous) return current;
      return { ...current, viewFontSizes: { ...current.viewFontSizes, [view]: size } };
    });
  }, []);

  useEffect(() => {
    saveCommandHistory(historyItems);
  }, [historyItems]);

  useLayoutEffect(() => {
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => applyAppearance(theme, scheme);
    apply();
    system.addEventListener("change", apply);
    return () => system.removeEventListener("change", apply);
  }, [theme, scheme]);

  useEffect(() => {
    if (isTauri()) {
      const base = scheme?.base ?? theme;
      const nativeTheme = base === "system" ? null : base === "light" ? "light" : "dark";
      void getCurrentWindow().setTheme(nativeTheme).catch(() => {});
    }
  }, [theme, scheme?.base]);

  useEffect(() => {
    if (!isTauri()) return;
    const listener = getCurrentWindow().onCloseRequested((event) => {
      if (installingUpdate.current) {
        event.preventDefault();
        return;
      }
      if (!exitConfirmed.current && dirtyDocuments.current.size) {
        event.preventDefault();
        setModal({ kind: "exit" });
      }
    });
    return () => { void listener.then((unlisten) => unlisten()).catch(() => {}); };
  }, []);

  function installUpdate(update: AppUpdate) {
    if (update.kind === "debian") {
      void api.openWebLink(update.url).catch((error: unknown) => setStatus({ text: describeError(error), error: true }));
      return;
    }
    installingUpdate.current = true;
    setUpdateProgress(null);
    setModal({ kind: "installUpdate", version: update.version });
    const progress = new Channel<UpdateProgress>();
    progress.onmessage = setUpdateProgress;
    void api.installUpdate(update.version, progress).catch((error: unknown) => {
      installingUpdate.current = false;
      setModal(null);
      setStatus({ text: describeError(error), error: true });
    });
  }

  function focus(side: Side) {
    setActive(side);
    document.getElementById(`${side}-files`)?.focus();
  }

  function selectDocument(id: number | null) {
    setActiveDocument(id);
    if (id === null) requestAnimationFrame(() => {
      if (panelsHidden) commandInput.current?.focus();
      else focus(active);
    });
  }

  function openDocument(file: NamedFile, editing: boolean, anchor?: MarkdownAnchor, replaceId?: number) {
    const existing = documents.find((item) => (replaceId === undefined || item.id === replaceId) &&
      item.editing === editing && item.file.name === file.name &&
      item.file.place.kind === file.place.kind && placePath(item.file.place) === placePath(file.place) &&
      (file.place.kind === "local" || sameConnection(item.file.place, file.place)));
    const id = existing?.id ?? replaceId ?? ++nextDocument.current;
    if (!existing) {
      const opened = { id, file, editing };
      setDocuments((current) => replaceId === undefined ? [...current, opened] :
        current.map((item) => item.id === replaceId ? opened : item));
    }
    setLinkedAnchor(anchor ? { id, anchor } : null);
    selectDocument(id);
  }

  function closeDocument(id: number) {
    const index = documents.findIndex((document) => document.id === id);
    if (index < 0) return;
    const remaining = documents.filter((document) => document.id !== id);
    const { place } = documents[index].file;
    if ((place.kind === "server" || place.kind === "ftp") && !Object.values(connected.current).some((connection) => sameConnection(connection, place)) &&
        !remaining.some(({ file }) => sameConnection(file.place, place))) {
      disconnect(place);
    }
    setDocuments(remaining);
    dirtyDocuments.current.delete(id);
    if (activeDocument === id) selectDocument(documents[index - 1]?.id ?? null);
  }

  function documentKeys(event: KeyboardEvent) {
    if (modal || helpTopic || event.nativeEvent.isComposing) return;
    if ((event.target as HTMLElement).closest("dialog[open]")) return;
    const shortcut = eventShortcut(event);
    if (!shortcut) return;
    if (shortcut === preferences.shortcuts.menu) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) perform("menu");
      return;
    }
    if (!documents.length) return;
    const direction = shortcut === preferences.shortcuts.nextDocument ? 1 : shortcut === preferences.shortcuts.previousDocument ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const ids = [null, ...documents.map(({ id }) => id)];
    const index = ids.indexOf(activeDocument);
    selectDocument(ids[(index + direction + ids.length) % ids.length]);
  }

  function routeRemote(side: Side, place: RemotePlace, listing: Listing) {
    showProcesses(side, false);
    cancelScan(side);
    ++request.current[side];
    listingPending.current[side] = false;
    delete failedFtp.current[side];
    const previous = connected.current[side];
    if (previous && !documents.some(({ file }) => sameConnection(file.place, previous))) disconnect(previous);
    connected.current[side] = place.kind === "kswitcher" ? null : place;
    setActive(side);
    updatePane(side, (pane) => {
      const history = pane.history.slice(0, pane.position + 1).filter((location) => location.kind === "local");
      return applyListing({ ...pane, history, position: history.length - 1 }, place, listing, "push");
    });
  }

  function open(side: Side, entry: Entry) {
    if (entry.name === "..") { parent(side); return; }
    const item = paneItem(panes[side], entry);
    if (!item || panes[side].loading) return;
    const { place, entry: file } = item;
    if (file.directory) {
      void load(side, childPlace(place, file.name));
    } else if ((place.kind === "ftp" || place.kind === "archive") && !file.link) {
      openDocument({ place, name: file.name }, false);
    } else if (place.kind === "local") {
      if (!file.link && isArchiveName(file.name)) {
        const path = placePath(childPlace(place, file.name));
        void openArchive(side, path).catch((error: unknown) => {
          const text = describeError(error);
          if (text === passwordError) setModal({ kind: "archivePassword", side, path });
          else setStatus({ text, error: true });
        });
        return;
      }
      void api.operate(place.path, { kind: "open", name: file.name }).catch((error: unknown) =>
        setStatus({ text: describeError(error), error: true }));
    } else {
      setStatus({ text: "Copy the remote file to a local folder to open it." });
    }
  }

  async function openArchive(side: Side, path: string, password?: string) {
    const ticket = ++request.current[side];
    listingPending.current[side] = true;
    updatePane(side, (pane) => ({ ...pane, loading: true }));
    try {
      const { listing, ...opened } = await api.openArchive(path, password);
      if (ticket === request.current[side]) {
        const place: ArchivePlace = { ...opened, kind: "archive", segments: [],
          address: opened.writable ? "Archive" : "Read-only archive" };
        updatePane(side, (pane) => applyListing(pane, place, listing, "push"));
      }
    } finally {
      if (ticket === request.current[side]) {
        listingPending.current[side] = false;
        updatePane(side, (pane) => ({ ...pane, loading: false }));
      }
    }
  }

  function parent(side: Side) {
    if (processPanels[side]) {
      showProcesses(side, false);
      return;
    }
    if (panes[side].search) {
      closeResults(side);
      return;
    }
    const place = panes[side].place;
    const target = place && parentPlace(place);
    if (target) void load(side, target, "push", place?.kind === "archive" && !place.segments.length ? folderLabel(place) : undefined);
  }

  function currentFolderShortcut(side: Side) {
    const target = panes[side];
    if (panelsHidden || processPanels[side] || target.loading || target.search) return;
    return shortcutFromPlace(target.place);
  }

  function addFolderShortcut(group: FolderGroup) {
    const entry = currentFolderShortcut(active);
    if (entry) setModal({ kind: "folderShortcuts", side: active, screen: { kind: "edit", group, entry } });
  }

  function closeFolderShortcuts(side: Side) {
    setModal(null);
    requestAnimationFrame(() => {
      if (!document.activeElement?.closest(".pane")) focus(side);
    });
  }

  async function openFolderShortcut(side: Side, entry: FolderShortcut) {
    let place: Place = localPath(entry.path);
    if (entry.peer) {
      const navigation = request.current[side];
      try {
        const peers = await api.kswitcherPeers(preferences.kswitcher);
        if (navigation !== request.current[side]) return;
        const peer = peers.find(({ id }) => id === entry.peer?.id);
        if (!peer) {
          setStatus({ text: t("Paired computer is unavailable: {0}", entry.peer.name), error: true });
          return;
        }
        place = { kind: "kswitcher", directory: preferences.kswitcher, address: peer.name, peer: peer.id, path: entry.path, parent: null };
      } catch (error) {
        setStatus({ text: describeError(error), error: true });
        return;
      }
    }
    if (processPanels[side]) showProcesses(side, false);
    else focus(side);
    await load(side, place);
  }

  function history(side: Side, offset: number) {
    if (processPanels[side]) {
      showProcesses(side, false);
      return;
    }
    const pane = panes[side];
    if (pane.search && offset < 0) {
      closeResults(side);
      return;
    }
    const position = pane.position + offset;
    const place = pane.history[position];
    if (place) void load(side, place, position);
  }

  function showProcesses(side: Side, visible: boolean, path?: string) {
    setProcessPanels((panels) => ({ ...panels, [side]: visible ? { path } : null }));
    requestAnimationFrame(() => focus(side));
  }

  function showLockingProcesses(side: Side, item: ReturnType<typeof paneItem>) {
    if (!windowsClient || item?.place.kind !== "local") return;
    const { place, entry } = item;
    showProcesses(opposite(side), true, placePath(childPlace(place, entry.name)));
  }

  function closeResults(side: Side) {
    selectionAnchor.current[side] = null;
    updatePane(side, closeSearchResults);
    requestAnimationFrame(() => focus(side));
  }

  function revealResult(side: Side, directory: Place, name: string) {
    setModal(null);
    setPanelsHidden(false);
    setActive(side);
    void load(side, directory, "push", name);
    requestAnimationFrame(() => focus(side));
  }

  function refresh(side: Side) {
    const { place, loading } = latest.current[side];
    if (place && !loading) void load(side, place, "refresh");
  }

  function sort(side: Side, column: SortColumn) {
    updatePane(side, (pane) => ({
      ...pane, keyboardRange: undefined, sort: { column, asc: column !== pane.sort.column || !pane.sort.asc },
    }));
  }

  async function batch(items: string[], action: (name: string) => Promise<void>) {
    for (const [index, name] of items.entries()) {
      try {
        await action(name);
      } catch (error) {
        throw new Error(`${name} · ${errorText(describeError(error))}${index > 0 ? ` (${t("{0} of {1} completed", index, items.length)})` : ""}`, { cause: error });
      }
    }
  }

  function transferItems(side: Side, selected: Entry, useMarks = true) {
    const state = panes[side];
    const marks = useMarks ? entries[side].filter(({ name }) => state.marked.includes(name)) : [];
    return (marks.length ? marks : [selected]).flatMap((entry) => {
      const item = paneItem(state, entry);
      return item ? [item] : [];
    });
  }

  function openTransfer(kind: Transfer["kind"], source: Place, items: Transfer["items"], target: Place | null, chooseOperation = false) {
    if (!items.length) return;
    if (target?.kind === "ftp" && source.kind !== "local") {
      setStatus({ text: "Choose a local source for the FTP upload.", error: true });
      return;
    }
    if (source.kind !== "local" && items.some(({ entry }) => entry.link || (source.kind === "kswitcher" && entry.directory))) {
      setStatus({ text: source.kind === "kswitcher" ? "Choose regular remote files to download." : "Choose remote files or folders without links.", error: true });
      return;
    }
    setModal({ kind: "transfer", transfer: {
      kind, source, items, chooseOperation,
      target: target?.kind === "local" || target?.kind === "ftp" ? placePath(target) : "",
      ftpDestination: target?.kind === "ftp" ? target.id : undefined,
    } });
  }

  function transfer(kind: "copy" | "move") {
    const source = pane.place;
    if (!source || !current || pane.loading) {
      setStatus({ text: "Select a file or folder in the active pane." });
      return;
    }
    if (kind === "move" && (pane.search || (source.kind !== "local" && source.kind !== "ftp"))) return;
    if (kind === "move" && source.kind === "ftp") {
      setModal({ kind: "rename", path: placePath(source), name: current.name, ftp: source });
      return;
    }
    openTransfer(kind, source, transferItems(active, current), other.search || (kind === "move" && otherFtp) ? null : other.place);
  }

  function startDrag(side: Side, entry: Entry, data: DataTransfer) {
    const state = panes[side];
    if (!state.place || state.loading || modal) return false;
    const items = transferItems(side, entry, state.marked.includes(entry.name));
    if (!items.length) return false;
    drag.current = { side, source: state.place, items };
    data.setData(fileDrag, "files");
    data.effectAllowed = "copyMove";
    return true;
  }

  function canDrop(side: Side, data: DataTransfer) {
    const target = panes[side];
    const supported = target.place?.kind === "local" || (target.place?.kind === "ftp" && drag.current?.source.kind === "local");
    return Boolean(!modal && drag.current && drag.current.side !== side && supported &&
      !target.search && !processPanels[side] && !target.loading && data.types.includes(fileDrag));
  }

  async function copyClipboard(side: Side, entry?: Entry) {
    if (!entry) return;
    const items = transferItems(side, entry, panes[side].marked.includes(entry.name) || entry === current);
    try {
      await api.copyFileReferences(items.map(({ place, entry }) => {
        if (place.kind !== "local") throw new Error("Choose local files to copy to the system clipboard.");
        return { directory: place.path, name: entry.name };
      }));
      setStatus({ text: t(items.length === 1 ? "{0} item copied to the clipboard." : "{0} items copied to the clipboard.", items.length) });
    } catch (failure) { setStatus({ text: describeError(failure), error: true }); }
  }

  async function pasteClipboard(side: Side) {
    const pane = panes[side];
    if (pane.place?.kind !== "local" || pane.search || processPanels[side] || pane.loading) return;
    try {
      const files = await api.clipboardFiles();
      if (!files.length) {
        setStatus({ text: "The clipboard contains no files." });
        return;
      }
      const items = files.map(({ directory, entry }) => ({ place: localPath(directory), entry }));
      openTransfer("copy", items[0].place, items, pane.place);
    } catch (failure) { setStatus({ text: describeError(failure), error: true }); }
  }

  function contextActions(side: Side, entry?: Entry) {
    setActive(side);
    if (entry && !panes[side].marked.includes(entry.name)) selectRow(side, entry, false, false);
    const item = paneItem(panes[side], entry);
    if (windowsClient && item?.place.kind === "local") {
      const { place, entry: file } = item;
      void api.windowsItemMenu(place.path, file.name).catch((failure: unknown) => {
        setStatus({ text: describeError(failure), error: true });
        setModal({ kind: "fileActions", side, entry });
      });
    } else setModal({ kind: "fileActions", side, entry });
  }

  function drop(side: Side) {
    const payload = drag.current;
    drag.current = null;
    if (!payload) return;
    openTransfer("copy", payload.source, payload.items, panes[side].place,
      payload.source.kind === "local" && panes[side].place?.kind === "local" && !panes[payload.side].search);
  }

  function selectRow(side: Side, entry: Entry, range: boolean, mark: boolean) {
    if (rowRename && (rowRename.side !== side || rowRename.name !== entry.name)) setRowRename(null);
    const items = entries[side];
    const index = items.findIndex(({ name }) => name === entry.name);
    const anchorName = selectionAnchor.current[side] ?? panes[side].selected ?? entry.name;
    const anchor = items.findIndex(({ name }) => name === anchorName);
    if (!range) selectionAnchor.current[side] = entry.name;
    const group = range && index >= 0 ? selectableRange(items, anchor < 0 ? index : anchor, index) : [];
    updatePane(side, (pane) => ({
      ...pane, selected: entry.name, keyboardRange: undefined,
      marked: range ? [...new Set([...pane.marked, ...group])] : mark && entry.name !== ".."
        ? pane.marked.includes(entry.name) ? pane.marked.filter((name) => name !== entry.name) : [...pane.marked, entry.name]
        : pane.marked.includes(entry.name) ? pane.marked : [],
    }));
  }

  async function renameItem(place: RenameLocation, name: string, newName: string) {
    if (place.kind === "ftp") await api.renameFtp(place.id, [...place.segments, name], newName);
    else await api.operate(place.path, { kind: "rename", name, new_name: newName });
  }

  function closeRowRename(side: Side) {
    setRowRename(null);
    requestAnimationFrame(() => document.getElementById(side + "-files")?.focus());
  }

  async function submitRowRename(rename: RowRename, name: string) {
    if (name !== rename.name) {
      await renameItem(rename.place, rename.name, name);
      if (sameRenameLocation(visiblePanes.current[rename.side].place, rename.place)) {
        await load(rename.side, rename.place, "refresh", name);
        refresh(opposite(rename.side));
      }
    }
    setRowRename((current) => current === rename ? null : current);
    if (sameRenameLocation(visiblePanes.current[rename.side].place, rename.place)) {
      requestAnimationFrame(() => document.getElementById(rename.side + "-files")?.focus());
    }
  }

  function openTerminal() {
    if (!local) {
      setStatus({ text: "Choose a local folder to open a terminal.", error: true });
      return false;
    }
    if (!terminal) setTerminal({ id: ++nextSession.current, path: local.path, refreshEnvironment: preferences.refreshEnvironment });
    return true;
  }

  function closeTerminal() {
    setTerminal(null);
    setPendingCommands([]);
    setPanelsHidden(false);
    commandInput.current?.focus();
  }

  function toggleTerminal() {
    if (terminal) closeTerminal();
    else openTerminal();
  }

  function recordCommand(text: string) {
    if (!text.trim()) return;
    const date = Date.now();
    setHistoryItems((history) => [{ text, date }, ...history].slice(0, historyLimit));
    historyIndex.current = -1;
  }

  function submitCommand(event: FormEvent) {
    event.preventDefault();
    if (!commandLine.trim()) {
      if (panelsHidden && terminal) setPendingCommands((commands) => [...commands, null]);
      else if (currentRow) open(active, currentRow);
      return;
    }
    if (!local || !openTerminal()) return;
    setPendingCommands((commands) => [...commands, { command: commandLine, directory: local.path }]);
    recordCommand(commandLine);
    setCommandLine("");
  }

  function insertCommand(value: string) {
    const input = commandInput.current;
    if (!input) return;
    const start = input.selectionStart ?? commandLine.length;
    const end = input.selectionEnd ?? start;
    const quoted = /^[\p{Letter}\p{Number}_.:/\\-]+$/u.test(value) ? value : shellArgument(value);
    setCommandLine(commandLine.slice(0, start) + quoted + commandLine.slice(end));
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + quoted.length, start + quoted.length);
    });
  }

  function fileFor(side: Side, entry = entries[side][paneCursorIndex(panes[side], entries[side])]): NamedFile | null {
    const item = paneItem(panes[side], entry);
    return item && item.place.kind !== "kswitcher" && !item.entry.directory && !item.entry.link
      ? { place: item.place, name: item.entry.name } : null;
  }

  const markedFolders = entries[active].filter((entry) => entry.directory && !entry.link && pane.marked.includes(entry.name));
  const canMeasure = Boolean(local || ftp) && !pane.search;
  const measureEntries = !canMeasure ? [] : ftp && currentRow?.name === ".."
    ? entries[active].filter((entry) => entry.directory && !entry.link && entry.name !== "..")
    : markedFolders.length ? markedFolders : current?.directory && !current.link ? [current] : [];

  function measure() {
    if ((!local && !ftp) || pane.loading || !measureEntries.length) return;
    cancelScan(active);
    const id = ++measureId.current;
    scans.current[active] = id;
    const names = measureEntries.map(({ name }) => name);
    updatePane(active, (pane) => ({ ...pane, measuring: names }));
    const output = new Channel<SizeResult>();
    output.onmessage = (result) => {
      if (scans.current[active] !== id) return;
      updatePane(active, (pane) => pane.measuring.includes(result.name) ? ({
        ...pane, sizes: new Map(pane.sizes).set(result.name, result),
        measuring: pane.measuring.filter((name) => name !== result.name),
      }) : pane);
    };
    const source = ftp ? { kind: "ftp" as const, connection: ftp.id, segments: ftp.segments }
      : { kind: "local" as const, directory: local!.path };
    void api.measureFolders(id, source, names, output).catch((error: unknown) => {
      if (scans.current[active] === id) setStatus({ text: describeError(error), error: true });
    }).finally(() => {
      output.onmessage = () => {};
      if (scans.current[active] === id) {
        scans.current[active] = null;
        updatePane(active, (pane) => ({ ...pane, measuring: [] }));
      }
    });
  }

  function perform(command: Command) {
    const bookmark = folderGroupCommand(command);
    if (bookmark) {
      if (bookmark.add) addFolderShortcut(bookmark.group);
      else if (!panelsHidden) {
        const group = folderShortcuts[bookmark.group];
        if (!group.length) setStatus({ text: t("No folder shortcuts in group {0}.", bookmark.group) });
        else if (group.length === 1) void openFolderShortcut(active, group[0]);
        else setModal({ kind: "folderShortcuts", side: active, screen: { kind: "picker", group: bookmark.group, selection: 0 } });
      }
      return;
    }
    if (command === "addFolderShortcut") {
      addFolderShortcut(8);
      return;
    }
    if (command === "folderShortcuts") {
      if (!panelsHidden) setModal({ kind: "folderShortcuts", side: active, screen: { kind: "groups" } });
      return;
    }
    if (processPanels[active]) {
      if (command === "recycle") {
        document.getElementById(`${active}-pane`)?.dispatchEvent(new Event("dirlume-end-processes"));
        return;
      }
      if (command === "cancelMeasure") {
        showProcesses(active, false);
        return;
      }
      if (!["switchPane", "swap", "back", "forward", "parent", "leftLocations", "rightLocations",
        "shrinkLeft", "growLeft", "settings", "help", "menu", "close", "terminal", "connect"].includes(command)) return;
    }
    if (command in rowCommands) {
      const items = entries[active];
      if (!items.length) return;
      const offset = rowCommands[command as keyof typeof rowCommands];
      updatePane(active, (pane) => {
        const index = paneCursorIndex(pane, items);
        const next = Math.max(0, Math.min(items.length - 1, offset === 0 ? 0 : index + offset));
        return isRangeCommand(command) ? extendKeyboardRange(pane, items, index, next) :
          { ...pane, selected: items[next].name, keyboardRange: undefined };
      });
      return;
    }
    switch (command) {
      case "switchPane":
        if (panelsHidden) break;
        if (document.activeElement === commandInput.current) setActive(opposite(active));
        else focus(opposite(active));
        break;
      case "swap": {
        if (listingPending.current.left || listingPending.current.right || busy) break;
        cancelScan("left");
        cancelScan("right");
        setPanes((current) => ({ left: current.right, right: current.left }));
        setProcessPanels((current) => ({ left: current.right, right: current.left }));
        connected.current = { left: connected.current.right, right: connected.current.left };
        failedFtp.current = { left: failedFtp.current.right, right: failedFtp.current.left };
        selectionAnchor.current = { left: selectionAnchor.current.right, right: selectionAnchor.current.left };
        focus(opposite(active));
        break;
      }
      case "address": {
        const input = document.getElementById(`${active}-address`) as HTMLInputElement | null;
        input?.focus();
        input?.select();
        break;
      }
      case "open": if (currentRow) open(active, currentRow); break;
      case "attributes":
        if (currentItem && !pane.loading && !busy) setModal({ kind: "attributes", item: currentItem });
        break;
      case "parent": parent(active); break;
      case "back": history(active, -1); break;
      case "forward": history(active, 1); break;
      case "refreshAlternate":
      case "refresh": refresh(active); break;
      case "filter": document.getElementById(`${active}-pane`)?.dispatchEvent(new Event("dirlume-filter")); break;
      case "hidden": setPreferences({ ...preferences, hidden: !preferences.hidden }); break;
      case "settings": setModal({ kind: "settings" }); break;
      case "help": setHelpTopic(contextHelpTopic(undefined, document.activeElement, editingDocument)); break;
      case "menu": mainMenu.current?.open(); break;
      case "close": void getCurrentWindow().close().catch((error: unknown) => setStatus({ text: describeError(error), error: true })); break;
      case "leftLocations":
      case "rightLocations": {
        if (panelsHidden) setPanelsHidden(false);
        const side = command === "leftLocations" ? "left" : "right";
        setActive(side);
        requestAnimationFrame(() => document.getElementById(`${side}-pane`)?.dispatchEvent(new Event("dirlume-locations")));
        break;
      }
      case "shrinkLeft": setSplit(clampSplit(split - 1)); break;
      case "growLeft": setSplit(clampSplit(split + 1)); break;
      case "terminal":
        if (panelsHidden) setPanelsHidden(false);
        else if (terminal || openTerminal()) setPanelsHidden(true);
        requestAnimationFrame(() => commandInput.current?.focus());
        break;
      case "commandPath":
      case "commandName":
        if (currentItem?.place.kind === "local") insertCommand(command === "commandPath"
          ? placePath(childPlace(currentItem.place, currentItem.entry.name)) : currentItem.entry.name);
        break;
      case "previousCommand": {
        const previous = commandTexts[historyIndex.current + 1];
        if (previous !== undefined) {
          historyIndex.current++;
          setCommandLine(previous);
          requestAnimationFrame(() => commandInput.current?.focus());
        }
        break;
      }
      case "commandHistory": setModal({ kind: "commandHistory" }); break;
      case "connect": setModal({ kind: "connect", side: active }); break;
      case "mark": {
        if (current) {
          selectRow(active, current, false, true);
          const index = entries[active].findIndex(({ name }) => name === current.name);
          const following = entries[active][index + 1];
          if (following) updatePane(active, (pane) => ({ ...pane, selected: following.name }));
        }
        break;
      }
      case "copy": if (!busy) transfer("copy"); break;
      case "move": if (!busy) transfer("move"); break;
      case "copyClipboard": if (current) void copyClipboard(active, current); break;
      case "lockingProcesses": if (current) showLockingProcesses(active, currentItem); break;
      case "pasteClipboard": void pasteClipboard(active); break;
      case "search":
        if (pane.place && !pane.loading) setModal({ kind: "search", side: active, place: pane.place });
        break;
      case "mkdir":
        if (local && !pane.search && !busy && !pane.loading) setModal({ kind: "mkdir", side: active, place: local });
        break;
      case "createArchive":
        if (local && current && !pane.search && !busy && !pane.loading) {
          setModal({ kind: "createArchive", side: active, directory: local.path,
            names: transferItems(active, current).map(({ entry }) => entry.name) });
        }
        break;
      case "rename": {
        const place = local ?? ftp;
        if (place && current && !pane.search && !busy && !pane.loading) {
          setRowRename({ side: active, place, name: current.name });
        }
        break;
      }
      case "newFile": {
        if (local && !pane.search && !busy && !pane.loading) {
          setModal({ kind: "newFile", path: local.path, name: "" });
        }
        break;
      }
      case "delete":
      case "recycle": {
        const writable = local ?? ftp ?? (archive?.writable ? archive : undefined);
        if (writable && !pane.search && current && !busy && !pane.loading) {
          const marked = entries[active].filter(({ name }) => pane.marked.includes(name));
          const selected = marked.length ? marked : [current];
          setModal({
            kind: ftp || archive ? "delete" : command, path: placePath(writable), ftp, archive,
            names: selected.map(({ name }) => name),
            directories: ftp ? selected.filter((entry) => entry.directory && !entry.link).map(({ name }) => name) : undefined,
          });
        }
        break;
      }
      case "cancelMeasure":
        if (commandLine) { setCommandLine(""); historyIndex.current = -1; }
        else if (pane.search && !panelsHidden) closeResults(active);
        else cancelScan(active);
        break;
      case "view":
      case "edit": {
        if (command === "view" && measureEntries.length) {
          measure();
          break;
        }
        const file = fileFor(active);
        if (file && (command === "view" || writableTextPlace(file.place))) openDocument(file, command === "edit");
        break;
      }
      case "compare": {
        const marked = entries[active].filter((entry) => pane.marked.includes(entry.name)).flatMap((entry) => {
          const file = fileFor(active, entry);
          return file ? [file] : [];
        });
        const left = marked.length === 2 ? marked[0] : fileFor("left");
        const right = marked.length === 2 ? marked[1] : fileFor("right");
        if (left && right) setModal({ kind: "compare", left, right });
        else setStatus({ text: "Choose a text file in each pane to compare.", error: true });
        break;
      }
    }
  }

  function keyDown(event: KeyboardEvent) {
    if ((event.target as HTMLElement).closest(".inline-rename")) return;
    if (modal || event.defaultPrevented || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    if (target.closest("dialog[open]")) return;
    const shortcut = eventShortcut(event);
    // Use the physical letter for these defaults when the keyboard layout changes.
    const physical = /^Key[A-Z]$/.test(event.code) && !event.getModifierState("AltGraph")
      ? eventShortcut(event, event.code.slice(3)) : "";
    const command = commandNames.find((command) => shortcut && commandScope(command) === "main" &&
      preferences.shortcuts[command] === shortcut) ?? (["settings", "hidden", "attributes"] as const).find((command) =>
      commands[command].key === physical && preferences.shortcuts[command] === physical) ??
      physicalFolderBinding(event.nativeEvent, preferences.shortcuts);
    if (target.closest(".terminal-card")) return;
    if (command === "settings") {
      event.preventDefault();
      if (!event.repeat) perform(command);
      return;
    }
    if (activeDocument !== null) return;
    const inCommandLine = target === commandInput.current;
    const onFiles = target.closest(".file-list");
    const inField = target.closest("input, select, textarea, [contenteditable]");
    if (!command || command === "quickSearch") {
      const unavailable = processPanels[active] ? target !== onFiles || !onFiles?.classList.contains("process-table") : !pane.place;
      if (panelsHidden || unavailable || (inField && !inCommandLine)) return;
      const seed = quickSearchSeed(event.nativeEvent, preferences.shortcuts.quickSearch);
      if (seed === null) return;
      event.preventDefault();
      document.getElementById(active + "-pane")?.dispatchEvent(new CustomEvent("dirlume-quick-search", { detail: seed }));
      return;
    }
    if (inField && (command === "copyClipboard" || command === "pasteClipboard")) return;
    if (command === "attributes" && (!onFiles || inField || panelsHidden || processPanels[active])) return;
    if (isRangeCommand(command) && (!onFiles || processPanels[active])) return;
    const fileNavigation = command in rowCommands || command === "open";
    const fileKey = /^F\d{1,2}$/.test(event.key);
    if (inField && !fileKey && command !== "terminal" &&
        (!inCommandLine || (fileNavigation && (commandLine || panelsHidden)))) return;
    if ((fileNavigation || command === "switchPane" || command === "mark") && !onFiles && !inCommandLine) return;
    if (panelsHidden && (fileNavigation || ["mark", "copy", "move", "recycle", "delete"].includes(command))) return;
    event.preventDefault();
    if ((!["hidden", "attributes", "addFolderShortcut", "folderShortcuts"].includes(command) && !folderGroupCommand(command)) || !event.repeat) {
      perform(command);
    }
  }

  function keyLabel(command: Command) {
    return showShortcut(preferences.shortcuts[command]);
  }

  const currentFile = fileFor(active);
  const fileActions = ([
    { command: "view", label: measureEntries.length ? "Measure" : "View", Icon: measureEntries.length ? Calculator : Eye,
      disabled: !fileFor(active) && !measureEntries.length },
    { command: "edit", label: "Edit", Icon: Pencil, disabled: !currentFile || !writableTextPlace(currentFile.place) },
    { command: "copy", label: local || ftp || archive ? "Copy" : "Download", Icon: local || ftp || archive ? Copy : ArrowDownToLine, disabled: !canTransfer || busy },
    { command: "move", label: ftp ? "Rename" : "Move", Icon: ArrowLeftRight, disabled: (!local && !ftp) || !!pane.search || !canTransfer || busy },
    { command: "rename", label: "Rename", Icon: TextCursorInput, disabled: (!local && !ftp) || !!pane.search || !current || busy },
    { command: "newFile", label: "New file", Icon: FilePlus, disabled: !local || !!pane.search || busy },
    { command: "mkdir", label: "New folder", Icon: FolderPlus, disabled: !local || !!pane.search || busy },
    { command: "recycle", label: ftp || archive ? "Delete" : "Trash", Icon: Trash2, disabled: (!local && !ftp && !archive?.writable) || !!pane.search || !current || busy },
    { command: "compare", label: "Compare", Icon: FileDiff, disabled: !pane.place || pane.place.kind === "kswitcher" },
    { command: "mark", label: "Mark", Icon: CheckSquare, disabled: !current },
  ] as const).filter(({ command }) => !ftp || command !== "rename");
  const panesAvailable = !panelsHidden && activeDocument === null;
  const filesAvailable = panesAvailable && !processPanels[active] && !pane.loading;

  function menuCommand(command: Command, disabled = false, label: string = commands[command].label) {
    return { label, disabled, shortcut: keyLabel(command), run: () => perform(command) };
  }

  function paneMenu(side: Side): MenuGroup {
    const target = panes[side];
    const available = panesAvailable && !target.loading;
    function inPane(command: "back" | "forward" | "parent" | "refresh", disabled: boolean) {
      return {
        ...menuCommand(command, !available || disabled),
        run: () => {
          focus(side);
          if (command === "parent") parent(side);
          else if (command === "refresh") refresh(side);
          else history(side, command === "back" ? -1 : 1);
        },
      };
    }
    return {
      label: side === "left" ? "Left" : "Right",
      items: [
        menuCommand(side === "left" ? "leftLocations" : "rightLocations", activeDocument !== null, "Sources"),
        inPane("back", !processPanels[side] && !target.search && target.position <= 0),
        inPane("forward", !processPanels[side] && target.position >= target.history.length - 1),
        inPane("parent", !processPanels[side] && !target.search && (!target.place || !parentPlace(target.place))),
        inPane("refresh", !!processPanels[side] || !target.place),
      ],
    };
  }

  const menuGroups: MenuGroup[] = [
    paneMenu("left"),
    { label: "Files", items: [
      ...fileActions.map(({ command, label, disabled }) => menuCommand(command, !filesAvailable || disabled, label)),
      menuCommand("createArchive", !filesAvailable || !local || !current || !!pane.search, "Create archive"),
      menuCommand("attributes", !filesAvailable || !currentItem || busy),
      ...(windowsClient ? [menuCommand("lockingProcesses", !filesAvailable || currentItem?.place.kind !== "local" || busy)] : []),
      menuCommand("copyClipboard", !filesAvailable || currentItem?.place.kind !== "local"),
      menuCommand("pasteClipboard", !filesAvailable || !local || !!pane.search),
      ...(ftp || archive ? [] : [menuCommand("delete", !filesAvailable || !local || !!pane.search || !current || busy)]),
    ] },
    { label: "Commands", items: [
      menuCommand("search", !filesAvailable || !pane.place),
      menuCommand("connect", activeDocument !== null, "Connect"),
      menuCommand("swap", !panesAvailable || panes.left.loading || panes.right.loading || busy),
      menuCommand("commandHistory", activeDocument !== null),
      menuCommand("folderShortcuts", !panesAvailable),
      { label: "Toggle terminal", disabled: activeDocument !== null, run: toggleTerminal },
      ...(isTauri() ? [{ label: "MCP server", run: () => setModal({ kind: "mcp" }) }] : []),
      ...(isTauri() ? [{ label: "Check for updates", run: () => { void checkUpdates(true); } }] : []),
    ] },
    { label: "Options", items: [menuCommand("settings"), menuCommand("hidden")] },
    paneMenu("right"),
    { label: "Help", items: [menuCommand("help"), { label: "About", run: () => setModal({ kind: "about" }) }] },
  ];

  return (
    <div className={`app${terminal ? " has-terminal" : ""}${panelsHidden ? " panels-hidden" : ""}${activeDocument !== null ? " document-active" : ""}`}
      onKeyDown={keyDown} onKeyDownCapture={documentKeys}>
      <header className="topbar">
        <div className="brand"><span className="brand-icon"><FolderTree /></span><h1>Dirlume</h1></div>
        <MainMenu ref={mainMenu} groups={menuGroups} shortcut={keyLabel("menu")} />
        <div className="top-actions">
          <Button className="toolbar-button" shortcut={keyLabel("connect")} onClick={() => perform("connect")}><Server /> {t("Connect")}</Button>
          <Button className="icon-button" aria-label={t("Find files")} shortcut={keyLabel("search")} disabled={activeDocument !== null || !!processPanels[active] || !pane.place || pane.loading}
            onClick={() => perform("search")}><Search /></Button>
          <span className="separator" />
          <Button className="icon-button" aria-label={t("Swap panes")} shortcut={keyLabel("swap")} onClick={() => perform("swap")}><ArrowLeftRight /></Button>
          <Button className="icon-button" aria-label={t("Show hidden files")} aria-pressed={preferences.hidden}
            shortcut={keyLabel("hidden")} onClick={() => perform("hidden")}>{preferences.hidden ? <Eye /> : <EyeOff />}</Button>
          <Button className="icon-button" aria-label={t("Toggle terminal")} aria-pressed={terminal !== null}
            onClick={toggleTerminal}><TerminalIcon /></Button>
          <Button className="icon-button" aria-label={t("Options")} shortcut={keyLabel("settings")} onClick={() => perform("settings")}><Settings2 /></Button>
        </div>
      </header>
      <main className="workspace" hidden={panelsHidden}
        style={{ "--left-pane-width": `${split}fr`, "--right-pane-width": `${100 - split}fr` } as CSSProperties}>
        {(["left", "right"] as const).map((side) => (
          <Pane key={side} side={side} active={active === side} showHidden={preferences.hidden}
            pane={panes[side]} entries={entries[side]} locations={locations}
            rename={rowRename?.side === side && sameRenameLocation(panes[side].place, rowRename.place) && !panes[side].search
              ? { name: rowRename.name, onCancel: () => closeRowRename(side), onSave: (name) => submitRowRename(rowRename, name) } : undefined}
            activate={() => setActive(side)} onRow={(entry, range, mark) => selectRow(side, entry, range, mark)}
            onQuickMatch={(name) => updatePane(side, (pane) => pane.selected === name ? pane : { ...pane, selected: name, keyboardRange: undefined })}
            onOpen={(entry) => open(side, entry)} onPath={(path) => {
              const place = panes[side].place;
              showProcesses(side, false);
              if (place?.kind === "ftp") {
                if (!path.startsWith("/")) {
                  setStatus({ text: "Enter an absolute FTP path starting with /.", error: true });
                  return;
                }
                void load(side, { ...place, segments: path.split("/").filter(Boolean) });
              } else void load(side, localPath(path));
            }}
            onHistory={(offset) => history(side, offset)} onParent={() => parent(side)} onRefresh={() => refresh(side)}
            onCloseResults={() => closeResults(side)}
            onStartDrag={(entry, data) => startDrag(side, entry, data)} onEndDrag={() => { drag.current = null; }}
            canDrop={(data) => canDrop(side, data)} onDrop={() => drop(side)}
            processView={processPanels[side]} onProcesses={(visible) => showProcesses(side, visible)}
            onContext={(entry) => contextActions(side, entry)}
            onRevealResult={(entry) => {
              const item = paneItem(panes[side], entry);
              if (item) revealResult(side, item.place, item.entry.name);
            }}
            onFilter={(filter) => updatePane(side, (pane) => ({ ...pane, filter, keyboardRange: undefined }))} onSort={(column) => sort(side, column)}
            onRemote={() => setModal({ kind: "connect", side })} onFtp={() => setModal({ kind: "ftp", side })}
            ftpShortcut={preferences.shortcuts.ftpSources} zoomShortcut={preferences.shortcuts.zoomFont}
            fontSize={preferences.viewFontSizes[side]} onZoom={zoomViewFont} />
        ))}
        <SplitDivider label={t("Pane divider")} className="pane-divider" value={split} onResize={setSplit} />
      </main>
      <div className="document-workspace" hidden={activeDocument === null}>
        {documents.map(({ id, file, editing }) => (
          <TextWindow key={JSON.stringify([id, placePath(file.place), file.name])}
            file={file} editing={editing} active={activeDocument === id} theme={theme}
            saveShortcut={preferences.shortcuts.saveText} alternateSaveShortcut={preferences.shortcuts.saveTextAlternate}
            closeShortcut={preferences.shortcuts.closeText} cancelShortcut={preferences.shortcuts.cancelText}
            hexShortcut={preferences.shortcuts.viewAsHex} zoomShortcut={preferences.shortcuts.zoomFont}
            fontSizes={preferences.viewFontSizes} onZoom={zoomViewFont}
            anchor={linkedAnchor?.id === id ? linkedAnchor.anchor : null}
            onOpenDocument={(target, newTab, anchor) => openDocument(target, false, anchor, newTab || editing ? undefined : id)}
            onDirtyChange={(dirty) => {
              if (dirty) dirtyDocuments.current.add(id);
              else dirtyDocuments.current.delete(id);
            }}
            onSaved={() => { refresh("left"); refresh("right"); }} onClose={() => closeDocument(id)} />
        ))}
      </div>
      {terminal && (
        <Suspense fallback={<div className="terminal-card pane-empty">{t("Opening terminal…")}</div>}>
          <TerminalPanel key={terminal.id} session={terminal} directory={processPanels[active] ? null : local?.path ?? null}
            theme={theme} scheme={scheme} shortcut={preferences.shortcuts.terminal} historyShortcut={preferences.shortcuts.commandHistory}
            watchEnvironment={preferences.refreshEnvironment}
            pendingCommands={pendingCommands} onCommandsQueued={(count) => setPendingCommands((commands) => commands.slice(count))}
            onCommandSubmitted={recordCommand}
            onShortcut={() => perform("terminal")} onHistory={() => setModal({ kind: "commandHistory" })} onClose={closeTerminal} />
        </Suspense>
      )}
      <form className="command-bar" onSubmit={submitCommand}>
        <Button type="button" className="toolbar-button" aria-pressed={terminal !== null} onClick={toggleTerminal}>
          <TerminalIcon /> {t("Terminal")}
        </Button>
        <span title={pane.place ? placePath(pane.place) : undefined}>{pane.place ? placePath(pane.place) : ""}</span>
        <CommandField input={commandInput} draft={commandLine} directory={processPanels[active] ? null : local?.path ?? null}
          history={commandTexts} refreshEnvironment={terminal?.refreshEnvironment ?? preferences.refreshEnvironment}
          onChange={(draft) => { historyIndex.current = -1; setCommandLine(draft); }} />
      </form>
      <nav className="actionbar" aria-label={t("File actions")}>
        {processPanels[active] ? <Button type="button" onClick={() => showProcesses(active, false)}>{t("Back to files")}</Button> :
          fileActions.map(({ command, label, Icon, disabled }) => (
          <Button key={command} disabled={disabled} onClick={() => perform(command)} shortcut={keyLabel(command)}>
            <Icon /><span>{t(label)}</span>{keyLabel(command) && <kbd>{keyLabel(command)}</kbd>}
          </Button>
        ))}
      </nav>
      <nav className="document-bar" aria-label={t("Open documents")} aria-hidden={!documents.length}>
        {documents.length > 0 && <>
          <Button type="button" aria-pressed={activeDocument === null} onClick={() => selectDocument(null)}><FolderTree /> {t("Files")}</Button>
          {documents.map(({ id, file, editing }) => (
            <Button key={id} type="button" aria-label={t(editing ? "Edit {0}" : "View {0}", file.name)}
              title={placePath(file.place)} aria-pressed={activeDocument === id} onClick={() => selectDocument(id)}>
              {editing ? <Pencil /> : <Eye />}<span>{file.name}</span>
            </Button>
          ))}
        </>}
      </nav>
      <footer className={`statusbar${status.error ? " danger" : ""}`}>
        <span role={status.error ? "alert" : "status"} title={errorText(status.text)}>
          {errorText(status.text)}
        </span>
        <span>{pane.place?.kind === "archive" ? t(pane.place.address) :
          pane.place && pane.place.kind !== "local" ? pane.place.address : t("Local file system")}</span>
      </footer>
      {modal?.kind === "settings" && <Settings preferences={preferences} onChange={(next) => {
        setLanguage(next.language);
        setPreferences(next);
      }} onClose={() => setModal(null)} />}
      {modal?.kind === "exit" && (
        <Dialog title={t("Unsaved changes")} onClose={() => setModal(modal.update ? { kind: "update", update: modal.update } : null)}>
          <div className="dialog-body"><p>{t(modal.update ? "Some editors have unsaved changes. Discard them and install the update?" :
            "Some editors have unsaved changes. Discard them and exit Dirlume?")}</p></div>
          <footer className="dialog-footer">
            <Button type="button" data-initial-focus onClick={() => setModal(null)}>{t("Keep working")}</Button>
            <Button type="button" className="negative" onClick={() => {
              if (modal.update) { installUpdate(modal.update); return; }
              exitConfirmed.current = true;
              void getCurrentWindow().close().catch((error: unknown) => {
                exitConfirmed.current = false;
                setModal(null);
                setStatus({ text: describeError(error), error: true });
              });
            }}>{t(modal.update ? "Discard changes and update" : "Discard changes and exit")}</Button>
          </footer>
        </Dialog>
      )}
      {modal?.kind === "update" && (
        <Dialog title={t("Update available")} onClose={() => setModal(null)}>
          <div className="dialog-body transfer-body">
            <p>{t("Dirlume {0} is available.", modal.update.version)}</p>
            {modal.update.kind === "debian" && <>
              <p>{t("Download the Debian package and run this command in the download folder.")}</p>
              <code>sudo apt install ./{modal.update.url.split("/").at(-1)}</code>
            </>}
          </div>
          <footer className="dialog-footer">
            <Button type="button" data-initial-focus onClick={() => setModal(null)}>{t("Later")}</Button>
            <Button type="button" className="primary" onClick={() => {
              if (modal.update.kind === "install" && dirtyDocuments.current.size) setModal({ kind: "exit", update: modal.update });
              else installUpdate(modal.update);
            }}>{t(modal.update.kind === "debian" ? "Download Debian package" : "Install and restart")}</Button>
          </footer>
        </Dialog>
      )}
      {modal?.kind === "installUpdate" && (
        <Dialog title={t("Installing update")}>
          <div className="dialog-body transfer-body">
            <p>{t("Downloading and verifying Dirlume {0}…", modal.version)}</p>
            <progress aria-label={t("Update download progress")} max={updateProgress?.total || 1}
              value={updateProgress?.total ? updateProgress.downloaded : undefined} />
            {updateProgress && <p>{t("{0} transferred", formatSize(updateProgress.downloaded))}</p>}
          </div>
        </Dialog>
      )}
      {modal?.kind === "transfer" && (
        <TransferDialog transfer={modal.transfer} showHidden={preferences.hidden} onClose={() => setModal(null)}
          onFinished={() => { refresh("left"); refresh("right"); }} />
      )}
      {modal?.kind === "search" && (
        <SearchDialog root={modal.place} showHidden={preferences.hidden} onClose={() => setModal(null)}
          onReveal={(directory, name) => revealResult(modal.side, directory, name)}
          onShowResults={(mask, matches, incomplete, selected) => {
            const { side } = modal;
            cancelScan(side);
            selectionAnchor.current[side] = null;
            updatePane(side, (pane) => showSearchResults(pane, mask, matches, incomplete, selected));
            setModal(null);
            setPanelsHidden(false);
            setActive(side);
            requestAnimationFrame(() => focus(side));
          }} />
      )}
      {modal?.kind === "about" && <AboutDialog onClose={() => setModal(null)} />}
      {modal?.kind === "mcp" && <McpDialog onClose={() => setModal(null)} />}
      {modal?.kind === "commandHistory" && <CommandHistory commands={historyItems} onClose={() => setModal(null)}
        onChoose={(line) => { historyIndex.current = -1; setCommandLine(line); setModal(null); requestAnimationFrame(() => commandInput.current?.focus()); }} />}
      {modal?.kind === "fileActions" && (
        <Dialog title={t("File actions")} onClose={() => setModal(null)}>
          <div className="dialog-body command-menu">
            {modal.entry && <Button type="button" disabled={paneItem(panes[modal.side], modal.entry)?.place.kind !== "local"}
              onClick={() => { setModal(null); void copyClipboard(modal.side, modal.entry); }}>{t("Copy files to clipboard")}</Button>}
            {windowsClient && modal.entry && paneItem(panes[modal.side], modal.entry)?.place.kind === "local" &&
              <Button type="button" onClick={() => {
                setModal(null);
                showLockingProcesses(modal.side, paneItem(panes[modal.side], modal.entry));
              }}>{t("Find locking processes")}</Button>}
            <Button type="button" disabled={panes[modal.side].place?.kind !== "local" || Boolean(panes[modal.side].search)}
              onClick={() => { setModal(null); void pasteClipboard(modal.side); }}>{t("Paste files")}</Button>
          </div>
          <footer className="dialog-footer"><Button type="button" onClick={() => setModal(null)}>{t("Close")}</Button></footer>
        </Dialog>
      )}
      {modal?.kind === "connect" && (
        <ConnectDialog provider={preferences.provider} directory={preferences.kswitcher} onOptions={() => setModal({ kind: "settings" })}
          onConnect={(place, listing) => { routeRemote(modal.side, place, listing); setModal(null); }}
          onClose={() => setModal(null)} />
      )}
      {modal?.kind === "attributes" && <AttributesDialog item={modal.item} onClose={() => setModal(null)}
        onApplied={() => { refresh("left"); refresh("right"); }} />}
      {modal?.kind === "folderShortcuts" && <FolderShortcutsDialog screen={modal.screen} shortcuts={folderShortcuts}
        currentFolder={currentFolderShortcut(modal.side)} bridgeDirectory={preferences.kswitcher} bindings={preferences.shortcuts}
        onScreen={(screen) => setModal({ ...modal, screen })}
        onSave={(next) => { persistFolderShortcuts(next); setFolderShortcuts(next); }}
        onAssigned={(group) => setStatus({ text: t("Folder shortcut saved in group {0}.", group) })}
        onOpen={(entry) => {
          closeFolderShortcuts(modal.side);
          void openFolderShortcut(modal.side, entry);
        }}
        onClose={() => closeFolderShortcuts(modal.side)} />}
      {modal?.kind === "ftp" && (
        <FtpDialog shortcuts={preferences.shortcuts} onClose={() => setModal(null)}
          onConnect={(place, listing) => {
            routeRemote(modal.side, place, listing);
            setModal(null);
            requestAnimationFrame(() => focus(modal.side));
          }} />
      )}
      {modal?.kind === "compare" && <CompareDialog left={modal.left} right={modal.right}
        previousShortcut={preferences.shortcuts.previousChange} nextShortcut={preferences.shortcuts.nextChange} onClose={() => setModal(null)} />}
      {modal?.kind === "mkdir" && <NewFolderDialog directory={modal.place.path} showHidden={preferences.hidden}
        historyShortcut={preferences.shortcuts.folderNameHistory} onClose={() => setModal(null)}
        onCreated={async (name) => {
          await load(modal.side, modal.place, "refresh", name);
          refresh(opposite(modal.side));
        }} />}
      {modal?.kind === "createArchive" && <ArchiveDialog directory={modal.directory} names={modal.names}
        showHidden={preferences.hidden} onClose={() => setModal(null)} onCreated={() => { refresh("left"); refresh("right"); }} />}
      {modal?.kind === "archivePassword" && <ArchivePasswordDialog onClose={() => setModal(null)}
        onOpen={async (password) => { await openArchive(modal.side, modal.path, password); setModal(null); }} />}
      {(modal?.kind === "rename" || modal?.kind === "newFile" || modal?.kind === "recycle" || modal?.kind === "delete") && (
        <FileDialog modal={modal} onClose={() => setModal(null)}
          hasNonemptyFolders={modal.ftp && "names" in modal ? async () => {
            const ftp = modal.ftp!;
            for (const name of modal.directories ?? []) {
              const listing = await api.listFtp(ftp.id, [...ftp.segments, name]);
              if (listing.entries.length || listing.omitted) return true;
            }
            return false;
          } : undefined}
          onSubmit={async (operation, recursive) => {
          const ftp = modal.ftp;
          if ("names" in modal && modal.archive) {
            const archive = modal.archive;
            await api.deleteArchiveEntries(archive.id, modal.names.map((name) => [...archive.segments, name]));
            refresh("left");
            refresh("right");
          } else if ("names" in modal) {
            try {
              await batch(modal.names, (name) => ftp
                ? api.deleteFtp(ftp.id, [...ftp.segments, name], recursive && (modal.directories?.includes(name) ?? false))
                : api.operate(modal.path, { kind: modal.kind, name }));
            } finally {
              refresh("left");
              refresh("right");
            }
          } else if (operation) {
            if (operation.kind === "rename") await renameItem(ftp ?? localPath(modal.path), operation.name, operation.new_name);
            else await api.operate(modal.path, operation);
            refresh("left");
            refresh("right");
            if (modal.kind === "newFile") {
              openDocument({ place: { kind: "local", path: modal.path, parent: null }, name: operation.name }, true);
            }
          }
          setModal(null);
        }} />
      )}
      {helpTopic && <HelpDialog initialTopic={helpTopic} language={preferences.language} onClose={() => setHelpTopic(null)} />}
      <McpRequests context={{
        active, panes, preferences, shortcuts: folderShortcuts, load, remote: routeRemote, refresh,
        selection: (side, names) => {
          updatePane(side, (pane) => ({ ...pane, marked: names, selected: names[0] ?? pane.selected, keyboardRange: undefined }));
          setActive(side);
        },
        setPreferences: (next) => { persistPreferences(next); setPreferences(next); },
        setShortcuts: (next) => { persistFolderShortcuts(next); setFolderShortcuts(next); },
      }} />
    </div>
  );
}

function CommandHistory({ commands, onChoose, onClose }: {
  commands: CommandEntry[];
  onChoose: (command: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const dateLabel = useTimestamps(commands.map(({ date }) => timestampSeconds(date)), "date");
  const groups = commandHistoryGroups(commands, query, dateLabel, t("Unknown date"));
  return (
    <Dialog title={t("Command history")} onClose={onClose}>
      <div className="dialog-body command-menu">
        <label className="field">{t("Search commands")}
          <input data-initial-focus type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        {groups.length ? groups.map(({ date, commands }, index) => <section className="command-history-group" key={date + index} aria-label={date}>
          <h3>{date}</h3>
          {commands.map((command) => <Button key={command} title={command} onClick={() => onChoose(command)}>{command}</Button>)}
        </section>) :
          <p>{t("No commands found.")}</p>}
      </div>
    </Dialog>
  );
}

function FileDialog({ modal, onClose, onSubmit, hasNonemptyFolders }: {
  modal: ActionModal;
  onClose: () => void;
  onSubmit: (operation: Operation | undefined, recursive: boolean) => Promise<void>;
  hasNonemptyFolders?: () => Promise<boolean>;
}) {
  const [name, setName] = useState(modal.kind === "rename" ? modal.name : "");
  const [encoding, setEncoding] = useState<TextEncoding>("utf8");
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [lockPaths, setLockPaths] = useState<string[] | null>(null);
  const [recursive, setRecursive] = useState(false);
  const titles = { newFile: "New file", rename: "Rename", recycle: "Move to Trash", delete: "Delete permanently" };
  const title = t(titles[modal.kind]);
  const removing = "names" in modal;
  const permanent = modal.kind === "delete";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (waiting) return;
    setWaiting(true);
    setError("");
    try {
      if (hasNonemptyFolders && !recursive && await hasNonemptyFolders()) {
        setRecursive(true);
        return;
      }
      await onSubmit(modal.kind === "newFile" ? { kind: "create_file", name, encoding } :
        modal.kind === "rename" ? { kind: "rename", name: modal.name, new_name: name } : undefined, recursive);
    } catch (error) {
      setError(describeError(error));
    } finally {
      setWaiting(false);
    }
  }

  return (
    <>
    <Dialog key={String(recursive)} title={recursive ? t("Delete FTP folder contents") : title} onClose={() => { if (!waiting) onClose(); }}>
      <form className="dialog-form" onSubmit={(event) => { void submit(event); }}>
        <div className="dialog-body">
          {removing
            ? <div className={permanent ? "permanent-delete-message" : undefined}>
              {permanent && <Trash2 aria-hidden="true" />}
              <div>
                <p>{recursive ? t("Permanently delete the selected FTP folders and all their contents?") :
                  <Message text={permanent ? "Permanently delete {0}?" : "Move {0} to Trash?"}>
                    <strong>{modal.names.length === 1 ? modal.names[0] : countText(modal.names.length, "item")}</strong>
                  </Message>}</p>
                {permanent && <p className="permanent-delete-note">{t("This action cannot be undone.")}</p>}
              </div>
            </div>
            : <label className="field">{t("Name")}
              <input data-initial-focus value={name} type="text" required onChange={(event) => setName(event.target.value)}
                onFocus={(event) => { if (modal.kind === "rename") event.currentTarget.select(); }} />
            </label>}
          {modal.kind === "newFile" && <label className="field new-file-encoding">{t("Encoding")}
            <select aria-label={t("Encoding")} value={encoding} disabled={waiting}
              onChange={(event) => setEncoding(event.target.value as TextEncoding)}>
              {Object.entries(textEncodingLabels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
            </select>
          </label>}
          {error && <p className="dialog-error" role="alert">{errorText(error)}</p>}
          {!modal.ftp && windowsClient && isPermissionError(error) && <ElevationButton directory={modal.path} />}
        </div>
        <div className="dialog-footer">
          {!modal.ftp && windowsClient && isLockError(error) && <Button type="button" onClick={() => setLockPaths(
            ("names" in modal ? modal.names : [modal.name]).filter(Boolean).map((name) => placePath(childPlace(localPath(modal.path), name))),
          )}>{t("Find locking processes")}</Button>}
          <Button type="button" data-initial-focus={removing ? true : undefined} onClick={onClose} disabled={waiting}>{t("Cancel")}</Button>
          <Button type="submit" className={permanent ? "permanent-delete-button" : removing ? "negative" : "primary"}
            disabled={waiting || (!removing && (!name || name === modal.name && modal.kind === "rename"))}>
            {waiting ? t("Working…") : recursive ? t("Delete contents") : modal.kind === "newFile" ? t("Create") : title}
          </Button>
        </div>
      </form>
    </Dialog>
    {lockPaths && <LockDialog paths={lockPaths} onClose={() => setLockPaths(null)} />}
    </>
  );
}

function ConnectDialog({ provider, directory, onConnect, onOptions, onClose }: {
  provider: "server" | "kswitcher";
  directory: string;
  onConnect: (place: RemotePlace, listing: Listing) => void;
  onOptions: () => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState("");
  const [bridge, setBridge] = useState<boolean | null>(null);
  const [peers, setPeers] = useState<KSwitcherPeer[]>([]);

  useEffect(() => {
    if (provider !== "kswitcher" || !directory) return;
    let current = true;
    api.hasKSwitcherBridge(directory).then(async (available) => {
      if (!current) return;
      setBridge(available);
      if (available) {
        const peers = await api.kswitcherPeers(directory);
        if (current) {
          setPeers(peers);
          setValue(peers[0]?.id ?? "");
        }
      }
    }).catch((error: unknown) => { if (current) setError(describeError(error)); });
    return () => { current = false; };
  }, [provider, directory]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (waiting) return;
    setWaiting(true);
    setError("");
    try {
      if (provider === "kswitcher") {
        if (bridge) {
          const peer = peers.find((peer) => peer.id === value);
          if (!peer) return;
          const listing = await api.listKSwitcher(directory, peer.id, "");
          onConnect({ kind: "kswitcher", directory, peer: peer.id, address: peer.name, path: "", parent: listing.parent }, listing);
        } else {
          await api.openKSwitcher(directory);
          onClose();
        }
      } else {
        const { id, address, listing } = await api.connect(value);
        onConnect({ kind: "server", id, address, segments: [] }, listing);
      }
    } catch (error) {
      setError(describeError(error));
    } finally {
      setWaiting(false);
    }
  }

  return (
    <Dialog title={provider === "server" ? t("Connect to Dirlume server") : t("Connect through KSwitcher")}
      onClose={() => { if (!waiting) onClose(); }}>
      <form className="dialog-form" onSubmit={(event) => { void submit(event); }}>
        <div className="dialog-body">
          {provider === "server" ? (
            <label className="field">{t("Server invitation")}
              <input data-initial-focus type="password" autoComplete="off" spellCheck={false} required
                placeholder={t("Paste the invitation from the remote machine")} value={value}
                onChange={(event) => setValue(event.target.value)} />
            </label>
          ) : bridge === true && peers.length ? (
            <label className="field">{t("Paired machine")}
              <select data-initial-focus value={value} onChange={(event) => setValue(event.target.value)}>
                {peers.map((peer) => <option key={peer.id} value={peer.id}>{peer.name}</option>)}
              </select>
            </label>
          ) : bridge === true ? (
            <p>{t("Run KSwitcher on both computers and enable file browsing for the paired machine.")}</p>
          ) : bridge === false ? (
            <p>{t("Open KSwitcher Files and select a paired machine from its source menu.")}</p>
          ) : (
            <p>{directory ? t("Looking for the KSwitcher bridge…") : t("Choose the KSwitcher installation folder in Options.")}</p>
          )}
          {error && <p className="dialog-error" role="alert">{errorText(error)}</p>}
        </div>
        <div className="dialog-footer">
          <Button type="button" onClick={onOptions} disabled={waiting}>{t("Connection options")}</Button>
          <Button type="submit" className="primary" disabled={waiting || (provider === "kswitcher" && bridge === null) || (bridge !== false && !value.trim())}>
            {waiting ? t("Connecting…") : bridge === false ? t("Open KSwitcher Files") : t("Connect")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
