import { useEffect, useState } from "react";
import { CloudDownload, Copy, GitCompareArrows, GitMerge, GitPullRequest, Network, Pencil, Tag, Trash2, Upload } from "lucide-react";
import { api, type GitRemote, type GitRemoteAction, type GitRepository, type GitUpstream } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { GitActionButtons, useGitMenu, type GitAction } from "./GitActions";
import { displayGitUrl } from "./GitRepositorySetup";
import { writeError } from "./gitWriteError";
import { t } from "./i18n";

const tabs = { remotes: "Remotes", upstream: "Upstream", refs: "Remote references" } as const;
const tabIcons = { remotes: Network, upstream: GitPullRequest, refs: Tag };
type Tab = keyof typeof tabs;
type SyncTarget = { reference?: string; action: "push" | "upstream" | "delete" };
const remoteLabels: Record<GitRemoteAction, string> = {
  add: "Add remote", rename: "Rename remote", setFetchUrl: "Change fetch URL", setPushUrl: "Change push URL",
  clearPushUrl: "Use fetch URL for pushes", remove: "Remove remote",
};
const refLabels = { branch: "Push branch", tag: "Push tag", deleteBranch: "Delete remote branch", deleteTag: "Delete remote tag" } as const;
type RefAction = keyof typeof refLabels;
type PullMethod = "merge" | "rebase";
type Review = { title: string; context: string[]; apply: () => Promise<string | void> };

function EditRemote({ root, remote, onReview, pending }: {
  root: string; remote?: GitRemote; onReview: (review: Review) => void; pending: boolean;
}) {
  const menu = useGitMenu();
  const [action, setAction] = useState<GitRemoteAction>("add");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const names = action === "add" || action === "rename";
  const urls = action === "add" || action === "setFetchUrl" || action === "setPushUrl";
  const blocked = action !== "add" && !remote || names && !name.trim() || urls && !url.trim();
  function prepare() {
    if (blocked) return;
    const newName = name.trim();
    const newUrl = urls ? url.trim() : null;
    onReview({
      title: remoteLabels[action],
      context: [action !== "add" ? remote?.name : undefined, names ? newName : undefined,
        newUrl ? displayGitUrl(newUrl) : undefined,
        action === "clearPushUrl" ? remote?.fetchUrls[0] : undefined].filter((value): value is string => !!value),
      apply: () => api.gitConfigureRemote(root, action, action === "add" ? null : remote ?? null, newName, newUrl),
    });
  }
  const review: GitAction = { label: "Review changes", icon: Pencil, disabled: pending || blocked,
    run: prepare, submit: true, destructive: action === "remove" };
  return <form {...menu([{ ...review, label: remoteLabels[action] }])}
    onSubmit={(event) => { event.preventDefault(); prepare(); }}>
    <label className="field">{t("Remote action")}
      <select value={action} disabled={pending} onChange={(event) => setAction(event.target.value as GitRemoteAction)}>
        {Object.entries(remoteLabels).map(([value, label]) => <option key={value} value={value} disabled={value !== "add" && !remote}>{t(label)}</option>)}
      </select>
    </label>
    {names && <label className="field">{t("Remote name")}
      <input value={name} disabled={pending} autoComplete="off" spellCheck={false} onChange={(event) => setName(event.target.value)} />
    </label>}
    {urls && <label className="field">{t(action === "setPushUrl" ? "Push URL" : "Fetch URL")}
      <input value={url} disabled={pending} autoComplete="off" spellCheck={false} onChange={(event) => setUrl(event.target.value)} />
    </label>}
    <GitActionButtons actions={[review]} />
  </form>;
}

export function GitSyncTools({ repository, refresh, initial, onRefresh, onCompare, onCopyRef, onPull }: {
  repository: GitRepository; refresh: number; onRefresh: () => void;
  initial?: SyncTarget;
  onCompare: (target: string) => void;
  onCopyRef: (reference: string) => void;
  onPull: (method: PullMethod, upstream: string) => void;
}) {
  const menu = useGitMenu();
  const root = repository.root;
  const [tab, setTab] = useState<Tab>(initial?.action === "upstream" ? "upstream" : initial ? "refs" : "remotes");
  const [remotes, setRemotes] = useState<GitRemote[]>();
  const [selected, setSelected] = useState("");
  const [upstream, setUpstream] = useState<GitUpstream>();
  const [desired, setDesired] = useState("");
  const [refAction, setRefAction] = useState<RefAction>(initial?.action === "delete" ?
    "deleteBranch" : initial?.reference?.startsWith("refs/tags/") ? "tag" : "branch");
  const [source, setSource] = useState(initial?.action === "push" ? initial.reference ?? "" : repository.headRef ?? "");
  const [destination, setDestination] = useState(initial?.action === "delete" ? "" :
    (initial?.reference ?? repository.headRef)?.replace(/^refs\/(heads|tags)\//, "") ?? "");
  const [review, setReview] = useState<Review>();
  const [pending, setPending] = useState(false);
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const remote = selected ? remotes?.find((item) => item.name === selected) : remotes?.[0];
  const upstreamRemote = remotes?.find((item) => item.name === upstream?.remote);
  const isTag = refAction === "tag" || refAction === "deleteTag";
  const deleting = refAction === "deleteBranch" || refAction === "deleteTag";
  const prefix = isTag ? "refs/tags/" : "refs/heads/";
  const localBranches = repository.branches.filter((branch) => !branch.remote);
  const localRefs = isTag ? repository.tags ?? [] : localBranches;
  useEffect(() => {
    let canceled = false;
    const fail = (error: unknown) => { if (!canceled) setError(writeError(error)); };
    void api.gitRemotes(root).then((values) => {
      if (canceled) return;
      setRemotes(values);
      if (initial?.action !== "delete" || !initial.reference) return;
      const reference = initial.reference;
      const matching = values.filter(({ name }) => reference.startsWith("refs/remotes/" + name + "/"))
        .sort((left, right) => right.name.length - left.name.length)[0];
      if (matching) {
        setSelected((current) => current || matching.name);
        setDestination((current) => current || reference.slice(("refs/remotes/" + matching.name + "/").length));
      } else setError(t("The remote reference no longer exists."));
    }, fail);
    void api.gitUpstream(root).then((value) => {
      if (!canceled) {
        setUpstream(value);
        setDesired(initial?.action === "upstream" ? initial.reference ?? "" : value.reference ?? "");
      }
    }, fail);
    return () => { canceled = true; };
  }, [root, refresh, initial]);

  async function execute() {
    if (!review || pending) return;
    setPending(true);
    setError("");
    setOutput("");
    try {
      const result = await review.apply();
      setOutput(result || t("Git operation completed."));
    } catch (error) {
      setError(writeError(error));
    } finally {
      setReview(undefined);
      setPending(false);
      onRefresh();
    }
  }

  function preparePull(method: PullMethod) {
    if (!upstream?.reference || !upstreamRemote) return;
    const reference = upstream.reference;
    setReview({
      title: method === "merge" ? "Pull by merge" : "Pull by rebase",
      context: [upstream.headRef ?? "HEAD", upstreamRemote.name, upstream.remoteRef ?? reference, ...upstreamRemote.fetchUrls],
      apply: async () => {
        const report = await api.gitFetchRemote(root, upstreamRemote, false);
        const actual = await api.gitUpstream(root);
        if (actual.head !== upstream.head || actual.headRef !== upstream.headRef || actual.reference !== reference) throw { kind: "stale" };
        if (!actual.tip) throw { kind: "failed", detail: "Fetch the upstream branch before comparing or pulling." };
        onPull(method, reference);
        return report;
      },
    });
  }

  function changeRefAction(value: RefAction) {
    setRefAction(value);
    const next = value === "tag" ? repository.tags?.[0]?.reference :
      value === "branch" ? repository.headRef ?? localBranches[0]?.reference : "";
    setSource(next ?? "");
    setDestination(next?.replace(/^refs\/(heads|tags)\//, "") ?? "");
  }

  async function inspectTransfer() {
    if (!remote || pending) return;
    setPending(true);
    setError("");
    setOutput("");
    try {
      const name = destination.trim();
      if (name.startsWith("refs/") && !name.startsWith(prefix)) {
        throw { kind: "failed", detail: "Enter a valid branch or tag reference." };
      }
      const inspected = await api.gitRemoteRefReview(root, remote, deleting ? null : source,
        name.startsWith(prefix) ? name : prefix + name);
      setReview({ title: refLabels[refAction], context: [remote.name, inspected.pushUrl, inspected.destination,
        inspected.object ?? inspected.deleteTip ?? ""],
      apply: () => api.gitTransferRemoteRef(root, inspected) });
    } catch (error) {
      setError(writeError(error));
    } finally {
      setPending(false);
    }
  }

  const tabActions: GitAction[] = (Object.keys(tabs) as Tab[]).map((name) => ({
    label: tabs[name], icon: tabIcons[name], pressed: tab === name, disabled: pending,
    run: () => { setTab(name); setError(""); setOutput(""); },
  }));
  const fetchActions: GitAction[] = remote ? [false, true].map((prune) => {
    const label = prune ? "Fetch and prune" : "Fetch remote";
    return { label, icon: CloudDownload, disabled: pending,
      run: () => setReview({ title: label, context: [remote.name, ...remote.fetchUrls],
        apply: () => api.gitFetchRemote(root, remote, prune) }) };
  }) : [];
  const upstreamActions: GitAction[] = upstream ? [
    { label: desired ? "Set upstream" : "Remove upstream", icon: Network, destructive: !desired,
      disabled: pending || !upstream.headRef || !upstream.head || (upstream.reference ?? "") === desired,
      run: () => setReview({ title: desired ? "Set upstream" : "Remove upstream", context: [upstream.headRef ?? "", desired || upstream.reference || ""],
        apply: () => api.gitSetUpstream(root, upstream, desired || null) }) },
    { label: "Compare upstream", icon: GitCompareArrows, disabled: pending || !upstream.tip,
      run: () => { if (upstream.tip) onCompare(upstream.reference ?? upstream.tip); } },
    ...(["merge", "rebase"] as const).map((method) => ({
      label: method === "merge" ? "Pull by merge" : "Pull by rebase", icon: method === "merge" ? GitMerge : GitPullRequest,
      disabled: pending || !upstreamRemote || !upstream.head, run: () => preparePull(method),
    })),
  ] : [];
  const refReview: GitAction = { label: refLabels[refAction], icon: deleting ? Trash2 : Upload,
    disabled: pending || !remote || !destination.trim() || !deleting && !source,
    destructive: deleting, run: () => void inspectTransfer(), submit: true };
  const refActions: GitAction[] = [
    ...(!deleting && source ? [
      { label: "Compare revisions", icon: GitCompareArrows, run: () => onCompare(source) },
      { label: "Copy reference", icon: Copy, run: () => onCopyRef(source) },
    ] : []),
    refReview,
  ];
  const destructiveReview = !!review && ["Remove upstream", "Remove remote", "Delete remote branch", "Delete remote tag"].includes(review.title);
  const remotePicker = <label className="field">{t("Remote")}
    <select value={remote?.name ?? ""} disabled={pending || !remotes?.length} onChange={(event) => setSelected(event.target.value)}>
      {remotes?.map(({ name }) => <option key={name}>{name}</option>)}
    </select>
  </label>;
  return <div className="git-scroll git-revision-comparison" aria-label={t("Synchronize repository")} tabIndex={-1}
    {...menu([...tabActions, ...(tab === "remotes" ? fetchActions : tab === "upstream" ? upstreamActions : refActions)])}>
    <p><code>{root}</code></p>
    <div className="git-branch-actions">
      <GitActionButtons actions={tabActions} />
    </div>
    {error && <p role="alert" className="git-write-feedback">{error}</p>}
    {pending && <p role="status">{t("Working with Git…")}</p>}
    {output && <pre className="git-patch" tabIndex={0} aria-label={t("Git output")}>{output}</pre>}
    {tab === "remotes" && <>
      {remotes?.length === 0 && <p>{t("No Git remotes are configured.")}</p>}
      {remote && <>
        {remotePicker}
        <dl><dt>{t("Fetch URL")}</dt><dd>{remote.fetchUrls.join("\n")}</dd>
          <dt>{t("Push URL")}</dt><dd>{remote.pushUrls.join("\n")}</dd></dl>
        <div className="git-branch-actions">
          <GitActionButtons actions={fetchActions} />
        </div>
      </>}
      {remotes && <EditRemote root={root} remote={remote} onReview={setReview} pending={pending} />}
      {!remotes && <p role="status">{t("Reading Git remotes…")}</p>}
    </>}
    {tab === "upstream" && (upstream ? <>
      <p>{upstream.headRef ?? t("Detached HEAD")}</p>
      {upstream.reference ? <p>{upstream.reference} · <code title={upstream.tip ?? ""}>{upstream.tip?.slice(0, 12) ?? t("Upstream tip unavailable")}</code></p>
        : <p>{t("No upstream is configured.")}</p>}
      <label className="field">{t("Upstream branch")}
        <select value={desired} disabled={pending || !upstream.headRef || !upstream.head} onChange={(event) => setDesired(event.target.value)}>
          <option value="">{t("No upstream")}</option>
          {repository.branches.filter(({ remote }) => remote).map(({ reference }) => <option key={reference}>{reference}</option>)}
          {upstream.reference && !repository.branches.some(({ reference }) => reference === upstream.reference) &&
            <option>{upstream.reference}</option>}
        </select>
      </label>
      <div className="git-branch-actions">
        <GitActionButtons actions={upstreamActions} />
      </div>
    </> : <p role="status">{t("Reading upstream…")}</p>)}
    {tab === "refs" && (remote ? <form {...menu(refActions)} onSubmit={(event) => { event.preventDefault(); void inspectTransfer(); }}>
      {remotePicker}
      <label className="field">{t("Reference action")}
        <select value={refAction} disabled={pending} onChange={(event) => changeRefAction(event.target.value as RefAction)}>
          {Object.entries(refLabels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select>
      </label>
      {!deleting && <label className="field">{t(isTag ? "Local tag" : "Local branch")}
        <select value={source} disabled={pending} onChange={(event) => {
          setSource(event.target.value);
          setDestination(event.target.value.replace(/^refs\/(heads|tags)\//, ""));
        }}>
          <option value="">{t("Select a reference")}</option>
          {localRefs.map(({ reference }) => <option key={reference} value={reference}>{reference}</option>)}
        </select>
      </label>}
      <label className="field">{t(isTag ? "Remote tag name" : "Destination branch")}
        <input autoComplete="off" spellCheck={false} value={destination} disabled={pending} onChange={(event) => setDestination(event.target.value)} />
      </label>
      <GitActionButtons actions={[{ ...refReview, label: "Review changes" }]} />
    </form> : <p>{t("No Git remotes are configured.")}</p>)}
    {review && <Dialog title={t(review.title)} helpTopic="gitView" onClose={pending ? undefined : () => setReview(undefined)}
      footer={<><Button disabled={pending} data-initial-focus={destructiveReview || undefined}
        onClick={() => setReview(undefined)}>{t("Cancel")}</Button>
        <Button disabled={pending} className={destructiveReview ? "negative" : undefined}
          onClick={() => void execute()}>{t(review.title)}</Button></>}>
      <div className="dialog-body git-tools-review">
      <p><code>{root}</code></p>
      {review.context.map((value, index) => <p key={index}><code>{value}</code></p>)}
      {review.title === "Pull by merge" || review.title === "Pull by rebase"
        ? <p>{t("Fetch the upstream and review the integration before changing the current branch.")}</p> : null}
      </div>
    </Dialog>}
  </div>;
}
