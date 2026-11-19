import { countText, errorText, t } from "./i18n";
import { Button } from "./Button";
import { AddressField } from "./AddressField";
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, ChevronDown, File, Folder,
  Activity, HardDrive, Link2, LoaderCircle, RefreshCw, Search, Server, X,
} from "lucide-react";
import { api, describeError, folderLabel, placePath, windowsClient, type Entry, type QuickLocation } from "./api";
import { folderMeasurement, formatDate, formatSize, paneCursorIndex, paneItem, parentPlace, type PaneState, type Side, type SortColumn } from "./panes";
import { ElevationButton, ProcessBrowser } from "./ProcessTools";
import { fileColor } from "./appearance";
import { fileIconKey, useWindowsIcons } from "./useWindowsIcons";
import { eventShortcut, showShortcut } from "./preferences";
import { useFontZoom } from "./useFontZoom";
import { viewFontStyle, type ZoomViewFont } from "./viewFonts";
import { columnWidthsStyle, FileColumns, readColumnLayout, saveColumnLayout } from "./FileColumns";

interface PaneProps {
  side: Side;
  active: boolean;
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
  onHistory: (offset: number) => void;
  onParent: () => void;
  onRefresh: () => void;
  onFilter: (filter: string) => void;
  onSort: (column: SortColumn) => void;
  onRemote: () => void;
  onFtp: () => void;
  ftpShortcut: string;
  zoomShortcut: string;
  fontSize?: number;
  onZoom: ZoomViewFont;
  onCloseResults: () => void;
  onRevealResult: (entry: Entry) => void;
  onStartDrag: (entry: Entry, data: DataTransfer) => boolean;
  onEndDrag: () => void;
  canDrop: (data: DataTransfer) => boolean;
  onDrop: () => void;
  processView: { path?: string } | null;
  onProcesses: (visible: boolean) => void;
  onContext: (entry?: Entry) => void;
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

export function Pane({ side, active, showHidden, pane, entries, locations, rename, activate, onRow, onQuickMatch, onOpen, onPath,
  onHistory, onParent, onRefresh, onFilter, onSort, onRemote, onFtp, ftpShortcut, zoomShortcut, fontSize, onZoom, onCloseResults, onRevealResult,
  onStartDrag, onEndDrag, canDrop, onDrop, processView, onProcesses, onContext }: PaneProps) {
  const section = useRef<HTMLElement>(null);
  useFontZoom(section, zoomShortcut, side, onZoom);
  const path = pane.place ? placePath(pane.place) : "";
  const [filterOpen, setFilterOpen] = useState(false);
  const [quickSearch, setQuickSearch] = useState<string | null>(null);
  const quickSearchInput = useRef<HTMLInputElement>(null);
  const [locationsOpen, setLocationsOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [draggedRow, setDraggedRow] = useState<string | null>(null);
  const locationsBox = useRef<HTMLDivElement>(null);
  const locationsButton = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const columnHeader = useRef<HTMLDivElement>(null);
  const [columnLayout, setColumnLayout] = useState(() => readColumnLayout(side));
  const rowProbe = useRef<HTMLDivElement>(null);
  const filterField = useRef<HTMLInputElement>(null);
  const selected = paneCursorIndex(pane, entries);
  const search = Boolean(pane.search);
  const matches = pane.search?.matches;
  const quickMatches = useMemo(() => {
    if (!quickSearch) return [];
    const prefix = quickSearch.normalize("NFC").toLocaleLowerCase();
    return entries.filter((entry) => entry.name !== ".." &&
      (matches?.get(entry.name)?.entry.name ?? entry.name).normalize("NFC").toLocaleLowerCase().startsWith(prefix));
  }, [entries, matches, quickSearch]);
  const currentQuickMatch = quickMatches.find(({ name }) => name === pane.selected);
  const [viewport, setViewport] = useState({ top: 0, height: 0, rowHeight: 29 });
  const virtual = search || entries.length > 100;
  const start = virtual ? Math.min(entries.length, Math.max(0, Math.floor(viewport.top / viewport.rowHeight) - 5)) : 0;
  const end = virtual ? Math.min(entries.length, Math.ceil((viewport.top + viewport.height) / viewport.rowHeight) + 6) : entries.length;
  const indices = Array.from({ length: end - start }, (_, offset) => start + offset);
  if (virtual) {
    // Keep the active descendant and the source of an ongoing drag mounted.
    const dragged = draggedRow === null ? -1 : entries.findIndex((entry) => entry.name === draggedRow);
    for (const index of new Set([selected, dragged])) {
      if (index >= 0 && (index < start || index >= end)) indices.push(index);
    }
    indices.sort((left, right) => left - right);
  }
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

  useEffect(() => setQuickSearch(null), [path, processView, matches]);
  const quickSearchOpen = quickSearch !== null;
  useLayoutEffect(() => {
    if (!quickSearchOpen) return;
    const input = quickSearchInput.current;
    input?.focus();
    if (input) input.setSelectionRange(input.value.length, input.value.length);
  }, [quickSearchOpen]);
  useEffect(() => {
    if (!currentQuickMatch && quickMatches[0]) onQuickMatch(quickMatches[0].name);
  }, [currentQuickMatch, onQuickMatch, quickMatches]);
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
      const top = selected * viewport.rowHeight;
      const bottom = top + viewport.rowHeight + 8;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
      setViewport((before) => before.top === element.scrollTop ? before : { ...before, top: element.scrollTop });
    } else {
      element.querySelector("[data-current='true']")?.scrollIntoView({ block: "nearest" });
    }
  }, [selected, path, active, virtual, matches, viewport.rowHeight, processView]);
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
    const showQuickSearch = (event: Event) => setQuickSearch((event as CustomEvent<string>).detail);
    target?.addEventListener("dirlume-filter", show);
    target?.addEventListener("dirlume-locations", showLocations);
    target?.addEventListener("dirlume-quick-search", showQuickSearch);
    return () => {
      target?.removeEventListener("dirlume-filter", show);
      target?.removeEventListener("dirlume-locations", showLocations);
      target?.removeEventListener("dirlume-quick-search", showQuickSearch);
    };
  }, [side]);

  const title = processView ? t("Processes") : search ? t("Search results") : pane.place ? folderLabel(pane.place) : t(side === "left" ? "Left pane" : "Right pane");
  const isRemote = pane.place && pane.place.kind !== "local";
  const folderItems = entries.filter(({ name }) => name !== "..");
  const folders = folderItems.reduce((count, entry) => count + Number(entry.directory), 0);
  const markedSet = new Set(pane.marked);
  const marked = entries.filter(({ name }) => markedSet.has(name));
  const complete = marked.every((entry) => entry.directory ? folderMeasurement(pane, entry)?.incomplete === false : entry.size !== null);
  const markedBytes = marked.reduce((bytes, entry) => bytes + (folderMeasurement(pane, entry)?.bytes ?? entry.size ?? 0), 0);
  return (
    <section ref={section} id={`${side}-pane`} style={{ ...viewFontStyle(fontSize), ...columnWidthsStyle(columnLayout.widths) }}
      data-size-column={columnLayout.visibility.size} data-modified-column={columnLayout.visibility.modified}
      className={`pane${active ? " active" : ""}${dragOver ? " drop-target" : ""}`} aria-label={t(side === "left" ? "left pane" : "right pane")}
      onPointerDown={activate} onFocus={activate} onContextMenu={(event) => {
        if (processView || !(event.target instanceof HTMLElement) || event.target.closest("input, select, textarea, dialog")) return;
        event.preventDefault();
        onContext();
      }} onDragOver={(event) => {
        if (!canDrop(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragOver(true);
      }} onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragOver(false);
      }} onDrop={(event) => {
        setDragOver(false);
        if (!canDrop(event.dataTransfer)) return;
        event.preventDefault();
        onDrop();
      }}>
      <header className="pane-heading">
        <div className="pane-title">
          {processView ? <Activity /> : search ? <Search /> : isRemote ? <Server /> : <Folder />}
          <h2 title={pane.search?.mask ?? title}>{title}</h2>
          {!processView && pane.place && pane.place.kind !== "local" && <span className="remote-name"
            title={pane.place.kind === "archive" ? t(pane.place.address) : pane.place.address}>
            {pane.place.kind === "archive" ? t(pane.place.address) : t("Remote")}</span>}
        </div>
        <div className="pane-tools">
          {processView && <Button className="icon-button" aria-label={t("Close processes")} title={t("Close processes")}
            onClick={() => onProcesses(false)}><X /></Button>}
          {search && !processView && <>
            <Button className="icon-button" aria-label={t("Go to selected file")} title={t("Go to selected file")} disabled={selected < 0}
              onClick={() => onRevealResult(entries[selected])}><ArrowUpRight /></Button>
            <Button className="icon-button" aria-label={t("Close search results")} title={t("Close search results")}
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
            {pane.loading ? <LoaderCircle className="spin" /> : <RefreshCw />}
          </Button>}
        </div>
      </header>
      <div className="navigation">
        <Button className="icon-button" aria-label={t("Back")} disabled={!processView && !search && pane.position <= 0} onClick={() => onHistory(-1)}><ArrowLeft /></Button>
        <Button className="icon-button" aria-label={t("Forward")} disabled={pane.position + 1 >= pane.history.length} onClick={() => onHistory(1)}><ArrowRight /></Button>
        <Button className="icon-button" aria-label={t("Parent folder")} disabled={!processView && !search && (!pane.place || !parentPlace(pane.place))} onClick={onParent}><ArrowUp /></Button>
        <AddressField side={side} place={pane.place} showHidden={showHidden}
          onNavigate={onPath} focusFiles={() => list.current?.focus()} />
        <div className="location-menu" ref={locationsBox} onKeyDown={(event) => {
          if (!locationsOpen) return;
          if (ftpShortcut && eventShortcut(event) === ftpShortcut) {
            event.preventDefault();
            event.stopPropagation();
            setLocationsOpen(false);
            onFtp();
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
              {locations.map((location) => (
                <Button key={location.path} title={location.path} onClick={() => { onPath(location.path); setLocationsOpen(false); list.current?.focus(); }}>
                  <Folder /> {t(location.label)}
                </Button>
              ))}
              <Button onClick={() => { setLocationsOpen(false); onProcesses(true); }}><Activity /> {t("Processes")}</Button>
              <Button shortcut={showShortcut(ftpShortcut)} onClick={() => { setLocationsOpen(false); onFtp(); }}><Server /> FTP</Button>
              <Button onClick={() => { setLocationsOpen(false); onRemote(); }}><Server /> {t("Remote machine")}</Button>
            </div>
          )}
        </div>
      </div>
      {processView ? <ProcessBrowser side={side} lockingPath={processView.path} onClose={() => onProcesses(false)} /> : <>
      {(filterOpen || pane.filter) && (
        <label className="pane-filter">
          <Search />
          <input ref={filterField} aria-label={t(side === "left" ? "Filter left folder" : "Filter right folder")} type="text" placeholder={t("Filter this folder")}
            value={pane.filter} onChange={(event) => onFilter(event.target.value)}
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
      <FileColumns container={columnHeader} layout={columnLayout} sort={pane.sort} onSort={onSort}
        onResize={(widths, persist) => {
          const next = { ...columnLayout, widths };
          setColumnLayout(next);
          if (persist) saveColumnLayout(side, next);
        }} onVisibility={(column, visible) => {
          const next = { ...columnLayout, visibility: { ...columnLayout.visibility, [column]: visible } };
          setColumnLayout(next);
          saveColumnLayout(side, next);
        }} />
      <div id={`${side}-files`} ref={list} className={virtual ? "file-list virtual-file-list" : "file-list"} role="listbox" aria-label={t(side === "left" ? "left files" : "right files")}
        onScroll={(event) => {
          if (columnHeader.current) columnHeader.current.scrollLeft = event.currentTarget.scrollLeft;
          if (!virtual) return;
          const top = event.currentTarget.scrollTop;
          setViewport((previous) => ({ ...previous, top }));
        }}
        aria-multiselectable="true" aria-busy={pane.loading}
        aria-activedescendant={selected >= 0 ? `${side}-file-${selected}` : undefined} tabIndex={0}>
        {virtual && <div ref={rowProbe} className="file-row-probe" aria-hidden="true" />}
        {indices.map((index, offset) => {
          const gap = index - (indices[offset - 1] ?? -1) - 1;
          const entry = entries[index];
          const icon = icons.get(byName.get(entry.name) ?? "");
          const size = folderMeasurement(pane, entry);
          const measuring = !search && entry.directory && !entry.link && pane.measuring.includes(entry.name);
          return <Fragment key={entry.name}>
          {gap > 0 && <div aria-hidden="true" style={{ height: gap * viewport.rowHeight }} />}
          <div id={`${side}-file-${index}`} className={`file-row${markedSet.has(entry.name) ? " marked" : ""}`}
            role="option" aria-setsize={virtual ? entries.length : undefined} aria-posinset={virtual ? index + 1 : undefined}
            data-file-color={fileColor(entry)}
            aria-selected={markedSet.size ? markedSet.has(entry.name) : index === selected} data-current={index === selected} title={entry.name}
            onClick={(event) => { onRow(entry, event.shiftKey, event.ctrlKey || event.metaKey); list.current?.focus({ preventScroll: true }); }}
            onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); if (entry.name !== "..") onContext(entry); }}
            draggable={entry.name !== ".." && rename?.name !== entry.name} onDragStart={(event) => {
              if (onStartDrag(entry, event.dataTransfer)) setDraggedRow(entry.name);
              else event.preventDefault();
            }}
            onDragEnd={() => { setDraggedRow(null); onEndDrag(); }}
            onDoubleClick={() => onOpen(entry)}>
            <span className="file-name">{entry.directory ? <Folder className="folder-icon" /> :
              icon ? <img className="native-file-icon" alt="" src={`data:image/png;base64,${icon}`} /> : <File />}
              {rename?.name === entry.name ? <InlineRenameField {...rename} /> : <span className="file-name-text">{entry.name.normalize("NFC")}</span>}
              {entry.link && <Link2 className="link-icon" aria-label={t("Link")} />}</span>
            <span className="file-size">{measuring ? <LoaderCircle className="spin" aria-label={t("Measuring folder")} /> :
              size ? `${size.incomplete ? "≥ " : ""}${formatSize(size.bytes)}` : formatSize(entry.directory ? null : entry.size)}</span>
            <span className="file-date">{formatDate(entry.modified)}</span>
          </div>
          </Fragment>;
        })}
        {virtual && (indices.at(-1) ?? -1) < entries.length - 1 &&
          <div aria-hidden="true" style={{ height: (entries.length - (indices.at(-1) ?? -1) - 1) * viewport.rowHeight }} />}
        {!entries.length && (
          <div className="pane-empty">
            {pane.loading ? t("Loading…") : pane.error ? t("Open another location to continue.") :
              pane.filter ? t("No items match the filter.") : search ? t("No visible matches.") : pane.place ? t("This folder is empty.") : t("Choose a location.")}
          </div>
        )}
      </div>
      {quickSearch !== null && <div className="quick-search">
        <label htmlFor={side + "-quick-search"}>{t("Quick search")}</label>
        <input id={side + "-quick-search"} ref={quickSearchInput} type="text" value={quickSearch} spellCheck={false}
          autoComplete="off" onChange={(event) => setQuickSearch(event.target.value)} onBlur={() => setQuickSearch(null)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape" || event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              const match = currentQuickMatch ?? quickMatches[0];
              if (event.key === "Enter" && !match) return;
              setQuickSearch(null);
              list.current?.focus({ preventScroll: true });
              if (event.key === "Enter" && match) onOpen(match);
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              event.stopPropagation();
              if (!quickMatches.length) return;
              const index = currentQuickMatch ? quickMatches.indexOf(currentQuickMatch) : 0;
              const offset = event.key === "ArrowDown" ? 1 : -1;
              const next = (index + offset + quickMatches.length) % quickMatches.length;
              onQuickMatch(quickMatches[next].name);
            }
          }} />
        <span role="status">{quickSearch ? (quickMatches.length ? countText(quickMatches.length, "match") : t("No match")) : ""}</span>
      </div>}
      {pane.error && <p className="pane-error" role="alert">{errorText(pane.error)}</p>}
      {pane.elevationPath && <ElevationButton directory={pane.elevationPath} />}
      <footer className="pane-footer">
        <span>{search ? countText(entries.length, "match") :
          <>{countText(folders, "folder")}<span className="dot" />{countText(folderItems.length - folders, "file")}</>}</span>
        <span>{marked.length ? t("{0} marked · {1}{2}", marked.length, complete ? "" : "≥ ", formatSize(markedBytes)) :
          search ? pane.search?.incomplete ? t("Partial results") : "" : pane.omitted ? t("{0} unavailable", pane.omitted) : ""}</span>
      </footer>
      </>}
    </section>
  );
}
