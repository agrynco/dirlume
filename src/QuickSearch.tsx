import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { countText, t } from "./i18n";
import type { Side } from "./panes";

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

export function QuickSearch({ side, query, items, current, onChange, onMatch, onAccept, onClose, focusList }: {
  side: Side;
  query: string;
  items: Match[];
  current: string | null | undefined;
  onChange: (value: string) => void;
  onMatch: (id: string) => void;
  onAccept: (id: string) => void;
  onClose: () => void;
  focusList: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const id = `${side}-quick-search`;
  const matches = useMemo(() => {
    if (!query) return [];
    const prefix = query.normalize("NFC").toLocaleLowerCase();
    return items.filter(({ name }) => name.normalize("NFC").toLocaleLowerCase().startsWith(prefix));
  }, [items, query]);
  const currentIndex = matches.findIndex(({ id }) => id === current);

  useLayoutEffect(() => {
    const input = field.current;
    input?.focus();
    if (input) input.setSelectionRange(input.value.length, input.value.length);
  }, []);

  useEffect(() => {
    if (currentIndex < 0 && matches[0]) onMatch(matches[0].id);
  }, [currentIndex, matches, onMatch]);

  return <div className="quick-search">
    <label htmlFor={id}>{t("Quick search")}</label>
    <input id={id} ref={field} type="text" value={query} spellCheck={false} autoComplete="off"
      onChange={(event) => onChange(event.target.value)} onBlur={onClose}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape" || event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          const match = matches[Math.max(0, currentIndex)];
          if (event.key === "Enter" && !match) return;
          onClose();
          focusList();
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
    <span role="status">{query ? (matches.length ? countText(matches.length, "match") : t("No match")) : ""}</span>
  </div>;
}
