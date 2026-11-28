import { useEffect, useState } from "react";
import { api, type GitStashAction, type GitStashEntry, type GitStashPreview, type GitWorkingIndex } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { writeError } from "./gitWriteError";
import { t } from "./i18n";

const actions: Record<GitStashAction, string> = { apply: "Apply stash", pop: "Pop stash", drop: "Drop stash" };
const versions = { combined: "All stash changes", staged: "Staged", working: "Unstaged" } as const;
const stashId = (entry: GitStashEntry) => entry.position + ":" + entry.hash;

export function GitStashes({ root, index, refresh, onRefresh, onClose }: {
  root: string; index?: GitWorkingIndex | null; refresh: number; onRefresh: () => void; onClose: () => void;
}) {
  const [entries, setEntries] = useState<GitStashEntry[]>();
  const [selected, setSelected] = useState("");
  const [message, setMessage] = useState("");
  const [untracked, setUntracked] = useState(false);
  const [restoreIndex, setRestoreIndex] = useState(true);
  const [preview, setPreview] = useState<GitStashPreview>();
  const [version, setVersion] = useState<keyof GitStashPreview>("combined");
  const [review, setReview] = useState<{ entry: GitStashEntry; action: GitStashAction }>();
  const [error, setError] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const entry = entries?.find((value) => stashId(value) === selected) ?? entries?.[0];
  const diff = preview?.[version];
  useEffect(() => {
    let canceled = false;
    void api.gitStashes(root).then((values) => { if (!canceled) setEntries(values); },
      (error: unknown) => { if (!canceled) setError(writeError(error)); });
    return () => { canceled = true; };
  }, [root, refresh]);
  useEffect(() => {
    setPreview(undefined);
    setPreviewError("");
    if (!entry) return;
    let canceled = false;
    void api.gitStashPreview(root, entry).then((result) => { if (!canceled) setPreview(result); },
      (error: unknown) => { if (!canceled) setPreviewError(writeError(error)); });
    return () => { canceled = true; };
  }, [root, entry]);

  async function update() {
    if (!index || pending) return;
    setPending(true);
    setError("");
    setFeedback("");
    setConflicts([]);
    try {
      if (review) {
        const result = await api.gitUpdateStash(root, index.snapshot, review.entry, review.action, restoreIndex);
        if (result.error) setError(t(result.error));
        else setFeedback(t(review.action === "drop" ? "Stash dropped." : "Stash applied."));
        setConflicts(result.changes.filter(({ status }) => status === "U").map(({ path }) => path));
      } else {
        await api.gitCreateStash(root, index.snapshot, message, untracked);
        setMessage("");
        setFeedback(t("Stash created."));
      }
    } catch (error) {
      setError(writeError(error));
    } finally {
      setReview(undefined);
      setPending(false);
      onRefresh();
    }
  }

  const canCreate = index?.snapshot.head && !index.writeBlocked && index.changes
    .some(({ group }) => group !== "untracked" || untracked);
  return <Dialog title={t("Git stashes")} helpTopic="gitView" wide onClose={pending ? undefined : onClose}
    footer={<Button onClick={onClose} disabled={pending}>{t("Close")}</Button>}>
    <p><code>{root}</code></p>
    <form className="git-stash-create" onSubmit={(event) => { event.preventDefault(); void update(); }}>
      <label className="field">{t("Stash message")}
        <input value={message} disabled={pending} onChange={(event) => setMessage(event.target.value)} />
      </label>
      <label className="field-checkbox"><input type="checkbox" checked={untracked} disabled={pending}
        onChange={(event) => setUntracked(event.target.checked)} />{t("Include untracked files")}</label>
      <Button type="submit" disabled={!canCreate || pending || !!review}>{t("Create stash")}</Button>
    </form>
    {error && <p role="alert">{error}</p>}
    {feedback && <p role="status">{feedback}</p>}
    {conflicts.length > 0 && <div role="alert"><p>{t("The worktree has unresolved stash conflicts.")}</p>
      <ul>{conflicts.map((path) => <li key={path}>{path}</li>)}</ul>
    </div>}
    {!entries ? <p role="status">{t("Reading stashes…")}</p> : entries.length ? <>
      <label className="field">{t("Stash")}
        <select value={entry ? stashId(entry) : ""} disabled={pending} onChange={(event) => setSelected(event.target.value)}>
          {entries.map((value) => <option key={stashId(value)} value={stashId(value)}>
            {"stash@{" + value.position + "} · " + value.subject}
          </option>)}
        </select>
      </label>
      {entry && <>
        <div className="git-branch-actions">
          {(Object.keys(versions) as (keyof GitStashPreview)[]).map((name) =>
            <Button key={name} aria-pressed={version === name} onClick={() => setVersion(name)}>{t(versions[name])}</Button>)}
        </div>
        {previewError ? <p role="alert">{previewError}</p> : !diff ? <p role="status">{t("Reading change…")}</p> :
          diff.patch ? <pre className="git-patch" tabIndex={0} aria-label={t("Stash diff")}>{diff.patch}</pre> :
            <p>{t(diff.fallback ? "A text diff is unavailable for this change." : "No changed paths.")}</p>}
        <label className="field-checkbox"><input type="checkbox" checked={restoreIndex} disabled={pending}
          onChange={(event) => setRestoreIndex(event.target.checked)} />{t("Restore staged changes to the index")}</label>
        <div className="git-branch-actions">
          {(Object.keys(actions) as GitStashAction[]).map((action) =>
            <Button key={action} disabled={pending || !index || index.writeBlocked && action !== "drop"}
              onClick={() => setReview({ entry, action })}>{t(actions[action])}</Button>)}
        </div>
      </>}
    </> : <p>{t("No stashes.")}</p>}
    {review && <Dialog title={t(actions[review.action])} helpTopic="gitView"
      onClose={pending ? undefined : () => setReview(undefined)} footer={<>
        <Button disabled={pending} onClick={() => setReview(undefined)}>{t("Cancel")}</Button>
        <Button disabled={pending || !index} onClick={() => void update()}>{t(actions[review.action])}</Button>
      </>}>
      <p><code>{root}</code></p>
      <p><code>{review.entry.hash.slice(0, 12)}</code> {review.entry.subject}</p>
      {review.action === "drop" && <p>{t("Remove this stash from the list.")}</p>}
      {review.action === "pop" && <p>{t("Remove this stash after applying it successfully.")}</p>}
    </Dialog>}
  </Dialog>;
}
