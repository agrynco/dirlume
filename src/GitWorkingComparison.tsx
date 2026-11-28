import { useState } from "react";
import { GitCompareArrows } from "lucide-react";
import type { GitRepository } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { GitFileVersions } from "./GitFileVersions";
import { RevisionInput } from "./GitRevisionComparison";
import type { ComparisonShortcuts } from "./TextTools";
import { t } from "./i18n";

export function GitWorkingComparison({ repository, path, head, onClose, shortcuts }: {
  repository: GitRepository; path: string; head: string; onClose: () => void; shortcuts: ComparisonShortcuts;
}) {
  const [selection, setSelection] = useState<{ revision: string; request: number }>();
  return <Dialog title={t("Compare with revision…")} wide resizeKey="git-working-revision" helpTopic="gitView" fontZoom="compare" onClose={onClose}
    footer={<Button onClick={onClose}>{t("Close")}</Button>}>
    <form className="dialog-body git-working-comparison" onSubmit={(event) => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      const picked = String(values.get("Comparison reference") ?? "");
      const revision = picked.startsWith("refs/") ? picked : String(values.get("Comparison revision") ?? "").trim();
      if (revision) setSelection((previous) => ({ revision, request: (previous?.request ?? 0) + 1 }));
    }}>
      <strong>{path}</strong>
      <div className="git-working-comparison-controls">
        <RevisionInput label="Comparison revision" choiceName="Comparison reference" initial={head}
          repository={{ ...repository, branches: repository.branches.filter(({ remote }) => !remote) }} />
        <Button type="submit" className="primary"><GitCompareArrows aria-hidden="true" />{t("Compare")}</Button>
      </div>
    </form>
    {selection && <div className="git-working-comparison-result">
      <GitFileVersions key={selection.request} root={repository.root} shortcuts={shortcuts}
        left={{ revision: selection.revision, label: t("Stored revision"), path }}
        right={{ revision: null, label: t("Working file"), path, working: true }} />
    </div>}
  </Dialog>;
}
