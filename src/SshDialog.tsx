import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, describeError, type Listing, type SshHostVerification, type SshPlace, type SshProfile } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { HistoryField } from "./HistoryField";
import { errorText, t } from "./i18n";
import { Message } from "./Message";
import { eventShortcut, showShortcut, type Bindings } from "./preferences";
import { ConnectionProtocol, type ConnectionDraft } from "./ConnectionProtocol";

export function SshDialog({ shortcuts, onConnect, onClose }: {
  shortcuts: Bindings;
  onConnect: (place: SshPlace, listing: Listing) => void;
  onClose: () => void;
}) {
  const [profiles, setProfiles] = useState<SshProfile[]>([]);
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState<SshProfile | null | undefined>();
  const [removing, setRemoving] = useState(false);
  const [verification, setVerification] = useState<SshHostVerification>();
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const list = useRef<HTMLSelectElement>(null);
  const profile = profiles.find(({ id }) => id === selected);

  useEffect(() => {
    let current = true;
    void api.sshProfiles().then((items) => {
      if (!current) return;
      setProfiles(items);
      setSelected(items[0]?.id ?? "");
    }).catch((failure: unknown) => {
      if (current) setError(describeError(failure));
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, []);

  async function connect(approval?: SshHostVerification) {
    if (!profile || working) return;
    setVerification(undefined);
    setWorking(true);
    setError("");
    try {
      const result = await api.connectSsh(profile.id, approval);
      if (result.kind === "verifyHost") {
        setVerification(result.verification);
      } else {
        onConnect({ kind: "ssh", id: result.id, profileId: profile.id, address: result.address, segments: result.segments }, result.listing);
      }
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setWorking(false);
    }
  }

  async function remove() {
    if (!profile || working) return;
    setWorking(true);
    setError("");
    try {
      await api.removeSshProfile(profile.id);
      const remaining = profiles.filter(({ id }) => id !== profile.id);
      setProfiles(remaining);
      setSelected(remaining[0]?.id ?? "");
      setRemoving(false);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setWorking(false);
    }
  }

  return <>
    <Dialog title={t("SSH connections")} onClose={() => { if (!working) onClose(); }} onKeyDown={(event) => {
      if (working || loading || editing !== undefined || removing || verification) return;
      const key = eventShortcut(event);
      if (!key) return;
      if (shortcuts.addSshProfile.includes(key)) setEditing(null);
      else if (shortcuts.editSshProfile.includes(key) && profile) setEditing(profile);
      else if (shortcuts.open.includes(key) && event.target === list.current) void connect();
      else return;
      event.preventDefault();
    }}>
      <div className="dialog-body ftp-connections">
        {loading ? <p role="status">{t("Loading connections…")}</p> : profiles.length ? (
          <label className="field">{t("Saved connections")}
            <select ref={list} size={6} value={selected} autoFocus onChange={(event) => setSelected(event.target.value)}
              onDoubleClick={() => { void connect(); }}>
              {profiles.map(({ id, label, host, port }) => <option key={id} value={id}>
                {label} · {host.includes(":") ? "[" + host + "]" : host}:{port}
              </option>)}
            </select>
          </label>
        ) : <p>{t("No saved SSH connections.")}</p>}
        {error && !removing && <p className="dialog-error" role="alert">{errorText(error)}</p>}
      </div>
      <footer className="dialog-footer">
        <Button type="button" disabled={working || loading} shortcut={showShortcut(shortcuts.addSshProfile[0])}
          onClick={() => setEditing(null)}>{t("Add")}</Button>
        <Button type="button" disabled={!profile || working} shortcut={showShortcut(shortcuts.editSshProfile[0])}
          onClick={() => setEditing(profile)}>{t("Edit")}</Button>
        <Button type="button" disabled={!profile || working} onClick={() => { setError(""); setRemoving(true); }}>{t("Remove")}</Button>
        <Button type="button" disabled={working} onClick={onClose}>{t("Cancel")}</Button>
        <Button type="button" className="primary" disabled={!profile || working} shortcut={showShortcut(shortcuts.open[0])}
          onClick={() => { void connect(); }}>{working && !removing ? t("Connecting…") : t("Connect")}</Button>
      </footer>
    </Dialog>
    {editing !== undefined && <SshProfileDialog profile={editing} onClose={() => setEditing(undefined)} onSave={async (input) => {
      const saved = await api.saveSshProfile(input);
      setProfiles((items) => editing ? items.map((item) => item.id === saved.id ? saved : item) : [...items, saved]);
      setSelected(saved.id);
      setError("");
      setEditing(undefined);
      requestAnimationFrame(() => list.current?.focus());
    }} />}
    {removing && profile && <Dialog title={t("Remove SSH connection")} tone="warning"
      onClose={() => { if (!working) setRemoving(false); }}>
      <div className="dialog-body">
        <p><Message text="Remove the saved connection {0}?"><strong>{profile.label}</strong></Message></p>
        {error && <p className="dialog-error" role="alert">{errorText(error)}</p>}
      </div>
      <footer className="dialog-footer">
        <Button type="button" data-initial-focus disabled={working} onClick={() => setRemoving(false)}>{t("Cancel")}</Button>
        <Button type="button" className="negative" disabled={working} onClick={() => { void remove(); }}>{t("Remove connection")}</Button>
      </footer>
    </Dialog>}
    {verification && <VerifyHostDialog verification={verification} onCancel={() => setVerification(undefined)}
      onApprove={() => { void connect(verification); }} />}
  </>;
}

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
      <Button type="button" className="primary" onClick={onApprove}>{t(testing ? "Verify and test" : "Trust and connect")}</Button>
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
      </div>
      <footer className="dialog-footer">
        <Button type="button" disabled={!!working || !canTest}
          onClick={() => { void testConnection(); }}>{t(working === "test" ? "Testing…" : "Test connection")}</Button>
        <Button type="button" disabled={!!working} onClick={onClose}>{t("Cancel")}</Button>
        <Button type="submit" className="primary" disabled={!!working}>{t(working === "save" ? "Saving…" : "Save connection")}</Button>
      </footer>
    </form>
  </Dialog>
  {verification && <VerifyHostDialog verification={verification} testing onCancel={() => setVerification(undefined)}
    onApprove={() => { void testConnection(verification); }} />}
  </>;
}
