import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, WrapText } from "lucide-react";
import { api, type GitBlameLine, type GitFileBlame } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { t } from "./i18n";
import { useTimestamps } from "./useTimestamps";

const messages = {
  empty: "This file has no lines.",
  missing: "File absent at this revision.",
  binary: "This revision contains binary data.",
  oversized: "This file revision exceeds the preview limit.",
};

export function GitBlameViewer({ root, revision, path, onClose, renderDetails }: {
  root: string;
  revision: string;
  path: string;
  onClose: () => void;
  renderDetails: (line: GitBlameLine) => ReactNode;
}) {
  const [blame, setBlame] = useState<GitFileBlame>();
  const [error, setError] = useState(false);
  const [wrapped, setWrapped] = useState(true);
  const [selected, setSelected] = useState(1);
  const [origin, setOrigin] = useState<GitBlameLine>();
  const scroll = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ button: HTMLButtonElement; top: number; left: number }>(null);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let active = true;
    void api.gitFileBlame(root, revision, path).then((result) => { if (active) setBlame(result); },
      () => { if (active) setError(true); });
    return () => { active = false; };
  }, [root, revision, path]);
  useLayoutEffect(() => {
    if (origin) { back.current?.focus(); return; }
    if (anchor.current && scroll.current) {
      const { button, top, left } = anchor.current;
      scroll.current.scrollTo(left, top);
      button.focus({ preventScroll: true });
      anchor.current = null;
    }
  }, [origin]);
  const lines = blame?.content.state === "available" ? blame.content.lines : [];
  const formatDate = useTimestamps(lines.map(({ time }) => time), "date");
  function moveFocus(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const next = event.key === "ArrowDown" ? Math.min(lines.length, selected + 1) :
      event.key === "ArrowUp" ? Math.max(1, selected - 1) : event.key === "Home" ? 1 : event.key === "End" ? lines.length : null;
    if (next === null) return;
    event.preventDefault();
    scroll.current?.querySelector<HTMLElement>(`[data-blame-line="${next}"] button`)?.focus();
  }
  return <Dialog title={t("Git blame · Text Viewer")} wide resizeKey="git-blame" helpTopic="viewer"
    onClose={origin ? () => setOrigin(undefined) : onClose}
    footer={<Button onClick={onClose}>{t("Close")}</Button>}>
    <section className="text-window git-blame-viewer" data-editing="false" data-text-surface="viewer" data-help-topic="viewer"
      aria-label={t("Blame")}>
      <header className="git-blame-heading document-heading">
        <strong>{blame?.path ?? path}</strong>
        <span><code title={blame?.revision ?? revision}>{(blame?.revision ?? revision).slice(0, 12)}</code> · {t("Committed revision")}</span>
        {!origin && <Button className="git-action" aria-pressed={wrapped} tooltip={t("Wrap lines")} onClick={() => setWrapped(!wrapped)}>
          <WrapText aria-hidden="true" />{t("Wrap lines")}
        </Button>}
      </header>
      {error && <p className="git-file-feedback" role="alert">{t("Could not read blame for this path at the selected revision.")}</p>}
      {!blame && !error && <p className="git-file-feedback" role="status">{t("Reading change…")}</p>}
      {blame && blame.content.state !== "available" && <p className="git-file-feedback">{t(messages[blame.content.state])}</p>}
      {blame?.content.state === "available" && <div ref={scroll} className="git-blame-lines" hidden={!!origin}
        data-wrap={wrapped} aria-label={t("Line attribution")}>
        {lines.map((line) => <div key={line.number} className="git-blame-line" data-blame-line={line.number}>
          <Button type="button" className="git-blame-attribution" tabIndex={selected === line.number ? 0 : -1}
            aria-label={t("Show commit details for line {0}: {1} · {2}", line.number, line.author, line.hash.slice(0, 12))}
            onKeyDown={moveFocus} onFocus={() => setSelected(line.number)} onClick={({ currentTarget }) => {
              if (scroll.current) anchor.current = { button: currentTarget, top: scroll.current.scrollTop, left: scroll.current.scrollLeft };
              setOrigin(line);
            }}>
            <strong>{line.author}</strong><small>{formatDate(line.time)} · <code title={line.hash}>{line.hash.slice(0, 10)}</code></small>
          </Button>
          <span className="git-blame-number" aria-hidden="true">{line.number}</span>
          <code className="git-blame-text">{line.text || " "}</code>
        </div>)}
      </div>}
      {origin && <div className="git-blame-detail">
        <Button className="git-action" ref={back} onClick={() => setOrigin(undefined)}>
          <ArrowLeft aria-hidden="true" />{t("Back to line {0}", origin.number)}
        </Button>
        <p className="git-blame-origin"><code>{origin.path}</code> · {t("Line {0}", origin.original)}</p>
        {renderDetails(origin)}
      </div>}
    </section>
  </Dialog>;
}
