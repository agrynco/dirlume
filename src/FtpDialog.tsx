import { HistoryField } from "./HistoryField";
import { errorText, t } from "./i18n";
import { Message } from "./Message";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, connectFtpLocation, describeError, type FtpPlace, type FtpProfile, type Listing, type SshHostVerification, type SshPlace, type SshProfile } from "./api";
import { Button } from "./Button";
import { ConnectionProtocol, type ConnectionDraft } from "./ConnectionProtocol";
import { Dialog } from "./Dialog";
import { SshProfileDialog, VerifyHostDialog } from "./SshDialog";
import { eventShortcut, showShortcut, type Bindings } from "./preferences";

type Profile = ({ kind: "ftp" } & FtpProfile) | ({ kind: "ssh" } & SshProfile);
const profileKey = (profile: Profile) => `${profile.kind}:${profile.id}`;

export function FtpDialog({ shortcuts, onConnect, onClose }: {
  shortcuts: Bindings;
  onConnect: (place: FtpPlace | SshPlace, listing: Listing) => void;
  onClose: () => void;
}) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState<Profile | null | undefined>(undefined);
  const [draft, setDraft] = useState<{ kind: "ftp" | "ssh"; fields?: ConnectionDraft }>({ kind: "ftp" });
  const [removing, setRemoving] = useState(false);
  const [verification, setVerification] = useState<SshHostVerification>();
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [codePage, setCodePage] = useState<number | null>(null);
  const [error, setError] = useState("");
  const list = useRef<HTMLSelectElement>(null);
  const profile = profiles.find((item) => profileKey(item) === selected);
  const editingKind = editing?.kind ?? draft.kind;

  useEffect(() => {
    let current = true;
    void Promise.allSettled([api.ftpProfiles(), api.sshProfiles()]).then(([ftp, ssh]) => {
      if (!current) return;
      const items: Profile[] = [
        ...(ftp.status === "fulfilled" ? ftp.value.map((item) => ({ ...item, kind: "ftp" as const })) : []),
        ...(ssh.status === "fulfilled" ? ssh.value.map((item) => ({ ...item, kind: "ssh" as const })) : []),
      ];
      setProfiles(items);
      setSelected(items[0] ? profileKey(items[0]) : "");
      const failure = ftp.status === "rejected" ? ftp : ssh.status === "rejected" ? ssh : null;
      if (failure) setError(describeError(failure.reason));
    }).finally(() => { if (current) setLoading(false); });
    void api.ftpWindowsCodePage().then((page) => { if (current) setCodePage(page); }).catch(() => {});
    return () => { current = false; };
  }, []);

  function add() {
    setDraft({ kind: "ftp" });
    setEditing(null);
  }

  function saved(profile: Profile) {
    const key = profileKey(profile);
    setProfiles((items) => editing ? items.map((item) => profileKey(item) === key ? profile : item) : [...items, profile]);
    setSelected(key);
    setError("");
    setEditing(undefined);
    requestAnimationFrame(() => list.current?.focus());
  }

  async function connect(approval?: SshHostVerification) {
    if (!profile || working || loading || editing !== undefined || removing) return;
    setWorking(true);
    setError("");
    setVerification(undefined);
    try {
      if (profile.kind === "ssh") {
        const result = await api.connectSsh(profile.id, approval);
        if (result.kind === "verifyHost") setVerification(result.verification);
        else onConnect({ kind: "ssh", id: result.id, profileId: profile.id, address: result.address, segments: result.segments }, result.listing);
      } else {
        const { place, listing } = await connectFtpLocation(profile.id);
        onConnect(place, listing);
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
      await (profile.kind === "ssh" ? api.removeSshProfile(profile.id) : api.removeFtpProfile(profile.id));
      const remaining = profiles.filter((item) => profileKey(item) !== profileKey(profile));
      setProfiles(remaining);
      setSelected(remaining[0] ? profileKey(remaining[0]) : "");
      setRemoving(false);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setWorking(false);
    }
  }

  return <>
    <Dialog title={t("FTP and SFTP connections")} onClose={() => { if (!working) onClose(); }} onKeyDown={(event) => {
      if (working || loading || editing !== undefined || removing || verification) return;
      const key = eventShortcut(event);
      if (!key) return;
      if (shortcuts.addFtpProfile.includes(key)) add();
      else if (shortcuts.editFtpProfile.includes(key) && profile) setEditing(profile);
      else if (shortcuts.open.includes(key) && event.target instanceof HTMLSelectElement) void connect();
      else return;
      event.preventDefault();
    }}>
      <div className="dialog-body ftp-connections">
        {loading ? <p role="status">{t("Loading connections…")}</p> : profiles.length ? (
          <label className="field">{t("Saved connections")}
            <select ref={list} size={6} value={selected} autoFocus onChange={(event) => setSelected(event.target.value)}
              onDoubleClick={() => { void connect(); }}>
              {profiles.map((item) => <option key={profileKey(item)} value={profileKey(item)}>
                {item.label} · {item.host.includes(":") ? `[${item.host}]` : item.host}:{item.port} · {item.kind === "ssh" ? "SFTP" : "FTP"}
              </option>)}
            </select>
          </label>
        ) : <p>{t("No saved FTP or SFTP connections.")}</p>}
        {error && !removing && <p className="dialog-error" role="alert">{errorText(error)}</p>}
      </div>
      <footer className="dialog-footer">
        <Button type="button" disabled={working || loading} shortcut={showShortcut(shortcuts.addFtpProfile[0])}
          onClick={add}>{t("Add")}</Button>
        <Button type="button" disabled={!profile || working} shortcut={showShortcut(shortcuts.editFtpProfile[0])}
          onClick={() => setEditing(profile)}>{t("Edit")}</Button>
        <Button type="button" disabled={!profile || working} onClick={() => { setError(""); setRemoving(true); }}>{t("Remove")}</Button>
        <Button type="button" disabled={working} onClick={onClose}>{t("Cancel")}</Button>
        <Button type="button" className="primary" disabled={!profile || working} shortcut={showShortcut(shortcuts.open[0])}
          onClick={() => { void connect(); }}>{working && !removing ? t("Connecting…") : t("Connect")}</Button>
      </footer>
    </Dialog>
    {editing !== undefined && editingKind === "ftp" && <ProfileDialog profile={editing?.kind === "ftp" ? editing : null} windowsCodePage={codePage}
      draft={editing === null ? draft.fields : undefined}
      onUseSftp={editing === null ? (fields) => setDraft({ kind: "ssh", fields: { ...fields, port: fields.port === "21" ? "22" : fields.port } }) : undefined}
      onClose={() => setEditing(undefined)} onSave={async (input) => {
        const id = await api.saveFtpProfile(input);
        const { password: _password, ...publicFields } = input;
        saved({ ...publicFields, id, kind: "ftp" });
      }} />}
    {editing !== undefined && editingKind === "ssh" && <SshProfileDialog profile={editing?.kind === "ssh" ? editing : null} sftp
      draft={editing === null ? draft.fields : undefined}
      onUseFtp={editing === null ? (fields) => setDraft({ kind: "ftp", fields: { ...fields, port: fields.port === "22" ? "21" : fields.port } }) : undefined}
      onClose={() => setEditing(undefined)} onSave={async (input) => saved({ ...await api.saveSshProfile(input), kind: "ssh" })} />}
    {verification && <VerifyHostDialog verification={verification} onCancel={() => setVerification(undefined)}
      onApprove={() => { void connect(verification); }} />}
    {removing && profile && <Dialog title={t(profile.kind === "ssh" ? "Remove SFTP connection" : "Remove FTP connection")} tone="warning" onClose={() => { if (!working) setRemoving(false); }}>
      <div className="dialog-body">
        <p><Message text="Remove the saved connection {0}?"><strong>{profile.label}</strong></Message></p>
        {error && <p className="dialog-error" role="alert">{errorText(error)}</p>}
      </div>
      <footer className="dialog-footer">
        <Button type="button" data-initial-focus disabled={working} onClick={() => setRemoving(false)}>{t("Cancel")}</Button>
        <Button type="button" className="negative" disabled={working} onClick={() => { void remove(); }}>{t("Remove connection")}</Button>
      </footer>
    </Dialog>}
  </>;
}

function ProfileDialog({ profile, draft, onUseSftp, windowsCodePage, onSave, onClose }: {
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
