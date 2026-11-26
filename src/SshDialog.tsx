import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import { api, describeError, type SshHostInput, type SshHostVerification, type SshJumpHost, type SshProfile } from "./api";
import { Button } from "./Button";
import { ConnectionHostFields, ConnectionNameField, NetBoxSession, type ConnectionDraft } from "./ConnectionProtocol";
import { Dialog } from "./Dialog";
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

type HostDraft = {
  host: string;
  port: string;
  portEdited: boolean;
  username: string;
  auth: SshHostInput["auth"]["kind"];
  path: string;
  secret: string;
  clearSecret: boolean;
};
type SavedHost = Pick<SshProfile, "host" | "port" | "username" | "auth" | "hasSecret">;
type JumpDraft = HostDraft & { id: string };

function hostDraft(saved?: SavedHost | null, draft?: ConnectionDraft): HostDraft {
  return {
    host: saved?.host ?? draft?.host ?? "", port: draft?.port ?? String(saved?.port ?? 22),
    portEdited: draft?.portEdited ?? false,
    username: saved?.username ?? draft?.username ?? "",
    auth: saved?.auth.kind ?? "password", path: saved?.auth.kind === "privateKey" ? saved.auth.path : "",
    secret: "", clearSecret: false,
  };
}

function keepsSecret(host: HostDraft, saved?: SavedHost | null) {
  return !!saved?.hasSecret && saved.host === host.host.trim().replace(/^\[(.*)\]$/, "$1").toLowerCase() &&
    saved.port === Number(host.port) && saved.username === host.username.trim() && saved.auth.kind === host.auth &&
    (saved.auth.kind !== "privateKey" || saved.auth.path === host.path.trim());
}

function canConnect(host: HostDraft, saved?: SavedHost | null) {
  const port = Number(host.port);
  return !!host.host.trim() && !!host.username.trim() && Number.isInteger(port) && port >= 1 && port <= 65535 &&
    (host.auth === "privateKey" ? !!host.path.trim() : !!(host.secret || keepsSecret(host, saved)));
}

function hostInput(host: HostDraft): SshHostInput {
  return {
    host: host.host, port: Number(host.port), username: host.username,
    auth: host.auth === "privateKey" ? { kind: "privateKey", path: host.path } : { kind: "password" },
    secret: host.secret || undefined, clearSecret: host.auth === "privateKey" && host.clearSecret,
  };
}

function routeHost(host: HostDraft) {
  const server = host.host.trim();
  if (!server || Number(host.port) === 22 || !host.port) return server;
  return (server.includes(":") && !server.startsWith("[") ? `[${server}]` : server) + `:${host.port}`;
}

function SshHostFields({ connection, saved, onChange, onError, jump = false }: {
  connection: HostDraft;
  saved?: SavedHost | null;
  onChange: (update: Partial<HostDraft>) => void;
  onError: (error: string) => void;
  jump?: boolean;
}) {
  const { auth, path, secret, clearSecret } = connection;
  const useKey = auth === "privateKey";
  const savedSecret = keepsSecret(connection, saved);

  async function chooseKey() {
    try {
      const chosen = await open({ title: t("Select SSH private key") });
      if (chosen) onChange({ path: chosen });
    } catch (failure) {
      onError(describeError(failure));
    }
  }

  return <>
    <ConnectionHostFields protocol="ssh" connection={connection} onChange={onChange} jump={jump} />
    <label className="field">{t("Authentication")}
      <select aria-label={t("Authentication")} value={auth} onChange={(event) => onChange({
        auth: event.target.value === "privateKey" ? "privateKey" : "password", secret: "", clearSecret: false,
      })}>
        <option value="password">{t("Password")}</option>
        <option value="privateKey">{t("Private key")}</option>
      </select>
    </label>
    {useKey && <div className="ftp-encoding-row">
      <label className="field">{t("Private key file")}
        <input required value={path} onChange={(event) => onChange({ path: event.target.value })} spellCheck={false} />
      </label>
      <Button type="button" onClick={() => { void chooseKey(); }}>{t("Browse…")}</Button>
    </div>}
    <label className="field">{t(useKey ? "Private key passphrase" : "Password")}
      <input type="password" autoComplete="new-password" value={secret} disabled={useKey && clearSecret}
        placeholder={savedSecret ? t(useKey ? "Keep saved passphrase" : "Keep saved password") : undefined}
        required={!useKey && !savedSecret} onChange={(event) => onChange({ secret: event.target.value })} />
    </label>
    {useKey && savedSecret && <label className="field-checkbox">
      <span>{t("Clear saved passphrase")}</span>
      <input type="checkbox" checked={clearSecret} onChange={(event) => onChange({ clearSecret: event.target.checked })} />
    </label>}
  </>;
}

export function SshProfileDialog({ profile, draft, onUseFtp, onSave, onClose }: {
  profile: SshProfile | null;
  draft?: ConnectionDraft;
  onUseFtp?: (draft: ConnectionDraft) => void;
  onSave: (input: Parameters<typeof api.saveSshProfile>[0]) => Promise<void>;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(profile?.label ?? draft?.label ?? "");
  const [connection, setConnection] = useState(() => hostDraft(profile, draft));
  const [jumps, setJumps] = useState<JumpDraft[]>(() =>
    (profile?.jumpHosts ?? []).map((host) => ({ ...hostDraft(host), id: host.id })));
  const [editor, setEditor] = useState<JumpDraft>();
  const editorRef = useRef<HTMLFieldSetElement>(null);
  const nextJump = useRef(0);
  const jumpId = useId();
  const savedJump = (id: string): SshJumpHost | undefined => profile?.jumpHosts?.find((host) => host.id === id);
  const [working, setWorking] = useState<"save" | "test">();
  const [error, setError] = useState("");
  const [verified, setVerified] = useState(false);
  const [pending, setPending] = useState<{ verification: SshHostVerification; approvals: readonly SshHostVerification[] }>();
  const canTest = !editor && canConnect(connection, profile);
  const route = [t("This computer"), ...jumps.map(routeHost), routeHost(connection) || t("SSH destination")];
  const input: Parameters<typeof api.saveSshProfile>[0] = {
    ...hostInput(connection), id: profile?.id, label,
    jumpHosts: jumps.map((host) => ({ ...hostInput(host), id: savedJump(host.id)?.id })),
  };

  const editingId = editor?.id;
  useEffect(() => {
    if (editingId) editorRef.current?.querySelector("input")?.focus();
  }, [editingId]);

  function changed() {
    setVerified(false);
    setError("");
  }

  function closeEditor(id?: string) {
    setEditor(undefined);
    requestAnimationFrame(() => document.getElementById(id ? `${jumpId}-edit-${id}` : `${jumpId}-add`)?.focus());
  }

  function saveJump() {
    if (!editor || !canConnect(editor, savedJump(editor.id))) return;
    setJumps((current) => current.some((host) => host.id === editor.id)
      ? current.map((host) => host.id === editor.id ? editor : host)
      : [...current, editor]);
    closeEditor(editor.id);
    changed();
  }

  function moveJump(index: number, offset: number) {
    const next = index + offset;
    setJumps((current) => current.map((host, position) => position === next ? current[index] :
      position === index ? current[next] : host));
    changed();
  }

  function removeJump(index: number) {
    setJumps((current) => current.filter((_, position) => position !== index));
    const next = jumps[index + 1] ?? jumps[index - 1];
    closeEditor(next?.id);
    changed();
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (working || editor) return;
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

  async function testConnection(approvals: readonly SshHostVerification[] = []) {
    if (working || !canTest) return;
    setWorking("test");
    setPending(undefined);
    setVerified(false);
    setError("");
    try {
      const result = await api.testSshConnection(input, approvals);
      if (result.kind === "verifyHost") setPending({ verification: result.verification, approvals });
      else setVerified(true);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setWorking(undefined);
    }
  }

  return <><NetBoxSession editing={!!profile} protocol="sftp" working={working} saveDisabled={!!editor}
    onChangeProtocol={onUseFtp && (() => onUseFtp({
      label, host: connection.host, port: connection.port, username: connection.username, portEdited: connection.portEdited,
    }))} onSave={(event) => { void save(event); }} onClose={onClose}>
        <ConnectionNameField protocol="ssh" label={label} onChange={setLabel} />
        <SshHostFields connection={connection} saved={profile} onChange={(update) => {
          setConnection((current) => ({ ...current, ...update }));
          changed();
        }} onError={setError} />
        <section className="ssh-jumps" aria-labelledby={jumpId}>
          <div className="ssh-jump-heading">
            <h3 id={jumpId}>{t("Jump hosts")}</h3>
            <Button id={`${jumpId}-add`} type="button" disabled={!!editor}
              onClick={() => { setEditor({ ...hostDraft(), id: `draft-${++nextJump.current}` }); setError(""); }}>
              <Plus aria-hidden="true" />{t("Add jump host")}
            </Button>
          </div>
          {jumps.length > 0 && <ol className="ssh-jump-list" role="list">
            {jumps.map((jump, index) => <li key={jump.id}>
              <span className="ssh-jump-name" dir="auto">{routeHost(jump)}</span>
              <div className="ssh-jump-actions">
                <Button id={`${jumpId}-edit-${jump.id}`} type="button" aria-label={t("Edit jump host {0}", index + 1)} disabled={!!editor}
                  onClick={() => { setEditor(jump); setError(""); }}>{t("Edit")}</Button>
                <Button type="button" className="icon-button" aria-label={t("Move up")} tooltip={t("Move up")}
                  disabled={!!editor || index === 0} onClick={() => moveJump(index, -1)}><ArrowUp aria-hidden="true" /></Button>
                <Button type="button" className="icon-button" aria-label={t("Move down")} tooltip={t("Move down")}
                  disabled={!!editor || index === jumps.length - 1} onClick={() => moveJump(index, 1)}><ArrowDown aria-hidden="true" /></Button>
                <Button type="button" aria-label={t("Remove jump host {0}", index + 1)} disabled={!!editor}
                  onClick={() => removeJump(index)}>{t("Remove")}</Button>
              </div>
            </li>)}
          </ol>}
          {editor && <fieldset className="ssh-jump-editor ftp-fields" ref={editorRef}>
            <legend>{jumps.some((host) => host.id === editor.id) ? t("Edit jump host") : t("New jump host")}</legend>
            <SshHostFields connection={editor} saved={savedJump(editor.id)} jump onChange={(update) => {
              setEditor((current) => current?.id === editor.id ? { ...current, ...update } : current);
              setError("");
            }} onError={setError} />
            <div className="dialog-actions">
              <Button type="button" onClick={() => {
                closeEditor(jumps.some((host) => host.id === editor.id) ? editor.id : undefined);
                setError("");
              }}>{t("Cancel")}</Button>
              <Button type="button" disabled={!canConnect(editor, savedJump(editor.id))} onClick={saveJump}>{t("Save jump host")}</Button>
            </div>
          </fieldset>}
          <div className="ssh-route">
            <strong>{t("Route")}</strong>
            <output aria-label={t("Route")} dir="auto">{route.join(" → ")}</output>
          </div>
        </section>
        {error && <p className="dialog-error" role="alert">{errorText(error)}</p>}
        {verified && <p role="status">{t("SFTP connection successful.")}</p>}
        <div className="dialog-actions">
          <Button type="button" disabled={!!working || !canTest}
            onClick={() => { void testConnection(); }}>{t(working === "test" ? "Testing…" : "Test connection")}</Button>
        </div>
  </NetBoxSession>
  {pending && <VerifyHostDialog verification={pending.verification} testing onCancel={() => setPending(undefined)}
    onApprove={() => { void testConnection([...pending.approvals, pending.verification]); }} />}
  </>;
}
