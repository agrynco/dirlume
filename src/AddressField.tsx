import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type Ref } from "react";
import { ChevronRight, Copy, Pencil, Server } from "lucide-react";
import { connectionSourceNames, folderLabel, isFileServer, placePath, smbHost, windowsClient, type ConnectionSource, type FileLocation, type Place } from "./api";
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
  const path = placePath(place);
  const windowsPath = windowsClient && (place.kind === "local" || place.kind === "smbRoot" || place.kind === "kswitcher");
  return JSON.stringify([place.kind, ...source, windowsPath ? path.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase() : path]);
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

function breadcrumbPlaces(place: FileLocation | null, limit = 4) {
  const places: FileLocation[] = [];
  while (place && places.length < limit) {
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
  const [hiddenForward, setHiddenForward] = useState(0);

  useLayoutEffect(() => {
    const viewport = clip.current;
    const content = track.current;
    if (editing || !viewport || !content) return;
    const address = viewport.parentElement;
    if (!address) return;
    const source = fitAncestors ? address.querySelector<HTMLElement>(":scope > .address-source") : null;
    const measure = () => {
      if (!fitAncestors) {
        setClipped(content.offsetWidth > viewport.clientWidth);
        return;
      }
      const available = address.clientWidth - (source?.getBoundingClientRect().width ?? 0);
      content.setAttribute("data-measuring", "");
      const width = (element: Element) => {
        const style = getComputedStyle(element);
        return element.getBoundingClientRect().width + parseFloat(style.marginInlineStart) + parseFloat(style.marginInlineEnd);
      };
      const parents = Array.from(content.querySelectorAll(":scope > .address-ancestor"), width);
      const descendants = Array.from(content.querySelectorAll(":scope > .address-forward > .address-ancestor"), width);
      const current = content.querySelector(".address-current");
      let remaining = [...parents, ...descendants].reduce((sum, size) => sum + size, current ? width(current) : 0);
      content.removeAttribute("data-measuring");
      const style = getComputedStyle(address);
      const overflowWidth = parseFloat(style.getPropertyValue("--address-overflow-width")) +
        parseFloat(style.getPropertyValue("--address-separator-width"));
      const clipped = remaining > available + 1;
      let hidden = 0;
      let hiddenForward = 0;
      while (remaining > available + 1 && (hidden < parents.length || hiddenForward < descendants.length)) {
        if (parents.length - hidden >= descendants.length - hiddenForward) {
          if (!hidden) remaining += overflowWidth;
          remaining -= parents[hidden++];
        } else {
          if (!hiddenForward) remaining += overflowWidth;
          remaining -= descendants[descendants.length - 1 - hiddenForward++];
        }
      }
      setHidden(hidden);
      setHiddenForward(hiddenForward);
      setClipped(clipped);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(fitAncestors ? address : viewport);
    observer.observe(content);
    if (source) observer.observe(source);
    return () => observer.disconnect();
  }, [editing, fitAncestors, location]);

  return { clip, track, clipped, hidden: fitAncestors ? hidden : 0, hiddenForward: fitAncestors ? hiddenForward : 0 };
}

function BreadcrumbTrack({ clip, track, ancestors, current, goTo, fitAncestors = false, hidden = 0, descendants = [],
  hiddenForward = 0, goForward, catalog = false }: {
  clip: Ref<HTMLDivElement>;
  track: Ref<HTMLDivElement>;
  ancestors: readonly FileLocation[];
  current: string;
  goTo?: (place: FileLocation) => void;
  fitAncestors?: boolean;
  hidden?: number;
  descendants?: readonly FileLocation[];
  hiddenForward?: number;
  goForward?: (place: FileLocation) => void;
  catalog?: boolean;
}) {
  return <div ref={clip} className="address-crumb-clip" data-fit={fitAncestors || undefined}>
    <div ref={track} className="address-crumbs">
      {ancestors.map((ancestor, index) => <div key={placeKey(ancestor)} className="address-ancestor" hidden={index < hidden}>
        {goTo ? <button type="button" onClick={() => goTo(ancestor)}>{folderLabel(ancestor)}</button> :
          <span>{folderLabel(ancestor)}</span>}
        <ChevronRight aria-hidden="true" />
      </div>)}
      <span aria-current="location" className="address-current">
        {catalog && <Server aria-hidden="true" />}{current}
      </span>
      {descendants.length > 0 && <div className="address-forward">
        {descendants.map((folder, index) => <div key={placeKey(folder)} className="address-ancestor"
          hidden={index >= descendants.length - hiddenForward}>
          <ChevronRight aria-hidden="true" />
          <Button type="button" tooltip={placePath(folder)} data-tooltip-placement="above"
            onClick={() => goForward?.(folder)}>{folderLabel(folder)}</Button>
        </div>)}
      </div>}
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

export function AddressField({ side, place: shown, showHidden, onNavigate, onNavigateAncestor, onOpenConnections, onCopy, focusFiles }: {
  side: Side;
  place: Place | null;
  showHidden: boolean;
  onNavigate: (path: string) => void;
  onNavigateAncestor: (place: FileLocation) => void;
  onOpenConnections: (source: ConnectionSource, trail: FileLocation) => void;
  onCopy: (path: string) => void;
  focusFiles: () => void;
}) {
  const catalog = shown?.kind === "connections" ? shown : null;
  const place = shown?.kind !== "connections" ? shown : null;
  const path = shown ? placePath(shown) : "";
  const source = connectionSource(place);
  const sourceName = source ? t(connectionSourceNames[source]) : "";
  const server = isFileServer(place) ? place : undefined;
  const editable = !catalog && (!place || place.kind === "local" || place.kind === "smbRoot" || !!server);
  const location = place ? placeKey(place) : "";
  const addressKey = JSON.stringify([side, catalog?.source, location]);
  const root = useRef<HTMLDivElement>(null);
  const browsing = useRef(false);
  const [editing, setEditing] = useState(false);
  const [overflow, setOverflow] = useState<"parents" | "previous" | null>(null);
  const parentButton = useRef<HTMLButtonElement>(null);
  const previousButton = useRef<HTMLButtonElement>(null);
  const [hoverX, setHoverX] = useState<number>();
  const [draft, setDraft] = useState(path);
  const [branch, setBranch] = useState<FileLocation[]>([]);
  const branchIndex = branch.findIndex((folder) => placeKey(folder) === location);
  const catalogBranch = catalog?.trail ? breadcrumbPlaces(catalog.trail, Infinity) : [];
  const forward = catalog ? catalogBranch : branchIndex < 0 ? [] : branch.slice(branchIndex + 1);
  const crumbs = breadcrumbPlaces(place, Infinity);
  const ancestors = crumbs.slice(0, -1);
  const { clip, track, clipped, hidden, hiddenForward } = useBreadcrumbClip(editing, true,
    JSON.stringify([addressKey, forward.map(placeKey)]));
  const parents = ancestors.slice(0, hidden);
  const nextFolders = forward.slice(forward.length - hiddenForward);
  const hiddenFolders = overflow === "parents" ? parents : nextFolders;
  const label = t(side === "left" ? "left path" : "right path");

  function startEditing() {
    if (!editable) return;
    const current = root.current?.querySelector<HTMLInputElement>("input");
    if (current) { current.focus(); current.select(); }
    else {
      setDraft(path);
      setOverflow(null);
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
    setOverflow(null);
  }, [addressKey, path]);

  useEffect(() => {
    if (!catalog && branch.length && branchIndex < 0) setBranch([]);
  }, [branch, branchIndex, catalog]);

  useEffect(() => {
    if (overflow && !hiddenFolders.length) setOverflow(null);
  }, [overflow, hiddenFolders.length]);

  useLayoutEffect(() => {
    if (editing) root.current?.querySelector("input")?.focus({ preventScroll: true });
  }, [editing]);

  function goTo(folder: FileLocation, goingUp = false) {
    if (catalogBranch.length) setBranch(catalogBranch);
    else if (goingUp && place && !forward.length) setBranch(crumbs);
    setOverflow(null);
    onNavigateAncestor(folder);
    focusFiles();
  }

  function overflowMenu(kind: "parents" | "previous", folders: FileLocation[]) {
    if (!folders.length) return null;
    const leading = kind === "parents";
    const open = overflow === kind;
    return <div className="address-ancestor address-overflow-segment">
      {!leading && <ChevronRight aria-hidden="true" />}
      <Button ref={leading ? parentButton : previousButton} type="button" className="icon-button address-overflow"
        aria-label={t(leading ? "Show parent folders" : "Show previous path")} aria-expanded={open}
        onClick={() => setOverflow(open ? null : kind)}>…</Button>
      {leading && <ChevronRight aria-hidden="true" />}
      {open && <div className={`location-popup address-${kind}`}>
        {folders.map((folder) => <Button type="button" key={placeKey(folder)} tooltip={placePath(folder)}
          onClick={() => goTo(folder, leading)}>{folderLabel(folder)}</Button>)}
      </div>}
    </div>;
  }

  return <div className="address" ref={root} id={side + "-path"} data-path={path} data-help-topic={catalog ? "paneSources" : "paneAddress"} onBlur={(event) => {
    if (helpIsOpen() || event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setOverflow(null);
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
      <nav className="address-breadcrumbs" aria-label={t("{0} breadcrumbs", label)} data-editable={editable} data-fit
        data-connection-source={source}
        onClick={(event) => {
          if (event.target === event.currentTarget || event.target === clip.current || event.target === track.current) {
            startEditing();
          }
        }}
        data-tooltip={clipped ? path : undefined} data-tooltip-placement="above" onPointerEnter={(event) => {
        if (event.pointerType !== "mouse") return;
        const { left, width } = event.currentTarget.getBoundingClientRect();
        setHoverX(Math.max(0, Math.min(width - 64, event.clientX - left + 8)));
      }} onKeyDown={(event) => {
        if (event.key !== "Escape" || !overflow) return;
        event.stopPropagation();
        event.preventDefault();
        setOverflow(null);
        (overflow === "parents" ? parentButton : previousButton).current?.focus();
      }}>
        {source && place && <div className="address-ancestor address-source">
          <Button type="button" aria-label={t("Open {0} connection list", sourceName)} onClick={() => {
            setOverflow(null);
            onOpenConnections(source, forward.at(-1) ?? place);
            focusFiles();
          }}>{sourceName}</Button>
          <ChevronRight aria-hidden="true" />
        </div>}
        {overflowMenu("parents", parents)}
        <BreadcrumbTrack clip={clip} track={track} ancestors={ancestors} goTo={(ancestor) => goTo(ancestor, true)}
          fitAncestors hidden={hidden} descendants={forward} hiddenForward={hiddenForward} goForward={goTo}
          catalog={!!catalog} current={catalog ? t(folderLabel(catalog)) : place ? folderLabel(place) : t("Enter a path")} />
        {overflowMenu("previous", nextFolders)}
        {!catalog && (editable || path) && <div className="address-actions" style={hoverX === undefined ? undefined : { left: hoverX }}>
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
