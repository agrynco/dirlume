import { useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { DialogIconButton } from "./DialogActions";
import { PathField } from "./PathField";
import { HistoryField } from "./HistoryField";
import { folderGroups, normalizeFolderPath, sameFolderShortcut, type FolderGroup, type FolderShortcut, type FolderShortcuts } from "./folderShortcuts";
import { countText, t } from "./i18n";
import { bindingMatches, eventShortcut, showShortcut, type Bindings } from "./preferences";

type Picker = { kind: "picker"; group: FolderGroup; selection: number };

export type FolderShortcutScreen =
  | { kind: "groups" }
  | Picker
  | { kind: "edit"; group: FolderGroup; entry: FolderShortcut; index?: number; returnTo?: Picker };

interface Props {
  screen: FolderShortcutScreen;
  shortcuts: FolderShortcuts;
  currentFolder?: FolderShortcut;
  bridgeDirectory: string;
  bindings: Bindings;
  onScreen: (screen: FolderShortcutScreen) => void;
  onSave: (shortcuts: FolderShortcuts) => void;
  onAssigned: (group: FolderGroup) => void;
  onOpen: (entry: FolderShortcut) => void;
  onClose: () => void;
}

export function FolderShortcutsDialog(props: Props) {
  const { screen, shortcuts, onScreen, onSave, onAssigned, onClose } = props;
  if (screen.kind === "groups") {
    const occupied = folderGroups.filter((group) => shortcuts[group].length > 0);
    return <Dialog title={t("Folder shortcuts")} onClose={onClose} dismissOnOutside>
      <div className="dialog-body command-menu">
        {occupied.length ? occupied.map((group, index) =>
          <Button key={group} type="button" data-initial-focus={index === 0 ? true : undefined}
            onClick={() => onScreen({ kind: "picker", group, selection: 0 })}>
            <span>{t("Group {0}", group)}</span><span>{countText(shortcuts[group].length, "folder")}</span>
          </Button>
        ) : <p>{t("No folder shortcuts saved.")}</p>}
      </div>
      <footer className="dialog-footer"><Button type="button" onClick={onClose}>{t("Close")}</Button></footer>
    </Dialog>;
  }
  if (screen.kind === "edit") {
    const cancel = () => screen.returnTo ? onScreen(screen.returnTo) : onClose();
    return <FolderShortcutEditor group={screen.group} entry={screen.entry} bridgeDirectory={props.bridgeDirectory}
      onClose={cancel} onSubmit={(entry) => {
        const group = shortcuts[screen.group];
        if (group.some((existing, index) => index !== screen.index && sameFolderShortcut(existing, entry))) {
          return t("This folder is already assigned to this group.");
        }
        const index = screen.index ?? group.length;
        const updated = group.slice();
        updated[index] = entry;
        try {
          onSave(shortcuts.map((entries, digit) => digit === screen.group ? updated : entries));
        } catch {
          return t("Could not save folder shortcuts.");
        }
        onAssigned(screen.group);
        if (screen.returnTo) onScreen({ ...screen.returnTo, selection: index });
        else onClose();
      }} />;
  }
  return <FolderShortcutPicker {...props} screen={screen} />;
}

function FolderShortcutEditor({ group, entry, bridgeDirectory, onSubmit, onClose }: {
  group: FolderGroup;
  entry: FolderShortcut;
  bridgeDirectory: string;
  onSubmit: (entry: FolderShortcut) => string | void;
  onClose: () => void;
}) {
  const id = useId();
  const [title, setTitle] = useState(entry.title);
  const [path, setPath] = useState(entry.path);
  const [error, setError] = useState("");
  const host = entry.remote?.name ?? entry.peer?.name;
  const pathLabel = host ? t("Path on {0}", host) : t("Path");

  function save(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeFolderPath(path, !!entry.peer, !!entry.remote);
    if (!normalized) {
      setError(t("Enter an absolute folder path on the original computer."));
      return;
    }
    setError(onSubmit({ ...entry, path: normalized, title: title.trim() }) ?? "");
  }

  return <Dialog title={t("Folder shortcuts")} onClose={onClose}>
    <form className="dialog-form" onSubmit={save}>
      <div className="dialog-body folder-shortcut-editor">
        <strong>{t("Group {0}", group)}</strong>
        <label className="field">{t("Title (optional)")}
          <HistoryField historyKey="folder-shortcut-title" aria-label={t("Title (optional)")} type="text" data-initial-focus
            maxLength={255} value={title} onValueChange={setTitle} />
        </label>
        <label className="field" htmlFor={id}>{pathLabel}</label>
        {entry.remote ? <HistoryField id={id} historyKey={"folder-shortcut-path." + entry.remote.id}
          spellCheck={false} value={path} onValueChange={setPath} required /> :
          <PathField id={id} historyKey="folder-shortcut-path" label={pathLabel}
            value={path} onChange={setPath} browse={entry.peer ? undefined : "folder"}
            kswitcher={entry.peer ? { directory: bridgeDirectory, peer: entry.peer.id } : undefined} required />}
        {error && <p className="dialog-error" role="alert">{error}</p>}
      </div>
      <footer className="dialog-footer">
        <Button type="button" onClick={onClose}>{t("Cancel")}</Button>
        <Button type="submit" className="primary">{t("Save")}</Button>
      </footer>
    </form>
  </Dialog>;
}

function FolderShortcutPicker({ screen, shortcuts, currentFolder, bindings, onScreen, onSave, onOpen, onClose }: Props & { screen: Picker }) {
  const { group } = screen;
  const entries = shortcuts[group];
  const selection = Math.max(0, Math.min(entries.length - 1, screen.selection));
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const [error, setError] = useState("");
  const select = (index: number) => onScreen({ ...screen, selection: index });

  useLayoutEffect(() => {
    document.getElementById(`${id}-${selection}`)?.scrollIntoView({ block: "nearest" });
  }, [id, selection]);

  function save(updated: FolderShortcut[], next: number) {
    try {
      onSave(shortcuts.map((entries, digit) => digit === group ? updated : entries));
      setError("");
      if (!updated.length) onClose();
      else {
        select(next);
        list.current?.focus({ preventScroll: true });
      }
    } catch {
      setError(t("Could not save folder shortcuts."));
    }
  }

  function move(offset: number) {
    const index = selection + offset;
    if (index < 0 || index >= entries.length) return;
    const updated = entries.slice();
    [updated[selection], updated[index]] = [updated[index], updated[selection]];
    save(updated, index);
  }

  const actions = [
    { command: "pickerAddFolder", label: "Add", icon: Plus, disabled: !currentFolder, run: () => {
      if (currentFolder) onScreen({ kind: "edit", group, entry: currentFolder, returnTo: screen });
    } },
    { command: "pickerEditFolder", label: "Edit", icon: Pencil, disabled: !entries[selection], run: () => {
      onScreen({ kind: "edit", group, entry: entries[selection], index: selection, returnTo: screen });
    } },
    { command: "pickerRemoveFolder", label: "Remove", icon: Trash2, disabled: !entries[selection], run: () => {
      const updated = entries.filter((_, index) => index !== selection);
      save(updated, Math.max(0, Math.min(selection, updated.length - 1)));
    } },
    { command: "pickerFolderUp", label: "Move up", icon: ArrowUp, disabled: selection === 0, run: () => move(-1) },
    { command: "pickerFolderDown", label: "Move down", icon: ArrowDown, disabled: selection >= entries.length - 1, run: () => move(1) },
  ] as const;

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const shortcut = eventShortcut(event);
    const action = actions.find(({ command }) => bindingMatches(bindings[command], shortcut));
    if (action) {
      event.preventDefault();
      if (!action.disabled && !event.repeat) action.run();
    } else if (event.target !== list.current) return;
    else if (shortcut === "Enter") {
      event.preventDefault();
      if (entries[selection]) onOpen(entries[selection]);
    } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(shortcut)) {
      event.preventDefault();
      if (shortcut === "Home") select(0);
      else if (shortcut === "End") select(entries.length - 1);
      else select(Math.max(0, Math.min(entries.length - 1, selection + (shortcut === "ArrowDown" ? 1 : -1))));
    }
  }

  return <Dialog title={t("Folder shortcuts")} onClose={onClose} dismissOnOutside>
    <div className="dialog-body folder-shortcut-picker" onKeyDown={navigate}>
      <strong>{t("Group {0}", group)}</strong>
      <div ref={list} className="folder-shortcut-list" role="listbox" tabIndex={0} data-initial-focus
        aria-label={t("Folder shortcuts in group {0}", group)} aria-activedescendant={entries.length ? `${id}-${selection}` : undefined}>
        {entries.map((entry, index) => {
          const host = entry.remote?.name ?? entry.peer?.name;
          const path = host ? host + " · " + entry.path : entry.path;
          const key = [entry.remote?.kind, entry.remote?.id ?? entry.peer?.id, entry.path].join(":");
          return <div key={key} id={`${id}-${index}`} role="option"
            className="folder-shortcut-row" aria-selected={index === selection} data-tooltip={path}
            onClick={() => { select(index); list.current?.focus({ preventScroll: true }); }}
            onDoubleClick={() => onOpen(entry)}>
            <span>{entry.title || path}</span>
            {entry.title && <small>{path}</small>}
          </div>;
        })}
      </div>
      <div className="dialog-action-strip dialog-actions-end">
        {[actions.slice(0, 3), actions.slice(3)].map((group, index) => <div className="dialog-action-group" key={index}>
          {group.map(({ label, command, icon: Icon, disabled, run }) => <DialogIconButton key={command}
            label={t(label)} disabled={disabled} shortcut={showShortcut(bindings[command][0])} onClick={run}><Icon /></DialogIconButton>)}
        </div>)}
      </div>
      {error && <p role="alert" className="dialog-error">{error}</p>}
    </div>
  </Dialog>;
}
