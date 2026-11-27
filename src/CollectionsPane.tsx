import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, File, Folder, LibraryBig } from "lucide-react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { FileContextMenu } from "./FileContextMenu";
import { describeError } from "./api";
import {
  collectionName, collectionReferencePath, collectionTrail, createCollectionFolder, editCollectionEntries,
  type CollectionEntry, type CollectionFolder,
} from "./collections";
import { errorText, t } from "./i18n";
import type { Side } from "./panes";
import { bindingMatches, eventShortcut, showShortcut, type Bindings } from "./preferences";

export function CollectionsPane({ side, active, collections, path, sourceMenu, loadError, shortcuts,
  onFocus, onPath, onClose, onChange, onCopy }: {
  side: Side;
  active: boolean;
  collections: CollectionFolder[];
  path: string[];
  sourceMenu: ReactNode;
  loadError: string;
  shortcuts: Bindings;
  onFocus: () => void;
  onPath: (path: string[]) => void;
  onClose: () => void;
  onChange: (collections: CollectionFolder[]) => void;
  onCopy?: (entries: CollectionEntry[]) => void;
}) {
  const [selected, setSelected] = useState("");
  const [marked, setMarked] = useState<string[]>([]);
  const [action, setAction] = useState<"create" | "rename" | "remove">();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [context, setContext] = useState<{ x: number; y: number }>();
  const list = useRef<HTMLDivElement>(null);
  const trail = collectionTrail(collections, path);
  const folder = trail.at(-1);
  const entries = folder?.children ?? collections;
  const index = Math.max(0, entries.findIndex((entry) => entry.id === selected));
  const item = entries[index];
  const selection = entries.filter((entry) => marked.includes(entry.id));
  const targets = selection.length ? selection : item ? [item] : [];
  const title = trail.map(({ name }) => name).join(" / ") || t("Collections");
  const pathKey = path.join("/");
  useLayoutEffect(() => { list.current?.focus({ preventScroll: true }); }, [pathKey]);

  function navigate(next: string[]) {
    setSelected("");
    setMarked([]);
    setError("");
    onPath(next);
  }

  function open(entry: CollectionEntry | undefined) {
    if (entry?.kind === "folder") navigate([...trail.map(({ id }) => id), entry.id]);
  }

  function show(next: typeof action) {
    setContext(undefined);
    setName(next === "rename" && item ? item.name : "");
    setError("");
    setAction(next);
  }

  function copy() {
    setContext(undefined);
    onCopy?.(targets);
  }

  function closeDialog() {
    setAction(undefined);
    setError("");
    requestAnimationFrame(() => list.current?.focus({ preventScroll: true }));
  }

  function submit() {
    try {
      const destination = trail.map(({ id }) => id);
      if (action === "create") {
        const created = createCollectionFolder(entries, name);
        onChange(editCollectionEntries(collections, destination, (items) => [...items, created]));
        navigate([...destination, created.id]);
      } else if (action === "rename" && item?.kind === "folder") {
        const value = collectionName(entries, name, item.id);
        onChange(editCollectionEntries(collections, destination, (items) =>
          items.map((entry) => entry.id === item.id ? { ...entry, name: value } : entry)));
      } else if (action === "remove") {
        const ids = new Set(targets.map(({ id }) => id));
        onChange(editCollectionEntries(collections, destination, (items) => items.filter(({ id }) => !ids.has(id))));
        setMarked([]);
      }
      closeDialog();
    } catch (failure) {
      setError(describeError(failure));
    }
  }

  function navigateList(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.defaultPrevented) return;
    const key = eventShortcut(event);
    const commands = [
      { match: "mkdir", enabled: !loadError, run: () => show("create") },
      { match: "rename", enabled: item?.kind === "folder", run: () => show("rename") },
      { match: "recycle", enabled: targets.length > 0, run: () => show("remove") },
      { match: "recycleAlternate", enabled: targets.length > 0, run: () => show("remove") },
      { match: "delete", enabled: targets.length > 0, run: () => show("remove") },
      { match: "copy", enabled: targets.length > 0 && Boolean(onCopy), run: copy },
      { match: "mark", enabled: Boolean(item), run: () => {
        if (item) setMarked((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id]);
      } },
    ] as const;
    const command = commands.find(({ enabled, match }) => enabled && bindingMatches(shortcuts[match], key));
    if (command) {
      event.preventDefault();
      if (!event.repeat) command.run();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Enter") {
      event.preventDefault();
      open(item);
      return;
    }
    const positions: Record<string, number> = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: entries.length - 1 };
    if (!Object.hasOwn(positions, event.key) || !entries.length) return;
    event.preventDefault();
    const next = entries[Math.min(entries.length - 1, Math.max(0, positions[event.key]))];
    setSelected(next.id);
    document.getElementById(side + "-collection-" + next.id)?.scrollIntoView({ block: "nearest" });
  }

  const dialogTitle = t(action === "rename" ? "Rename" : action === "remove" ? "Remove from collection" :
    trail.length ? "New folder" : "New collection");
  return <section className={"pane recent-pane recent-" + side + (active ? " active" : "")}
    aria-label={t("Collections")} data-pane-side={side} data-help-topic="paneSources"
    onFocus={onFocus} onKeyDown={(event) => {
      if (event.key !== "Escape" || event.defaultPrevented || action) return;
      event.preventDefault();
      if (trail.length) navigate(trail.slice(0, -1).map(({ id }) => id));
      else onClose();
    }}>
    <header className="pane-heading">
      <h2 className="pane-title" title={title}><LibraryBig aria-hidden="true" />{title}</h2>
      <Button className="icon-button" aria-label={t(trail.length ? "Parent folder" : "Back to files")}
        onClick={() => trail.length ? navigate(trail.slice(0, -1).map(({ id }) => id)) : onClose()}><ArrowLeft /></Button>
      {sourceMenu}
    </header>
    <div className="recent-list" role="listbox" aria-label={title} id={side + "-collections"} tabIndex={0}
      aria-multiselectable="true" aria-activedescendant={item ? side + "-collection-" + item.id : undefined} ref={list}
      onKeyDown={navigateList}>
      {entries.map((entry) => {
        const source = entry.kind === "reference" ? collectionReferencePath(entry) : "";
        const Icon = entry.kind === "folder" || entry.directory ? Folder : File;
        return <div className="recent-row" key={entry.id} id={side + "-collection-" + entry.id} role="option"
          aria-selected={entry === item || marked.includes(entry.id)} aria-label={source ? entry.name + " · " + source : entry.name}
          onClick={(event) => {
            setSelected(entry.id);
            if (event.ctrlKey || event.metaKey) setMarked((current) =>
              current.includes(entry.id) ? current.filter((id) => id !== entry.id) : [...current, entry.id]);
            list.current?.focus({ preventScroll: true });
          }} onDoubleClick={() => open(entry)}
          onContextMenu={(event) => {
            event.preventDefault();
            setSelected(entry.id);
            if (!marked.includes(entry.id)) setMarked([]);
            setContext({ x: event.clientX, y: event.clientY });
          }}>
          <Icon aria-hidden="true" /><strong>{entry.name}</strong>
          {source && <span className="recent-path" title={source}>{source}</span>}
        </div>;
      })}
    </div>
    {!entries.length && !loadError && <p className="pane-empty">{t(folder ? "This collection folder is empty." : "No collections yet.")}</p>}
    {loadError && <div className="pane-error"><span role="alert">{errorText(loadError)}</span></div>}
    <footer className="recent-actions">
      <Button disabled={!!loadError} shortcut={showShortcut(shortcuts.mkdir[0])} onClick={() => show("create")}>{t(folder ? "New folder" : "New collection")}</Button>
      <Button disabled={item?.kind !== "folder"} shortcut={showShortcut(shortcuts.rename[0])} onClick={() => show("rename")}>{t("Rename")}</Button>
      <Button disabled={!targets.length} shortcut={showShortcut(shortcuts.recycle[0])} onClick={() => show("remove")}>{t("Remove from collection")}</Button>
      {onCopy && <Button disabled={!targets.length} shortcut={showShortcut(shortcuts.copy[0])} onClick={copy}>{t("Copy")}</Button>}
    </footer>
    {context && <FileContextMenu {...context} label="Collections"
      onClose={() => setContext(undefined)} onReturn={() => list.current?.focus({ preventScroll: true })}>
      {item?.kind === "folder" && <Button role="menuitem" onClick={() => { setContext(undefined); open(item); }}>{t("Open folder")}</Button>}
      {onCopy && <Button role="menuitem" onClick={copy}>{t("Copy")}</Button>}
      {item?.kind === "folder" && <Button role="menuitem" onClick={() => show("rename")}>{t("Rename")}</Button>}
      <Button role="menuitem" onClick={() => show("remove")}>{t("Remove from collection")}</Button>
    </FileContextMenu>}
    {action && <Dialog title={dialogTitle} onClose={closeDialog}>
      <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <div className="dialog-body">
          {action === "remove" ? <p>{t("Remove the selected entries from the collection? Original files and folders will remain in place.")}</p> :
            <label className="field">{t("Name")}<input data-initial-focus required value={name}
              onChange={(event) => setName(event.target.value)} /></label>}
          {error && <p className="dialog-error" role="alert">{errorText(error)}</p>}
        </div>
        <footer className="dialog-footer">
          <Button type="button" data-initial-focus={action === "remove" || undefined} onClick={closeDialog}>{t("Cancel")}</Button>
          <Button type="submit">{t(action === "remove" ? "Remove" : action === "rename" ? "Rename" : "Create")}</Button>
        </footer>
      </form>
    </Dialog>}
  </section>;
}
