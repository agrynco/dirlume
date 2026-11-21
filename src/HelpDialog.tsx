import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { helpText } from "./helpContent";
import { helpGroups, helpTopics, overviewTopics, type HelpTopic } from "./helpTopics";
import { t, type Language } from "./i18n";
import { commandLabel, defaultBindings, showShortcuts } from "./preferences";
import type { Side } from "./panes";

export default function HelpDialog({ initialTopic, side, language, copyShortcuts, onClose }: {
  initialTopic: HelpTopic;
  side?: Side;
  language: Language;
  copyShortcuts?: readonly string[];
  onClose: () => void;
}) {
  const [topic, setTopic] = useState(initialTopic);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusTopic = useRef(false);

  useLayoutEffect(() => {
    if (focusTopic.current) heading.current?.focus();
  }, [topic]);

  function openTopic(id: HelpTopic) {
    focusTopic.current = true;
    if (id === topic) heading.current?.focus();
    else setTopic(id);
  }

  const paragraphs = helpText[language][topic].split("\n\n");
  return (
    <Dialog title={t("Help")} onClose={onClose} wide contextHelp>
      <div className="help-layout">
        <nav className="help-contents" aria-label={t("Table of contents")}>
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
        <div className="help-reading" key={topic}>
          {helpGroups.flatMap(({ topics }) => topics).map((id) => (
            <section id={`help-${id}`} key={id} hidden={id !== topic} aria-labelledby={`help-heading-${id}`}>
              {id === topic && <>
                <h3 id={`help-heading-${id}`} tabIndex={-1} ref={heading}>{t(helpTopics[id].title)}</h3>
                {topic === "paneSources" && side && <p>{t(side === "left" ?
                  "This control changes the source for the left pane." : "This control changes the source for the right pane.")}</p>}
                {paragraphs.map((paragraph) => {
                  const parts = paragraph.split(/\[\[([a-zA-Z]+)\|([^\]]+)\]\]/g);
                  return <p key={paragraph}>{parts.map((part, index) => index % 3 === 0 ? part : index % 3 === 1 ?
                    <a key={index} href={`#help-${part}`} onClick={(event) => {
                      event.preventDefault();
                      openTopic(part as HelpTopic);
                    }}>{parts[index + 1]}</a> : null)}</p>;
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
