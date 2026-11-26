import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { countText, t } from "./i18n";
import { helpIsOpen } from "./contextHelp";
import type { Side } from "./panes";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

export function useQuickSearch(side: Side, enabled = true) {
  const [query, setQuery] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const pane = document.getElementById(`${side}-pane`);
    const open = (event: Event) => setQuery((event as CustomEvent<string>).detail);
    pane?.addEventListener("dirlume-quick-search", open);
    return () => pane?.removeEventListener("dirlume-quick-search", open);
  }, [enabled, side]);
  return [query, setQuery] as const;
}

type Match = { id: string; name: string };

export function QuickSearch({ side, query, items, current, onChange, onMatch, onAccept, onClose, focusList, fileNames = false }: {
  side: Side;
  query: string;
  items: Match[];
  current: string | null | undefined;
  onChange: (value: string) => void;
  onMatch: (id: string) => void;
  onAccept: (id: string) => void;
  onClose: () => void;
  focusList: () => void;
  fileNames?: boolean;
}) {
  const field = useRef<HTMLInputElement>(null);
  const lastQuery = useRef<string>(null);
  const [resultsOpen, setResultsOpen] = useState(false);
  const id = `${side}-quick-search`;
  const matches = useMemo(() => {
    if (!query) return [];
    const needle = query.normalize("NFC").toLocaleLowerCase();
    const prefixes: Match[] = [];
    const substrings: Match[] = [];
    for (const item of items) {
      const name = item.name.normalize("NFC").toLocaleLowerCase();
      if (name.startsWith(needle)) prefixes.push(item);
      else if (fileNames && name.includes(needle)) substrings.push(item);
    }
    return prefixes.concat(substrings);
  }, [fileNames, items, query]);
  const currentIndex = matches.findIndex(({ id }) => id === current);
  const showResults = fileNames && matches.length > 0;
  const status = query ? (matches.length ? countText(matches.length, "match") : t("No match")) : "";

  useLayoutEffect(() => {
    const input = field.current;
    input?.focus();
    if (input) input.setSelectionRange(input.value.length, input.value.length);
  }, []);

  useEffect(() => {
    const changed = lastQuery.current !== query;
    lastQuery.current = query;
    if (matches[0] && (currentIndex < 0 || (fileNames && changed && currentIndex !== 0))) onMatch(matches[0].id);
  }, [currentIndex, fileNames, matches, onMatch, query]);

  function closeAndFocus() {
    onClose();
    focusList();
  }

  return <div className="quick-search" onBlur={(event) => {
    if (!resultsOpen && !event.currentTarget.contains(event.relatedTarget) && !helpIsOpen()) onClose();
  }}>
    <label htmlFor={id}>{t("Quick search")}</label>
    <input id={id} ref={field} type="text" value={query} spellCheck={false} autoComplete="off"
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape" || event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          const match = matches[Math.max(0, currentIndex)];
          if (event.key === "Enter" && !match) return;
          closeAndFocus();
          if (event.key === "Enter") onAccept(match.id);
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          if (!matches.length) return;
          const offset = event.key === "ArrowDown" ? 1 : -1;
          const next = (Math.max(0, currentIndex) + offset + matches.length) % matches.length;
          onMatch(matches[next].id);
        }
      }} />
    <span role="status" className={showResults ? "quick-search-announcement" : undefined}>{status}</span>
    {showResults && <Button type="button" aria-haspopup="dialog" onPointerDown={(event) => {
      if (event.button === 0) event.preventDefault();
    }} onClick={() => setResultsOpen(true)} onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeAndFocus();
    }}>{status}</Button>}
    {resultsOpen && showResults && <Dialog title={t("Quick search results")} onClose={() => setResultsOpen(false)} helpTopic="search"
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const row = (event.target as HTMLElement).closest("tbody tr");
        if (!row) return;
        event.preventDefault();
        const adjacent = event.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling;
        adjacent?.querySelector("button")?.focus();
      }}>
      <table className="quick-search-results">
        <thead><tr><th scope="col">{t("Name")}</th></tr></thead>
        <tbody>
          {matches.map((match) => <tr key={match.id}>
            <td><Button type="button" dir="auto" data-initial-focus={match.id === current || undefined} onClick={() => {
              onMatch(match.id);
              onClose();
              requestAnimationFrame(focusList);
            }}>{match.name}</Button></td>
          </tr>)}
        </tbody>
      </table>
    </Dialog>}
  </div>;
}
