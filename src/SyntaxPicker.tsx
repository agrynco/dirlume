import { useId, useLayoutEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { t } from "./i18n";
import { languageChoices } from "./syntaxCatalog";

function results(query: string) {
  const choices = [
    { key: "auto", name: t("Automatic"), aliases: [] },
    { key: "plain", name: t("Plain text"), aliases: [] },
    ...languageChoices.map(({ name, alias, extensions }) => ({ key: name, name, aliases: [...alias, ...extensions] })),
  ];
  const search = query.trim().toLocaleLowerCase().replace(/^\./, "");
  if (!search) return choices;
  return choices.flatMap((choice) => {
    const name = choice.name.toLocaleLowerCase();
    const aliases = choice.aliases.map((alias) => alias.toLocaleLowerCase());
    const rank = name === search || aliases.includes(search) ? 0 : name.startsWith(search) ? 1 :
      name.includes(search) || aliases.some((alias) => alias.includes(search)) ? 2 : null;
    return rank === null ? [] : [{ ...choice, rank }];
  }).sort((left, right) => left.rank - right.rank);
}

export default function SyntaxPicker({ syntax, editing, onSelect, onClose }: {
  syntax: string;
  editing: boolean;
  onSelect: (syntax: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState<number | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const choices = results(query);
  const current = highlight ?? Math.max(0, choices.findIndex(({ key }) => key === syntax));
  useLayoutEffect(() => {
    list.current?.querySelectorAll<HTMLElement>("[role=option]")[current]?.scrollIntoView({ block: "nearest" });
  }, [current, query]);

  return <Dialog title={t("Choose syntax")} onClose={onClose} helpTopic={editing ? "editor" : "viewer"} onKeyDown={(event) => {
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onClose();
    }
  }} footer={
    <Button onClick={onClose}>{t("Cancel")}</Button>
  }>
    <div className="syntax-picker">
      <input type="search" aria-label={t("Search syntax")} placeholder={t("Search syntax")} value={query}
        aria-controls={id} aria-activedescendant={choices[current] ? id + "-" + current : undefined}
        data-initial-focus onChange={(event) => {
          setQuery(event.target.value);
          setHighlight(event.target.value.trim() ? 0 : null);
        }} onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            if (choices[current]) onSelect(choices[current].key);
          } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            setHighlight(Math.max(0, Math.min(choices.length - 1, current + (event.key === "ArrowUp" ? -1 : 1))));
          }
        }} />
      <div className="syntax-results" ref={list} id={id} role="listbox" aria-label={t("Syntax")}>
        {choices.map(({ key, name }, index) => <Button type="button" role="option" key={key} id={id + "-" + index}
          tabIndex={-1} aria-selected={key === syntax} data-highlighted={index === current || undefined}
          onClick={() => onSelect(key)}>
          <span>{name}</span>{key === syntax && <Check aria-hidden="true" />}
        </Button>)}
        {!choices.length && <p role="status">{t("No matching syntax")}</p>}
      </div>
    </div>
  </Dialog>;
}
