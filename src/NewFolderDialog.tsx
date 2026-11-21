import { useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { api, describeError, isPermissionError, windowsClient, type FolderLinkType } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { EditableDropdown } from "./EditableDropdown";
import { errorText, t } from "./i18n";
import { PathField } from "./PathField";
import { bindingMatches, eventShortcut, showShortcut } from "./preferences";
import { ElevationButton } from "./ProcessTools";
import { timestampSeconds, useTimestamps } from "./useTimestamps";

const historyKey = "dirlume.folder-name-history.v1";
type HistoryEntry = { name: string; date: number };

function folderHistory(): HistoryEntry[] {
  try {
    const entries: unknown = JSON.parse(localStorage.getItem(historyKey) ?? "[]");
    return Array.isArray(entries) ? entries.filter((entry): entry is HistoryEntry =>
      typeof entry?.name === "string" && entry.name.length > 0 &&
      Number.isFinite(entry.date) && Math.abs(entry.date) <= 8.64e15).slice(0, 100) : [];
  } catch {
    return [];
  }
}

export function NewFolderDialog({ directory, showHidden, historyShortcut, onCreated, onClose }: {
  directory: string;
  showHidden: boolean;
  historyShortcut: readonly string[];
  onCreated: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const nameId = useId();
  const historyId = useId();
  const targetId = useId();
  const [name, setName] = useState("");
  const [linkType, setLinkType] = useState<FolderLinkType>("none");
  const [target, setTarget] = useState("");
  const [multiple, setMultiple] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [error, setError] = useState("");
  const [failedName, setFailedName] = useState("");
  const [history] = useState(folderHistory);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const dates = new Map<string, HistoryEntry[]>();
  const dateLabel = useTimestamps(historyOpen ? history.map(({ date }) => timestampSeconds(date)) : [], "date");
  if (historyOpen) for (const entry of history) {
    const date = dateLabel(timestampSeconds(entry.date)) ?? t("Unknown date");
    const group = dates.get(date) ?? [];
    group.push(entry);
    dates.set(date, group);
  }

  useLayoutEffect(() => {
    if (historyOpen) list.current?.querySelector("button")?.focus();
  }, [historyOpen]);

  function closeHistory() {
    setHistoryOpen(false);
    input.current?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (waiting) return;
    setWaiting(true);
    setError("");
    setFailedName("");
    try {
      const result = await api.createFolders(directory, { name, multiple, linkType, target });
      if (result.last) await onCreated(result.last);
      if (result.failure) {
        setError(result.failure.error);
        setFailedName(result.failure.name);
        return;
      }
      try {
        const recent = [{ name, date: Date.now() }, ...history.filter((entry) => entry.name !== name)].slice(0, 100);
        localStorage.setItem(historyKey, JSON.stringify(recent));
      } catch { /* The folder was created even if history storage is unavailable. */ }
      onClose();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setWaiting(false);
    }
  }

  return <Dialog title={t("New folder")} onClose={() => { if (!waiting) onClose(); }} onKeyDown={(event) => {
    if (historyOpen && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeHistory();
    } else if (!waiting && history.length && bindingMatches(historyShortcut, eventShortcut(event))) {
      event.preventDefault();
      event.stopPropagation();
      if (historyOpen) closeHistory();
      else setHistoryOpen(true);
    }
  }}>
    <form className="dialog-form" onSubmit={(event) => { void submit(event); }}>
      <div className="dialog-body">
        <div className="field">
          <label htmlFor={nameId}>{t("Name")}</label>
          <EditableDropdown trigger={{
            popupId: historyId, expanded: historyOpen, label: t("Folder name history"), shortcut: showShortcut(historyShortcut[0]),
            disabled: waiting || !history.length, keepFieldFocus: false, onClick: () => {
              if (historyOpen) closeHistory();
              else setHistoryOpen(true);
            },
          }}>
            <input id={nameId} ref={input} data-initial-focus type="text" required autoComplete="off" value={name}
              disabled={waiting} onChange={(event) => setName(event.target.value)} />
          </EditableDropdown>
          {historyOpen && <div id={historyId} ref={list} className="folder-name-history" role="listbox"
            aria-label={t("Folder name history")} onKeyDown={(event) => {
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              event.preventDefault();
              const rows = [...event.currentTarget.querySelectorAll("button")];
              const index = rows.indexOf(document.activeElement as HTMLButtonElement);
              rows[(index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length]?.focus();
            }}>
            {[...dates].map(([date, entries]) => <div key={date} role="group" aria-label={date}>
              <span className="folder-history-date">{date}</span>
              {entries.map((entry) => <Button type="button" key={entry.name} role="option" aria-selected={false}
                onClick={() => { setName(entry.name); closeHistory(); }}>{entry.name}</Button>)}
            </div>)}
          </div>}
        </div>
        <label className="field">{t("Link type")}
          <select value={linkType} aria-label={t("Link type")} disabled={waiting} onChange={(event) => setLinkType(event.target.value as FolderLinkType)}>
            <option value="none">{t("None")}</option>
            {windowsClient && <option value="junction">{t("Directory junction")}</option>}
            <option value="symbolic">{t("Symbolic link")}</option>
          </select>
        </label>
        {linkType !== "none" && <div className="field">
          <label htmlFor={targetId}>{t("Target")}</label>
          <PathField id={targetId} label={t("Target")} value={target} onChange={setTarget} required
            readOnly={waiting} showHidden={showHidden} browse="folder" browsePath={directory} baseDirectory={directory} />
        </div>}
        <label className="transfer-checkbox">
          <input type="checkbox" checked={multiple} disabled={waiting} onChange={(event) => setMultiple(event.target.checked)} />
          {t("Process multiple names")}
        </label>
        {error && <p className="dialog-error" role="alert">{failedName ? t("Could not create {0}. {1}", failedName, errorText(error)) : errorText(error)}</p>}
        {windowsClient && isPermissionError(error) && <ElevationButton directory={directory} />}
      </div>
      <div className="dialog-footer">
        <Button type="button" disabled={waiting} onClick={onClose}>{t("Cancel")}</Button>
        <Button type="submit" className="primary" disabled={waiting || !name.trim() || (linkType !== "none" && !target.trim())}>
          {t(waiting ? "Working…" : "Create")}
        </Button>
      </div>
    </form>
  </Dialog>;
}
