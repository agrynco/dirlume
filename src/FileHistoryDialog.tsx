import { useEffect, useEffectEvent, useState } from "react";
import { api, describeError, type FileHistory, type FileHistoryDirection } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { errorText, locale, t } from "./i18n";

const statuses: Record<string, string> = {
  running: "Working…", completed: "Completed", cancelled: "Canceled", failed: "Failed",
  skipped: "Skipped", undone: "Undone", partial: "Partially reversed", reversed: "Reversed", pending: "Pending",
};

const statusLabel = (status: string) => t(statuses[status] ?? status);

const heading = (entry: FileHistory["entries"][number]) => {
  const time = new Date(entry.time).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  return time + " · " + t(entry.moving ? "Move" : "Copy") + " · " + statusLabel(entry.outcome);
};

export function FileHistoryDialog({ initial, onClose, onChanged }: {
  initial?: FileHistoryDirection;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [view, setView] = useState<FileHistory>();
  const [selected, setSelected] = useState<number>();
  const [running, setRunning] = useState(true);
  const [error, setError] = useState("");
  const changed = useEffectEvent(onChanged);
  useEffect(() => {
    let disposed = false;
    async function load() {
      try {
        const current = await api.fileOperationHistory();
        if (disposed) return;
        const target = initial ? current[initial] : null;
        setSelected(target ?? current.undo ?? current.entries[0]?.id);
        const result = initial && target != null ? await api.reverseFileOperation(initial, target) : current;
        if (disposed) return;
        setView(result);
        if (result.changed) changed();
      } catch (failure) {
        if (!disposed) setError(describeError(failure));
      } finally {
        if (!disposed) setRunning(false);
      }
    }
    void load();
    return () => { disposed = true; };
  }, [initial]);

  async function reverse(direction: FileHistoryDirection) {
    const target = view?.[direction];
    if (running || target == null) return;
    setSelected(target);
    setRunning(true);
    setError("");
    try {
      const result = await api.reverseFileOperation(direction, target);
      setView(result);
      if (result.changed) onChanged();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setRunning(false);
    }
  }

  const entry = view?.entries.find(({ id }) => id === selected);
  const target = (direction: FileHistoryDirection) => view?.entries.find(({ id }) => id === view[direction]);
  const label = (direction: FileHistoryDirection) => t(view?.pending === direction ? "Retry" :
    direction === "undo" ? "Undo file operation" : "Redo file operation");

  return <Dialog title={t("File operation history")} wide helpTopic="actionDialogs" onClose={() => { if (!running) onClose(); }}
    footer={<>
      {(["undo", "redo"] as const).map((direction) => {
        const next = target(direction);
        return <Button key={direction} type="button" disabled={!next || running}
          tooltip={next ? heading(next) + " · " + next.destination : undefined}
          onClick={() => void reverse(direction)}>{label(direction)}</Button>;
      })}
      <Button type="button" onClick={onClose} disabled={running}>{t("Close")}</Button>
    </>}>
    <div className="dialog-body file-operation-history">
      {running && <p role="status">{t("Working…")}</p>}
      {error && <p className="dialog-error" role="alert">{errorText(error)}</p>}
      {view && !view.entries.length && <p>{t("No file operations in this session.")}</p>}
      {view && view.entries.length > 0 && <div className="file-operation-history-grid">
        <select size={8} aria-label={t("File operation history")} value={selected ?? ""}
          onChange={(event) => setSelected(Number(event.target.value))} disabled={running} data-initial-focus>
          {view.entries.map((item) => <option key={item.id} value={item.id}>{heading(item)}</option>)}
        </select>
        {entry && <section className="file-operation-history-details" aria-label={t("Details")}>
          <h3>{heading(entry)}</h3>
          <dl>
            <dt>{t("Source path")}</dt><dd>{entry.source}</dd>
            <dt>{t("Destination")}</dt><dd>{entry.destination}</dd>
          </dl>
          {entry.reason && <p className="dialog-error" role="status">{errorText(entry.reason)}</p>}
          {entry.rows.length > 0 && <ul>
            {entry.rows.map((row, index) => <li key={index}>
              <strong>{statusLabel(row.outcome)}</strong>
              <div>{row.source}</div>
              <div>{row.destination}</div>
              {row.error && <span className="dialog-error">{errorText(row.error)}</span>}
            </li>)}
          </ul>}
        </section>}
      </div>}
    </div>
  </Dialog>;
}
