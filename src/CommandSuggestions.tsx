import type { CSSProperties } from "react";
import { Folder } from "lucide-react";
import type { CommandCompletion } from "./api";
import { t } from "./i18n";

export type CommandSuggestion = { label: string; text: string; index: number; length: number; history?: boolean; directory?: boolean };

export function commandSuggestions(draft: string, history: readonly string[], batch?: CommandCompletion | null) {
  const recent = batch?.exclusive ? [] : history;
  const options: CommandSuggestion[] = recent.map((line) => ({ label: line, text: line, index: 0, length: draft.length, history: true }));
  if (!batch || batch.index < 0 || batch.length < 0 || batch.index + batch.length > draft.length) return options;
  const seen = new Set(recent);
  for (const { label, text, directory } of batch.matches) {
    const result = draft.slice(0, batch.index) + text + draft.slice(batch.index + batch.length);
    if (!label || seen.has(result)) continue;
    seen.add(result);
    options.push({ label, text, index: batch.index, length: batch.length, directory });
  }
  return options;
}

export function moveSuggestion(key: string, index: number, count: number) {
  if (key === "ArrowDown") return (index + 1) % count;
  return index < 0 ? count - 1 : (index - 1 + count) % count;
}

export function CommandSuggestions({ id, options, selected, choose, style }: {
  id: string;
  options: readonly CommandSuggestion[];
  selected: number;
  choose: (option: CommandSuggestion) => void;
  style?: CSSProperties;
}) {
  return <div className="command-suggestions" role="listbox" id={id} aria-label={t("Command suggestions")} style={style}>
    {options.map((option, index) => <div key={`${option.index}:${option.text}`} id={`${id}-${index}`}
      role="option" aria-selected={index === selected} data-tooltip={option.label}
      onMouseDown={(event) => event.preventDefault()} onClick={() => choose(option)}>
      <span className="command-suggestion-label">{option.directory && <Folder aria-hidden="true" />}{option.label}</span>
      {option.history && <small>{t("History")}</small>}
    </div>)}
    {!options.length && <div className="history-empty" role="status">{t("No previous entries.")}</div>}
  </div>;
}
