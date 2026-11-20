import { useId, useLayoutEffect, useRef, useState, type ComponentPropsWithRef, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { EditableDropdown } from "./EditableDropdown";
import { t } from "./i18n";

const prefix = "dirlume.field-history.";
const historyLimit = 30;

export function readFieldHistory(key: string): string[] {
  try {
    const entries: unknown = JSON.parse(localStorage.getItem(prefix + key) ?? "[]");
    return Array.isArray(entries) ? entries.filter((entry) => typeof entry === "string").slice(0, historyLimit) : [];
  } catch {
    return [];
  }
}

export function rememberFieldValue(key: string, value: string) {
  if (!value.trim() || value.length > 4096) return;
  try {
    const entries = readFieldHistory(key).filter((entry) => entry !== value);
    localStorage.setItem(prefix + key, JSON.stringify([value, ...entries].slice(0, historyLimit)));
  } catch { /* An unavailable history does not prevent editing. */ }
}

export function matchingFieldHistory(entries: string[], value: string) {
  const query = value.toLocaleLowerCase();
  return entries.filter((entry) => entry !== value && entry.toLocaleLowerCase().startsWith(query));
}

export function useSuggestionPosition(anchor: RefObject<HTMLElement | null>, open: boolean) {
  const [position, setPosition] = useState<CSSProperties>();
  useLayoutEffect(() => {
    const element = anchor.current;
    if (!open || !element) return;
    const dialog = element.closest("dialog");
    const place = (event?: Event) => {
      if (event?.target instanceof Element && event.target.matches(".path-suggestions")) return;
      const bounds = element.getBoundingClientRect();
      const area = dialog?.getBoundingClientRect();
      const visible = element.closest(".settings-page-body, .dialog-body")?.getBoundingClientRect() ?? area;
      if (visible && (bounds.top >= visible.bottom || bounds.bottom <= visible.top)) {
        setPosition(undefined);
        return;
      }
      const above = bounds.top - (area?.top ?? 0) - 8;
      const below = (area?.bottom ?? window.innerHeight) - bounds.bottom - 8;
      const upward = below < 180 && above > below;
      const width = Math.min(window.innerWidth - 16, Math.max(bounds.width, 160));
      setPosition({ left: Math.min(bounds.left, window.innerWidth - width - 8), width,
        maxHeight: Math.max(0, Math.min(260, upward ? above : below)),
        ...(upward ? { bottom: window.innerHeight - bounds.top + 4 } : { top: bounds.bottom + 4 }) });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    const resize = new ResizeObserver(() => place());
    resize.observe(element);
    if (dialog) resize.observe(dialog);
    return () => {
      resize.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor, open]);
  return open ? position : undefined;
}

type HistoryFieldProps = Omit<ComponentPropsWithRef<"input">, "value" | "onChange"> & {
  historyKey: string;
  value: string;
  onValueChange: (value: string) => void;
};

export function HistoryField({ historyKey, value, ref, onValueChange, onKeyDown, onBlur, ...props }: HistoryFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLSpanElement>(null);
  const edited = useRef(false);
  const id = useId();
  const [mode, setMode] = useState<"history" | "matches">();
  const [selection, setSelection] = useState(-1);
  const entries = mode ? readFieldHistory(historyKey) : [];
  const matches = mode === "matches" ? matchingFieldHistory(entries, value) : entries;
  const position = useSuggestionPosition(field, mode === "history" || matches.length > 0);
  const expanded = position !== undefined;
  const optionId = (index: number) => id + "-" + index;

  useLayoutEffect(() => {
    if (expanded && selection >= 0) document.getElementById(id + "-" + selection)?.scrollIntoView({ block: "nearest" });
  }, [expanded, id, selection]);

  function close() {
    setMode(undefined);
    setSelection(-1);
  }

  function save(current: string) {
    if (edited.current) rememberFieldValue(historyKey, current);
    edited.current = false;
  }

  function choose(entry: string) {
    edited.current = true;
    onValueChange(entry);
    input.current?.focus({ preventScroll: true });
    close();
  }

  function toggleHistory() {
    input.current?.focus({ preventScroll: true });
    if (mode === "history") close();
    else { setMode("history"); setSelection(-1); }
  }

  const trigger = props.disabled || props.readOnly ? undefined : { popupId: id, expanded, onClick: toggleHistory };
  return <EditableDropdown className="history-field" ref={field} trigger={trigger}>
    <input {...props} ref={(element) => {
      input.current = element;
      if (typeof ref === "function") return ref(element);
      if (ref) ref.current = element;
    }} value={value} autoComplete="off" aria-autocomplete="list" aria-controls={expanded ? id : undefined}
      data-history-open={expanded || undefined}
      aria-activedescendant={expanded && matches[selection] ? optionId(selection) : undefined}
      onChange={(event) => {
        edited.current = true;
        setSelection(-1);
        setMode(event.target.value ? "matches" : undefined);
        onValueChange(event.target.value);
      }} onBlur={(event) => {
        save(event.currentTarget.value);
        close();
        onBlur?.(event);
      }} onKeyDown={(event) => {
        const { key } = event;
        if (!event.nativeEvent.isComposing && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
          if (event.altKey && key === "ArrowDown") {
            setMode("history");
            setSelection(-1);
          } else if (event.altKey) {
            onKeyDown?.(event);
            return;
          } else if (expanded && key === "Escape") close();
          else if (expanded && matches.length && (key === "ArrowDown" || key === "ArrowUp")) {
            const offset = key === "ArrowDown" ? 1 : -1;
            const start = selection < 0 && offset === -1 ? 0 : selection;
            setSelection((start + offset + matches.length) % matches.length);
          } else if (expanded && key === "Enter" && matches[selection]) choose(matches[selection]);
          else {
            if (key === "Enter") save(event.currentTarget.value);
            onKeyDown?.(event);
            return;
          }
          event.preventDefault();
          event.stopPropagation();
        } else onKeyDown?.(event);
      }} />
    {expanded && createPortal(
      <div id={id} role="listbox" className="path-suggestions"
        style={position} aria-label={t("Entry history")}>
        {matches.map((entry, index) => <div key={entry} id={optionId(index)} role="option" aria-selected={index === selection}
          data-tooltip={entry} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(entry)}>
          <span>{entry}</span>
        </div>)}
        {!matches.length && <div className="history-empty" role="status">{t("No previous entries.")}</div>}
      </div>, field.current?.closest("dialog") ?? document.body)}
  </EditableDropdown>;
}
