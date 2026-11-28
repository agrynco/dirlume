import { useEffect, useState } from "react";
import { ArrowDownToLine, ArrowLeft, ArrowRight, Eye, GitCommitHorizontal, GitMerge as MergeIcon, Layers, Pencil, Play, X } from "lucide-react";
import { api, type GitConflictPreview, type GitMergeConflict, type GitMergeMode, type GitMergePlan,
  type GitMergeResolution, type GitMergeReview, type GitMergeSession, type GitMergeState, type GitOperation, type NamedFile } from "./api";
import { bookmarkFile } from "./fileBookmarks";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { GitActionButtons, useGitMenu, type GitAction } from "./GitActions";
import { writeError } from "./gitWriteError";
import { t } from "./i18n";

const sections = [["base", "Base"], ["ours", "Ours"], ["theirs", "Theirs"]] as const;
const resolutionLabels: Record<GitMergeResolution, string> = {
  ours: "Use ours", theirs: "Use theirs", working: "Stage working result",
};
const operationLabels: Record<GitOperation, { status: string; resume: string; abort: string }> = {
  merge: { status: "Merge in progress", resume: "Continue merge", abort: "Abort merge" },
  cherryPick: { status: "Cherry-pick in progress", resume: "Continue cherry-pick", abort: "Abort cherry-pick" },
  revert: { status: "Revert in progress", resume: "Continue revert", abort: "Abort revert" },
  rebase: { status: "Rebase in progress", resume: "Continue rebase", abort: "Abort rebase" },
};

export function gitOperationStatus(operation: GitOperation) {
  return operationLabels[operation].status;
}

type Confirmation = { action: "start"; mode: GitMergeMode; review: GitMergeReview } |
  { action: "finish"; abort: boolean; session: GitMergeSession };

function Conflict({ root, state, conflict, busy, actions, onOpen, canEdit }: {
  root: string; state: GitMergeState; conflict: GitMergeConflict; busy: boolean;
  actions: (conflict: GitMergeConflict, disabled?: boolean) => GitAction[];
  onOpen: (file: NamedFile, editing: boolean) => void;
  canEdit: (file: NamedFile) => boolean;
}) {
  const menu = useGitMenu();
  const [preview, setPreview] = useState<GitConflictPreview | null>(null);
  const [error, setError] = useState("");
  const [section, setSection] = useState<keyof Pick<GitConflictPreview, "base" | "ours" | "theirs">>("ours");
  useEffect(() => {
    let canceled = false;
    void api.gitInspectMerge(root, state.session, conflict).then((value) => { if (!canceled) setPreview(value); },
      (error: unknown) => { if (!canceled) setError(writeError(error)); });
    return () => { canceled = true; };
  }, [root, state, conflict]);
  const file = preview?.workingPath ? bookmarkFile(preview.workingPath) : null;
  const blob = preview?.[section];
  const versions = sections.map(([name, label]) => ({
    label, icon: Layers, pressed: section === name, run: () => setSection(name),
  }));
  const resolution: GitAction[] = [
    ...(file && canEdit(file) ? [{ label: "Edit working result", icon: Pencil, disabled: busy, run: () => onOpen(file, true) }] : []),
    ...actions(conflict, !preview),
  ];
  return <section aria-label={t("Conflict versions")} tabIndex={-1} {...menu([...versions, ...resolution])}>
    <h3>{conflict.path}</h3>
    <div className="git-branch-actions">
      <GitActionButtons actions={versions} />
    </div>
    {error ? <p role="alert">{error}</p> : !preview ? <p role="status">{t("Reading change…")}</p> :
      blob?.text !== null && blob?.text !== undefined
        ? <pre tabIndex={0} className="git-patch" aria-label={t("Conflict version text")}>{blob.text}</pre>
        : <p>{t(!blob ? "This path is absent on this side." : blob.fallback === "oversized"
          ? "This change is too large to preview." : "A text diff is unavailable for this change.")}</p>}
    <div className="git-branch-actions">
      <GitActionButtons actions={resolution} />
    </div>
  </section>;
}

export function GitMerge({ root, source, state, refresh, onRefresh, onOpen, canEdit }: {
  root: string; source: string; state: GitMergeState | null; refresh: number; onRefresh: () => void;
  onOpen: (file: NamedFile, editing: boolean) => void; canEdit: (file: NamedFile) => boolean;
}) {
  const menu = useGitMenu();
  const [plan, setPlan] = useState<GitMergePlan | null>(null);
  const [queryError, setQueryError] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [resolution, setResolution] = useState<{ conflict: GitMergeConflict; method: GitMergeResolution; session: GitMergeSession }>();
  useEffect(() => {
    if (state || !source) return;
    let canceled = false;
    setPlan(null);
    setQueryError("");
    void api.gitMergePlan(root, source).then((value) => { if (!canceled) setPlan(value); },
      (error: unknown) => { if (!canceled) setQueryError(writeError(error)); });
    return () => { canceled = true; };
  }, [root, source, state, refresh]);
  async function execute(action: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(writeError(error));
    } finally {
      setPending(false);
      onRefresh();
    }
  }
  const selection = state?.conflicts.find(({ path }) => path === selected) ?? state?.conflicts[0];
  const labels = operationLabels[state?.session.operation ?? "merge"];
  const confirmLabels = confirmation?.action === "finish" ? operationLabels[confirmation.session.operation] : labels;
  const reviewTitle = confirmation?.action === "finish" ? confirmation.abort ? confirmLabels.abort : confirmLabels.resume :
    confirmation?.mode === "fastForward" ? "Fast-forward only" : "Create merge commit";
  function applyReview() {
    setConfirmation(undefined);
    if (confirmation?.action === "finish") {
      void execute(() => api.gitFinishMerge(root, confirmation.session, confirmation.abort));
    } else if (confirmation) {
      void execute(() => api.gitStartMerge(root, confirmation.review, confirmation.mode));
    }
  }
  const operationActions: GitAction[] = state ? [
    { label: labels.resume, icon: Play, disabled: pending || state.conflicts.length > 0,
      run: () => setConfirmation({ action: "finish", abort: false, session: state.session }) },
    { label: labels.abort, icon: X, disabled: pending, destructive: true,
      run: () => setConfirmation({ action: "finish", abort: true, session: state.session }) },
  ] : plan && !plan.upToDate ? [
    { label: "Fast-forward only", icon: MergeIcon, disabled: pending || !plan.fastForward,
      run: () => setConfirmation({ action: "start", mode: "fastForward", review: plan.review }) },
    { label: "Create merge commit", icon: GitCommitHorizontal, disabled: pending,
      run: () => setConfirmation({ action: "start", mode: "mergeCommit", review: plan.review }) },
  ] : [];
  function conflictActions(conflict: GitMergeConflict, disabled = false): GitAction[] {
    return ([["working", ArrowDownToLine], ["ours", ArrowLeft], ["theirs", ArrowRight]] as const).map(([method, icon]) => ({
      label: resolutionLabels[method], icon, disabled: pending || disabled || !state, destructive: method !== "working",
      run: () => {
        if (!state) return;
        setSelected(conflict.path);
        setResolution({ conflict, method, session: state.session });
      },
    }));
  }
  return <div className="git-scroll git-revision-comparison" tabIndex={-1}
    {...menu(operationActions)}>
    <p><code>{root}</code></p>
    {error && <p role="alert">{error}</p>}
    {state ? <>
      <p role="status">{t(labels.status)}</p>
      <p><code title={state.session.head}>{state.session.head.slice(0, 12)}</code>
        {" ← "}{state.session.sources.map((hash) => <code key={hash} title={hash}>{hash.slice(0, 12)}{" "}</code>)}</p>
      <div className="git-branch-actions">
        <GitActionButtons actions={operationActions} />
      </div>
      <section aria-label={t("Unresolved paths")}>
        <h3>{t("Unresolved paths")}</h3>
        {state.conflicts.length ? <ul>{state.conflicts.map((conflict) => <li key={conflict.path}>
          <Button aria-pressed={selection?.path === conflict.path} onClick={() => setSelected(conflict.path)}
            {...menu([{ label: "Show conflict", icon: Eye, run: () => setSelected(conflict.path) },
              ...conflictActions(conflict)], conflict.path)}>{conflict.path}</Button>
        </li>)}</ul> : <p>{t("All conflicts are resolved.")}</p>}
      </section>
      {selection && <Conflict key={JSON.stringify([state.session, selection])} root={root} state={state} conflict={selection} busy={pending}
        actions={conflictActions} onOpen={onOpen} canEdit={canEdit} />}
    </> : !source ? <p>{t("Select a source branch to merge.")}</p> :
      queryError ? <p role="alert">{queryError}</p> : !plan ? <p role="status">{t("Reading Git repository…")}</p> : <>
        <dl><dt>{t("Source branch")}</dt><dd>{plan.review.sourceRef} <code>{plan.review.sourceTip.slice(0, 12)}</code></dd>
          <dt>{t("Current branch")}</dt><dd>{plan.review.headRef} <code>{plan.review.head.slice(0, 12)}</code></dd></dl>
        <h3>{t("Changed paths on the source branch")}</h3>
        {plan.changes.length ? <ul>{plan.changes.map(({ path, previousPath }) =>
          <li key={path}>{previousPath ? previousPath + " → " + path : path}</li>)}</ul> : <p>{t("No changed paths.")}</p>}
        {plan.upToDate ? <p>{t("The current branch already contains the source branch.")}</p> :
          <div className="git-branch-actions">
            <GitActionButtons actions={operationActions} />
          </div>}
      </>}
    {confirmation && <Dialog title={t(reviewTitle)} helpTopic="gitView" onClose={() => setConfirmation(undefined)}
      footer={<><Button data-initial-focus={confirmation.action === "finish" && confirmation.abort || undefined}
        onClick={() => setConfirmation(undefined)}>{t("Cancel")}</Button>
        <Button className={confirmation.action === "finish" && confirmation.abort ? "negative" : undefined}
          onClick={applyReview}>{t(reviewTitle)}</Button></>}>
      <div className="dialog-body git-tools-review">
      <p><code>{root}</code></p>
      {confirmation.action === "finish"
        ? <p>{t(confirmation.abort ? "Abort the active operation and discard changes made to resolve it." : "Continue the active Git operation.")}</p>
        : <p>{confirmation.review.sourceRef} → {confirmation.review.headRef}</p>}
      </div>
    </Dialog>}
    {resolution && <Dialog title={t(resolutionLabels[resolution.method])} helpTopic="gitView"
      onClose={pending ? undefined : () => setResolution(undefined)} footer={<>
        <Button disabled={pending} data-initial-focus={resolution.method !== "working" || undefined}
          onClick={() => setResolution(undefined)}>{t("Cancel")}</Button>
        <Button disabled={pending} className={resolution.method === "working" ? undefined : "negative"} onClick={() => {
          setResolution(undefined);
          void execute(() => api.gitResolveMerge(root, resolution.session, resolution.conflict, resolution.method));
        }}>{t(resolutionLabels[resolution.method])}</Button>
      </>}>
      <div className="dialog-body git-tools-review">
        <p><code>{root}</code></p><p>{resolution.conflict.path}</p>
        {resolution.method !== "working" && <p>{t(resolution.conflict[resolution.method]
          ? "This replaces the working result with the selected version."
          : "This side deleted the path. Confirm to remove it from the result.")}</p>}
      </div>
    </Dialog>}
  </div>;
}
