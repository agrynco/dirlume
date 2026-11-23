import { useLayoutEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { helpText } from "./helpContent";
import { helpGroups, helpTopics, overviewTopics, type HelpTopic } from "./helpTopics";
import { t, type Language } from "./i18n";
import { bindingMatches, commandLabel, defaultBindings, eventShortcut, showShortcuts } from "./preferences";
import type { Side } from "./panes";

const topicLinks = /\[\[([a-zA-Z]+)\|([^\]]+)\]\]/g;
const topicIds = helpGroups.flatMap(({ topics }) => topics);
type Match = { paragraph: number; start: number; end: number };
type Passage = { topic: HelpTopic; match?: Match };
type SearchResult = Passage & { title: string; titleMatch: boolean; snippet: string };

function snippet(text: string, match?: RegExpExecArray | null) {
  const matchStart = match?.index ?? 0;
  const matchEnd = matchStart + (match?.[0].length ?? 0);
  let start = Math.max(0, matchStart - 30);
  let end = Math.min(text.length, Math.max(start + 120, matchEnd + 24));
  const nextSpace = text.indexOf(" ", start);
  const previousSpace = text.lastIndexOf(" ", end);
  if (start && nextSpace !== -1 && nextSpace < matchStart) start = nextSpace + 1;
  if (end < text.length && previousSpace > matchEnd) end = previousSpace;
  return (start ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
}

function searchTopics(language: Language, query: string) {
  const words = query.trim().split(/\s+/);
  const phrase = new RegExp(words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "iu");
  const results = topicIds.flatMap<SearchResult>((topic) => {
    const title = t(helpTopics[topic].title);
    const titleMatch = phrase.test(title);
    const paragraphs = helpText[language][topic].split("\n\n").map((text) => text.replace(topicLinks, "$2"));
    for (const [paragraph, text] of paragraphs.entries()) {
      const match = phrase.exec(text);
      if (match) return [{ topic, title, titleMatch, snippet: snippet(text, match),
        match: { paragraph, start: match.index, end: match.index + match[0].length } }];
    }
    return titleMatch ? [{ topic, title, titleMatch, snippet: snippet(paragraphs[0]) }] : [];
  });
  return results.sort((left, right) => Number(right.titleMatch) - Number(left.titleMatch));
}

export default function HelpDialog({ initialTopic, side, language, copyShortcuts, searchShortcuts, onClose }: {
  initialTopic: HelpTopic;
  side?: Side;
  language: Language;
  copyShortcuts?: readonly string[];
  searchShortcuts: readonly string[];
  onClose: () => void;
}) {
  const [passage, setPassage] = useState<Passage>({ topic: initialTopic });
  const [query, setQuery] = useState("");
  const topic = passage.topic;
  const searching = !!query.trim();
  const results = searching ? searchTopics(language, query) : [];
  const input = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const match = useRef<HTMLParagraphElement>(null);
  const focusPassage = useRef(false);

  useLayoutEffect(() => {
    if (!focusPassage.current) return;
    focusPassage.current = false;
    const target = match.current ?? heading.current;
    target?.focus({ preventScroll: true });
    (match.current?.querySelector("mark") ?? target)?.scrollIntoView({ block: "start", inline: "nearest" });
  }, [passage]);

  function openTopic(topic: HelpTopic, match?: Match) {
    focusPassage.current = true;
    setPassage({ topic, match });
  }

  const paragraphs = helpText[language][topic].split("\n\n");
  return (
    <Dialog title={t("Help")} onClose={onClose} wide contextHelp onKeyDown={(event) => {
      if (event.defaultPrevented || event.nativeEvent.isComposing) return;
      if (event.key === "Escape" && event.target === input.current) {
        event.preventDefault();
        onClose();
        return;
      }
      if (!bindingMatches(searchShortcuts, eventShortcut(event))) return;
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
    }}>
      <div className="help-layout">
        <div className="help-sidebar">
          <form className="help-search" role="search" aria-label={t("Search Help")} onSubmit={(event) => {
            event.preventDefault();
            if (results[0]) openTopic(results[0].topic, results[0].match);
          }}>
            <label htmlFor="help-search">{t("Search Help")}</label>
            <div className="help-search-field">
              <Search aria-hidden="true" />
              <input id="help-search" ref={input} type="search" value={query}
                onChange={(event) => setQuery(event.target.value)} autoComplete="off" />
              {query && <Button type="button" className="icon-button" aria-label={t("Clear Help search")} onClick={() => {
                setQuery("");
                input.current?.focus();
              }}><X aria-hidden="true" /></Button>}
            </div>
          </form>
          {searching && <section className="help-contents help-results" aria-label={t("Help search results")}>
            <p role="status">{results.length ? t("Help topics found: {0}", results.length) : t("No matching Help topics.")}</p>
            <ul>
              {results.map((result) => <li key={result.topic}>
                <a href={`#help-${result.topic}`} aria-current={topic === result.topic ? "location" : undefined}
                  onClick={(event) => { event.preventDefault(); openTopic(result.topic, result.match); }}>
                  <strong>{result.title}</strong>
                  <span>{result.snippet}</span>
                </a>
              </li>)}
            </ul>
          </section>}
          <nav className="help-contents" aria-label={t("Table of contents")} hidden={searching}>
            <h3>{t("Table of contents")}</h3>
            {helpGroups.map(({ title, topics }) => (
              <div className="help-topic-group" key={topics[0]}>
                {title && <h4>{t(title)}</h4>}
                {topics.map((id) => <a key={id} href={`#help-${id}`} aria-current={topic === id ? "location" : undefined}
                  data-initial-focus={id === initialTopic ? true : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    openTopic(id);
                  }}>{t(helpTopics[id].title)}</a>)}
              </div>
            ))}
          </nav>
        </div>
        <div className="help-reading" key={topic}>
          {topicIds.map((id) => (
            <section id={`help-${id}`} key={id} hidden={id !== topic} aria-labelledby={`help-heading-${id}`}>
              {id === topic && <>
                <h3 id={`help-heading-${id}`} tabIndex={-1} ref={heading}>{t(helpTopics[id].title)}</h3>
                {topic === "paneSources" && side && <p>{t(side === "left" ?
                  "This control changes the source for the left pane." : "This control changes the source for the right pane.")}</p>}
                {paragraphs.map((paragraph, index) => {
                  const parts = paragraph.split(topicLinks);
                  const hit = passage.match?.paragraph === index ? passage.match : undefined;
                  let offset = 0;
                  return <p key={index} tabIndex={hit ? -1 : undefined} ref={hit ? match : undefined}
                    data-help-match={!!hit || undefined}>{parts.map((part, index) => {
                      if (index % 3 === 2) return null;
                      const linked = index % 3 === 1;
                      const label = linked ? parts[index + 1] : part;
                      const start = Math.max(0, (hit?.start ?? 0) - offset);
                      const end = Math.min(label.length, (hit?.end ?? 0) - offset);
                      offset += label.length;
                      const text = start < end ?
                        <>{label.slice(0, start)}<mark>{label.slice(start, end)}</mark>{label.slice(end)}</> : label;
                      return linked ? <a key={index} href={`#help-${part}`} onClick={(event) => {
                        event.preventDefault();
                        openTopic(part as HelpTopic);
                      }}>{text}</a> : <span key={index}>{text}</span>;
                    })}</p>;
                })}
                {id === "terminalShortcuts" && !!copyShortcuts?.length && <p>{t("Configured file Copy shortcut: {0}.", showShortcuts(copyShortcuts))}</p>}
                {overviewTopics[id] && <ul className="help-related">
                  {overviewTopics[id].map((related) => <li key={related}><a href={`#help-${related}`} onClick={(event) => {
                    event.preventDefault();
                    openTopic(related);
                  }}>{t(helpTopics[related].title)}</a></li>)}
                </ul>}
                {helpTopics[id].keys.length > 0 && <>
                  <h4>{t("Default shortcuts")}</h4>
                  <dl className="help-keys">
                    {helpTopics[id].keys.map((command) => (
                      <div key={command}>
                        <dt><kbd>{showShortcuts(defaultBindings[command])}</kbd></dt>
                        <dd>{commandLabel(command)}</dd>
                      </div>
                    ))}
                  </dl>
                </>}
              </>}
            </section>
          ))}
        </div>
      </div>
      <footer className="dialog-footer"><Button type="button" onClick={onClose}>{t("Close")}</Button></footer>
    </Dialog>
  );
}
