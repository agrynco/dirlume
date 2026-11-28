import { HistoryField } from "./HistoryField";
import { countText, errorText, locale, t } from "./i18n";
import { Button } from "./Button";
import { AddressField } from "./AddressField";
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronRight, File, Folder, Ruler,
  Activity, GitBranch, HardDrive, Link2, LoaderCircle, RefreshCw, Search, Server, TriangleAlert, X,
} from "lucide-react";
import { api, describeError, folderLabel, googleDriveSignInRequired, supportsFileTree, placeAddress, smbHost, windowsClient, type ComputerDrive, type ConnectionSource, type DiskSpace, type Entry, type FileLocation, type PanelMetadataRequest, type Place, type QuickLocation } from "./api";
import { entryLabel, folderMeasurement, formatDate, formatSize, paneCursorIndex, paneItem, type FilePaneView, type PaneState, type Side, type SortColumn } from "./panes";
import { ElevationButton, ProcessBrowser } from "./ProcessTools";
import { fileAppearance, type FileTypeIndex } from "./appearance";
import { fileIconKey, useWindowsIcons } from "./useWindowsIcons";
import { bindingMatches, eventShortcut, showShortcut, type PanelLayout } from "./preferences";
import { useTimestamps } from "./useTimestamps";
import { viewFontStyle } from "./viewFonts";
import { columnGroupTrack, fieldClass, FileColumns, isSizeField, panelColumnTracks, readColumnLayout, saveColumnLayout, type ColumnSamples } from "./FileColumns";
import { defaultPanelModes, displayPanelName, isNameField, panelColumnGroups, type PanelField, type PanelMode, type PanelModeId } from "./panelModes";
import { usePanelMetadata } from "./usePanelMetadata";
import { QuickSearch, useQuickSearch } from "./QuickSearch";
import { SpaceControl } from "./SpaceControl";
import { canAnalyze, type Metric, type SpacePlace } from "./spaceScan";
import { useRightClickSelection } from "./useRightClickSelection";
import { gitChangeLabel, gitPanePath, type GitPaneListing } from "./gitPane";

function sizeLabel(bytes: number, incomplete?: boolean, formatter?: Intl.NumberFormat) {
  const value = formatter ? formatter.format(bytes) : formatSize(bytes);
  return incomplete ? `≥ ${value}` : value;
}

function driveSpace(drive?: ComputerDrive): DiskSpace | null {
  if (!drive || drive.total == null || drive.available == null ||
      drive.total <= 0 || drive.available < 0 || drive.available > drive.total) return null;
  return { total: drive.total, available: drive.available };
}

function paneSpaceTarget(place: Place | null): { key: string; read: () => Promise<DiskSpace | null> } | null {
  if (place?.kind === "local") return { key: JSON.stringify([place.kind, place.path]), read: () => api.diskSpace(place.path) };
  if (place?.kind === "googleDrive") return { key: JSON.stringify([place.kind, place.id]), read: async () => {
    const { limit, usage } = await api.googleDriveQuota(place.id);
    return limit !== null && usage !== null ? { total: limit, available: Math.max(0, limit - usage) } : null;
  } };
  if (place?.kind === "server" && place.pairedComputer && place.segments.length) {
    const [drive] = place.segments;
    return { key: JSON.stringify([place.kind, place.id, drive]), read: async () =>
      driveSpace((await api.listConnectedComputerDrives(place.id)).find(({ name }) => name === drive)) };
  }
  if (place?.kind === "kswitcher") {
    const drive = /^([a-z]:)[\\/]/i.exec(place.path)?.[1].toUpperCase();
    if (drive) return { key: JSON.stringify([place.kind, place.directory, place.peer, drive]), read: async () =>
      driveSpace((await api.listKSwitcher(place.directory, place.peer, "")).drives?.find(({ name }) => name.toUpperCase() === drive)) };
  }
  return null;
}

interface PaneProps {
  side: Side;
  active: boolean;
  covered?: boolean;
  preserveScroll?: boolean;
  layout: PanelLayout;
  modeId: PanelModeId;
  mode: PanelMode;
  sortAvailable: boolean;
  sortPending: boolean;
  onGroupLayout: (rows: number, pageSize: number) => void;
  onPage: (capacity: number, direction: number) => void;
  showHidden: boolean;
  rightClickSelection: boolean;
  pane: PaneState;
  addressPlace?: FileLocation | null;
  entries: Entry[];
  fileTypes: FileTypeIndex;
  fileView: FilePaneView;
  onFileView: (view: FilePaneView) => void;
  onTreeBranch: (entry: Entry) => void;
  folderSizes: { active: boolean; branchActive: boolean; scanning: boolean; error?: string; metric: Metric; support: boolean; setMetric: (metric: Metric) => void };
  onFolderSizes: () => void;
  locations: QuickLocation[];
  rename?: { name: string; rowKey: string; onSave: (name: string) => Promise<void>; onCancel: () => void };
  activate: () => void;
  onRow: (entry: Entry, range: boolean, mark: boolean) => void;
  onRightClickMark: (names: readonly string[], mark: boolean) => void;
  onQuickMatch: (name: string) => void;
  onOpen: (entry: Entry) => void;
  fileOpenFeedback: ReactNode;
  onPath: (path: string) => void;
  onLocalLocation: (location: QuickLocation) => void;
  onPathAncestor: (place: Place) => void;
  onOpenConnections: (source: ConnectionSource) => void;
  onAddConnection: (source: ConnectionSource) => void;
  onReconnectGoogleDrive: () => void;
  onCopyPath: (path: string) => void;
  onHistory: (offset: number) => void;
  onParent?: () => void;
  onRefresh: () => void;
  onDismissError: () => void;
  onRetryWithSudo: () => void;
  onCancelFolderOperation: () => void;
  cancelFolderShortcut: readonly string[];
  onFilter: (filter: string) => void;
  onSort: (column: SortColumn) => void;
  sourceMenu: ReactNode;
  fontSize?: number;
  onCloseResults: () => void;
  onRevealResult: (entry: Entry) => void;
  onStartDrag: (entry: Entry, event: ReactPointerEvent) => void;
  dropTarget: boolean;
  processView: { path?: string } | null;
  onProcesses: (visible: boolean) => void;
  processContextMenuShortcut: readonly string[];
  fileContextMenuShortcut: readonly string[];
  onShowExecutable: (path: string) => Promise<void>;
  onProcessFeedback: (text: string, error?: boolean) => void;
  onContext: (x: number, y: number, entry?: Entry, preserveMarks?: boolean) => void;
  onAnalyze: (place: SpacePlace) => void;
  spaceDisabled: boolean;
  gitListing?: GitPaneListing;
  gitUnavailable?: boolean;
}

function InlineRenameField({ name, onSave, onCancel }: NonNullable<PaneProps["rename"]>) {
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  async function save() {
    if (!draft.trim() || saving) return;
    setError("");
    setSaving(true);
    try { await onSave(draft); }
    catch (failure) {
      setSaving(false);
      setError(describeError(failure));
      requestAnimationFrame(() => input.current?.focus());
    }
  }

  return <span className="inline-rename" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    <input ref={input} type="text" aria-label={t("New name for {0}", name)} value={draft}
      readOnly={saving} aria-invalid={!!error} aria-describedby={error ? errorId : undefined}
      onChange={(event) => { setDraft(event.target.value); setError(""); }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || !["Enter", "Escape"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Enter") void save();
        else if (!saving) onCancel();
      }} />
    {error && <span id={errorId} className="inline-rename-error" role="alert">{errorText(error)}</span>}
  </span>;
}

export function Pane({ side, active, covered, preserveScroll, layout, modeId, mode, sortAvailable, sortPending, onGroupLayout, onPage, showHidden, addressPlace,
  rightClickSelection, pane, entries: availableEntries, fileTypes, fileView, onFileView, onTreeBranch, folderSizes, onFolderSizes, locations, rename, activate, onRow,
  onRightClickMark, onQuickMatch, onOpen, fileOpenFeedback, onPath, onLocalLocation,
  onHistory, onParent, onRefresh, onFilter, onSort, sourceMenu, fontSize, onCloseResults, onRevealResult,
  onStartDrag, dropTarget, processView, onProcesses, processContextMenuShortcut, fileContextMenuShortcut, onShowExecutable, onProcessFeedback,
  onContext, onCancelFolderOperation, cancelFolderShortcut,
  onPathAncestor, onOpenConnections, onAddConnection, onReconnectGoogleDrive, onCopyPath, onDismissError, onRetryWithSudo, onAnalyze, spaceDisabled,
  gitListing, gitUnavailable }: PaneProps) {
  const section = useRef<HTMLElement>(null);
  const path = pane.place ? placeAddress(pane.place) : "";
  const catalog = pane.place?.kind === "connections";
  const netbox = pane.place?.kind === "connections" && pane.place.source === "netbox";
  const driveCatalog = pane.place?.kind === "connections" && pane.place.source === "googleDrive";
  const [filterOpen, setFilterOpen] = useState(false);
  const [quickSearch, setQuickSearch] = useQuickSearch(side, !processView);
  const list = useRef<HTMLDivElement>(null);
  const markedSet = new Set(pane.marked);
  const rightClick = useRightClickSelection({ list, entries: availableEntries, marked: markedSet, scope: path,
    enabled: rightClickSelection && !catalog && !processView && !covered && !pane.loading,
    onMark: onRightClickMark, onContext: (x, y, entry) => onContext(x, y, entry, true) });
  const { entries } = rightClick;
  const savedScroll = useRef<{ top: number; left: number } | null>(null);
  const columnHeader = useRef<HTMLDivElement>(null);
  const [modeVisibility, setModeVisibility] = useState(() => ({
    brief: readColumnLayout(side, "brief"), medium: readColumnLayout(side, "medium"),
    full: readColumnLayout(side, "full"), wide: readColumnLayout(side, "wide"),
    owners: readColumnLayout(side, "owners"), links: readColumnLayout(side, "links"),
    alternativeFull: readColumnLayout(side, "alternativeFull"),
  }));
  const layoutMode = catalog ? "full" : modeId;
  const visibility = modeVisibility[layoutMode];
  const definition = catalog ? defaultPanelModes.full : mode;
  const tree = !catalog && fileView === "tree";
  const sourceColumns = definition.list.filter(({ field }) => field !== "git" || gitListing);
  const withGit = gitListing && !sourceColumns.some(({ field }) => field === "git") ? sourceColumns.flatMap((column) =>
    isNameField(column.field) ? [column, { field: "git" as const, width: "0" }] : [column]) : sourceColumns;
  const columnsInMode = withGit.filter(({ field }) => isNameField(field) || visibility[fieldClass[field]] !== false);
  const modeGroups = panelColumnGroups(columnsInMode);
  const groups = (tree ? modeGroups.slice(0, 1) : modeGroups).map((group) =>
    (folderSizes.active || folderSizes.branchActive) && !group.some(({ field }) => field === "size" || field === "bytes")
      ? [...group, { field: "size" as const, width: "0" }] : group);
  const columns = groups.flat();
  const tlsProfiles = netbox && pane.entries.some(({ connection }) =>
    connection?.kind === "ftp" && connection.encryption && connection.encryption !== "plain");
  const tracks = driveCatalog ? "minmax(0, 2fr) minmax(0, 3fr) minmax(0, 2fr)" : netbox ? `minmax(0, 2fr) minmax(0, ${tlsProfiles ? 15 : 7}ch) minmax(0, 3fr)` : panelColumnTracks(columns);
  const rowProbe = useRef<HTMLDivElement>(null);
  const filterField = useRef<HTMLInputElement>(null);
  const selected = paneCursorIndex(pane, entries);
  const search = Boolean(pane.search);
  const matches = pane.search?.matches;
  const [viewport, setViewport] = useState({ top: 0, height: 0, rowHeight: 29 });
  const grouped = groups.length > 1;
  const paged = grouped && (layoutMode === "brief" || layoutMode === "medium");
  const virtual = grouped || search || entries.length > 100;
  const visibleRows = Math.max(1, Math.floor((viewport.height - 8) / viewport.rowHeight));
  const rowsPerGroup = paged ? visibleRows : grouped ? Math.max(visibleRows, Math.ceil(entries.length / groups.length)) : Math.max(1, entries.length);
  const capacity = rowsPerGroup * groups.length;
  const pageStart = paged ? Math.floor(Math.max(0, selected) / capacity) * capacity : 0;
  const lastWheelPage = useRef(-Infinity);
  const renderedGroups = groups.map((group, groupIndex) => {
    const first = pageStart + groupIndex * rowsPerGroup;
    const last = Math.min(first + rowsPerGroup, entries.length);
    const start = virtual && !paged ? Math.min(last, first + Math.max(0, Math.floor(viewport.top / viewport.rowHeight) - 5)) : first;
    const end = virtual && !paged ? Math.min(last, first + Math.ceil((viewport.top + viewport.height) / viewport.rowHeight) + 6) : last;
    const indices = Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset);
    if (virtual && selected >= first && selected < last && (selected < start || selected >= end)) {
      indices.push(selected);
      indices.sort((left, right) => left - right);
    }
    return { group, first, last, indices };
  });
  const indices = renderedGroups.flatMap(({ indices }) => indices);
  const statusColumns = catalog ? [] : mode.status.filter(({ field }) => field !== "git");
  const displayedColumns = [...columns, ...statusColumns];
  const displayedFields = displayedColumns.map(({ field }) => field);
  const autoNameCount = columns.filter(({ field, width }) => width === "0" && isNameField(field)).length;
  const automaticFields = [...new Set(columns.filter(({ field, width }) =>
    isSizeField(field) || width === "0" && (!isNameField(field) || autoNameCount > 1)).map(({ field }) => field))].join(",");
  const language = locale();
  const bytesFormat = useMemo(() => new Intl.NumberFormat(language), [language]);
  const visibleTimestamps = processView ? [] : indices.map((index) => entries[index].modified);
  const dateLabel = useTimestamps(displayedFields.includes("date") ? visibleTimestamps : [], "date");
  const timeLabel = useTimestamps(displayedFields.includes("time") ? visibleTimestamps : [], "time");
  const metadataRequests = new Map<string, PanelMetadataRequest>();
  const listingFields = columns.map(({ field }) => field);
  const statusFields = statusColumns.map(({ field }) => field);
  const listOwner = listingFields.includes("owner");
  const listLinks = listingFields.includes("links");
  if (!processView && (displayedFields.includes("owner") || displayedFields.includes("links"))) {
    for (const index of indices) {
      const entry = entries[index];
      const item = paneItem(pane, entry);
      if (item?.place.kind !== "local") continue;
      const owner = listOwner || (index === selected && statusFields.includes("owner"));
      const links = !entry.directory && !entry.link &&
        (listLinks || (index === selected && statusFields.includes("links")));
      if (owner || links) metadataRequests.set(entry.name, { directory: item.place.path, name: item.entry.name, owner, links });
    }
  }
  // Include the requested fields in the cache key so switching modes can request new metadata.
  const metadataKey = (item: PanelMetadataRequest) => JSON.stringify([item.directory, item.name, item.owner, item.links]);
  const metadata = usePanelMetadata(pane.entries, new Map([...metadataRequests.values()].map((request) => [metadataKey(request), request])));

  const fileIcons = new Map<string, { directory: string; name: string }>();
  const byName = new Map<string, string>();
  if (windowsClient && !processView) {
    for (const index of indices) {
      const item = entries[index];
      if (item.directory) continue;
      const source = paneItem(pane, item);
      if (source?.place.kind !== "local") continue;
      const { entry, place } = source;
      const key = fileIconKey(place.path, entry.name, entry.size, entry.modified);
      if (!key) continue;
      fileIcons.set(key, { directory: place.path, name: entry.name });
      byName.set(item.name, key);
    }
  }
  const icons = useWindowsIcons(fileIcons, api.fileIcons);
  const localFolder = pane.place?.kind === "local" ? pane.place.path : null;
  const spaceTarget = useMemo(() => paneSpaceTarget(pane.place), [pane.place]);
  const [space, setSpace] = useState<{ key: string; value: DiskSpace } | null>(null);
  useEffect(() => {
    if (!spaceTarget || pane.loading) return;
    let cancelled = false;
    spaceTarget.read().then((value) => {
      if (!cancelled) setSpace(value ? { key: spaceTarget.key, value } : null);
    }, () => {
      if (!cancelled) setSpace(null);
    });
    return () => { cancelled = true; };
  }, [spaceTarget, pane.loading, pane.entries]);
  const free = !pane.loading && space && space.key === spaceTarget?.key ? space.value : null;
  const spaceControl = !processView && canAnalyze(pane.place)
    ? <SpaceControl place={pane.place} free={free} onAnalyze={onAnalyze} disabled={spaceDisabled || pane.loading} /> : null;

  useEffect(() => setQuickSearch(null), [path, processView, matches]);
  useLayoutEffect(() => {
    const element = list.current;
    const probe = rowProbe.current;
    if (!element || !probe) return;
    const measure = () => setViewport({
      top: element.scrollTop, height: element.clientHeight, rowHeight: probe.getBoundingClientRect().height || 29,
    });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(probe);
    return () => observer.disconnect();
  }, [virtual, processView]);
  useLayoutEffect(() => {
    onGroupLayout(grouped && !processView ? rowsPerGroup : 0, paged && !processView ? capacity : 0);
  }, [grouped, paged, processView, rowsPerGroup, capacity, onGroupLayout]);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    element.scrollTop = 0;
    if (columnHeader.current) columnHeader.current.scrollLeft = element.scrollLeft;
    setViewport((before) => before.top === element.scrollTop ? before : { ...before, top: element.scrollTop });
  }, [path, matches, processView]);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    if (preserveScroll) {
      savedScroll.current ??= { top: element.scrollTop, left: element.scrollLeft };
      return;
    }
    if (savedScroll.current) {
      element.scrollTop = savedScroll.current.top;
      element.scrollLeft = savedScroll.current.left;
      savedScroll.current = null;
      setViewport((before) => before.top === element.scrollTop ? before : { ...before, top: element.scrollTop });
      return;
    }
    if (!active || selected < 0 || paged || rightClick.selecting) return;
    if (virtual) {
      const top = (selected % rowsPerGroup) * viewport.rowHeight;
      const bottom = top + viewport.rowHeight + 8;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
      setViewport((before) => before.top === element.scrollTop ? before : { ...before, top: element.scrollTop });
    } else {
      element.querySelector("[data-current='true']")?.scrollIntoView({ block: "nearest" });
    }
  }, [selected, path, active, virtual, matches, viewport.rowHeight, rowsPerGroup, processView, preserveScroll, paged, rightClick.selecting]);
  useEffect(() => {
    const target = document.getElementById(`${side}-pane`);
    const show = () => {
      setFilterOpen(true);
      requestAnimationFrame(() => filterField.current?.focus());
    };
    target?.addEventListener("dirlume-filter", show);
    return () => target?.removeEventListener("dirlume-filter", show);
  }, [side]);

  const title = processView ? t("Processes") : search ? t("Search results") : pane.place ? folderLabel(pane.place) : t(side === "left" ? "Left pane" : "Right pane");
  const cancelKey = cancelFolderShortcut[0] === "Escape" ? "Esc" : showShortcut(cancelFolderShortcut[0]);
  const loadingLabel = t(search ? "Searching…" : "Opening folder…");
  const measuringLabel = t("Calculating folder sizes…");
  const host = smbHost(pane.place);
  const isRemote = host || (pane.place && pane.place.kind !== "local");
  const folderItems = entries.filter(({ name }) => name !== "..");
  const folders = folderItems.reduce((count, entry) => count + Number(entry.directory), 0);
  const marked = entries.filter(({ name }) => markedSet.has(name));
  const complete = marked.every((entry) => {
    const background = pane.backgroundSizes?.get(entry.name);
    return background ? !background.incomplete && !background.unavailable :
      entry.directory ? folderMeasurement(pane, entry)?.incomplete === false : entry.size !== null;
  });
  const markedBytes = marked.reduce((bytes, entry) => bytes +
    (pane.backgroundSizes?.get(entry.name)?.bytes ?? folderMeasurement(pane, entry)?.bytes ?? entry.size ?? 0), 0);

  const twin = layout === "twin";
  const current = selected >= 0 ? entries[selected] : undefined;
  const missing = "—";
  function itemValue(entry: Entry, field: PanelField, listing = false) {
    const requestsMetadata = field === "owner" || field === "links";
    const request = requestsMetadata ? metadataRequests.get(entry.name) : undefined;
    let details = request && metadata?.get(metadataKey(request));
    if (requestsMetadata && !request && metadata && listing) {
      // Keep values that have already arrived in the sizing sample when their rows scroll out of view.
      const item = paneItem(pane, entry);
      if (item?.place.kind === "local") details = metadata.get(metadataKey({
        directory: item.place.path, name: item.entry.name, owner: listOwner,
        links: !entry.directory && !entry.link && listLinks,
      }));
    }
    switch (field) {
      case "git": return "";
      case "size":
      case "bytes": {
        const background = pane.backgroundSizes?.get(entry.name);
        if (background?.unavailable) return missing;
        if (background?.pending && background.bytes === 0) return "…";
        const size = background ?? folderMeasurement(pane, entry);
        const count = size?.bytes ?? (entry.directory ? null : entry.size);
        if (count === null) return missing;
        return sizeLabel(count, size?.incomplete, field === "bytes" ? bytesFormat : undefined);
      }
      case "date": return entry.modified === null ? missing : dateLabel(entry.modified) ?? formatDate(entry.modified, "date");
      case "time": return entry.modified === null ? missing : timeLabel(entry.modified) ?? formatDate(entry.modified, "time");
      case "owner": return entry.owner || details?.owner || missing;
      case "links": {
        const links = entry.directory || entry.link ? null : entry.hardLinks ?? details?.hardLinks;
        return links == null ? missing : links.toLocaleString(locale());
      }
      default: {
        const original = matches?.get(entry.name)?.entry.name ?? entry.tree?.segments.at(-1) ?? entryLabel(entry);
        const display = displayPanelName(original, entry.directory, definition);
        const prefix = listing && !entry.googleDrive && entry.connection?.kind !== "googleDrive" && !entry.tree && original !== entry.name ? entry.name.slice(0, -original.length) : "";
        return prefix.normalize("NFC") + display;
      }
    }
  }

  const widthSamples = useMemo<ColumnSamples>(() => {
    const result: ColumnSamples = {};
    if (processView || netbox || !automaticFields) return result;
    for (const field of automaticFields.split(",") as PanelField[]) {
      const samples = new Map<string, string>();
      const tabular = field !== "owner" && !isNameField(field);
      const add = (label: string) => samples.set(tabular ? label.replace(/\p{Decimal_Number}/gu, "0") : label, label);
      for (const entry of entries) add(itemValue(entry, field, true));
      result[field] = [...samples.values()];
    }
    return result;
  }, [automaticFields, entries, processView, netbox, metadata, pane, language, dateLabel, timeLabel, definition, listOwner, listLinks]);
  const statusSamples: ColumnSamples = {};
  if (!processView && !netbox && current && current.name !== "..") {
    for (const { field, width } of statusColumns) {
      if (width === "0" || isSizeField(field)) statusSamples[field] = [itemValue(current, field)];
    }
  }

  function renderName(entry: Entry, field: PanelField, listing: boolean) {
    const text = itemValue(entry, field, listing);
    if (listing && rename?.rowKey === entry.name) return <InlineRenameField {...rename} />;
    const dot = (entry.directory ? definition.alignFolders : definition.alignFiles) ? text.lastIndexOf(".") : -1;
    const aligned = dot > text.lastIndexOf("/") + 1 && dot < text.length - 1;
    return <span className={`file-name-text${field === "rightName" ? " file-name-end" : ""}${aligned && field !== "rightName" ? " file-name-aligned" : ""}`}>
      {aligned && field !== "rightName" ? <><span>{text.slice(0, dot)}</span><span>{text.slice(entry.directory ? dot : dot + 1)}</span></> :
        field === "rightName" ? <span>{text}</span> : text}
    </span>;
  }
  // The drive bar highlights the most specific quick location that contains the current folder.
  const comparablePath = (value: string) => windowsClient ? value.replace(/[\\/]+$/, "").toLocaleLowerCase() : value.replace(/\/+$/, "");
  const currentLocation = localFolder ? locations.reduce<QuickLocation | undefined>((best, location) => {
    const base = comparablePath(location.path);
    const folder = comparablePath(localFolder);
    const separator = windowsClient ? /[\\/]/ : /\//;
    const inside = folder === base || (folder.startsWith(base) &&
      (base === "" || base.endsWith(":") || separator.test(folder.charAt(base.length))));
    return inside && (!best || base.length > comparablePath(best.path).length) ? location : best;
  }, undefined) : undefined;
  const localView = pane.place?.kind === "local" && !pane.loading;
  const driveView = pane.place?.kind === "googleDrive" && !pane.loading;
  const treeView = !pane.search && !pane.loading && supportsFileTree(pane.place);
  const viewControls = !catalog && !processView && !search && pane.place && <div className="pane-view-toolbar" data-help-topic="paneViews">
      <div className="pane-view-modes" role="group" aria-label={t("File pane view")}>
          <Button type="button" aria-pressed={!tree} disabled={!treeView} onClick={() => onFileView("list")}>{t("List")}</Button>
          <Button type="button" aria-pressed={tree} disabled={!treeView} onClick={() => onFileView("tree")}>{t("Tree")}</Button>
        </div>
        <Button type="button" aria-pressed={driveView ? undefined : folderSizes.active}
          disabled={!localView && (!driveView || !availableEntries.some(({ googleDrive }) => googleDrive?.directory))} onClick={onFolderSizes}>
          <Ruler aria-hidden="true" />{t("Folder sizes")}
        </Button>
        {folderSizes.active && (folderSizes.support
          ? <select value={folderSizes.metric} aria-label={t("Size metric")} onChange={(event) => folderSizes.setMetric(event.target.value as Metric)}>
            <option value="logical">{t("File size")}</option>
            <option value="allocated">{t("Size on disk")}</option>
          </select> : <span className="pane-view-metric">{t("File size")}</span>)}
        {folderSizes.scanning && <span className="pane-size-scan" role="status" aria-label={t("Measuring folders…")} data-tooltip={t("Measuring folders…")}>
          <LoaderCircle className="spin" aria-hidden="true" />
        </span>}
        {folderSizes.error && <span className="pane-size-scan" role="status" data-tooltip={errorText(folderSizes.error)}>{t("Partial results")}</span>}
      </div>;
  return (
    <section ref={section} id={`${side}-pane`} style={viewFontStyle(fontSize)} inert={covered} data-font-zoom={side}
      data-panel-mode={catalog || processView ? undefined : modeId}
      data-help-topic={processView ? "processes" : search ? "search" : catalog ? "remote" : "files"}
      data-drop-pane={side} data-pane-side={side} data-layout={layout} className={`pane${active ? " active" : ""}${dropTarget ? " drop-target" : ""}`}
      aria-label={t(side === "left" ? "left pane" : "right pane")}
      onPointerDown={activate} onFocus={activate}>
      <header className={`pane-heading${(catalog || localFolder && !host) && !processView && !search ? " local-heading" : ""}`}>
        {layout !== "standard" && <nav className="drive-bar" data-help-topic="paneSources" aria-label={t(side === "left" ? "Drives and places for left pane" : "Drives and places for right pane")}>
          {locations.map((location) => (
            <Button key={location.path} type="button" data-tooltip={location.path} aria-pressed={location === currentLocation}
              onClick={() => onLocalLocation(location)}>
              {twin && (/^[a-z]:$/i.test(location.label) ? <HardDrive aria-hidden="true" /> : <Folder aria-hidden="true" />)}{t(location.label)}
            </Button>
          ))}
        </nav>}
        <div className="pane-title">
          {processView ? <Activity /> : search ? <Search /> : isRemote ? <Server /> : <Folder />}
          <h2 data-tooltip={pane.search?.query.mask ?? title}>{title}</h2>
          {!processView && pane.place && pane.place.kind !== "connections" && pane.place.kind !== "local" && pane.place.kind !== "smbRoot" && <span className="remote-name"
            data-tooltip={pane.place.kind === "archive" ? t(pane.place.address) : pane.place.address}>
            {pane.place.kind === "googleDrive" ? pane.place.address : pane.place.kind === "archive" ? t(pane.place.address) : t("Remote")}</span>}
          {!processView && host && <span className="remote-name" data-tooltip={path}>SMB · {host}</span>}
        </div>
        {layout === "standard" && viewControls}
        <div className="pane-tools">
          {processView && <Button className="icon-button" aria-label={t("Close processes")}
            onClick={() => onProcesses(false)}><X /></Button>}
          {search && !processView && <>
            <Button className="icon-button" aria-label={t("Go to selected file")} disabled={selected < 0}
              onClick={() => onRevealResult(entries[selected])}><ArrowUpRight /></Button>
            <Button className="icon-button" aria-label={t("Close search results")}
              onClick={onCloseResults}><X /></Button>
          </>}
          {!processView && <Button className="icon-button" data-help-topic="paneFilter" aria-label={t("Filter folder")} aria-pressed={filterOpen}
            onClick={() => {
              if (filterOpen) {
                setFilterOpen(false);
                onFilter("");
                list.current?.focus();
              } else {
                setFilterOpen(true);
                requestAnimationFrame(() => filterField.current?.focus());
              }
            }}><Search /></Button>}
          {!processView && <Button className="icon-button" data-help-topic="paneStatus" aria-label={t(search ? "Refresh" : "Refresh folder")}
            disabled={!pane.place || pane.loading || !!pane.search && pane.search.query.root.kind !== "local"} onClick={onRefresh}>
            <RefreshCw />
          </Button>}
        </div>
      </header>
      {layout !== "standard" && viewControls}
      {twin && spaceControl && <div className="pane-volume">
        {localFolder && <><HardDrive aria-hidden="true" />
          <span className="pane-volume-name">{currentLocation ? t(currentLocation.label) : localFolder}</span></>}
        {spaceControl}
      </div>}
      <div className="navigation" data-help-topic="paneNavigation">
        <Button className="icon-button" aria-label={t("Back")} disabled={!processView && !search && pane.position <= 0} onClick={() => onHistory(-1)}><ArrowLeft /></Button>
        <Button className="icon-button" aria-label={t("Forward")} disabled={pane.position + 1 >= pane.history.length} onClick={() => onHistory(1)}><ArrowRight /></Button>
        <Button className="icon-button" aria-label={t("Parent folder")} disabled={!onParent} onClick={onParent}><ArrowUp /></Button>
        <AddressField key={pane.addressRevision} side={side} place={addressPlace ?? pane.place} trail={pane.addressTrail} showHidden={showHidden}
          onNavigate={onPath} onNavigateAncestor={onPathAncestor} onOpenConnections={onOpenConnections}
          onCopy={onCopyPath} focusFiles={() => list.current?.focus()} />
        {sourceMenu}
      </div>
      {!processView && (gitListing || gitUnavailable) && <div className="pane-git-branch" data-help-topic="gitView">
        <GitBranch aria-hidden="true" />{gitListing ? <span dir="auto" data-tooltip={gitListing.status.root}>
          {gitListing.status.headRef?.replace(/^refs\/heads\//, "") ??
            t("Detached HEAD {0}", gitListing.status.head?.slice(0, 7) ?? "")}
          {!gitListing.status.head && <> · {t("No commits yet")}</>}</span> : <span>{t("Git status unavailable")}</span>}
      </div>}
      {processView ? <ProcessBrowser side={side} lockingPath={processView.path} onClose={() => onProcesses(false)}
        menuShortcut={processContextMenuShortcut} onShowExecutable={onShowExecutable} onFeedback={onProcessFeedback} /> : <>
      {(filterOpen || pane.filter) && (
        <label className="pane-filter" data-help-topic="paneFilter">
          <Search />
          <HistoryField historyKey="pane-filter" ref={filterField} aria-label={t(side === "left" ? "Filter left folder" : "Filter right folder")}
            type="text" placeholder={t("Filter this folder")} value={pane.filter} onValueChange={onFilter}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setFilterOpen(false);
                onFilter("");
                list.current?.focus();
              } else if (event.key === "Enter") list.current?.focus();
            }} />
          <Button className="icon-button" aria-label={t("Close filter")} onClick={() => { setFilterOpen(false); onFilter(""); list.current?.focus(); }}><X /></Button>
        </label>
      )}
      {netbox || driveCatalog ? <div className="file-columns" ref={columnHeader}>
        <div className="file-column-grid" style={{ gridTemplateColumns: tracks }}>
          <div className="file-column col-name">
            <Button type="button" onClick={() => onSort("name")} tooltip={t("Sort by {0}", t("Name").toLocaleLowerCase())}>
              <span>{t("Name")}</span>{sortAvailable && pane.sort.column === "name" && (pane.sort.asc ? <ArrowUp /> : <ArrowDown />)}
            </Button>
          </div>
          <div className="file-column"><span className="file-column-label">{t(driveCatalog ? "Account email" : "Protocol")}</span></div>
          <div className="file-column"><span className="file-column-label">{t(driveCatalog ? "Status" : "Host")}</span></div>
        </div>
      </div> : <FileColumns container={columnHeader} groups={groups} columns={withGit} tracks={tracks} samples={widthSamples} statusSamples={statusSamples}
        visibility={visibility} sort={sortAvailable ? pane.sort : { ...pane.sort, column: "name", asc: true }} onSort={onSort}
        onVisibility={(column, visible) => {
          const next = { ...visibility, [column]: visible };
          setModeVisibility((before) => ({ ...before, [layoutMode]: next }));
          saveColumnLayout(side, layoutMode, next);
        }} />}
      {rightClick.spinner && createPortal(<span className="right-selection-hold" role="status"
        aria-label={t("Release to open the context menu")} style={{
          left: Math.min(window.innerWidth - 22, rightClick.spinner.x + 12),
          top: Math.min(window.innerHeight - 22, rightClick.spinner.y + 12),
        }}><LoaderCircle className="spin" aria-hidden="true" /></span>, document.body)}
      <div id={`${side}-files`} ref={list} className={virtual ? "file-list virtual-file-list" : "file-list"} data-paged={paged || undefined}
        role={tree ? "tree" : "listbox"} data-help-return data-file-view={fileView} aria-label={t(side === "left" ? "left files" : "right files")}
        {...rightClick.events}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || event.key !== "ContextMenu" &&
              !bindingMatches(fileContextMenuShortcut, eventShortcut(event))) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.repeat) return;
          const entry = entries[selected];
          const target = event.currentTarget.querySelector<HTMLElement>(".file-row[data-current=true]") ?? event.currentTarget;
          const bounds = target.getBoundingClientRect();
          onContext(bounds.left + 8, bounds.bottom, entry?.name === ".." ? undefined : entry);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (event.button >= 0 && !rightClick.suppressContextMenu(event)) onContext(event.clientX, event.clientY);
        }}
        onWheel={(event) => {
          if (!paged || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
            Math.abs(event.deltaY) <= Math.abs(event.deltaX) || event.timeStamp - lastWheelPage.current < 150) return;
          lastWheelPage.current = event.timeStamp;
          onPage(capacity, Math.sign(event.deltaY));
        }}
        onScroll={(event) => {
          if (columnHeader.current) columnHeader.current.scrollLeft = event.currentTarget.scrollLeft;
          if (!virtual) return;
          const top = event.currentTarget.scrollTop;
          setViewport((previous) => ({ ...previous, top }));
        }}
        aria-multiselectable={!catalog} aria-busy={pane.loading}
        aria-activedescendant={selected >= 0 ? `${side}-file-${selected}` : undefined} tabIndex={0}>
        {virtual && <div ref={rowProbe} className="file-row-probe" aria-hidden="true" />}
        {entries.length > 0 && <div className="file-list-grid" style={{ gridTemplateColumns: tracks }} role="presentation">
          {renderedGroups.map(({ group, first, last, indices }, groupIndex) => <div key={groupIndex} className="file-row-group"
            style={netbox || driveCatalog ? { gridColumn: "1 / -1" } : columnGroupTrack(groups, groupIndex)} role="presentation">
          {indices.map((index, offset) => {
            const gap = index - (indices[offset - 1] ?? first - 1) - 1;
            const entry = entries[index];
            const connection = entry.connection;
            const drive = connection?.kind === "googleDrive" ? connection : undefined;
            const signIn = drive ? t(drive.signInNeeded ? "Sign-in needed" : "Signed in") : "";
            const profile = netbox && (connection?.kind === "ftp" || connection?.kind === "ssh") ? connection : undefined;
            const protocol = profile?.kind === "ssh" ? "SFTP" : profile?.encryption === "explicitTls" ? t("FTPS (explicit)") :
              profile?.encryption === "implicitTls" ? t("FTPS (implicit)") : "FTP";
            const icon = icons.get(byName.get(entry.name) ?? "");
            const measuring = !search && entry.directory && !entry.link && pane.measuring.includes(entry.name);
            const gitPath = gitListing && entry.name !== ".." ? gitPanePath(gitListing, entry) : undefined;
            const gitChanges = gitPath !== undefined ? gitListing?.files.get(gitPath) : undefined;
            const gitFolder = !!(entry.directory && gitPath !== undefined && gitListing?.folders.has(gitPath));
            const gitLabel = gitFolder ? t("Changes in this folder") : gitChanges?.map(gitChangeLabel).join(" · ");
            const marked = markedSet.has(entry.name);
            const appearance = fileAppearance(entry.googleDrive ? { ...entry, name: entry.googleDrive.name } : entry, fileTypes);
            const branchError = entry.tree?.error && (entry.tree.stale
              ? t("Folder contents may be out of date. {0}", errorText(entry.tree.error)) : errorText(entry.tree.error));
            return <Fragment key={entry.name}>
              {gap > 0 && <div className="file-row-spacer" aria-hidden="true" style={{ height: gap * viewport.rowHeight }} />}
              <div id={`${side}-file-${index}`} className={`file-row${marked ? " marked" : ""}`}
                role={tree ? "treeitem" : "option"} aria-setsize={virtual && !tree ? entries.length : undefined}
                aria-posinset={virtual && !tree ? index + 1 : undefined}
                aria-level={entry.tree?.segments.length}
                aria-expanded={entry.tree && entry.directory && !entry.link ? entry.tree.expanded : undefined}
                aria-label={drive ? [drive.label, drive.email, signIn].join(" ") : profile ? [entry.name, protocol, profile.host].join(" ") :
                  group.map(({ field }) => field === "git" ? gitLabel ?? "" : itemValue(entry, field, true)).filter(Boolean).join(" ")}
                aria-description={branchError}
                data-file-color={appearance.tone}
                style={appearance.color || appearance.family ? { "--entry-color": appearance.color,
                  "--entry-font": appearance.family && `${CSS.escape(appearance.family)}, var(--panel-font)` } as CSSProperties : undefined}
                aria-selected={markedSet.size ? marked : index === selected} data-current={index === selected} data-tooltip={entryLabel(entry)} data-entry-index={index}
                data-help-topic={catalog || search ? undefined : "paneSelection"}
                onClick={(event) => { onRow(entry, event.shiftKey, event.ctrlKey || event.metaKey); list.current?.focus({ preventScroll: true }); }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!rightClick.suppressContextMenu(event)) onContext(event.clientX, event.clientY, entry.name === ".." ? undefined : entry);
                }}
                onPointerDown={(event) => { if (entry.name !== ".." && rename?.rowKey !== entry.name) onStartDrag(entry, event); }}
                onDragStart={(event) => event.preventDefault()}
                onDoubleClick={() => onOpen(entry)}>
                {drive ? <>
                  <span className="file-name"><Server aria-hidden="true" /><span className="file-name-text">{drive.label}</span></span>
                  <span className="file-metadata file-host" dir="auto" data-tooltip={drive.email}>{drive.email}</span>
                  <span className="file-metadata file-host" data-tooltip={signIn}>{signIn}</span>
                </> : profile ? <>
                  <span className="file-name"><Server aria-hidden="true" /><span className="file-name-text">{entry.name}</span></span>
                  <span className="file-metadata file-protocol" data-tooltip={protocol}>{protocol}</span>
                  <span className="file-metadata file-host" dir="auto" data-tooltip={profile.host}>{profile.host}</span>
                </> : group.map(({ field }, slot) => isNameField(field) ?
                  <span key={slot} className="file-name">
                    {tree && <span className="file-tree-indent" style={{ width: Math.min(12, (entry.tree?.segments.length ?? 1) - 1) * 12 }} aria-hidden="true" />}
                    {tree && (entry.tree && entry.directory && !entry.link
                      ? <Button type="button" className="file-tree-expand" tabIndex={-1}
                        aria-label={t(entry.tree.expanded ? "Collapse folder" : "Expand folder")}
                        data-tooltip={branchError}
                        onPointerDown={(event) => { if (event.button === 0) event.stopPropagation(); }}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (event.detail <= 1) onTreeBranch(entry);
                          list.current?.focus({ preventScroll: true });
                        }} onDoubleClick={(event) => event.stopPropagation()}>
                        {entry.tree.loading ? <LoaderCircle className="spin" aria-hidden="true" /> :
                          branchError ? <TriangleAlert className="file-tree-error" aria-hidden="true" /> :
                          entry.tree.expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                      </Button> : <span className="file-tree-spacer" aria-hidden="true" />)}
                    {field === "markedName" && <span className="panel-mode-mark" aria-hidden="true">{marked && <Check />}</span>}
                    {entry.directory ? <Folder className="folder-icon" /> :
                      icon ? <img className="native-file-icon" alt="" src={`data:image/png;base64,${icon}`} /> : <File />}
                    {renderName(entry, field, true)}
                    {entry.link && <Link2 className="link-icon" aria-label={t("Link")} />}
                  </span> : field === "git" ? <span key={slot} className="file-git-status">
                    {gitFolder ? <span data-tooltip={gitLabel} aria-label={gitLabel}>Δ</span> : gitChanges && <Button type="button"
                      tabIndex={-1} aria-label={gitLabel} tooltip={gitLabel} onPointerDown={(event) => event.stopPropagation()}
                      onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => {
                        event.stopPropagation();
                        const rect = event.currentTarget.getBoundingClientRect();
                        onContext(rect.left, rect.bottom, entry);
                      }}>
                      {gitChanges.map(({ group, status }) => <span key={group} data-git-group={group}>{group === "staged" ? "S" : group === "unstaged" ? "W" : ""}{status}</span>)}
                    </Button>}
                  </span> :
                  <span key={slot} className={`file-metadata file-${fieldClass[field] === "modified" ? "date" : fieldClass[field]}`}>
                    {(field === "bytes" || field === "size") && measuring ?
                      <LoaderCircle className="spin" aria-label={t("Measuring folder")} /> : itemValue(entry, field)}
                  </span>)}
              </div>
            </Fragment>;
          })}
          {virtual && (indices.at(-1) ?? first - 1) < last - 1 &&
            <div className="file-row-spacer" aria-hidden="true" style={{ height: (last - (indices.at(-1) ?? first - 1) - 1) * viewport.rowHeight }} />}
          </div>)}
        </div>}
        {(!entries.length || pane.place?.kind === "googleDrive" && entries.length === 1 && entries[0].name === "..") && (
          <div className="pane-empty">
            {(netbox || driveCatalog) && !pane.loading && !pane.error && !pane.filter ? <>
              <p>{t("No saved connections.")}</p>
              <Button type="button" onClick={() => onAddConnection(driveCatalog ? "googleDrive" : "netbox")}>{t("Add connection")}</Button>
            </> : pane.loading ? t("Loading…") : pane.error ? (netbox || driveCatalog || pane.place?.kind === "googleDrive" ? null : t("Open another location to continue.")) :
              pane.filter ? t("No items match the filter.") : search ? t("No visible matches.") : pane.place ? t("This folder is empty.") : t("Choose a location.")}
          </div>
        )}
      </div>
      {quickSearch !== null && <QuickSearch side={side} query={quickSearch} current={pane.selected} fileNames={!catalog}
        items={folderItems.map((entry) => ({ id: entry.name, name: matches?.get(entry.name)?.entry.name ?? entry.tree?.segments.at(-1) ?? entryLabel(entry) }))}
        onChange={setQuickSearch} onMatch={onQuickMatch}
        onAccept={(name) => { const entry = entries.find((item) => item.name === name); if (entry) onOpen(entry); }}
        onClose={() => setQuickSearch(null)} focusList={() => list.current?.focus({ preventScroll: true })} />}
      {fileOpenFeedback}
      {pane.error && <div className="pane-error" data-help-topic="paneStatus">
        <span role="alert">{errorText(pane.error)}</span>
        {(netbox || driveCatalog) && !pane.loading && <Button type="button" onClick={onRefresh}>{t("Refresh connections")}</Button>}
        {pane.place?.kind === "googleDrive" && pane.error === googleDriveSignInRequired &&
          <Button type="button" onClick={onReconnectGoogleDrive}>{t("Reconnect")}</Button>}
        {pane.deniedSshListing && !pane.loading &&
          <Button type="button" onClick={onRetryWithSudo}>{t("Open with sudo…")}</Button>}
        <Button type="button" className="icon-button" aria-label={t("Dismiss error")} onClick={onDismissError}><X /></Button>
      </div>}
      {pane.elevationPath && <ElevationButton directory={pane.elevationPath} side={side} />}
      {pane.cachedListing && !pane.loading && <div className="pane-status-note" role="status">{t("Showing a cached directory listing.")}</div>}
      <footer className="pane-footer" data-help-topic="paneStatus">
        {pane.loading ? <div className="pane-progress">
          <div className="pane-progress-status" role="status" data-tooltip={pane.loadingPath ?? loadingLabel}>
            <LoaderCircle className="spin" aria-hidden="true" />
            <span>{loadingLabel}</span>
            {pane.loadingPath && <span className="pane-progress-path">{pane.loadingPath}</span>}
          </div>
          <Button type="button" aria-label={t("Cancel folder navigation")}
            shortcut={cancelKey} onClick={onCancelFolderOperation}>
            {t("Cancel")}{cancelKey && <kbd aria-hidden="true">{cancelKey}</kbd>}
          </Button>
        </div> : <>
          <div className="pane-status-line">
            {pane.measuring.length > 0 ? <div className="pane-progress pane-measurement">
              <div className="pane-progress-status" role="status" data-tooltip={measuringLabel}>
                <LoaderCircle className="spin" aria-hidden="true" /><span>{measuringLabel}</span>
              </div>
              <Button type="button" className="icon-button" aria-label={t("Cancel folder size calculation")}
                shortcut={cancelKey} onClick={onCancelFolderOperation}><X aria-hidden="true" /></Button>
            </div> : current && current.name !== ".." && statusColumns.length > 0 &&
              <div className="pane-details" style={{ gridTemplateColumns: panelColumnTracks(statusColumns, true) }}
                data-tooltip={statusColumns.map(({ field }) => itemValue(current, field)).filter(Boolean).join(" · ")}>
                {statusColumns.map(({ field }, index) => <span key={index} className={`pane-detail pane-detail-${fieldClass[field]}`}
                  data-tooltip={itemValue(current, field)}>
                  {isNameField(field) ? <>{field === "markedName" && markedSet.has(current.name) && <Check aria-hidden="true" />}
                    {renderName(current, field, false)}</> : itemValue(current, field)}
                </span>)}
              </div>}
            <div className="pane-summary">
              <span className="pane-counts" data-tooltip={search ? countText(entries.length, "match") :
                countText(folders, "folder") + " · " + countText(folderItems.length - folders, "file")}>
                <span className="pane-counts-full">{search ? countText(entries.length, "match") :
                  <>{countText(folders, "folder")}<span className="dot" />{countText(folderItems.length - folders, "file")}</>}</span>
                <span className="pane-counts-compact" aria-hidden="true">
                  {search ? <><Search />{entries.length.toLocaleString(locale())}</> :
                    <><Folder />{folders.toLocaleString(locale())}<File />{(folderItems.length - folders).toLocaleString(locale())}</>}
                </span>
              </span>
              {marked.length > 0 ? <span className="pane-marked">{t("{0} marked · {1}{2}", marked.length, complete ? "" : "≥ ", formatSize(markedBytes))}</span> :
                <span className="pane-note">{sortPending ? t("Loading sort metadata…") : search ? pane.search?.incomplete ? t("Partial results") : "" :
                  pane.omitted ? t("{0} unavailable", pane.omitted) : ""}</span>}
              {!twin && spaceControl}
            </div>
          </div>
        </>}
      </footer>
      </>}
    </section>
  );
}
