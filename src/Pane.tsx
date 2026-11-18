import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, File, Folder,
  HardDrive, Link2, LoaderCircle, RefreshCw, Search, Server, X,
} from "lucide-react";
import { folderLabel, placePath, type Entry, type QuickLocation } from "./api";
import { formatDate, formatSize, parentPlace, type PaneState, type Side, type SortColumn } from "./panes";

interface PaneProps {
  side: Side;
  active: boolean;
  pane: PaneState;
  entries: Entry[];
  locations: QuickLocation[];
  activate: () => void;
  onRow: (entry: Entry) => void;
  onOpen: (entry: Entry) => void;
  onPath: (path: string) => void;
  onHistory: (offset: number) => void;
  onParent: () => void;
  onRefresh: () => void;
  onFilter: (filter: string) => void;
  onSort: (column: SortColumn) => void;
  onRemote: () => void;
}

const columns = [{ key: "name", label: "Name" }, { key: "size", label: "Size" }, { key: "modified", label: "Modified" }] as const;

export function Pane({ side, active, pane, entries, locations, activate, onRow, onOpen, onPath,
  onHistory, onParent, onRefresh, onFilter, onSort, onRemote }: PaneProps) {
  const path = pane.place ? placePath(pane.place) : "";
  const [address, setAddress] = useState(path);
  const [filterOpen, setFilterOpen] = useState(false);
  const [locationsOpen, setLocationsOpen] = useState(false);
  const locationsBox = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const filterField = useRef<HTMLInputElement>(null);
  const selected = entries.length ? Math.max(0, entries.findIndex((entry) => entry.name === pane.selected)) : -1;

  useEffect(() => setAddress(path), [path]);
  useEffect(() => {
    if (active && selected >= 0) list.current?.querySelector("[aria-selected='true']")?.scrollIntoView({ block: "nearest" });
  }, [selected, path, active]);
  useEffect(() => {
    if (!locationsOpen) return;
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
    target?.addEventListener("dirlume-filter", show);
    return () => target?.removeEventListener("dirlume-filter", show);
  }, [side]);

  function submitAddress(event: FormEvent) {
    event.preventDefault();
    if ((pane.place && pane.place.kind !== "local") || address === path) return;
    onPath(address);
    list.current?.focus();
  }

  const title = pane.place ? folderLabel(pane.place) : side === "left" ? "Left pane" : "Right pane";
  const isRemote = pane.place && pane.place.kind !== "local";
  const folders = entries.reduce((count, entry) => count + Number(entry.directory), 0);
  return (
    <section id={`${side}-pane`} className={`pane${active ? " active" : ""}`} aria-label={`${side} pane`}
      onPointerDown={activate} onFocus={activate}>
      <header className="pane-heading">
        <div className="pane-title">
          {isRemote ? <Server /> : <Folder />}
          <h2 title={title}>{title}</h2>
          {pane.place && pane.place.kind !== "local" && <span className="remote-name" title={pane.place.address}>Remote</span>}
        </div>
        <div className="pane-tools">
          <button className="icon-button" aria-label="Filter folder" aria-pressed={filterOpen}
            onClick={() => {
              if (filterOpen) {
                setFilterOpen(false);
                onFilter("");
                list.current?.focus();
              } else {
                setFilterOpen(true);
                requestAnimationFrame(() => filterField.current?.focus());
              }
            }}><Search /></button>
          <button className="icon-button" aria-label="Refresh folder" disabled={!pane.place || pane.loading} onClick={onRefresh}>
            {pane.loading ? <LoaderCircle className="spin" /> : <RefreshCw />}
          </button>
        </div>
      </header>
      <div className="navigation">
        <button className="icon-button" aria-label="Back" disabled={pane.position <= 0} onClick={() => onHistory(-1)}><ArrowLeft /></button>
        <button className="icon-button" aria-label="Forward" disabled={pane.position + 1 >= pane.history.length} onClick={() => onHistory(1)}><ArrowRight /></button>
        <button className="icon-button" aria-label="Parent folder" disabled={!pane.place || !parentPlace(pane.place)} onClick={onParent}><ArrowUp /></button>
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
          if (event.key === "Escape") { setLocationsOpen(false); list.current?.focus(); }
        }}>
          <button className="icon-button location-trigger" aria-label={`Locations for ${side} pane`}
            aria-expanded={locationsOpen} onClick={() => setLocationsOpen(!locationsOpen)}><HardDrive /><ChevronDown /></button>
          {locationsOpen && (
            <div className="location-popup">
              {locations.map((location) => (
                <button key={location.path} title={location.path} onClick={() => { onPath(location.path); setLocationsOpen(false); list.current?.focus(); }}>
                  <Folder /> {location.label}
                </button>
              ))}
              <button onClick={() => { setLocationsOpen(false); onRemote(); }}><Server /> Remote machine</button>
            </div>
          )}
        </div>
      </div>
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
          <button className="icon-button" aria-label="Close filter" onClick={() => { setFilterOpen(false); onFilter(""); list.current?.focus(); }}><X /></button>
        </label>
      )}
      <div className="file-columns">
        {columns.map(({ key, label }) => (
          <button key={key} type="button" className={`col-${key}`} onClick={() => onSort(key)} title={`Sort by ${label.toLowerCase()}`}>
            {label}{pane.sort.column === key && (pane.sort.asc ? <ArrowUp /> : <ArrowDown />)}
          </button>
        ))}
      </div>
      <div id={`${side}-files`} ref={list} className="file-list" role="listbox" aria-label={`${side} files`}
        aria-busy={pane.loading} aria-activedescendant={selected < 0 ? undefined : `${side}-file-${selected}`} tabIndex={0}>
        {entries.map((entry, index) => (
          <div id={`${side}-file-${index}`} className={`file-row${pane.marked.includes(entry.name) ? " marked" : ""}`}
            key={entry.name} role="option" aria-selected={index === selected} title={entry.name}
            onClick={() => { onRow(entry); list.current?.focus({ preventScroll: true }); }}
            onDoubleClick={() => onOpen(entry)}>
            <span className="file-name">{entry.directory ? <Folder className="folder-icon" /> : <File />}
              <span>{entry.name}</span>{entry.link && <Link2 className="link-icon" aria-label="Link" />}</span>
            <span className="file-size">{entry.directory ? "–" : formatSize(entry.size)}</span>
            <span className="file-date">{formatDate(entry.modified)}</span>
          </div>
        ))}
        {!entries.length && (
          <div className="pane-empty">
            {pane.loading ? "Loading…" : pane.error ? "Open another location to continue." :
              pane.filter ? "No items match the filter." : pane.place ? "This folder is empty." : "Choose a location."}
          </div>
        )}
      </div>
      {pane.error && <p className="pane-error" role="alert">{pane.error}</p>}
      <footer className="pane-footer">
        <span>{folders} {folders === 1 ? "folder" : "folders"}<span className="dot" />{entries.length - folders} {entries.length - folders === 1 ? "file" : "files"}</span>
        <span>{pane.marked.length ? `${pane.marked.length} marked` : pane.omitted ? `${pane.omitted} unavailable` : ""}</span>
      </footer>
    </section>
  );
}
