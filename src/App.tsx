import { workspaceResources, type Resource } from "./workspaceResources";
import { Button } from "./Button";
import { WindowControls } from "./WindowControls";
import { WindowResizeMarker } from "./ResizeGrip";
import { StatusFeedback, type WorkspaceStatus } from "./StatusFeedback";
import { HistoryField } from "./HistoryField";
import { SchemeOptions } from "./SchemeOptions";
import { CommandField } from "./CommandField";
import { clampSplit, SplitDivider } from "./SplitDivider";
import { timestampSeconds, useTimestamps } from "./useTimestamps";
import { commandHistoryGroups, historyLimit, readCommandHistory, saveCommandHistory, type CommandEntry } from "./commandHistory";
import { Fragment, lazy, Suspense, useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import {
  ArrowDownToLine, ArrowLeftRight, Bookmark, Braces, CheckSquare, ClipboardCopy, Coffee, Copy, Eye, EyeOff, FileDiff,
  FilePlus, FolderPlus, FolderTree, Calculator, CircleHelp, GitBranch, History, Moon, Pencil, Plug, RefreshCw,
  ScanEye, Search, Server, Settings2, Sun, Terminal as TerminalIcon, TextCursorInput, Trash2, type LucideIcon,
} from "lucide-react";
import { Channel, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { api, connectFtpLocation, describeError, folderLabel, isFileServer, isLockError, isPermissionError, placePath, smbHost, watchDirectory, writableTextPlace, windowsClient, type ArchivePlace, type Entry, type FtpPlace, type KSwitcherPeer, type Listing, type NamedFile, type Operation, type Place, type QuickLocation, type RemotePlace, type SizeResult, type SshPlace } from "./api";
import { smbLocation, type AdministratorWorkspace, type ConnectionSource, type FileLocation, type SavedConnection, type SshHostVerification } from "./api";
import { canAnalyze, spaceRelativePath, type SpaceItemCommand, type SpaceLocalItem, type SpacePlace } from "./spaceScan";
import type { SpaceAnalyzerHandle, SpaceNavigation } from "./SpaceAnalyzer";
import { useFilePaneTree, usePaneFolderSizes, usePaneTreeRevision } from "./filePaneTree";
import type { EnvironmentMode } from "./EnvironmentPane";
import { textEncodingLabels, type AppUpdate, type InstalledRelease, type TerminalCommand, type TerminalSession, type TextEncoding, type UpdateProgress } from "./api";
import { Dialog, readDialogSize } from "./Dialog";
import { ReleaseNotes } from "./ReleaseNotes";
import { reportFrontendError } from "./diagnostics";
import { AttributesDialog } from "./AttributesDialog";
import { connectionCommands, RemoveConnectionDialog, SavedConnectionDialog } from "./SavedConnectionDialog";
import { VerifyHostDialog } from "./SshDialog";
import { SmbDialog } from "./SmbDialog";
import { SudoDialog } from "./SudoDialog";
import { FileContextMenu } from "./FileContextMenu";
import { FolderShortcutsDialog, type FolderShortcutScreen } from "./FolderShortcutsDialog";
import { FileBookmarksDialog } from "./FileBookmarksDialog";
import { bookmarkFile, bookmarkKey, lineFingerprint, readFileBookmarks, saveFileBookmarks, type BookmarkJump, type FileBookmark } from "./fileBookmarks";
import { persistFolderShortcuts, readFolderShortcuts, shortcutFromPlace, type FolderGroup, type FolderShortcut } from "./folderShortcuts";
import type { HelpTopic } from "./helpTopics";
import { TerminalShortcutHint } from "./TerminalShortcutHint";
import { topicForControl, useHelpShortcut } from "./contextHelp";
import { AboutDialog, donationUrl, MainMenu, type MainMenuHandle, type MenuGroup } from "./MainMenu";
import { McpDialog, McpRequests } from "./McpDialog";
import { Pane } from "./Pane";
import { PaneSources, type PaneSource } from "./PaneSources";
import { NewFolderDialog } from "./NewFolderDialog";
import { ArchiveDialog, ArchivePasswordDialog, isArchiveName, passwordError } from "./ArchiveDialog";
import { SearchDialog } from "./SearchDialog";
import { ElevationButton, ElevationContext, LockDialog } from "./ProcessTools";
import { DeletionDialog } from "./DeletionDialog";
import { DiskInformation } from "./DiskInformation";
import type { Deletion } from "./api";
import { Settings } from "./Settings";
import { SortCriteriaDialog, SortMenu } from "./FileSortMenu";
import { defaultSortCriteria, sortMode, sortModes, type SortMode } from "./fileSort";
import { useFileSortMetadata } from "./useFileSortMetadata";
import { panelModeIds, panelModeName, type PanelModeId } from "./panelModes";
import { AppearancePicker } from "./AppearancePicker";
import type { AppearancePick } from "./appearancePick";
import type { FeaturePage } from "./featureOptions";
import { applyAppearance, fileTypeIndex, isLightTheme, resolveAppearance, selectAppearance, useSystemTheme } from "./appearance";
import { TextWindow, CompareDialog } from "./TextTools";
import { ImageDocument } from "./ImageDocument";
import { ImageEditor, type ImageEditorHandle } from "./ImageEditor";
import { canEditImage, imageType } from "./ImageViewport";
import { isMarkdownFile, type MarkdownLocation, type MarkdownPosition } from "./markdown";
import { TransferDialog, type Transfer } from "./TransferDialog";
import {
  applyListing, childPlace, closeSearchResults, emptyPane, filesystemPlace, formatSize, hasParentRow, localPath, opposite, paneCursorIndex, paneItem, parentPlace,
  readPlace, selectableRange, showSearchResults, SmbCredentialsRequired, toggleMarkAndMoveCursor, visibleEntries,
  type DeniedSshListing, type FilePaneView, type ListingAction, type PaneState, type Side, type SortColumn,
} from "./panes";
import { commandNames, commands, commandScope, driveSourceCommand, eventShortcut, flushPortablePreferences, folderGroupCommand, persistPreferences, bindingMatches, commandPanelMode, panelModeCommand, commandSortMode,
  compactShortcut, preferenceKey, preferenceSnapshot, quickSearchSeed, readPreferences, shortcutBindings, showShortcut, type Command, type Preferences, type SpaceAnalyzerView } from "./preferences";
import { countText, errorText, setLanguage, t } from "./i18n";
import { Message } from "./Message";
import { readWorkspace, restorePane, saveWorkspace, type DocumentWindow, type SavedFtpLocation } from "./workspace";
import { maxViewFontSize, minViewFontSize, type ZoomViewFont } from "./viewFonts";
import { shellArgument } from "./shell";

const TerminalPanel = lazy(() => import("./TerminalPanel"));
const HelpDialog = lazy(() => import("./HelpDialog"));
const QuickView = lazy(() => import("./QuickView"));
const SpaceAnalyzer = lazy(() => import("./SpaceAnalyzer"));
const GitView = lazy(() => import("./GitView"));
const EnvironmentPane = lazy(() => import("./EnvironmentPane"));
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
type RowRename = { side: Side; place: RenameLocation; name: string; treeKey?: string };
type AnalysisPane = {
  id: number; root: SpacePlace; location: { place: SpacePlace; reveal?: string };
  navigation: SpaceNavigation; initialView: SpaceAnalyzerView;
};
type DocumentTab = DocumentWindow & {
  position?: MarkdownPosition;
  bookmarkJump?: BookmarkJump;
  back?: MarkdownLocation[];
  forward?: MarkdownLocation[];
  imageIndex?: number;
  imageEditorOpened?: boolean;
  imageRevision?: number;
};

function sameRenameLocation(current: Place | null, place: RenameLocation) {
  return current !== null && current.kind === place.kind && placePath(current) === placePath(place) &&
    (place.kind === "local" || sameConnection(current, place));
}

type ActionModal = (
  | { kind: "rename" | "newFile"; path: string; name: string }
  | { kind: "recycle" | "delete"; path: string; names: string[]; directories?: string[]; relativePaths?: string[][] }
) & { remote?: FtpPlace | SshPlace; archive?: ArchivePlace };

type Modal =
  | { kind: "settings"; page?: FeaturePage }
  | { kind: "connect"; side: Side }
  | { kind: "smb"; side: Side; navigation: { path: string; complete: (place: Place, listing: Listing) => boolean } }
  | { kind: "connectionEditor"; side: Side; source: ConnectionSource; profile?: SavedConnection }
  | { kind: "removeConnection"; side: Side; profile: SavedConnection }
  | { kind: "verifyConnection"; side: Side; profile: SavedConnection; verification: SshHostVerification; approvals: readonly SshHostVerification[] }
  | { kind: "compare"; left: NamedFile; right: NamedFile }
  | { kind: "transfer"; side: Side; transfer: Transfer }
  | { kind: "deletion"; deletion: Deletion }
  | { kind: "search"; side: Side; place: FileLocation }
  | { kind: "mkdir"; side: Side; place: Extract<Place, { kind: "local" }> }
  | { kind: "createArchive"; side: Side; directory: string; names: string[] }
  | { kind: "archivePassword"; side: Side; path: string }
  | { kind: "sudoBrowse"; side: Side; target: DeniedSshListing }
  | { kind: "attributes"; item: NonNullable<ReturnType<typeof paneItem>> }
  | { kind: "folderShortcuts"; side: Side; screen: FolderShortcutScreen }
  | { kind: "fileBookmarks"; path?: string }
  | { kind: "sortMenu"; side: Side }
  | { kind: "sortCriteria"; side: Side; mode: SortMode }
  | { kind: "about" | "commandHistory" | "mcp" }
  | { kind: "exit"; update?: AppUpdate }
  | { kind: "update"; update: AppUpdate }
  | { kind: "whatsNew" }
  | { kind: "upToDate" }
  | { kind: "installUpdate"; version: string }
  | ActionModal;

const rowCommands = {
  firstRow: 0, lastRow: Number.POSITIVE_INFINITY, leftRow: 0, rightRow: Number.POSITIVE_INFINITY,
  upRow: -1, downRow: 1, pageUp: -12, pageDown: 12,
  selectUpRow: -1, selectDownRow: 1,
};

function isRangeCommand(command: Command) {
  return command === "selectUpRow" || command === "selectDownRow";
}

function isTerminalInput(target: EventTarget | null) {
  return target instanceof Element && target.closest(".terminal-surface") !== null;
}

function hasTerminalShortcutFocus(target: EventTarget | null) {
  return isTerminalInput(target) || (target instanceof Element && !!target.closest("[data-terminal-shortcut-help]"));
}

function contextHelpTopic(modal: Modal["kind"] | undefined, editing: boolean | undefined): HelpTopic {
  if (modal === "settings") return "general";
  if (modal === "search" || modal === "compare") return modal;
  if (modal === "connect" || modal === "smb" || modal === "connectionEditor") return "remote";
  if (modal === "createArchive" || modal === "archivePassword") return "archives";
  if (modal === "transfer" || modal === "mkdir" || modal === "delete" || modal === "recycle" || modal === "rename" || modal === "deletion") return "actionDialogs";
  return editing === undefined ? "files" : editing ? "editor" : "viewer";
}

function sameConnection(left: Place | null, right: Place) {
  return (left?.kind === "server" || isFileServer(left) || left?.kind === "archive") && left.kind === right.kind && left.id === right.id;
}

function sameDocumentFile(left: NamedFile, right: NamedFile) {
  return left.name === right.name && left.place.kind === right.place.kind &&
    placePath(left.place) === placePath(right.place) &&
    (right.place.kind === "local" || sameConnection(left.place, right.place));
}

function disconnect(place: Resource) {
  const close = place.kind === "archive" ? api.closeArchive : place.kind === "ssh" ? api.disconnectSsh : place.kind === "ftp" ? api.disconnectFtp : api.disconnect;
  void close(place.id).catch(() => {});
}

function swapSides<T>(panes: Record<Side, T>): Record<Side, T> {
  return { left: panes.right, right: panes.left };
}

export default function App({ initialPreferences, portableUpdateError, portableSettingsError, administrator,
  administratorWorkspace, administratorWorkspaceUnavailable }: {
  initialPreferences: Preferences;
  portableUpdateError?: string | null;
  portableSettingsError?: string | null;
  administrator?: boolean;
  administratorWorkspace?: AdministratorWorkspace | null;
  administratorWorkspaceUnavailable?: boolean;
}) {
  const [startup] = useState(() => administratorWorkspace ? null : readWorkspace());
  const [ready, setReady] = useState(false);
  const [panes, setPanes] = useState(() => ({
    left: { ...restorePane(startup?.panels.left), loading: true },
    right: { ...restorePane(startup?.panels.right), loading: true },
  }));
  const visiblePanes = useRef(panes);
  visiblePanes.current = panes;
  const [rowRename, setRowRename] = useState<RowRename | null>(null);
  const [locations, setLocations] = useState<QuickLocation[]>([]);
  const [sourceMenu, setSourceMenu] = useState<{ side: Side; returnFocus: HTMLElement | null } | null>(null);
  const [focusedSide, setActive] = useState<Side>(administratorWorkspace?.side ?? (startup?.active === "right" ? "right" : "left"));
  const [quickViewSource, setQuickViewSource] = useState<Side | null>(null);
  const [quickViewSourceText, setQuickViewSourceText] = useState(false);
  const [analysisPanes, setAnalysisPanes] = useState<Record<Side, AnalysisPane | null>>(() => {
    const panes: Record<Side, AnalysisPane | null> = { left: null, right: null };
    if (administratorWorkspace?.otherAnalyzer) {
      const place = localPath(administratorWorkspace.otherAnalyzer);
      panes[opposite(administratorWorkspace.side)] = { id: 1, root: place, location: { place },
        navigation: { segments: [], focus: false }, initialView: initialPreferences.spaceAnalyzerView ?? "tree" };
    }
    return panes;
  });
  const [diskPanes, setDiskPanes] = useState<Record<Side, string | null>>({ left: null, right: null });
  const analysisHandles = useRef<Record<Side, SpaceAnalyzerHandle | null>>({ left: null, right: null });
  const nextAnalysis = useRef(administratorWorkspace?.otherAnalyzer ? 1 : 0);
  const treeNavigation = useRef<Record<Side, number>>({ left: 0, right: 0 });
  const [fileRevision, setFileRevision] = useState(0);
  const [sshUploadRefresh, setSshUploadRefresh] = useState<number | null>(null);
  const [folderSizesEnabled, setFolderSizesEnabled] = useState({ left: false, right: false });
  const [gitView, setGitView] = useState<{ side: Side; source: Side; path: string } | null>(null);
  const [gitRefresh, setGitRefresh] = useState(0);
  const [swappedPanes, setSwappedPanes] = useState(false);
  const [environmentPanels, setEnvironmentPanels] = useState<Record<Side, EnvironmentMode | null>>({ left: null, right: null });
  const [environmentRevision, setEnvironmentRevision] = useState(0);
  const active = quickViewSource ?? focusedSide;
  const analysis = analysisPanes[active];
  const diskActive = diskPanes[active] !== null;
  const showingAnalysis = Boolean(analysisPanes.left || analysisPanes.right);
  const environmentActive = environmentPanels[active] !== null;
  const showingEnvironment = environmentPanels.left !== null || environmentPanels.right !== null;
  const previewSide = quickViewSource === null ? null : opposite(quickViewSource);
  const [processPanels, setProcessPanels] = useState<Record<Side, { path?: string } | null>>({ left: null, right: null });
  const [preferences, setPreferences] = useState(initialPreferences);
  const rowsPerGroup = useRef<Record<Side, number>>({ left: 0, right: 0 });
  const groupPageSize = useRef<Record<Side, number>>({ left: 0, right: 0 });
  const { theme, scheme } = resolveAppearance(preferences, useSystemTheme());
  const fileTypes = useMemo(() => fileTypeIndex(scheme?.fileTypes), [scheme?.fileTypes]);
  const followSystem = preferences.theme === "system" && preferences.activeScheme === null;
  const [modal, setModal] = useState<Modal | null>(null);
  const [localAppearancePick, setLocalAppearancePick] = useState<((pick: AppearancePick | null) => void) | null>(null);
  const [fileMenu, setFileMenu] = useState<{ side: Side; x: number; y: number; entry?: Entry } | null>(null);
  const [updateNotice, setUpdateNotice] = useState<Extract<Modal, { kind: "update" | "upToDate" }> | null>(null);
  const [installedRelease, setInstalledRelease] = useState<InstalledRelease | null | undefined>(undefined);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const checkingUpdates = useRef(false);
  const manualUpdateCheck = useRef(false);
  const installingUpdate = useRef(false);
  const [documents, setDocuments] = useState<DocumentTab[]>(startup?.documents ?? []);
  const [fileBookmarks, setFileBookmarks] = useState(readFileBookmarks);
  const bookmarkRequest = useRef(0);
  const [activeDocument, setActiveDocument] = useState<number | null>(startup?.activeDocument ?? null);
  const nextDocument = useRef(Math.max(0, ...(startup?.documents ?? []).map(({ id }) => id)));
  const dirtyDocuments = useRef(new Set<number>());
  const imageEditors = useRef(new Map<number, ImageEditorHandle>());
  const exitPending = useRef(false);
  const exitConfirmed = useRef(false);
  const busy = modal?.kind === "transfer";
  const [terminals, setTerminals] = useState<Record<string, TerminalSession>>({});
  const [terminalInputFocused, setTerminalInputFocused] = useState(false);
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
  const initialSplit = administratorWorkspace?.split ?? startup?.split;
  const [split, setSplit] = useState(initialSplit !== undefined && Number.isFinite(initialSplit) ? clampSplit(initialSplit) : 50);
  const [commandLine, setCommandLine] = useState("");
  const [pendingCommands, setPendingCommands] = useState<Record<number, TerminalCommand[]>>({});
  const commandInput = useRef<HTMLTextAreaElement>(null);
  const [historyItems, setHistoryItems] = useState(readCommandHistory);
  const commandTexts = useMemo(() => historyItems.map(({ text }) => text), [historyItems]);
  const localTerminalHistory = useMemo(() => historyItems.filter(({ source }) => source === "local").map(({ text }) => text), [historyItems]);
  const commandLineHistory = useMemo(() => historyItems.filter(({ source }) => source !== "ssh").map(({ text }) => text), [historyItems]);
  const historyIndex = useRef(-1);
  const selectionAnchor = useRef<{ left: string | null; right: string | null }>({ left: null, right: null });
  const startupError = (administratorWorkspaceUnavailable ? t("Could not restore the administrator workspace.") : undefined) ?? portableUpdateError ?? portableSettingsError;
  const [status, setStatus] = useState<WorkspaceStatus>({ text: startupError ?? "Ready", error: !!startupError });
  const [folderShortcuts, setFolderShortcuts] = useState(readFolderShortcuts);
  const request = useRef({ left: 0, right: 0 });
  const pendingListings = useRef<Partial<Record<Side, { controller: AbortController; background: boolean }>>>({});
  const terminalListings = useRef<Partial<Record<Side, number>>>({});
  const nextSession = useRef(0);
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
  const [comparisons, setComparisons] = useState<{ left: NamedFile; right: NamedFile }[]>([]);
  const retained = useRef(new Map<string, Resource>());
  useEffect(() => {
    const next = workspaceResources({
      panes, connections: connected.current, documents, analyzers: [analysisPanes.left?.root, analysisPanes.right?.root],
      comparisons: modal?.kind === "compare" ? [...comparisons, modal] : comparisons,
      transfer: modal?.kind === "transfer" ? modal.transfer : undefined,
    });
    for (const [key, place] of retained.current) if (!next.has(key)) disconnect(place);
    retained.current = next;
  }, [panes, documents, comparisons, modal, analysisPanes]);
  const pane = panes[active];
  const markedNames = {
    left: useMemo(() => new Set(panes.left.marked), [panes.left.marked]),
    right: useMemo(() => new Set(panes.right.marked), [panes.right.marked]),
  };
  const catalog = pane.place?.kind === "connections" ? pane.place : null;
  const other = panes[opposite(active)];
  const panesAvailable = !panelsHidden && activeDocument === null;
  const canSwapPanes = panesAvailable && (gitView !== null || !panes.left.loading && !panes.right.loading && !busy);
  const showingSortMenu = modal?.kind === "sortMenu" ? modal.side : undefined;
  const leftSort = useFileSortMetadata(panes.left, preferences.sortSettings, showingSortMenu === "left");
  const rightSort = useFileSortMetadata(panes.right, preferences.sortSettings, showingSortMenu === "right");
  const leftCanSort = leftSort.canSort;
  const rightCanSort = rightSort.canSort;
  const leftRoot = !panes.left.search && panes.left.place?.kind === "local" ? panes.left.place : null;
  const rightRoot = !panes.right.search && panes.right.place?.kind === "local" ? panes.right.place : null;
  const leftTreeOn = preferences.paneViews.left === "tree";
  const rightTreeOn = preferences.paneViews.right === "tree";
  const leftRevision = usePaneTreeRevision(leftRoot?.path, leftTreeOn || folderSizesEnabled.left, fileRevision);
  const rightRevision = usePaneTreeRevision(rightRoot?.path, rightTreeOn || folderSizesEnabled.right, fileRevision);
  const leftTree = useFilePaneTree(leftRoot, leftTreeOn, leftRevision);
  const rightTree = useFilePaneTree(rightRoot, rightTreeOn, rightRevision);
  const trees = { left: leftTree, right: rightTree };
  const folderSizes = {
    left: usePaneFolderSizes(panes.left, folderSizesEnabled.left, leftRevision),
    right: usePaneFolderSizes(panes.right, folderSizesEnabled.right, rightRevision),
  };
  const leftRootSizes = useMemo(() => folderSizes.left.measures(panes.left.entries), [folderSizes.left.measures, panes.left.entries]);
  const rightRootSizes = useMemo(() => folderSizes.right.measures(panes.right.entries), [folderSizes.right.measures, panes.right.entries]);
  const lists = {
    left: useMemo(() => visibleEntries(leftRootSizes ? { ...panes.left, backgroundSizes: leftRootSizes } : panes.left,
      preferences.hidden, preferences.sortSettings, leftCanSort,
      leftSort.metadata, leftSort.descriptions, leftSort.pending),
    [leftRootSizes, panes.left, preferences.hidden, preferences.sortSettings, leftCanSort, leftSort.metadata, leftSort.descriptions, leftSort.pending]),
    right: useMemo(() => visibleEntries(rightRootSizes ? { ...panes.right, backgroundSizes: rightRootSizes } : panes.right,
      preferences.hidden, preferences.sortSettings, rightCanSort,
      rightSort.metadata, rightSort.descriptions, rightSort.pending),
    [rightRootSizes, panes.right, preferences.hidden, preferences.sortSettings, rightCanSort, rightSort.metadata, rightSort.descriptions, rightSort.pending]),
  };
  const entries = {
    left: useMemo(() => leftTree.visible(panes.left, lists.left, preferences.hidden, preferences.sortSettings, leftCanSort, folderSizes.left.measures),
      [leftTree.visible, panes.left, lists.left, preferences.hidden, preferences.sortSettings, leftCanSort, folderSizes.left.measures]),
    right: useMemo(() => rightTree.visible(panes.right, lists.right, preferences.hidden, preferences.sortSettings, rightCanSort, folderSizes.right.measures),
      [rightTree.visible, panes.right, lists.right, preferences.hidden, preferences.sortSettings, rightCanSort, folderSizes.right.measures]),
  };
  const paneSizes = {
    left: useMemo(() => leftTree.enabled ? folderSizes.left.measures(entries.left) : leftRootSizes,
      [leftTree.enabled, folderSizes.left.measures, entries.left, leftRootSizes]),
    right: useMemo(() => rightTree.enabled ? folderSizes.right.measures(entries.right) : rightRootSizes,
      [rightTree.enabled, folderSizes.right.measures, entries.right, rightRootSizes]),
  };
  const reconcileTreeMarks = useEffectEvent((side: Side) => {
    if (!trees[side].enabled) return;
    updatePane(side, (pane) => {
      const marked = pane.marked.filter((key) => trees[side].lookup(pane, key) !== null);
      return marked.length === pane.marked.length ? pane : { ...pane, marked };
    });
  });
  useEffect(() => { reconcileTreeMarks("left"); }, [leftTree.branches]);
  useEffect(() => { reconcileTreeMarks("right"); }, [rightTree.branches]);
  const sorts = { left: leftSort, right: rightSort };
  const currentRow = entries[active][paneCursorIndex(pane, entries[active])];
  const current = currentRow?.name === ".." ? undefined : currentRow;
  const currentItem = paneItem(pane, current);
  const local = pane.place?.kind === "local" ? pane.place : null;
  function treeFolder(side: Side) {
    const state = panes[side];
    if (!trees[side].enabled || !state.selected) return null;
    const item = paneItem(state, trees[side].lookup(state, state.selected) ?? undefined);
    return item?.place.kind === "local" ? (item.entry.directory ? childPlace(item.place, item.entry.name) : item.place) : null;
  }
  const terminalLocation = analysis?.location.place ?? treeFolder(active) ?? pane.place;
  const terminalPlace = terminalLocation?.kind === "local" || terminalLocation?.kind === "ssh" ? terminalLocation : null;
  const terminalKey = terminalPlace ? terminalPlace.kind === "ssh" ? "ssh:" + terminalPlace.id : "local" : null;
  const terminal = terminalKey ? terminals[terminalKey] : undefined;
  const ftp = pane.place?.kind === "ftp" ? pane.place : undefined;
  const archive = pane.place?.kind === "archive" ? pane.place : undefined;
  const fileServer = isFileServer(pane.place) ? pane.place : undefined;
  const permanentDelete = Boolean(fileServer || smbHost(local));
  const otherFileServer = !other.search && isFileServer(other.place);
  const canTransfer = Boolean(currentItem);
  const shortcuts = shortcutBindings(preferences);
  const editingDocument = documents.find(({ id }) => id === activeDocument)?.editing;
  const [helpRequest, setHelpTopic] = useHelpShortcut(shortcuts.help, contextHelpTopic(modal?.kind, editingDocument));
  const helpTopic = helpRequest?.topic;
  const terminalFocusHint = (terminalInputFocused || helpTopic === "terminalShortcuts") && terminalVisible && terminal && activeDocument === null
    ? <TerminalShortcutHint panelsHidden={panelsHidden} onHelp={() => setHelpTopic("terminalShortcuts")} /> : undefined;

  const checkUpdates = useCallback(async (manual: boolean) => {
    if (manual) {
      manualUpdateCheck.current = true;
      setStatus({ text: "Checking for updates…" });
    }
    if (checkingUpdates.current) return;
    checkingUpdates.current = true;
    try {
      const update = await api.checkForUpdate(manual ? "manual" : "automatic");
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
    if (!isTauri()) return;
    let current = true;
    void api.installedRelease().then((release) => {
      if (current) setInstalledRelease(release);
    }, (error: unknown) => {
      if (current) setInstalledRelease(null);
      reportFrontendError("installed_release", error);
    });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    if (modal || helpTopic || installedRelease === undefined) return;
    if (installedRelease?.showOnStartup) {
      setInstalledRelease({ ...installedRelease, showOnStartup: false });
      setModal({ kind: "whatsNew" });
      return;
    }
    if (!updateNotice) return;
    setModal(updateNotice);
    setUpdateNotice(null);
  }, [updateNotice, installedRelease, modal, helpTopic]);

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
      mainMenu.current?.open();
    }
    const reset = () => { singleAlt = false; };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", reset);
    window.addEventListener("pointerdown", reset, true);
    window.addEventListener("wheel", reset, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", reset);
      window.removeEventListener("pointerdown", reset, true);
      window.removeEventListener("wheel", reset, true);
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
    pendingListings.current[side]?.controller.abort();
    delete pendingListings.current[side];
    return request.current[side];
  }, []);

  const beginListing = useCallback((side: Side, background = false) => {
    const ticket = invalidateListing(side);
    const controller = new AbortController();
    pendingListings.current[side] = { controller, background };
    return { ticket, signal: controller.signal };
  }, [invalidateListing]);

  function cancelLoading(side: Side, pending = latest.current[side].loading) {
    if (!pending) return false;
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
    const { ticket, signal } = beginListing(side, background);
    if (!background) updatePane(side, (pane) => ({
      ...pane, loading: true, loadingPath: placePath(place), error: "", elevationPath: undefined,
      deniedSshListing: elevated ? pane.deniedSshListing : undefined,
    }));
    const complete = (openedPlace: Place, openedListing: Listing, sudoListing?: boolean) => {
      if (ticket !== request.current[side]) return false;
      if (action === "push" || typeof action === "number") delete failedFtp.current[side];
      const revealed = reveal !== undefined ? openedListing.entries.find((entry) => entry.name === reveal) : undefined;
      const found = reveal === ".." ? hasParentRow(openedPlace) : !!revealed;
      if (reveal !== undefined && reveal !== ".." && !found) setStatus({ text: t("Item no longer found: {0}", reveal), error: true });
      updatePane(side, (pane) => {
        if (background && pane.place !== place) return pane;
        const listing = { ...applyListing(pane, openedPlace, openedListing, action), sudoListing };
        if (background) Object.assign(listing, { error: pane.error, elevationPath: pane.elevationPath, deniedSshListing: pane.deniedSshListing });
        return found && reveal !== undefined ? { ...listing, selected: reveal, revealedHidden: revealed?.hidden ? reveal : undefined, filter: "", marked: [] } : listing;
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
        updatePane(side, (pane) => background && (pane.place !== place || pane.error) ? pane : {
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
    if (sshUploadRefresh === null) return;
    const folders = (["left", "right"] as const).flatMap((side) => {
      const { place, loading } = panes[side];
      return place?.kind === "ssh" && place.id === sshUploadRefresh ? [{ side, place, loading }] : [];
    });
    // Let any navigation settle before rereading the directory on the upload's connection.
    if (folders.some(({ side, loading }) => loading || pendingListings.current[side]?.background === false)) return;
    setSshUploadRefresh(null);
    for (const { side, place } of folders) void load(side, place, "refresh");
  }, [sshUploadRefresh, panes, load]);

  useEffect(() => {
    let cancelled = false;
    // Show the native window after React commits the controls, before restoring any listings.
    const shown = isTauri() ? getCurrentWindow().show().catch((error: unknown) => {
      reportFrontendError("show_window", error, "native_error");
    }) : Promise.resolve();
    void shown.then(() => Promise.all([api.locations(), administratorWorkspace ? null : api.requestedLocation()])).then(async ([locations, requested]) => {
      if (cancelled) return;
      setLocations(locations);
      const home = locations[0];
      const alternate = locations.find(({ label }) => label === "Downloads") ?? home;
      if (home && alternate) {
        await Promise.all(([["left", home.path], ["right", alternate.path]] as const).map(async ([side, fallback]) => {
          if (request.current[side] !== 0) return;
          const elevationTarget = administratorWorkspace?.side === side ? administratorWorkspace : null;
          const elevationFolder = elevationTarget?.directory ?? administratorWorkspace?.otherFolder;
          const requestedFolder = elevationFolder ? localPath(elevationFolder) : side === "left" && requested ? filesystemPlace(requested) : null;
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
          if (!local || !await load(side, local, requestedFolder ? "push" : "refresh", elevationTarget?.selected ?? undefined)) {
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
  }, [administratorWorkspace, beginListing, load, startup, updatePane]);

  useEffect(() => {
    if (!ready || !administratorWorkspace) return;
    const frame = requestAnimationFrame(() => document.getElementById(administratorWorkspace.side + "-files")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [administratorWorkspace, ready]);

  const administratorTitle = administrator ? `Dirlume (${t("Administrator")})` : undefined;
  useEffect(() => {
    if (administratorTitle && isTauri()) void getCurrentWindow().setTitle(administratorTitle).catch(() => {});
  }, [administratorTitle]);

  useEffect(() => {
    if (ready) saveWorkspace(panes, active, split, terminalHeight, documents, activeDocument, failedFtp.current);
  }, [ready, panes, active, split, terminalHeight, documents, activeDocument]);

  useEffect(() => {
    try { saveFileBookmarks(fileBookmarks); }
    catch (error) { setStatus({ text: describeError(error), error: true }); }
  }, [fileBookmarks]);

  const leftPath = (ready || !panes.left.loading) && panes.left.place?.kind === "local" ? panes.left.place.path : null;
  const rightPath = (ready || !panes.right.loading) && panes.right.place?.kind === "local" ? panes.right.place.path : null;
  const showingGit = gitView !== null;
  const leftEnvironment = environmentPanels.left !== null;
  const rightEnvironment = environmentPanels.right !== null;
  const leftAnalyzing = analysisPanes.left !== null;
  const rightAnalyzing = analysisPanes.right !== null;
  useEffect(() => {
    const locations = [["left", leftPath, leftEnvironment || leftAnalyzing], ["right", rightPath, rightEnvironment || rightAnalyzing]] as const;
    const stopWatching = locations.map(([side, path, covered]) => {
      if (!path || covered || showingGit) return () => {};
      let stopped = false;
      let timer: number | undefined;
      const refreshWatchedFolder = () => {
        const current = latest.current[side];
        if (stopped || current.place?.kind !== "local" || current.place.path !== path) return;
        if (pendingListings.current[side]) timer = window.setTimeout(refreshWatchedFolder, 150);
        else void load(side, current.place, "background");
      };
      const watch = watchDirectory(path, () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(refreshWatchedFolder, 150);
      });
      void watch.ready.catch(() => {});
      return () => {
        stopped = true;
        window.clearTimeout(timer);
        watch.stop();
      };
    });
    return () => stopWatching.forEach((stop) => stop());
  }, [leftPath, rightPath, load, leftAnalyzing, rightAnalyzing, showingGit, leftEnvironment, rightEnvironment]);

  const leftRemote = panes.left.place?.kind !== "local" ? panes.left.place : null;
  const rightRemote = panes.right.place?.kind !== "local" ? panes.right.place : null;
  useEffect(() => {
    if (!leftRemote && !rightRemote) return;
    const timer = window.setInterval(() => {
      for (const side of ["left", "right"] as const) {
        if (showingGit || (side === "left" ? leftEnvironment || leftAnalyzing : rightEnvironment || rightAnalyzing)) continue;
        const { place } = latest.current[side];
        if (place && place.kind !== "local" && place.kind !== "connections") void load(side, place, "background");
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [leftRemote, rightRemote, load, leftAnalyzing, rightAnalyzing, showingGit, leftEnvironment, rightEnvironment]);

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

  useLayoutEffect(() => applyAppearance(theme, scheme, document.documentElement, preferences.retainedFonts),
    [theme, scheme, preferences.retainedFonts]);

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
  }, [scheme, theme, preferences.actionButtonWidth, preferences.hideActionButtonIcons, preferences.layout]);

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
      const nativeTheme = followSystem ? null : isLightTheme(theme) ? "light" : "dark";
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

  async function confirmExit(update?: AppUpdate) {
    if (update) { installUpdate(update); return; }
    exitConfirmed.current = true;
    try {
      await getCurrentWindow().close();
    } catch (error) {
      exitConfirmed.current = false;
      setModal(null);
      setStatus({ text: describeError(error), error: true });
    }
  }

  async function requestExit(update?: AppUpdate) {
    if (exitPending.current) return;
    exitPending.current = true;
    try {
      setModal(null);
      for (const id of dirtyDocuments.current) {
        const editor = imageEditors.current.get(id);
        if (editor && !await editor.confirmClose()) {
          if (update) setModal({ kind: "update", update });
          return;
        }
      }
      if (Array.from(dirtyDocuments.current).some((id) => !imageEditors.current.has(id))) setModal({ kind: "exit", update });
      else await confirmExit(update);
    } finally {
      exitPending.current = false;
    }
  }

  const requestWindowExit = useEffectEvent(() => { void requestExit(); });

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
        requestWindowExit();
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

  function dismissWhatsNew() {
    void api.acknowledgeRelease().catch((error: unknown) => {
      setStatus({ text: describeError(error), error: true });
    }).finally(() => setModal((current) => current?.kind === "whatsNew" ? null : current));
  }

  function workspaceMenuHasFocus() {
    return !!document.activeElement?.closest(".main-menu, .location-popup");
  }

  function focus(side: Side) {
    if (workspaceMenuHasFocus()) return;
    side = quickViewSource ?? side;
    setActive(side);
    if (analysisHandles.current[side]) {
      analysisHandles.current[side]?.focus();
      return;
    }
    document.getElementById(side + (diskPanes[side] ? "-disk-information" : environmentPanels[side] ? "-environment" : "-files"))?.focus();
  }

  function paneCovered(side: Side) {
    return !!gitView || environmentPanels[side] !== null || side === previewSide || !!analysisPanes[side] || !!diskPanes[side];
  }

  function closeSourceMenu(restoreFocus: boolean) {
    setSourceMenu(null);
    if (restoreFocus) requestAnimationFrame(() => {
      if (workspaceMenuHasFocus()) return;
      const previous = sourceMenu?.returnFocus;
      if (previous?.isConnected && !previous.closest("[inert], [hidden]")) previous.focus({ preventScroll: true });
      else focus(active);
    });
  }

  function toggleSourceMenu(side: Side) {
    if (sourceMenu?.side === side) { closeSourceMenu(true); return; }
    const previous = sourceMenu?.returnFocus ?? document.activeElement;
    setPanelsHidden(false);
    setSourceMenu({ side, returnFocus: previous instanceof HTMLElement ? previous : null });
  }

  function revealWorkspaceSide(side: Side) {
    if (gitView) setGitView(null);
    if (environmentPanels[side]) setEnvironmentPanels((panels) => ({ ...panels, [side]: null }));
    if (analysisPanes[side]) setAnalysisPanes((current) => ({ ...current, [side]: null }));
    if (diskPanes[side]) setDiskPanes((current) => ({ ...current, [side]: null }));
    if (side === previewSide) setQuickViewSource(null);
  }

  function focusRevealedSide(side: Side) {
    requestAnimationFrame(() => {
      if (workspaceMenuHasFocus()) return;
      setActive(side);
      document.getElementById(side + "-files")?.focus({ preventScroll: true });
    });
  }

  function openPaneSource(side: Side, source: PaneSource) {
    closeSourceMenu(false);
    revealWorkspaceSide(side);
    if (source === "processes") showProcesses(side, true);
    else if (typeof source === "string") openConnections(side, source);
    else {
      const other = panes[opposite(side)].place;
      const otherDrive = other?.kind === "local" && /^([a-z]:)(?:[\\/]|$)/i.exec(other.path)?.[1]?.toUpperCase();
      const path = driveSourceCommand(source) && other?.kind === "local" && otherDrive === source.label.toUpperCase()
        ? other.path : source.path;
      showProcesses(side, false);
      void load(side, filesystemPlace(path));
    }
    focusRevealedSide(side);
  }

  function paneSources(side: Side, overlay = false) {
    return <PaneSources side={side} overlay={overlay} open={sourceMenu?.side === side && (overlay || !paneCovered(side))}
      locations={locations} shortcuts={shortcuts} onToggle={() => toggleSourceMenu(side)} onClose={closeSourceMenu}
      onPick={(source) => openPaneSource(side, source)} />;
  }

  function selectDocument(id: number | null) {
    setActiveDocument(id);
    if (id === null && !panelsHidden) {
      const document = documents.find((tab) => tab.id === activeDocument);
      const source = document?.imageOrigin ?? active;
      if (document?.imageOrigin) {
        const file = document.file;
        const row = entries[source].find((entry) => {
          const candidate = fileFor(source, entry);
          return candidate && sameDocumentFile(candidate, file);
        });
        if (row) updatePane(source, (pane) => ({ ...pane, selected: row.name }));
      }
      requestAnimationFrame(() => focus(source));
    }
  }

  const workspaceKeys = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (modal || helpTopic || event.defaultPrevented || event.isComposing || isTerminalInput(event.target)) return;
    if (event.target instanceof Element && event.target.closest("dialog[open]")) return;
    const shortcut = eventShortcut(event);
    if (event.getModifierState("AltGraph") && /^Digit[0-9]$/.test(event.code)) return;
    const settingsMatch = bindingMatches(shortcuts.settings, shortcut) ||
      (shortcuts.settings.includes(commands.settings.key) && event.code === "KeyS" &&
        !event.getModifierState("AltGraph") && eventShortcut(event, "S") === commands.settings.key);
    if (settingsMatch) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) openSettings();
      return;
    }
    const element = event.target instanceof HTMLElement ? event.target : null;
    if (element?.closest("[role=menu], .inline-rename")) return;
    if (activeDocument === null && shortcut) {
      const command = commandNames.find((name) => name !== "settings" && commandScope(name) === "main" && bindingMatches(shortcuts[name], shortcut));
      const sourceSide = command === "leftLocations" ? "left" : command === "rightLocations" ? "right" : null;
      const bookmark = command && folderGroupCommand(command);
      const inField = element?.closest("input, select, textarea, [contenteditable]");
      const inSources = element?.closest(".location-popup");
      const openBookmark = bookmark && !bookmark.add && !panelsHidden && !inSources &&
        (!inField || !!inField.closest(".git-pane, .environment-pane, .quick-view, .space-analyzer"));
      if (sourceSide || openBookmark) {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        if (sourceSide) toggleSourceMenu(sourceSide);
        else if (openBookmark) {
          const focused = element?.closest<HTMLElement>("[data-pane-side]")?.dataset.paneSide;
          openFolderGroup(focused === "left" || focused === "right" ? focused : active, bookmark.group);
        }
        return;
      }
      if (inSources) return;
    }
    if (!gitView && !environmentActive && bindingMatches(shortcuts.cancelMeasure, shortcut) && activeDocument === null &&
        !panelsHidden && cancelFolderOperation(active)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const direction = bindingMatches(shortcuts.nextDocument, shortcut) ? 1 : bindingMatches(shortcuts.previousDocument, shortcut) ? -1 : 0;
    if (shortcut && direction && documents.length) {
      event.preventDefault();
      event.stopPropagation();
      const ids = [null, ...documents.map(({ id }) => id)];
      const index = ids.indexOf(activeDocument);
      selectDocument(ids[(index + direction + ids.length) % ids.length]);
      return;
    }
    const noControl = !element?.closest(".app");
    if (noControl && bindingMatches(shortcuts.attributes, shortcut)) return;
    const inTitlebar = element?.closest(".topbar") && !element.closest("select, input");
    const hasModifier = event.ctrlKey || event.altKey || event.metaKey || /^F\d+$/.test(event.key);
    if ((!noControl && (!inTitlebar || !hasModifier)) ||
        !shortcut || !commandNames.some((command) => bindingMatches(shortcuts[command], shortcut))) return;
    const selector = activeDocument !== null ? ".text-window:not([hidden])" : panelsHidden ? ".terminal-card:not([hidden])" :
      gitView ? ".git-pane" : environmentActive ? "#" + active + "-environment" : `#${active}-files`;
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

  function openDocument(file: NamedFile, editing: boolean, position?: MarkdownPosition, origin?: Side, diagnosticLog?: true, bookmarkJump?: BookmarkJump) {
    const image = !!imageType(file.name);
    const existing = documents.find((item) => item.diagnosticLog === diagnosticLog &&
      (image || item.editing === editing) && sameDocumentFile(item.file, file));
    const id = existing?.id ?? ++nextDocument.current;
    const imageOrigin = image ? origin : undefined;
    const imageIndex = imageOrigin ? imagesInPane(imageOrigin, file).findIndex((candidate) => sameDocumentFile(candidate, file)) : undefined;
    const canEdit = editing && (!image || canEditImage(file));
    if (!existing) {
      setDocuments((current) => [...current, { id, file, editing: canEdit, position, imageOrigin, imageIndex, diagnosticLog, bookmarkJump }]);
    } else if (position || image || bookmarkJump) {
      setDocuments((current) => current.map((tab) => tab.id === id
        ? { ...tab, position: bookmarkJump ? undefined : position ?? tab.position, bookmarkJump,
          imageOrigin: imageOrigin ?? tab.imageOrigin, imageIndex: imageIndex ?? tab.imageIndex,
          editing: canEdit, imageEditorOpened: image && (tab.imageEditorOpened || tab.editing) }
        : tab));
    }
    selectDocument(id);
  }

  function updateFileBookmark(bookmark: FileBookmark, change: (current: FileBookmark) => FileBookmark | null) {
    const key = bookmarkKey(bookmark.path, bookmark.line);
    setFileBookmarks((items) => items.flatMap((item) => {
      if (bookmarkKey(item.path, item.line) !== key) return [item];
      const next = change(item);
      return next ? [next] : [];
    }));
  }

  function addFileBookmark(path: string, line: number, text: string) {
    const key = bookmarkKey(path, line);
    setFileBookmarks((items) => items.some((item) => bookmarkKey(item.path, item.line) === key) ? items :
      [...items, { path, line, fingerprint: lineFingerprint(text) }]);
  }

  function openFileBookmark(bookmark: FileBookmark) {
    const file = bookmarkFile(bookmark.path);
    if (!file) return;
    setModal(null);
    openDocument(file, false, undefined, undefined, undefined,
      { line: bookmark.line, fingerprint: bookmark.fingerprint, request: ++bookmarkRequest.current });
  }

  function followMarkdownLink(id: number, from: NamedFile, file: NamedFile, position: MarkdownPosition, scrollTop: number) {
    setDocuments((current) => current.map((tab) => tab.id !== id || tab.file !== from ? tab : {
      ...tab, file, position, bookmarkJump: undefined, forward: [],
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
        ...tab, ...target, bookmarkJump: undefined,
        [direction]: history.slice(0, -1),
        [opposite]: [...(tab[opposite] ?? []), { file: tab.file, position: { scrollTop } }],
      };
    }));
  }

  function closeDocument(id: number) {
    const index = documents.findIndex((document) => document.id === id);
    if (index < 0) return;
    const remaining = documents.filter((document) => document.id !== id);
    setDocuments(remaining);
    dirtyDocuments.current.delete(id);
    if (activeDocument === id) {
      selectDocument(imageType(documents[index].file.name) ? null : documents[index - 1]?.id ?? null);
    }
  }

  async function openErrorLog() {
    try {
      const path = await api.errorLog();
      if (!path) {
        setStatus({ text: "No errors have been logged yet." });
        return;
      }
      const end = Math.max(path.lastIndexOf("/"), windowsClient ? path.lastIndexOf("\\") : -1);
      openDocument({ place: { kind: "local", path: path.slice(0, end), parent: null }, name: path.slice(end + 1) },
        false, undefined, undefined, true);
      setStatus({ text: "Ready" });
    } catch (error) {
      setStatus({ text: describeError(error), error: true });
    }
  }

  function documentKeys(event: KeyboardEvent) {
    if (modal || helpTopic || event.defaultPrevented || event.nativeEvent.isComposing) return;
    if ((event.target as HTMLElement).closest("dialog[open]")) return;
    const shortcut = eventShortcut(event);
    if (!shortcut) return;
    const resize = bindingMatches(shortcuts.expandTerminal, shortcut) ? 1 : bindingMatches(shortcuts.collapseTerminal, shortcut) ? -1 : 0;
    if (resize && activeDocument === null) {
      event.preventDefault();
      event.stopPropagation();
      resizeTerminal(resize);
      return;
    }
    if (isTerminalInput(event.target)) {
      // Only terminal layout shortcuts need to intercept keys before xterm processes them.
      const toggle = bindingMatches(shortcuts.toggleTerminal, shortcut);
      if (toggle || bindingMatches(shortcuts.terminal, shortcut)) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) {
          if (toggle) toggleTerminal();
          else perform("terminal");
        }
      }
      return;
    }
    if (bindingMatches(shortcuts.menu, shortcut) || bindingMatches(shortcuts.menuAlternate, shortcut)) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) perform("menu");
    }
  }

  function routeLocation(side: Side, place: Place, listing: Listing, reveal?: string) {
    showProcesses(side, false);
    cancelScan(side);
    invalidateListing(side);
    delete failedFtp.current[side];
    const previous = connected.current[side];
    if (previous && !sameConnection(previous, place) && !sameConnection(connected.current[opposite(side)], previous)) {
      if (previous.kind === "ssh") dropTerminal("ssh:" + previous.id);
    }
    connected.current[side] = place.kind === "server" || isFileServer(place) ? place : null;
    setActive(side);
    updatePane(side, (pane) => {
      if (place.kind === "smbRoot" && pane.place?.kind === "smbRoot" && pane.place.path === place.path) {
        return applyListing(pane, place, listing, "refresh");
      }
      const history = pane.history.slice(0, pane.position + 1).filter((location) => location.kind === "local");
      const opened = applyListing({ ...pane, history, position: history.length - 1 }, place, listing, "push");
      const revealed = reveal === undefined ? undefined : listing.entries.find((entry) => entry.name === reveal);
      return revealed ? { ...opened, selected: revealed.name, revealedHidden: revealed.hidden ? revealed.name : undefined, marked: [], filter: "" } : opened;
    });
  }

  const resolveSpacePlace = useCallback((place: SpacePlace): SpacePlace => {
    if (place.kind !== "server" && !isFileServer(place)) return place;
    const connections = Object.values(connected.current);
    if (connections.some((connection) => sameConnection(connection, place))) return place;
    const shared = connections.find((connection) => connection?.kind === place.kind &&
      (connection.kind === "server" ? place.kind === "server" && connection.origin === place.origin && connection.share === place.share
        : isFileServer(place) && connection.profileId === place.profileId));
    return shared ? { ...place, id: shared.id } : place;
  }, []);

  function diskPath(side: Side) {
    const place = analysisPanes[side]?.location.place ?? treeFolder(side) ?? panes[side].place;
    return place?.kind === "local" ? place.path : null;
  }

  function openDiskInformation(side: Side) {
    const path = diskPath(side);
    if (!path || !canSelectPanelMode(side)) return;
    if (diskPanes[side]) { focus(side); return; }
    setAnalysisPanes((current) => ({ ...current, [side]: null }));
    setDiskPanes((current) => ({ ...current, [side]: path }));
    setActive(side);
  }

  function closeDiskInformation(side: Side) {
    setDiskPanes((current) => ({ ...current, [side]: null }));
    focusRevealedSide(side);
  }

  function openSpaceAnalyzer(side: Side, place: SpacePlace, moveFocus = true, defaultView: SpaceAnalyzerView = "tree") {
    if (pendingListings.current[side]) invalidateListing(side);
    setQuickViewSource(null);
    if (diskPanes[side]) setDiskPanes((current) => ({ ...current, [side]: null }));
    const next = { id: ++nextAnalysis.current, root: place, location: { place }, navigation: { segments: [], focus: moveFocus },
      initialView: preferences.spaceAnalyzerView ?? defaultView };
    setAnalysisPanes((current) => ({ ...current, [side]: next }));
    if (moveFocus) setActive(side);
  }

  function closeSpaceAnalyzer(side: Side) {
    setAnalysisPanes((current) => ({ ...current, [side]: null }));
    setActive(side);
    requestAnimationFrame(() => focus(side));
  }

  function navigateAnalysis(side: Side, place: SpacePlace, focusTree: boolean) {
    const current = analysisPanes[side];
    const segments = current ? spaceRelativePath(current.root, place) : null;
    if (!current || !segments) {
      openSpaceAnalyzer(side, place, focusTree);
      return;
    }
    setAnalysisPanes((panes) => panes[side]?.id !== current.id ? panes : ({
      ...panes, [side]: { ...current, location: { place }, navigation: { segments, focus: focusTree, revealTree: focusTree } },
    }));
  }

  function selectAnalysisLocation(side: Side, id: number, location: AnalysisPane["location"]) {
    setAnalysisPanes((panes) => {
      const current = panes[side];
      if (!current || current.id !== id || current.location.reveal === location.reveal &&
          placePath(current.location.place) === placePath(location.place)) return panes;
      return { ...panes, [side]: { ...current, location } };
    });
  }

  function closeGitView() {
    if (!gitView) return;
    const { source } = gitView;
    setGitView(null);
    setActive(source);
    requestAnimationFrame(() => focus(source));
  }

  function showEnvironment(side: Side, mode: EnvironmentMode | null) {
    if (mode && !environmentPanels[side] && pendingListings.current[side] && !cancelLoading(side)) {
      invalidateListing(side);
    }
    setQuickViewSource(null);
    setEnvironmentPanels((panels) => ({ ...panels, [side]: mode }));
    setActive(side);
    if (!mode) focusRevealedSide(side);
  }

  async function revealSpace(side: Side, place: SpacePlace, reveal?: string) {
    const target = opposite(side);
    if (place.kind !== "server" && !isFileServer(place) || sameConnection(connected.current[target], place)) {
      if (processPanels[target]) showProcesses(target, false);
      if (!await load(target, place, "push", reveal)) throw new Error(t("Could not open the selected location."));
      revealWorkspaceSide(target);
      requestAnimationFrame(() => focus(target));
      return;
    }
    const { ticket, signal } = beginListing(target);
    try {
      const result = await waitForListing(readPlace(place), signal);
      if (!result || ticket !== request.current[target]) return;
      if (reveal !== undefined && !result.listing.entries.some((entry) => entry.name === reveal)) {
        throw new Error(t("File no longer found: {0}", reveal));
      }
      routeLocation(target, result.place, result.listing, reveal);
    } finally {
      if (ticket === request.current[target]) delete pendingListings.current[target];
    }
  }

  async function revealProcessExecutable(side: Side, path: string) {
    const split = Math.max(path.lastIndexOf("/"), windowsClient ? path.lastIndexOf("\\") : -1);
    if (split < 0 || split + 1 === path.length) throw new Error(t("The process executable path is unavailable."));
    await revealSpace(side, localPath(path.slice(0, split + 1)), path.slice(split + 1));
  }

  function open(side: Side, entry: Entry, selectParent = false) {
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
      if (entry.tree && !file.link) { toggleTreeBranch(side, entry); return; }
      void load(side, childPlace(place, file.name), "push", selectParent && place.kind === "local" ? ".." : undefined);
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

  async function openSavedConnection(side: Side, profile: SavedConnection, approvals: readonly SshHostVerification[] = []) {
    const location = panes[side].place;
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
          const result = await api.connectSsh(profile.id, approvals);
          if (result.kind === "verifyHost") {
            if (request.current[side] !== ticket) break;
            if (activeModal.current) throw new Error(t("Open this connection again to verify its host key."));
            const verification = { kind: "verifyConnection", side, profile, verification: result.verification, approvals } as const;
            activeModal.current = verification;
            setModal(verification);
          } else {
            const { id, address, origin, segments, listing } = result;
            const catalogSource = location?.kind === "connections" && location.source === "ftp" ? "ftp" : undefined;
            complete({ kind: "ssh", profileId: profile.id, id, address, origin, segments, catalogSource }, listing);
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
      const { listing, ...opened } = await api.openArchive(path, password);
      if (signal.aborted || ticket !== request.current[side]) { await api.closeArchive(opened.id); return; }
      const place: ArchivePlace = { ...opened, kind: "archive", segments: [],
        address: opened.writable ? "Archive" : "Read-only archive" };
      updatePane(side, (pane) => applyListing(pane, place, listing, "push"));
    } catch (error) {
      if (!signal.aborted && ticket === request.current[side]) throw error;
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

  function openFolderGroup(side: Side, number: FolderGroup) {
    const group = folderShortcuts[number];
    if (!group.length) setStatus({ text: t("No folder shortcuts in group {0}.", number) });
    else if (group.length === 1) void openFolderShortcut(side, group[0]);
    else setModal({ kind: "folderShortcuts", side, screen: { kind: "picker", group: number, selection: 0 } });
  }

  function closeFolderShortcuts(side: Side) {
    setModal(null);
    requestAnimationFrame(() => {
      if (!document.activeElement?.closest(".pane")) focus(side);
    });
  }

  async function openFolderShortcut(side: Side, entry: FolderShortcut) {
    if (paneCovered(side)) {
      revealWorkspaceSide(side);
      focusRevealedSide(side);
    }
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
    if (previewSide || showingAnalysis || environmentPanels[opposite(side)] || !windowsClient || item?.place.kind !== "local") return;
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
    if (place && !loading) {
      if (trees[side].enabled) setFileRevision((revision) => revision + 1);
      void load(side, place, "refresh");
    }
  }

  function toggleTreeBranch(side: Side, entry: Entry) {
    if (!entry.tree || !entry.directory || entry.link) return;
    trees[side].toggle(entry);
    if (entry.tree.expanded) updatePane(side, (pane) => pane.selected?.startsWith(entry.name + "/")
      ? { ...pane, selected: entry.name } : pane);
  }

  async function setFilePaneView(side: Side, view: FilePaneView) {
    const pane = panes[side];
    if (pane.loading || pane.search || pane.place?.kind !== "local" || preferences.paneViews[side] === view) return;
    if (view === "list" && pane.selected?.includes("/")) {
      const row = trees[side].lookup(pane, pane.selected);
      const item = paneItem(pane, row ?? undefined);
      if (item && !await load(side, item.place, "push", item.entry.name)) return;
    }
    if (view === "list") updatePane(side, (current) => ({ ...current,
      selected: current.selected?.includes("/") ? null : current.selected,
      marked: current.marked.filter((key) => !key.includes("/")),
    }));
    setPreferences((before) => ({ ...before, paneViews: { ...before.paneViews, [side]: view } }));
    requestAnimationFrame(() => focus(side));
  }

  function sort(side: Side, column: SortColumn, fromHeading = false) {
    const mode = sortMode(column);
    const catalog = panes[side].place?.kind === "connections";
    if ((!canSelectPanelMode(side) && !(fromHeading && catalog)) || !sorts[side].canSort(mode)) return;
    updatePane(side, (pane) => ({
      ...pane, sort: { ...pane.sort, column, asc: mode === sortMode(pane.sort.column) ? !pane.sort.asc : sortModes[mode].asc },
    }));
  }

  function showSortMenu(side: Side) {
    if (canSelectPanelMode(side)) setModal({ kind: "sortMenu", side });
  }

  function changeSortDirection(side: Side, asc: boolean) {
    updatePane(side, (pane) => ({ ...pane, sort: { ...pane.sort, asc } }));
  }

  function toggleSortPriority(side: Side, field: "directoriesFirst" | "markedFirst" | "groups") {
    if (!canSelectPanelMode(side)) return;
    updatePane(side, (pane) => ({ ...pane, sort: { ...pane.sort, [field]: !pane.sort[field] } }));
  }

  function closeSortMenu(side: Side) {
    setModal(null);
    requestAnimationFrame(() => focus(side));
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

  function selectedEntries(side: Side, selected: Entry, useMarks = true, recursive = true) {
    const state = panes[side];
    if (useMarks && trees[side].enabled && state.marked.some((key) => trees[side].lookup(state, key) === undefined)) {
      setStatus({ text: "Wait for the marked folders to finish loading." });
      return [];
    }
    const marks = !useMarks ? [] : trees[side].enabled ? state.marked.flatMap((key) => {
      const row = trees[side].lookup(state, key);
      return row ? [row] : [];
    }) : entries[side].filter(({ name }) => markedNames[side].has(name));
    const selection = marks.length ? marks : [selected];
    if (!recursive || !trees[side].enabled) return selection;
    const folders = new Set(selection.filter(({ directory, link }) => directory && !link).map(({ name }) => name));
    return selection.filter(({ tree }) => !tree?.segments.some((_, index) =>
      index > 0 && folders.has(tree.segments.slice(0, index).join("/"))));
  }

  function transferItems(side: Side, selected: Entry, useMarks = true) {
    const state = panes[side];
    return selectedEntries(side, selected, useMarks).flatMap((entry) => {
      const item = paneItem(state, entry);
      return item ? [item] : [];
    });
  }

  function openAdministrator({ directory, side = active, selected }: { directory: string; side?: Side; selected?: string }) {
    const other = opposite(side);
    const otherPlace = visiblePanes.current[other].place;
    const otherAnalyzer = analysisPanes[other]?.root;
    return api.openElevated({ directory, side, selected, split, preferences: preferenceSnapshot(preferences),
      otherFolder: otherPlace?.kind === "local" ? otherPlace.path : undefined,
      otherAnalyzer: otherAnalyzer?.kind === "local" ? otherAnalyzer.path : undefined });
  }

  function openTransfer(kind: Transfer["kind"], source: Transfer["source"], items: Transfer["items"], target: Place | null,
    chooseOperation = false, side = active) {
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
    setModal({ kind: "transfer", side, transfer: {
      kind, source, items, chooseOperation,
      target: target?.kind === "local" || isFileServer(target) ? placePath(target) : "",
      remoteDestination,
    } });
  }

  function fileLocationsChanged() {
    refresh("left");
    refresh("right");
    setFileRevision((revision) => revision + 1);
  }

  function confirmDeletion(command: "recycle" | "delete", place: RenameLocation | SshPlace | ArchivePlace, entries: readonly Entry[], tree = false) {
    if (!entries.length) return;
    const remote = place.kind === "ftp" || place.kind === "ssh" ? place : undefined;
    const archive = place.kind === "archive" ? place : undefined;
    setModal({
      kind: remote || archive || smbHost(place) ? "delete" : command,
      path: placePath(place), remote, archive, names: entries.map(({ name }) => name),
      directories: entries.filter(({ directory, link }) => directory && !link).map(({ name }) => name),
      relativePaths: tree ? entries.map((entry) => [...(entry.tree?.segments ?? [entry.name])]) : undefined,
    });
  }

  function spaceItemAction(side: Side, items: readonly SpaceLocalItem[], command: SpaceItemCommand) {
    if (busy || modal || !items.length) return;
    const root = analysisPanes[side]?.root;
    if (root?.kind !== "local") return;
    if (command === "copy" || command === "move") {
      const targetSide = opposite(side);
      const target = panes[targetSide];
      const location = analysisPanes[targetSide]?.location.place ?? treeFolder(targetSide) ?? target.place;
      openTransfer(command, items.length === 1 ? items[0].place : root, [...items],
        gitView || environmentPanels[targetSide] || previewSide === targetSide || processPanels[targetSide] || target.search ||
          command === "move" && isFileServer(location) ? null : location, false, side);
    } else {
      const entries = items.flatMap(({ place, entry }) => {
        const parent = spaceRelativePath(root, place);
        if (!parent) return [];
        const segments = [...parent, entry.name];
        return [{ ...entry, name: segments.join("/"), tree: { parent: place, segments, expanded: false, loading: false } }];
      });
      if (entries.length) confirmDeletion(command, root, entries, true);
    }
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
    if ((side !== "left" && side !== "right") || side === source || !!analysisPanes[side] || environmentPanels[side] ||
        gitView || modal || helpTopic || activeDocument !== null) return null;
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

  async function copyClipboard(side: Side, entry?: Entry, useMarks?: boolean) {
    if (!entry) return;
    const items = transferItems(side, entry, useMarks ?? (panes[side].marked.includes(entry.name) || entry === current));
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

  function contextActions(side: Side, x: number, y: number, entry?: Entry, preserveMarks = false) {
    setActive(side);
    setFileMenu(null);
    if (entry && !panes[side].marked.includes(entry.name)) {
      if (preserveMarks) {
        selectionAnchor.current[side] = entry.name;
        updatePane(side, (pane) => ({ ...pane, selected: entry.name }));
      } else selectRow(side, entry, false, false);
    }
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
      payload.source.kind === "local" && panes[side].place?.kind === "local" && !panes[payload.side].search, payload.side);
  }

  function selectRow(side: Side, entry: Entry, range: boolean, mark: boolean) {
    if (panes[side].place?.kind === "connections") {
      updatePane(side, (pane) => ({ ...pane, selected: entry.name }));
      return;
    }
    if (rowRename && (rowRename.side !== side || (rowRename.treeKey ?? rowRename.name) !== entry.name)) setRowRename(null);
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

  function setRightClickMarks(side: Side, names: readonly string[], mark: boolean) {
    const selected = names.at(-1);
    if (!selected) return;
    selectionAnchor.current[side] = selected;
    updatePane(side, (pane) => {
      const marked = new Set(pane.marked);
      for (const name of names) {
        if (mark) marked.add(name);
        else marked.delete(name);
      }
      return { ...pane, selected, marked: [...marked] };
    });
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
      if (rename.place.kind === "local") setFileRevision((revision) => revision + 1);
      if (rename.treeKey) {
        const renamedKey = [...rename.treeKey.split("/").slice(0, -1), name].join("/");
        updatePane(rename.side, (pane) => ({ ...pane,
          selected: renamedKey, marked: pane.marked.map((key) => key === rename.treeKey ? renamedKey : key),
        }));
      }
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

  function focusTerminalInput() {
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLTextAreaElement>(".terminal-card:not([hidden]) .xterm-helper-textarea");
      input?.focus({ preventScroll: true });
      if (input && document.activeElement === input) setTerminalInputFocused(document.hasFocus());
    });
  }

  function followShellDirectory(session: TerminalSession, path: string) {
    if (session.id !== terminal?.id || !terminalVisible || activeDocument !== null || processPanels[active] || diskActive) return;
    const place = terminalPlace;
    if (!place || (session.kind === "local" ? place.kind !== "local" :
      place.kind !== "ssh" || place.id !== session.connection)) return;

    const fromShell = terminalListings.current[active] === request.current[active];
    const pending = pendingListings.current[active];
    if (pending && !pending.background && !fromShell) return;
    const absolute = session.kind === "local" && windowsClient ? /^[a-z]:[\\/]|^[\\/]{2}[^\\/]/i.test(path) : path.startsWith("/");
    if (!absolute) return;
    if (path === placePath(place)) {
      if (fromShell && pending) cancelLoading(active, true);
      return;
    }
    const destination = place.kind === "ssh" ? { ...place, segments: path.split("/").filter(Boolean) } : filesystemPlace(path);
    if (analysis && canAnalyze(destination)) {
      navigateAnalysis(active, destination, false);
      return;
    }
    if (trees[active].enabled && destination.kind === "local") {
      void navigateTree(active, destination, false);
      return;
    }
    void loadTerminalFolder(active, destination);
  }

  function loadTerminalFolder(side: Side, destination: FileLocation) {
    const listing = load(side, destination);
    const ticket = request.current[side];
    terminalListings.current[side] = ticket;
    return listing.finally(() => {
      if (terminalListings.current[side] === ticket) delete terminalListings.current[side];
    });
  }

  async function navigateTree(side: Side, destination: FileLocation, focusTree: boolean) {
    const pane = latest.current[side];
    const root = pane.place;
    const segments = root?.kind === "local" && destination.kind === "local" ? spaceRelativePath(root, destination) : null;
    const ticket = ++treeNavigation.current[side];
    const current = () => treeNavigation.current[side] === ticket && latest.current[side].place === root &&
      latest.current[side].selected === pane.selected;
    const selected = segments ? await trees[side].reveal(pane, segments, current) : null;
    if (!current()) return;
    if (selected !== null) updatePane(side, (state) => ({ ...state, selected, revealedHidden: selected }));
    else if (!await (focusTree ? load(side, destination) : loadTerminalFolder(side, destination))) return;
    if (focusTree) requestAnimationFrame(() => focus(side));
  }

  const followTerminal = useEffectEvent(() => { openTerminal(false); });
  useEffect(() => {
    if (terminalVisible && terminalKey && !terminal && activeDocument === null) followTerminal();
  }, [terminalVisible, terminalKey, terminal, activeDocument]);
  useEffect(() => {
    const syncFocus = () => setTerminalInputFocused(document.hasFocus() && hasTerminalShortcutFocus(document.activeElement));
    window.addEventListener("focus", syncFocus);
    window.addEventListener("blur", syncFocus);
    return () => {
      window.removeEventListener("focus", syncFocus);
      window.removeEventListener("blur", syncFocus);
    };
  }, []);

  function showCommandLine(moveFocus = true) {
    setTerminalInputFocused(false);
    setTerminalShare(0);
    setPanelsHidden(false);
    if (moveFocus) requestAnimationFrame(() => {
      const field = commandInput.current;
      if (field && !field.closest(".app.has-terminal")) field.focus();
    });
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

  function recordCommand(text: string, source: "local" | "ssh") {
    if (!text.trim()) return;
    const date = Date.now();
    setHistoryItems((history) => [{ text, date, source }, ...history].slice(0, historyLimit));
    historyIndex.current = -1;
  }

  function submitCommand(event: FormEvent) {
    event.preventDefault();
    if (!commandLine.trim()) {
      if (panelsHidden && terminal) setPendingCommands((commands) => ({ ...commands, [terminal.id]: [...(commands[terminal.id] ?? []), null] }));
      else if (!analysis && currentRow) open(active, currentRow);
      return;
    }
    const session = openTerminal(!terminalVisible);
    if (!session || !terminalPlace) return;
    if (!terminalVisible) setTerminalShare(terminalHeight);
    setPendingCommands((commands) => ({
      ...commands, [session.id]: [...(commands[session.id] ?? []), { command: commandLine, directory: placePath(terminalPlace) }],
    }));
    recordCommand(commandLine, session.kind);
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
    const items = trees[active].enabled && current ? selectedEntries(active, current, true, false) :
      marked.length ? marked : current ? [current] : [];
    const names = items.map(({ name, tree }) => pane.search?.matches.get(name)?.entry.name ?? tree?.segments.at(-1) ?? name);
    if (!names.length) return;
    void api.copyText(names.join("\n")).then(() => setStatus({ text: "Item names copied to the clipboard." }),
      (error: unknown) => setStatus({ text: describeError(error), error: true }));
  }

  function fileFor(side: Side, entry = entries[side][paneCursorIndex(panes[side], entries[side])]): NamedFile | null {
    const item = paneItem(panes[side], entry);
    return item && item.place.kind !== "kswitcher" && !item.entry.directory && !item.entry.link
      ? { place: item.place, name: item.entry.name } : null;
  }

  function imagesInPane(side: Side, file: NamedFile) {
    const source = panes[side];
    const place = source.place;
    if (!source.search && !trees[side].enabled && (place?.kind !== file.place.kind || placePath(place) !== placePath(file.place) ||
        (place.kind !== "local" && !sameConnection(place, file.place)))) return [];
    return entries[side].flatMap((entry) => {
      if (!imageType(entry.name)) return [];
      const image = fileFor(side, entry);
      return image ? [image] : [];
    });
  }

  const comparisonMarked = pane.marked.length < 2 ? [] : entries[active]
    .filter(({ name }) => markedNames[active].has(name))
    .map((entry) => fileFor(active, entry))
    .filter((file): file is NamedFile => file !== null);
  const comparisonLeft = comparisonMarked.length === 2 ? comparisonMarked[0] : fileFor("left");
  const comparisonRight = comparisonMarked.length === 2 ? comparisonMarked[1] : fileFor("right");
  const comparison = comparisonLeft && comparisonRight ? { left: comparisonLeft, right: comparisonRight } : null;

  const markedFolders = entries[active].filter((entry) => entry.directory && !entry.link && markedNames[active].has(entry.name));
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
    const measuringSide = (): Side | undefined =>
      scans.current.left === id ? "left" : scans.current.right === id ? "right" : undefined;
    const output = new Channel<SizeResult>();
    output.onmessage = (result) => {
      const side = measuringSide();
      if (!side) return;
      updatePane(side, (pane) => pane.measuring.includes(result.name) ? ({
        ...pane, sizes: new Map(pane.sizes).set(result.name, result),
        measuring: pane.measuring.filter((name) => name !== result.name),
      }) : pane);
    };
    const source = ftp ? { kind: "ftp" as const, connection: ftp.id, segments: ftp.segments }
      : { kind: "local" as const, directory: local!.path };
    void api.measureFolders(id, source, names, output).catch((error: unknown) => {
      if (measuringSide()) setStatus({ text: describeError(error), error: true });
    }).finally(() => {
      output.onmessage = () => {};
      const side = measuringSide();
      if (side) {
        scans.current[side] = null;
        updatePane(side, (pane) => ({ ...pane, measuring: [] }));
      }
    });
  }

  function canSelectPanelMode(side: Side) {
    const place = panes[side].place;
    return !gitView && !environmentPanels[side] && side !== previewSide && !panelsHidden && activeDocument === null && !processPanels[side] &&
      !!place && place.kind !== "connections";
  }

  async function setPanelMode(side: Side, id: PanelModeId) {
    if (!canSelectPanelMode(side)) return;
    const analyzer = analysisPanes[side];
    if (analyzer) {
      const { place, reveal } = analyzer.location;
      if (!await load(side, place, "push", reveal)) return;
      closeSpaceAnalyzer(side);
    }
    if (diskPanes[side]) closeDiskInformation(side);
    setPreferences((before) => before.selectedPanelModes[side] === id ? before : ({
      ...before, selectedPanelModes: { ...before.selectedPanelModes, [side]: id },
    }));
  }

  function swapPanes() {
    if (!canSwapPanes) return;
    if (gitView) {
      setGitView({ ...gitView, side: opposite(gitView.side) });
      return;
    }
    const sides = ["left", "right"] as const;
    if (sides.some((side) => pendingListings.current[side] && !pendingListings.current[side]?.background)) return;
    for (const side of sides) if (pendingListings.current[side]) invalidateListing(side);

    const next = opposite(active);
    const focused = document.activeElement;
    const movedFocus = focused instanceof HTMLElement && focused.closest(".workspace .pane") ? focused : null;
    setSwappedPanes((swapped) => !swapped);
    setPanes(swapSides);
    setProcessPanels(swapSides);
    setEnvironmentPanels(swapSides);
    setQuickViewSource((side) => side === null ? null : opposite(side));
    setAnalysisPanes(swapSides);
    setDiskPanes(swapSides);
    setRowRename((rename) => rename && { ...rename, side: opposite(rename.side) });
    connected.current = swapSides(connected.current);
    failedFtp.current = { left: failedFtp.current.right, right: failedFtp.current.left };
    selectionAnchor.current = swapSides(selectionAnchor.current);
    scans.current = swapSides(scans.current);
    setActive(opposite(focusedSide));
    const id = next + (diskActive ? "-disk-information" : environmentActive ? "-environment" : "-files");
    requestAnimationFrame(() => {
      if (movedFocus?.isConnected) movedFocus.focus({ preventScroll: true });
      else if (analysisHandles.current[next]) analysisHandles.current[next]?.focus();
      else document.getElementById(id)?.focus({ preventScroll: true });
    });
  }

  function moveGroupPage(side: Side, capacity: number, direction: number) {
    const items = entries[side];
    updatePane(side, (pane) => {
      const index = paneCursorIndex(pane, items);
      if (index < 0) return pane;
      const target = (Math.floor(index / capacity) + direction) * capacity;
      if (target < 0 || target >= items.length) return pane;
      return { ...pane, selected: items[Math.min(items.length - 1, index + direction * capacity)].name };
    });
  }

  function perform(command: Command) {
    if (command === "fileBookmarks") {
      if (activeDocument === null) setModal({ kind: "fileBookmarks" });
      return;
    }
    if (command === "leftLocations" || command === "rightLocations") {
      toggleSourceMenu(command === "leftLocations" ? "left" : "right");
      return;
    }
    if (command === "swap") {
      swapPanes();
      return;
    }
    if (command === "environmentVariables") {
      if (panesAvailable && !gitView && !showingAnalysis) showEnvironment(active, environmentPanels[active] ? null : "root");
      return;
    }
    if (environmentActive && !["switchPane", "menu", "help", "settings", "close", "shrinkLeft", "growLeft"].includes(command)) return;
    if (command === "gitView") {
      if (!canToggleGitView) return;
      if (gitView) closeGitView();
      else if (local) {
        for (const side of ["left", "right"] as const) {
          if (pendingListings.current[side] && !panes[side].loading) invalidateListing(side);
        }
        setQuickViewSource(null);
        setGitView({ side: active, source: active, path: local.path });
      }
      return;
    }
    if (gitView) {
      if (command === "refresh") setGitRefresh((revision) => revision + 1);
      if (!["menu", "help", "settings", "close", "shrinkLeft", "growLeft"].includes(command)) return;
    }
    if (command === "analyzeSpace") {
      if (!panesAvailable || showingEnvironment) return;
      if (analysis) analysisHandles.current[active]?.focus();
      else if (filesAvailable && canAnalyze(pane.place)) openSpaceAnalyzer(active, pane.place);
      return;
    }
    if (command === "diskInformation") {
      openDiskInformation(active);
      return;
    }
    if (analysis && (command === "copy" || command === "move" || command === "recycle" || command === "recycleAlternate" || command === "delete")) {
      analysisHandles.current[active]?.runAction(command === "recycleAlternate" ? "recycle" : command);
      return;
    }
    if (command === "quickView") {
      if (!canToggleQuickView) return;
      setQuickViewSource(quickViewSource === null ? active : null);
      setQuickViewSourceText(false);
      focus(active);
      return;
    }
    if (command === "sortMenu") {
      showSortMenu(active);
      return;
    }
    if (command === "sortGroups" || command === "sortMarkedFirst" || command === "sortDirectoriesFirst") {
      toggleSortPriority(active, command === "sortGroups" ? "groups" : command === "sortMarkedFirst" ? "markedFirst" : "directoriesFirst");
      return;
    }
    const sortCriterion = commandSortMode(command);
    if (sortCriterion) {
      sort(active, sortCriterion);
      return;
    }
    const mode = commandPanelMode(command);
    if (mode) {
      setPanelMode(active, mode);
      return;
    }
    if (command === "recycleAlternate") command = "recycle";
    if (command === "toggleTerminal") {
      toggleTerminal();
      return;
    }
    const bookmark = folderGroupCommand(command);
    if (bookmark) {
      if (bookmark.add) addFolderShortcut(bookmark.group);
      else if (!panelsHidden) openFolderGroup(active, bookmark.group);
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
    if ((analysis || diskActive) && !["switchPane", "settings", "help", "menu", "close", "shrinkLeft", "growLeft", "terminal", "commandHistory", "previousCommand"].includes(command)) return;
    if (processPanels[active]) {
      if (command === "recycle") {
        document.getElementById(`${active}-pane`)?.dispatchEvent(new Event("dirlume-end-processes"));
        return;
      }
      if (command === "cancelMeasure") {
        showProcesses(active, false);
        return;
      }
      if (!["switchPane", "swap", "back", "forward", "parent",
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
      if (trees[active].enabled && currentRow && (command === "leftRow" || command === "rightRow")) {
        if (command === "rightRow" && currentRow.tree?.expanded) {
          const next = entries[active][paneCursorIndex(pane, entries[active]) + 1];
          if (next?.name.startsWith(currentRow.name + "/")) updatePane(active, (pane) => ({ ...pane, selected: next.name }));
        } else if (command === "rightRow" || currentRow.tree?.expanded) toggleTreeBranch(active, currentRow);
        else if (currentRow.tree && currentRow.tree.segments.length > 1) {
          const parent = currentRow.tree.segments.slice(0, -1).join("/");
          updatePane(active, (pane) => ({ ...pane, selected: parent }));
        }
        return;
      }
      const items = entries[active];
      if (!items.length) return;
      const direction = command === "pageUp" || command === "leftRow" ? -1 :
        command === "pageDown" || command === "rightRow" ? 1 : 0;
      const capacity = groupPageSize.current[active];
      if (capacity && direction) {
        moveGroupPage(active, capacity, direction);
        return;
      }
      const offset = rowCommands[command as keyof typeof rowCommands];
      const groupStep = command === "leftRow" || command === "rightRow" ? direction * rowsPerGroup.current[active] : 0;
      updatePane(active, (pane) => {
        const index = paneCursorIndex(pane, items);
        if (groupStep && (index + groupStep < 0 || index + groupStep >= items.length)) return pane;
        const next = Math.max(0, Math.min(items.length - 1, groupStep ? index + groupStep : offset === 0 ? 0 : index + offset));
        return isRangeCommand(command) ? toggleMarkAndMoveCursor(pane, items, index, next) : { ...pane, selected: items[next].name };
      });
      return;
    }
    switch (command) {
      case "switchPane":
        if (panelsHidden || previewSide) break;
        if (document.activeElement === commandInput.current) setActive(opposite(active));
        else focus(opposite(active));
        break;
      case "address": {
        document.getElementById(`${active}-path`)?.dispatchEvent(new Event("dirlume-edit-path"));
        break;
      }
      case "open": if (currentRow) open(active, currentRow, true); break;
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
      case "help": setHelpTopic(topicForControl(document.activeElement, contextHelpTopic(undefined, editingDocument))); break;
      case "menu": mainMenu.current?.open(); break;
      case "close": void getCurrentWindow().close().catch((error: unknown) => setStatus({ text: describeError(error), error: true })); break;
      case "shrinkLeft": setSplit(clampSplit(split - 1)); break;
      case "growLeft": setSplit(clampSplit(split + 1)); break;
      case "terminal":
        if (panelsHidden) {
          if (terminalShare) setPanelsHidden(false);
          else showCommandLine();
        } else if (openTerminal()) {
          setPanelsHidden(true);
          focusTerminalInput();
        }
        break;
      case "commandPath":
      case "commandName":
        if (command === "commandPath" && currentRow?.name === ".." &&
            (pane.place?.kind === "local" || pane.place?.kind === "ssh")) {
          const target = parentPlace(pane.place);
          if (target) insertCommand(placePath(target), pane.place.kind === "local" && windowsClient);
        } else if (currentItem && (currentItem.place.kind === "local" || currentItem.place.kind === "ssh")) {
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
        const place = current?.tree && currentItem?.place.kind === "local" ? currentItem.place : local ?? ftp;
        if (place && current && !pane.search && !busy && !pane.loading) {
          setRowRename({ side: active, place, name: currentItem?.entry.name ?? current.name, treeKey: current.tree ? current.name : undefined });
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
          confirmDeletion(command, writable, selectedEntries(active, current), trees[active].enabled);
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
          if (trees[active].enabled) setFolderSizesEnabled((before) => ({ ...before, [active]: true }));
          else measure();
          break;
        }
        const file = fileFor(active);
        if (file && (command === "view" || imageType(file.name) || writableTextPlace(file.place))) openDocument(file, command === "edit", undefined, active);
        break;
      }
      case "compare": {
        if (!comparison) {
          setStatus({ text: "Choose a text file in each pane to compare.", error: true });
        } else if (isTauri()) {
          setComparisons((open) => [...open, comparison]);
          void api.openToolWindow(t("Compare files"), undefined, comparison)
            .catch((error: unknown) => setStatus({ text: describeError(error), error: true }))
            .finally(() => setComparisons((open) => open.filter((pair) => pair !== comparison)));
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
    if (modal || helpTopic || event.defaultPrevented || native.isComposing || native.getModifierState("AltGraph")) return;
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
      ? connectionCommands[catalog.source].find((command) => bindingMatches(shortcuts[command], shortcut)) : undefined;
    const command = profileCommand ?? commandNames.find((command) => shortcut && command !== "settings" && commandScope(command) === "main" &&
      bindingMatches(shortcuts[command], shortcut)) ?? (["hidden", "attributes", "copyFullPath"] as const).find((command) =>
      commands[command].key === physical && shortcuts[command].includes(physical));
    if (activeDocument !== null) return;
    if (command === "swap") {
      if (canSwapPanes) {
        event.preventDefault();
        if (!event.repeat) perform(command);
      }
      return;
    }
    if (environmentActive) {
      const fromEnvironmentList = target.id === active + "-environment";
      if (command && (["environmentVariables", "menu", "help", "close", "shrinkLeft", "growLeft"].includes(command) ||
          command === "switchPane" && fromEnvironmentList)) {
        event.preventDefault();
        if (!event.repeat) perform(command);
      }
      return;
    }
    if (gitView) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeGitView();
      } else if (command && ["gitView", "refresh", "menu", "help", "close", "shrinkLeft", "growLeft"].includes(command)) {
        event.preventDefault();
        if (!event.repeat) perform(command);
      }
      return;
    }
    if (target.closest(".space-analyzer, .disk-information")) {
      if (command && (command === "analyzeSpace" || command === "diskInformation" || command === "menu" || command === "help" || command === "close" || command === "toggleTerminal" || command === "terminal" ||
          command === "switchPane" && (target.getAttribute("role") === "treegrid" || target.id.endsWith("-disk-information")) ||
          commandPanelMode(command) || folderGroupCommand(command))) {
        event.preventDefault();
        if (!event.repeat) perform(command);
      }
      return;
    }
    const inCommandLine = target === commandInput.current;
    const inField = target.closest("input, select, textarea, [contenteditable]");
    if (command?.startsWith("sort") && (inField || target.closest("[role=menu]") || !canSelectPanelMode(active))) return;
    if (command && (commandPanelMode(command) || (folderGroupCommand(command)?.add === false)) &&
        (inField || target.closest("[role=menu]") || (commandPanelMode(command) && !canSelectPanelMode(active)))) return;
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
    if (command === "refresh" && (onFiles?.id === "left-files" || onFiles?.id === "right-files")) {
      refresh(onFiles.id === "left-files" ? "left" : "right");
      return;
    }
    if (!event.repeat || (!["hidden", "attributes", "quickView", "gitView", "analyzeSpace", "copyFullPath", "copyItemNames", "addFolderShortcut", "folderShortcuts", "terminal", "toggleTerminal"].includes(command) &&
        !folderGroupCommand(command) && !commandPanelMode(command) && !command.startsWith("sort"))) {
      perform(command);
    }
  }

  function keyLabel(command: Command) {
    return showShortcut(shortcuts[command][0]);
  }

  const currentFile = fileFor(active);
  const fileActions = diskActive ? [] : analysis ? ([
    { command: "copy", label: "Copy", Icon: Copy, disabled: analysis.root.kind !== "local" || busy },
    { command: "move", label: "Move", Icon: ArrowLeftRight, disabled: analysis.root.kind !== "local" || busy },
    { command: "recycle", label: "Trash", Icon: Trash2, disabled: analysis.root.kind !== "local" || busy },
  ] as const) : catalog ? ([
    { command: connectionCommands[catalog.source][0], label: "Add connection", Icon: FilePlus, disabled: pane.loading },
    { command: connectionCommands[catalog.source][1], label: "Edit connection", Icon: Pencil, disabled: !current?.connection || pane.loading },
    { command: "recycle", label: "Remove connection", Icon: Trash2, disabled: !current?.connection || pane.loading },
  ] as const) : ([
    { command: "view", label: measureEntries.length ? "Measure" : "View", Icon: measureEntries.length ? Calculator : Eye,
      disabled: !fileFor(active) && !measureEntries.length },
    { command: "edit", label: "Edit", Icon: Pencil, disabled: !currentFile || !(imageType(currentFile.name) || writableTextPlace(currentFile.place)) },
    { command: "copy", label: local || fileServer || archive ? "Copy" : "Download", Icon: local || fileServer || archive ? Copy : ArrowDownToLine, disabled: !canTransfer || busy },
    { command: "move", label: ftp ? "Rename" : "Move", Icon: ArrowLeftRight, disabled: (!local && !ftp) || !!pane.search || !canTransfer || busy },
    { command: "rename", label: "Rename", Icon: TextCursorInput, disabled: (!local && !ftp) || !!pane.search || !current || busy },
    { command: "newFile", label: "New file", Icon: FilePlus, disabled: !local || !!pane.search || busy },
    { command: "mkdir", label: "New folder", Icon: FolderPlus, disabled: !local || !!pane.search || busy },
    { command: "recycle", label: permanentDelete || archive ? "Delete" : "Trash", Icon: Trash2, disabled: (!local && !fileServer && !archive?.writable) || !!pane.search || !current || busy },
    { command: "compare", label: "Compare", Icon: FileDiff, disabled: comparison === null },
    { command: "mark", label: "Mark", Icon: CheckSquare, disabled: !current },
  ] as const).filter(({ command }) => !ftp || command !== "rename");
  const filesAvailable = panesAvailable && !analysis && !diskActive && !gitView && !environmentActive && !processPanels[active] && !pane.loading;
  const canToggleQuickView = panesAvailable && !showingEnvironment && !gitView && !showingAnalysis &&
    (quickViewSource !== null || filesAvailable && !!pane.place && !catalog && pane.place.kind !== "smbRoot");
  const canToggleGitView = panesAvailable && !showingEnvironment && (!!gitView || filesAvailable && !!local && !showingAnalysis && !busy && !panes[opposite(active)].loading);
  const previewFile = previewSide && filesAvailable ? currentFile : null;
  const previewName = currentItem?.entry.name ?? current?.name;
  const previewKey = previewFile ? JSON.stringify([
    previewFile.place.kind, "id" in previewFile.place ? previewFile.place.id : null, placePath(previewFile.place),
    previewFile.name, currentItem?.entry.size, currentItem?.entry.modified,
  ]) : "";
  const previewMessage = t(pane.loading ? "Loading preview…" :
    !current || processPanels[active] ? "Select a file to preview." :
    current.directory ? "Folders cannot be previewed." : "This file type cannot be previewed.");
  const formattedPreview = previewFile && (isMarkdownFile(previewFile.name) || /\.html?$/i.test(previewFile.name));
  const canCopyItemNames = filesAvailable && !catalog && (pane.marked.length > 0 || !!current);
  const currentFullPath = filesAvailable && currentItem ? placePath(childPlace(currentItem.place, currentItem.entry.name)) : null;

  function menuCommand(command: Command, disabled = false, label: string = commands[command].label) {
    return { label, disabled, shortcut: keyLabel(command), run: () => perform(command) };
  }

  function paneMenu(side: Side): MenuGroup {
    const target = panes[side];
    const available = panesAvailable && !paneCovered(side) && !target.loading;
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
        ...panelModeIds.map((id) => ({
          id,
          label: panelModeName(id, preferences.panelModes),
          translated: true,
          checked: !analysisPanes[side] && !diskPanes[side] && preferences.selectedPanelModes[side] === id,
          shortcut: keyLabel(panelModeCommand(id)),
          disabled: !canSelectPanelMode(side),
          run: () => setPanelMode(side, id),
        })),
        { ...menuCommand("analyzeSpace", !canSelectPanelMode(side) || !canAnalyze(target.place), "Space Analyzer"),
          checked: Boolean(analysisPanes[side]), run: () => {
            if (analysisPanes[side]) focus(side);
            else if (canAnalyze(target.place)) openSpaceAnalyzer(side, target.place);
          } },
        { ...menuCommand("diskInformation", !canSelectPanelMode(side) || !diskPath(side)),
          checked: Boolean(diskPanes[side]), run: () => openDiskInformation(side) },
        { ...menuCommand("sortMenu", !canSelectPanelMode(side)), separatorBefore: true, run: () => showSortMenu(side) },
        menuCommand(side === "left" ? "leftLocations" : "rightLocations", activeDocument !== null, "Sources"),
        inPane("back", !processPanels[side] && !target.search && target.position <= 0),
        inPane("forward", !processPanels[side] && target.position >= target.history.length - 1),
        inPane("parent", !processPanels[side] && !target.search && target.place?.kind !== "connections" &&
          (!target.place || !parentPlace(target.place))),
        inPane("refresh", !!processPanels[side] || !target.place),
      ],
    };
  }

  const commandWithIcon = (Icon: LucideIcon, command: Command, disabled = false, label?: string) =>
    ({ ...menuCommand(command, disabled, label), Icon });

  const menuGroups: MenuGroup[] = [
    paneMenu("left"),
    { label: "Files", items: [
      ...fileActions.map(({ command, label, disabled }) => menuCommand(command, (!analysis && !filesAvailable) || disabled, label)),
      menuCommand("createArchive", !filesAvailable || !local || !current || !!pane.search, "Create archive"),
      menuCommand("attributes", !filesAvailable || !currentItem || busy),
      ...(windowsClient ? [menuCommand("lockingProcesses", !!previewSide || !filesAvailable || currentItem?.place.kind !== "local" || busy)] : []),
      menuCommand("copyClipboard", !filesAvailable || currentItem?.place.kind !== "local"),
      menuCommand("pasteClipboard", !filesAvailable || !local || !!pane.search),
      ...(permanentDelete || archive ? [] : [menuCommand("delete", !filesAvailable || !local || !!pane.search || !current || busy)]),
    ] },
    { label: "Commands", items: [
      { ...commandWithIcon(ScanEye, "quickView", !canToggleQuickView), checked: quickViewSource !== null },
      { ...commandWithIcon(GitBranch, "gitView", !canToggleGitView), checked: showingGit },
      { ...commandWithIcon(Braces, "environmentVariables", !panesAvailable || !!gitView || showingAnalysis), checked: environmentActive },
      commandWithIcon(FolderTree, "analyzeSpace", !analysis && (!filesAvailable || showingEnvironment || !canAnalyze(pane.place))),
      commandWithIcon(Bookmark, "fileBookmarks", activeDocument !== null),
      commandWithIcon(Search, "search", !filesAvailable || !pane.place || pane.place.kind === "smbRoot"),
      commandWithIcon(FileDiff, "compare", !filesAvailable || comparison === null),
      commandWithIcon(ClipboardCopy, "copyFullPath", currentFullPath === null),
      commandWithIcon(Copy, "copyItemNames", !canCopyItemNames),
      commandWithIcon(Server, "connect", activeDocument !== null, "Connect"),
      commandWithIcon(ArrowLeftRight, "swap", !panesAvailable || !canSwapPanes),
      commandWithIcon(History, "commandHistory", activeDocument !== null),
      commandWithIcon(Bookmark, "folderShortcuts", !panesAvailable),
      commandWithIcon(TerminalIcon, "toggleTerminal", activeDocument !== null),
      ...(isTauri() ? [
        { label: "MCP server", Icon: Plug, run: () => setModal({ kind: "mcp" }) },
        { label: "Check for updates", Icon: RefreshCw, run: () => { void checkUpdates(true); } },
      ] : []),
    ] },
    { label: "Options", items: [menuCommand("settings"), menuCommand("hidden")] },
    paneMenu("right"),
    { label: "Help", items: [menuCommand("help"),
      ...(installedRelease ? [{ label: "What's new", run: () => setModal({ kind: "whatsNew" }) }] : []),
      { label: "About", run: () => setModal({ kind: "about" }) },
      { label: "Open error log", separatorBefore: true, run: () => void openErrorLog() }] },
  ];

  const showFileActions = !showingGit && !environmentActive && activeDocument === null;
  const commandLineVisible = showFileActions && !panelsHidden;
  const resizeInDocuments = !preferences.showStatusBar && documents.length > 0;
  const resizeInFileActions = !preferences.showStatusBar && !resizeInDocuments && showFileActions;

  return (
    <ElevationContext value={openAdministrator}>
    <div className={`app${terminalVisible ? " has-terminal" : ""}${commandLineVisible ? " has-command-line" : ""}${panelsHidden ? " panels-hidden" : ""}${activeDocument !== null ? " document-active" : ""}`}
      data-layout={preferences.layout} data-status-bar={preferences.showStatusBar ? undefined : "hidden"}
      style={{ "--terminal-height": `${terminalShare}fr`, "--panes-height": `${100 - terminalShare}fr` } as CSSProperties}
      onKeyDown={keyDown} onKeyDownCapture={documentKeys}
      onFocusCapture={(event) => setTerminalInputFocused(hasTerminalShortcutFocus(event.target))}
      onBlurCapture={(event) => {
        if (hasTerminalShortcutFocus(event.target) && !hasTerminalShortcutFocus(event.relatedTarget)) setTerminalInputFocused(false);
      }}
      onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}>
      <header className={windowsClient && isTauri() ? "topbar window-titlebar" : "topbar"} data-help-topic="workspace"
        data-menu-position={preferences.mainMenuAlignment} data-tauri-drag-region={windowsClient && isTauri() ? "deep" : undefined}>
        <div className="brand">
          <span className="brand-icon"><FolderTree /></span><h1 aria-label={administratorTitle}>Dirlume</h1>
          {administrator && <span className="administrator-label" aria-hidden="true">{t("Administrator")}</span>}
        </div>
        <MainMenu ref={mainMenu} groups={menuGroups} shortcut={keyLabel("menu")} hiddenByDefault />
        <div className="top-actions">
          <Button type="button" className="icon-button donation-button titlebar-donation" aria-label={t("Donate via monobank")}
            data-tauri-drag-region="false" onClick={() => {
              void api.openWebLink(donationUrl).catch((error: unknown) => setStatus({ text: describeError(error), error: true }));
            }}><Coffee aria-hidden="true" /></Button>
          {panesAvailable && formattedPreview && <div className="quick-view-modes" role="group" data-help-topic="quickView" aria-label={t("Quick View format")}>
            <Button aria-pressed={!quickViewSourceText} onClick={() => { setQuickViewSourceText(false); focus(active); }}>{t("Rendered")}</Button>
            <Button aria-pressed={quickViewSourceText} onClick={() => { setQuickViewSourceText(true); focus(active); }}>{t("Source")}</Button>
          </div>}
          <Button className="icon-button" data-help-topic="quickView" aria-label={t("Quick View")} aria-pressed={quickViewSource !== null}
            shortcut={keyLabel("quickView")} disabled={!canToggleQuickView} onClick={() => perform("quickView")}><ScanEye /></Button>
          <Button className="icon-button" data-help-topic="gitView" aria-label={t("Git View")} aria-pressed={showingGit} shortcut={keyLabel("gitView")}
            disabled={!canToggleGitView} onClick={() => perform("gitView")}><GitBranch /></Button>
          <Button className="toolbar-button topbar-connect" data-help-topic="remote" aria-label={t("Connect")} shortcut={keyLabel("connect")} disabled={showingGit} onClick={() => perform("connect")}>
            <Server /> <span>{t("Connect")}</span>
          </Button>
          <Button className="icon-button" data-help-topic="search" aria-label={t("Find files")} shortcut={keyLabel("search")}
            disabled={!filesAvailable || !pane.place || pane.place.kind === "smbRoot"}
            onClick={() => perform("search")}><Search /></Button>
          <span className="separator" />
          <Button className="icon-button" aria-label={t("Swap panes")} shortcut={keyLabel("swap")}
            disabled={!canSwapPanes} onClick={() => perform("swap")}><ArrowLeftRight /></Button>
          <Button className="icon-button" aria-label={t("Show hidden files")} aria-pressed={preferences.hidden}
            shortcut={keyLabel("hidden")} disabled={showingGit} onClick={() => perform("hidden")}>{preferences.hidden ? <Eye /> : <EyeOff />}</Button>
          <Button className="icon-button" data-help-topic="terminal" aria-label={t("Toggle terminal")} aria-pressed={terminalVisible}
            shortcut={keyLabel("toggleTerminal")} disabled={activeDocument !== null} onClick={toggleTerminal}><TerminalIcon /></Button>
          <Button className="icon-button" aria-label={t(isLightTheme(theme) ? "Switch to favorite dark scheme" : "Switch to favorite light scheme")}
            onClick={() => setPreferences((current) => selectAppearance(current,
              isLightTheme(theme) ? current.systemDarkScheme : current.systemLightScheme))}>
            {isLightTheme(theme) ? <Moon /> : <Sun />}
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
          <Pane key={swappedPanes ? opposite(side) : side} side={side}
            active={active === side} covered={paneCovered(side)}
            layout={preferences.layout} showHidden={preferences.hidden} rightClickSelection={preferences.rightClickSelection}
            pane={paneSizes[side] ? { ...panes[side], backgroundSizes: paneSizes[side] } : panes[side]}
            entries={entries[side]} fileTypes={fileTypes} locations={locations} addressPlace={treeFolder(side)}
            fileView={trees[side].enabled ? "tree" : "list"} onFileView={(view) => void setFilePaneView(side, view)}
            onTreeBranch={(entry) => toggleTreeBranch(side, entry)} folderSizes={folderSizes[side]}
            onFolderSizes={() => setFolderSizesEnabled((before) => ({ ...before, [side]: !before[side] }))}
            preserveScroll={showingGit || !!environmentPanels[side] || !!analysisPanes[side] || !!diskPanes[side]}
            onAnalyze={(place) => openSpaceAnalyzer(side, place)} spaceDisabled={showingEnvironment}
            modeId={preferences.selectedPanelModes[side]} mode={preferences.panelModes[preferences.selectedPanelModes[side]]}
            sortAvailable={!sorts[side].pending && sorts[side].canSort(sortMode(panes[side].sort.column))} sortPending={sorts[side].pending}
            onGroupLayout={(rows, capacity) => {
              rowsPerGroup.current[side] = rows;
              groupPageSize.current[side] = capacity;
            }}
            onPage={(capacity, direction) => moveGroupPage(side, capacity, direction)}
            rename={rowRename?.side === side && !panes[side].search &&
              (rowRename.treeKey ? trees[side].enabled : sameRenameLocation(panes[side].place, rowRename.place))
              ? { name: rowRename.name, rowKey: rowRename.treeKey ?? rowRename.name,
                onCancel: () => closeRowRename(side), onSave: (name) => submitRowRename(rowRename, name) } : undefined}
            activate={() => setActive(side)} onRow={(entry, range, mark) => selectRow(side, entry, range, mark)}
            onRightClickMark={(names, mark) => setRightClickMarks(side, names, mark)}
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
              } else if (trees[side].enabled) void navigateTree(side, filesystemPlace(path), true);
              else void load(side, filesystemPlace(path));
            }}
            onLocalLocation={(location) => openPaneSource(side, location)}
            onPathAncestor={(place) => {
              showProcesses(side, false);
              if (trees[side].enabled && place.kind === "local") void navigateTree(side, place, true);
              else void load(side, place);
            }}
            onOpenConnections={(source) => openConnections(side, source)}
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
            processContextMenuShortcut={shortcuts.processContextMenu}
            onShowExecutable={(path) => revealProcessExecutable(side, path)}
            onProcessFeedback={(text, error) => setStatus({ text, error })}
            onContext={(x, y, entry, preserveMarks) => contextActions(side, x, y, entry, preserveMarks)}
            onRevealResult={(entry) => {
              const item = paneItem(panes[side], entry);
              if (item) revealResult(side, item.place, item.entry.name);
            }}
            onFilter={(filter) => updatePane(side, (pane) => ({ ...pane, filter }))} onSort={(column) => sort(side, column, true)}
            sourceMenu={paneSources(side)} zoomShortcut={shortcuts.zoomFont}
            fontSize={preferences.viewFontSizes[side]} onZoom={zoomViewFont} />
        ))}
        {(["left", "right"] as const).map((side) => {
          const mode = environmentPanels[side];
          return mode && <Suspense key={swappedPanes ? opposite(side) : side} fallback={<section className={"pane environment-pane environment-" + side}>
            <p className="pane-empty" role="status">{t("Loading environment variables…")}</p>
          </section>}>
            <EnvironmentPane side={side} active={active === side} mode={mode} oppositeMode={environmentPanels[opposite(side)]}
              shortcuts={shortcuts} revision={environmentRevision} onMode={(mode) => showEnvironment(side, mode)}
              onClose={() => showEnvironment(side, null)} onFocus={() => setActive(side)}
              onChanged={() => setEnvironmentRevision((revision) => revision + 1)} />
          </Suspense>;
        })}
        {gitView && <Suspense fallback={<section className={"pane git-pane git-pane-" + gitView.side}>
          <p className="pane-empty" role="status">{t("Reading Git repository…")}</p>
        </section>}>
          <GitView side={gitView.side} path={gitView.path} refresh={gitRefresh}
            onRefresh={() => setGitRefresh((revision) => revision + 1)} onClose={closeGitView} />
        </Suspense>}
        {(["left", "right"] as const).map((side) => diskPanes[side] && <DiskInformation key={side + diskPanes[side]}
          side={side} path={diskPanes[side]} active={active === side} onFocus={() => setActive(side)}
          onClose={() => closeDiskInformation(side)} onScan={(root) => openSpaceAnalyzer(side, localPath(root), true, "sunburst")} />)}
        {(["left", "right"] as const).map((side) => {
          const analyzer = analysisPanes[side];
          return analyzer && <Suspense key={analyzer.id} fallback={<section className={"pane space-analyzer space-analyzer-" + side}>
            <p className="pane-empty" role="status">{t("Scanning…")}</p>
          </section>}>
            <SpaceAnalyzer ref={(view) => { analysisHandles.current[side] = view; }} side={side} place={analyzer.root}
              currentFolder={analyzer.location.place} navigation={analyzer.navigation} active={active === side} layout={preferences.layout}
              initialView={analyzer.initialView} onViewChoice={(view) => setPreferences((current) => ({ ...current, spaceAnalyzerView: view }))}
              shortcuts={shortcuts} fileRevision={fileRevision} operationsAvailable={!busy && !modal}
              rightClickSelection={preferences.rightClickSelection}
              onItemAction={(items, command) => spaceItemAction(side, items, command)}
              resolvePlace={resolveSpacePlace} onClose={() => closeSpaceAnalyzer(side)} onFocus={() => setActive(side)}
              onNavigate={(place) => navigateAnalysis(side, place, true)}
              onLocation={(location) => selectAnalysisLocation(side, analyzer.id, location)}
              onReveal={(place, reveal) => revealSpace(side, place, reveal)} />
          </Suspense>;
        })}
        {panesAvailable && previewSide && <Suspense fallback={<section className={`pane quick-view quick-view-${previewSide}`}>
          <p className="pane-empty" role="status">{t("Loading preview…")}</p>
        </section>}>
          <QuickView side={previewSide} file={previewFile} fileKey={previewKey} name={previewName}
            message={previewMessage} source={quickViewSourceText} light={isLightTheme(theme)} onFocusFiles={() => focus(active)} />
        </Suspense>}
        {sourceMenu && paneCovered(sourceMenu.side) && paneSources(sourceMenu.side, true)}
        {terminalVisible && !panelsHidden && <div className="terminal-divider" role="separator" data-help-topic="workspace"
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
        {documents.map(({ id, file, editing, position, bookmarkJump, back, forward, imageOrigin, imageIndex, imageEditorOpened, imageRevision = 0, diagnosticLog }) => {
          const documentKey = JSON.stringify([id, placePath(file.place), file.name]);
          if (imageType(file.name)) {
            const candidates = activeDocument === id ? imagesInPane(imageOrigin ?? active, file) : [];
            const index = candidates.findIndex((image) => sameDocumentFile(file, image));
            const current = index >= 0 ? index : Math.max(0, imageIndex ?? 0);
            const documentActive = activeDocument === id;
            const editable = file.place.kind === "local" && canEditImage(file);
            const mode = (editing: boolean) => {
              const existing = editing && documents.find((tab) => tab.id !== id &&
                (tab.imageEditorOpened || tab.editing) && sameDocumentFile(tab.file, file));
              const target = existing ? existing.id : id;
              setDocuments((current) => current.map((tab) => tab.id === target ? { ...tab, editing, imageEditorOpened: true } : tab));
              if (target !== id) selectDocument(target);
            };
            function afterConfirmation(run: () => void) {
              const editor = imageEditors.current.get(id);
              if (!editor) run();
              else void editor.confirmClose().then((confirmed) => { if (confirmed) run(); });
            }
            const close = () => afterConfirmation(() => closeDocument(id));
            return <Fragment key={documentKey}>
              {!editing && <ImageDocument key={imageRevision} file={file} active={documentActive} shortcuts={shortcuts} revision={imageRevision}
                previous={candidates[current - 1]} next={candidates[index >= 0 ? current + 1 : current]}
                onNavigate={(image) => afterConfirmation(() => {
                  dirtyDocuments.current.delete(id);
                  setDocuments((current) => current.map((tab) => tab.id === id
                    ? { ...tab, file: image, imageIndex: candidates.indexOf(image), imageEditorOpened: false } : tab));
                })} onEdit={() => mode(true)} onClose={close} />}
              {(editing || imageEditorOpened) && editable && file.place.kind === "local" && <ImageEditor
                ref={(handle) => { if (handle) imageEditors.current.set(id, handle); else imageEditors.current.delete(id); }}
                directory={file.place.path} name={file.name} active={documentActive && editing} shortcuts={shortcuts} revision={imageRevision}
                onSwitch={() => mode(false)} onClose={close} onDirty={(dirty) => {
                  if (dirty) dirtyDocuments.current.add(id);
                  else dirtyDocuments.current.delete(id);
                }} onSaved={(replaced) => {
                  if (replaced) setDocuments((current) => current.map((tab) => sameDocumentFile(tab.file, file)
                    ? { ...tab, imageRevision: (tab.imageRevision ?? 0) + 1 } : tab));
                  for (const side of ["left", "right"] as const) if (!latest.current[side].sudoListing) refresh(side);
                  setStatus({ text: replaced ? t("The original image was replaced.") : t("Image copy saved."), error: false });
                }} />}
            </Fragment>;
          }
          return (
          <TextWindow key={documentKey}
            file={file} editing={editing} active={activeDocument === id} theme={theme}
            diagnosticLog={diagnosticLog}
            fileBookmarks={fileBookmarks} bookmarkJump={bookmarkJump} onBookmarkLine={addFileBookmark}
            onFileBookmarks={(path) => setModal({ kind: "fileBookmarks", path })}
            viewerContentWidth={preferences.viewerContentWidth} viewerMarkdownContentWidth={preferences.viewerMarkdownContentWidth}
            colors={scheme?.colors}
            shortcuts={shortcuts}
            fontSizes={preferences.viewFontSizes} onZoom={zoomViewFont}
            onOptions={() => openSettings(editing ? "editor" : "viewer")}
            onSwitchMode={() => openDocument(file, !editing)}
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
              if (editing && file.place.kind !== "local") {
                // A remote Viewer reloads after a save because it has no local directory watch.
                setDocuments((current) => current.map((tab) => !tab.editing && sameDocumentFile(tab.file, file)
                  ? { ...tab, file: { ...tab.file } } : tab));
              }
              for (const side of ["left", "right"] as const) if (!latest.current[side].sudoListing) refresh(side);
            }} onClose={() => closeDocument(id)} />
          );
        })}
      </div>
      <Suspense fallback={terminalVisible && activeDocument === null ?
        <div className="terminal-card pane-empty" role="status">{t("Opening terminal…")}</div> : null}>
        {Object.entries(terminals).map(([key, session]) => (
          <TerminalPanel key={session.id} session={session}
            directory={key === terminalKey && terminalPlace && !processPanels[active] ? placePath(terminalPlace) : null}
            visible={key === terminalKey && terminalVisible && activeDocument === null} theme={theme} scheme={scheme}
            history={localTerminalHistory}
            rowHeight={terminalRowHeight} focusRequested={terminalFocus}
            focusHint={!preferences.showStatusBar && key === terminalKey ? terminalFocusHint : undefined}
            watchEnvironment={session.kind === "local" && preferences.refreshEnvironment}
            copyShortcut={shortcuts.copyTerminalText} pasteShortcut={shortcuts.pasteTerminalText} pasteOnRightClick={preferences.terminalPasteOnRightClick}
            onClipboardError={(error) => setStatus({ text: describeError(error), error: true })}
            onTerminalError={(message) => setStatus({ text: message, error: true })}
            pendingCommands={pendingCommands[session.id] ?? noCommands}
            onCommandsQueued={(count) => setPendingCommands((commands) => ({ ...commands,
              [session.id]: (commands[session.id] ?? []).slice(count),
            }))}
            onCommandSubmitted={(text) => recordCommand(text, session.kind)} onDirectoryChange={(path) => followShellDirectory(session, path)}
            onClose={() => { dropTerminal(key); showCommandLine(); }} />
        ))}
      </Suspense>
      {terminalVisible && activeDocument === null && !terminal && <div className="terminal-card pane-empty" role="status">
        {t(terminalKey ? "Opening terminal…" : "Choose a local or SSH folder to open a terminal.")}
      </div>}
      <form className="command-bar" data-help-topic="terminal" hidden={!commandLineVisible} onSubmit={submitCommand}>
        <Button type="button" className="toolbar-button" aria-pressed={terminalVisible} onClick={toggleTerminal} shortcut={keyLabel("toggleTerminal")}>
          <TerminalIcon /> {t("Terminal")}
        </Button>
        <span data-tooltip={terminalLocation ? placePath(terminalLocation) : undefined}>{terminalLocation ? placePath(terminalLocation) : ""}</span>
        <CommandField input={commandInput} draft={commandLine} directory={processPanels[active] || terminalPlace?.kind !== "local" ? null : terminalPlace.path}
          history={terminalPlace?.kind === "ssh" ? [] : commandLineHistory}
          refreshEnvironment={terminals.local?.refreshEnvironment ?? preferences.refreshEnvironment}
          onChange={(draft) => { historyIndex.current = -1; setCommandLine(draft); }} />
      </form>
      <div className="actionbar-row" hidden={!showFileActions}>
        <nav ref={actionbar} className="actionbar" data-help-topic="operations" data-button-width={preferences.actionButtonWidth} aria-label={t("File actions")}>
          {processPanels[active] ? <Button type="button" onClick={() => showProcesses(active, false)}>{t("Back to files")}</Button> :
            fileActions.map(({ command, label, Icon, disabled }) => (
            <Button key={command} data-command={command} disabled={disabled} onClick={() => perform(command)} shortcut={keyLabel(command)}
              aria-keyshortcuts={shortcuts[command].join(" ") || undefined}>
              {keyLabel(command) && <kbd aria-hidden="true" data-shortcut={keyLabel(command)}>{compactShortcut(shortcuts[command][0])}</kbd>}
              {!preferences.hideActionButtonIcons && <Icon />}<span>{t(label)}</span>
            </Button>
          ))}
          <Button type="button" aria-pressed={terminalVisible} onClick={toggleTerminal} shortcut={keyLabel("toggleTerminal")}>
            {!preferences.hideActionButtonIcons && <TerminalIcon />}<span>{t("Terminal")}</span>
            {keyLabel("toggleTerminal") && <kbd aria-hidden="true">{keyLabel("toggleTerminal")}</kbd>}
          </Button>
        </nav>
        {resizeInFileActions && <WindowResizeMarker />}
      </div>
      <div className="document-bar-row" data-populated={documents.length > 0 || undefined}>
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
        {resizeInDocuments && <WindowResizeMarker />}
      </div>
      {preferences.showStatusBar ? <footer data-help-topic="workspace" className={`statusbar${status.error ? " danger" : ""}`}>
        <span className="statusbar-message" role={status.error ? "alert" : "status"} data-tooltip={errorText(status.text)}>
          {errorText(status.text)}
        </span>
        {terminalFocusHint}
        <span className="statusbar-location">{pane.place?.kind === "connections" ? t("Saved connections") : pane.place?.kind === "archive" ? t(pane.place.address) :
          pane.place && pane.place.kind !== "local" && pane.place.kind !== "smbRoot" ? pane.place.address :
            smbHost(pane.place) ?? t("Local file system")}</span>
        <WindowResizeMarker />
      </footer> : <>
        <StatusFeedback status={status} />
        {!resizeInDocuments && !resizeInFileActions && <WindowResizeMarker />}
      </>}
      {modal?.kind === "settings" && <Settings initialPage={modal.page} preferences={preferences}
        onPick={() => new Promise((resolve) => setLocalAppearancePick(() => resolve))} onChange={(next) => {
        setLanguage(next.language);
        setPreferences(next);
        return next;
      }} onClose={() => setModal(null)} />}
      {localAppearancePick && <AppearancePicker onFinish={(pick) => {
        setLocalAppearancePick(null);
        localAppearancePick(pick);
      }} />}
      {modal?.kind === "exit" && (
        <Dialog title={t("Unsaved changes")} tone="warning" onClose={() => setModal(modal.update ? { kind: "update", update: modal.update } : null)}>
          <div className="dialog-body"><p>{t(modal.update ? "Some editors have unsaved changes. Discard them and install the update?" :
            "Some editors have unsaved changes. Discard them and exit Dirlume?")}</p></div>
          <footer className="dialog-footer">
            <Button type="button" data-initial-focus onClick={() => setModal(null)}>{t("Keep working")}</Button>
            <Button type="button" className="alert-confirm" onClick={() => void confirmExit(modal.update)}>
              {t(modal.update ? "Discard changes and update" : "Discard changes and exit")}</Button>
          </footer>
        </Dialog>
      )}
      {modal?.kind === "update" && (
        <Dialog title={t("Update available")} onClose={() => setModal(null)}>
          <div className="dialog-body transfer-body">
            <p>{t("Dirlume {0} is available.", modal.update.version)}</p>
            <ReleaseNotes release={modal.update} onError={(text) => setStatus({ text, error: true })} />
            {modal.update.kind === "debian" && <>
              <p>{t("Download the Debian package and run this command in the download folder.")}</p>
              <code>sudo apt install ./{modal.update.url.split("/").at(-1)}</code>
            </>}
          </div>
          <footer className="dialog-footer">
            <Button type="button" data-initial-focus onClick={() => setModal(null)}>{t("Later")}</Button>
            <Button type="button" className="primary" onClick={() => {
              if (modal.update.kind === "install" && dirtyDocuments.current.size) void requestExit(modal.update);
              else installUpdate(modal.update);
            }}>{t(modal.update.kind === "debian" ? "Download Debian package" : "Install and restart")}</Button>
          </footer>
        </Dialog>
      )}
      {modal?.kind === "whatsNew" && installedRelease && (
        <Dialog title={t("What's new")} onClose={dismissWhatsNew}
          footer={<Button type="button" data-initial-focus onClick={dismissWhatsNew}>{t("Close")}</Button>}>
          <div className="dialog-body transfer-body">
            <p>{t("Dirlume {0}", installedRelease.version)}</p>
            <ReleaseNotes release={installedRelease} onError={(text) => setStatus({ text, error: true })} />
          </div>
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
        <TransferDialog transfer={modal.transfer} side={modal.side} showHidden={preferences.hidden} onClose={() => setModal(null)}
          onFinished={(success) => {
            const destination = modal.transfer.remoteDestination;
            if (destination?.kind === "ssh") setSshUploadRefresh(destination.id);
            else fileLocationsChanged();
            if (success) setStatus({ text: "Transfer complete" });
          }} />
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
                target.search || (item.place.kind !== "local" && isFileServer(target.place)) ? null : target.place, false, side);
            }}>{t("Copy")}</Button>
            {item.place.kind === "local" && <Button role="menuitem" onClick={() => {
              setFileMenu(null);
              void copyClipboard(side, entry, !!entry && state.marked.includes(entry.name));
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
      {modal?.kind === "sortMenu" && <SortMenu sort={panes[modal.side].sort} mode={sortMode(panes[modal.side].sort.column)}
        bindings={shortcuts} available={sorts[modal.side].canSort} onClose={() => closeSortMenu(modal.side)}
        onMode={(mode) => { sort(modal.side, mode); closeSortMenu(modal.side); }}
        onDirection={(asc) => changeSortDirection(modal.side, asc)}
        onToggle={(field) => toggleSortPriority(modal.side, field)}
        onCriteria={(mode) => setModal({ kind: "sortCriteria", side: modal.side, mode })} />}
      {modal?.kind === "sortCriteria" && <SortCriteriaDialog mode={modal.mode}
        criteria={preferences.sortSettings.criteria[modal.mode] ?? defaultSortCriteria(modal.mode)}
        onSave={(criteria) => {
          setPreferences((before) => ({ ...before, sortSettings: {
            ...before.sortSettings, criteria: { ...before.sortSettings.criteria, [modal.mode]: criteria },
          } }));
          setModal({ kind: "sortMenu", side: modal.side });
        }}
        onClose={() => setModal({ kind: "sortMenu", side: modal.side })} />}
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
      {modal?.kind === "fileBookmarks" && <FileBookmarksDialog bookmarks={fileBookmarks} path={modal.path} addKey={keyLabel("bookmarkLine")}
        onOpen={openFileBookmark} onRename={(bookmark, name) => updateFileBookmark(bookmark, (item) => ({ ...item, name: name || undefined }))}
        onRemove={(bookmark) => updateFileBookmark(bookmark, () => null)} onClose={() => setModal(null)} />}
      {modal?.kind === "connectionEditor" && <SavedConnectionDialog source={modal.source} profile={modal.profile}
        remoteProvider={preferences.provider} bridgeDirectory={preferences.kswitcher}
        onSaved={(kind, id) => reloadConnectionLists(modal.side, { kind, id })}
        onClose={() => connectionDialogsClosed(modal.side)} />}
      {modal?.kind === "removeConnection" && <RemoveConnectionDialog profile={modal.profile}
        onRemoved={() => reloadConnectionLists(modal.side)} onClose={() => connectionDialogsClosed(modal.side)} />}
      {modal?.kind === "verifyConnection" && <VerifyHostDialog verification={modal.verification}
        onCancel={() => connectionDialogsClosed(modal.side)} onApprove={() => {
          connectionDialogsClosed(modal.side);
          void openSavedConnection(modal.side, modal.profile, [...modal.approvals, modal.verification]);
        }} />}
      {modal?.kind === "compare" && <CompareDialog left={modal.left} right={modal.right}
        previousShortcut={shortcuts.previousChange} nextShortcut={shortcuts.nextChange} swapShortcut={shortcuts.swap} onClose={() => setModal(null)} />}
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
      {modal?.kind === "deletion" && <DeletionDialog deletion={modal.deletion} onClose={() => setModal(null)} onFinished={(result) => {
        fileLocationsChanged();
        if (result && !result.cancelled && result.counts.failed + result.counts.skipped + result.counts.unprocessed === 0) {
          setStatus({ text: t(modal.deletion.permanent ? "Deleted {0}." : "Moved {0} to Trash.", countText(result.counts.completed, "item")) });
        }
      }} />}
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
          } else if ("names" in modal && remote) {
            try {
              const remove = remote.kind === "ssh" ? api.deleteSsh : api.deleteFtp;
              await batch(modal.names, (name) => remove(remote.id, [...remote.segments, name], recursive && (modal.directories?.includes(name) ?? false)));
            } catch (error) {
              setStatus({ text: describeError(error), error: true });
              setModal(null);
              return;
            } finally {
              refresh("left");
              refresh("right");
            }
          } else if ("names" in modal) {
            setModal({ kind: "deletion", deletion: { directory: modal.path, names: modal.names,
              permanent: modal.kind === "delete", relativePaths: modal.relativePaths } });
            return;
          } else if (operation) {
            if (operation.kind === "rename") await renameItem((remote?.kind === "ftp" ? remote : undefined) ?? localPath(modal.path), operation.name, operation.new_name);
            else await api.operate(modal.path, operation);
            fileLocationsChanged();
            if (modal.kind === "newFile") {
              openDocument({ place: { kind: "local", path: modal.path, parent: null }, name: operation.name }, true);
            }
          }
          setModal(null);
        }} />
      )}
      {helpRequest && <Suspense fallback={null}>
        <HelpDialog initialTopic={helpRequest.topic} side={helpRequest.side} language={preferences.language}
          copyShortcuts={shortcuts.copy} searchShortcuts={shortcuts.searchHelp} onClose={() => {
          setHelpTopic(null);
          if (helpTopic === "terminalShortcuts") focusTerminalInput();
        }} />
      </Suspense>}
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
    </ElevationContext>
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
    <Dialog key={String(recursive)} title={recursive ? t(modal.remote?.kind === "ssh" ? "Delete SSH folder contents" : "Delete FTP folder contents") : title} tone={permanent ? "warning" : undefined}
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
          {!modal.remote && windowsClient && isPermissionError(error) &&
            <ElevationButton directory={modal.path} selected={modal.kind === "rename" ? modal.name : undefined} />}
          {!modal.remote && windowsClient && isLockError(error) && <div className="dialog-actions"><Button type="button" onClick={() => setLockPaths(
            ("names" in modal ? modal.names : [modal.name]).filter(Boolean).map((name) => placePath(childPlace(localPath(modal.path), name))),
          )}>{t("Find locking processes")}</Button></div>}
        </div>
        <footer className="dialog-footer">
          <Button type="button" data-initial-focus={removing ? true : undefined} onClick={onClose} disabled={waiting}>{t("Cancel")}</Button>
          <Button type="submit" className={permanent ? "alert-confirm" : removing ? undefined : "primary"}
            disabled={waiting || (!removing && (!name || name === modal.name && modal.kind === "rename"))}>
            {waiting ? t("Working…") : recursive ? t("Delete contents") : modal.kind === "newFile" ? t("Create") : title}
          </Button>
        </footer>
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
          <div className="dialog-actions">
            <Button type="button" onClick={onOptions} disabled={waiting}>{t("Connection options")}</Button>
          </div>
        </div>
        <footer className="dialog-footer">
          <Button type="submit" className="primary" disabled={waiting || (provider === "kswitcher" && bridge === null) || (bridge !== false && !value.trim())}>
            {waiting ? t("Connecting…") : bridge === false ? t("Open KSwitcher Files") : t("Connect")}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}
