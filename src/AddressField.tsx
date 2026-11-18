import { useEffect, useMemo, useState } from "react";
import { Folder } from "lucide-react";
import { api, placePath, windowsClient, type Entry, type Place } from "./api";
import type { Side } from "./panes";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function splitAddress(value: string, windows: boolean) {
  if (windows && /^[a-z]:$/i.test(value)) {
    return { parent: value + "\\", fragment: "", separator: "\\" };
  }
  if (windows ? !/^(?:[a-z]:[\\/]|[\\/]{2})/i.test(value) : !value.startsWith("/")) return null;
  const end = Math.max(value.lastIndexOf("/"), windows ? value.lastIndexOf("\\") : -1);
  return { parent: value.slice(0, end + 1), fragment: value.slice(end + 1), separator: value[end] };
}

export function AddressField({ side, place, showHidden, onNavigate, focusFiles }: {
  side: Side;
  place: Place | null;
  showHidden: boolean;
  onNavigate: (path: string) => void;
  focusFiles: () => void;
}) {
  const path = place ? placePath(place) : "";
  const ftp = place?.kind === "ftp" ? place.id : undefined;
  const editable = !place || place.kind === "local" || place.kind === "ftp";
  const [draft, setDraft] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [selection, setSelection] = useState(-1);
  const [lookup, setLookup] = useState<{ parent: string; ftp?: number; entries: Entry[] } | null>(null);
  const value = draft ?? path;
  const parts = editable && suggesting ? splitAddress(value, ftp === undefined && windowsClient) : null;
  const parent = parts?.parent;
  const id = side + "-address";
  const popup = id + "-suggestions";
  const entries = lookup && lookup.parent === parent && lookup.ftp === ftp ? lookup.entries : null;

  useEffect(() => {
    setDraft(null);
    setSuggesting(false);
    setSelection(-1);
  }, [path, ftp]);

  useEffect(() => {
    if (!parent) return;
    let current = true;
    const timer = window.setTimeout(() => {
      const listing = ftp === undefined ? api.listLocal(parent) : api.listFtp(ftp, parent.split("/").filter(Boolean));
      void listing.then(({ entries }) => {
        if (current) setLookup({ parent, ftp, entries });
      }, () => {
        if (current) setLookup({ parent, ftp, entries: [] });
      });
    }, 140);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [parent, ftp]);

  const fragment = parts?.fragment;
  const suggestions = useMemo(() => {
    if (!entries || fragment === undefined) return [];
    const prefix = fragment.normalize("NFC").toLocaleLowerCase();
    return entries.filter((entry) => entry.directory && (showHidden || !entry.hidden || prefix.startsWith(".")) &&
      entry.name.normalize("NFC").toLocaleLowerCase().startsWith(prefix))
      .sort((left, right) => collator.compare(left.name, right.name)).slice(0, 20);
  }, [entries, fragment, showHidden]);

  const current = suggestions[selection];
  useEffect(() => {
    if (current) document.getElementById(popup + "-" + selection)?.scrollIntoView({ block: "nearest" });
  }, [current, popup, selection]);

  function closeSuggestions() {
    setSuggesting(false);
    setSelection(-1);
  }

  function navigate(address: string) {
    closeSuggestions();
    if (address !== path) {
      setDraft(address);
      onNavigate(address);
      focusFiles();
    }
  }

  const expanded = suggestions.length > 0;
  return (
    <form className="address" onSubmit={(event) => {
      event.preventDefault();
      if (editable) navigate(current && parts ? parts.parent + current.name : value);
    }}>
      <input id={id} aria-label={side + " path"} value={value} readOnly={!editable} type="text"
        role={editable ? "combobox" : undefined} aria-autocomplete={editable ? "list" : undefined}
        aria-expanded={editable ? expanded : undefined} aria-controls={expanded ? popup : undefined}
        aria-activedescendant={current ? popup + "-" + selection : undefined}
        spellCheck={false} autoComplete="off" onFocus={() => { if (draft !== null) setSuggesting(true); }}
        onBlur={closeSuggestions}
        onChange={(event) => {
          setDraft(event.target.value);
          setSuggesting(true);
          setSelection(-1);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            if (expanded) closeSuggestions();
            else {
              setDraft(null);
              closeSuggestions();
              focusFiles();
            }
          } else if (expanded && parts && event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
            event.preventDefault();
            setDraft(parts.parent + (current ?? suggestions[0]).name + parts.separator);
            setSelection(-1);
          } else if (expanded && (event.key === "ArrowDown" || event.key === "ArrowUp") &&
              !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
            event.preventDefault();
            const next = event.key === "ArrowDown" ? selection + 1 : selection < 0 ? suggestions.length - 1 : selection - 1;
            setSelection((next + suggestions.length) % suggestions.length);
          }
        }} />
      {parts && expanded && (
        <div id={popup} className="address-suggestions" role="listbox" aria-label={side + " path suggestions"}>
          {suggestions.map(({ name }, index) => (
            <div key={name} id={popup + "-" + index} role="option" aria-selected={index === selection}
              title={parts.parent + name} onMouseDown={(event) => event.preventDefault()}
              onClick={() => navigate(parts.parent + name)}><Folder aria-hidden="true" /><span>{name}</span></div>
          ))}
        </div>
      )}
    </form>
  );
}
