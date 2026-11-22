import { Channel } from "@tauri-apps/api/core";
import { FolderOpen, LockKeyhole, Trash2 } from "lucide-react";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { api, describeError, isPermissionError, windowsClient, type Deletion, type DeletionCounts, type DeletionDecision,
  type DeletionEvent, type DeletionResult, type DeletionSelection } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { countText, errorText, locale, t } from "./i18n";
import { formatSize } from "./panes";
import { ElevationButton, LockDialog } from "./ProcessTools";

type Locked = Extract<DeletionEvent, { phase: "locked" }>;
let nextDeletion = 0;

function Meter({ label, current, total, secondary }: { label: string; current?: number; total?: number; secondary?: boolean }) {
  const id = useId();
  const language = locale();
  return <div className="deletion-meter" data-secondary={secondary || undefined}>
    <div><strong id={id}>{t(label)}</strong>
      {current !== undefined && total !== undefined && <span>{t("{0} of {1}", current.toLocaleString(language), total.toLocaleString(language))}</span>}
    </div>
    <progress aria-labelledby={id} max={Math.max(total ?? 1, 1)} value={current} />
  </div>;
}

function SelectionDetails({ selection, permanent, available, finished }: {
  selection: DeletionSelection; permanent: boolean; available: number | null; finished: boolean;
}) {
  return <>
    <dl className="deletion-details">
      <div><dt>{t("Selection")}</dt><dd>{countText(selection.files, "file")} · {countText(selection.folders, "folder")}</dd></div>
      <div><dt>{t(permanent ? "Estimated space to reclaim" : "Selection size")}</dt><dd>{formatSize(selection.bytes)}</dd></div>
      <div><dt>{t(finished ? "Free space now" : "Free space before deletion")}</dt><dd>{formatSize(available)}</dd></div>
    </dl>
    {selection.incomplete && <p className="deletion-note">{t("Some items could not be counted.")}</p>}
  </>;
}

function Counts({ counts }: { counts: DeletionCounts }) {
  const language = locale();
  return <ul className="deletion-counts" aria-label={t("Deletion counts")}>
    <li>{t("{0} completed", counts.completed.toLocaleString(language))}</li>
    <li>{t("{0} skipped", counts.skipped.toLocaleString(language))}</li>
    <li>{t("{0} failed", counts.failed.toLocaleString(language))}</li>
    {counts.unprocessed > 0 && <li>{t("{0} unprocessed", counts.unprocessed.toLocaleString(language))}</li>}
  </ul>;
}

function LockDecision({ locked, suspended, onCancel, onInspect, onDecide, waiting }: {
  locked: Locked; suspended: boolean; onCancel: () => void; onInspect: () => void;
  onDecide: (decision: DeletionDecision) => void; waiting: boolean;
}) {
  const [remember, setRemember] = useState(false);
  return <Dialog title={t("Item is in use")} helpTopic="operations" suspended={suspended} onClose={onCancel}>
    <div className="dialog-body deletion-body">
      <div className="deletion-path" role="alert">
        <LockKeyhole aria-hidden="true" />
        <div><strong>{locked.path.split(/[\\/]/).at(-1)}</strong><span>{locked.path}</span></div>
      </div>
      <p>{t("Deletion is paused while another process is using this item.")}</p>
      {windowsClient && <div><Button type="button" onClick={onInspect}>{t("Find locking processes")}</Button></div>}
      <label className="deletion-remember"><input type="checkbox" checked={remember}
        onChange={(event) => setRemember(event.currentTarget.checked)} />{t("Apply to all remaining locked items")}</label>
    </div>
    <footer className="dialog-footer">
      <Button type="button" data-initial-focus onClick={onCancel}>{t("Cancel")}</Button>
      <Button type="button" disabled={waiting} onClick={() => onDecide("retry")}>{t("Retry")}</Button>
      <Button type="button" className="primary" disabled={waiting} onClick={() => onDecide(remember ? "skipRemaining" : "skip")}>{t("Skip")}</Button>
    </footer>
  </Dialog>;
}

export function DeletionDialog({ deletion, onClose, onFinished }: {
  deletion: Deletion; onClose: () => void; onFinished: (result: DeletionResult | null) => void;
}) {
  const [id] = useState(() => ++nextDeletion);
  const [event, setEvent] = useState<Exclude<DeletionEvent, Locked> | null>(null);
  const [locked, setLocked] = useState<Locked | null>(null);
  const [lockPaths, setLockPaths] = useState<string[] | null>(null);
  const [result, setResult] = useState<DeletionResult | null>(null);
  const [error, setError] = useState("");
  const [answering, setAnswering] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const cancelRequested = useRef(false);
  const finished = useRef(false);
  const close = useRef<HTMLButtonElement>(null);
  const complete = useEffectEvent((next: DeletionResult | null) => {
    onFinished(next);
    if (next && !next.cancelled && next.counts.failed + next.counts.skipped + next.counts.unprocessed === 0) onClose();
  });

  useEffect(() => {
    let active = true;
    const output = new Channel<DeletionEvent>();
    let cancelForwarded = false;
    output.onmessage = (next) => {
      if (!active) return;
      if (cancelRequested.current) {
        if (!cancelForwarded) {
          cancelForwarded = true;
          void api.cancelDeletion(id).catch(() => { cancelForwarded = false; });
        }
        if (next.phase === "locked") return;
      }
      if (next.phase === "locked") setLocked(next);
      else setEvent(next);
    };
    void api.deleteSelection(id, deletion, output).then((next) => {
      finished.current = true;
      if (!active) return;
      setResult(next);
      setLocked(null);
      setLockPaths(null);
      complete(next);
    }, (failure: unknown) => {
      finished.current = true;
      if (active) {
        setError(describeError(failure));
        setLocked(null);
        setLockPaths(null);
        complete(null);
      }
    });
    return () => {
      active = false;
      if (!finished.current) void api.cancelDeletion(id).catch(() => {});
    };
  }, [deletion, id]);

  useEffect(() => { if (result || error) close.current?.focus(); }, [result, error]);

  function cancel() {
    if (finished.current) { onClose(); return; }
    if (cancelRequested.current) return;
    cancelRequested.current = true;
    setCancelling(true);
    setLocked(null);
    setLockPaths(null);
    void api.cancelDeletion(id).catch((failure: unknown) => {
      setError(describeError(failure));
      setCancelling(false);
      cancelRequested.current = false;
    });
  }

  async function decide(decision: DeletionDecision) {
    if (!locked || answering) return;
    const token = locked.token;
    setAnswering(true);
    try {
      await api.resolveDeletion(id, token, decision);
      setLocked((current) => current?.token === token ? null : current);
    } catch (failure) {
      setError(describeError(failure));
      cancel();
    } finally {
      setAnswering(false);
    }
  }

  const progress = event?.phase === "removing" ? event.progress : null;
  const selection = result?.selection ?? event?.selection;
  const counts = result?.counts ?? progress?.counts;
  const path = progress?.path ?? (event?.phase === "preparing" ? event.path : deletion.directory);
  const prepared = selection ? selection.files + selection.folders : 0;
  const processed = counts ? counts.completed + counts.failed + counts.skipped : 0;

  return <>
    <Dialog title={t(result?.cancelled ? "Deletion cancelled" : result ? "Deletion results" : "Deletion progress")}
      helpTopic="operations" suspended={Boolean(locked)} onClose={cancel}>
      <div className="dialog-body deletion-body">
        <div className="deletion-path">
          {event?.phase === "preparing" ? <FolderOpen aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
          <span className="deletion-progress-path">{result ? deletion.directory : path}</span>
        </div>
        {error && <p className="dialog-error" role="alert">{errorText(error)}</p>}
        {cancelling && !result && !error && <p role="status">{t("Cancelling deletion…")}</p>}
        {!result && (progress ? <>
          <Meter label="Overall progress" current={processed} total={prepared} />
          <Meter label="Current item progress" current={progress.currentProcessed} total={progress.currentTotal} secondary />
        </> : !error && <Meter label="Preparing selection…" />)}
        {selection && <SelectionDetails selection={selection} permanent={deletion.permanent}
          available={result ? result.availableAfter : selection.availableBefore} finished={Boolean(result)} />}
        {result?.failures.length ? <details className="deletion-failures">
          <summary>{t("Failed items")}</summary>
          <ul>{result.failures.map(({ path, message }, index) => <li key={index}><strong>{path}</strong><span>{errorText(message)}</span></li>)}</ul>
        </details> : null}
        {windowsClient && result?.failures.some(({ message }) => isPermissionError(message)) &&
          <div><ElevationButton directory={deletion.directory} /></div>}
      </div>
      <footer className="dialog-footer deletion-footer">
        {counts && <Counts counts={counts} />}
        {result || finished.current ? <Button ref={close} type="button" className="primary" onClick={onClose}>{t("Done")}</Button> :
          <Button type="button" data-initial-focus onClick={cancel} disabled={cancelling}>{t("Cancel deletion")}</Button>}
      </footer>
    </Dialog>
    {locked && <LockDecision key={locked.token} locked={locked} suspended={Boolean(lockPaths)} waiting={answering}
      onInspect={() => setLockPaths([locked.path])} onCancel={cancel} onDecide={(choice) => { void decide(choice); }} />}
    {lockPaths && <LockDialog paths={lockPaths} onClose={() => setLockPaths(null)} />}
  </>;
}
