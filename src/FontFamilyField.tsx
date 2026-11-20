import { errorText, t } from "./i18n";
import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { bundledFontFamily, maxFontFamilyLength } from "./appearance";
import { EditableDropdown } from "./EditableDropdown";
import { SettingSearchLabel } from "./SettingSearchLabel";
import { readFieldHistory, rememberFieldValue } from "./HistoryField";

export type InstalledFonts = { families: string[]; error?: string } | null;

export function FontFamilyField({ label, value, fallback, installed, builtIn, onChange }: {
  label: string;
  value: string;
  fallback: string;
  installed: InstalledFonts;
  builtIn: boolean;
  onChange: (family: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLSpanElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [index, setIndex] = useState(-1);
  const [position, setPosition] = useState<CSSProperties>();
  const matches = useMemo(() => {
    const prefix = query?.trim().toLocaleLowerCase();
    const unique = new Map<string, string>();
    for (const family of [...readFieldHistory("font-family"), bundledFontFamily, ...(installed?.families ?? [])]) {
      const key = family.toLocaleLowerCase();
      if (!unique.has(key)) unique.set(key, family);
    }
    const families = [...unique.values()];
    if (!prefix) return families;
    const starts = [];
    const contains = [];
    for (const family of families) {
      const name = family.toLocaleLowerCase();
      if (name.startsWith(prefix)) starts.push(family);
      else if (name.includes(prefix)) contains.push(family);
    }
    return [...starts, ...contains];
  }, [installed, query, open]);
  const expanded = open && position !== undefined;
  const optionId = (index: number) => `${id}-${index}`;

  useLayoutEffect(() => {
    const anchor = field.current;
    const options = anchor?.closest("dialog");
    const scroller = anchor?.closest(".settings-page-body");
    if (!open || !anchor || !options) return;

    const place = () => {
      const bounds = anchor.getBoundingClientRect();
      const dialog = options.getBoundingClientRect();
      const area = scroller?.getBoundingClientRect() ?? dialog;
      if (bounds.top >= area.bottom || bounds.bottom <= area.top) {
        setPosition(undefined);
        return;
      }
      const below = dialog.bottom - bounds.bottom - 8;
      const above = bounds.top - dialog.top - 8;
      const upward = below < 160 && below < above;
      setPosition({
        left: bounds.left, width: bounds.width, maxHeight: Math.min(220, upward ? above : below),
        ...(upward ? { bottom: window.innerHeight - bounds.top + 4 } : { top: bounds.bottom + 4 }),
      });
    };
    place();
    scroller?.addEventListener("scroll", place);
    window.addEventListener("resize", place);
    const resize = new ResizeObserver(place);
    resize.observe(options);
    resize.observe(anchor);
    return () => {
      resize.disconnect();
      scroller?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (expanded && index >= 0) document.getElementById(`${id}-${index}`)?.scrollIntoView({ block: "nearest" });
  }, [expanded, id, index]);

  function close() {
    setOpen(false);
    setQuery(null);
    setIndex(-1);
  }

  function choose(family: string) {
    rememberFieldValue("font-family", family);
    close();
    onChange(family);
  }

  function toggleFonts() {
    input.current?.focus({ preventScroll: true });
    if (open) close();
    else setOpen(true);
  }

  return <div className="font-family" onKeyDown={(event) => {
    if (!open || event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }}>
    <label className="field" htmlFor={`${id}-input`}><SettingSearchLabel label="Font family" aliases={["Installed fonts"]} /></label>
    <EditableDropdown ref={field} trigger={{
      popupId: id, expanded, label: t("Browse installed fonts for {0}", t(label).toLocaleLowerCase()),
      tooltip: t("Browse installed fonts"), onClick: toggleFonts,
    }}>
      <input ref={input} id={`${id}-input`} aria-label={t("{0} font family", t(label))} type="text" role="combobox"
        aria-autocomplete="list" aria-expanded={expanded} aria-controls={expanded ? id : undefined}
        aria-activedescendant={expanded && matches[index] ? optionId(index) : undefined}
        value={builtIn ? query ?? value : value} placeholder={fallback} maxLength={maxFontFamilyLength}
        autoComplete="off" spellCheck={false}
        onChange={(event) => {
          setQuery(event.target.value);
          setIndex(-1);
          setOpen(true);
          if (!builtIn) onChange(event.target.value);
        }}
        onBlur={() => {
          if (builtIn && query?.trim()) choose(query.trim());
          else {
            if (query?.trim()) rememberFieldValue("font-family", query.trim());
            close();
          }
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            if (matches.length) {
              const next = event.key === "ArrowDown" ? index + 1 : index < 0 ? matches.length - 1 : index - 1;
              setIndex((next + matches.length) % matches.length);
            }
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            if (matches[index]) choose(matches[index]);
            else if (builtIn && query?.trim()) choose(query.trim());
            else close();
          }
        }} />
    </EditableDropdown>
    {expanded && <div className="font-suggestions" style={position}>
      <div role="listbox" id={id} aria-label={t("{0} font suggestions", t(label))}>
        {matches.map((family, indexOfFamily) => <div key={family} id={optionId(indexOfFamily)} role="option"
          aria-selected={indexOfFamily === index} data-tooltip={family} onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(family)}>{family}</div>)}
      </div>
      {matches.length === 0 && <div role={installed?.error ? "alert" : "status"} className="font-suggestion-status">
        {installed?.error ? errorText(installed.error) : (installed === null ? t("Loading system fonts…") :
          installed.families.length === 0 ? t("No system fonts available.") : t("No matching fonts."))}
      </div>}
    </div>}
  </div>;
}
