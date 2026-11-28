import { useState, type FormEvent, type ReactNode } from "react";
import { Copy, FileClock, GitCompareArrows, Search } from "lucide-react";
import { api, type GitCommit, type GitComparison, type GitDetails, type GitHistory, type GitRepository } from "./api";
import { Button } from "./Button";
import { useGitMenu, type GitAction } from "./GitActions";
import { GitFileVersions } from "./GitFileVersions";
import { t } from "./i18n";
import type { ComparisonShortcuts } from "./TextTools";

export function RevisionInput({ label, initial, repository, choiceName, exact = false }: {
  label: string; initial?: string; repository: GitRepository; choiceName?: string; exact?: boolean;
}) {
  const options = repository.branches.map(({ name, reference, tip }) => ({ name, reference, value: tip }));
  const tags = repository.tags ?? [];
  const [kind, setKind] = useState(() => exact ? "" : options.find(({ reference }) => reference === initial)?.reference ??
    options.find(({ value }) => value === initial)?.reference ??
    tags.find(({ reference }) => reference === initial)?.reference ?? (initial && initial === repository.head ? "HEAD" : ""));
  const value = options.find(({ reference }) => reference === kind)?.value ??
    (kind === "HEAD" ? repository.head ?? "" : kind);
  return <div>
    <label className="field">{t(label)}
      <select name={choiceName} value={kind} onChange={(event) => setKind(event.target.value)}>
        {repository.head && !options.some(({ value }) => value === repository.head) &&
          <option value="HEAD">{t("Checked out")}</option>}
        <optgroup label={t("Branches")}>
          {options.map(({ name, reference }) => <option key={reference} value={reference}>{name}</option>)}
        </optgroup>
        {tags.length > 0 && <optgroup label={t("Tags")}>
          {tags.map(({ name, reference }) => <option key={reference} value={reference}>{name}</option>)}
        </optgroup>}
        <option value="">{t("Enter commit ID")}</option>
      </select>
    </label>
    {kind ? <input type="hidden" name={label} value={value} /> : <label className="field">{t("Full commit ID")}
      <input autoComplete="off" spellCheck={false} name={label} defaultValue={initial} required />
    </label>}
  </div>;
}

function UniqueCommits({ root, included, excluded, title, initial, commitActions, renderDetails }: {
  root: string; included: string; excluded: string; title: string; initial: GitHistory;
  commitActions: (commit: GitCommit, showDetails?: () => void) => GitAction[];
  renderDetails: (commit: GitCommit) => ReactNode;
}) {
  const menu = useGitMenu();
  const [history, setHistory] = useState(initial);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState<string>();
  async function loadMore() {
    if (history.nextOffset === null || working) return;
    setError(false);
    setWorking(true);
    try {
      const page = await api.gitRevisionHistory(root, included, excluded, history.nextOffset);
      setHistory((current) => ({ commits: [...current.commits, ...page.commits], nextOffset: page.nextOffset }));
    } catch {
      setError(true);
    } finally {
      setWorking(false);
    }
  }
  return <section aria-label={t(title)}>
    <h3>{t(title)}</h3>
    {history.commits.length > 0 ? <ul>{history.commits.map((commit) => <li key={commit.hash}>
      <Button type="button" aria-expanded={expanded === commit.hash}
        onClick={() => setExpanded(expanded === commit.hash ? undefined : commit.hash)}
        {...menu(commitActions(commit, () => setExpanded(commit.hash)))}>
        <code title={commit.hash}>{commit.shortHash}</code> {commit.subject || t("No subject")}
      </Button>
      {expanded === commit.hash && renderDetails(commit)}
    </li>)}</ul> : <p>{t("No unique commits.")}</p>}
    {error && <p role="alert">{t("Could not read the Git repository.")}</p>}
    {history.nextOffset !== null && <Button disabled={working} onClick={() => void loadMore()}>{t("Load more")}</Button>}
  </section>;
}

export function GitRevisionChange({ root, base, target, change, shortcuts, reverse = false }: {
  root: string; base: string | null; target: string; change: GitDetails["changes"][number]; reverse?: boolean;
  shortcuts: ComparisonShortcuts;
}) {
  const before = { revision: base, path: change.previousPath ?? change.path, absent: !base || change.status === "A" };
  const after = { revision: target, path: change.path, absent: change.status === "D" };
  return <GitFileVersions root={root} shortcuts={shortcuts} left={{ ...(reverse ? after : before), label: t("Before") }}
    right={{ ...(reverse ? before : after), label: t("After") }} />;
}

export function GitRevisionComparison({ repository, target, commitActions, onInspectPath, renderDetails, onCopyPath, shortcuts }: {
  repository: GitRepository; target?: string;
  commitActions: (commit: GitCommit, showDetails?: () => void) => GitAction[];
  onInspectPath: (target: { path: string; tip: string; mode: "history" | "blame" }) => void;
  renderDetails: (commit: GitCommit) => ReactNode;
  onCopyPath: (path: string) => void;
  shortcuts: ComparisonShortcuts;
}) {
  const menu = useGitMenu();
  const [result, setResult] = useState<GitComparison | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(false);
  async function compare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working) return;
    const form = new FormData(event.currentTarget);
    setWorking(true);
    setError(false);
    setResult(null);
    setSelected(null);
    try {
      const result = await api.gitCompareRevisions(repository.root, String(form.get("Base revision") ?? "").trim(),
        String(form.get("Target revision") ?? "").trim());
      setResult(result);
    } catch {
      setError(true);
    } finally {
      setWorking(false);
    }
  }
  const diff = result?.changes.find(({ path }) => path === selected);
  return <div className="git-scroll git-revision-comparison">
    <form onSubmit={(event) => void compare(event)}>
      <RevisionInput label="Base revision" initial={repository.head ?? undefined} repository={repository} />
      <RevisionInput label="Target revision" initial={target ?? repository.head ?? undefined} repository={repository} />
      <Button type="submit" className="git-action" disabled={working}><GitCompareArrows aria-hidden="true" />{t("Compare")}</Button>
    </form>
    {working && <p role="status">{t("Loading commits…")}</p>}
    {error && <p role="alert">{t("Could not compare these revisions. Check both commit IDs or select branches or tags.")}</p>}
    {result && <>
      <div className="git-revision-commits">
        <UniqueCommits key={result.base + ":" + result.target} root={repository.root} included={result.base} excluded={result.target}
          title="Commits only in base" initial={result.baseOnly} commitActions={commitActions} renderDetails={renderDetails} />
        <UniqueCommits key={result.target + ":" + result.base + ":target"} root={repository.root} included={result.target} excluded={result.base}
          title="Commits only in target" initial={result.targetOnly} commitActions={commitActions} renderDetails={renderDetails} />
      </div>
      <section aria-label={t("Changed paths")}>
        <h3>{t("Changed paths")}</h3>
        {result.changes.length > 0 ? <ul>{result.changes.map(({ status, path, previousPath }) => <li key={path}>
          <Button aria-pressed={selected === path} onClick={() => setSelected(selected === path ? null : path)} {...menu([
            { label: "Show change", icon: GitCompareArrows, run: () => setSelected(path) },
            { label: "File history", icon: FileClock, run: () => onInspectPath({ path,
              tip: result.target, mode: "history" }) },
            { label: "Show blame", icon: Search, run: () => onInspectPath({ path: status === "D" ? previousPath ?? path : path,
              tip: status === "D" ? result.base : result.target, mode: "blame" }) },
            { label: "Copy path", icon: Copy, run: () => onCopyPath(path) },
          ])}>
            <code>{status}</code> {previousPath ? previousPath + " → " + path : path}
          </Button>
        </li>)}</ul> : <p>{t("No changed paths.")}</p>}
        {diff && <GitRevisionChange key={diff.path} root={repository.root} base={result.base} target={result.target} change={diff} shortcuts={shortcuts} />}
      </section>
    </>}
  </div>;
}
