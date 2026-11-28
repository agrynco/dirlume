import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { GitBranch, GitCompareArrows, Network, Search } from "lucide-react";
import { api, type GitBranch as Branch, type GitCommit, type GitGraphCommit, type GitGraphPage, type GitRepository } from "./api";
import { Button } from "./Button";
import { GitActionButtons, useGitMenu, type GitAction } from "./GitActions";
import { RevisionInput } from "./GitRevisionComparison";
import { t } from "./i18n";

type Revision = { value: string; label: string; exact?: boolean };
type Pair = { base?: Revision; target?: Revision };
type Scope = { base: Revision } & ({ mode: "branch" } | { mode: "upstream" | "compare"; target: Revision });
type Lane = { hash: string; color: number };
type Edge = { parent: string; from: number; to: number; color: number };
type GraphRow = {
  commit: GitGraphCommit;
  node: number;
  color: number;
  incoming: boolean;
  parallel: { column: number; color: number }[];
  edges: Edge[];
  outside: string[];
  after: { column: number; color: number }[];
};

const laneSpacing = 15;
const x = (column: number) => 9 + column * laneSpacing;
const laneColor = (color: number) => `var(--git-lane-${color % 5})`;

function layoutGraph(commits: GitGraphCommit[]) {
  const order = new Map(commits.map(({ hash }, index) => [hash, index]));
  const lanes: (Lane | null)[] = [];
  let width = 1;
  let nextColor = 0;
  const rows = commits.map((commit, row): GraphRow => {
    const previous = lanes.findIndex((lane) => lane?.hash === commit.hash);
    const free = lanes.indexOf(null);
    const node = previous >= 0 ? previous : free >= 0 ? free : lanes.length;
    const color = lanes[node]?.color ?? nextColor++;
    const parallel = lanes.flatMap((lane, column) => lane && column !== node ? [{ column, color: lane.color }] : []);
    lanes[node] = null;
    const edges: Edge[] = [];
    const outside: string[] = [];
    for (const parent of commit.parents) {
      if ((order.get(parent) ?? -1) <= row) {
        outside.push(parent);
        continue;
      }
      let to = lanes.findIndex((lane) => lane?.hash === parent);
      if (to < 0) {
        const free = lanes.indexOf(null);
        to = edges.length === 0 && !lanes[node] ? node : free < 0 ? lanes.length : free;
        lanes[to] = { hash: parent, color: to === node ? color : nextColor++ };
      }
      edges.push({ parent, from: node, to, color: lanes[to]!.color });
    }
    const after = lanes.flatMap((lane, column) => lane ? [{ column, color: lane.color }] : []);
    width = Math.max(width, node + 1, lanes.length);
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    return { commit, node, color, incoming: previous >= 0, parallel, edges, outside, after };
  });
  return { rows, width: x(width) + 4 };
}

function LaneLines({ row }: { row: GraphRow }) {
  const hash = row.commit.hash;
  return <span className="git-graph-lanes" aria-hidden="true">
    {row.parallel.map(({ column, color }) => <span key={column} className="git-lane-through"
      style={{ left: x(column), color: laneColor(color) }} />)}
    {row.incoming && <span className="git-lane-incoming" style={{ left: x(row.node), color: laneColor(row.color) }} />}
    {row.edges.map(({ parent, from, to, color }) => <span key={parent} data-graph-edge={hash + ":" + parent}
      className={"git-lane-edge" + (to < from ? " to-left" : "")}
      style={{ left: x(Math.min(from, to)), width: Math.abs(x(from) - x(to)) + 2, color: laneColor(color) }} />)}
    {row.outside.length > 0 && <span className="git-lane-outside" style={{ left: x(row.node), color: laneColor(row.color) }} />}
    <span className="git-lane-node" style={{ left: x(row.node), color: laneColor(row.color) }} />
  </span>;
}

function revisionName(revision: string) {
  return revision.replace(/^refs\/(heads|remotes|tags)\//, "");
}

function formPair(form: HTMLFormElement | null): Pair {
  if (!form) return {};
  const data = new FormData(form);
  function choice(label: string): Revision | undefined {
    const value = String(data.get(label) ?? "").trim();
    if (!value) return;
    const selected = String(data.get(label + " kind") ?? "");
    return { value: selected.startsWith("refs/") ? selected : value,
      label: selected ? revisionName(selected) : value.slice(0, 12), exact: !selected };
  }
  return { base: choice("Base revision"), target: choice("Target revision") };
}

function GraphResults({ repository, scope, search, commitActions, renderDetails, onUseRevision }: {
  repository: GitRepository;
  scope: Scope;
  search: string;
  commitActions: (commit: GitCommit, showDetails: () => void) => GitAction[];
  renderDetails: (commit: GitCommit) => ReactNode;
  onUseRevision: (side: keyof Pair, commit: GitCommit) => void;
}) {
  const menu = useGitMenu();
  const [page, setPage] = useState<GitGraphPage>();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const alive = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ hash: string; offset: number }>(null);
  const { root } = repository;
  const base = scope.base.value;
  const target = scope.mode === "branch" ? null : scope.target.value;
  useEffect(() => {
    let canceled = false;
    alive.current = true;
    setError(false);
    setLoading(true);
    void api.gitCommitGraph(root, { base, target, search, offset: 0 })
      .then((result) => { if (!canceled) setPage(result); }, () => { if (!canceled) setError(true); })
      .finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; alive.current = false; };
  }, [root, base, target, search, attempt]);
  useLayoutEffect(() => {
    const remembered = anchor.current;
    const list = scroller.current;
    if (!remembered || !list) return;
    anchor.current = null;
    const row = list.querySelector<HTMLElement>(`[data-commit="${remembered.hash}"]`);
    if (row) list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - remembered.offset;
  }, [page]);
  async function loadMore() {
    if (!page || page.nextOffset === null || loading) return;
    setError(false);
    setLoading(true);
    try {
      const next = await api.gitCommitGraph(root, { base: page.base, target: page.target, search, offset: page.nextOffset });
      if (!alive.current) return;
      const list = scroller.current;
      if (list) {
        const top = list.getBoundingClientRect().top;
        const visible = Array.from(list.querySelectorAll<HTMLElement>("[data-commit]"))
          .find((row) => row.getBoundingClientRect().bottom > top);
        if (visible?.dataset.commit) anchor.current = { hash: visible.dataset.commit, offset: visible.getBoundingClientRect().top - top };
      }
      const hashes = new Set(page.commits.map(({ hash }) => hash));
      setPage({ ...next, commits: [...page.commits, ...next.commits.filter(({ hash }) => !hashes.has(hash))] });
    } catch {
      if (alive.current) setError(true);
    } finally {
      if (alive.current) setLoading(false);
    }
  }
  const layout = useMemo(() => layoutGraph(page?.commits ?? []), [page]);
  const refs = useMemo(() => {
    const tips = new Map<string, Branch[]>();
    for (const branch of repository.branches) {
      const atTip = tips.get(branch.tip);
      if (atTip) atTip.push(branch);
      else tips.set(branch.tip, [branch]);
    }
    return tips;
  }, [repository.branches]);
  return <>
    {error && <p role="alert" className="git-error">{t(target ? "Could not read this comparison. Check both local revisions and retry." :
      "Could not read the commit graph. Retry or select a different branch.")}</p>}
    {loading && <p className="git-graph-status" role="status">{t("Loading commits…")}</p>}
    {page && !layout.rows.length && <p className="git-graph-status">{t(search ? "No matching commits." : "No commits yet")}</p>}
    {layout.rows.length > 0 && <div className="git-graph-scroll" ref={scroller} style={{ "--git-graph-width": `${layout.width}px` } as CSSProperties}>
      <ul className="git-graph-rows" aria-label={t("Commit graph")}>
        {layout.rows.map((row) => {
          const { commit } = row;
          const show = () => setExpanded(commit.hash);
          const commands = [
            ...commitActions(commit, show),
            { label: "Use as base", icon: GitCompareArrows, run: () => onUseRevision("base", commit) },
            { label: "Use as target", icon: GitCompareArrows, run: () => onUseRevision("target", commit) },
          ];
          const side = commit.side === "base" ? scope.mode === "upstream" ? "Outgoing commit" : "Base only" :
            commit.side === "target" ? scope.mode === "upstream" ? "Incoming commit" : "Target only" : undefined;
          const open = expanded === commit.hash;
          return <li key={commit.hash} data-commit={commit.hash} data-graph-side={commit.side ?? undefined}>
            <Button className="git-graph-row" aria-expanded={open} tooltip={commit.subject}
              onClick={() => setExpanded(open ? undefined : commit.hash)} {...menu(commands, commit.shortHash)}>
              <LaneLines row={row} />
              <span className="git-graph-summary">
                <strong className="git-graph-subject">{commit.subject || t("No subject")}</strong>
                {(side || refs.has(commit.hash)) && <span className="git-graph-badges">
                  {side && <span className="git-graph-side">{t(side)}</span>}
                  {refs.get(commit.hash)?.map((ref) => <span key={ref.reference} className="git-graph-ref"
                    data-graph-ref={ref.reference}>{ref.name}</span>)}
                </span>}
              </span>
              {row.outside.length > 0 && <span className="git-graph-more-parents" aria-label={t("Parents outside current results")}
                data-tooltip={t("Parents outside current results")}>…</span>}
              <code title={commit.hash}>{commit.shortHash}</code>
            </Button>
            {open && <div className="git-graph-expanded">
              <span className="git-graph-lanes" aria-hidden="true">{row.after.map(({ column, color }) =>
                <span key={column} className="git-lane-through" style={{ left: x(column), color: laneColor(color) }} />)}</span>
              {renderDetails(commit)}
            </div>}
          </li>;
        })}
      </ul>
    </div>}
    {((page && page.nextOffset !== null) || error) && <div className="git-graph-footer">
      <Button type="button" disabled={loading} onClick={() => page ? void loadMore() : setAttempt(attempt + 1)}>
        {t(error ? "Retry" : "Load more")}
      </Button>
    </div>}
  </>;
}

export function GitCommitGraph({ repository, tip, branch, commitActions, renderDetails }: {
  repository: GitRepository;
  tip: string;
  branch?: Branch;
  commitActions: (commit: GitCommit, showDetails: () => void) => GitAction[];
  renderDetails: (commit: GitCommit) => ReactNode;
}) {
  const menu = useGitMenu();
  const [upstream, setUpstream] = useState<{ tip: string; reference: string } | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [comparing, setComparing] = useState(false);
  const [draft, setDraft] = useState<Pair>({});
  const form = useRef<HTMLFormElement>(null);
  const focusComparison = useRef<"base" | "target" | "submit">(null);
  const branchScope: Scope = { mode: "branch", base: { value: tip, label: branch?.name ?? t("Detached HEAD") } };
  const [scope, setScope] = useState<Scope>(branchScope);
  const reference = branch?.remote ? undefined : branch?.reference;
  useEffect(() => {
    if (!reference) return;
    let canceled = false;
    void api.gitGraphUpstream(repository.root, reference)
      .then((value) => { if (!canceled) setUpstream(value); }, () => { if (!canceled) setUpstream(null); });
    return () => { canceled = true; };
  }, [repository.root, reference]);
  useLayoutEffect(() => {
    const focus = focusComparison.current;
    if (!focus || !form.current) return;
    const control = focus === "submit" ? form.current.querySelector<HTMLButtonElement>("button[type=submit]") :
      form.current.elements.namedItem(focus === "base" ? "Base revision kind" : "Target revision kind");
    if (control instanceof HTMLElement) control.focus();
    focusComparison.current = null;
  }, [comparing, draft]);
  function useRevision(side: keyof Pair, commit: GitCommit) {
    const pair = form.current ? formPair(form.current) : scope.mode === "branch" ? draft : { base: scope.base, target: scope.target };
    const next = { ...pair, [side]: { value: commit.hash, label: commit.shortHash, exact: true } };
    focusComparison.current = !next.base ? "base" : !next.target ? "target" : "submit";
    setDraft(next);
    setComparing(true);
  }
  const viewActions: GitAction[] = [
    { label: "Selected branch", icon: GitBranch, pressed: scope.mode === "branch" && !comparing,
      run: () => { setScope(branchScope); setComparing(false); } },
    ...(upstream ? [{ label: "Show upstream", icon: Network, pressed: scope.mode === "upstream" && !comparing,
      run: () => {
        setScope({ mode: "upstream", base: branchScope.base, target: { value: upstream.tip, label: revisionName(upstream.reference) } });
        setComparing(false);
      } }] : []),
    { label: "Compare revisions in graph", icon: GitCompareArrows, pressed: comparing || scope.mode === "compare",
      run: () => {
        if (!comparing && scope.mode !== "branch") setDraft({ base: scope.base, target: scope.target });
        setComparing(!comparing);
      } },
  ];
  return <div className="git-commit-graph" tabIndex={-1} {...menu(viewActions)}>
    <div className="git-branch-actions" role="group" aria-label={t("Graph history scope")}>
      <GitActionButtons actions={viewActions} />
    </div>
    {comparing && <form className="git-graph-compare" ref={form} onSubmit={(event) => {
      event.preventDefault();
      const { base, target } = formPair(event.currentTarget);
      if (base && target) {
        setDraft({ base, target });
        setScope({ mode: "compare", base, target });
      }
    }}>
      <RevisionInput key={"base:" + draft.base?.value} label="Base revision" choiceName="Base revision kind"
        initial={draft.base?.value} exact={draft.base?.exact} repository={repository} />
      <RevisionInput key={"target:" + draft.target?.value} label="Target revision" choiceName="Target revision kind"
        initial={draft.target?.value} exact={draft.target?.exact} repository={repository} />
      <Button type="submit" className="git-action"><GitCompareArrows aria-hidden="true" />{t("Compare")}</Button>
    </form>}
    <div className="git-graph-scope" aria-label={t("Graph revisions")}>
      <span>{t(scope.mode === "branch" ? "Selected branch" : "Base revision")} <code>{scope.base.label}</code></span>
      {scope.mode !== "branch" && <span>{t(scope.mode === "upstream" ? "Upstream branch" : "Target revision")} <code>{scope.target.label}</code></span>}
    </div>
    <form className="git-graph-search" onSubmit={(event) => { event.preventDefault(); setSearch(searchInput.trim()); }}>
      <label className="field">{t("Search commit messages")}
        <input type="search" value={searchInput} maxLength={200} onChange={(event) => {
          setSearchInput(event.target.value);
          if (!event.target.value.trim()) setSearch("");
        }} />
      </label>
      <Button type="submit" className="git-action"><Search aria-hidden="true" />{t("Search")}</Button>
    </form>
    <GraphResults key={JSON.stringify([scope, search])} repository={repository} scope={scope} search={search}
      commitActions={commitActions} renderDetails={renderDetails} onUseRevision={useRevision} />
  </div>;
}
