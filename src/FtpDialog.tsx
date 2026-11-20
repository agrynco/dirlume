import { useState, type FormEvent } from "react";
import { describeError, type api, type FtpProfile } from "./api";
import { Button } from "./Button";
import { ConnectionProtocol, type ConnectionDraft } from "./ConnectionProtocol";
import { Dialog } from "./Dialog";
import { HistoryField } from "./HistoryField";
import { errorText, t } from "./i18n";

export function FtpProfileDialog({ profile, draft, onUseSftp, windowsCodePage, onSave, onClose }: {
  profile: FtpProfile | null;
  draft?: ConnectionDraft;
  onUseSftp?: (draft: ConnectionDraft) => void;
  windowsCodePage: number | null;
  onSave: (profile: Parameters<typeof api.saveFtpProfile>[0]) => Promise<void>;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(profile?.label ?? draft?.label ?? "");
  const [host, setHost] = useState(profile?.host ?? draft?.host ?? "");
  const [port, setPort] = useState(draft?.port ?? String(profile?.port ?? 21));
  const [username, setUsername] = useState(profile?.username ?? draft?.username ?? "");
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [codePage, setCodePage] = useState(profile?.codePage?.toString() ?? "");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setWorking(true);
    setError("");
    try {
      await onSave({
        id: profile?.id, label: label.trim(), host: host.trim().replace(/^\[(.*)\]$/, "$1"), port: Number(port), username: username.trim(),
        password: clearPassword ? "" : password || undefined,
        codePage: codePage && Number(codePage) !== 65001 ? Number(codePage) : null,
      });
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog title={profile ? t("Edit FTP connection") : t("Add FTP connection")} onClose={() => { if (!working) onClose(); }}>
      <form className="dialog-form" onSubmit={(event) => { void save(event); }} autoComplete="off">
        <div className="dialog-body ftp-fields" inert={working}>
          {onUseSftp && <ConnectionProtocol value="ftp" onChange={() => onUseSftp({ label, host, port, username })} />}
          <label className="field">{t("Connection name")}
            <HistoryField historyKey="ftp-name" aria-label={t("Connection name")} data-initial-focus required value={label} onValueChange={setLabel} />
          </label>
          <div className="ftp-host-row">
            <label className="field">{t("Server")}
              <HistoryField historyKey="ftp-host" aria-label={t("Server")} required spellCheck={false}
                placeholder="ftp.example.com" value={host} onValueChange={setHost} />
            </label>
            <label className="field">{t("Port")}
              <input required type="number" min={1} max={65535} value={port} onChange={(event) => setPort(event.target.value)} />
            </label>
          </div>
          <label className="field">{t("Username")}
            <HistoryField historyKey="ftp-username" aria-label={t("Username")} placeholder={t("Anonymous")}
              value={username} onValueChange={setUsername} spellCheck={false} />
          </label>
          <label className="field">{t("Password")}
            <input type="password" autoComplete="new-password" placeholder={profile ? t("Keep saved password") : undefined}
              value={password} disabled={clearPassword} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {profile && <label className="field-checkbox">
            <span>{t("Clear saved password")}</span>
            <input type="checkbox" checked={clearPassword} onChange={(event) => setClearPassword(event.target.checked)} />
          </label>}
          <div className="ftp-encoding-row">
            <label className="field">{t("Filename code page")}
              <input type="number" min={1} max={65535} placeholder="UTF-8" value={codePage}
                onChange={(event) => setCodePage(event.target.value)} />
            </label>
            {windowsCodePage && windowsCodePage !== 65001 && <Button type="button" onClick={() => setCodePage(String(windowsCodePage))}>
              {t("Use Windows code page")}
            </Button>}
          </div>
          <p className="search-hint">{t("Plain FTP sends credentials and files without encryption.")}</p>
          {error && <p className="dialog-error" role="alert">{errorText(error)}</p>}
        </div>
        <footer className="dialog-footer">
          <Button type="button" disabled={working} onClick={onClose}>{t("Cancel")}</Button>
          <Button type="submit" className="primary" disabled={working}>{working ? t("Saving…") : t("Save connection")}</Button>
        </footer>
      </form>
    </Dialog>
  );
}
