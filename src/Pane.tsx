import { Button } from "./Button";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, ChevronDown, File, Folder,
  Activity, HardDrive, Link2, LoaderCircle, RefreshCw, Search, Server, X,
} from "lucide-react";
import { api, folderLabel, placePath, windowsClient, type Entry, type QuickLocation } from "./api";
import { formatDate, formatSize, paneItem, parentPlace, type PaneState, type Side, type SortColumn } from "./panes";
import { ElevationButton, ProcessBrowser } from "./ProcessTools";
import { fileColor } from "./appearance";
import { fileIconKey, useWindowsIcons } from "./useWindowsIcons";

interface PaneProps {
  side: Side;
  active: boolean;
  pane: PaneState;
  entries: Entry[];
  locations: QuickLocation[];
  activate: () => void;
  onRow: (entry: Entry, range: boolean, mark: boolean) => void;
  onOpen: (entry: Entry) => void;
  onPath: (path: string) => void;
  onHistory: (offset: number) => void;
  onParent: () => void;
  onRefresh: () => void;
  onFilter: (filter: string) => void;
  onSort: (column: SortColumn) => void;
  onRemote: () => void;
  onCloseResults: () => void;
  onRevealResult: (entry: Entry) => void;
  onStartDrag: (entry: Entry, data: DataTransfer) => boolean;
  onEndDrag: () => void;
  canDrop: (data: DataTransfer) => boolean;
  onDrop: () => void;
  processView: boolean;
  onProcesses: (visible: boolean) => void;
  onContext: (entry?: Entry) => void;
}

const columns = [{ key: "name", label: "Name" }, { key: "size", label: "Size" }, { key: "modified", label: "Modified" }] as const;

export function Pane({ side, active, pane, entries, locations, activate, onRow, onOpen, onPath,
  onHistory, onParent, onRefresh, onFilter, onSort, onRemote, onCloseResults, onRevealResult,
  onStartDrag, onEndDrag, canDrop, onDrop, processView, onProcesses, onContext }: PaneProps) {
  const path = pane.place ? placePath(pane.place) : "";
  const [address, setAddress] = useState(path);
  const [filterOpen, setFilterOpen] = useState(false);
  const [locationsOpen, setLocationsOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const locationsBox = useRef<HTMLDivElement>(null);
  const locationsButton = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const rowProbe = useRef<HTMLDivElement>(null);
  const filterField = useRef<HTMLInputElement>(null);
  const selected = entries.length ? Math.max(0, entries.findIndex((entry) => entry.name === pane.selected)) : -1;
  const search = Boolean(pane.search);
  const matches = pane.search?.matches;
  const [viewport, setViewport] = useState({ top: 0, height: 0, rowHeight: 29 });
  const start = search ? Math.min(entries.length, Math.max(0, Math.floor(viewport.top / viewport.rowHeight) - 5)) : 0;
  const end = search ? Math.min(entries.length, Math.ceil((viewport.top + viewport.height) / viewport.rowHeight) + 6) : entries.length;
  const displayed = entries.slice(start, end);
  const fileIcons = new Map<string, { directory: string; name: string }>();
  const byName = new Map<string, string>();
  if (windowsClient && !processView) {
    for (const item of displayed) {
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

  useEffect(() => setAddress(path), [path]);
  useLayoutEffect(() => {
    const element = list.current;
    const probe = rowProbe.current;
    if (!element || !probe) return;
    const measure = () => setViewport({
      top: element.scrollTop, height: element.clientHeight, rowHeight: probe.getBoundingClientRect().height || 29,
    });
    element.scrollTop = 0;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(probe);
    return () => observer.disconnect();
  }, [matches]);
  useLayoutEffect(() => {
    const element = list.current;
    if (!active || selected < 0 || !element) return;
    if (search) {
      const top = selected * viewport.rowHeight;
      const bottom = top + viewport.rowHeight + 8;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
    } else {
      element.querySelector("[data-current='true']")?.scrollIntoView({ block: "nearest" });
    }
  }, [selected, path, active, search, matches, viewport.rowHeight]);
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

  function submitAddress(event: FormEvent) {
    event.preventDefault();
    if ((pane.place && pane.place.kind !== "local") || address === path) return;
    onPath(address);
    list.current?.focus();
  }

  const title = processView ? "Processes" : search ? "Search results" : pane.place ? folderLabel(pane.place) : side === "left" ? "Left pane" : "Right pane";
  const isRemote = pane.place && pane.place.kind !== "local";
  const folders = entries.reduce((count, entry) => count + Number(entry.directory), 0);
  const markedSet = new Set(pane.marked);
  const marked = entries.filter(({ name }) => markedSet.has(name));
  const complete = marked.every((entry) => entry.directory ? pane.sizes.get(entry.name)?.incomplete === false : entry.size !== null);
  const markedBytes = marked.reduce((bytes, entry) => bytes + (pane.sizes.get(entry.name)?.bytes ?? entry.size ?? 0), 0);
  return (
    <section id={`${side}-pane`} className={`pane${active ? " active" : ""}${dragOver ? " drop-target" : ""}`} aria-label={`${side} pane`}
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
          {!processView && pane.place && pane.place.kind !== "local" && <span className="remote-name" title={pane.place.address}>Remote</span>}
        </div>
        <div className="pane-tools">
          {processView && <Button className="icon-button" aria-label="Close processes" title="Close processes"
            onClick={() => onProcesses(false)}><X /></Button>}
          {search && !processView && <>
            <Button className="icon-button" aria-label="Go to selected file" title="Go to selected file" disabled={selected < 0}
              onClick={() => onRevealResult(entries[selected])}><ArrowUpRight /></Button>
            <Button className="icon-button" aria-label="Close search results" title="Close search results"
              onClick={onCloseResults}><X /></Button>
          </>}
          {!processView && <Button className="icon-button" aria-label="Filter folder" aria-pressed={filterOpen}
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
          {!processView && <Button className="icon-button" aria-label="Refresh folder" disabled={search || !pane.place || pane.loading} onClick={onRefresh}>
            {pane.loading ? <LoaderCircle className="spin" /> : <RefreshCw />}
          </Button>}
        </div>
      </header>
      <div className="navigation">
        <Button className="icon-button" aria-label="Back" disabled={!processView && !search && pane.position <= 0} onClick={() => onHistory(-1)}><ArrowLeft /></Button>
        <Button className="icon-button" aria-label="Forward" disabled={pane.position + 1 >= pane.history.length} onClick={() => onHistory(1)}><ArrowRight /></Button>
        <Button className="icon-button" aria-label="Parent folder" disabled={!processView && !search && (!pane.place || !parentPlace(pane.place))} onClick={onParent}><ArrowUp /></Button>
        <form className="address" onSubmit={submitAddress}>
          <input id={`${side}-address`} aria-label={`${side} path`} value={address} readOnly={Boolean(isRemote)} type="text"
            spellCheck={false} autoComplete="off" onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setAddress(path);
                list.current?.focus();
              }
            }} />
        </form>
        <div className="location-menu" ref={locationsBox} onKeyDown={(event) => {
          if (!locationsOpen) return;
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
          <Button ref={locationsButton} className="icon-button location-trigger" aria-label={`Locations for ${side} pane`}
            aria-expanded={locationsOpen} onClick={() => setLocationsOpen(!locationsOpen)}><HardDrive /><ChevronDown /></Button>
          {locationsOpen && (
            <div className="location-popup">
              {locations.map((location) => (
                <Button key={location.path} title={location.path} onClick={() => { onPath(location.path); setLocationsOpen(false); list.current?.focus(); }}>
                  <Folder /> {location.label}
                </Button>
              ))}
              <Button onClick={() => { setLocationsOpen(false); onProcesses(true); }}><Activity /> Processes</Button>
              <Button onClick={() => { setLocationsOpen(false); onRemote(); }}><Server /> Remote machine</Button>
            </div>
          )}
        </div>
      </div>
      {processView ? <ProcessBrowser side={side} /> : <>
      {(filterOpen || pane.filter) && (
        <label className="pane-filter">
          <Search />
          <input ref={filterField} aria-label={`Filter ${side} folder`} type="text" placeholder="Filter this folder"
            value={pane.filter} onChange={(event) => onFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setFilterOpen(false);
                onFilter("");
                list.current?.focus();
              } else if (event.key === "Enter") list.current?.focus();
            }} />
          <Button className="icon-button" aria-label="Close filter" onClick={() => { setFilterOpen(false); onFilter(""); list.current?.focus(); }}><X /></Button>
        </label>
      )}
      <div className="file-columns">
        {columns.map(({ key, label }) => (
          <Button key={key} type="button" className={`col-${key}`} onClick={() => onSort(key)} title={`Sort by ${label.toLowerCase()}`}>
            {label}{pane.sort.column === key && (pane.sort.asc ? <ArrowUp /> : <ArrowDown />)}
          </Button>
        ))}
      </div>
      <div id={`${side}-files`} ref={list} className={search ? "file-list result-list" : "file-list"} role="listbox" aria-label={`${side} files`}
        onScroll={search ? (event) => {
          const top = event.currentTarget.scrollTop;
          setViewport((previous) => ({ ...previous, top }));
        } : undefined}
        aria-multiselectable="true" aria-busy={pane.loading}
        aria-activedescendant={selected >= start && selected < end ? `${side}-file-${selected}` : undefined} tabIndex={0}>
        {search && <>
          <div ref={rowProbe} className="result-row-probe" aria-hidden="true" />
          <div aria-hidden="true" style={{ height: start * viewport.rowHeight }} />
        </>}
        {displayed.map((entry, offset) => {
          const index = start + offset;
          const icon = icons.get(byName.get(entry.name) ?? "");
          const size = pane.sizes.get(entry.name);
          const measuring = pane.measuring.includes(entry.name);
          return <div id={`${side}-file-${index}`} className={`file-row${markedSet.has(entry.name) ? " marked" : ""}`}
            key={entry.name} role="option" aria-setsize={search ? entries.length : undefined} aria-posinset={search ? index + 1 : undefined}
            data-file-color={entry.directory ? undefined : fileColor(entry.name)}
            aria-selected={markedSet.size ? markedSet.has(entry.name) : index === selected} data-current={index === selected} title={entry.name}
            onClick={(event) => { onRow(entry, event.shiftKey, event.ctrlKey || event.metaKey); list.current?.focus({ preventScroll: true }); }}
            onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onContext(entry); }}
            draggable onDragStart={(event) => { if (!onStartDrag(entry, event.dataTransfer)) event.preventDefault(); }}
            onDragEnd={onEndDrag}
            onDoubleClick={() => onOpen(entry)}>
            <span className="file-name">{entry.directory ? <Folder className="folder-icon" /> :
              icon ? <img className="native-file-icon" alt="" src={`data:image/png;base64,${icon}`} /> : <File />}
              <span>{entry.name}</span>{entry.link && <Link2 className="link-icon" aria-label="Link" />}</span>
            <span className="file-size">{measuring ? <LoaderCircle className="spin" aria-label="Measuring folder" /> :
              size ? `${size.incomplete ? "≥ " : ""}${formatSize(size.bytes)}` : formatSize(entry.directory ? null : entry.size)}</span>
            <span className="file-date">{formatDate(entry.modified)}</span>
          </div>;
        })}
        {search && <div aria-hidden="true" style={{ height: (entries.length - end) * viewport.rowHeight }} />}
        {!entries.length && (
          <div className="pane-empty">
            {pane.loading ? "Loading…" : pane.error ? "Open another location to continue." :
              pane.filter ? "No items match the filter." : search ? "No visible matches." : pane.place ? "This folder is empty." : "Choose a location."}
          </div>
        )}
      </div>
      {pane.error && <p className="pane-error" role="alert">{pane.error}</p>}
      {pane.elevationPath && <ElevationButton directory={pane.elevationPath} />}
      <footer className="pane-footer">
        <span>{search ? `${entries.length} ${entries.length === 1 ? "match" : "matches"}` :
          <>{folders} {folders === 1 ? "folder" : "folders"}<span className="dot" />{entries.length - folders} {entries.length - folders === 1 ? "file" : "files"}</>}</span>
        <span>{marked.length ? `${marked.length} marked · ${complete ? "" : "≥ "}${formatSize(markedBytes)}` :
          search ? pane.search?.incomplete ? "Partial results" : "" : pane.omitted ? `${pane.omitted} unavailable` : ""}</span>
      </footer>
      </>}
    </section>
  );
}
