import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { File, Folder, FolderOpen } from "lucide-react";
import { api, windowsClient, type Entry, type FileServer } from "./api";
import { Button } from "./Button";
import { reportFrontendError } from "./diagnostics";
import { EditableDropdown } from "./EditableDropdown";
import { t } from "./i18n";
import { matchingFieldHistory, readFieldHistory, rememberFieldValue, useSuggestionPosition } from "./HistoryField";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function splitPath(value: string, windows: boolean, baseDirectory?: string) {
  if (windows && /^[a-z]:$/i.test(value)) {
    const parent = value + "\\";
    return { parent, lookup: parent, fragment: "", separator: "\\" };
  }
  const absolute = windows ? /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(value) : value.startsWith("/");
  if (!absolute && !baseDirectory) return null;
  const end = Math.max(value.lastIndexOf("/"), windows ? value.lastIndexOf("\\") : -1);
  const parent = value.slice(0, end + 1);
  const separator = end >= 0 ? value[end] : windows ? "\\" : "/";
  const base = baseDirectory ?? "";
  const join = base.endsWith("/") || (windows && base.endsWith("\\")) ? "" : separator;
  const lookup = absolute ? parent : base + join + parent;
  return { parent, lookup, fragment: value.slice(end + 1), separator };
}

export function PathField({ id, label, suggestionLabel, value, onChange, onCommit, onEscape, historyKey = id,
  server, kswitcher, includeFiles = false, showHidden = false, readOnly = false, required = false,
  initialFocus = false, selectOnFocus = false, suggestOnFocus = false, browse, browsePath = value, baseDirectory }: {
  id: string;
  historyKey?: string;
  label: string;
  suggestionLabel?: string;
  value: string;
  onChange: (path: string) => void;
  onCommit?: (path: string) => void;
  onEscape?: () => void;
  server?: FileServer;
  kswitcher?: { directory: string; peer: string };
  includeFiles?: boolean;
  showHidden?: boolean;
  readOnly?: boolean;
  required?: boolean;
  initialFocus?: boolean;
  selectOnFocus?: boolean;
  suggestOnFocus?: boolean;
  browse?: "folder" | "save";
  browsePath?: string;
  baseDirectory?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLSpanElement>(null);
  const edited = useRef(false);
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [selection, setSelection] = useState(-1);
  const [lookup, setLookup] = useState<{ parent: string; source: string; entries: Entry[] } | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [browseFailed, setBrowseFailed] = useState(false);
  const peer = kswitcher?.peer;
  const directory = kswitcher?.directory;
  const serverId = server?.id;
  const serverKind = server?.kind;
  const source = kswitcher ? JSON.stringify(kswitcher) : server ? `${server.kind}:${server.id}` : "local";
  const historyScope = historyKey + "." + source;
  const parts = !readOnly && editing && !showHistory ? splitPath(value, !server && (windowsClient || !!peer), baseDirectory) : null;
  const parent = parts?.lookup;
  const popup = id + "-suggestions";
  const entries = lookup?.parent === parent && lookup?.source === source ? lookup.entries : undefined;

  useEffect(() => {
    if (!parent) return;
    let current = true;
    const timer = window.setTimeout(() => {
      const listing = serverId !== undefined ? (serverKind === "ssh" ? api.listSsh : api.listFtp)(serverId, parent.split("/").filter(Boolean)) :
        peer && directory !== undefined ? api.listKSwitcher(directory, peer, parent) : api.listLocal(parent);
      void listing.then(({ entries }) => {
        if (current) setLookup({ parent, source, entries });
      }, () => {
        if (current) setLookup({ parent, source, entries: [] });
      });
    }, 140);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [parent, source, serverId, serverKind, peer, directory]);

  const fragment = parts?.fragment;
  const suggestions = useMemo(() => {
    if (!entries || fragment === undefined) return [];
    const prefix = fragment.normalize("NFC").toLocaleLowerCase();
    return entries.filter((entry) => (includeFiles || entry.directory) && (showHidden || !entry.hidden || prefix.startsWith(".")) &&
      entry.name.normalize("NFC").toLocaleLowerCase().startsWith(prefix))
      .sort((left, right) => collator.compare(left.name, right.name)).slice(0, 20);
  }, [entries, fragment, includeFiles, showHidden]);
  const history = showHistory || (editing && value) ? readFieldHistory(historyScope) : [];
  const paths = suggestions.map(({ name, directory }) => ({ path: parts!.parent + name, label: name, directory }));
  const recent = (showHistory ? history : matchingFieldHistory(history, value))
    .filter((path) => !paths.some((entry) => entry.path === path))
    .map((path) => ({ path, label: path, directory: undefined }));
  const choices = [...paths, ...recent];
  const current = choices[selection];
  const position = useSuggestionPosition(field, !readOnly && (showHistory || choices.length > 0));
  const expanded = position !== undefined;

  useLayoutEffect(() => {
    if (expanded && current) document.getElementById(popup + "-" + selection)?.scrollIntoView({ block: "nearest" });
  }, [expanded, current?.path, popup, selection]);

  function closeSuggestions() {
    setEditing(false);
    setShowHistory(false);
    setSelection(-1);
  }

  function toggleHistory() {
    input.current?.focus({ preventScroll: true });
    if (showHistory) closeSuggestions();
    else { setShowHistory(true); setSelection(-1); }
  }

  function choose(path: string) {
    closeSuggestions();
    rememberFieldValue(historyScope, path);
    edited.current = false;
    (onCommit ?? onChange)(path);
  }

  function handleKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!readOnly && event.altKey && event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      setShowHistory(true);
      setSelection(-1);
      return;
    }
    if (event.altKey) return;
    if (event.key === "Escape" && (expanded || onEscape)) {
      event.preventDefault();
      event.stopPropagation();
      closeSuggestions();
      if (!expanded) onEscape?.();
    } else if (!readOnly && event.key === "Enter" && (onCommit || (expanded && current))) {
      event.preventDefault();
      event.stopPropagation();
      choose(expanded && current ? current.path : value);
    } else if (expanded && choices.length && event.key === "Tab") {
      event.preventDefault();
      const entry = current ?? choices[0];
      edited.current = true;
      onChange(entry.path + (entry.directory ? parts?.separator ?? "" : ""));
      setSelection(-1);
      if (!entry.directory) closeSuggestions();
    } else if (expanded && choices.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      event.stopPropagation();
      const next = event.key === "ArrowDown" ? selection + 1 : selection < 0 ? choices.length - 1 : selection - 1;
      setSelection((next + choices.length) % choices.length);
    } else if (event.key === "Enter" && edited.current) {
      rememberFieldValue(historyScope, value);
      edited.current = false;
    }
  }

  const browseLabel = browse === "save" ? t("Choose a file destination") : t("Browse for a folder");

  async function pickPath() {
    closeSuggestions();
    setBrowsing(true);
    setBrowseFailed(false);
    try {
      const options = { title: browseLabel, defaultPath: browsePath || undefined };
      const selected = await (browse === "save" ? save(options) : open({ ...options, directory: true }));
      if (selected !== null && input.current) {
        if (!onCommit) input.current.focus();
        choose(selected);
      }
    } catch (error) {
      reportFrontendError("folder_picker", error);
      setBrowseFailed(true);
    } finally {
      setBrowsing(false);
    }
  }

  const list = expanded && (
    <div id={popup} className="path-suggestions" style={position} role="listbox"
      aria-label={showHistory ? t("Entry history") : suggestionLabel ?? t("{0} suggestions", label)}>
      {choices.map(({ path, label, directory }, index) => (
        <div key={path} id={popup + "-" + index} role="option" aria-selected={index === selection}
          data-tooltip={path} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(path)}>
          {directory === undefined ? null : directory ? <Folder aria-hidden="true" /> : <File aria-hidden="true" />}<span>{label}</span>
        </div>
      ))}
      {!choices.length && <div className="history-empty" role="status">{t("No previous entries.")}</div>}
    </div>
  );
  const dialog = list ? input.current?.closest("dialog") : null;
  const trigger = readOnly ? undefined : { popupId: popup, expanded, onClick: toggleHistory };
  return <div className="path-field">
    <div className="path-input-row">
      <EditableDropdown ref={field} trigger={trigger}>
        <input ref={input} id={id} aria-label={label} value={value} readOnly={readOnly} type="text" required={required}
          role={readOnly ? undefined : "combobox"} aria-autocomplete={readOnly ? undefined : "list"}
          aria-expanded={readOnly ? undefined : expanded} aria-controls={expanded ? popup : undefined}
          aria-activedescendant={expanded && current ? popup + "-" + selection : undefined}
          spellCheck={false} autoComplete="off" data-initial-focus={initialFocus || undefined}
          onFocus={(event) => {
            if (selectOnFocus) event.currentTarget.select();
            if (suggestOnFocus) setEditing(true);
          }} onBlur={(event) => {
            if (edited.current && !onCommit) rememberFieldValue(historyScope, event.currentTarget.value);
            edited.current = false;
            closeSuggestions();
          }}
          onChange={(event) => {
            edited.current = true;
            onChange(event.target.value);
            setEditing(true);
            setShowHistory(false);
            setSelection(-1);
          }} onKeyDown={handleKeys} />
      </EditableDropdown>
      {browse && !readOnly && !server && isTauri() &&
        <Button type="button" className="icon-button path-browse" aria-label={browseLabel} disabled={browsing} onClick={() => void pickPath()}>
          <FolderOpen aria-hidden="true" />
        </Button>}
    </div>
    {browseFailed && <div className="path-picker-error" role="alert">{t("Could not open the system picker.")}</div>}
    {dialog ? createPortal(list, dialog) : list}
  </div>;
}
