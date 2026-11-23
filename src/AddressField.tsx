import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type Ref } from "react";
import { ChevronRight, Copy, Pencil } from "lucide-react";
import { connectionSourceNames, folderLabel, isFileServer, placePath, smbHost, windowsClient, type ConnectionSource, type FileLocation } from "./api";
import { Button } from "./Button";
import { helpIsOpen } from "./contextHelp";
import { t } from "./i18n";
import { parentPlace, type Side } from "./panes";
import { PathField } from "./PathField";

function parentPath(path: string, windows: boolean) {
  const trimmed = path.replace(windows ? /[\\/]+$/ : /\/+$/, "");
  if (windows && /^(?:[a-z]:|[\\/]{2}[^\\/]+[\\/][^\\/]+)$/i.test(trimmed)) return null;
  const end = Math.max(trimmed.lastIndexOf("/"), windows ? trimmed.lastIndexOf("\\") : -1);
  if (end < 0) return null;
  const root = end === 0 || (windows && end === 2 && /^[a-z]:/i.test(trimmed));
  return trimmed.slice(0, root ? end + 1 : end);
}

function placeKey(place: FileLocation) {
  const source = place.kind === "local" || place.kind === "smbRoot" ? [] :
    place.kind === "kswitcher" ? [place.directory, place.peer] : [place.id];
  return JSON.stringify([place.kind, ...source, placePath(place)]);
}

function connectionSource(place: FileLocation | null): ConnectionSource | undefined {
  switch (place?.kind) {
    case "ftp": return "ftp";
    case "ssh": return place.catalogSource ?? "ssh";
    case "server":
    case "kswitcher": return "remote";
    case "local":
    case "smbRoot": return smbHost(place) ? "smb" : undefined;
  }
}

function breadcrumbPlaces(place: FileLocation | null, limit = 4, inSameSource = false) {
  const places: FileLocation[] = [];
  const kind = place?.kind;
  while (place && places.length < limit && (!inSameSource || place.kind === kind)) {
    places.push(place);
    let parent = parentPlace(place);
    if (parent?.kind === "local") parent = { ...parent, parent: parentPath(parent.path, windowsClient) };
    if (parent?.kind === "kswitcher" && parent.path) parent = { ...parent, parent: parentPath(parent.path, true) ?? "" };
    place = parent;
  }
  return places.reverse();
}

function useBreadcrumbClip(editing = false, fitAncestors = false, location = "") {
  const clip = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  const [hidden, setHidden] = useState(0);

  useLayoutEffect(() => {
    const viewport = clip.current;
    const content = track.current;
    if (editing || !viewport || !content) return;
    const address = viewport.parentElement;
    if (!address) return;
    const measure = () => {
      if (!fitAncestors) {
        setClipped(content.offsetWidth > viewport.clientWidth);
        return;
      }
      const available = address.clientWidth;
      content.setAttribute("data-measuring", "");
      const widths = Array.from(content.children, (crumb) => crumb.getBoundingClientRect().width);
      content.removeAttribute("data-measuring");
      const overflowWidth = Number.parseFloat(getComputedStyle(address).getPropertyValue("--address-overflow-width"));
      let remaining = widths.reduce((sum, width) => sum + width, 0);
      const clipped = remaining > available;
      let hidden = 0;
      if (clipped) {
        while (hidden < widths.length - 1 && remaining + overflowWidth > available) {
          remaining -= widths[hidden++];
        }
      }
      setHidden(hidden);
      setClipped(clipped);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(fitAncestors ? address : viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [editing, fitAncestors, location]);

  return { clip, track, clipped, hidden: fitAncestors ? hidden : 0 };
}

function BreadcrumbTrack({ clip, track, ancestors, current, goTo, fitAncestors = false, hidden = 0 }: {
  clip: Ref<HTMLDivElement>;
  track: Ref<HTMLDivElement>;
  ancestors: readonly FileLocation[];
  current: string;
  goTo?: (place: FileLocation) => void;
  fitAncestors?: boolean;
  hidden?: number;
}) {
  return <div ref={clip} className="address-crumb-clip" data-fit={fitAncestors || undefined}>
    <div ref={track} className="address-crumbs" data-has-hidden={hidden > 0 || undefined}>
      {ancestors.map((ancestor, index) => <div key={placeKey(ancestor)} className="address-ancestor" hidden={index < hidden}>
        {goTo ? <button type="button" onClick={() => goTo(ancestor)}>{folderLabel(ancestor)}</button> :
          <span>{folderLabel(ancestor)}</span>}
        <ChevronRight aria-hidden="true" />
      </div>)}
      <span aria-current="location" className="address-current">{current}</span>
    </div>
  </div>;
}

export function CompactAddressBreadcrumbs({ place, path, goTo }: {
  place: FileLocation; path: string; goTo?: (place: FileLocation) => void;
}) {
  // A volume or share can be scanned without loading a directory listing first.
  const target = place.kind === "local" && place.parent === null ? { ...place, parent: parentPath(place.path, windowsClient) } : place;
  const ancestors = breadcrumbPlaces(target).slice(0, -1);
  const { clip, track, clipped } = useBreadcrumbClip();
  const shortened = clipped || (ancestors.length === 3 && Boolean(parentPlace(ancestors[0])));
  const [overflow, setOverflow] = useState(false);
  const overflowButton = useRef<HTMLButtonElement>(null);

  return <div className="address-breadcrumbs" role="group" aria-label={path} title={path} onBlur={(event) => {
    if (!helpIsOpen() && !event.currentTarget.contains(event.relatedTarget)) setOverflow(false);
  }} onKeyDown={(event) => {
    if (event.key !== "Escape" || !overflow) return;
    event.preventDefault();
    event.stopPropagation();
    setOverflow(false);
    overflowButton.current?.focus();
  }}>
    <BreadcrumbTrack clip={clip} track={track} ancestors={ancestors} current={folderLabel(target)} goTo={goTo} />
    {shortened && (goTo ? <Button ref={overflowButton} type="button" className="icon-button address-overflow"
      aria-label={t("Show parent folders")} aria-expanded={overflow} onClick={() => setOverflow(!overflow)}>…</Button> :
      <span className="address-overflow address-ellipsis" aria-hidden="true">…</span>)}
    {shortened && overflow && goTo && <div className="location-popup address-parents">
      {breadcrumbPlaces(target, Infinity).slice(0, -1).map((ancestor) => <Button type="button" key={placeKey(ancestor)}
        tooltip={placePath(ancestor)} onClick={() => { setOverflow(false); goTo(ancestor); }}>{folderLabel(ancestor)}</Button>)}
    </div>}
  </div>;
}

export function AddressField({ side, place, showHidden, onNavigate, onNavigateAncestor, onOpenConnections, onCopy, focusFiles }: {
  side: Side;
  place: FileLocation | null;
  showHidden: boolean;
  onNavigate: (path: string) => void;
  onNavigateAncestor: (place: FileLocation) => void;
  onOpenConnections: (source: ConnectionSource) => void;
  onCopy: (path: string) => void;
  focusFiles: () => void;
}) {
  const path = place ? placePath(place) : "";
  const source = connectionSource(place);
  const sourceName = source ? t(connectionSourceNames[source]) : "";
  const server = isFileServer(place) ? place : undefined;
  const editable = !place || place.kind === "local" || place.kind === "smbRoot" || !!server;
  const location = place ? placeKey(place) : "";
  const addressKey = JSON.stringify([side, location]);
  const root = useRef<HTMLDivElement>(null);
  const browsing = useRef(false);
  const [editing, setEditing] = useState(false);
  const fitAncestors = place?.kind === "local" && !source;
  const { clip, track, clipped, hidden } = useBreadcrumbClip(editing, fitAncestors, location);
  const [overflow, setOverflow] = useState(false);
  const [hoverX, setHoverX] = useState<number>();
  const [draft, setDraft] = useState(path);
  const [branch, setBranch] = useState<FileLocation[]>([]);
  const branchIndex = branch.findIndex((folder) => placeKey(folder) === location);
  const forward = branchIndex < 0 ? [] : branch.slice(branchIndex + 1);
  const crumbs = breadcrumbPlaces(place, fitAncestors ? Infinity : undefined);
  const ancestors = crumbs.slice(0, -1);
  const shortened = clipped || (!fitAncestors && ancestors.length === 3 && Boolean(parentPlace(ancestors[0])));
  const parents = fitAncestors ? ancestors.slice(0, hidden) :
    overflow && source ? breadcrumbPlaces(place, Infinity).slice(0, -1) : ancestors;
  const label = t(side === "left" ? "left path" : "right path");

  function startEditing() {
    if (!editable) return;
    const current = root.current?.querySelector<HTMLInputElement>("input");
    if (current) { current.focus(); current.select(); }
    else {
      setDraft(path);
      setOverflow(false);
      setEditing(true);
    }
  }
  const editRequested = useEffectEvent(startEditing);

  useEffect(() => {
    const element = root.current;
    const edit = () => editRequested();
    element?.addEventListener("dirlume-edit-path", edit);
    return () => element?.removeEventListener("dirlume-edit-path", edit);
  }, []);

  useEffect(() => {
    setDraft(path);
    setEditing(false);
    setOverflow(false);
  }, [addressKey, path]);

  useEffect(() => {
    if (branch.length && branchIndex < 0) setBranch([]);
  }, [branch, branchIndex]);

  useEffect(() => {
    if (!shortened) setOverflow(false);
  }, [shortened]);

  useLayoutEffect(() => {
    if (editing) root.current?.querySelector("input")?.focus({ preventScroll: true });
  }, [editing]);

  function goTo(folder: FileLocation, goingUp = false) {
    if (goingUp && place && !forward.length && folder.kind === place.kind) {
      setBranch(breadcrumbPlaces(place, Infinity, true));
    }
    setOverflow(false);
    onNavigateAncestor(folder);
    focusFiles();
  }

  const overflowButton = shortened && (fitAncestors ? hidden > 0 : ancestors.length > 0) && <Button type="button" className="icon-button address-overflow"
    aria-label={t("Show parent folders")} aria-expanded={overflow} onClick={() => setOverflow(!overflow)}>…</Button>;

  return <div className="address" ref={root} id={side + "-path"} data-path={path} data-help-topic="paneAddress" onBlur={(event) => {
    if (helpIsOpen() || event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setOverflow(false);
    if (editing && !browsing.current) {
      setEditing(false);
      setDraft(path);
    }
  }}>
    {editing ? <PathField id={side + "-address"} label={label}
      suggestionLabel={t(side === "left" ? "left path suggestions" : "right path suggestions")}
      value={draft} showHidden={showHidden} server={server} browse="folder" selectOnFocus
      onBrowseStateChange={(open) => { browsing.current = open; }}
      onChange={setDraft} onCommit={(value) => {
        setEditing(false);
        if (value !== path) onNavigate(value);
        focusFiles();
      }} onEscape={() => { setEditing(false); focusFiles(); }} /> :
      <nav className="address-breadcrumbs" aria-label={t("{0} breadcrumbs", label)} data-editable={editable} data-connection-source={source}
        onClick={(event) => {
          if (event.target === event.currentTarget || event.target === clip.current || event.target === track.current) {
            startEditing();
          }
        }}
        data-tooltip={shortened ? path : undefined} data-tooltip-placement="above" onPointerEnter={(event) => {
        if (event.pointerType !== "mouse") return;
        const { left, width } = event.currentTarget.getBoundingClientRect();
        setHoverX(Math.max(0, Math.min(width - 64, event.clientX - left + 8)));
      }} onKeyDown={(event) => {
        if (event.key !== "Escape" || !overflow) return;
        event.stopPropagation();
        event.preventDefault();
        setOverflow(false);
        focusFiles();
      }}>
        {source && <div className="address-ancestor address-source">
          <Button type="button" aria-label={t("Open {0} connection list", sourceName)} onClick={() => {
            setOverflow(false);
            onOpenConnections(source);
            focusFiles();
          }}>{sourceName}</Button>
          <ChevronRight aria-hidden="true" />
        </div>}
        {overflowButton}
        <BreadcrumbTrack clip={clip} track={track} ancestors={ancestors} goTo={(ancestor) => goTo(ancestor, true)}
          fitAncestors={fitAncestors} hidden={hidden}
          current={place ? folderLabel(place) : t("Enter a path")} />
        {forward.length > 0 && <div className="address-forward">
          {forward.map((folder) => <div key={placeKey(folder)} className="address-ancestor">
            <ChevronRight aria-hidden="true" />
            <Button type="button" tooltip={placePath(folder)} data-tooltip-placement="above"
              onClick={() => goTo(folder)}>{folderLabel(folder)}</Button>
          </div>)}
        </div>}
        {shortened && overflow && parents.length > 0 && <div className="location-popup address-parents">
          {parents.map((ancestor) => <Button type="button" key={placeKey(ancestor)}
            tooltip={placePath(ancestor)} onClick={() => goTo(ancestor, true)}>{folderLabel(ancestor)}</Button>)}
        </div>}
        {(editable || path) && <div className="address-actions" style={hoverX === undefined ? undefined : { left: hoverX }}>
          {editable && <Button type="button" className="icon-button" data-tooltip-placement="above" aria-label={t("Edit {0}", label)} onClick={() => startEditing()}>
            <Pencil aria-hidden="true" />
          </Button>}
          {path && <Button type="button" className="icon-button" data-tooltip-placement="above" aria-label={t("Copy {0}", label)} onClick={() => onCopy(path)}>
            <Copy aria-hidden="true" />
          </Button>}
        </div>}
      </nav>}
  </div>;
}
