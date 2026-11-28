import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Eye } from "lucide-react";
import { api, type GitFileContent } from "./api";
import { Button } from "./Button";
import type { CompareRequest, DiffResult } from "./compare.worker";
import { Dialog } from "./Dialog";
import { DiffRows } from "./DiffRows";
import { GitActionButtons, type GitAction } from "./GitActions";
import { t } from "./i18n";

export type GitFileSide = { revision: string | null; path: string; label: string; absent?: boolean };
type FileVersion = GitFileSide & { content: GitFileContent };

const fallback = {
  missing: "File absent at this revision.",
  binary: "This revision contains binary data.",
  oversized: "This file revision exceeds the preview limit.",
};

async function readVersion(root: string, side: GitFileSide): Promise<FileVersion> {
  if (!side.revision || side.absent) return { ...side, content: { state: "missing" } };
  const value = await api.gitFileRevision(root, side.revision, side.path);
  return { ...side, ...value };
}

function VersionHeading({ side }: { side: FileVersion }) {
  return <div className="git-file-version-heading">
    <strong>{side.label}</strong>
    <code title={side.revision ?? undefined}>{side.revision?.slice(0, 12) ?? t("Empty tree")}</code>
    <span>{side.path}</span>
    {side.content.state !== "available" && <small>{t(fallback[side.content.state])}</small>}
  </div>;
}

export function GitFileVersions({ root, left, right, showRevision = false }: {
  root: string;
  left: GitFileSide;
  right: GitFileSide;
  showRevision?: boolean;
}) {
  const [versions, setVersions] = useState<{ left: FileVersion; right: FileVersion }>();
  const [diff, setDiff] = useState<DiffResult>();
  const [error, setError] = useState(false);
  const [group, setGroup] = useState(0);
  const [document, setDocument] = useState(false);
  const output = useRef<HTMLDivElement>(null);
  const { revision: leftRevision, path: leftPath, label: leftLabel, absent: leftAbsent } = left;
  const { revision: rightRevision, path: rightPath, label: rightLabel, absent: rightAbsent } = right;
  useEffect(() => {
    let active = true;
    setVersions(undefined);
    setDiff(undefined);
    setError(false);
    setGroup(0);
    void Promise.all([
      readVersion(root, { revision: leftRevision, path: leftPath, label: leftLabel, absent: leftAbsent }),
      readVersion(root, { revision: rightRevision, path: rightPath, label: rightLabel, absent: rightAbsent }),
    ]).then(([left, right]) => { if (active) setVersions({ left, right }); }, () => { if (active) setError(true); });
    return () => { active = false; };
  }, [root, leftRevision, leftPath, leftLabel, leftAbsent, rightRevision, rightPath, rightLabel, rightAbsent]);
  useEffect(() => {
    if (!versions) return;
    const { left, right } = versions;
    if ([left.content, right.content].some(({ state }) => state !== "available" && state !== "missing")) return;
    const before = left.content.state === "available" ? left.content.text : "";
    const after = right.content.state === "available" ? right.content.text : "";
    if (before === after) {
      setDiff({ blocks: [], groups: 0 });
      return;
    }
    let worker: Worker;
    const failed = () => setDiff({ error: "Could not compare the files." });
    try {
      worker = new Worker(new URL("./compare.worker.ts", import.meta.url), { type: "module" });
    } catch {
      failed();
      return;
    }
    worker.onmessage = (event: MessageEvent<DiffResult>) => { setDiff(event.data); worker.terminate(); };
    worker.onerror = () => { failed(); worker.terminate(); };
    worker.postMessage({ left: before, right: after, whitespace: false } satisfies CompareRequest);
    return () => { worker.onmessage = null; worker.onerror = null; worker.terminate(); };
  }, [versions]);
  const result = diff && !("error" in diff) ? diff : undefined;
  function jump(offset: number) {
    const count = result?.groups ?? 0;
    if (!count) return;
    const next = group ? (group - 1 + count + offset) % count + 1 : offset > 0 ? 1 : count;
    setGroup(next);
    const view = output.current;
    const row = view?.querySelector<HTMLElement>(`[data-change="${next}"]`);
    if (row && view) view.scrollTop += row.getBoundingClientRect().top - view.getBoundingClientRect().top;
  }
  if (error) return <p role="alert" className="git-file-feedback">{t("Could not read the file revision. Check that the revision is available locally.")}</p>;
  if (!versions) return <p role="status" className="git-file-feedback">{t("Reading change…")}</p>;
  const canCompare = [versions.left.content, versions.right.content].every(({ state }) => state === "available" || state === "missing");
  const canShow = versions.right.content.state === "available";
  const bothPresent = versions.left.content.state === "available" && canShow;
  const actions: GitAction[] = [
    { label: "Previous", icon: ArrowUp, disabled: !result?.groups, run: () => jump(-1) },
    { label: "Next", icon: ArrowDown, disabled: !result?.groups, run: () => jump(1) },
    ...(showRevision ? [{ label: "Show revision", icon: Eye, disabled: !canShow, run: () => setDocument(true) }] : []),
  ];
  return <div className="git-file-versions">
    <div className="git-file-version-headings" role="group" aria-label={t("Compared file revisions")}>
      <VersionHeading side={versions.left} />
      <VersionHeading side={versions.right} />
    </div>
    <div className="git-branch-actions">
      <GitActionButtons actions={actions} />
      {!!result?.groups && <span>{t("{0} / {1}", group, result.groups)}</span>}
    </div>
    {canCompare && !diff && <p className="git-file-feedback" role="status">{t("Reading change…")}</p>}
    {diff && "error" in diff && <p className="git-file-feedback" role="alert">{t(diff.error)}</p>}
    {result && result.groups === 0 && bothPresent && <p className="git-file-feedback">{t("The file contents are identical.")}</p>}
    {!!result?.groups && <div className="git-file-rows" ref={output} tabIndex={0} aria-label={t("Side-by-side revision diff")}>
      {result.blocks.map((block, index) => <DiffRows key={index} block={block} current={group} split connectors={false} ratio={0.5} />)}
    </div>}
    {document && versions.right.content.state === "available" && <Dialog title={t("Show revision")} wide helpTopic="gitView"
      onClose={() => setDocument(false)} footer={<Button onClick={() => setDocument(false)}>{t("Close")}</Button>}>
      <div className="dialog-body">
        <VersionHeading side={versions.right} />
        <pre className="git-patch" tabIndex={0} aria-label={t("File revision text")}>{versions.right.content.text}</pre>
      </div>
    </Dialog>}
  </div>;
}
