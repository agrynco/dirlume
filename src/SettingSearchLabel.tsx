import { createContext, useContext } from "react";
import { t } from "./i18n";

export const SettingsSearchTerms = createContext<readonly string[]>([]);

export function matchesSettings(terms: readonly string[], labels: readonly string[]) {
  const text = [...labels, ...labels.map((label) => t(label))].join(" ").toLocaleLowerCase();
  return terms.every((term) => text.includes(term));
}

export function SettingSearchLabel({ label, aliases = [] }: { label: string; aliases?: readonly string[] }) {
  const terms = useContext(SettingsSearchTerms);
  const text = t(label);
  if (!terms.length || !matchesSettings(terms, [label, ...aliases])) return <span>{text}</span>;

  const visible = text.toLocaleLowerCase();
  const matched = terms.filter((term) => visible.includes(term));
  const pattern = [...new Set(matched)].sort((left, right) => right.length - left.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const parts = pattern ? text.split(new RegExp(`(${pattern})`, "iu")) : [text];
  return <span className={matched.length < terms.length ? "setting-search-alias" : undefined}>
    {parts.map((part, index) => index % 2 ? <mark className="setting-search-text" key={index}>{part}</mark> : part)}
  </span>;
}
