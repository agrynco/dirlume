import { useEffect, useId, useState } from "react";
import { ArrowDown, ArrowUp, Copy, FileDiff, GitBranchPlus, History, ListChecks, Undo2, Upload } from "lucide-react";
import {
  api, type GitHistoryAction, type GitHistoryPlan, type GitPushReview, type GitRebaseAction,
  type GitRebasePlan, type GitRebaseStep, type GitReflog, type GitReflogEntry, type GitRepository,
} from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { GitActionButtons, useGitMenu, type GitAction } from "./GitActions";
import { GitRevisionPatch } from "./GitRevisionComparison";
import { writeError } from "./gitWriteError";
import { t } from "./i18n";

const actionLabels = {
  cherryPick: "Cherry-pick commit", revert: "Revert commit", softReset: "Soft reset",
  mixedReset: "Mixed reset", hardReset: "Hard reset", rebase: "Rebase branch",
  reflog: "Reflog", push: "Force-push with lease",
} as const;
export type HistoryAction = keyof typeof actionLabels;
type Action = HistoryAction;
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

function Impact({ root, plan, selectedPath, onSelectPath }: {
  root: string; plan: GitHistoryPlan; selectedPath: string | undefined; onSelectPath: (path: string) => void;
}) {
  const { action, target, head, headRef, parent } = plan.review;
  const effect = resetEffects[action];
  const revert = action === "revert";
  const replay = action === "cherryPick" || revert;
  const base = plan.parents[(parent ?? 1) - 1] ?? null;
  const change = plan.paths.find(({ path }) => path === selectedPath) ?? plan.paths[0];
  const local = plan.localChanges.filter(({ group }) => replay || group !== "untracked");
  const [copyStatus, setCopyStatus] = useState("");
  const destination = headRef?.replace(/^refs\/heads\//, "") ?? t("Detached HEAD");
  const parentLabel = base ? <CommitHash hash={base} /> : t("Empty tree");
  return <>
    <dl className="git-history-impact">
      <dt>{t(replay ? "Applies to" : "Current branch")}</dt>
      <dd>{replay ? <strong>{destination}</strong> : headRef ?? "HEAD"} <CommitHash hash={head} /></dd>
      <dt>{t(replay ? "Source commit" : "Target commit")}</dt>
      <dd>{replay ? <>
        <strong>{plan.subject || t("No subject")}</strong>
        <div className="git-history-source"><code>{target}</code>
          <Button type="button" className="icon-button" aria-label={t("Copy commit hash")} tooltip={t("Copy commit hash")}
            onClick={() => void api.copyText(target).then(() => setCopyStatus(t("Commit hash copied.")),
              () => setCopyStatus(t("Could not copy the commit hash.")))}><Copy aria-hidden="true" /></Button>
        </div>
        {copyStatus && <span role="status">{copyStatus}</span>}
      </> : <CommitHash hash={target} />}</dd>
      {replay && <><dt>{t("Reviewed parent")}</dt><dd>{parent && <>{parent} · </>}{parentLabel}</dd></>}
    </dl>
    {effect && <p>{t(effect)}</p>}
    {replay && <p>{t("Git applies this patch to the checked-out destination and may report conflicts.")}</p>}
    <h3>{t("Changed paths")}</h3>
    {plan.paths.length ? <ul className={replay ? "git-history-paths" : undefined}>{plan.paths.map(({ path, previousPath }) => {
      const label = previousPath ? (revert ? path + " → " + previousPath : previousPath + " → " + path) : path;
      return <li key={path}>{replay ? <Button aria-pressed={change?.path === path} onClick={() => onSelectPath(path)}>
        <FileDiff aria-hidden="true" />{label}
      </Button> : label}</li>;
    })}</ul> : <p>{t("No changed paths.")}</p>}
    {replay && change && <section className="git-history-patch" aria-label={t("Change preview")}>
      <h3>{t(revert ? "Inverse of the source commit" : "Source commit changes")}</h3>
      <div className="git-history-patch-versions">
        <span>{t("Before")} {revert ? <CommitHash hash={target} /> : parentLabel}</span>
        <span>{t("After")} {revert ? parentLabel : <CommitHash hash={target} />}</span>
      </div>
      <GitRevisionPatch key={JSON.stringify([base, target, change.path, revert])} root={root} base={base} target={target}
        change={change} reverse={revert} />
    </section>}
    {local.length > 0 && <>
      <h3>{t("Local changes")}</h3>
      <ul>{local.map(({ path, group }) =>
        <li key={group + path}>{t(group === "staged" ? "Staged" : group === "untracked" ? "Untracked" : "Unstaged")} · {path}</li>)}</ul>
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

export function GitHistoryTools({ repository, initialTarget, initialRef, initialAction, onRefresh }: {
  repository: GitRepository; initialTarget?: string; initialRef?: string; initialAction?: Action; onRefresh: () => void;
}) {
  const menu = useGitMenu();
  const root = repository.root;
  const refs = useId();
  const [action, setAction] = useState<Action>(initialAction ?? "cherryPick");
  const [target, setTarget] = useState((initialAction === "rebase" ? initialRef : undefined) ?? initialTarget ?? repository.head ?? "");
  const [parent, setParent] = useState<number | null>(null);
  const [branch, setBranch] = useState(repository.headRef?.replace(/^refs\/heads\//, "") ?? "");
  const [remotes, setRemotes] = useState<string[]>();
  const [remote, setRemote] = useState("");
  const [preview, setPreview] = useState<Preview>();
  const [selectedPath, setSelectedPath] = useState<string>();
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
    setSelectedPath(undefined);
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
    setSelectedPath(undefined);
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
  const destructive = action === "push" || action.endsWith("Reset");
  const prepare: GitAction = { label: action === "reflog" ? "Read reflog" : "Review changes",
    icon: action === "reflog" ? History : ListChecks, disabled: pending || missingTarget, run: () => void requestPreview(), submit: true };
  const submit: GitAction[] = preview && !mustChooseParent ? [{
    label: actionLabels[action], icon: action === "push" ? Upload : Undo2, destructive,
    disabled: pending || preview.kind === "rebase" && invalidSteps,
    run: () => setConfirmation(preview.kind === "rebase" ? { ...preview, steps: [...steps] } : preview),
  }] : [];

  return <div className="git-scroll git-revision-comparison git-history-tools" aria-label={t("History actions")} tabIndex={-1}
    {...menu([prepare, ...submit])}>
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
      <GitActionButtons actions={[prepare]} />
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
      {!mustChooseParent && <Impact root={root} plan={preview.value} selectedPath={selectedPath} onSelectPath={setSelectedPath} />}
    </>}
    {preview?.kind === "push" && <PushImpact review={preview.value} />}
    {preview?.kind === "rebase" && <>
      <RebaseImpact plan={preview.value} />
      <h3>{t("Commit sequence")}</h3>
      {steps.length ? <ol className="git-rebase-list">{steps.map((step, index) => {
        const commit = preview.value.commits.find(({ hash }) => hash === step.hash);
        const moves: GitAction[] = [
          { label: "Move earlier", icon: ArrowUp, disabled: pending || index === 0, run: () => moveStep(index, -1) },
          { label: "Move later", icon: ArrowDown, disabled: pending || index === steps.length - 1, run: () => moveStep(index, 1) },
        ];
        return <li key={step.hash} tabIndex={0} {...menu(moves)}>
          <p><CommitHash hash={step.hash} /> {commit?.subject}</p>
          <div className="git-branch-actions">
            <select aria-label={t("Rebase action")} value={step.action} onChange={(event) => {
              const next = event.target.value as GitRebaseAction;
              setSteps(steps.map((item) => item === step ? { ...item, action: next, message: next === "reword" ? commit?.subject ?? "" : null } : item));
            }}>
              {Object.entries(stepLabels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
            </select>
            <GitActionButtons actions={moves} />
          </div>
          {step.action === "reword" && <label className="field">{t("Replacement commit message")}
            <textarea value={step.message ?? ""} onChange={(event) =>
              setSteps(steps.map((item) => item === step ? { ...item, message: event.target.value } : item))} />
          </label>}
        </li>;
      })}</ol> : <p>{t("No commits to replay.")}</p>}
      {invalidSteps && <p role="status">{t("Reword needs a message. Squash needs an earlier commit.")}</p>}
    </>}
    <GitActionButtons actions={submit} />
    {action === "reflog" && reflog && <>
      {reflog.entries.length ? <ul className="git-rebase-list">{reflog.entries.map((entry, index) => {
        const recover: GitAction[] = [{ label: "Recover into new branch", icon: GitBranchPlus, disabled: pending,
          run: () => setConfirmation({ kind: "recover", entry, branch: "" }) }];
        return <li key={entry.selector + index} tabIndex={0} {...menu(recover)}>
          <p><CommitHash hash={entry.hash} /> {entry.subject}</p><p>{entry.selector} · {entry.action}</p>
          <GitActionButtons actions={recover} />
        </li>; })}</ul> : <p>{t("No reflog entries.")}</p>}
      {reflog.nextOffset !== null && <Button disabled={pending}
        onClick={() => void requestPreview(null, reflog.nextOffset ?? 0)}>{t("Load more")}</Button>}
    </>}
    {confirmation && <Dialog title={t(heading)} helpTopic="gitView" wide={action === "cherryPick" || action === "revert"}
      onClose={pending ? undefined : () => setConfirmation(undefined)}
      footer={<>
        <Button disabled={pending} data-initial-focus={destructive || undefined} onClick={() => setConfirmation(undefined)}>{t("Cancel")}</Button>
        <Button disabled={pending || confirmation.kind === "recover" && !confirmation.branch.trim()}
          className={destructive ? "negative" : undefined}
          onClick={() => void runConfirmed()}>{t(heading)}</Button>
      </>}>
      <div className="dialog-body git-history-confirmation">
        <p><code>{root}</code></p>
        {confirmation.kind === "recover" ? <>
          <p><CommitHash hash={confirmation.entry.hash} /> {confirmation.entry.subject}</p>
          <label className="field">{t("Branch name")}
            <input autoFocus value={confirmation.branch} disabled={pending} autoComplete="off" spellCheck={false}
              onChange={(event) => setConfirmation({ ...confirmation, branch: event.target.value })} />
          </label>
        </> : confirmation.kind === "push" ? <PushImpact review={confirmation.value} />
          : confirmation.kind === "edit" ? <Impact root={root} plan={confirmation.value} selectedPath={selectedPath} onSelectPath={setSelectedPath} /> : <>
            <RebaseImpact plan={confirmation.value} />
            <h3>{t("Commit sequence")}</h3>
            {confirmation.steps?.length ? <ol>{confirmation.steps.map((step) =>
              <li key={step.hash}>{t(stepLabels[step.action])} <CommitHash hash={step.hash} /> {step.message ??
                confirmation.value.commits.find(({ hash }) => hash === step.hash)?.subject}</li>)}</ol>
              : <p>{t("No commits to replay.")}</p>}
          </>}
      </div>
    </Dialog>}
  </div>;
}
