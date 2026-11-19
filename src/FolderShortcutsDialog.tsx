import { useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { PathField } from "./PathField";
import { folderGroups, normalizeFolderPath, sameFolderShortcut, type FolderGroup, type FolderShortcut, type FolderShortcuts } from "./folderShortcuts";
import { countText, t } from "./i18n";
import { eventShortcut, showShortcut, type Bindings } from "./preferences";

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

  function save(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeFolderPath(path, !!entry.peer);
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
          <input type="text" data-initial-focus maxLength={255} value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="field" htmlFor={id}>{entry.peer ? t("Path on {0}", entry.peer.name) : t("Path")}</label>
        <PathField id={id} label={entry.peer ? t("Path on {0}", entry.peer.name) : t("Path")}
          value={path} onChange={setPath} browse={entry.peer ? undefined : "folder"}
          kswitcher={entry.peer ? { directory: bridgeDirectory, peer: entry.peer.id } : undefined} required />
        {error && <p className="dialog-error" role="alert">{error}</p>}
      </div>
      <footer className="dialog-footer">
        <Button type="button" onClick={onClose}>{t("Cancel")}</Button>
        <Button type="submit" className="primary">{t("OK")}</Button>
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
    { command: "pickerAddFolder", label: "Add", disabled: !currentFolder, run: () => {
      if (currentFolder) onScreen({ kind: "edit", group, entry: currentFolder, returnTo: screen });
    } },
    { command: "pickerEditFolder", label: "Edit", disabled: !entries[selection], run: () => {
      onScreen({ kind: "edit", group, entry: entries[selection], index: selection, returnTo: screen });
    } },
    { command: "pickerRemoveFolder", label: "Remove", disabled: !entries[selection], run: () => {
      const updated = entries.filter((_, index) => index !== selection);
      save(updated, Math.max(0, Math.min(selection, updated.length - 1)));
    } },
    { command: "pickerFolderUp", label: "Move up", disabled: selection === 0, run: () => move(-1) },
    { command: "pickerFolderDown", label: "Move down", disabled: selection >= entries.length - 1, run: () => move(1) },
  ] as const;

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const shortcut = eventShortcut(event);
    const action = actions.find(({ command }) => shortcut && bindings[command] === shortcut);
    if (action) {
      event.preventDefault();
      if (!action.disabled && !event.repeat) action.run();
    } else if (shortcut === "Enter") {
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
    <div className="dialog-body folder-shortcut-picker">
      <strong>{t("Group {0}", group)}</strong>
      <div ref={list} className="folder-shortcut-list" role="listbox" tabIndex={0} data-initial-focus
        aria-label={t("Folder shortcuts in group {0}", group)} aria-activedescendant={entries.length ? `${id}-${selection}` : undefined}
        onKeyDown={navigate}>
        {entries.map((entry, index) => {
          const path = entry.peer ? `${entry.peer.name} · ${entry.path}` : entry.path;
          return <div key={`${entry.peer?.id || ""}:${entry.path}`} id={`${id}-${index}`} role="option"
            className="folder-shortcut-row" aria-selected={index === selection} title={path}
            onClick={() => { select(index); list.current?.focus({ preventScroll: true }); }}
            onDoubleClick={() => onOpen(entry)}>
            <span>{entry.title || path}</span>
            {entry.title && <small>{path}</small>}
          </div>;
        })}
      </div>
      {error && <p role="alert" className="dialog-error">{error}</p>}
    </div>
    <footer className="dialog-footer folder-shortcut-actions">
      {actions.map(({ label, command, disabled, run }) => {
        const shortcut = showShortcut(bindings[command]);
        return <Button key={command} type="button" disabled={disabled} shortcut={shortcut} onClick={run}>
          {t(label)}{shortcut && <kbd aria-hidden="true">{shortcut}</kbd>}
        </Button>;
      })}
    </footer>
  </Dialog>;
}
