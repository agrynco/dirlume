import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LoaderCircle, X } from "lucide-react";
import { api, describeError, placePath, type Place } from "./api";
import { Button } from "./Button";
import { errorText, locale, t } from "./i18n";
import { childPlace, type Side } from "./panes";

type Outcome = { kind: "pending" } | { kind: "sent" } | { kind: "failed"; error: string };
export type FileOpenAttempt = {
  id: number;
  side: Side;
  name: string;
  path: string;
  time: number;
  outcome: Outcome;
};

const historyLimit = 100;
const acknowledgmentTime = 2_000;

export function useFileOpens() {
  const [history, setHistory] = useState<FileOpenAttempt[]>([]);
  const [notices, setNotices] = useState<FileOpenAttempt[]>([]);
  const pending = useRef(new Set<string>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const nextId = useRef(0);

  useEffect(() => {
    const scheduled = timers.current;
    return () => { for (const timer of scheduled) clearTimeout(timer); };
  }, []);

  function dismiss(id: number) {
    setNotices((current) => current.filter((attempt) => attempt.id !== id));
  }

  async function openFile(side: Side, directory: Extract<Place, { kind: "local" }>, name: string) {
    const path = placePath(childPlace(directory, name));
    if (pending.current.has(path)) return;
    pending.current.add(path);
    const attempt: FileOpenAttempt = { id: ++nextId.current, side, name, path, time: Date.now(), outcome: { kind: "pending" } };
    setHistory((current) => [attempt, ...current].slice(0, historyLimit));
    setNotices((current) => [...current.filter((notice) => notice.path !== path), attempt]);

    let outcome: Outcome;
    try {
      await api.operate(directory.path, { kind: "open", name });
      outcome = { kind: "sent" };
    } catch (error) {
      outcome = { kind: "failed", error: describeError(error) };
    } finally {
      pending.current.delete(path);
    }
    const complete = (current: FileOpenAttempt[]) => current.map((entry) => entry.id === attempt.id ? { ...entry, outcome } : entry);
    setHistory(complete);
    setNotices((current) => complete(outcome.kind === "failed"
      ? current.filter((notice) => notice.side !== side || notice.outcome.kind !== "failed") : current));
    if (outcome.kind === "sent") {
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        dismiss(attempt.id);
      }, acknowledgmentTime);
      timers.current.add(timer);
    }
  }

  return { history, notices, openFile, dismiss };
}

export function FileOpenFeedback({ attempts, onDismiss }: { attempts: readonly FileOpenAttempt[]; onDismiss: (id: number) => void }) {
  if (!attempts.length) return null;
  return <div className="pane-file-open-notices">{attempts.map(({ id, name, path, outcome }) => outcome.kind === "failed"
    ? <div key={id} className="pane-error" data-help-topic="paneStatus">
      <span role="alert">{t("Could not open {0}. {1}", name, errorText(outcome.error))}</span>
      <Button type="button" className="icon-button" aria-label={t("Dismiss error")} onClick={() => onDismiss(id)}><X /></Button>
    </div>
    : <div key={id} className="pane-file-open" role="status" data-help-topic="paneStatus" data-tooltip={path}>
      {outcome.kind === "pending" ? <><LoaderCircle className="spin" aria-hidden="true" /><span>{t("Opening {0}…", name)}</span></> :
        <><span>{t("Open request sent to the system")}</span><span dir="auto">{name}</span></>}
    </div>)}</div>;
}

export function FileOpensTerminal({ history, onBack, onClose }: {
  history: readonly FileOpenAttempt[]; onBack: () => void; onClose: () => void;
}) {
  const back = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { back.current?.focus({ preventScroll: true }); }, []);
  return <section className="terminal-card file-opens-terminal" data-font-zoom="terminal" data-help-topic="terminal" aria-label={t("Terminal")}>
    <header>
      <h2>{t("File opens")}</h2>
      <Button type="button" ref={back} onClick={onBack}>{t("Back to terminal")}</Button>
      <Button type="button" className="icon-button" aria-label={t("Close terminal")} onClick={onClose}><X /></Button>
    </header>
    <div className="file-open-history" role="region" aria-label={t("File opens")} tabIndex={0}>
      {history.length === 0 ? <p>{t("No file opens in this session.")}</p> : <table>
        <thead><tr><th scope="col">{t("Time")}</th><th scope="col">{t("Path")}</th><th scope="col">{t("Result")}</th></tr></thead>
        <tbody>{history.map(({ id, path, time, outcome }) => <tr key={id}>
          <td><time dateTime={new Date(time).toISOString()}>{new Date(time).toLocaleString(locale())}</time></td>
          <td dir="auto">{path}</td>
          <td>{outcome.kind === "pending" ? t("Opening…") : outcome.kind === "sent" ? t("Open request sent to the system") :
            t("Open request failed. {0}", errorText(outcome.error))}</td>
        </tr>)}</tbody>
      </table>}
    </div>
  </section>;
}
