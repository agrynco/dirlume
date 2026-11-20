import { Button } from "./Button";
import { WindowControls } from "./WindowControls";
import { WindowResizeMarker } from "./ResizeGrip";
import { HistoryField } from "./HistoryField";
import { SchemeOptions } from "./SchemeOptions";
import { CommandField } from "./CommandField";
import { clampSplit, SplitDivider } from "./SplitDivider";
import { timestampSeconds, useTimestamps } from "./useTimestamps";
import { commandHistoryGroups, historyLimit, readCommandHistory, saveCommandHistory, type CommandEntry } from "./commandHistory";
import { lazy, Suspense, useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import {
  ArrowDownToLine, ArrowLeftRight, CheckSquare, Copy, Eye, EyeOff, FileDiff, FilePlus, FolderPlus, FolderTree,
  Calculator, CircleHelp, Moon, Pencil, Search, Server, Settings2, Sun, Terminal as TerminalIcon, TextCursorInput, Trash2,
} from "lucide-react";
import { Channel, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { api, connectFtpLocation, describeError, folderLabel, isFileServer, isLockError, isPermissionError, placePath, smbHost, writableTextPlace, windowsClient, type ArchivePlace, type Entry, type FtpPlace, type KSwitcherPeer, type Listing, type NamedFile, type Operation, type Place, type QuickLocation, type RemotePlace, type SizeResult, type SshPlace } from "./api";
import { smbLocation, type ConnectionSource, type FileLocation, type SavedConnection, type SshHostVerification } from "./api";
import { textEncodingLabels, type AppUpdate, type TerminalCommand, type TerminalSession, type TextEncoding, type UpdateProgress } from "./api";
import { Dialog, readDialogSize } from "./Dialog";
import { reportFrontendError } from "./diagnostics";
import { AttributesDialog } from "./AttributesDialog";
import { connectionCommands, RemoveConnectionDialog, SavedConnectionDialog } from "./SavedConnectionDialog";
import { VerifyHostDialog } from "./SshDialog";
import { SmbDialog } from "./SmbDialog";
import { SudoDialog } from "./SudoDialog";
import { FileContextMenu } from "./FileContextMenu";
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
import type { FeaturePage } from "./featureOptions";
import { applyAppearance, resolveAppearance, selectAppearance, useSystemTheme } from "./appearance";
import { TextWindow, CompareDialog } from "./TextTools";
import type { MarkdownLocation, MarkdownPosition } from "./markdown";
import { TransferDialog, type Transfer } from "./TransferDialog";
import {
  applyListing, childPlace, closeSearchResults, emptyPane, filesystemPlace, formatSize, hasParentRow, localPath, opposite, paneCursorIndex, paneItem, parentPlace,
  readPlace, selectableRange, showSearchResults, SmbCredentialsRequired, toggleMarkAndMoveCursor, visibleEntries,
  type DeniedSshListing, type ListingAction, type PaneState, type Side, type SortColumn,
} from "./panes";
import { commandNames, commands, commandScope, eventShortcut, flushPortablePreferences, folderGroupCommand, persistPreferences, physicalFolderBinding,
  compactShortcut, preferenceKey, quickSearchSeed, readPreferences, shortcutBindings, showShortcut, type Command, type Preferences } from "./preferences";
import { countText, errorText, setLanguage, t } from "./i18n";
import { Message } from "./Message";
import { readWorkspace, restorePane, saveWorkspace, type DocumentWindow, type SavedFtpLocation } from "./workspace";
import { maxViewFontSize, minViewFontSize, type ZoomViewFont } from "./viewFonts";
import { shellArgument } from "./shell";

const TerminalPanel = lazy(() => import("./TerminalPanel"));
const previousTerminalHeights = [28, 28, 38, 48, 58];
const noCommands: TerminalCommand[] = [];

function waitForListing<T>(listing: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  return Promise.race([listing, new Promise<undefined>((resolve) => {
    if (signal.aborted) resolve(undefined);
    else signal.addEventListener("abort", () => resolve(undefined), { once: true });
  })]);
}

type NetworkPlace = Extract<RemotePlace, { kind: "server" | "ftp" | "ssh" }>;
type RenameLocation = Extract<Place, { kind: "local" | "ftp" }>;
type RowRename = { side: Side; place: RenameLocation; name: string };
type DocumentTab = DocumentWindow & {
  position?: MarkdownPosition;
  back?: MarkdownLocation[];
  forward?: MarkdownLocation[];
};

function sameRenameLocation(current: Place | null, place: RenameLocation) {
  return current !== null && current.kind === place.kind && placePath(current) === placePath(place) &&
    (place.kind === "local" || sameConnection(current, place));
}

type ActionModal = (
  | { kind: "rename" | "newFile"; path: string; name: string }
  | { kind: "recycle" | "delete"; path: string; names: string[]; directories?: string[] }
) & { remote?: FtpPlace | SshPlace; archive?: ArchivePlace };

type Modal =
  | { kind: "settings"; page?: FeaturePage }
  | { kind: "connect"; side: Side }
  | { kind: "smb"; side: Side; navigation: { path: string; complete: (place: Place, listing: Listing) => boolean } }
  | { kind: "connectionEditor"; side: Side; source: ConnectionSource; profile?: SavedConnection }
  | { kind: "removeConnection"; side: Side; profile: SavedConnection }
  | { kind: "verifyConnection"; side: Side; profile: SavedConnection; verification: SshHostVerification }
  | { kind: "compare"; left: NamedFile; right: NamedFile }
  | { kind: "transfer"; transfer: Transfer }
  | { kind: "search"; side: Side; place: FileLocation }
  | { kind: "mkdir"; side: Side; place: Extract<Place, { kind: "local" }> }
  | { kind: "createArchive"; side: Side; directory: string; names: string[] }
  | { kind: "archivePassword"; side: Side; path: string }
  | { kind: "sudoBrowse"; side: Side; target: DeniedSshListing }
  | { kind: "attributes"; item: NonNullable<ReturnType<typeof paneItem>> }
  | { kind: "folderShortcuts"; side: Side; screen: FolderShortcutScreen }
  | { kind: "about" | "commandHistory" | "mcp" }
  | { kind: "exit"; update?: AppUpdate }
  | { kind: "update"; update: AppUpdate }
  | { kind: "upToDate" }
  | { kind: "installUpdate"; version: string }
  | ActionModal;

const rowCommands = {
  firstRow: 0, lastRow: Number.POSITIVE_INFINITY, upRow: -1, downRow: 1, pageUp: -12, pageDown: 12,
  selectUpRow: -1, selectDownRow: 1,
};

function isRangeCommand(command: Command) {
  return command === "selectUpRow" || command === "selectDownRow";
}

function isTerminalInput(target: EventTarget | null) {
  return target instanceof Element && target.closest(".terminal-surface") !== null;
}

function contextHelpTopic(modal: Modal["kind"] | undefined, target: Element | null, editing: boolean | undefined): HelpTopic {
  if (modal === "settings") return "general";
  if (modal === "search") return "search";
  if (target?.closest(".terminal-card, .command-bar")) return "terminal";
  return editing === undefined ? "files" : editing ? "editor" : "viewer";
}

function sameConnection(left: Place | null, right: Place) {
  return (left?.kind === "server" || isFileServer(left) || left?.kind === "archive") && left.kind === right.kind && left.id === right.id;
}

function disconnect(place: NetworkPlace) {
  const close = place.kind === "ssh" ? api.disconnectSsh : place.kind === "ftp" ? api.disconnectFtp : api.disconnect;
  void close(place.id).catch(() => {});
}

export default function App({ initialPreferences, portableUpdateError, portableSettingsError }: {
  initialPreferences: Preferences;
  portableUpdateError?: string | null;
  portableSettingsError?: string | null;
}) {
  const [startup] = useState(readWorkspace);
  const [ready, setReady] = useState(false);
  const [panes, setPanes] = useState(() => ({
    left: { ...restorePane(startup?.panels.left), loading: true },
    right: { ...restorePane(startup?.panels.right), loading: true },
  }));
  const visiblePanes = useRef(panes);
  visiblePanes.current = panes;
  const [rowRename, setRowRename] = useState<RowRename | null>(null);
  const [locations, setLocations] = useState<QuickLocation[]>([]);
  const [active, setActive] = useState<Side>(startup?.active === "right" ? "right" : "left");
  const [processPanels, setProcessPanels] = useState<Record<Side, { path?: string } | null>>({ left: null, right: null });
  const [preferences, setPreferences] = useState(initialPreferences);
  const { theme, scheme } = resolveAppearance(preferences, useSystemTheme());
  const followSystem = preferences.theme === "system" && preferences.activeScheme === null;
  const [modal, setModal] = useState<Modal | null>(null);
  const [fileMenu, setFileMenu] = useState<{ side: Side; x: number; y: number; entry?: Entry } | null>(null);
  const [helpTopic, setHelpTopic] = useState<HelpTopic | null>(null);
  const [updateNotice, setUpdateNotice] = useState<Extract<Modal, { kind: "update" | "upToDate" }> | null>(null);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const checkingUpdates = useRef(false);
  const manualUpdateCheck = useRef(false);
  const installingUpdate = useRef(false);
  const [documents, setDocuments] = useState<DocumentTab[]>(startup?.documents ?? []);
  const [activeDocument, setActiveDocument] = useState<number | null>(startup?.activeDocument ?? null);
  const documentMenu = useRef<MainMenuHandle>(null);
  const nextDocument = useRef(Math.max(0, ...(startup?.documents ?? []).map(({ id }) => id)));
  const dirtyDocuments = useRef(new Set<number>());
  const exitConfirmed = useRef(false);
  const busy = modal?.kind === "transfer";
  const [terminals, setTerminals] = useState<Record<string, TerminalSession>>({});
  const [terminalShare, setTerminalShare] = useState(0);
  const [terminalHeight, setTerminalHeight] = useState(() => {
    const height = startup?.terminalHeight;
    if (typeof height === "number" && Number.isFinite(height) && height > 0 && height < 100) return height;
    return previousTerminalHeights[startup?.terminalHeightStep ?? 1] ?? 28;
  });
  const terminalRowHeight = useRef(0);
  const terminalFocus = useRef<number | null>(null);
  const terminalDrag = useRef<{ y: number; height: number; available: number; minimum: number; maximum: number } | null>(null);
  const [panelsHidden, setPanelsHidden] = useState(false);
  const terminalVisible = panelsHidden || terminalShare > 0;
  const [split, setSplit] = useState(Number.isFinite(startup?.split) ? clampSplit(startup!.split) : 50);
  const [commandLine, setCommandLine] = useState("");
  const [pendingCommands, setPendingCommands] = useState<Record<number, TerminalCommand[]>>({});
  const commandInput = useRef<HTMLTextAreaElement>(null);
  const [historyItems, setHistoryItems] = useState(readCommandHistory);
  const commandTexts = useMemo(() => historyItems.map(({ text }) => text), [historyItems]);
  const historyIndex = useRef(-1);
  const selectionAnchor = useRef<{ left: string | null; right: string | null }>({ left: null, right: null });
  const startupError = portableUpdateError ?? portableSettingsError;
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: startupError ?? "Ready", error: !!startupError });
  const [folderShortcuts, setFolderShortcuts] = useState(readFolderShortcuts);
  const request = useRef({ left: 0, right: 0 });
  const pendingListings = useRef<Partial<Record<Side, AbortController>>>({});
  const nextSession = useRef(0);
  const watchId = useRef(0);
  const measureId = useRef(0);
  const scans = useRef<{ left: number | null; right: number | null }>({ left: null, right: null });
  const drag = useRef<{ side: Side; source: Transfer["source"]; items: Transfer["items"]; pointer: number; x: number; y: number; moving: boolean } | null>(null);
  const [dropTarget, setDropTarget] = useState<Side | null>(null);
  const latest = useRef(panes);
  const mainMenu = useRef<MainMenuHandle>(null);
  latest.current = panes;
  const connected = useRef<Record<Side, NetworkPlace | null>>({ left: null, right: null });
  const failedFtp = useRef<Partial<Record<Side, SavedFtpLocation>>>({});
  const activeModal = useRef(modal);
  activeModal.current = modal;
  const pane = panes[active];
  const catalog = pane.place?.kind === "connections" ? pane.place : null;
  const other = panes[opposite(active)];
  const canSwapPanes = !panes.left.loading && !panes.right.loading && !busy;
  const entries = useMemo(() => ({
    left: visibleEntries(panes.left, preferences.hidden),
    right: visibleEntries(panes.right, preferences.hidden),
  }), [panes, preferences.hidden]);
  const currentRow = entries[active][paneCursorIndex(pane, entries[active])];
  const current = currentRow?.name === ".." ? undefined : currentRow;
  const currentItem = paneItem(pane, current);
  const local = pane.place?.kind === "local" ? pane.place : null;
  const terminalPlace = pane.place?.kind === "ssh" ? pane.place : local;
  const terminalKey = terminalPlace ? terminalPlace.kind === "ssh" ? "ssh:" + terminalPlace.id : "local" : null;
  const terminal = terminalKey ? terminals[terminalKey] : undefined;
  const ftp = pane.place?.kind === "ftp" ? pane.place : undefined;
  const archive = pane.place?.kind === "archive" ? pane.place : undefined;
  const fileServer = isFileServer(pane.place) ? pane.place : undefined;
  const permanentDelete = Boolean(fileServer || smbHost(local));
  const otherFileServer = !other.search && isFileServer(other.place);
  const canTransfer = Boolean(currentItem);
  const shortcuts = shortcutBindings(preferences);
  const helpShortcut = shortcuts.help;
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
      const update = await api.checkForUpdate();
      if (update) setUpdateNotice({ kind: "update", update });
      else if (manualUpdateCheck.current) setUpdateNotice({ kind: "upToDate" });
      if (manualUpdateCheck.current) setStatus({ text: "Ready" });
    } catch (error) {
      if (manualUpdateCheck.current) setStatus({ text: describeError(error), error: true });
    } finally {
      checkingUpdates.current = false;
      manualUpdateCheck.current = false;
    }
  }, []);

  useEffect(() => {
    if (isTauri() && !portableUpdateError) void checkUpdates(false);
  }, [checkUpdates, portableUpdateError]);

  useEffect(() => {
    if (!updateNotice || modal || helpTopic) return;
    setModal(updateNotice);
    setUpdateNotice(null);
  }, [updateNotice, modal, helpTopic]);

  useLayoutEffect(() => {
    if (!helpShortcut.length) return;
    function openHelp(event: WindowEventMap["keydown"]) {
      if (event.defaultPrevented || event.isComposing || !helpShortcut.includes(eventShortcut(event))) return;
      const target = event.target instanceof Element ? event.target : null;
      if (isTerminalInput(target) || target?.closest("[data-shortcut-capture]")) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const topic = contextHelpTopic(modalKind, target, editingDocument);
      setHelpTopic((current) => current ?? topic);
    }
    document.addEventListener("keydown", openHelp, true);
    return () => document.removeEventListener("keydown", openHelp, true);
  }, [helpShortcut, modalKind, editingDocument]);

  useEffect(() => {
    if (!shortcuts.menuAlternate.includes("Alt")) return;
    let singleAlt = false;
    function down(event: globalThis.KeyboardEvent) {
      if (event.target instanceof Element && event.target.closest(".terminal-card")) { singleAlt = false; return; }
      if (event.repeat && event.key === "Alt") return;
      singleAlt = event.key === "Alt" && !event.ctrlKey && !event.shiftKey && !event.metaKey && !event.isComposing && !modal && !helpTopic;
      if (singleAlt) event.preventDefault();
    }
    function up(event: globalThis.KeyboardEvent) {
      if (event.key !== "Alt" || !singleAlt) return;
      singleAlt = false;
      event.preventDefault();
      (documentMenu.current ?? mainMenu.current)?.open();
    }
    const reset = () => { singleAlt = false; };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", reset);
    window.addEventListener("pointerdown", reset, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", reset);
      window.removeEventListener("pointerdown", reset, true);
    };
  }, [shortcuts.menuAlternate, modal, helpTopic]);

  const updatePane = useCallback((side: Side, updater: (pane: PaneState) => PaneState) => {
    setPanes((previous) => ({ ...previous, [side]: updater(previous[side]) }));
  }, []);

  const cancelScan = useCallback((side: Side) => {
    const previous = scans.current[side];
    if (previous === null) return false;
    scans.current[side] = null;
    void api.cancelMeasurement(previous).catch(() => {});
    updatePane(side, (pane) => ({ ...pane, measuring: [] }));
    return true;
  }, [updatePane]);

  const invalidateListing = useCallback((side: Side) => {
    ++request.current[side];
    pendingListings.current[side]?.abort();
    delete pendingListings.current[side];
    return request.current[side];
  }, []);

  const beginListing = useCallback((side: Side) => {
    const ticket = invalidateListing(side);
    const controller = new AbortController();
    pendingListings.current[side] = controller;
    return { ticket, signal: controller.signal };
  }, [invalidateListing]);

  function cancelLoading(side: Side) {
    if (!latest.current[side].loading) return false;
    const addressRevision = invalidateListing(side);
    updatePane(side, (pane) => ({ ...pane, loading: false, loadingPath: undefined, addressRevision }));
    return true;
  }

  function cancelFolderOperation(side: Side) {
    const cancelledLoading = cancelLoading(side);
    const cancelledMeasurement = cancelScan(side);
    return cancelledLoading || cancelledMeasurement;
  }

  const load = useCallback(async (side: Side, place: Place, action: ListingAction | "background" = "push", reveal?: string, sudoPassword?: string) => {
    const background = action === "background";
    const elevated = sudoPassword !== undefined;
    const dialog = activeModal.current;
    if (background && (pendingListings.current[side] || latest.current[side].sudoListing ||
        (dialog?.kind === "smb" && dialog.side === side && dialog.navigation))) return false;
    if (action !== "refresh" && !background) cancelScan(side);
    const { ticket, signal } = beginListing(side);
    if (!background) updatePane(side, (pane) => ({
      ...pane, loading: true, loadingPath: placePath(place), error: "", elevationPath: undefined,
      deniedSshListing: elevated ? pane.deniedSshListing : undefined,
    }));
    const complete = (openedPlace: Place, openedListing: Listing, sudoListing?: boolean) => {
      if (ticket !== request.current[side]) return false;
      if (action === "push" || typeof action === "number") delete failedFtp.current[side];
      const found = reveal === ".." ? hasParentRow(openedPlace) :
        reveal !== undefined && openedListing.entries.some((entry) => entry.name === reveal);
      if (reveal !== undefined && reveal !== ".." && !found) setStatus({ text: t("File no longer found: {0}", reveal), error: true });
      updatePane(side, (pane) => {
        const listing = { ...applyListing(pane, openedPlace, openedListing, action), sudoListing };
        if (background) Object.assign(listing, { error: pane.error, elevationPath: pane.elevationPath, deniedSshListing: pane.deniedSshListing });
        return found && reveal !== undefined ? { ...listing, selected: reveal, filter: "", marked: [] } : listing;
      });
      return true;
    };
    try {
      const result = await waitForListing(readPlace(place, sudoPassword, !background), signal);
      return result ? complete(result.place, result.listing, result.elevated) : false;
    } catch (error) {
      if (ticket === request.current[side]) {
        const credentialsRequired = error instanceof SmbCredentialsRequired;
        const prompt = credentialsRequired && !background && !activeModal.current && (action !== "refresh" || place.kind === "smbRoot");
        if (prompt) {
          const credentialsDialog = { kind: "smb", side, navigation: { path: placePath(place), complete } } as const;
          activeModal.current = credentialsDialog;
          setModal(credentialsDialog);
        }
        const text = credentialsRequired ? (prompt ? "" : error.message) : describeError(error);
        updatePane(side, (pane) => background && pane.error ? pane : {
          ...pane, loading: false, loadingPath: undefined, error: text,
          elevationPath: windowsClient && place.kind === "local" && isPermissionError(text) ? place.path : undefined,
          deniedSshListing: elevated ? pane.deniedSshListing : place.kind === "ssh" && isPermissionError(text)
            ? { place, action: background ? "refresh" : action, reveal } : undefined,
        });
      }
      if (elevated) throw error;
      return false;
    } finally {
      if (request.current[side] === ticket) delete pendingListings.current[side];
    }
  }, [beginListing, cancelScan, updatePane]);

  useEffect(() => {
    let cancelled = false;
    // Show the native window after React commits the controls, before restoring any listings.
    const shown = isTauri() ? getCurrentWindow().show().catch((error: unknown) => {
      reportFrontendError("show_window", error, "native_error");
    }) : Promise.resolve();
    void shown.then(() => Promise.all([api.locations(), api.requestedLocation()])).then(async ([locations, requested]) => {
      if (cancelled) return;
      setLocations(locations);
      const home = locations[0];
      const alternate = locations.find(({ label }) => label === "Downloads") ?? home;
      if (home && alternate) {
        await Promise.all(([["left", home.path], ["right", alternate.path]] as const).map(async ([side, fallback]) => {
          if (request.current[side] !== 0) return;
          const requestedFolder = side === "left" && requested ? filesystemPlace(requested) : null;
          const saved = startup?.panels[side];
          const savedFtp = !requestedFolder ? saved?.ftp : undefined;
          let failure: string | undefined;
          if (savedFtp) {
            const { ticket, signal } = beginListing(side);
            updatePane(side, (pane) => ({ ...pane, loading: true, loadingPath: "/" + savedFtp.segments.join("/") }));
            try {
              const connection = connectFtpLocation(savedFtp.profileId, savedFtp.segments).then((result) => {
                if (signal.aborted || cancelled) {
                  disconnect(result.place);
                  return;
                }
                return result;
              });
              const result = await waitForListing(connection, signal);
              if (!result) return;
              const { place, listing } = result;
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
              if (request.current[side] === ticket) delete pendingListings.current[side];
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
    }).finally(() => {
      if (cancelled) return;
      for (const side of ["left", "right"] as const) {
        if (request.current[side] === 0) updatePane(side, (pane) => ({ ...pane, loading: false }));
      }
      setReady(true);
    });
    return () => { cancelled = true; };
  }, [beginListing, load, startup, updatePane]);

  useEffect(() => {
    if (ready) saveWorkspace(panes, active, split, terminalHeight, documents, activeDocument, failedFtp.current);
  }, [ready, panes, active, split, terminalHeight, documents, activeDocument]);

  const leftPath = (ready || !panes.left.loading) && panes.left.place?.kind === "local" ? panes.left.place.path : null;
  const rightPath = (ready || !panes.right.loading) && panes.right.place?.kind === "local" ? panes.right.place.path : null;
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
        if (pendingListings.current[side]) timer = window.setTimeout(refreshWatchedFolder, 150);
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
        if (place && place.kind !== "local" && place.kind !== "connections") void load(side, place, "background");
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [leftRemote, rightRemote, load]);

  useEffect(() => {
    persistPreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    function onError(event: Event) {
      setStatus({ text: (event as CustomEvent<string>).detail, error: true });
    }
    window.addEventListener("dirlume-portable-settings-error", onError);
    return () => window.removeEventListener("dirlume-portable-settings-error", onError);
  }, []);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== preferenceKey) return;
      const next = readPreferences();
      setLanguage(next.language);
      setPreferences(next);
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

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

  useLayoutEffect(() => applyAppearance(theme, scheme), [theme, scheme]);

  const actionbar = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const bar = actionbar.current;
    if (!bar) return;
    const fitButtons = () => {
      for (const content of ["all", "text-and-shortcuts", "text-only"]) {
        bar.dataset.buttonContent = content;
        if (bar.scrollWidth <= bar.clientWidth) break;
      }
    };
    const resize = new ResizeObserver(fitButtons);
    const labels = new MutationObserver(fitButtons);
    resize.observe(bar);
    labels.observe(bar, { childList: true, characterData: true, subtree: true });
    document.fonts.addEventListener("loadingdone", fitButtons);
    fitButtons();
    return () => {
      resize.disconnect();
      labels.disconnect();
      document.fonts.removeEventListener("loadingdone", fitButtons);
    };
  }, [scheme, theme]);

  useEffect(() => {
    function preventWorkspaceSelectAll(event: globalThis.KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || (!event.ctrlKey && !event.metaKey)) return;
      const shortcut = eventShortcut(event, event.code === "KeyA" ? "a" : event.key);
      if (shortcut !== "Ctrl+A" && shortcut !== "Meta+A") return;
      const target = event.target;
      if (target instanceof Element && (target.closest("input, textarea, dialog, .document-workspace, .terminal-card") ||
          (target instanceof HTMLElement && target.isContentEditable))) return;
      event.preventDefault();
    }
    // Handle the WebView default even when a click leaves focus on the body.
    window.addEventListener("keydown", preventWorkspaceSelectAll);
    return () => window.removeEventListener("keydown", preventWorkspaceSelectAll);
  }, []);

  useEffect(() => {
    if (isTauri() && !windowsClient) {
      // On Windows the native window theme also controls WebView2's system color query.
      const nativeTheme = followSystem ? null : theme === "light" ? "light" : "dark";
      void getCurrentWindow().setTheme(nativeTheme).catch(() => {});
    }
  }, [followSystem, theme]);

  const dirtyComparisons = useRef(new Set<string>());
  const askToSaveComparison = useCallback(() => {
    if (!dirtyComparisons.current.size) return false;
    void getAllWebviewWindows().then((windows) => {
      const labels = new Set(windows.map(({ label }) => label));
      for (const label of dirtyComparisons.current) if (!labels.has(label)) dirtyComparisons.current.delete(label);
      const comparison = windows.find(({ label }) => dirtyComparisons.current.has(label));
      if (comparison) void comparison.setFocus().finally(() => comparison.close()).catch(() => {});
    }).catch(() => {});
    return true;
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    const dirtyListener = listen<{ label: string; dirty: boolean }>("dirlume:comparison-dirty", ({ payload }) => {
      if (!payload.label.startsWith("compare-")) return;
      if (payload.dirty) dirtyComparisons.current.add(payload.label);
      else dirtyComparisons.current.delete(payload.label);
    });
    const listener = getCurrentWindow().onCloseRequested((event) => {
      if (installingUpdate.current) {
        event.preventDefault();
        return;
      }
      if (askToSaveComparison()) { event.preventDefault(); return; }
      if (!exitConfirmed.current && dirtyDocuments.current.size) {
        event.preventDefault();
        setModal({ kind: "exit" });
      }
    });
    return () => {
      void listener.then((unlisten) => unlisten()).catch(() => {});
      void dirtyListener.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [askToSaveComparison]);

  function installUpdate(update: AppUpdate) {
    if (update.kind !== "install") {
      void api.openWebLink(update.url).catch((error: unknown) => setStatus({ text: describeError(error), error: true }));
      return;
    }
    if (askToSaveComparison()) return;
    installingUpdate.current = true;
    setUpdateProgress(null);
    setModal({ kind: "installUpdate", version: update.version });
    const progress = new Channel<UpdateProgress>();
    progress.onmessage = setUpdateProgress;
    void flushPortablePreferences().then(() => api.installUpdate(update.version, progress)).catch((error: unknown) => {
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
    if (id === null && !panelsHidden) requestAnimationFrame(() => focus(active));
  }

  const workspaceKeys = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (modal || helpTopic || event.defaultPrevented || event.isComposing || isTerminalInput(event.target)) return;
    if (event.target instanceof Element && event.target.closest("dialog[open]")) return;
    const shortcut = eventShortcut(event);
    const settingsMatch = shortcuts.settings.includes(shortcut) ||
      (shortcuts.settings.includes(commands.settings.key) && event.code === "KeyS" &&
        !event.getModifierState("AltGraph") && eventShortcut(event, "S") === commands.settings.key);
    if (settingsMatch) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) openSettings();
      return;
    }
    if (event.target instanceof Element && event.target.closest("[role=menu]")) return;
    if (shortcuts.cancelMeasure.includes(shortcut) && activeDocument === null &&
        !panelsHidden && cancelFolderOperation(active)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const direction = shortcuts.nextDocument.includes(shortcut) ? 1 : shortcuts.previousDocument.includes(shortcut) ? -1 : 0;
    if (shortcut && direction && documents.length) {
      event.preventDefault();
      event.stopPropagation();
      const ids = [null, ...documents.map(({ id }) => id)];
      const index = ids.indexOf(activeDocument);
      selectDocument(ids[(index + direction + ids.length) % ids.length]);
      return;
    }
    const element = event.target instanceof Element ? event.target : null;
    const noControl = !element?.closest(".app");
    if (noControl && shortcuts.attributes.includes(shortcut)) return;
    const inTitlebar = element?.closest(".topbar") && !element.closest("select, input");
    const hasModifier = event.ctrlKey || event.altKey || event.metaKey || /^F\d+$/.test(event.key);
    if ((!noControl && (!inTitlebar || !hasModifier)) ||
        !shortcut || !commandNames.some((command) => shortcuts[command].includes(shortcut))) return;
    const selector = activeDocument !== null ? ".text-window:not([hidden])" : panelsHidden ? ".terminal-card:not([hidden])" : `#${active}-files`;
    const target = document.querySelector(selector);
    if (target && !target.dispatchEvent(new globalThis.KeyboardEvent("keydown", {
      key: event.key, code: event.code, altKey: event.altKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
      repeat: event.repeat, bubbles: true, cancelable: true,
    }))) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => workspaceKeys(event);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  function openDocument(file: NamedFile, editing: boolean, position?: MarkdownPosition) {
    const existing = documents.find((item) =>
      item.editing === editing && item.file.name === file.name &&
      item.file.place.kind === file.place.kind && placePath(item.file.place) === placePath(file.place) &&
      (file.place.kind === "local" || sameConnection(item.file.place, file.place)));
    const id = existing?.id ?? ++nextDocument.current;
    if (!existing) {
      setDocuments((current) => [...current, { id, file, editing, position }]);
    } else if (position) {
      setDocuments((current) => current.map((tab) => tab.id === id ? { ...tab, position } : tab));
    }
    selectDocument(id);
  }

  function followMarkdownLink(id: number, from: NamedFile, file: NamedFile, position: MarkdownPosition, scrollTop: number) {
    setDocuments((current) => current.map((tab) => tab.id !== id || tab.file !== from ? tab : {
      ...tab, file, position, forward: [],
      back: [...(tab.back ?? []), { file: from, position: { scrollTop } }],
    }));
  }

  function navigateMarkdown(id: number, direction: "back" | "forward", scrollTop: number) {
    const opposite = direction === "back" ? "forward" : "back";
    setDocuments((current) => current.map((tab) => {
      const history = tab[direction];
      const target = history?.at(-1);
      if (tab.id !== id || !history || !target) return tab;
      return {
        ...tab, ...target,
        [direction]: history.slice(0, -1),
        [opposite]: [...(tab[opposite] ?? []), { file: tab.file, position: { scrollTop } }],
      };
    }));
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

  async function openErrorLog() {
    try {
      const path = await api.errorLog();
      if (!path) {
        setStatus({ text: "No errors have been logged yet." });
        return;
      }
      const end = Math.max(path.lastIndexOf("/"), windowsClient ? path.lastIndexOf("\\") : -1);
      openDocument({ place: { kind: "local", path: path.slice(0, end), parent: null }, name: path.slice(end + 1) }, false);
    } catch (error) {
      setStatus({ text: describeError(error), error: true });
    }
  }

  function documentKeys(event: KeyboardEvent) {
    if (modal || helpTopic || event.defaultPrevented || event.nativeEvent.isComposing) return;
    if ((event.target as HTMLElement).closest("dialog[open]")) return;
    const shortcut = eventShortcut(event);
    if (!shortcut) return;
    const resize = shortcuts.expandTerminal.includes(shortcut) ? 1 : shortcuts.collapseTerminal.includes(shortcut) ? -1 : 0;
    if (resize && activeDocument === null) {
      event.preventDefault();
      event.stopPropagation();
      resizeTerminal(resize);
      return;
    }
    if (isTerminalInput(event.target)) {
      // Only terminal layout shortcuts need to intercept keys before xterm processes them.
      const toggle = shortcuts.toggleTerminal.includes(shortcut);
      if (toggle || shortcuts.terminal.includes(shortcut)) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) {
          if (toggle) toggleTerminal();
          else perform("terminal");
        }
      }
      return;
    }
    if (shortcuts.menu.includes(shortcut)) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) perform("menu");
    }
  }

  function routeLocation(side: Side, place: Place, listing: Listing) {
    showProcesses(side, false);
    cancelScan(side);
    invalidateListing(side);
    delete failedFtp.current[side];
    const previous = connected.current[side];
    if (previous && !sameConnection(previous, place) && !sameConnection(connected.current[opposite(side)], previous)) {
      if (previous.kind === "ssh") dropTerminal("ssh:" + previous.id);
      if (!documents.some(({ file }) => sameConnection(file.place, previous))) disconnect(previous);
    }
    connected.current[side] = place.kind === "server" || isFileServer(place) ? place : null;
    setActive(side);
    updatePane(side, (pane) => {
      if (place.kind === "smbRoot" && pane.place?.kind === "smbRoot" && pane.place.path === place.path) {
        return applyListing(pane, place, listing, "refresh");
      }
      const history = pane.history.slice(0, pane.position + 1).filter((location) => location.kind === "local");
      return applyListing({ ...pane, history, position: history.length - 1 }, place, listing, "push");
    });
  }

  function open(side: Side, entry: Entry) {
    if (entry.name === "..") { parent(side); return; }
    const pane = panes[side];
    if (pane.loading) return;
    if (pane.place?.kind === "connections" && entry.connection) {
      void openSavedConnection(side, entry.connection);
      return;
    }
    if (pane.place?.kind === "smbRoot" && entry.directory) {
      void load(side, childPlace(pane.place, entry.name));
      return;
    }
    const item = paneItem(pane, entry);
    if (!item) return;
    const { place, entry: file } = item;
    if (file.directory) {
      void load(side, childPlace(place, file.name));
    } else if ((isFileServer(place) || place.kind === "archive") && !file.link) {
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

  function openConnections(side: Side, source: ConnectionSource) {
    const place = panes[side].place;
    showProcesses(side, false);
    if (place?.kind === "connections" && place.source === source) refresh(side);
    else void load(side, { kind: "connections", source, from: place?.kind === "connections" ? place.from : place });
  }

  function editConnection(side: Side, source: ConnectionSource, profile?: SavedConnection) {
    if (panes[side].loading) return;
    setModal({ kind: "connectionEditor", side, source, profile });
  }

  function connectionDialogsClosed(side: Side) {
    activeModal.current = null;
    setModal(null);
    requestAnimationFrame(() => focus(side));
  }

  function reloadConnectionLists(side: Side, selected?: { kind: SavedConnection["kind"]; id: string }) {
    connectionDialogsClosed(side);
    for (const shown of ["left", "right"] as const) {
      const { place, loading } = latest.current[shown];
      if (place?.kind !== "connections" || loading) continue;
      void load(shown, place, "refresh").then((loaded) => {
        if (!loaded || shown !== side || !selected) return;
        updatePane(shown, (pane) => {
          if (pane.place !== place) return pane;
          const entry = pane.entries.find(({ connection }) => connection?.kind === selected.kind && connection.id === selected.id);
          return entry ? { ...pane, selected: entry.name, filter: "" } : pane;
        });
      });
    }
  }

  async function openSavedConnection(side: Side, profile: SavedConnection, approval?: SshHostVerification) {
    const { ticket } = beginListing(side);
    updatePane(side, (pane) => ({ ...pane, loading: true, loadingPath: profile.label, error: "" }));
    function complete(place: Place, listing: Listing) {
      if (request.current[side] !== ticket) {
        if (place.kind === "server" || isFileServer(place)) disconnect(place);
        return false;
      }
      routeLocation(side, place, listing);
      requestAnimationFrame(() => focus(side));
      return true;
    }
    try {
      switch (profile.kind) {
        case "ftp": {
          const { place, listing } = await connectFtpLocation(profile.id);
          complete(place, listing);
          break;
        }
        case "ssh": {
          const result = await api.connectSsh(profile.id, approval);
          if (result.kind === "verifyHost") {
            if (request.current[side] !== ticket) break;
            if (activeModal.current) throw new Error(t("Open this connection again to verify its host key."));
            const verification = { kind: "verifyConnection", side, profile, verification: result.verification } as const;
            activeModal.current = verification;
            setModal(verification);
          } else {
            const { id, address, origin, segments, listing } = result;
            complete({ kind: "ssh", profileId: profile.id, id, address, origin, segments }, listing);
          }
          break;
        }
        case "smb": {
          const result = await api.connectSmb(profile.path, null, false);
          if (request.current[side] !== ticket) break;
          if (result.kind === "credentials_required") {
            if (activeModal.current) throw new SmbCredentialsRequired();
            const credentials = { kind: "smb", side, navigation: { path: profile.path, complete } } as const;
            activeModal.current = credentials;
            setModal(credentials);
          } else {
            const { place, listing } = smbLocation(result);
            if (complete(place, listing) && result.warning) {
              setStatus({ text: t("Could not save SMB credentials. {0}", result.warning), error: true });
            }
          }
          break;
        }
        case "server": {
          const { listing, ...connected } = await api.connectSavedServer(profile.credential);
          complete({ kind: "server", ...connected, segments: [] }, listing);
          break;
        }
        case "kswitcher": {
          const directory = preferences.kswitcher;
          const listing = await api.listKSwitcher(directory, profile.peer, "");
          complete({ kind: "kswitcher", directory, peer: profile.peer, path: "", parent: listing.parent, address: profile.label }, listing);
          break;
        }
      }
    } catch (failure) {
      if (request.current[side] === ticket) updatePane(side, (pane) => ({ ...pane, error: describeError(failure) }));
    } finally {
      if (request.current[side] === ticket) {
        delete pendingListings.current[side];
        updatePane(side, (pane) => ({ ...pane, loading: false, loadingPath: undefined }));
      }
    }
  }

  async function openArchive(side: Side, path: string, password?: string) {
    const { ticket, signal } = beginListing(side);
    updatePane(side, (pane) => ({ ...pane, loading: true, loadingPath: path }));
    try {
      const result = await waitForListing(api.openArchive(path, password), signal);
      if (!result) return;
      const { listing, ...opened } = result;
      if (ticket === request.current[side]) {
        const place: ArchivePlace = { ...opened, kind: "archive", segments: [],
          address: opened.writable ? "Archive" : "Read-only archive" };
        updatePane(side, (pane) => applyListing(pane, place, listing, "push"));
      }
    } finally {
      if (ticket === request.current[side]) {
        delete pendingListings.current[side];
        updatePane(side, (pane) => ({ ...pane, loading: false, loadingPath: undefined }));
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
    if (place?.kind === "connections") {
      if (target) {
        const position = panes[side].history.lastIndexOf(target, panes[side].position - 1);
        void load(side, target, position >= 0 ? position : "push");
      } else {
        cancelLoading(side);
        updatePane(side, () => emptyPane);
      }
      return;
    }
    if (place && target) {
      const reveal = target.kind === "smbRoot" || (place.kind === "archive" && !place.segments.length) ? folderLabel(place) : undefined;
      void load(side, target, "push", reveal);
    }
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
    if (entry.remote) {
      await openNetworkFolderShortcut(side, entry.remote, entry.path);
      return;
    }
    const state = latest.current[side];
    const savedPath = (path: string) => windowsClient ? path.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase() : path;
    if (!state.search && !state.loading && !processPanels[side] && state.place) {
      const current = state.place;
      const matches = entry.peer ? current.kind === "kswitcher" && current.peer === entry.peer.id &&
        current.directory === preferences.kswitcher : current.kind === "local";
      if (matches && savedPath(placePath(current)) === savedPath(entry.path)) {
        focus(side);
        return;
      }
    }
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
    await load(side, place, "push", "..");
  }

  async function openNetworkFolderShortcut(side: Side, remote: NonNullable<FolderShortcut["remote"]>, path: string) {
    const segments = path.split("/").filter(Boolean);
    const existing = connected.current[side];
    const matches = (place: NetworkPlace | null) => place?.kind === remote.kind &&
      (place.kind === "server" ? place.share : place.profileId) === remote.id;
    if (processPanels[side]) showProcesses(side, false);
    else focus(side);
    if (existing && matches(existing)) {
      await load(side, { ...existing, segments });
      return;
    }

    const { ticket, signal } = beginListing(side);
    updatePane(side, (pane) => ({ ...pane, loading: true, loadingPath: path, error: "", elevationPath: undefined }));
    try {
      let place: NetworkPlace;
      let listing: Listing;
      if (remote.kind === "ftp") {
        ({ place, listing } = await connectFtpLocation(remote.id, segments));
      } else if (remote.kind === "ssh") {
        const result = await api.connectSsh(remote.id, undefined, segments);
        if (result.kind === "verifyHost") throw new Error(t("Verify the host key in SSH connections before opening this shortcut."));
        place = { kind: "ssh", id: result.id, profileId: remote.id, address: result.address, origin: result.origin, segments: result.segments };
        listing = result.listing;
      } else {
        const shared = connected.current[opposite(side)];
        if (shared?.kind !== "server" || !matches(shared)) {
          throw new Error(t("Connect to the Dirlume server at {0} before opening this shortcut.", remote.name));
        }
        place = { ...shared, segments };
        listing = await api.listServer(shared.id, segments);
        if (!sameConnection(connected.current[opposite(side)], shared)) {
          throw new Error(t("Connect to the Dirlume server at {0} before opening this shortcut.", remote.name));
        }
      }
      if (signal.aborted || ticket !== request.current[side]) {
        if (place.kind !== "server") disconnect(place);
        return;
      }
      routeLocation(side, place, listing);
    } catch (error) {
      if (!signal.aborted && ticket === request.current[side]) {
        updatePane(side, (pane) => ({ ...pane, loading: false, loadingPath: undefined, error: describeError(error) }));
      }
    } finally {
      if (ticket === request.current[side]) delete pendingListings.current[side];
    }
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
    if (visible) cancelFolderOperation(side);
    setProcessPanels((panels) => ({ ...panels, [side]: visible ? { path } : null }));
    requestAnimationFrame(() => focus(side));
  }

  function showLockingProcesses(side: Side, item: ReturnType<typeof paneItem>) {
    if (!windowsClient || item?.place.kind !== "local") return;
    const { place, entry } = item;
    showProcesses(opposite(side), true, placePath(childPlace(place, entry.name)));
  }

  function closeResults(side: Side) {
    cancelLoading(side);
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
      ...pane, sort: { column, asc: column !== pane.sort.column || !pane.sort.asc },
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

  function openTransfer(kind: Transfer["kind"], source: Transfer["source"], items: Transfer["items"], target: Place | null, chooseOperation = false) {
    if (!items.length) return;
    const remoteDestination = isFileServer(target) ? target : undefined;
    if (remoteDestination && source.kind !== "local") {
      setStatus({ text: remoteDestination.kind === "ssh" ? "Choose a local source for the SSH upload." :
        "Choose a local source for the FTP upload.", error: true });
      return;
    }
    if (source.kind !== "local" && items.some(({ entry }) => entry.link || (source.kind === "kswitcher" && entry.directory))) {
      setStatus({ text: source.kind === "kswitcher" ? "Choose regular remote files to download." : "Choose remote files or folders without links.", error: true });
      return;
    }
    setModal({ kind: "transfer", transfer: {
      kind, source, items, chooseOperation,
      target: target?.kind === "local" || isFileServer(target) ? placePath(target) : "",
      remoteDestination,
    } });
  }

  function transfer(kind: "copy" | "move") {
    const source = pane.place;
    if (!source || source.kind === "smbRoot" || source.kind === "connections" || !current || pane.loading) {
      setStatus({ text: "Select a file or folder in the active pane." });
      return;
    }
    if (kind === "move" && (pane.search || (source.kind !== "local" && source.kind !== "ftp"))) return;
    if (kind === "move" && source.kind === "ftp") {
      setModal({ kind: "rename", path: placePath(source), name: current.name, remote: source });
      return;
    }
    openTransfer(kind, source, transferItems(active, current), other.search || (kind === "move" && otherFileServer) ? null : other.place);
  }

  function startDrag(side: Side, entry: Entry, event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0 || event.pointerType === "touch") return;
    const state = panes[side];
    if (!state.place || state.place.kind === "smbRoot" || state.place.kind === "connections" || state.loading || modal) return;
    const items = transferItems(side, entry, state.marked.includes(entry.name));
    if (!items.length) return;
    drag.current = { side, source: state.place, items, pointer: event.pointerId,
      x: event.clientX, y: event.clientY, moving: false };
  }

  function dropSide(x: number, y: number, local: boolean, source?: Side): Side | null {
    const side = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-pane]")?.dataset.dropPane;
    if ((side !== "left" && side !== "right") || side === source || modal || helpTopic || activeDocument !== null) return null;
    const pane = panes[side];
    return !pane.search && !pane.loading && !processPanels[side] &&
      (pane.place?.kind === "local" || (local && isFileServer(pane.place))) ? side : null;
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointer || !(event.buttons & 1)) return;
    if (!current.moving) {
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < 5) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      current.moving = true;
    }
    setDropTarget(dropSide(event.clientX, event.clientY, current.source.kind === "local", current.side));
  }

  function stopDrag() {
    drag.current = null;
    setDropTarget(null);
  }

  const handleNativeDrop = useEffectEvent(async (payload: DragDropEvent) => {
    if (payload.type === "leave") { setDropTarget(null); return; }
    const { x, y } = payload.position;
    const side = dropSide(x / window.devicePixelRatio, y / window.devicePixelRatio, true);
    if (payload.type !== "drop") { setDropTarget(side); return; }
    setDropTarget(null);
    if (!side || !payload.paths.length) return;
    try {
      const files = await api.droppedFiles(payload.paths);
      const items = files.map(({ directory, entry }) => ({ place: localPath(directory), entry }));
      if (items.length) openTransfer("copy", items[0].place, items, panes[side].place, panes[side].place?.kind === "local");
    } catch (error) {
      setStatus({ text: describeError(error), error: true });
    }
  });

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    const listener = getCurrentWebview().onDragDropEvent(({ payload }) => { if (active) void handleNativeDrop(payload); });
    void listener.catch((error: unknown) => reportFrontendError("file_drop", error));
    return () => { active = false; void listener.then((unlisten) => unlisten()).catch(() => {}); };
  }, []);

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

  function contextActions(side: Side, x: number, y: number, entry?: Entry) {
    setActive(side);
    setFileMenu(null);
    if (entry && !panes[side].marked.includes(entry.name)) selectRow(side, entry, false, false);
    const state = panes[side];
    const item = entry ? paneItem(state, entry) : null;
    const place = entry ? item?.place : state.search ? null : state.place;
    if (isTauri() && windowsClient && place?.kind === "local") {
      void api.windowsItemMenu(place.path, item?.entry.name).catch((failure: unknown) => {
        setStatus({ text: describeError(failure), error: true });
        setFileMenu({ side, x, y, entry });
      });
    } else setFileMenu({ side, x, y, entry });
  }

  function finishDrag(event: PointerEvent<HTMLDivElement>) {
    const payload = drag.current;
    if (!payload || payload.pointer !== event.pointerId) return;
    stopDrag();
    const side = payload.moving ? dropSide(event.clientX, event.clientY, payload.source.kind === "local", payload.side) : null;
    if (!side) return;
    openTransfer("copy", payload.source, payload.items, panes[side].place,
      payload.source.kind === "local" && panes[side].place?.kind === "local" && !panes[payload.side].search);
  }

  function selectRow(side: Side, entry: Entry, range: boolean, mark: boolean) {
    if (panes[side].place?.kind === "connections") {
      updatePane(side, (pane) => ({ ...pane, selected: entry.name }));
      return;
    }
    if (rowRename && (rowRename.side !== side || rowRename.name !== entry.name)) setRowRename(null);
    const items = entries[side];
    const index = items.findIndex(({ name }) => name === entry.name);
    const anchorName = selectionAnchor.current[side] ?? panes[side].selected ?? entry.name;
    const anchor = items.findIndex(({ name }) => name === anchorName);
    if (!range) selectionAnchor.current[side] = entry.name;
    const group = range && index >= 0 ? selectableRange(items, anchor < 0 ? index : anchor, index) : [];
    updatePane(side, (pane) => ({
      ...pane, selected: entry.name,
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

  function openTerminal(moveFocus = true, place = terminalPlace) {
    if (!place) {
      setStatus({ text: "Choose a local or SSH folder to open a terminal.", error: true });
      return;
    }
    const key = place.kind === "ssh" ? "ssh:" + place.id : "local";
    const existing = terminals[key];
    if (existing) {
      if (moveFocus) terminalFocus.current = existing.id;
      return existing;
    }
    const common = { id: ++nextSession.current, path: placePath(place), refreshEnvironment: preferences.refreshEnvironment };
    const session: TerminalSession = place.kind === "ssh"
      ? { ...common, kind: "ssh", connection: place.id, address: place.address, segments: place.segments }
      : { ...common, kind: "local" };
    if (moveFocus) terminalFocus.current = session.id;
    setTerminals((current) => ({ ...current, [key]: session }));
    return session;
  }

  const followTerminal = useEffectEvent(() => { openTerminal(false); });
  useEffect(() => {
    if (terminalVisible && terminalKey && !terminal && activeDocument === null) followTerminal();
  }, [terminalVisible, terminalKey, terminal, activeDocument]);

  function showCommandLine(moveFocus = true) {
    setTerminalShare(0);
    setPanelsHidden(false);
    if (moveFocus) requestAnimationFrame(() => commandInput.current?.focus());
  }

  function dropTerminal(key: string) {
    const session = terminals[key];
    if (!session) return;
    setTerminals(({ [key]: _closed, ...remaining }) => remaining);
    setPendingCommands(({ [session.id]: _closed, ...remaining }) => remaining);
  }

  function toggleTerminal() {
    if (terminalVisible) showCommandLine();
    else if (openTerminal()) setTerminalShare(terminalHeight);
  }

  function terminalBounds() {
    const card = document.querySelector<HTMLElement>(".terminal-card:not([hidden])");
    const surface = card?.querySelector<HTMLElement>(".terminal-surface");
    const workspace = document.querySelector(".workspace");
    if (!card || !surface || !workspace) return;
    const style = getComputedStyle(card);
    const margin = parseFloat(style.marginTop) + parseFloat(style.marginBottom);
    const height = card.getBoundingClientRect().height + margin;
    const available = height + workspace.getBoundingClientRect().height;
    const row = terminalRowHeight.current || parseFloat(style.getPropertyValue("--terminal-size")) || 18;
    const minimum = height - surface.getBoundingClientRect().height + row;
    const maximum = available - Math.min(150, window.innerHeight * .35);
    return { height, available, row, minimum, maximum };
  }

  function storeTerminalHeight(height: number, available: number) {
    const share = height / available * 100;
    setTerminalShare(share);
    setTerminalHeight(share);
  }

  function resizeTerminal(direction: 1 | -1) {
    if (panelsHidden) {
      if (direction === -1) {
        setTerminalShare(terminalHeight);
        setPanelsHidden(false);
      }
      return;
    }
    if (terminalShare === 0) {
      if (direction === 1 && openTerminal()) setTerminalShare(terminalHeight);
      return;
    }
    const bounds = terminalBounds();
    if (!bounds) return;
    const { height, available, row, minimum, maximum } = bounds;
    const next = Math.min(maximum, height + direction * row * preferences.terminalResizeRows);
    if (direction === -1 && next < minimum - .5) {
      showCommandLine(!document.activeElement?.closest(".workspace"));
    } else if (next > 0 && Math.abs(next - height) > .1) {
      storeTerminalHeight(next, available);
    }
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
      if (panelsHidden && terminal) setPendingCommands((commands) => ({ ...commands, [terminal.id]: [...(commands[terminal.id] ?? []), null] }));
      else if (currentRow) open(active, currentRow);
      return;
    }
    const session = openTerminal();
    if (!session || !terminalPlace) return;
    setTerminalShare(terminalHeight);
    setPendingCommands((commands) => ({
      ...commands, [session.id]: [...(commands[session.id] ?? []), { command: commandLine, directory: placePath(terminalPlace) }],
    }));
    recordCommand(commandLine);
    setCommandLine("");
  }

  function insertCommand(value: string, windows = windowsClient) {
    const input = commandInput.current;
    if (!input) return;
    const start = input.selectionStart ?? commandLine.length;
    const end = input.selectionEnd ?? start;
    const quoted = /^[\p{Letter}\p{Number}_.:/\\-]+$/u.test(value) ? value : shellArgument(value, windows);
    setCommandLine(commandLine.slice(0, start) + quoted + commandLine.slice(end));
    showCommandLine(false);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + quoted.length, start + quoted.length);
    });
  }

  function copyPath(path: string) {
    void api.copyText(path).then(() => setStatus({ text: "Path copied to the clipboard." }),
      (error: unknown) => setStatus({ text: describeError(error), error: true }));
  }

  function copyItemNames() {
    if (!canCopyItemNames) return;
    const marks = new Set(pane.marked);
    const marked = marks.size ? entries[active].filter(({ name }) => marks.has(name)) : [];
    const items = marked.length ? marked : current ? [current] : [];
    const names = items.map(({ name }) => pane.search?.matches.get(name)?.entry.name ?? name);
    if (!names.length) return;
    void api.copyText(names.join("\n")).then(() => setStatus({ text: "Item names copied to the clipboard." }),
      (error: unknown) => setStatus({ text: describeError(error), error: true }));
  }

  function fileFor(side: Side, entry = entries[side][paneCursorIndex(panes[side], entries[side])]): NamedFile | null {
    const item = paneItem(panes[side], entry);
    return item && item.place.kind !== "kswitcher" && !item.entry.directory && !item.entry.link
      ? { place: item.place, name: item.entry.name } : null;
  }

  const comparisonMarked = pane.marked.length < 2 ? [] : entries[active]
    .filter(({ name }) => pane.marked.includes(name))
    .map((entry) => fileFor(active, entry))
    .filter((file): file is NamedFile => file !== null);
  const comparisonLeft = comparisonMarked.length === 2 ? comparisonMarked[0] : fileFor("left");
  const comparisonRight = comparisonMarked.length === 2 ? comparisonMarked[1] : fileFor("right");
  const comparison = comparisonLeft && comparisonRight ? { left: comparisonLeft, right: comparisonRight } : null;

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
    if (command === "recycleAlternate") command = "recycle";
    if (command === "toggleTerminal") {
      toggleTerminal();
      return;
    }
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
        "shrinkLeft", "growLeft", "settings", "help", "menu", "close", "terminal", "commandHistory", "connect"].includes(command)) return;
    }
    if (catalog && !processPanels[active]) {
      const [add, edit] = connectionCommands[catalog.source];
      if (command === add || command === edit) {
        if (command === add || current?.connection) editConnection(active, catalog.source, command === edit ? current?.connection : undefined);
        return;
      }
      if (command === "recycle" || command === "delete") {
        if (current?.connection && !pane.loading) setModal({ kind: "removeConnection", side: active, profile: current.connection });
        return;
      }
      if (isRangeCommand(command) || command === "mark") return;
    }
    if (command in rowCommands) {
      const items = entries[active];
      if (!items.length) return;
      const offset = rowCommands[command as keyof typeof rowCommands];
      updatePane(active, (pane) => {
        const index = paneCursorIndex(pane, items);
        const next = Math.max(0, Math.min(items.length - 1, offset === 0 ? 0 : index + offset));
        return isRangeCommand(command) ? toggleMarkAndMoveCursor(pane, items, index, next) : { ...pane, selected: items[next].name };
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
        if (!canSwapPanes || pendingListings.current.left || pendingListings.current.right) break;
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
        document.getElementById(`${active}-path`)?.dispatchEvent(new Event("dirlume-edit-path"));
        break;
      }
      case "open": if (currentRow) open(active, currentRow); break;
      case "attributes":
        if (currentItem && !pane.loading && !busy) setModal({ kind: "attributes", item: currentItem });
        break;
      case "parent": parent(active); break;
      case "back": history(active, -1); break;
      case "forward": history(active, 1); break;
      case "refresh": refresh(active); break;
      case "filter": document.getElementById(`${active}-pane`)?.dispatchEvent(new Event("dirlume-filter")); break;
      case "hidden": setPreferences({ ...preferences, hidden: !preferences.hidden }); break;
      case "settings": openSettings(); break;
      case "help": setHelpTopic(contextHelpTopic(undefined, document.activeElement, editingDocument)); break;
      case "menu":
      case "menuAlternate": (documentMenu.current ?? mainMenu.current)?.open(); break;
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
        if (panelsHidden) {
          if (terminalShare) setPanelsHidden(false);
          else showCommandLine();
        } else if (openTerminal()) {
          setPanelsHidden(true);
          requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".terminal-card:not([hidden]) .xterm-helper-textarea")?.focus());
        }
        break;
      case "commandPath":
      case "commandName":
        if (currentItem && (currentItem.place.kind === "local" || currentItem.place.kind === "ssh")) {
          insertCommand(command === "commandPath"
            ? placePath(childPlace(currentItem.place, currentItem.entry.name)) : currentItem.entry.name,
          currentItem.place.kind === "local" && windowsClient);
        }
        break;
      case "copyFullPath":
        if (currentFullPath !== null) copyPath(currentFullPath);
        break;
      case "copyItemNames": copyItemNames(); break;
      case "previousCommand": {
        const previous = commandTexts[historyIndex.current + 1];
        if (previous !== undefined) {
          historyIndex.current++;
          setCommandLine(previous);
          showCommandLine();
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
        if (pane.place && pane.place.kind !== "smbRoot" && pane.place.kind !== "connections" && !pane.loading) {
          setModal({ kind: "search", side: active, place: pane.place });
        }
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
        const writable = local ?? fileServer ?? (archive?.writable ? archive : undefined);
        if (writable && !pane.search && current && !busy && !pane.loading) {
          const marked = entries[active].filter(({ name }) => pane.marked.includes(name));
          const selected = marked.length ? marked : [current];
          setModal({
            kind: permanentDelete || archive ? "delete" : command, path: placePath(writable), remote: fileServer, archive,
            names: selected.map(({ name }) => name),
            directories: fileServer ? selected.filter((entry) => entry.directory && !entry.link).map(({ name }) => name) : undefined,
          });
        }
        break;
      }
      case "cancelMeasure":
        if (commandLine) { setCommandLine(""); historyIndex.current = -1; }
        else if (pane.search && !panelsHidden) closeResults(active);
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
        if (!comparison) {
          setStatus({ text: "Choose a text file in each pane to compare.", error: true });
        } else if (isTauri()) {
          void api.openToolWindow(t("Compare files"), undefined, comparison)
            .catch((error: unknown) => setStatus({ text: describeError(error), error: true }));
        } else setModal({ kind: "compare", ...comparison });
        break;
      }
    }
  }

  const openingOptions = useRef(false);
  function openSettings(page?: FeaturePage) {
    if (!isTauri()) { setModal({ kind: "settings", page }); return; }
    if (openingOptions.current) return;
    openingOptions.current = true;
    void api.openToolWindow(t("Options"), readDialogSize("options"), undefined, page).then(() => {
      setModal((current) => current?.kind === "connect" ? null : current);
    }).catch((error: unknown) => setStatus({ text: describeError(error), error: true })).finally(() => {
      openingOptions.current = false;
    });
  }

  function keyDown(event: KeyboardEvent) {
    const native = event.nativeEvent;
    if ((event.target as HTMLElement).closest(".inline-rename")) return;
    if (modal || helpTopic || event.defaultPrevented || native.isComposing) return;
    const target = event.target as HTMLElement;
    if (target.closest("dialog[open]") || isTerminalInput(target)) return;
    if (target === commandInput.current && event.ctrlKey && !event.altKey && !event.metaKey &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")) return;
    const shortcut = eventShortcut(event);
    const fileKey = /^F\d{1,2}$/.test(event.key);
    // Use the physical letter for these defaults when the keyboard layout changes.
    const physical = /^Key[A-Z]$/.test(event.code) && !event.getModifierState("AltGraph")
      ? eventShortcut(event, event.code.slice(3)) : "";
    const onFiles = target.closest(".file-list");
    const profileCommand = catalog && !processPanels[active] && onFiles
      ? connectionCommands[catalog.source].find((command) => shortcuts[command].includes(shortcut)) : undefined;
    const command = profileCommand ?? commandNames.find((command) => shortcut && command !== "settings" && commandScope(command) === "main" &&
      shortcuts[command].includes(shortcut)) ?? (["hidden", "attributes", "copyFullPath"] as const).find((command) =>
      commands[command].key === physical && shortcuts[command].includes(physical)) ??
      physicalFolderBinding(native, shortcuts);
    if (activeDocument !== null) return;
    const inCommandLine = target === commandInput.current;
    const inField = target.closest("input, select, textarea, [contenteditable]");
    if (!command || command === "quickSearch") {
      const unavailable = processPanels[active] ? target !== onFiles || !onFiles?.classList.contains("process-table") : !pane.place;
      if (panelsHidden || unavailable || (inField && !inCommandLine)) return;
      const seed = quickSearchSeed(native, shortcuts.quickSearch);
      if (seed === null) return;
      event.preventDefault();
      document.getElementById(active + "-pane")?.dispatchEvent(new CustomEvent("dirlume-quick-search", { detail: seed }));
      return;
    }
    if (inField && (event.key === "Backspace" || event.key === "Delete" || command === "copyClipboard" || command === "pasteClipboard")) return;
    if (command === "copyFullPath" && (!onFiles || inField || currentFullPath === null)) return;
    if (command === "copyItemNames" && (!onFiles || inField || !canCopyItemNames)) return;
    if (command === "attributes" && (!onFiles || inField || panelsHidden || processPanels[active])) return;
    if (isRangeCommand(command) && (!onFiles || processPanels[active])) return;
    const fileNavigation = command in rowCommands || command === "open";
    if (inField && !fileKey && command !== "terminal" && command !== "toggleTerminal" &&
        (!inCommandLine || (fileNavigation && (commandLine || panelsHidden)))) return;
    if ((fileNavigation || command === "switchPane" || command === "mark") && !onFiles && !inCommandLine) return;
    if (panelsHidden && (fileNavigation || (["mark", "copy", "move", "recycle", "recycleAlternate", "delete"].includes(command)))) return;
    event.preventDefault();
    if (!event.repeat || (!["hidden", "attributes", "copyFullPath", "copyItemNames", "addFolderShortcut", "folderShortcuts", "terminal", "toggleTerminal"].includes(command) &&
        !folderGroupCommand(command))) {
      perform(command);
    }
  }

  function keyLabel(command: Command) {
    return showShortcut(shortcuts[command][0]);
  }

  const currentFile = fileFor(active);
  const fileActions = catalog ? ([
    { command: connectionCommands[catalog.source][0], label: "Add connection", Icon: FilePlus, disabled: pane.loading },
    { command: connectionCommands[catalog.source][1], label: "Edit connection", Icon: Pencil, disabled: !current?.connection || pane.loading },
    { command: "recycle", label: "Remove connection", Icon: Trash2, disabled: !current?.connection || pane.loading },
  ] as const) : ([
    { command: "view", label: measureEntries.length ? "Measure" : "View", Icon: measureEntries.length ? Calculator : Eye,
      disabled: !fileFor(active) && !measureEntries.length },
    { command: "edit", label: "Edit", Icon: Pencil, disabled: !currentFile || !writableTextPlace(currentFile.place) },
    { command: "copy", label: local || fileServer || archive ? "Copy" : "Download", Icon: local || fileServer || archive ? Copy : ArrowDownToLine, disabled: !canTransfer || busy },
    { command: "move", label: ftp ? "Rename" : "Move", Icon: ArrowLeftRight, disabled: (!local && !ftp) || !!pane.search || !canTransfer || busy },
    { command: "rename", label: "Rename", Icon: TextCursorInput, disabled: (!local && !ftp) || !!pane.search || !current || busy },
    { command: "newFile", label: "New file", Icon: FilePlus, disabled: !local || !!pane.search || busy },
    { command: "mkdir", label: "New folder", Icon: FolderPlus, disabled: !local || !!pane.search || busy },
    { command: "recycle", label: permanentDelete || archive ? "Delete" : "Trash", Icon: Trash2, disabled: (!local && !fileServer && !archive?.writable) || !!pane.search || !current || busy },
    { command: "compare", label: "Compare", Icon: FileDiff, disabled: comparison === null },
    { command: "mark", label: "Mark", Icon: CheckSquare, disabled: !current },
  ] as const).filter(({ command }) => !ftp || command !== "rename");
  const panesAvailable = !panelsHidden && activeDocument === null;
  const filesAvailable = panesAvailable && !processPanels[active] && !pane.loading;
  const canCopyItemNames = filesAvailable && !catalog && (pane.marked.length > 0 || !!current);
  const currentFullPath = filesAvailable && currentItem ? placePath(childPlace(currentItem.place, currentItem.entry.name)) : null;

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
        inPane("parent", !processPanels[side] && !target.search && target.place?.kind !== "connections" &&
          (!target.place || !parentPlace(target.place))),
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
      ...(permanentDelete || archive ? [] : [menuCommand("delete", !filesAvailable || !local || !!pane.search || !current || busy)]),
    ] },
    { label: "Commands", items: [
      menuCommand("search", !filesAvailable || !pane.place || pane.place.kind === "smbRoot"),
      menuCommand("compare", !filesAvailable || comparison === null),
      menuCommand("copyFullPath", currentFullPath === null),
      menuCommand("copyItemNames", !canCopyItemNames),
      menuCommand("connect", activeDocument !== null, "Connect"),
      menuCommand("swap", !panesAvailable || !canSwapPanes),
      menuCommand("commandHistory", activeDocument !== null),
      menuCommand("folderShortcuts", !panesAvailable),
      menuCommand("toggleTerminal", activeDocument !== null),
      ...(isTauri() ? [{ label: "MCP server", run: () => setModal({ kind: "mcp" }) }] : []),
      ...(isTauri() ? [{ label: "Check for updates", run: () => { void checkUpdates(true); } }] : []),
    ] },
    { label: "Options", items: [menuCommand("settings"), menuCommand("hidden")] },
    paneMenu("right"),
    { label: "Help", items: [menuCommand("help"), { label: "About", run: () => setModal({ kind: "about" }) },
      { label: "Open error log", separatorBefore: true, run: () => void openErrorLog() }] },
  ];

  return (
    <div className={`app${terminalVisible ? " has-terminal" : ""}${panelsHidden ? " panels-hidden" : ""}${activeDocument !== null ? " document-active" : ""}`}
      data-layout={preferences.layout} style={{ "--terminal-height": `${terminalShare}fr`, "--panes-height": `${100 - terminalShare}fr` } as CSSProperties}
      onKeyDown={keyDown} onKeyDownCapture={documentKeys}
      onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}>
      <header className={windowsClient && isTauri() ? "topbar window-titlebar" : "topbar"}
        data-menu-position={preferences.mainMenuAlignment} data-tauri-drag-region={windowsClient && isTauri() ? "deep" : undefined}>
        <div className="brand">
          <span className="brand-icon"><FolderTree /></span><h1>Dirlume</h1>
        </div>
        <MainMenu ref={mainMenu} groups={menuGroups} shortcut={keyLabel("menu")} />
        <div className="top-actions">
          <Button className="toolbar-button topbar-connect" aria-label={t("Connect")} shortcut={keyLabel("connect")} onClick={() => perform("connect")}>
            <Server /> <span>{t("Connect")}</span>
          </Button>
          <Button className="icon-button" aria-label={t("Find files")} shortcut={keyLabel("search")}
            disabled={activeDocument !== null || !!processPanels[active] || !pane.place || pane.place.kind === "smbRoot" || pane.loading}
            onClick={() => perform("search")}><Search /></Button>
          <span className="separator" />
          <Button className="icon-button" aria-label={t("Swap panes")} shortcut={keyLabel("swap")}
            disabled={!canSwapPanes} onClick={() => perform("swap")}><ArrowLeftRight /></Button>
          <Button className="icon-button" aria-label={t("Show hidden files")} aria-pressed={preferences.hidden}
            shortcut={keyLabel("hidden")} onClick={() => perform("hidden")}>{preferences.hidden ? <Eye /> : <EyeOff />}</Button>
          <Button className="icon-button" aria-label={t("Toggle terminal")} aria-pressed={terminalVisible}
            shortcut={keyLabel("toggleTerminal")} disabled={activeDocument !== null} onClick={toggleTerminal}><TerminalIcon /></Button>
          <Button className="icon-button" aria-label={t(theme === "light" ? "Switch to favorite dark scheme" : "Switch to favorite light scheme")}
            onClick={() => setPreferences((current) => selectAppearance(current,
              theme === "light" ? current.systemDarkScheme : current.systemLightScheme))}>
            {theme === "light" ? <Moon /> : <Sun />}
          </Button>
          {preferences.showTitlebarScheme && <select className="topbar-scheme" aria-label={t("Color scheme")}
            data-tooltip={scheme?.name}
            value={preferences.activeScheme ? `custom:${preferences.activeScheme}` : preferences.theme}
            onChange={(event) => {
              const value = event.target.value;
              setPreferences((current) => selectAppearance(current, value));
            }}>
            <SchemeOptions schemes={preferences.schemes} />
          </select>}
          <Button className="icon-button" aria-label={t("Options")} shortcut={keyLabel("settings")} onClick={() => perform("settings")}><Settings2 /></Button>
        </div>
        {windowsClient && isTauri() && <WindowControls />}
      </header>
      <main className="workspace" hidden={panelsHidden}
        style={{ "--left-pane-width": `${split}fr`, "--right-pane-width": `${100 - split}fr` } as CSSProperties}>
        {(["left", "right"] as const).map((side) => (
          <Pane key={side} side={side} active={active === side} layout={preferences.layout} showHidden={preferences.hidden}
            pane={panes[side]} entries={entries[side]} locations={locations}
            rename={rowRename?.side === side && sameRenameLocation(panes[side].place, rowRename.place) && !panes[side].search
              ? { name: rowRename.name, onCancel: () => closeRowRename(side), onSave: (name) => submitRowRename(rowRename, name) } : undefined}
            activate={() => setActive(side)} onRow={(entry, range, mark) => selectRow(side, entry, range, mark)}
            onQuickMatch={(name) => updatePane(side, (pane) => pane.selected === name ? pane : { ...pane, selected: name })}
            onOpen={(entry) => open(side, entry)} onPath={(path) => {
              const place = panes[side].place;
              showProcesses(side, false);
              if (isFileServer(place)) {
                if (!path.startsWith("/")) {
                  setStatus({ text: place.kind === "ssh" ? "Enter an absolute SSH path starting with /." :
                    "Enter an absolute FTP path starting with /.", error: true });
                  return;
                }
                void load(side, { ...place, segments: path.split("/").filter(Boolean) });
              } else void load(side, filesystemPlace(path));
            }}
            onPathAncestor={(place) => { showProcesses(side, false); void load(side, place); }}
            onCopyPath={copyPath}
            onHistory={(offset) => history(side, offset)} onParent={() => parent(side)} onRefresh={() => refresh(side)}
            onDismissError={() => {
              updatePane(side, (pane) => ({ ...pane, error: "", elevationPath: undefined, deniedSshListing: undefined }));
              requestAnimationFrame(() => focus(side));
            }} onRetryWithSudo={() => {
              const target = panes[side].deniedSshListing;
              if (target) setModal({ kind: "sudoBrowse", side, target });
            }}
            onCancelFolderOperation={() => {
              if (cancelFolderOperation(side)) requestAnimationFrame(() => focus(side));
            }} cancelFolderShortcut={shortcuts.cancelMeasure}
            onCloseResults={() => closeResults(side)}
            onStartDrag={(entry, event) => startDrag(side, entry, event)} dropTarget={dropTarget === side}
            processView={processPanels[side]} onProcesses={(visible) => showProcesses(side, visible)}
            onContext={(x, y, entry) => contextActions(side, x, y, entry)}
            onRevealResult={(entry) => {
              const item = paneItem(panes[side], entry);
              if (item) revealResult(side, item.place, item.entry.name);
            }}
            onFilter={(filter) => updatePane(side, (pane) => ({ ...pane, filter }))} onSort={(column) => sort(side, column)}
            onRemote={() => openConnections(side, "remote")} onFtp={() => openConnections(side, "ftp")}
            onSsh={() => openConnections(side, "ssh")} onSmb={() => openConnections(side, "smb")}
            sourceBindings={shortcuts} zoomShortcut={shortcuts.zoomFont}
            fontSize={preferences.viewFontSizes[side]} onZoom={zoomViewFont} />
        ))}
        {terminalVisible && !panelsHidden && <div className="terminal-divider" role="separator"
          aria-label={t("Resize terminal")} aria-orientation="horizontal" aria-valuenow={Math.round(terminalShare)} tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary) return;
            const bounds = terminalBounds();
            if (!bounds || bounds.maximum < bounds.minimum) return;
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture(event.pointerId);
            terminalDrag.current = { ...bounds, y: event.clientY };
          }}
          onPointerMove={(event) => {
            const start = terminalDrag.current;
            if (!start || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const height = Math.min(start.maximum, Math.max(start.minimum, start.height + start.y - event.clientY));
            storeTerminalHeight(height, start.available);
          }}
          onLostPointerCapture={() => { terminalDrag.current = null; }}
          onKeyDown={(event) => {
            if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey ||
                (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
            event.preventDefault();
            event.stopPropagation();
            resizeTerminal(event.key === "ArrowUp" ? 1 : -1);
          }} />}
        <SplitDivider label={t("Pane divider")} className="pane-divider" value={split} onResize={setSplit} />
      </main>
      <div className="document-workspace" hidden={activeDocument === null}>
        {documents.map(({ id, file, editing, position, back, forward }) => (
          <TextWindow key={JSON.stringify([id, placePath(file.place), file.name])}
            file={file} editing={editing} active={activeDocument === id} theme={theme}
            viewerContentWidth={preferences.viewerContentWidth} colors={scheme?.colors}
            shortcuts={shortcuts} menuRef={activeDocument === id ? documentMenu : undefined}
            fontSizes={preferences.viewFontSizes} onZoom={zoomViewFont}
            onOptions={() => openSettings(editing ? "editor" : "viewer")}
            position={position} canGoBack={!!back?.length} canGoForward={!!forward?.length}
            onNavigate={(direction, scrollTop) => navigateMarkdown(id, direction, scrollTop)}
            onOpenDocument={(target, newTab, next, scrollTop) => {
              if (newTab || (editing && target !== file)) openDocument(target, false, next);
              else if (editing) setDocuments((current) => current.map((tab) => tab.id === id ? { ...tab, position: next } : tab));
              else followMarkdownLink(id, file, target, next ?? { scrollTop: 0 }, scrollTop);
            }}
            onDirtyChange={(dirty) => {
              if (dirty) dirtyDocuments.current.add(id);
              else dirtyDocuments.current.delete(id);
            }}
            onSaved={() => {
              for (const side of ["left", "right"] as const) if (!latest.current[side].sudoListing) refresh(side);
            }} onClose={() => closeDocument(id)} />
        ))}
      </div>
      <Suspense fallback={terminalVisible && activeDocument === null ?
        <div className="terminal-card pane-empty" role="status">{t("Opening terminal…")}</div> : null}>
        {Object.entries(terminals).map(([key, session]) => (
          <TerminalPanel key={session.id} session={session}
            directory={key === terminalKey && terminalPlace && !processPanels[active] ? placePath(terminalPlace) : null}
            visible={key === terminalKey && terminalVisible && activeDocument === null} theme={theme} scheme={scheme}
            rowHeight={terminalRowHeight} focusRequested={terminalFocus}
            watchEnvironment={session.kind === "local" && preferences.refreshEnvironment}
            pasteShortcut={shortcuts.pasteTerminalText} pasteOnRightClick={preferences.terminalPasteOnRightClick}
            onPasteError={(error) => setStatus({ text: describeError(error), error: true })}
            pendingCommands={pendingCommands[session.id] ?? noCommands}
            onCommandsQueued={(count) => setPendingCommands((commands) => ({ ...commands,
              [session.id]: (commands[session.id] ?? []).slice(count),
            }))}
            onCommandSubmitted={recordCommand} onClose={() => { dropTerminal(key); showCommandLine(); }} />
        ))}
      </Suspense>
      {terminalVisible && activeDocument === null && !terminal && <div className="terminal-card pane-empty" role="status">
        {t(terminalKey ? "Opening terminal…" : "Choose a local or SSH folder to open a terminal.")}
      </div>}
      <form className="command-bar" hidden={terminalVisible} onSubmit={submitCommand}>
        <Button type="button" className="toolbar-button" onClick={toggleTerminal} shortcut={keyLabel("toggleTerminal")}>
          <TerminalIcon /> {t("Terminal")}
        </Button>
        <span data-tooltip={pane.place ? placePath(pane.place) : undefined}>{pane.place ? placePath(pane.place) : ""}</span>
        <CommandField input={commandInput} draft={commandLine} directory={processPanels[active] ? null : local?.path ?? null}
          history={commandTexts} refreshEnvironment={terminals.local?.refreshEnvironment ?? preferences.refreshEnvironment}
          onChange={(draft) => { historyIndex.current = -1; setCommandLine(draft); }} />
      </form>
      <nav ref={actionbar} className="actionbar" data-button-width={preferences.actionButtonWidth} aria-label={t("File actions")}>
        {processPanels[active] ? <Button type="button" onClick={() => showProcesses(active, false)}>{t("Back to files")}</Button> :
          fileActions.map(({ command, label, Icon, disabled }) => (
          <Button key={command} disabled={disabled} onClick={() => perform(command)} shortcut={keyLabel(command)}
            aria-keyshortcuts={shortcuts[command].join(" ") || undefined}>
            {keyLabel(command) && <kbd aria-hidden="true" data-shortcut={keyLabel(command)}>{compactShortcut(shortcuts[command][0])}</kbd>}
            <Icon /><span>{t(label)}</span>
          </Button>
        ))}
        <Button type="button" aria-pressed={terminalVisible} onClick={toggleTerminal} shortcut={keyLabel("toggleTerminal")}>
          <TerminalIcon /><span>{t("Terminal")}</span>{keyLabel("toggleTerminal") && <kbd aria-hidden="true">{keyLabel("toggleTerminal")}</kbd>}
        </Button>
      </nav>
      <nav className="document-bar" aria-label={t("Open documents")} aria-hidden={!documents.length}>
        {documents.length > 0 && <>
          <Button type="button" aria-pressed={activeDocument === null} onClick={() => selectDocument(null)}><FolderTree /> {t("Files")}</Button>
          {documents.map(({ id, file, editing }) => (
            <Button key={id} type="button" aria-label={t(editing ? "Edit {0}" : "View {0}", file.name)}
              tooltip={placePath(file.place)} aria-pressed={activeDocument === id} onClick={() => selectDocument(id)}>
              {editing ? <Pencil /> : <Eye />}<span>{file.name}</span>
            </Button>
          ))}
        </>}
      </nav>
      <footer className={`statusbar${status.error ? " danger" : ""}`}>
        <span role={status.error ? "alert" : "status"} data-tooltip={errorText(status.text)}>
          {errorText(status.text)}
        </span>
        <span>{pane.place?.kind === "connections" ? t("Saved connections") : pane.place?.kind === "archive" ? t(pane.place.address) :
          pane.place && pane.place.kind !== "local" && pane.place.kind !== "smbRoot" ? pane.place.address :
            smbHost(pane.place) ?? t("Local file system")}</span>
        <WindowResizeMarker />
      </footer>
      {modal?.kind === "settings" && <Settings initialPage={modal.page} preferences={preferences} onChange={(next) => {
        setLanguage(next.language);
        setPreferences(next);
        return next;
      }} onClose={() => setModal(null)} />}
      {modal?.kind === "exit" && (
        <Dialog title={t("Unsaved changes")} tone="warning" onClose={() => setModal(modal.update ? { kind: "update", update: modal.update } : null)}>
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
      {modal?.kind === "upToDate" && (
        <Dialog title={t("Check for updates")} onClose={() => setModal(null)}
          footer={<Button type="button" data-initial-focus onClick={() => setModal(null)}>{t("Close")}</Button>}>
          <div className="dialog-body"><p>{t("Dirlume is up to date.")}</p></div>
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
          onFinished={(success) => { refresh("left"); refresh("right"); if (success) setStatus({ text: "Transfer complete" }); }} />
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
      {modal?.kind === "about" && <AboutDialog onClose={() => setModal(null)} onOpenGuide={() => {
        setModal(null);
        setHelpTopic("files");
      }} />}
      {modal?.kind === "sudoBrowse" && <SudoDialog operation="browse" address={modal.target.place.address}
        path={placePath(modal.target.place)} onClose={() => { setModal(null); requestAnimationFrame(() => focus(modal.side)); }}
        onConfirm={async (password) => {
          const { place, action, reveal } = modal.target;
          await load(modal.side, place, action, reveal, password);
        }} />}
      {modal?.kind === "mcp" && <McpDialog onClose={() => setModal(null)} />}
      {modal?.kind === "commandHistory" && <CommandHistory commands={historyItems} onClose={() => setModal(null)}
        onChoose={(line) => { historyIndex.current = -1; setCommandLine(line); setModal(null); showCommandLine(); }} />}
      {fileMenu && !modal && (() => {
        const { side, x, y, entry } = fileMenu;
        const state = panes[side];
        const item = entry ? paneItem(state, entry) : null;
        const target = panes[opposite(side)];
        return <FileContextMenu x={x} y={y} onClose={() => setFileMenu(null)} onReturn={() => focus(side)}>
          {state.place?.kind === "connections" && (() => {
            const { source } = state.place;
            return <>
              <Button role="menuitem" onClick={() => { setFileMenu(null); editConnection(side, source); }}>{t("Add connection")}</Button>
              {entry?.connection && <>
                <Button role="menuitem" onClick={() => { setFileMenu(null); open(side, entry); }}>{t("Open")}</Button>
                <Button role="menuitem" onClick={() => { setFileMenu(null); editConnection(side, source, entry.connection); }}>
                  {t("Edit connection")}</Button>
                <Button role="menuitem" onClick={() => {
                  setFileMenu(null);
                  setModal({ kind: "removeConnection", side, profile: entry.connection! });
                }}>{t("Remove connection")}</Button>
              </>}
            </>;
          })()}
          {state.place?.kind === "smbRoot" && entry && <Button role="menuitem" onClick={() => {
            setFileMenu(null);
            open(side, entry);
          }}>{t("Open")}</Button>}
          {item && <>
            <Button role="menuitem" onClick={() => {
              setFileMenu(null);
              openTransfer("copy", item.place, transferItems(side, entry!, state.marked.includes(entry!.name)),
                target.search || (item.place.kind !== "local" && isFileServer(target.place)) ? null : target.place);
            }}>{t("Copy")}</Button>
            {item.place.kind === "local" && <Button role="menuitem" onClick={() => {
              setFileMenu(null);
              void copyClipboard(side, entry);
            }}>{t("Copy files to clipboard")}</Button>}
            {windowsClient && item.place.kind === "local" && <Button role="menuitem" onClick={() => {
              setFileMenu(null);
              showLockingProcesses(side, item);
            }}>{t("Find locking processes")}</Button>}
          </>}
          {state.place?.kind === "local" && !state.search && <>
            <Button role="menuitem" onClick={() => { setFileMenu(null); void pasteClipboard(side); }}>{t("Paste files")}</Button>
            {!entry && <Button role="menuitem" onClick={() => {
              setFileMenu(null);
              const place = state.place;
              if (place?.kind === "local") setModal({ kind: "mkdir", side, place });
            }}>{t("New folder")}</Button>}
          </>}
          <Button role="menuitem" onClick={() => { setFileMenu(null); refresh(side); focus(side); }}>{t("Refresh")}</Button>
        </FileContextMenu>;
      })()}
      {modal?.kind === "connect" && (
        <ConnectDialog provider={preferences.provider} directory={preferences.kswitcher} onOptions={() => openSettings()}
          onConnect={(place, listing) => { routeLocation(modal.side, place, listing); setModal(null); }}
          onClose={() => setModal(null)} />
      )}
      {modal?.kind === "smb" && (
        <SmbDialog path={modal.navigation.path} onClose={() => { setModal(null); requestAnimationFrame(() => focus(modal.side)); }}
          onConnect={(place, listing, warning) => {
            modal.navigation.complete(place, listing);
            setModal(null);
            if (warning) setStatus({ text: t("Could not save SMB credentials. {0}", warning), error: true });
            requestAnimationFrame(() => focus(modal.side));
          }} />
      )}
      {modal?.kind === "attributes" && <AttributesDialog item={modal.item} onClose={() => setModal(null)}
        onApplied={() => { refresh("left"); refresh("right"); }} />}
      {modal?.kind === "folderShortcuts" && <FolderShortcutsDialog screen={modal.screen} shortcuts={folderShortcuts}
        currentFolder={currentFolderShortcut(modal.side)} bridgeDirectory={preferences.kswitcher} bindings={shortcuts}
        onScreen={(screen) => setModal({ ...modal, screen })}
        onSave={(next) => { persistFolderShortcuts(next); setFolderShortcuts(next); }}
        onAssigned={(group) => setStatus({ text: t("Folder shortcut saved in group {0}.", group) })}
        onOpen={(entry) => {
          closeFolderShortcuts(modal.side);
          void openFolderShortcut(modal.side, entry);
        }}
        onClose={() => closeFolderShortcuts(modal.side)} />}
      {modal?.kind === "connectionEditor" && <SavedConnectionDialog source={modal.source} profile={modal.profile}
        remoteProvider={preferences.provider} bridgeDirectory={preferences.kswitcher}
        onSaved={(kind, id) => reloadConnectionLists(modal.side, { kind, id })}
        onClose={() => connectionDialogsClosed(modal.side)} />}
      {modal?.kind === "removeConnection" && <RemoveConnectionDialog profile={modal.profile}
        onRemoved={() => reloadConnectionLists(modal.side)} onClose={() => connectionDialogsClosed(modal.side)} />}
      {modal?.kind === "verifyConnection" && <VerifyHostDialog verification={modal.verification}
        onCancel={() => connectionDialogsClosed(modal.side)} onApprove={() => {
          connectionDialogsClosed(modal.side);
          void openSavedConnection(modal.side, modal.profile, modal.verification);
        }} />}
      {modal?.kind === "compare" && <CompareDialog left={modal.left} right={modal.right}
        previousShortcut={shortcuts.previousChange} nextShortcut={shortcuts.nextChange} onClose={() => setModal(null)} />}
      {modal?.kind === "mkdir" && <NewFolderDialog directory={modal.place.path} showHidden={preferences.hidden}
        historyShortcut={shortcuts.folderNameHistory} onClose={() => setModal(null)}
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
          hasNonemptyFolders={modal.remote && "names" in modal ? async () => {
            const remote = modal.remote!;
            const list = remote.kind === "ssh" ? api.listSsh : api.listFtp;
            for (const name of modal.directories ?? []) {
              const listing = await list(remote.id, [...remote.segments, name]);
              if (listing.entries.length || listing.omitted) return true;
            }
            return false;
          } : undefined}
          onSubmit={async (operation, recursive) => {
          const remote = modal.remote;
          if ("names" in modal && modal.archive) {
            const archive = modal.archive;
            await api.deleteArchiveEntries(archive.id, modal.names.map((name) => [...archive.segments, name]));
            refresh("left");
            refresh("right");
          } else if ("names" in modal) {
            try {
              const remove = remote?.kind === "ssh" ? api.deleteSsh : api.deleteFtp;
              await batch(modal.names, (name) => remote
                ? remove(remote.id, [...remote.segments, name], recursive && (modal.directories?.includes(name) ?? false))
                : api.operate(modal.path, { kind: modal.kind, name }));
            } finally {
              refresh("left");
              refresh("right");
            }
          } else if (operation) {
            if (operation.kind === "rename") await renameItem((remote?.kind === "ftp" ? remote : undefined) ?? localPath(modal.path), operation.name, operation.new_name);
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
        active, panes, preferences, shortcuts: folderShortcuts, load, remote: routeLocation, refresh,
        selection: (side, names) => {
          updatePane(side, (pane) => ({ ...pane, marked: names, selected: names[0] ?? pane.selected }));
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
          <HistoryField historyKey="command-history-search" aria-label={t("Search commands")} data-initial-focus type="search"
            value={query} onValueChange={setQuery} />
        </label>
        {groups.length ? groups.map(({ date, commands }, index) => <section className="command-history-group" key={date + index} aria-label={date}>
          <h3>{date}</h3>
          {commands.map((command) => <Button key={command} tooltip={command} onClick={() => onChoose(command)}>{command}</Button>)}
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
    <Dialog key={String(recursive)} title={recursive ? t(modal.remote?.kind === "ssh" ? "Delete SSH folder contents" : "Delete FTP folder contents") : title} tone={permanent ? "destructive" : undefined}
      onClose={() => { if (!waiting) onClose(); }}>
      <form className="dialog-form" onSubmit={(event) => { void submit(event); }}>
        <div className="dialog-body">
          {removing
            ? <div className={permanent ? "permanent-delete-message" : "trash-confirmation"}>
              {permanent ? <Trash2 aria-hidden="true" /> : <CircleHelp aria-hidden="true" />}
              <div>
                <p>{recursive ? t(modal.remote?.kind === "ssh" ? "Permanently delete the selected SSH folders and all their contents?" :
                  "Permanently delete the selected FTP folders and all their contents?") :
                  <Message text={permanent ? "Permanently delete {0}?" : "Move {0} to Trash?"}>
                    <strong>{modal.names.length === 1 ? modal.names[0] : countText(modal.names.length, "item")}</strong>
                  </Message>}</p>
                {permanent && <p className="permanent-delete-note">{t("This action cannot be undone.")}</p>}
              </div>
            </div>
            : <label className="field">{t("Name")}
              <HistoryField historyKey={modal.kind + "-name"} aria-label={t("Name")} data-initial-focus value={name} type="text" required onValueChange={setName}
                onFocus={(event) => { if (modal.kind === "rename") event.currentTarget.select(); }} />
            </label>}
          {modal.kind === "newFile" && <label className="field new-file-encoding">{t("Encoding")}
            <select aria-label={t("Encoding")} value={encoding} disabled={waiting}
              onChange={(event) => setEncoding(event.target.value as TextEncoding)}>
              {Object.entries(textEncodingLabels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
            </select>
          </label>}
          {error && <p className="dialog-error" role="alert">{errorText(error)}</p>}
          {!modal.remote && windowsClient && isPermissionError(error) && <ElevationButton directory={modal.path} />}
        </div>
        <div className="dialog-footer">
          {!modal.remote && windowsClient && isLockError(error) && <Button type="button" onClick={() => setLockPaths(
            ("names" in modal ? modal.names : [modal.name]).filter(Boolean).map((name) => placePath(childPlace(localPath(modal.path), name))),
          )}>{t("Find locking processes")}</Button>}
          <Button type="button" data-initial-focus={removing ? true : undefined} onClick={onClose} disabled={waiting}>{t("Cancel")}</Button>
          <Button type="submit" className={permanent ? "permanent-delete-button" : removing ? undefined : "primary"}
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
        const { listing, ...connection } = await api.connect(value);
        onConnect({ kind: "server", ...connection, segments: [] }, listing);
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
