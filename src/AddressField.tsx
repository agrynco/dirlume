import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type Ref } from "react";
import { ChevronRight, Copy, Pencil, Server } from "lucide-react";
import { connectionSourceNames, folderLabel, isFileServer, placeAddress, windowsClient, type ConnectionSource, type FileLocation, type Place } from "./api";
import { Button } from "./Button";
import { helpIsOpen } from "./contextHelp";
import { t } from "./i18n";
import { breadcrumbPlaces, connectionSource, parentPath, placeKey, previousPath, type Side } from "./panes";
import { PathField } from "./PathField";

function useBreadcrumbClip(location: string) {
  const clip = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  const [hidden, setHidden] = useState(0);
  const [hiddenForward, setHiddenForward] = useState(0);

  useLayoutEffect(() => {
    const viewport = clip.current;
    const content = track.current;
    if (!viewport || !content) return;
    const address = viewport.parentElement;
    if (!address) return;
    const source = address.querySelector<HTMLElement>(":scope > .address-source");
    const measure = () => {
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
    observer.observe(address);
    observer.observe(content);
    if (source) observer.observe(source);
    return () => observer.disconnect();
  }, [location]);

  return { clip, track, clipped, hidden, hiddenForward };
}

function BreadcrumbTrack({ clip, track, ancestors, current, goTo, hidden, descendants, hiddenForward, catalog }: {
  clip: Ref<HTMLDivElement>;
  track: Ref<HTMLDivElement>;
  ancestors: readonly FileLocation[];
  current: string;
  goTo: (place: FileLocation) => void;
  hidden: number;
  descendants: readonly FileLocation[];
  hiddenForward: number;
  catalog: boolean;
}) {
  return <div ref={clip} className="address-crumb-clip">
    <div ref={track} className="address-crumbs">
      {ancestors.map((ancestor, index) => <div key={placeKey(ancestor)} className="address-ancestor" hidden={index < hidden}>
        <button type="button" onClick={() => goTo(ancestor)}>{folderLabel(ancestor)}</button>
        <ChevronRight aria-hidden="true" />
      </div>)}
      <span aria-current="location" className="address-current">
        {catalog && <Server aria-hidden="true" />}{current}
      </span>
      {descendants.length > 0 && <div className="address-forward">
        {descendants.map((folder, index) => <div key={placeKey(folder)} className="address-ancestor"
          hidden={index >= descendants.length - hiddenForward}>
          <ChevronRight aria-hidden="true" />
          <Button type="button" tooltip={placeAddress(folder)} data-tooltip-placement="above"
            onClick={() => goTo(folder)}>{folderLabel(folder)}</Button>
        </div>)}
      </div>}
    </div>
  </div>;
}

export function AddressBreadcrumbs({ place: shown, path, label, trail, onNavigate, onOpenConnections, onEdit, onCopy }: {
  place: Place | null;
  path: string;
  label: string;
  trail?: FileLocation;
  onNavigate: (place: FileLocation) => void;
  onOpenConnections?: (source: ConnectionSource) => void;
  onEdit?: () => void;
  onCopy?: () => void;
}) {
  const catalog = shown?.kind === "connections" ? shown : null;
  const place = shown?.kind !== "connections" ? shown : null;
  const target = place?.kind === "local" && place.parent === null ? { ...place, parent: parentPath(place.path, windowsClient) } : place;
  const source = connectionSource(target);
  const sourceName = source ? t(connectionSourceNames[source]) : "";
  const forward = previousPath(shown, trail);
  const ancestors = breadcrumbPlaces(target).slice(0, -1);
  const location = JSON.stringify([catalog?.source, target && placeKey(target), forward.map(placeKey)]);
  const { clip, track, clipped, hidden, hiddenForward } = useBreadcrumbClip(location);
  const [overflow, setOverflow] = useState<"parents" | "previous" | null>(null);
  const parentButton = useRef<HTMLButtonElement>(null);
  const previousButton = useRef<HTMLButtonElement>(null);
  const restoreOverflowFocus = useRef<typeof overflow>(null);
  const [hoverX, setHoverX] = useState<number>();
  const parents = ancestors.slice(0, hidden);
  const nextFolders = forward.slice(forward.length - hiddenForward);
  const hiddenFolders = overflow === "parents" ? parents : nextFolders;

  useLayoutEffect(() => setOverflow(null), [location]);
  useEffect(() => {
    if (overflow && !hiddenFolders.length) setOverflow(null);
  }, [overflow, hiddenFolders.length]);

  useLayoutEffect(() => {
    if (overflow || !restoreOverflowFocus.current) return;
    const trigger = restoreOverflowFocus.current === "parents" ? parentButton : previousButton;
    restoreOverflowFocus.current = null;
    trigger.current?.focus({ preventScroll: true });
  }, [overflow]);

  function goTo(folder: FileLocation) {
    setOverflow(null);
    onNavigate(folder);
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
        {folders.map((folder) => <Button type="button" key={placeKey(folder)} tooltip={placeAddress(folder)}
          onClick={() => goTo(folder)}>{folderLabel(folder)}</Button>)}
      </div>}
    </div>;
  }

  return <nav className="address-breadcrumbs" aria-label={t("{0} breadcrumbs", label)} data-editable={Boolean(onEdit)}
    data-connection-source={source}
    onBlur={(event) => {
      if (!helpIsOpen() && !event.currentTarget.contains(event.relatedTarget)) setOverflow(null);
    }}
    onClick={(event) => {
      if (event.target === event.currentTarget || event.target === clip.current || event.target === track.current) {
        onEdit?.();
      }
    }}
    data-tooltip={clipped ? path : undefined} data-tooltip-placement="above" onPointerEnter={(event) => {
    if ((!onEdit && !onCopy) || event.pointerType !== "mouse") return;
    const { left, width } = event.currentTarget.getBoundingClientRect();
    setHoverX(Math.max(0, Math.min(width - 64, event.clientX - left + 8)));
  }} onKeyDown={(event) => {
    if (event.key !== "Escape" || !overflow) return;
    event.stopPropagation();
    event.preventDefault();
    restoreOverflowFocus.current = overflow;
    setOverflow(null);
  }}>
    {source && place && <div className="address-ancestor address-source">
      {onOpenConnections ? <Button type="button" aria-label={t("Open {0} connection list", sourceName)} onClick={() => {
        setOverflow(null);
        onOpenConnections(source);
      }}>{sourceName}</Button> : <span>{sourceName}</span>}
      <ChevronRight aria-hidden="true" />
    </div>}
    {overflowMenu("parents", parents)}
    <BreadcrumbTrack clip={clip} track={track} ancestors={ancestors} goTo={goTo}
      hidden={hidden} descendants={forward} hiddenForward={hiddenForward}
      catalog={!!catalog} current={catalog ? t(folderLabel(catalog)) : place ? folderLabel(place) : t("Enter a path")} />
    {overflowMenu("previous", nextFolders)}
    {(onEdit || onCopy) && <div className="address-actions" style={hoverX === undefined ? undefined : { left: hoverX }}>
      {onEdit && <Button type="button" className="icon-button" data-tooltip-placement="above" aria-label={t("Edit {0}", label)} onClick={onEdit}>
        <Pencil aria-hidden="true" />
      </Button>}
      {onCopy && <Button type="button" className="icon-button" data-tooltip-placement="above" aria-label={t("Copy {0}", label)} onClick={onCopy}>
        <Copy aria-hidden="true" />
      </Button>}
    </div>}
  </nav>;
}

export function AddressField({ side, place: shown, trail, showHidden, onNavigate, onNavigateAncestor, onOpenConnections, onCopy, focusFiles }: {
  side: Side;
  place: Place | null;
  trail?: FileLocation;
  showHidden: boolean;
  onNavigate: (path: string) => void;
  onNavigateAncestor: (place: FileLocation) => void;
  onOpenConnections: (source: ConnectionSource) => void;
  onCopy: (path: string) => void;
  focusFiles: () => void;
}) {
  const catalog = shown?.kind === "connections" ? shown : null;
  const place = shown?.kind !== "connections" ? shown : null;
  const path = shown ? placeAddress(shown) : "";
  const server = isFileServer(place) ? place : undefined;
  const editable = !catalog && (!place || place.kind === "local" || place.kind === "smbRoot" || !!server);
  const location = place ? placeKey(place) : "";
  const addressKey = JSON.stringify([side, catalog?.source, location]);
  const root = useRef<HTMLDivElement>(null);
  const browsing = useRef(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(path);
  const label = t(side === "left" ? "left path" : "right path");

  function startEditing() {
    if (!editable) return;
    const current = root.current?.querySelector<HTMLInputElement>("input");
    if (current) { current.focus(); current.select(); }
    else {
      setDraft(path);
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
  }, [addressKey, path]);

  useLayoutEffect(() => {
    if (editing) root.current?.querySelector("input")?.focus({ preventScroll: true });
  }, [editing]);

  return <div className="address" ref={root} id={side + "-path"} data-path={path} data-help-topic={catalog ? "paneSources" : "paneAddress"} onBlur={(event) => {
    if (helpIsOpen() || event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
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
      <AddressBreadcrumbs place={shown} path={path} label={label} trail={trail}
        onNavigate={(folder) => { onNavigateAncestor(folder); focusFiles(); }}
        onOpenConnections={(source) => { onOpenConnections(source); focusFiles(); }}
        onEdit={editable ? startEditing : undefined} onCopy={!catalog && path ? () => onCopy(path) : undefined} />}
  </div>;
}
