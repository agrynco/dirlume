import { open } from "@tauri-apps/plugin-dialog";
import { useState, type FormEvent } from "react";
import { api, describeError, type SshHostVerification, type SshProfile } from "./api";
import { Button } from "./Button";
import { ConnectionProtocol, type ConnectionDraft } from "./ConnectionProtocol";
import { Dialog } from "./Dialog";
import { HistoryField } from "./HistoryField";
import { errorText, t } from "./i18n";

export function VerifyHostDialog({ verification, testing, onCancel, onApprove }: {
  verification: SshHostVerification;
  testing?: boolean;
  onCancel: () => void;
  onApprove: () => void;
}) {
  return <Dialog title={t("Verify SSH server")} tone="warning" onClose={onCancel}>
    <div className="dialog-body">
      <p>{t("Verify the host key fingerprint for {0} on port {1} with your server administrator before connecting.",
        verification.host, verification.port)}</p>
      <p><code>{verification.fingerprint}</code></p>
      {testing && <p>{t("This approval applies only to this test.")}</p>}
    </div>
    <footer className="dialog-footer">
      <Button type="button" data-initial-focus onClick={onCancel}>{t("Cancel")}</Button>
      <Button type="button" className="alert-confirm" onClick={onApprove}>{t(testing ? "Verify and test" : "Trust and connect")}</Button>
    </footer>
  </Dialog>;
}

export function SshProfileDialog({ profile, draft, onUseFtp, sftp, onSave, onClose }: {
  profile: SshProfile | null;
  draft?: ConnectionDraft;
  onUseFtp?: (draft: ConnectionDraft) => void;
  sftp?: boolean;
  onSave: (input: Parameters<typeof api.saveSshProfile>[0]) => Promise<void>;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(profile?.label ?? draft?.label ?? "");
  const [connection, setConnection] = useState({
    host: profile?.host ?? draft?.host ?? "", port: draft?.port ?? String(profile?.port ?? 22),
    username: profile?.username ?? draft?.username ?? "",
    auth: profile?.auth.kind ?? "password", path: profile?.auth.kind === "privateKey" ? profile.auth.path : "",
    secret: "", clearSecret: false,
  });
  const { host, port, username, auth, path, secret, clearSecret } = connection;
  const [working, setWorking] = useState<"save" | "test">();
  const [error, setError] = useState("");
  const [verified, setVerified] = useState(false);
  const [verification, setVerification] = useState<SshHostVerification>();
  const useKey = auth === "privateKey";
  const savedSecret = profile?.hasSecret && profile.host === host.trim().replace(/^\[(.*)\]$/, "$1").toLowerCase() &&
    profile.port === Number(port) && profile.username === username.trim() && profile.auth.kind === auth &&
    (profile.auth.kind !== "privateKey" || profile.auth.path === path.trim());
  const numericPort = Number(port);
  const canTest = !!host.trim() && !!username.trim() && Number.isInteger(numericPort) && numericPort >= 1 && numericPort <= 65535 &&
    (useKey ? !!path.trim() : !!(secret || savedSecret));
  const input: Parameters<typeof api.saveSshProfile>[0] = {
    id: profile?.id, label, host, port: numericPort, username,
    auth: useKey ? { kind: "privateKey", path } : { kind: "password" },
    secret: secret || undefined, clearSecret: useKey && clearSecret,
  };

  function updateConnection(update: Partial<typeof connection>) {
    setConnection((current) => ({ ...current, ...update }));
    setVerified(false);
    setError("");
  }

  async function chooseKey() {
    try {
      const chosen = await open({ title: t("Select SSH private key") });
      if (chosen) updateConnection({ path: chosen });
    } catch (failure) {
      setError(describeError(failure));
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setWorking("save");
    setError("");
    try {
      await onSave(input);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setWorking(undefined);
    }
  }

  async function testConnection(approval?: SshHostVerification) {
    if (working || !canTest) return;
    setWorking("test");
    setVerification(undefined);
    setVerified(false);
    setError("");
    try {
      const result = await api.testSshConnection(input, approval);
      if (result.kind === "verifyHost") setVerification(result.verification);
      else setVerified(true);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setWorking(undefined);
    }
  }

  const title = sftp ? profile ? "Edit SFTP connection" : "Add SFTP connection" :
    profile ? "Edit SSH connection" : "Add SSH connection";
  return <><Dialog title={t(title)} onClose={() => { if (!working) onClose(); }}>
    <form className="dialog-form" onSubmit={(event) => { void save(event); }} autoComplete="off">
      <div className="dialog-body ftp-fields" inert={!!working}>
        {onUseFtp && <ConnectionProtocol value="sftp" onChange={() => onUseFtp({ label, host, port, username })} />}
        <label className="field">{t("Connection name")}
          <HistoryField historyKey="ssh-name" aria-label={t("Connection name")} data-initial-focus required value={label} onValueChange={setLabel} />
        </label>
        <div className="ftp-host-row">
          <label className="field">{t("Server")}
            <HistoryField historyKey="ssh-host" aria-label={t("Server")} required spellCheck={false}
              placeholder="ssh.example.com" value={host} onValueChange={(host) => updateConnection({ host })} />
          </label>
          <label className="field">{t("Port")}
            <input required type="number" min={1} max={65535} value={port} onChange={(event) => updateConnection({ port: event.target.value })} />
          </label>
        </div>
        <label className="field">{t("Username")}
          <HistoryField historyKey="ssh-username" aria-label={t("Username")} required spellCheck={false}
            value={username} onValueChange={(username) => updateConnection({ username })} />
        </label>
        <label className="field">{t("Authentication")}
          <select aria-label={t("Authentication")} value={auth} onChange={(event) => updateConnection({
            auth: event.target.value === "privateKey" ? "privateKey" : "password", secret: "", clearSecret: false,
          })}>
            <option value="password">{t("Password")}</option>
            <option value="privateKey">{t("Private key")}</option>
          </select>
        </label>
        {useKey && <div className="ftp-encoding-row">
          <label className="field">{t("Private key file")}
            <input required value={path} onChange={(event) => updateConnection({ path: event.target.value })} spellCheck={false} />
          </label>
          <Button type="button" onClick={() => { void chooseKey(); }}>{t("Browse…")}</Button>
        </div>}
        <label className="field">{t(useKey ? "Private key passphrase" : "Password")}
          <input type="password" autoComplete="new-password" value={secret} disabled={useKey && clearSecret}
            placeholder={savedSecret ? t(useKey ? "Keep saved passphrase" : "Keep saved password") : undefined}
            required={!useKey && !savedSecret} onChange={(event) => updateConnection({ secret: event.target.value })} />
        </label>
        {useKey && savedSecret && <label className="field-checkbox">
          <span>{t("Clear saved passphrase")}</span>
          <input type="checkbox" checked={clearSecret} onChange={(event) => updateConnection({ clearSecret: event.target.checked })} />
        </label>}
        {error && <p className="dialog-error" role="alert">{errorText(error)}</p>}
        {verified && <p role="status">{t("SFTP connection successful.")}</p>}
        <div className="dialog-actions">
          <Button type="button" disabled={!!working || !canTest}
            onClick={() => { void testConnection(); }}>{t(working === "test" ? "Testing…" : "Test connection")}</Button>
        </div>
      </div>
      <footer className="dialog-footer">
        <Button type="button" disabled={!!working} onClick={onClose}>{t("Cancel")}</Button>
        <Button type="submit" className="primary" disabled={!!working}>{t(working === "save" ? "Saving…" : "Save connection")}</Button>
      </footer>
    </form>
  </Dialog>
  {verification && <VerifyHostDialog verification={verification} testing onCancel={() => setVerification(undefined)}
    onApprove={() => { void testConnection(verification); }} />}
  </>;
}
