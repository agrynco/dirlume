import { useEffect, useId, useState } from "react";
import {
  api, type GitHistoryAction, type GitHistoryPlan, type GitPushReview, type GitRebaseAction,
  type GitRebasePlan, type GitRebaseStep, type GitReflog, type GitReflogEntry, type GitRepository,
} from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { writeError } from "./GitChanges";
import { t } from "./i18n";

const actionLabels = {
  cherryPick: "Cherry-pick commit", revert: "Revert commit", softReset: "Soft reset",
  mixedReset: "Mixed reset", hardReset: "Hard reset", rebase: "Rebase branch",
  reflog: "Reflog", push: "Force-push with lease",
} as const;
type Action = keyof typeof actionLabels;
const stepLabels: Record<GitRebaseAction, string> = {
  pick: "Pick", reword: "Reword", squash: "Squash", drop: "Drop",
};
const resetEffects: Partial<Record<GitHistoryAction, string>> = {
  softReset: "Move HEAD to the target. Keep the index and working files.",
  mixedReset: "Move HEAD and replace the index. Keep working files.",
  hardReset: "Move HEAD, replace the index, and discard changes to tracked working files.",
};
type Preview = { kind: "edit"; value: GitHistoryPlan } | { kind: "rebase"; value: GitRebasePlan } |
  { kind: "push"; value: GitPushReview };
type Confirmation = (Preview & { steps?: GitRebaseStep[] }) | { kind: "recover"; entry: GitReflogEntry; branch: string };

function CommitHash({ hash }: { hash: string }) {
  return <code title={hash}>{hash.slice(0, 12)}</code>;
}

function Impact({ plan }: { plan: GitHistoryPlan }) {
  const effect = resetEffects[plan.review.action];
  const local = plan.localChanges.filter(({ group }) => group !== "untracked");
  return <>
    <dl><dt>{t("Current branch")}</dt><dd>{plan.review.headRef ?? "HEAD"} <CommitHash hash={plan.review.head} /></dd>
      <dt>{t("Target commit")}</dt><dd><CommitHash hash={plan.review.target} /></dd></dl>
    {effect && <p>{t(effect)}</p>}
    <h3>{t("Changed paths")}</h3>
    {plan.paths.length ? <ul>{plan.paths.map(({ path, previousPath }) =>
      <li key={path}>{previousPath ? previousPath + " → " + path : path}</li>)}</ul> : <p>{t("No changed paths.")}</p>}
    {local.length > 0 && <>
      <h3>{t("Local changes")}</h3>
      <ul>{local.map(({ path, group }) =>
        <li key={group + path}>{t(group === "staged" ? "Staged" : "Unstaged")} · {path}</li>)}</ul>
    </>}
  </>;
}

function RebaseImpact({ plan }: { plan: GitRebasePlan }) {
  return <>
    <dl><dt>{t("Current branch")}</dt><dd>{plan.review.headRef} <CommitHash hash={plan.review.head} /></dd>
      <dt>{t("Rebase base")}</dt><dd>{plan.review.baseRef} <CommitHash hash={plan.review.base} /></dd></dl>
    {plan.merges.length > 0 && <p>{t("These merge commits will be flattened.")}{" "}
      {plan.merges.map((hash) => <span key={hash}><CommitHash hash={hash} />{" "}</span>)}</p>}
  </>;
}

function PushImpact({ review }: { review: GitPushReview }) {
  return <>
    <dl>
      <dt>{t("Current branch")}</dt><dd>{review.headRef} <CommitHash hash={review.head} /></dd>
      <dt>{t("Remote")}</dt><dd>{review.remote} · {review.url}</dd>
      <dt>{t("Destination branch")}</dt><dd>{review.destination}</dd>
      <dt>{t("Expected remote tip")}</dt><dd><CommitHash hash={review.expected} /></dd>
    </dl>
    <p>{t("Replace the remote branch if its tip still matches this review.")}</p>
  </>;
}

export function GitHistoryTools({ repository, initialTarget, initialRef, onRefresh }: {
  repository: GitRepository; initialTarget?: string; initialRef?: string; onRefresh: () => void;
}) {
  const root = repository.root;
  const refs = useId();
  const [action, setAction] = useState<Action>("cherryPick");
  const [target, setTarget] = useState(initialTarget ?? repository.head ?? "");
  const [parent, setParent] = useState<number | null>(null);
  const [branch, setBranch] = useState(repository.headRef?.replace(/^refs\/heads\//, "") ?? "");
  const [remotes, setRemotes] = useState<string[]>();
  const [remote, setRemote] = useState("");
  const [preview, setPreview] = useState<Preview>();
  const [steps, setSteps] = useState<GitRebaseStep[]>([]);
  const [reflog, setReflog] = useState<GitReflog>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (action !== "push") return;
    let canceled = false;
    void api.gitPushRemotes(root).then((names) => {
      if (!canceled) {
        setRemotes(names);
        setRemote(names[0] ?? "");
      }
    }, (error: unknown) => { if (!canceled) setError(writeError(error)); });
    return () => { canceled = true; };
  }, [action, root]);

  function clearPreview() {
    setPreview(undefined);
    setError("");
    setFeedback("");
  }

  async function loadReflog(offset: number) {
    const result = await api.gitReflog(root, offset);
    setReflog((previous) => ({
      entries: offset && previous ? [...previous.entries, ...result.entries] : result.entries,
      nextOffset: result.nextOffset,
    }));
  }

  async function requestPreview(chosenParent = parent, offset = 0) {
    setPending(true);
    setError("");
    setFeedback("");
    setPreview(undefined);
    try {
      if (action === "rebase") {
        const value = await api.gitRebasePlan(root, target.trim());
        setSteps(value.commits.map(({ hash }) => ({ hash, action: "pick", message: null })));
        setPreview({ kind: "rebase", value });
      } else if (action === "push") {
        setPreview({ kind: "push", value: await api.gitPushLeasePlan(root, remote, branch.trim()) });
      } else if (action === "reflog") {
        await loadReflog(offset);
      } else {
        setPreview({ kind: "edit", value: await api.gitHistoryPlan(root, action, target.trim(), chosenParent) });
      }
    } catch (error) {
      setError(writeError(error));
    } finally {
      setPending(false);
    }
  }

  function changeAction(next: Action) {
    setAction(next);
    clearPreview();
    setParent(null);
    setReflog(undefined);
    if (next === "rebase") setTarget(initialRef ?? initialTarget ?? repository.head ?? "");
    else if (action === "rebase") setTarget(initialTarget ?? repository.head ?? "");
  }

  function moveStep(index: number, offset: number) {
    const next = [...steps];
    const [step] = next.splice(index, 1);
    next.splice(index + offset, 0, step);
    setSteps(next);
  }

  async function runConfirmed() {
    if (!confirmation || pending) return;
    setPending(true);
    setError("");
    setFeedback("");
    try {
      if (confirmation.kind === "recover") {
        await api.gitRecoverCommit(root, confirmation.entry.hash, confirmation.branch.trim());
      } else if (confirmation.kind === "push") {
        await api.gitPushWithLease(root, confirmation.value);
      } else if (confirmation.kind === "rebase") {
        await api.gitStartRebase(root, confirmation.value.review, confirmation.steps ?? []);
      } else {
        await api.gitEditHistory(root, confirmation.value.review);
      }
      setFeedback(t("Git operation completed."));
      setReflog(undefined);
    } catch (error) {
      setError(writeError(error));
    } finally {
      setConfirmation(undefined);
      setPreview(undefined);
      setPending(false);
      onRefresh();
    }
  }

  const needParent = preview?.kind === "edit" && preview.value.parents.length > 1;
  const mustChooseParent = needParent && preview.value.review.parent === null;
  const invalidSteps = steps.some((step, index) => step.action === "reword" && !step.message?.trim() ||
    step.action === "squash" && !steps.slice(0, index).some(({ action }) => action !== "drop"));
  const missingTarget = action === "push" ? !remote || !branch.trim() : action !== "reflog" && !target.trim();
  const heading = confirmation?.kind === "recover" ? "Recover into new branch" : actionLabels[action];

  return <div className="git-scroll git-revision-comparison" aria-label={t("History actions")}>
    <p><code>{root}</code></p>
    <form onSubmit={(event) => { event.preventDefault(); void requestPreview(); }}>
      <label className="field">{t("History action")}
        <select value={action} disabled={pending} onChange={(event) => changeAction(event.target.value as Action)}>
          {Object.entries(actionLabels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select>
      </label>
      {action === "push" ? <>
        <label className="field">{t("Remote")}
          <select value={remote} disabled={pending || !remotes?.length} onChange={(event) => { setRemote(event.target.value); clearPreview(); }}>
            {remotes?.map((name) => <option key={name}>{name}</option>)}
          </select>
        </label>
        {remotes?.length === 0 && <p>{t("No Git remotes are configured.")}</p>}
        <label className="field">{t("Destination branch")}
          <input value={branch} disabled={pending} spellCheck={false} autoComplete="off"
            onChange={(event) => { setBranch(event.target.value); clearPreview(); }} />
        </label>
      </> : action !== "reflog" && <>
        <label className="field">{t(action === "rebase" ? "Rebase base" : "Target commit")}
          <input value={target} list={action === "rebase" ? refs : undefined} disabled={pending}
            spellCheck={false} autoComplete="off" onChange={(event) => { setTarget(event.target.value); setParent(null); clearPreview(); }} />
        </label>
        {action === "rebase" && <datalist id={refs}>
          {repository.branches.map(({ reference }) => <option value={reference} key={reference} />)}
        </datalist>}
      </>}
      <Button type="submit" disabled={pending || missingTarget}>{t(action === "reflog" ? "Read reflog" : "Review changes")}</Button>
    </form>
    {pending && <p role="status">{t("Working with Git…")}</p>}
    {error && <p role="alert">{error}</p>}
    {feedback && <p role="status">{feedback}</p>}
    {preview?.kind === "edit" && <>
      {needParent && <label className="field">{t("Mainline parent")}
        <select value={parent ?? ""} disabled={pending} onChange={(event) => {
          const next = event.target.value ? Number(event.target.value) : null;
          setParent(next);
          void requestPreview(next);
        }}>
          <option value="">{t("Select a parent")}</option>
          {preview.value.parents.map((hash, index) => <option key={hash} value={index + 1}>{index + 1} · {hash.slice(0, 12)}</option>)}
        </select>
      </label>}
      {!mustChooseParent && <Impact plan={preview.value} />}
    </>}
    {preview?.kind === "push" && <PushImpact review={preview.value} />}
    {preview?.kind === "rebase" && <>
      <RebaseImpact plan={preview.value} />
      <h3>{t("Commit sequence")}</h3>
      {steps.length ? <ol className="git-rebase-list">{steps.map((step, index) => {
        const commit = preview.value.commits.find(({ hash }) => hash === step.hash);
        return <li key={step.hash}>
          <p><CommitHash hash={step.hash} /> {commit?.subject}</p>
          <div className="git-branch-actions">
            <select aria-label={t("Rebase action")} value={step.action} onChange={(event) => {
              const next = event.target.value as GitRebaseAction;
              setSteps(steps.map((item) => item === step ? { ...item, action: next, message: next === "reword" ? commit?.subject ?? "" : null } : item));
            }}>
              {Object.entries(stepLabels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
            </select>
            <Button disabled={index === 0} onClick={() => moveStep(index, -1)}>{t("Move earlier")}</Button>
            <Button disabled={index === steps.length - 1} onClick={() => moveStep(index, 1)}>{t("Move later")}</Button>
          </div>
          {step.action === "reword" && <label className="field">{t("Replacement commit message")}
            <textarea value={step.message ?? ""} onChange={(event) =>
              setSteps(steps.map((item) => item === step ? { ...item, message: event.target.value } : item))} />
          </label>}
        </li>;
      })}</ol> : <p>{t("No commits to replay.")}</p>}
      {invalidSteps && <p role="status">{t("Reword needs a message. Squash needs an earlier commit.")}</p>}
    </>}
    {preview && !mustChooseParent && <Button disabled={pending || preview.kind === "rebase" && invalidSteps}
      onClick={() => setConfirmation(preview.kind === "rebase" ? { ...preview, steps: [...steps] } : preview)}>{t(actionLabels[action])}</Button>}
    {action === "reflog" && reflog && <>
      {reflog.entries.length ? <ul className="git-rebase-list">{reflog.entries.map((entry, index) =>
        <li key={entry.selector + index}>
          <p><CommitHash hash={entry.hash} /> {entry.subject}</p><p>{entry.selector} · {entry.action}</p>
          <Button disabled={pending} onClick={() => setConfirmation({ kind: "recover", entry, branch: "" })}>{t("Recover into new branch")}</Button>
        </li>)}</ul> : <p>{t("No reflog entries.")}</p>}
      {reflog.nextOffset !== null && <Button disabled={pending}
        onClick={() => void requestPreview(null, reflog.nextOffset ?? 0)}>{t("Load more")}</Button>}
    </>}
    {confirmation && <Dialog title={t(heading)} helpTopic="gitView" onClose={pending ? undefined : () => setConfirmation(undefined)}
      footer={<>
        <Button disabled={pending} onClick={() => setConfirmation(undefined)}>{t("Cancel")}</Button>
        <Button disabled={pending || confirmation.kind === "recover" && !confirmation.branch.trim()}
          onClick={() => void runConfirmed()}>{t(heading)}</Button>
      </>}>
      <p><code>{root}</code></p>
      {confirmation.kind === "recover" ? <>
        <p><CommitHash hash={confirmation.entry.hash} /> {confirmation.entry.subject}</p>
        <label className="field">{t("Branch name")}
          <input autoFocus value={confirmation.branch} disabled={pending} autoComplete="off" spellCheck={false}
            onChange={(event) => setConfirmation({ ...confirmation, branch: event.target.value })} />
        </label>
      </> : confirmation.kind === "push" ? <PushImpact review={confirmation.value} />
        : confirmation.kind === "edit" ? <Impact plan={confirmation.value} /> : <>
          <RebaseImpact plan={confirmation.value} />
          <h3>{t("Commit sequence")}</h3>
          {confirmation.steps?.length ? <ol>{confirmation.steps.map((step) =>
            <li key={step.hash}>{t(stepLabels[step.action])} <CommitHash hash={step.hash} /> {step.message ??
              confirmation.value.commits.find(({ hash }) => hash === step.hash)?.subject}</li>)}</ol>
            : <p>{t("No commits to replay.")}</p>}
        </>}
    </Dialog>}
  </div>;
}
