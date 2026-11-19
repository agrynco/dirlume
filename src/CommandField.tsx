import { useEffect, useId, useLayoutEffect, useState, type KeyboardEvent, type RefObject } from "react";
import { api, windowsClient, type CommandCompletion } from "./api";
import { t } from "./i18n";

type Option = { label: string; text: string; index: number; length: number; history?: boolean };

export function CommandField({ input, draft, directory, history, refreshEnvironment, onChange }: {
  input: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  directory: string | null;
  history: readonly string[];
  refreshEnvironment: boolean;
  onChange: (draft: string) => void;
}) {
  const id = useId();
  const [focused, setFocused] = useState(false);
  const [position, setPosition] = useState(draft.length);
  const [selection, setSelection] = useState<{ query: string; index: number } | null>(null);
  const [dismissed, setDismissed] = useState("");
  const [native, setNative] = useState<{ query: string; result: CommandCompletion } | null>(null);
  const caret = Math.min(position, draft.length);
  const query = JSON.stringify([draft, caret, directory, refreshEnvironment]);
  const selected = selection?.query === query ? selection.index : -1;
  const setSelected = (index: number) => setSelection(index < 0 ? null : { query, index });
  const suggesting = focused && !!draft.trim() && dismissed !== query;

  useEffect(() => {
    if (!suggesting || !directory) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void api.completeCommand(draft, caret, directory, refreshEnvironment).then(
        (result) => { if (current) setNative({ query, result }); },
        () => { if (current) setNative(null); },
      );
    }, 150);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [suggesting, directory, draft, caret, query, refreshEnvironment]);

  const prefix = windowsClient ? draft.toLowerCase() : draft;
  const recent = suggesting && caret === draft.length
    ? [...new Set(history.filter((line) => (windowsClient ? line.toLowerCase() : line).startsWith(prefix)))].slice(0, 5)
    : [];
  const options: Option[] = recent.map((line) => ({ label: line, text: line, index: 0, length: draft.length, history: true }));
  const batch = suggesting && native?.query === query ? native.result : null;
  if (batch && batch.index >= 0 && batch.length >= 0 && batch.index + batch.length <= draft.length) {
    const seen = new Set(recent);
    for (const { label, text } of batch.matches) {
      const result = draft.slice(0, batch.index) + text + draft.slice(batch.index + batch.length);
      if (!label || seen.has(result)) continue;
      seen.add(result);
      options.push({ label, text, index: batch.index, length: batch.length });
    }
  }
  const open = options.length > 0;
  const activeOption = options[selected];

  useLayoutEffect(() => {
    if (open && selected >= 0) document.getElementById(`${id}-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [open, id, query, selected]);

  function dismiss() {
    setDismissed(query);
    setSelected(-1);
  }

  function choose(option: Option) {
    const value = draft.slice(0, option.index) + option.text + draft.slice(option.index + option.length);
    const next = option.index + option.text.length;
    setDismissed(JSON.stringify([value, next, directory, refreshEnvironment]));
    setSelected(-1);
    setPosition(next);
    onChange(value);
    requestAnimationFrame(() => {
      if (document.activeElement === input.current) input.current?.setSelectionRange(next, next);
    });
  }

  function selectCaret(element: HTMLTextAreaElement) {
    const next = element.selectionStart ?? element.value.length;
    if (next !== position) {
      setPosition(next);
      setSelected(-1);
    }
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.shiftKey) {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        event.currentTarget.form?.requestSubmit();
      }
      return;
    }
    if (event.key === "Enter" && (!open || !activeOption)) {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.form?.requestSubmit();
      return;
    }
    if (!open) return;
    if (event.key === "Escape") dismiss();
    else if (event.key === "ArrowDown") setSelected((selected + 1) % options.length);
    else if (event.key === "ArrowUp") setSelected(selected < 0 ? options.length - 1 : (selected - 1 + options.length) % options.length);
    else if (event.key === "Tab") choose(activeOption ?? options[0]);
    else if (event.key === "Enter" && activeOption) choose(activeOption);
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  return <div className="command-entry">
    <textarea ref={input} aria-label={t("Command line")} role="combobox" aria-autocomplete="list" aria-expanded={open}
      aria-controls={open ? id : undefined} aria-activedescendant={activeOption ? `${id}-${selected}` : undefined}
      rows={1} wrap="off" autoFocus autoComplete="off" spellCheck={false} value={draft} placeholder={t("Enter a command")}
      onFocus={(event) => { setFocused(true); setDismissed(""); selectCaret(event.currentTarget); }}
      onBlur={() => { setFocused(false); setSelected(-1); setNative(null); }}
      onSelect={(event) => selectCaret(event.currentTarget)}
      onChange={(event) => {
        setPosition(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
        setDismissed("");
        setSelected(-1);
        onChange(event.currentTarget.value);
      }}
      onKeyDown={keyDown} />
    {open && <div className="command-suggestions" role="listbox" id={id} aria-label={t("Command suggestions")}>
      {options.map((option, index) => <div key={`${option.index}:${option.text}`} id={`${id}-${index}`}
        role="option" aria-selected={index === selected} title={option.label}
        onMouseDown={(event) => event.preventDefault()} onClick={() => choose(option)}>
        <span>{option.label}</span>{option.history && <small>{t("History")}</small>}
      </div>)}
    </div>}
  </div>;
}
