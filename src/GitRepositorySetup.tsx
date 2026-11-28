import { useState } from "react";
import { api, type GitSetupAction } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { writeError, writeFailure } from "./gitWriteError";
import { t } from "./i18n";

const labels: Record<GitSetupAction, string> = { clone: "Clone repository", init: "Initialize repository", open: "Open existing repository" };

export function displayGitUrl(value: string) {
  try {
    const url = new URL(value);
    if (!url.hostname) return value;
    if (url.protocol !== "ssh:") url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

export function GitRepositorySetup({ initialPath, onOpen, onClose }: {
  initialPath: string; onOpen: (path: string) => void; onClose: () => void;
}) {
  const [action, setAction] = useState<GitSetupAction>("open");
  const [path, setPath] = useState(initialPath);
  const [url, setUrl] = useState("");
  const [review, setReview] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [partial, setPartial] = useState("");
  const title = review ? labels[action] : "Repository setup";
  const blocked = !path.trim() || action === "clone" && !url.trim();
  async function execute() {
    if (blocked || pending) return;
    if (!review) {
      setReview(true);
      return;
    }
    setPending(true);
    setError("");
    setPartial("");
    try {
      onOpen(await api.gitRepositorySetup(action, path.trim(), action === "clone" ? url.trim() : null));
    } catch (error) {
      const failure = writeFailure(error);
      if (failure?.kind === "partialClone" && failure.detail && typeof failure.detail === "object") {
        const detail = failure.detail as { path?: string; message?: string };
        setPartial(detail.path ?? path);
        setError(detail.message ?? writeError(error));
      } else {
        setError(writeError(error));
      }
      setReview(false);
    } finally {
      setPending(false);
    }
  }
  return <Dialog title={t(title)} helpTopic="gitView" onClose={pending ? undefined : onClose} footer={<>
    <Button disabled={pending} onClick={review ? () => setReview(false) : onClose}>{t(review ? "Back" : "Cancel")}</Button>
    <Button disabled={blocked || pending} onClick={() => void execute()}>{t(review ? labels[action] : "Review changes")}</Button>
  </>}>
    {error && <p role="alert" className="git-write-feedback">{error}</p>}
    {partial && <div>
      <p>{t("Git left a partial clone at {0}.", partial)}</p>
      <Button onClick={() => { setAction("open"); setPath(partial); setReview(true); }}>{t("Review opening the partial clone")}</Button>
    </div>}
    {review ? <>
      <p><code>{path}</code></p>
      {action === "clone" && <p><code>{displayGitUrl(url.trim())}</code></p>}
      {action === "init" && <p>{t("Initialize Git in this folder and keep its existing files.")}</p>}
    </> : <form className="git-stash-create" onSubmit={(event) => { event.preventDefault(); void execute(); }}>
      <label className="field">{t("Repository action")}
        <select value={action} onChange={(event) => { setAction(event.target.value as GitSetupAction); setError(""); }}>
          {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select>
      </label>
      {action === "clone" && <label className="field">{t("Repository URL or path")}
        <input value={url} autoComplete="off" spellCheck={false} onChange={(event) => setUrl(event.target.value)} />
      </label>}
      <label className="field">{t("Repository folder")}
        <input value={path} autoComplete="off" spellCheck={false} onChange={(event) => setPath(event.target.value)} />
      </label>
    </form>}
    {pending && <p role="status">{t("Working with Git…")}</p>}
  </Dialog>;
}
