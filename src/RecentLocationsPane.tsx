import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, Clock3, Folder } from "lucide-react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { errorText, t } from "./i18n";
import type { Side } from "./panes";
import { recentLocationKey, recentPath, type RecentLocation } from "./recentLocations";
import { bindingMatches, eventShortcut } from "./preferences";

function recentSource(location: RecentLocation) {
  if (location.kind === "local") return t("Local file system");
  const type = location.kind === "server" ? t("Dirlume server") :
    location.kind === "kswitcher" ? "KSwitcher LAN" : location.kind.toUpperCase();
  return location.source ? type + " · " + location.source : type;
}

export function RecentLocationsPane({ side, active, locations, sourceMenu, error, loading, onFocus,
  onClose, onOpen, onRemove, onClear, onEdit, copyBindings, onCollect, onSelection }: {
  side: Side;
  active: boolean;
  locations: readonly RecentLocation[];
  sourceMenu: ReactNode;
  error: string;
  loading: boolean;
  onFocus: () => void;
  onClose: () => void;
  onOpen: (location: RecentLocation) => void;
  onRemove: (location: RecentLocation) => void;
  onClear: () => void;
  onEdit: (location: RecentLocation) => void;
  copyBindings: readonly string[];
  onCollect?: (location: RecentLocation) => void;
  onSelection: (location: RecentLocation | undefined) => void;
}) {
  const [filter, setFilter] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { input.current?.focus(); }, []);
  const terms = filter.trim().toLocaleLowerCase().split(/\s+/);
  const visible = locations.filter((location) => {
    const fields = [location.name, recentPath(location), recentSource(location)].map((value) => value.toLocaleLowerCase());
    return terms.every((term) => fields.some((value) => value.includes(term)));
  });
  const selected = Math.max(0, visible.findIndex((location) => recentLocationKey(location) === selectedKey));
  const current = visible[selected];
  useLayoutEffect(() => { onSelection(current); }, [current, onSelection]);
  const rowId = (index: number) => side + "-recent-location-" + index;
  function openCurrent() {
    if (current && !loading) onOpen(current);
  }
  function navigate(event: KeyboardEvent, inFilter = false) {
    if (!inFilter && current && !loading && onCollect && !event.nativeEvent.isComposing &&
        bindingMatches(copyBindings, eventShortcut(event))) {
      event.preventDefault();
      if (!event.repeat) onCollect(current);
      return;
    }
    if (event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key === "Enter") {
      event.preventDefault();
      openCurrent();
      return;
    }
    const positions: Record<string, number> = { ArrowUp: selected - 1, ArrowDown: selected + 1, Home: 0, End: visible.length - 1 };
    if (!Object.hasOwn(positions, event.key) || inFilter && !event.key.startsWith("Arrow") || !current) return;
    event.preventDefault();
    const index = inFilter ? selected : Math.min(visible.length - 1, Math.max(0, positions[event.key]));
    setSelectedKey(recentLocationKey(visible[index]));
    if (inFilter) list.current?.focus({ preventScroll: true });
    document.getElementById(rowId(index))?.scrollIntoView({ block: "nearest" });
  }
  return <section className={"pane recent-pane recent-" + side + (active ? " active" : "")}
    aria-label={t(side === "left" ? "Recent locations in left pane" : "Recent locations in right pane")}
    data-pane-side={side} data-help-topic="paneSources" onFocus={onFocus} onKeyDown={(event) => {
      if (event.key !== "Escape" || event.defaultPrevented || confirmClear) return;
      event.preventDefault();
      onClose();
    }}>
    <header className="pane-heading">
      <h2 className="pane-title"><Clock3 aria-hidden="true" />{t("Recent locations")}</h2>
      <Button className="icon-button" aria-label={t("Back to files")} onClick={onClose}><ArrowLeft /></Button>
      {sourceMenu}
    </header>
    <div className="recent-filter">
      <input ref={input} type="search" aria-label={t("Filter recent locations")} placeholder={t("Filter recent locations")}
        value={filter} onChange={(event) => { setFilter(event.target.value); setSelectedKey(""); }}
        onKeyDown={(event) => navigate(event, true)} />
    </div>
    <div className="recent-list" role="listbox" aria-label={t("Recent locations")} aria-busy={loading}
      aria-activedescendant={current ? rowId(selected) : undefined} id={side + "-recent"} tabIndex={0} ref={list}
      onKeyDown={navigate}>
      {visible.map((location, index) => {
        const key = recentLocationKey(location);
        const source = recentSource(location);
        const path = recentPath(location);
        return <div className="recent-row" key={key} id={rowId(index)} role="option" aria-selected={index === selected}
          aria-label={location.name + " · " + path + " · " + source} data-tooltip={path + " · " + source}
          onClick={() => { setSelectedKey(key); list.current?.focus({ preventScroll: true }); }}
          onDoubleClick={() => { if (!loading) onOpen(location); }}>
          <Folder aria-hidden="true" /><strong>{location.name}</strong><small>{source}</small>
          <span className="recent-path">{path}</span>
        </div>;
      })}
    </div>
    {!visible.length && <p className="pane-empty" role="status">
      {t(locations.length ? "No recent locations match the filter." : "No recent locations yet.")}
    </p>}
    {error && <div className="pane-error"><span role="alert">{errorText(error)}</span></div>}
    <footer className="recent-actions">
      <Button disabled={!current || loading} onClick={openCurrent}>{t("Open folder")}</Button>
      {onCollect && <Button disabled={!current || loading} onClick={() => { if (current) onCollect(current); }}>{t("Add to collection")}</Button>}
      <Button disabled={!current || loading} onClick={() => {
        if (current) onRemove(current);
        list.current?.focus({ preventScroll: true });
      }}>{t("Remove from Recent")}</Button>
      <Button disabled={!locations.length || loading} onClick={() => setConfirmClear(true)}>{t("Clear Recent")}</Button>
      {error && current && "profileId" in current &&
        <Button disabled={loading} onClick={() => onEdit(current)}>{t("Edit connection")}</Button>}
    </footer>
    {confirmClear && <Dialog title={t("Clear Recent")} onClose={() => setConfirmClear(false)} footer={<>
      <Button data-initial-focus onClick={() => setConfirmClear(false)}>{t("Cancel")}</Button>
      <Button onClick={() => {
        onClear();
        setConfirmClear(false);
        requestAnimationFrame(() => input.current?.focus());
      }}>{t("Clear Recent")}</Button>
    </>}>
      <p>{t("Remove all folders from Recent?")}</p>
    </Dialog>}
  </section>;
}
