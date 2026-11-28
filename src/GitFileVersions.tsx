import { useEffect, useState } from "react";
import { Eye } from "lucide-react";
import { api, type GitFileContent } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { GitActionButtons } from "./GitActions";
import { t } from "./i18n";
import { ReadOnlyFileComparison, type ComparisonShortcuts } from "./TextTools";

export type GitFileSide = { revision: string | null; path: string; label: string; absent?: boolean; working?: boolean };
type FileVersion = GitFileSide & { content: GitFileContent };

const fallback = {
  missing: "File absent at this revision.",
  binary: "This revision contains binary data.",
  oversized: "This file revision exceeds the preview limit.",
};
const workingFallback = {
  missing: "The working file is unavailable.",
  binary: "The working file contains binary data.",
  oversized: "The working file exceeds the preview limit.",
};

function comparable({ content, working }: FileVersion) {
  return content.state === "available" || !working && content.state === "missing";
}

async function readVersion(root: string, side: GitFileSide): Promise<FileVersion> {
  if (side.working) return { ...side, content: await api.gitWorkingFileContent(root, side.path) };
  if (!side.revision || side.absent) return { ...side, content: { state: "missing" } };
  const value = await api.gitFileRevision(root, side.revision, side.path);
  return { ...side, ...value };
}

function VersionHeading({ side }: { side: FileVersion }) {
  return <div className="git-file-version-heading">
    <strong>{side.label}</strong>
    {!side.working && <code title={side.revision ?? undefined}>{side.revision?.slice(0, 12) ?? t("Empty tree")}</code>}
    <span>{side.path}</span>
    {side.content.state !== "available" && <small>{t((side.working ? workingFallback : fallback)[side.content.state])}</small>}
  </div>;
}

export function GitFileVersions({ root, left, right, shortcuts, showRevision = false }: {
  root: string;
  left: GitFileSide;
  right: GitFileSide;
  shortcuts: ComparisonShortcuts;
  showRevision?: boolean;
}) {
  const [versions, setVersions] = useState<{ left: FileVersion; right: FileVersion }>();
  const [error, setError] = useState(false);
  const [document, setDocument] = useState(false);
  const { revision: leftRevision, path: leftPath, label: leftLabel, absent: leftAbsent } = left;
  const { revision: rightRevision, path: rightPath, label: rightLabel, absent: rightAbsent, working: rightWorking } = right;
  useEffect(() => {
    let active = true;
    setVersions(undefined);
    setError(false);
    void Promise.all([
      readVersion(root, { revision: leftRevision, path: leftPath, label: leftLabel, absent: leftAbsent }),
      readVersion(root, { revision: rightRevision, path: rightPath, label: rightLabel, absent: rightAbsent, working: rightWorking }),
    ]).then(([left, right]) => { if (active) setVersions({ left, right }); }, () => { if (active) setError(true); });
    return () => { active = false; };
  }, [root, leftRevision, leftPath, leftLabel, leftAbsent, rightRevision, rightPath, rightLabel, rightAbsent, rightWorking]);
  if (error) return <p role="alert" className="git-file-feedback">{t("Could not read the file revision. Check that the revision is available locally.")}</p>;
  if (!versions) return <p role="status" className="git-file-feedback">{t("Reading change…")}</p>;
  const canCompare = [versions.left, versions.right].every(comparable);
  const canShow = versions.right.content.state === "available";
  const bothPresent = versions.left.content.state === "available" && canShow;
  return <div className="git-file-versions">
    {showRevision && <div className="git-branch-actions">
      <GitActionButtons actions={[{ label: "Show revision", icon: Eye, disabled: !canShow, run: () => setDocument(true) }]} />
    </div>}
    {canCompare ? <ReadOnlyFileComparison {...shortcuts} markIdentical={bothPresent}
      left={{ text: versions.left.content.state === "available" ? versions.left.content.text : "", heading: <VersionHeading side={versions.left} /> }}
      right={{ text: versions.right.content.state === "available" ? versions.right.content.text : "", heading: <VersionHeading side={versions.right} /> }}
    /> : <div className="git-file-version-headings" role="group" aria-label={t("Compared file revisions")}>
      <VersionHeading side={versions.left} />
      <VersionHeading side={versions.right} />
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
