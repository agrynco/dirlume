import { useEffect, useId, useState, type FormEvent } from "react";
import { api, describeError, type DesktopShare } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { errorText, t } from "./i18n";
import { PathField } from "./PathField";

export function ShareFolderDialog({ initialPath, onClose }: { initialPath: string; onClose: () => void }) {
  const [path, setPath] = useState(initialPath);
  const [address, setAddress] = useState("");
  const [share, setShare] = useState<DesktopShare | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const field = useId();
  useEffect(() => {
    let canceled = false;
    void Promise.all([api.activeDesktopShare(), api.suggestShareAddress()]).then(([share, address]) => {
      if (canceled) return;
      setShare(share);
      setAddress((current) => current || address || "");
    }, (error: unknown) => { if (!canceled) setError(describeError(error)); }).finally(() => {
      if (!canceled) setLoading(false);
    });
    return () => { canceled = true; };
  }, []);

  async function start(event: FormEvent) {
    event.preventDefault();
    if (busy || loading || share) return;
    setBusy(true);
    setError("");
    try {
      setShare(await api.startDesktopShare(path, address));
    } catch (error) {
      setError(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    setError("");
    try {
      await api.stopDesktopShare();
      setShare(null);
      setCopied(false);
    } catch (error) {
      setError(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!share) return;
    setError("");
    setCopied(false);
    try {
      await api.copyText(share.invitation);
      setCopied(true);
    } catch (error) {
      setError(describeError(error));
    }
  }

  return <Dialog title={t("Share a folder")} helpTopic="remote" onClose={() => { if (!busy) onClose(); }}>
    <form className="dialog-form" onSubmit={(event) => { void start(event); }}>
      <div className="dialog-body share-folder-form">
        {loading ? <p role="status">{t("Checking sharing status…")}</p> : share ? <>
          <p role="status">{t("Sharing this folder for browsing and downloads.")}</p>
          <p><strong>{share.path}</strong></p>
          <p>{share.address}</p>
          <p>{t("Send the invitation to someone on your local network. They can open it in Dirlume using Connect. Stopping the share revokes access.")}</p>
          {copied && <p role="status">{t("Invitation copied.")}</p>}
        </> : <>
          <p>{t("Share one folder for browsing and downloads on your local network.")}</p>
          <label className="field" htmlFor={field}>{t("Folder to share")}
            <PathField id={field} label={t("Folder to share")} value={path} onChange={setPath}
              browse="folder" required initialFocus readOnly={busy} />
          </label>
          <label className="field">{t("Local network IP address")}
            <input value={address} onChange={(event) => setAddress(event.target.value)}
              placeholder="192.168.1.10" autoComplete="off" spellCheck={false} readOnly={busy} required />
          </label>
        </>}
        {error && <p className="dialog-error" role="alert">{errorText(error)}</p>}
      </div>
      <footer className="dialog-footer">
        {share ? <>
          <Button type="button" disabled={busy} onClick={() => { void stop(); }}>{t("Stop sharing")}</Button>
          <Button type="button" className="primary" disabled={busy} onClick={() => { void copy(); }}>{t("Copy invitation")}</Button>
        </> : <Button type="submit" className="primary" disabled={loading || busy || !path.trim() || !address.trim()}>
          {busy ? t("Starting sharing…") : t("Start sharing")}
        </Button>}
      </footer>
    </form>
  </Dialog>;
}
