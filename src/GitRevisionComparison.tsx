import { useEffect, useState, type FormEvent } from "react";
import { api, type GitComparison, type GitDetails, type GitHistory, type GitRepository, type GitRevisionDiff } from "./api";
import { Button } from "./Button";
import { t } from "./i18n";

const fallbackLabels = {
  binary: "A text diff is unavailable for binary content.",
  conflict: "A text diff is unavailable for this conflict.",
  oversized: "This diff is too large to preview.",
  unsupported: "A text diff is unavailable for this change.",
};

function RevisionInput({ label, initial, repository }: { label: string; initial?: string; repository: GitRepository }) {
  const options = repository.branches.map(({ name, reference, tip }) => ({ name, reference, value: tip }));
  const tags = repository.tags ?? [];
  const [kind, setKind] = useState(() => options.find(({ value, reference }) => value === initial || reference === initial)?.reference ??
    (initial && initial === repository.head ? "HEAD" : ""));
  const value = options.find(({ reference }) => reference === kind)?.value ??
    (kind === "HEAD" ? repository.head ?? "" : kind);
  return <div>
    <label className="field">{t(label)}
      <select value={kind} onChange={(event) => setKind(event.target.value)}>
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

function UniqueCommits({ root, included, excluded, title, initial }: {
  root: string; included: string; excluded: string; title: string; initial: GitHistory;
}) {
  const [history, setHistory] = useState(initial);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(false);
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
      <code title={commit.hash}>{commit.shortHash}</code> {commit.subject || t("No subject")}
    </li>)}</ul> : <p>{t("No unique commits.")}</p>}
    {error && <p role="alert">{t("Could not read the Git repository.")}</p>}
    {history.nextOffset !== null && <Button disabled={working} onClick={() => void loadMore()}>{t("Load more")}</Button>}
  </section>;
}

function Patch({ root, result, change }: { root: string; result: GitComparison; change: GitDetails["changes"][number] }) {
  const [diff, setDiff] = useState<GitRevisionDiff | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let canceled = false;
    void api.gitRevisionDiff(root, result.base, result.target, change.path, change.previousPath)
      .then((value) => { if (!canceled) setDiff(value); }, () => { if (!canceled) setError(true); });
    return () => { canceled = true; };
  }, [root, result, change]);
  if (error) return <p role="alert">{t("Could not read the Git repository.")}</p>;
  if (!diff) return <p role="status">{t("Reading change…")}</p>;
  if (diff.fallback) return <p>{t(fallbackLabels[diff.fallback])}</p>;
  return <pre className="git-patch" tabIndex={0} aria-label={t("Inline diff")}><code>
    {diff.patch?.split("\n").map((line, index) => <span key={index}
      data-diff={line.startsWith("+") && !line.startsWith("+++") ? "added" :
        line.startsWith("-") && !line.startsWith("---") ? "removed" : undefined}>{line}{"\n"}</span>)}
  </code></pre>;
}

export function GitRevisionComparison({ repository, target }: { repository: GitRepository; target?: string }) {
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
      setResult(await api.gitCompareRevisions(repository.root, String(form.get("Base revision") ?? "").trim(),
        String(form.get("Target revision") ?? "").trim()));
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
      <Button type="submit" disabled={working}>{t("Compare")}</Button>
    </form>
    {working && <p role="status">{t("Loading commits…")}</p>}
    {error && <p role="alert">{t("Could not compare these revisions. Check both commit IDs or select branches or tags.")}</p>}
    {result && <>
      <div className="git-revision-commits">
        <UniqueCommits root={repository.root} included={result.base} excluded={result.target} title="Commits only in base" initial={result.baseOnly} />
        <UniqueCommits root={repository.root} included={result.target} excluded={result.base} title="Commits only in target" initial={result.targetOnly} />
      </div>
      <section aria-label={t("Changed paths")}>
        <h3>{t("Changed paths")}</h3>
        {result.changes.length > 0 ? <ul>{result.changes.map(({ status, path, previousPath }) => <li key={path}>
          <Button aria-pressed={selected === path} onClick={() => setSelected(selected === path ? null : path)}>
            <code>{status}</code> {previousPath ? previousPath + " → " + path : path}
          </Button>
        </li>)}</ul> : <p>{t("No changed paths.")}</p>}
        {diff && <Patch key={diff.path} root={repository.root} result={result} change={diff} />}
      </section>
    </>}
  </div>;
}
