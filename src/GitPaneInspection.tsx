import { useCallback, useEffect, useState } from "react";
import { api, type GitFileContent, type GitFileHistoryPage, type GitPaneFileDiff, type GitPaneSource, type GitTextVersions } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { GitFileVersions } from "./GitFileVersions";
import { gitChangeLabel, type GitPaneAction } from "./gitPane";
import { t } from "./i18n";
import { ReadOnlyFileComparison, type ComparisonShortcuts } from "./TextTools";

export interface GitPaneTarget {
  action: GitPaneAction;
  source: GitPaneSource;
  root: string;
  path: string;
  previousPath?: string;
  head: string | null;
}

const titles: Record<GitPaneAction, string> = { compare: "Compare with HEAD", diff: "Show diff", history: "File history" };

function ContentHeading({ label, path, content }: { label: string; path: string; content: GitFileContent }) {
  return <div className="git-file-version-heading"><strong>{t(label)}</strong><span>{path}</span>
    {content.state !== "available" && <small>{t(content.state === "missing" ? "File absent at this revision." :
      content.state === "binary" ? "This revision contains binary data." : "This file revision exceeds the preview limit.")}</small>}
  </div>;
}

function Comparison({ versions, leftLabel, rightLabel, leftPath, rightPath, shortcuts }: {
  versions: GitTextVersions; leftLabel: string; rightLabel: string; leftPath: string; rightPath: string; shortcuts: ComparisonShortcuts;
}) {
  const left = <ContentHeading label={leftLabel} path={leftPath} content={versions.left} />;
  const right = <ContentHeading label={rightLabel} path={rightPath} content={versions.right} />;
  const isText = (item: GitFileContent) => item.state === "available" || item.state === "missing";
  if (!isText(versions.left) || !isText(versions.right)) return <div className="git-file-version-headings">{left}{right}</div>;
  return <ReadOnlyFileComparison {...shortcuts} markIdentical={versions.left.state === "available" && versions.right.state === "available"}
    left={{ text: versions.left.state === "available" ? versions.left.text : "", heading: left }}
    right={{ text: versions.right.state === "available" ? versions.right.text : "", heading: right }} />;
}

export function GitPaneInspection({ target, shortcuts, onClose }: { target: GitPaneTarget; shortcuts: ComparisonShortcuts; onClose: () => void }) {
  const { source, root, path, previousPath, action, head } = target;
  const [diffs, setDiffs] = useState<GitPaneFileDiff[]>();
  const [diffGroup, setDiffGroup] = useState<string>();
  const [versions, setVersions] = useState<GitTextVersions>();
  const [history, setHistory] = useState<GitFileHistoryPage>();
  const [selected, setSelected] = useState<string>();
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState(false);
  const readContent = useCallback((revision: string, path: string) => api.gitPaneRead(source, root, { kind: "revision", revision, path }), [source, root]);
  useEffect(() => {
    let current = true;
    setPending(true);
    setError(false);
    const operation = action === "diff" ? api.gitPaneRead(source, root, { kind: "diff", path, head }).then((value) => { if (current) setDiffs(value); }) :
      !head ? Promise.resolve() : action === "compare" ? api.gitPaneRead(source, root, { kind: "compare", path, previousPath, revision: head })
        .then((value) => { if (current) setVersions(value); }) :
        api.gitPaneRead(source, root, { kind: "history", path: previousPath ?? path, tip: head, offset }).then((value) => {
          if (!current) return;
          setHistory((previous) => ({ ...value, commits: offset && previous ? [...previous.commits, ...value.commits] : value.commits }));
          setSelected((previous) => previous ?? value.commits[0]?.hash);
        });
    void operation.catch(() => { if (current) setError(true); }).finally(() => { if (current) setPending(false); });
    return () => { current = false; };
  }, [source, root, path, previousPath, action, head, offset]);
  const diff = diffs?.find(({ change }) => change.group === diffGroup) ?? diffs?.[0];
  const comparison = history?.commits.find(({ hash }) => hash === selected);
  return <Dialog title={t(titles[action])} wide resizeKey="git-pane-inspection" helpTopic="gitView" fontZoom="compare" onClose={onClose}
    footer={<Button onClick={onClose}>{t("Close")}</Button>}>
    <div className="dialog-body git-pane-inspection">
      <p className="git-file-history-target"><strong>{path}</strong><small>{root}</small></p>
      {!head && action !== "diff" ? <p role="status">{t("This repository has no commits yet.")}</p> : <>
        {pending && <p role="status">{t("Reading change…")}</p>}
        {error && <p role="alert">{t("Could not read this change.")}</p>}
        {diffs?.length === 0 && <p>{t("No changes for this file.")}</p>}
        {diff && <>
          {diffs && diffs.length > 1 ? <label className="field">{t("Change to compare")}
            <select value={diff.change.group} onChange={(event) => setDiffGroup(event.target.value)}>
              {diffs.map(({ change }) => <option key={change.group} value={change.group}>{gitChangeLabel(change)}</option>)}
            </select>
          </label> : <p>{gitChangeLabel(diff.change)}</p>}
          {diff.versions ? <div className="git-working-comparison-result">
            <Comparison key={diff.change.group} versions={diff.versions} shortcuts={shortcuts} leftPath={diff.change.previousPath ?? path} rightPath={path}
              leftLabel={diff.change.group === "staged" && head ? "HEAD" : diff.change.group === "unstaged" ? "Index" : "Empty tree"}
              rightLabel={diff.change.group === "staged" ? "Index" : "Working file"} />
          </div> : <p>{t("A text diff is unavailable for this conflict.")}</p>}
        </>}
        {versions && <div className="git-working-comparison-result">
          <Comparison versions={versions} shortcuts={shortcuts} leftPath={previousPath ?? path} rightPath={path}
            leftLabel="HEAD" rightLabel="Working file" />
        </div>}
        {history && (history.commits.length ? <>
          <label className="field">{t("Selected revision")}
            <select value={selected ?? ""} onChange={(event) => setSelected(event.target.value)}>
              {history.commits.map(({ hash, shortHash, subject }) => <option key={hash} value={hash}>{shortHash} · {subject || t("No subject")}</option>)}
            </select>
          </label>
          {history.nextOffset !== null && <Button disabled={pending} onClick={() => setOffset(history.nextOffset!)}>{t("Load more")}</Button>}
          {comparison && <div className="git-working-comparison-result"><GitFileVersions root={root} shortcuts={shortcuts} readContent={readContent}
            left={{ revision: comparison.parent, path: comparison.change.previousPath ?? comparison.change.path,
              label: t(comparison.merge ? "First parent" : "Parent revision"), absent: comparison.change.status === "A" }}
            right={{ revision: comparison.hash, path: comparison.change.path, label: t("Selected revision"), absent: comparison.change.status === "D" }} showRevision /></div>}
        </> : <p>{t("No file history at this revision.")}</p>)}
      </>}
    </div>
  </Dialog>;
}
