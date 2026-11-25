import { HistoryField } from "./HistoryField";
import { countText, errorText, locale, t } from "./i18n";
import { Button } from "./Button";
import { AddressField } from "./AddressField";
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronRight, File, Folder, Ruler,
  Activity, HardDrive, Link2, LoaderCircle, RefreshCw, Search, Server, TriangleAlert, X,
} from "lucide-react";
import { api, describeError, folderLabel, placePath, smbHost, windowsClient, type ComputerDrive, type ConnectionSource, type DiskSpace, type Entry, type FileLocation, type PanelMetadataRequest, type Place, type QuickLocation } from "./api";
import { folderMeasurement, formatDate, formatSize, paneCursorIndex, paneItem, type FilePaneView, type PaneState, type Side, type SortColumn } from "./panes";
import { ElevationButton, ProcessBrowser } from "./ProcessTools";
import { fileAppearance, type FileTypeIndex } from "./appearance";
import { fileIconKey, useWindowsIcons } from "./useWindowsIcons";
import { showShortcut, type PanelLayout } from "./preferences";
import { useTimestamps } from "./useTimestamps";
import { viewFontStyle } from "./viewFonts";
import { columnGroupTrack, fieldClass, FileColumns, measuredColumnFields, panelColumnTracks, readColumnLayout, saveColumnLayout, type MeasuredColumnField } from "./FileColumns";
import { defaultPanelModes, displayPanelName, isNameField, panelColumnGroups, type PanelField, type PanelMode, type PanelModeId } from "./panelModes";
import { usePanelMetadata } from "./usePanelMetadata";
import { QuickSearch, useQuickSearch } from "./QuickSearch";
import { SpaceControl } from "./SpaceControl";
import { canAnalyze, type Metric, type SpacePlace } from "./spaceScan";
import { useRightClickSelection } from "./useRightClickSelection";

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
  onPath: (path: string) => void;
  onLocalLocation: (location: QuickLocation) => void;
  onPathAncestor: (place: Place) => void;
  onOpenConnections: (source: ConnectionSource) => void;
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
  onShowExecutable: (path: string) => Promise<void>;
  onProcessFeedback: (text: string, error?: boolean) => void;
  onContext: (x: number, y: number, entry?: Entry, preserveMarks?: boolean) => void;
  onAnalyze: (place: SpacePlace) => void;
  spaceDisabled: boolean;
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
  rightClickSelection, pane, entries, fileTypes, fileView, onFileView, onTreeBranch, folderSizes, onFolderSizes, locations, rename, activate, onRow,
  onRightClickMark, onQuickMatch, onOpen, onPath, onLocalLocation,
  onHistory, onParent, onRefresh, onFilter, onSort, sourceMenu, fontSize, onCloseResults, onRevealResult,
  onStartDrag, dropTarget, processView, onProcesses, processContextMenuShortcut, onShowExecutable, onProcessFeedback,
  onContext, onCancelFolderOperation, cancelFolderShortcut,
  onPathAncestor, onOpenConnections, onCopyPath, onDismissError, onRetryWithSudo, onAnalyze, spaceDisabled }: PaneProps) {
  const section = useRef<HTMLElement>(null);
  const path = pane.place ? placePath(pane.place) : "";
  const catalog = pane.place?.kind === "connections";
  const [filterOpen, setFilterOpen] = useState(false);
  const [quickSearch, setQuickSearch] = useQuickSearch(side, !processView);
  const list = useRef<HTMLDivElement>(null);
  const markedSet = new Set(pane.marked);
  const rightClick = useRightClickSelection({ list, entries, marked: markedSet, scope: path,
    enabled: rightClickSelection && !catalog && !processView && !covered && !pane.loading,
    onMark: onRightClickMark, onContext: (x, y, entry) => onContext(x, y, entry, true) });
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
  const tree = fileView === "tree";
  const columnsInMode = definition.list.filter(({ field }) => isNameField(field) || visibility[fieldClass[field]] !== false);
  const modeGroups = panelColumnGroups(columnsInMode);
  const groups = (tree ? modeGroups.slice(0, 1) : modeGroups).map((group) =>
    (folderSizes.active || folderSizes.branchActive) && !group.some(({ field }) => field === "size" || field === "bytes")
      ? [...group, { field: "size" as const, width: "0" }] : group);
  const columns = groups.flat();
  const hasReadyBackgroundSize = useMemo(() => {
    for (const size of pane.backgroundSizes?.values() ?? []) {
      if (!size.pending && !size.unavailable) return true;
    }
    return false;
  }, [pane.backgroundSizes]);
  const fitMeasuredFolders = !pane.search && (pane.sizes.size > 0 || hasReadyBackgroundSize);
  const tracks = panelColumnTracks(columns, fitMeasuredFolders);
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
  const statusColumns = catalog ? [] : mode.status;
  const displayedColumns = [...columns, ...statusColumns];
  const displayedFields = displayedColumns.map(({ field }) => field);
  const automatic = measuredColumnFields.filter((field) => displayedColumns.some((column) => column.field === field && column.width === "0"));
  const autoSize = automatic.includes("size");
  const autoBytes = automatic.includes("bytes");
  const sampleSize = autoSize || (fitMeasuredFolders && columns.some(({ field }) => field === "size"));
  const sampleBytes = autoBytes || (fitMeasuredFolders && columns.some(({ field }) => field === "bytes"));
  const language = locale();
  const bytesFormat = useMemo(() => new Intl.NumberFormat(language), [language]);
  const measuredSizes = useMemo(() => {
    const size = new Map<string, string>();
    const bytes = new Map<string, string>();
    if (!search && (sampleSize || sampleBytes)) {
      const measurements = pane.backgroundSizes ? new Map([...pane.sizes, ...pane.backgroundSizes]) : pane.sizes;
      for (const [name, result] of measurements) {
        const background = pane.backgroundSizes?.get(name);
        if (background?.unavailable || (background?.pending && background.bytes === 0)) continue;
        const measured = pane.sizes.has(name) || !!background;
        // The pane uses tabular figures. One sample per digit pattern keeps large batches compact.
        if (autoSize || (sampleSize && measured)) {
          const sample = sizeLabel(result.bytes, result.incomplete);
          size.set(sample.replace(/\p{Decimal_Number}/gu, "0"), sample);
        }
        if (autoBytes || (sampleBytes && measured)) {
          const sample = sizeLabel(result.bytes, result.incomplete, bytesFormat);
          bytes.set(sample.replace(/\p{Decimal_Number}/gu, "0"), sample);
        }
      }
    }
    return { size: [...size.values()], bytes: [...bytes.values()] };
  }, [search, autoSize, autoBytes, sampleSize, sampleBytes, pane.backgroundSizes, pane.sizes, bytesFormat]);
  const visibleTimestamps = processView ? [] : indices.map((index) => entries[index].modified);
  const dateLabel = useTimestamps(displayedFields.includes("date") ? visibleTimestamps : [], "date");
  const timeLabel = useTimestamps(displayedFields.includes("time") ? visibleTimestamps : [], "time");
  const metadataRequests = new Map<string, PanelMetadataRequest>();
  const listingFields = columns.map(({ field }) => field);
  const statusFields = statusColumns.map(({ field }) => field);
  if (!processView && (displayedFields.includes("owner") || displayedFields.includes("links"))) {
    for (const index of indices) {
      const entry = entries[index];
      const item = paneItem(pane, entry);
      if (item?.place.kind !== "local") continue;
      const owner = listingFields.includes("owner") || (index === selected && statusFields.includes("owner"));
      const links = !entry.directory && !entry.link &&
        (listingFields.includes("links") || (index === selected && statusFields.includes("links")));
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
    if (!active || selected < 0 || paged) return;
    if (virtual) {
      const top = (selected % rowsPerGroup) * viewport.rowHeight;
      const bottom = top + viewport.rowHeight + 8;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
      setViewport((before) => before.top === element.scrollTop ? before : { ...before, top: element.scrollTop });
    } else {
      element.querySelector("[data-current='true']")?.scrollIntoView({ block: "nearest" });
    }
  }, [selected, path, active, virtual, matches, viewport.rowHeight, rowsPerGroup, processView, preserveScroll, paged]);
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
    const request = metadataRequests.get(entry.name);
    const details = request && metadata?.get(metadataKey(request));
    switch (field) {
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
        const original = matches?.get(entry.name)?.entry.name ?? entry.tree?.segments.at(-1) ?? entry.name;
        const display = displayPanelName(original, entry.directory, definition);
        const prefix = listing && !entry.tree && original !== entry.name ? entry.name.slice(0, -original.length) : "";
        return prefix.normalize("NFC") + display;
      }
    }
  }

  const widthSamples: Partial<Record<MeasuredColumnField, string[]>> = { ...measuredSizes };
  for (const field of automatic) {
    const samples = new Set(field === "size" || field === "bytes" ? measuredSizes[field] : []);
    for (const index of indices) samples.add(itemValue(entries[index], field));
    widthSamples[field] = [...samples];
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
  const viewControls = !catalog && !processView && !search && pane.place && <div className="pane-view-toolbar" data-help-topic="paneViews">
      <div className="pane-view-modes" role="group" aria-label={t("File pane view")}>
          <Button type="button" aria-pressed={!tree} disabled={!localView} onClick={() => onFileView("list")}>{t("List")}</Button>
          <Button type="button" aria-pressed={tree} disabled={!localView} onClick={() => onFileView("tree")}>{t("Tree")}</Button>
        </div>
        <Button type="button" aria-pressed={folderSizes.active} disabled={!localView} onClick={onFolderSizes}>
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
            {pane.place.kind === "archive" ? t(pane.place.address) : t("Remote")}</span>}
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
      <FileColumns container={columnHeader} groups={groups} columns={definition.list} tracks={tracks} samples={widthSamples}
        visibility={visibility} sort={sortAvailable ? pane.sort : { ...pane.sort, column: "name", asc: true }} onSort={onSort}
        onVisibility={(column, visible) => {
          const next = { ...visibility, [column]: visible };
          setModeVisibility((before) => ({ ...before, [layoutMode]: next }));
          saveColumnLayout(side, layoutMode, next);
        }} />
      {rightClick.spinner && createPortal(<span className="right-selection-hold" role="status"
        aria-label={t("Release to open the context menu")} style={{
          left: Math.min(window.innerWidth - 22, rightClick.spinner.x + 12),
          top: Math.min(window.innerHeight - 22, rightClick.spinner.y + 12),
        }}><LoaderCircle className="spin" aria-hidden="true" /></span>, document.body)}
      <div id={`${side}-files`} ref={list} className={virtual ? "file-list virtual-file-list" : "file-list"} data-paged={paged || undefined}
        role={tree ? "tree" : "listbox"} data-help-return data-file-view={fileView} aria-label={t(side === "left" ? "left files" : "right files")}
        {...rightClick.events}
        onContextMenu={(event) => {
          event.preventDefault();
          if (!rightClick.suppressContextMenu(event)) onContext(event.clientX, event.clientY);
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
            style={columnGroupTrack(groups, groupIndex)} role="presentation">
          {indices.map((index, offset) => {
            const gap = index - (indices[offset - 1] ?? first - 1) - 1;
            const entry = entries[index];
            const icon = icons.get(byName.get(entry.name) ?? "");
            const measuring = !search && entry.directory && !entry.link && pane.measuring.includes(entry.name);
            const marked = markedSet.has(entry.name);
            const appearance = fileAppearance(entry, fileTypes);
            const branchError = entry.tree?.error && (entry.tree.stale
              ? t("Folder contents may be out of date. {0}", errorText(entry.tree.error)) : errorText(entry.tree.error));
            return <Fragment key={entry.name}>
              {gap > 0 && <div className="file-row-spacer" aria-hidden="true" style={{ height: gap * viewport.rowHeight }} />}
              <div id={`${side}-file-${index}`} className={`file-row${marked ? " marked" : ""}`}
                role={tree ? "treeitem" : "option"} aria-setsize={virtual && !tree ? entries.length : undefined}
                aria-posinset={virtual && !tree ? index + 1 : undefined}
                aria-level={entry.tree?.segments.length}
                aria-expanded={entry.tree && entry.directory && !entry.link ? entry.tree.expanded : undefined}
                aria-label={group.map(({ field }) => itemValue(entry, field, true)).join(" ")}
                aria-description={branchError}
                data-file-color={appearance.tone}
                style={appearance.color || appearance.family ? { "--entry-color": appearance.color,
                  "--entry-font": appearance.family && `${CSS.escape(appearance.family)}, var(--panel-font)` } as CSSProperties : undefined}
                aria-selected={markedSet.size ? marked : index === selected} data-current={index === selected} data-tooltip={entry.name} data-entry-index={index}
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
                {group.map(({ field }, slot) => isNameField(field) ?
                  <span key={slot} className="file-name" data-marked-name={field === "markedName" || undefined}>
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
        {!entries.length && (
          <div className="pane-empty">
            {pane.loading ? t("Loading…") : pane.error ? t("Open another location to continue.") :
              pane.filter ? t("No items match the filter.") : search ? t("No visible matches.") : pane.place ? t("This folder is empty.") : t("Choose a location.")}
          </div>
        )}
      </div>
      {quickSearch !== null && <QuickSearch side={side} query={quickSearch} current={pane.selected}
        items={folderItems.map(({ name, tree }) => ({ id: name, name: matches?.get(name)?.entry.name ?? tree?.segments.at(-1) ?? name }))}
        onChange={setQuickSearch} onMatch={onQuickMatch}
        onAccept={(name) => { const entry = entries.find((item) => item.name === name); if (entry) onOpen(entry); }}
        onClose={() => setQuickSearch(null)} focusList={() => list.current?.focus({ preventScroll: true })} />}
      {pane.error && <div className="pane-error" data-help-topic="paneStatus">
        <span role="alert">{errorText(pane.error)}</span>
        {pane.deniedSshListing && !pane.loading &&
          <Button type="button" onClick={onRetryWithSudo}>{t("Open with sudo…")}</Button>}
        <Button type="button" className="icon-button" aria-label={t("Dismiss error")} onClick={onDismissError}><X /></Button>
      </div>}
      {pane.elevationPath && <ElevationButton directory={pane.elevationPath} side={side} />}
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
              <div className="pane-details" style={{ gridTemplateColumns: panelColumnTracks(statusColumns) }}
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
