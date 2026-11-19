import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { helpGroups, helpText, helpTopics, type HelpTopic } from "./helpContent";
import { t, type Language } from "./i18n";
import { commandLabel, defaultBindings, showShortcuts } from "./preferences";

export type { HelpTopic } from "./helpContent";

export function HelpDialog({ initialTopic, language, onClose }: {
  initialTopic: HelpTopic;
  language: Language;
  onClose: () => void;
}) {
  const [topic, setTopic] = useState(initialTopic);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusTopic = useRef(false);

  useLayoutEffect(() => {
    if (focusTopic.current) heading.current?.focus();
  }, [topic]);

  return (
    <Dialog title={t("Help")} onClose={onClose} wide>
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
                  focusTopic.current = true;
                  if (id === topic) heading.current?.focus();
                  else setTopic(id);
                }}>{t(helpTopics[id].title)}</a>)}
            </div>
          ))}
        </nav>
        <div className="help-reading" key={topic}>
          {helpGroups.flatMap(({ topics }) => topics).map((id) => (
            <section id={`help-${id}`} key={id} hidden={id !== topic} aria-labelledby={`help-heading-${id}`}>
              {id === topic && <>
                <h3 id={`help-heading-${id}`} tabIndex={-1} ref={heading}>{t(helpTopics[id].title)}</h3>
                <p>{helpText[language][id]}</p>
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
