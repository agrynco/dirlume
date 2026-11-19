import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { File, Folder, FolderOpen } from "lucide-react";
import { api, windowsClient, type Entry } from "./api";
import { Button } from "./Button";
import { reportFrontendError } from "./diagnostics";
import { t } from "./i18n";

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

export function PathField({ id, label, suggestionLabel, value, onChange, onCommit, onEscape,
  ftp, kswitcher, includeFiles = false, showHidden = false, readOnly = false, required = false,
  initialFocus = false, selectOnFocus = false, suggestOnFocus = false, browse, browsePath = value, baseDirectory }: {
  id: string;
  label: string;
  suggestionLabel?: string;
  value: string;
  onChange: (path: string) => void;
  onCommit?: (path: string) => void;
  onEscape?: () => void;
  ftp?: number;
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
  const [editing, setEditing] = useState(false);
  const [selection, setSelection] = useState(-1);
  const [lookup, setLookup] = useState<{ parent: string; source: string; entries: Entry[] } | null>(null);
  const [position, setPosition] = useState<CSSProperties>();
  const [browsing, setBrowsing] = useState(false);
  const [browseFailed, setBrowseFailed] = useState(false);
  const peer = kswitcher?.peer;
  const directory = kswitcher?.directory;
  const source = kswitcher ? JSON.stringify(kswitcher) : ftp === undefined ? "local" : `ftp:${ftp}`;
  const parts = !readOnly && editing ? splitPath(value, ftp === undefined && (windowsClient || !!peer), baseDirectory) : null;
  const parent = parts?.lookup;
  const popup = id + "-suggestions";
  const entries = lookup?.parent === parent && lookup?.source === source ? lookup.entries : undefined;

  useEffect(() => {
    if (!parent) return;
    let current = true;
    const timer = window.setTimeout(() => {
      const listing = ftp !== undefined ? api.listFtp(ftp, parent.split("/").filter(Boolean)) :
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
  }, [parent, source, ftp, peer, directory]);

  const fragment = parts?.fragment;
  const suggestions = useMemo(() => {
    if (!entries || fragment === undefined) return [];
    const prefix = fragment.normalize("NFC").toLocaleLowerCase();
    return entries.filter((entry) => (includeFiles || entry.directory) && (showHidden || !entry.hidden || prefix.startsWith(".")) &&
      entry.name.normalize("NFC").toLocaleLowerCase().startsWith(prefix))
      .sort((left, right) => collator.compare(left.name, right.name)).slice(0, 20);
  }, [entries, fragment, includeFiles, showHidden]);
  const hasSuggestions = suggestions.length > 0;
  const current = suggestions[selection];
  const expanded = hasSuggestions && position !== undefined;

  useLayoutEffect(() => {
    const anchor = input.current;
    if (!hasSuggestions || !anchor) return;
    const dialog = anchor.closest("dialog");
    const scroller = anchor.closest(".settings-page-body, .dialog-body");
    const place = () => {
      const bounds = anchor.getBoundingClientRect();
      const area = dialog?.getBoundingClientRect();
      const visible = scroller?.getBoundingClientRect() ?? area;
      if (visible && (bounds.top >= visible.bottom || bounds.bottom <= visible.top)) {
        setPosition(undefined);
        return;
      }
      const above = bounds.top - (area?.top ?? 0) - 8;
      const below = (area?.bottom ?? window.innerHeight) - bounds.bottom - 8;
      const upward = below < 180 && above > below;
      setPosition({ left: bounds.left, width: bounds.width, maxHeight: Math.max(0, Math.min(260, upward ? above : below)),
        ...(upward ? { bottom: window.innerHeight - bounds.top + 4 } : { top: bounds.bottom + 4 }) });
    };
    place();
    scroller?.addEventListener("scroll", place);
    window.addEventListener("resize", place);
    const resize = new ResizeObserver(place);
    resize.observe(anchor);
    if (dialog) resize.observe(dialog);
    return () => {
      resize.disconnect();
      scroller?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, [hasSuggestions]);

  useLayoutEffect(() => {
    if (expanded && current) document.getElementById(popup + "-" + selection)?.scrollIntoView({ block: "nearest" });
  }, [expanded, current, popup, selection]);

  function closeSuggestions() {
    setEditing(false);
    setSelection(-1);
    setPosition(undefined);
  }

  function choose(path: string) {
    closeSuggestions();
    (onCommit ?? onChange)(path);
  }

  function handleKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "Escape" && (expanded || onEscape)) {
      event.preventDefault();
      event.stopPropagation();
      closeSuggestions();
      if (!expanded) onEscape?.();
    } else if (!readOnly && event.key === "Enter" && (onCommit || (expanded && current))) {
      event.preventDefault();
      choose(expanded && current && parts ? parts.parent + current.name : value);
    } else if (expanded && parts && event.key === "Tab") {
      event.preventDefault();
      const entry = current ?? suggestions[0];
      onChange(parts.parent + entry.name + (entry.directory ? parts.separator : ""));
      setSelection(-1);
      if (!entry.directory) closeSuggestions();
    } else if (expanded && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? selection + 1 : selection < 0 ? suggestions.length - 1 : selection - 1;
      setSelection((next + suggestions.length) % suggestions.length);
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

  const list = expanded && parts && (
    <div id={popup} className="path-suggestions" style={position} role="listbox" aria-label={suggestionLabel ?? t("{0} suggestions", label)}>
      {suggestions.map(({ name, directory }, index) => (
        <div key={name} id={popup + "-" + index} role="option" aria-selected={index === selection}
          title={parts.parent + name} onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(parts.parent + name)}>
          {directory ? <Folder aria-hidden="true" /> : <File aria-hidden="true" />}<span>{name}</span>
        </div>
      ))}
    </div>
  );
  const dialog = list ? input.current?.closest("dialog") : null;
  return <div className="path-field">
    <div className="path-input-row">
      <input ref={input} id={id} aria-label={label} value={value} readOnly={readOnly} type="text" required={required}
        role={readOnly ? undefined : "combobox"} aria-autocomplete={readOnly ? undefined : "list"}
        aria-expanded={readOnly ? undefined : expanded} aria-controls={expanded ? popup : undefined}
        aria-activedescendant={expanded && current ? popup + "-" + selection : undefined}
        spellCheck={false} autoComplete="off" data-initial-focus={initialFocus || undefined}
        onFocus={(event) => {
          if (selectOnFocus) event.currentTarget.select();
          if (suggestOnFocus) setEditing(true);
        }} onBlur={closeSuggestions}
        onChange={(event) => {
          onChange(event.target.value);
          setEditing(true);
          setSelection(-1);
        }} onKeyDown={handleKeys} />
      {browse && !readOnly && ftp === undefined && isTauri() &&
        <Button type="button" className="icon-button path-browse" aria-label={browseLabel} disabled={browsing} onClick={() => void pickPath()}>
          <FolderOpen aria-hidden="true" />
        </Button>}
    </div>
    {browseFailed && <div className="path-picker-error" role="alert">{t("Could not open the system picker.")}</div>}
    {dialog ? createPortal(list, dialog) : list}
  </div>;
}
