import { HistoryField } from "./HistoryField";
import { countText, errorText, locale, t } from "./i18n";
import { Button } from "./Button";
import { AddressField } from "./AddressField";
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, Check, ChevronDown, File, Folder,
  Activity, HardDrive, Link2, LoaderCircle, RefreshCw, Search, Server, X,
} from "lucide-react";
import { api, describeError, folderLabel, placePath, smbHost, windowsClient, type DiskSpace, type Entry, type PanelMetadataRequest, type Place, type QuickLocation } from "./api";
import { folderMeasurement, formatDate, formatSize, paneCursorIndex, paneItem, parentPlace, type PaneState, type Side, type SortColumn } from "./panes";
import { ElevationButton, ProcessBrowser } from "./ProcessTools";
import { fileColor } from "./appearance";
import { fileIconKey, useWindowsIcons } from "./useWindowsIcons";
import { bindingMatches, driveSourceCommand, eventShortcut, showShortcut, type Bindings, type DriveSourceCommand, type PanelLayout } from "./preferences";
import { useFontZoom } from "./useFontZoom";
import { useTimestamps } from "./useTimestamps";
import { viewFontStyle, type ZoomViewFont } from "./viewFonts";
import { columnGroupTrack, fieldClass, FileColumns, panelColumnTracks, readColumnLayout, saveColumnLayout } from "./FileColumns";
import { defaultPanelModes, displayPanelName, isNameField, panelColumnGroups, type PanelField, type PanelMode, type PanelModeId } from "./panelModes";
import { usePanelMetadata } from "./usePanelMetadata";
import { QuickSearch, useQuickSearch } from "./QuickSearch";

interface PaneProps {
  side: Side;
  active: boolean;
  layout: PanelLayout;
  modeId: PanelModeId;
  mode: PanelMode;
  sortAvailable: boolean;
  sortPending: boolean;
  onGroupRows: (rows: number) => void;
  showHidden: boolean;
  pane: PaneState;
  entries: Entry[];
  locations: QuickLocation[];
  rename?: { name: string; onSave: (name: string) => Promise<void>; onCancel: () => void };
  activate: () => void;
  onRow: (entry: Entry, range: boolean, mark: boolean) => void;
  onQuickMatch: (name: string) => void;
  onOpen: (entry: Entry) => void;
  onPath: (path: string) => void;
  onLocalLocation: (location: QuickLocation) => void;
  onPathAncestor: (place: Place) => void;
  onCopyPath: (path: string) => void;
  onHistory: (offset: number) => void;
  onParent: () => void;
  onRefresh: () => void;
  onDismissError: () => void;
  onRetryWithSudo: () => void;
  onCancelFolderOperation: () => void;
  cancelFolderShortcut: readonly string[];
  onFilter: (filter: string) => void;
  onSort: (column: SortColumn) => void;
  onRemote: () => void;
  onFtp: () => void;
  onSsh: () => void;
  onSmb: () => void;
  sourceBindings: Pick<Bindings, "processSources" | "ftpSources" | "sshSources" | "smbSources" | "remoteSources" | DriveSourceCommand>;
  zoomShortcut: readonly string[];
  fontSize?: number;
  onZoom: ZoomViewFont;
  onCloseResults: () => void;
  onRevealResult: (entry: Entry) => void;
  onStartDrag: (entry: Entry, event: ReactPointerEvent) => void;
  dropTarget: boolean;
  processView: { path?: string } | null;
  onProcesses: (visible: boolean) => void;
  onContext: (x: number, y: number, entry?: Entry) => void;
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

export function Pane({ side, active, layout, modeId, mode, sortAvailable, sortPending, onGroupRows, showHidden, pane, entries, locations, rename, activate, onRow, onQuickMatch, onOpen, onPath, onLocalLocation,
  onHistory, onParent, onRefresh, onFilter, onSort, onRemote, onFtp, onSsh, onSmb, sourceBindings, zoomShortcut, fontSize, onZoom, onCloseResults, onRevealResult,
  onStartDrag, dropTarget, processView, onProcesses, onContext, onCancelFolderOperation, cancelFolderShortcut,
  onPathAncestor, onCopyPath, onDismissError, onRetryWithSudo }: PaneProps) {
  const section = useRef<HTMLElement>(null);
  useFontZoom(section, zoomShortcut, side, onZoom);
  const path = pane.place ? placePath(pane.place) : "";
  const catalog = pane.place?.kind === "connections";
  const [filterOpen, setFilterOpen] = useState(false);
  const [quickSearch, setQuickSearch] = useQuickSearch(side, !processView);
  const [locationsOpen, setLocationsOpen] = useState(false);
  const locationsBox = useRef<HTMLDivElement>(null);
  const locationsButton = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
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
  const columns = definition.list.filter(({ field }) => isNameField(field) || visibility[fieldClass[field]] !== false);
  const groups = panelColumnGroups(columns);
  const tracks = panelColumnTracks(columns);
  const rowProbe = useRef<HTMLDivElement>(null);
  const filterField = useRef<HTMLInputElement>(null);
  const selected = paneCursorIndex(pane, entries);
  const search = Boolean(pane.search);
  const matches = pane.search?.matches;
  const [viewport, setViewport] = useState({ top: 0, height: 0, rowHeight: 29 });
  const grouped = groups.length > 1;
  const virtual = grouped || search || entries.length > 100;
  const visibleRows = Math.max(1, Math.floor((viewport.height - 8) / viewport.rowHeight));
  const rowsPerGroup = grouped ? Math.max(visibleRows, Math.ceil(entries.length / groups.length)) : Math.max(1, entries.length);
  const renderedGroups = groups.map((group, groupIndex) => {
    const first = groupIndex * rowsPerGroup;
    const last = Math.min(first + rowsPerGroup, entries.length);
    const start = virtual ? Math.min(last, first + Math.max(0, Math.floor(viewport.top / viewport.rowHeight) - 5)) : first;
    const end = virtual ? Math.min(last, first + Math.ceil((viewport.top + viewport.height) / viewport.rowHeight) + 6) : last;
    const indices = Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset);
    if (virtual && selected >= first && selected < last && (selected < start || selected >= end)) {
      indices.push(selected);
      indices.sort((left, right) => left - right);
    }
    return { group, first, last, indices };
  });
  const indices = renderedGroups.flatMap(({ indices }) => indices);
  const statusColumns = catalog ? [] : mode.status;
  const displayedFields = [...columns, ...statusColumns].map(({ field }) => field);
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
  const [space, setSpace] = useState<{ folder: string; value: DiskSpace } | null>(null);
  useEffect(() => {
    if (!localFolder || pane.loading) return;
    let cancelled = false;
    api.diskSpace(localFolder).then((value) => {
      if (!cancelled) setSpace(value ? { folder: localFolder, value } : null);
    }, () => {
      if (!cancelled) setSpace(null);
    });
    return () => { cancelled = true; };
  }, [localFolder, pane.loading, pane.entries]);
  const free = localFolder && space?.folder === localFolder ? space.value : null;
  const freeLabel = free ? t("{0} free of {1}", formatSize(free.available), formatSize(free.total)) : undefined;

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
  useLayoutEffect(() => { onGroupRows(grouped && !processView ? rowsPerGroup : 0); }, [grouped, processView, rowsPerGroup, onGroupRows]);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    element.scrollTop = 0;
    if (columnHeader.current) columnHeader.current.scrollLeft = element.scrollLeft;
    setViewport((before) => before.top === element.scrollTop ? before : { ...before, top: element.scrollTop });
  }, [path, matches, processView]);
  useLayoutEffect(() => {
    const element = list.current;
    if (!active || selected < 0 || !element) return;
    if (virtual) {
      const top = (selected % rowsPerGroup) * viewport.rowHeight;
      const bottom = top + viewport.rowHeight + 8;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
      setViewport((before) => before.top === element.scrollTop ? before : { ...before, top: element.scrollTop });
    } else {
      element.querySelector("[data-current='true']")?.scrollIntoView({ block: "nearest" });
    }
  }, [selected, path, active, virtual, matches, viewport.rowHeight, rowsPerGroup, processView]);
  useEffect(() => {
    if (!locationsOpen) return;
    locationsBox.current?.querySelector<HTMLButtonElement>(".location-popup button")?.focus();
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !locationsBox.current?.contains(event.target)) setLocationsOpen(false);
    }
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [locationsOpen]);
  useEffect(() => {
    const target = document.getElementById(`${side}-pane`);
    const show = () => {
      setFilterOpen(true);
      requestAnimationFrame(() => filterField.current?.focus());
    };
    const showLocations = () => {
      setLocationsOpen((open) => !open);
      locationsButton.current?.focus();
    };
    target?.addEventListener("dirlume-filter", show);
    target?.addEventListener("dirlume-locations", showLocations);
    return () => {
      target?.removeEventListener("dirlume-filter", show);
      target?.removeEventListener("dirlume-locations", showLocations);
    };
  }, [side]);

  const title = processView ? t("Processes") : search ? t("Search results") : pane.place ? folderLabel(pane.place) : t(side === "left" ? "Left pane" : "Right pane");
  const cancelKey = cancelFolderShortcut[0] === "Escape" ? "Esc" : showShortcut(cancelFolderShortcut[0]);
  const loadingLabel = t("Opening folder…");
  const host = smbHost(pane.place);
  const isRemote = host || (pane.place && pane.place.kind !== "local");
  const sources = [
    { label: t("Processes"), key: sourceBindings.processSources, Icon: Activity, open: () => onProcesses(true) },
    { label: "FTP", key: sourceBindings.ftpSources, Icon: Server, open: onFtp },
    { label: "SSH", key: sourceBindings.sshSources, Icon: Server, open: onSsh },
    ...(windowsClient ? [{ label: "SMB", key: sourceBindings.smbSources, Icon: Server, open: onSmb }] : []),
    { label: t("Remote machine"), key: sourceBindings.remoteSources, Icon: Server, open: onRemote },
  ];
  const localLocations = locations.map((location) => {
    const command = driveSourceCommand(location);
    return { location, bindings: command ? sourceBindings[command] : [] };
  });
  function openLocalLocation(location: QuickLocation) {
    setLocationsOpen(false);
    onLocalLocation(location);
    list.current?.focus();
  }
  const folderItems = entries.filter(({ name }) => name !== "..");
  const folders = folderItems.reduce((count, entry) => count + Number(entry.directory), 0);
  const markedSet = new Set(pane.marked);
  const marked = entries.filter(({ name }) => markedSet.has(name));
  const complete = marked.every((entry) => entry.directory ? folderMeasurement(pane, entry)?.incomplete === false : entry.size !== null);
  const markedBytes = marked.reduce((bytes, entry) => bytes + (folderMeasurement(pane, entry)?.bytes ?? entry.size ?? 0), 0);

  const twin = layout === "twin";
  const current = selected >= 0 ? entries[selected] : undefined;
  const missing = "—";
  function itemValue(entry: Entry, field: PanelField, listing = false) {
    const request = metadataRequests.get(entry.name);
    const details = request && metadata?.get(metadataKey(request));
    switch (field) {
      case "size":
      case "bytes": {
        const size = folderMeasurement(pane, entry);
        const count = size?.bytes ?? (entry.directory ? null : entry.size);
        if (count === null) return missing;
        const value = field === "bytes" ? count.toLocaleString(locale()) : formatSize(count);
        return size?.incomplete ? `≥ ${value}` : value;
      }
      case "date": return entry.modified === null ? missing : dateLabel(entry.modified) ?? formatDate(entry.modified, "date");
      case "time": return entry.modified === null ? missing : timeLabel(entry.modified) ?? formatDate(entry.modified, "time");
      case "owner": return entry.owner || details?.owner || missing;
      case "links": {
        const links = entry.directory || entry.link ? null : entry.hardLinks ?? details?.hardLinks;
        return links == null ? missing : links.toLocaleString(locale());
      }
      default: {
        const original = matches?.get(entry.name)?.entry.name ?? entry.name;
        const display = displayPanelName(original, entry.directory, definition);
        const prefix = listing && original !== entry.name ? entry.name.slice(0, -original.length) : "";
        return prefix.normalize("NFC") + display;
      }
    }
  }

  function renderName(entry: Entry, field: PanelField, listing: boolean) {
    const text = itemValue(entry, field, listing);
    if (listing && rename?.name === entry.name) return <InlineRenameField {...rename} />;
    const dot = (entry.directory ? definition.alignFolders : definition.alignFiles) ? text.lastIndexOf(".") : -1;
    const aligned = dot > text.lastIndexOf("/") + 1 && dot < text.length - 1;
    return <span className={`file-name-text${field === "rightName" ? " file-name-end" : ""}${aligned && field !== "rightName" ? " file-name-aligned" : ""}`}>
      {aligned && field !== "rightName" ? <><span>{text.slice(0, dot)}</span><span>{text.slice(entry.directory ? dot : dot + 1)}</span></> :
        field === "rightName" ? <span>{text}</span> : text}
    </span>;
  }
  const usedShare = free && free.total > 0 ? Math.min(100, Math.max(0, 100 - free.available / free.total * 100)) : 0;
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
  return (
    <section ref={section} id={`${side}-pane`} style={viewFontStyle(fontSize)}
      data-panel-mode={catalog || processView ? undefined : modeId}
      data-drop-pane={side} data-layout={layout} className={`pane${active ? " active" : ""}${dropTarget ? " drop-target" : ""}`}
      aria-label={t(side === "left" ? "left pane" : "right pane")}
      onPointerDown={activate} onFocus={activate}>
      <header className={`pane-heading${(catalog || localFolder && !host) && !processView && !search ? " local-heading" : ""}`}>
        {layout !== "standard" && <nav className="drive-bar" aria-label={t(side === "left" ? "Drives and places for left pane" : "Drives and places for right pane")}>
          {locations.map((location) => (
            <Button key={location.path} type="button" data-tooltip={location.path} aria-pressed={location === currentLocation}
              onClick={() => openLocalLocation(location)}>
              {twin && (/^[a-z]:$/i.test(location.label) ? <HardDrive aria-hidden="true" /> : <Folder aria-hidden="true" />)}{t(location.label)}
            </Button>
          ))}
        </nav>}
        <div className="pane-title">
          {processView ? <Activity /> : search ? <Search /> : isRemote ? <Server /> : <Folder />}
          <h2 data-tooltip={pane.search?.mask ?? title}>{title}</h2>
          {!processView && pane.place && pane.place.kind !== "connections" && pane.place.kind !== "local" && pane.place.kind !== "smbRoot" && <span className="remote-name"
            data-tooltip={pane.place.kind === "archive" ? t(pane.place.address) : pane.place.address}>
            {pane.place.kind === "archive" ? t(pane.place.address) : t("Remote")}</span>}
          {!processView && host && <span className="remote-name" data-tooltip={path}>SMB · {host}</span>}
        </div>
        <div className="pane-tools">
          {processView && <Button className="icon-button" aria-label={t("Close processes")}
            onClick={() => onProcesses(false)}><X /></Button>}
          {search && !processView && <>
            <Button className="icon-button" aria-label={t("Go to selected file")} disabled={selected < 0}
              onClick={() => onRevealResult(entries[selected])}><ArrowUpRight /></Button>
            <Button className="icon-button" aria-label={t("Close search results")}
              onClick={onCloseResults}><X /></Button>
          </>}
          {!processView && <Button className="icon-button" aria-label={t("Filter folder")} aria-pressed={filterOpen}
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
          {!processView && <Button className="icon-button" aria-label={t("Refresh folder")} disabled={search || !pane.place || pane.loading} onClick={onRefresh}>
            <RefreshCw />
          </Button>}
        </div>
      </header>
      {twin && localFolder && !search && !processView && <div className="pane-volume">
        <HardDrive aria-hidden="true" />
        <span className="pane-volume-name">{currentLocation ? t(currentLocation.label) : localFolder}</span>
        {free && <>
          <span className="pane-volume-free" data-tooltip={freeLabel}>{freeLabel}</span>
          <span className="space-meter" aria-hidden="true"><span style={{ width: `${usedShare}%` }} /></span>
        </>}
      </div>}
      <div className="navigation">
        <Button className="icon-button" aria-label={t("Back")} disabled={!processView && !search && pane.position <= 0} onClick={() => onHistory(-1)}><ArrowLeft /></Button>
        <Button className="icon-button" aria-label={t("Forward")} disabled={pane.position + 1 >= pane.history.length} onClick={() => onHistory(1)}><ArrowRight /></Button>
        <Button className="icon-button" aria-label={t("Parent folder")} disabled={!processView && !search && !catalog && (!pane.place || !parentPlace(pane.place))} onClick={onParent}><ArrowUp /></Button>
        {pane.place?.kind === "connections" ? <div className="address" id={side + "-path"} data-path={path}>
          <div className="address-breadcrumbs connection-address"><Server aria-hidden="true" />{t(path)}</div>
        </div> : <AddressField key={pane.addressRevision} side={side} place={pane.place} showHidden={showHidden}
          onNavigate={onPath} onNavigateAncestor={onPathAncestor} onCopy={onCopyPath} focusFiles={() => list.current?.focus()} />}
        <div className="location-menu" ref={locationsBox} onKeyDown={(event) => {
          if (!locationsOpen || event.defaultPrevented || event.nativeEvent.isComposing) return;
          const shortcut = eventShortcut(event);
          const localLocation = shortcut && localLocations.find(({ bindings }) => bindingMatches(bindings, shortcut));
          if (localLocation) {
            event.preventDefault();
            event.stopPropagation();
            openLocalLocation(localLocation.location);
            return;
          }
          const source = shortcut && sources.find(({ key }) => bindingMatches(key, shortcut));
          if (source) {
            event.preventDefault();
            event.stopPropagation();
            setLocationsOpen(false);
            source.open();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setLocationsOpen(false);
            list.current?.focus();
          }
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".location-popup button"));
            if (!buttons.length) return;
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const direction = event.key === "ArrowUp" ? -1 : 1;
            const next = current < 0 ? (direction > 0 ? 0 : buttons.length - 1) : (current + direction + buttons.length) % buttons.length;
            buttons[next].focus();
          }
        }}>
          <Button ref={locationsButton} className="icon-button location-trigger" aria-label={t(side === "left" ? "Locations for left pane" : "Locations for right pane")}
            aria-expanded={locationsOpen} onClick={() => setLocationsOpen(!locationsOpen)}><HardDrive /><ChevronDown /></Button>
          {locationsOpen && (
            <div className="location-popup">
              {localLocations.map(({ location, bindings }) => (
                <Button key={location.path} tooltip={location.path} shortcut={showShortcut(bindings[0])} onClick={() => openLocalLocation(location)}>
                  <Folder /> <span>{t(location.label)}</span>{bindings.length > 0 && <kbd aria-hidden="true">{showShortcut(bindings[0])}</kbd>}
                </Button>
              ))}
              <div className="location-source-group" role="group" aria-label={t("Sources")}>
                {sources.map(({ label, key, Icon, open }) => (
                  <Button key={label} shortcut={showShortcut(key[0])} onClick={() => { setLocationsOpen(false); open(); }}>
                    <Icon /> <span>{label}</span>{key.length > 0 && <kbd aria-hidden="true">{showShortcut(key[0])}</kbd>}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      {processView ? <ProcessBrowser side={side} lockingPath={processView.path} onClose={() => onProcesses(false)} /> : <>
      {(filterOpen || pane.filter) && (
        <label className="pane-filter">
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
      <FileColumns container={columnHeader} groups={groups} columns={definition.list} tracks={tracks}
        visibility={visibility} sort={sortAvailable ? pane.sort : { ...pane.sort, column: "name", asc: true }} onSort={onSort}
        onVisibility={(column, visible) => {
          const next = { ...visibility, [column]: visible };
          setModeVisibility((before) => ({ ...before, [layoutMode]: next }));
          saveColumnLayout(side, layoutMode, next);
        }} />
      <div id={`${side}-files`} ref={list} className={virtual ? "file-list virtual-file-list" : "file-list"} role="listbox" aria-label={t(side === "left" ? "left files" : "right files")}
        onContextMenu={(event) => { event.preventDefault(); onContext(event.clientX, event.clientY); }}
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
            return <Fragment key={entry.name}>
              {gap > 0 && <div className="file-row-spacer" aria-hidden="true" style={{ height: gap * viewport.rowHeight }} />}
              <div id={`${side}-file-${index}`} className={`file-row${marked ? " marked" : ""}`}
                role="option" aria-setsize={virtual ? entries.length : undefined} aria-posinset={virtual ? index + 1 : undefined}
                aria-label={group.map(({ field }) => itemValue(entry, field, true)).join(" ")}
                data-file-color={fileColor(entry)}
                aria-selected={markedSet.size ? marked : index === selected} data-current={index === selected} data-tooltip={entry.name}
                onClick={(event) => { onRow(entry, event.shiftKey, event.ctrlKey || event.metaKey); list.current?.focus({ preventScroll: true }); }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onContext(event.clientX, event.clientY, entry.name === ".." ? undefined : entry);
                }}
                onPointerDown={(event) => { if (entry.name !== ".." && rename?.name !== entry.name) onStartDrag(entry, event); }}
                onDragStart={(event) => event.preventDefault()}
                onDoubleClick={() => onOpen(entry)}>
                {group.map(({ field }, slot) => isNameField(field) ?
                  <span key={slot} className="file-name" data-marked-name={field === "markedName" || undefined}>
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
        items={folderItems.map(({ name }) => ({ id: name, name: matches?.get(name)?.entry.name ?? name }))}
        onChange={setQuickSearch} onMatch={onQuickMatch}
        onAccept={(name) => { const entry = entries.find((item) => item.name === name); if (entry) onOpen(entry); }}
        onClose={() => setQuickSearch(null)} focusList={() => list.current?.focus({ preventScroll: true })} />}
      {pane.error && <div className="pane-error">
        <span role="alert">{errorText(pane.error)}</span>
        {pane.deniedSshListing && !pane.loading &&
          <Button type="button" onClick={onRetryWithSudo}>{t("Open with sudo…")}</Button>}
        <Button type="button" className="icon-button" aria-label={t("Dismiss error")} onClick={onDismissError}><X /></Button>
      </div>}
      {pane.elevationPath && <ElevationButton directory={pane.elevationPath} />}
      {statusColumns.length > 0 && <div className="pane-details" style={{ gridTemplateColumns: panelColumnTracks(statusColumns) }}>
        {current && current.name !== ".." && statusColumns.map(({ field }, index) => <span key={index} className={`pane-detail pane-detail-${fieldClass[field]}`}
          data-tooltip={itemValue(current, field)}>
          {isNameField(field) ? <>{field === "markedName" && markedSet.has(current.name) && <Check aria-hidden="true" />}
            {renderName(current, field, false)}</> : itemValue(current, field)}
        </span>)}
      </div>}
      <footer className="pane-footer">
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
          <span className="pane-counts">{search ? countText(entries.length, "match") :
            <>{countText(folders, "folder")}<span className="dot" />{countText(folderItems.length - folders, "file")}</>}</span>
          {pane.measuring.length > 0 ? <div className="pane-measurement">
            <div className="pane-progress-status" role="status">
              <LoaderCircle className="spin" aria-hidden="true" /><span>{t("Calculating folder sizes…")}</span>
            </div>
            <Button type="button" className="icon-button" aria-label={t("Cancel folder size calculation")}
              shortcut={cancelKey} onClick={onCancelFolderOperation}><X aria-hidden="true" /></Button>
          </div> : <span className={marked.length ? "pane-marked" : "pane-note"}>{marked.length ? t("{0} marked · {1}{2}", marked.length, complete ? "" : "≥ ", formatSize(markedBytes)) :
            sortPending ? t("Loading sort metadata…") : search ? pane.search?.incomplete ? t("Partial results") : "" : pane.omitted ? t("{0} unavailable", pane.omitted) : ""}</span>}
          {free && !search && !twin && <span className="pane-free" data-tooltip={freeLabel}>
            <span className="pane-free-full">{freeLabel}</span>
            <span className="pane-free-short">{t("{0} free", formatSize(free.available))}</span>
            <span className="space-meter" aria-hidden="true"><span style={{ width: `${usedShare}%` }} /></span>
          </span>}
        </>}
      </footer>
      </>}
    </section>
  );
}
