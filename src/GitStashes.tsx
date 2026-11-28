import { useEffect, useState } from "react";
import { Archive, ArrowDownToLine, ArrowUpFromLine, Eye, Layers, Trash2 } from "lucide-react";
import { api, type GitStashAction, type GitStashChange, type GitStashEntry, type GitStashPreview, type GitWorkingIndex } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { GitActionButtons, useGitMenu, type GitAction } from "./GitActions";
import { writeError } from "./gitWriteError";
import { t } from "./i18n";
import { GitRevisionChange } from "./GitRevisionComparison";
import type { ComparisonShortcuts } from "./TextTools";

const actions: Record<GitStashAction, string> = { apply: "Apply stash", pop: "Pop stash", drop: "Drop stash" };
const icons = { apply: ArrowDownToLine, pop: ArrowUpFromLine, drop: Trash2 };
const versions = { combined: "All stash changes", staged: "Staged", working: "Unstaged" } as const;
const stashId = (entry: GitStashEntry) => entry.position + ":" + entry.hash;
const changeId = ({ target, change }: GitStashChange) => JSON.stringify([target, change.path]);

export function GitStashes({ root, index, refresh, onRefresh, onClose, shortcuts }: {
  root: string; index?: GitWorkingIndex | null; refresh: number; onRefresh: () => void; onClose: () => void;
  shortcuts: ComparisonShortcuts;
}) {
  const menu = useGitMenu();
  const [entries, setEntries] = useState<GitStashEntry[]>();
  const [selected, setSelected] = useState("");
  const [message, setMessage] = useState("");
  const [untracked, setUntracked] = useState(false);
  const [restoreIndex, setRestoreIndex] = useState(true);
  const [preview, setPreview] = useState<GitStashPreview>();
  const [version, setVersion] = useState<keyof GitStashPreview>("combined");
  const [selectedChange, setSelectedChange] = useState<string>();
  const [review, setReview] = useState<{ entry: GitStashEntry; action: GitStashAction }>();
  const [error, setError] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const entry = entries?.find((value) => stashId(value) === selected) ?? entries?.[0];
  const diff = preview?.[version];
  const changed = diff?.find((change) => changeId(change) === selectedChange) ?? diff?.[0];
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
  const create: GitAction = { label: "Create stash", icon: Archive, submit: true, disabled: !canCreate || pending || !!review,
    run: () => void update() };
  function entryActions(target: GitStashEntry): GitAction[] {
    return (Object.keys(actions) as GitStashAction[]).map((action) => ({
      label: actions[action], icon: icons[action], disabled: pending || !index || index.writeBlocked && action !== "drop",
      destructive: action === "drop",
      run: () => { setSelected(stashId(target)); setReview({ entry: target, action }); },
    }));
  }
  const versionActions = (Object.keys(versions) as (keyof GitStashPreview)[]).map((name) => ({
    label: versions[name], icon: Layers, pressed: version === name, run: () => setVersion(name),
  }));
  return <Dialog title={t("Git stashes")} helpTopic="gitView" wide onClose={pending ? undefined : onClose}
    footer={<Button onClick={onClose} disabled={pending}>{t("Close")}</Button>}>
    <div className="dialog-body" tabIndex={-1} {...menu([create, ...(entry ? [...versionActions, ...entryActions(entry)] : [])])}>
    <p><code>{root}</code></p>
    <form className="git-stash-create" onSubmit={(event) => { event.preventDefault(); void update(); }}>
      <label className="field">{t("Stash message")}
        <input value={message} disabled={pending} onChange={(event) => setMessage(event.target.value)} />
      </label>
      <label className="field-checkbox"><input type="checkbox" checked={untracked} disabled={pending}
        onChange={(event) => setUntracked(event.target.checked)} />{t("Include untracked files")}</label>
      <GitActionButtons actions={[create]} />
    </form>
    {error && <p role="alert">{error}</p>}
    {feedback && <p role="status">{feedback}</p>}
    {conflicts.length > 0 && <div role="alert"><p>{t("The worktree has unresolved stash conflicts.")}</p>
      <ul>{conflicts.map((path) => <li key={path}>{path}</li>)}</ul>
    </div>}
    {!entries ? <p role="status">{t("Reading stashes…")}</p> : entries.length ? <>
      <ul className="git-rebase-list git-stash-list" aria-label={t("Stashes")}>
        {entries.map((value) => <li key={stashId(value)}>
          <Button aria-pressed={entry === value} disabled={pending} onClick={() => setSelected(stashId(value))}
            {...menu([{ label: "Preview stash", icon: Eye, run: () => setSelected(stashId(value)) }, ...entryActions(value)], value.subject)}>
            {"stash@{" + value.position + "} · " + value.subject}
          </Button>
        </li>)}
      </ul>
      {entry && <>
        <div className="git-branch-actions">
          <GitActionButtons actions={versionActions} />
        </div>
        {previewError ? <p role="alert">{previewError}</p> : !diff ? <p role="status">{t("Reading change…")}</p> :
          changed ? <section aria-label={t("Stash diff")}>
            <ul className="git-history-paths" aria-label={t("Changed paths")}>
              {diff.map((file) => <li key={changeId(file)}><Button aria-pressed={changed === file}
                onClick={() => setSelectedChange(changeId(file))}>
                {file.change.previousPath ? file.change.previousPath + " → " + file.change.path : file.change.path}
                {file.base === null && <> · {t("Untracked")}</>}
              </Button></li>)}
            </ul>
            <GitRevisionChange key={changeId(changed)} root={root} base={changed.base} target={changed.target}
              change={changed.change} shortcuts={shortcuts} />
          </section> : <p>{t("No changed paths.")}</p>}
        <label className="field-checkbox"><input type="checkbox" checked={restoreIndex} disabled={pending}
          onChange={(event) => setRestoreIndex(event.target.checked)} />{t("Restore staged changes to the index")}</label>
        <div className="git-branch-actions">
          <GitActionButtons actions={entryActions(entry)} />
        </div>
      </>}
    </> : <p>{t("No stashes.")}</p>}
    </div>
    {review && <Dialog title={t(actions[review.action])} helpTopic="gitView"
      onClose={pending ? undefined : () => setReview(undefined)} footer={<>
        <Button disabled={pending} data-initial-focus={review.action === "drop" || undefined}
          onClick={() => setReview(undefined)}>{t("Cancel")}</Button>
        <Button disabled={pending || !index} className={review.action === "drop" ? "negative" : undefined}
          onClick={() => void update()}>{t(actions[review.action])}</Button>
      </>}>
      <div className="dialog-body git-tools-review">
        <p><code>{root}</code></p>
        <p><code>{review.entry.hash.slice(0, 12)}</code> {review.entry.subject}</p>
        {review.action === "drop" && <p>{t("Remove this stash from the list.")}</p>}
        {review.action === "pop" && <p>{t("Remove this stash after applying it successfully.")}</p>}
      </div>
    </Dialog>}
  </Dialog>;
}
