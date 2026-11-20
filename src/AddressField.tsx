import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight, Copy, Pencil } from "lucide-react";
import { folderLabel, isFileServer, placePath, smbHost, windowsClient, type Place } from "./api";
import { Button } from "./Button";
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

function placeKey(place: Place) {
  const source = place.kind === "local" ? [] : place.kind === "kswitcher" ? [place.directory, place.peer] : [place.id];
  return JSON.stringify([place.kind, ...source, placePath(place)]);
}

function breadcrumbLabel(place: Place) {
  return place.kind === "local" && smbHost(place) && !place.parent
    ? place.path.replace(/[\\/]+$/, "") : folderLabel(place);
}

function breadcrumbPlaces(place: Place | null, limit = 4, inSameSource = false) {
  const places: Place[] = [];
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

export function AddressField({ side, place, showHidden, onNavigate, onNavigateAncestor, onCopy, focusFiles }: {
  side: Side;
  place: Place | null;
  showHidden: boolean;
  onNavigate: (path: string) => void;
  onNavigateAncestor: (place: Place) => void;
  onCopy: (path: string) => void;
  focusFiles: () => void;
}) {
  const path = place ? placePath(place) : "";
  const server = isFileServer(place) ? place : undefined;
  const editable = !place || place.kind === "local" || !!server;
  const location = place ? placeKey(place) : "";
  const addressKey = JSON.stringify([side, location]);
  const root = useRef<HTMLDivElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [clipped, setClipped] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const [hoverX, setHoverX] = useState<number>();
  const [draft, setDraft] = useState(path);
  const [branch, setBranch] = useState<Place[]>([]);
  const branchIndex = branch.findIndex((folder) => placeKey(folder) === location);
  const forward = branchIndex < 0 ? [] : branch.slice(branchIndex + 1);
  const crumbs = breadcrumbPlaces(place);
  const ancestors = crumbs.slice(0, -1);
  const shortened = clipped || (ancestors.length === 3 && Boolean(parentPlace(ancestors[0])));
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

  useLayoutEffect(() => {
    if (editing) {
      root.current?.querySelector("input")?.focus({ preventScroll: true });
      return;
    }
    const viewport = clip.current;
    const content = track.current;
    if (!viewport || !content) return;
    const measure = () => setClipped(content.offsetWidth > viewport.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [editing]);

  function goTo(folder: Place, goingUp = false) {
    if (goingUp && place && !forward.length && folder.kind === place.kind) {
      setBranch(breadcrumbPlaces(place, Infinity, true));
    }
    setOverflow(false);
    onNavigateAncestor(folder);
    focusFiles();
  }

  return <div className="address" ref={root} id={side + "-path"} data-path={path} onBlur={(event) => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setOverflow(false);
  }}>
    {editing ? <PathField id={side + "-address"} label={label}
      suggestionLabel={t(side === "left" ? "left path suggestions" : "right path suggestions")}
      value={draft} showHidden={showHidden} server={server} browse="folder" selectOnFocus
      onChange={setDraft} onCommit={(value) => {
        setEditing(false);
        if (value !== path) onNavigate(value);
        focusFiles();
      }} onEscape={() => { setEditing(false); focusFiles(); }} /> :
      <nav className="address-breadcrumbs" aria-label={t("{0} breadcrumbs", label)} data-editable={editable}
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
        <div ref={clip} className="address-crumb-clip">
          <div ref={track} className="address-crumbs">
            {ancestors.map((ancestor) => <div key={placePath(ancestor)} className="address-ancestor">
              <button type="button" onClick={() => goTo(ancestor, true)}>{breadcrumbLabel(ancestor)}</button>
              <ChevronRight aria-hidden="true" />
            </div>)}
            <span aria-current="location" className="address-current">{place ? breadcrumbLabel(place) : t("Enter a path")}</span>
          </div>
        </div>
        {forward.length > 0 && <div className="address-forward">
          {forward.map((folder) => <div key={placeKey(folder)} className="address-ancestor">
            <ChevronRight aria-hidden="true" />
            <Button type="button" tooltip={placePath(folder)} data-tooltip-placement="above"
              onClick={() => goTo(folder)}>{breadcrumbLabel(folder)}</Button>
          </div>)}
        </div>}
        {shortened && ancestors.length > 0 && <Button type="button" className="icon-button address-overflow"
          aria-label={t("Show parent folders")} aria-expanded={overflow} onClick={() => setOverflow(!overflow)}>…</Button>}
        {overflow && <div className="location-popup address-parents">
          {ancestors.map((ancestor) => <Button type="button" key={placePath(ancestor)}
            tooltip={placePath(ancestor)} onClick={() => goTo(ancestor, true)}>{breadcrumbLabel(ancestor)}</Button>)}
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
