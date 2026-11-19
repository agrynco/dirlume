import { HistoryField } from "./HistoryField";
import { errorText, t } from "./i18n";
import { Message } from "./Message";
import { useEffect, useState, type FormEvent } from "react";
import { api, connectFtpLocation, describeError, type FtpPlace, type FtpProfile, type Listing } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { eventShortcut, showShortcut, type Bindings } from "./preferences";

export function FtpDialog({ shortcuts, onConnect, onClose }: {
  shortcuts: Bindings;
  onConnect: (place: FtpPlace, listing: Listing) => void;
  onClose: () => void;
}) {
  const [profiles, setProfiles] = useState<FtpProfile[]>([]);
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState<FtpProfile | null | undefined>(undefined);
  const [removing, setRemoving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [codePage, setCodePage] = useState<number | null>(null);
  const [error, setError] = useState("");
  const profile = profiles.find(({ id }) => id === selected);

  useEffect(() => {
    let current = true;
    void api.ftpProfiles().then((items) => {
      if (!current) return;
      setProfiles(items);
      setSelected(items[0]?.id ?? "");
    }).catch((failure: unknown) => {
      if (current) setError(describeError(failure));
    }).finally(() => { if (current) setLoading(false); });
    void api.ftpWindowsCodePage().then((page) => { if (current) setCodePage(page); }).catch(() => {});
    return () => { current = false; };
  }, []);

  async function connect() {
    if (!profile || working || loading || editing !== undefined || removing) return;
    setWorking(true);
    setError("");
    try {
      const { place, listing } = await connectFtpLocation(profile.id);
      onConnect(place, listing);
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
      await api.removeFtpProfile(profile.id);
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
    <Dialog title={t("FTP connections")} onClose={() => { if (!working) onClose(); }} onKeyDown={(event) => {
      if (working || loading || editing !== undefined || removing) return;
      const key = eventShortcut(event);
      if (!key) return;
      if (key === shortcuts.addFtpProfile) setEditing(null);
      else if (key === shortcuts.editFtpProfile && profile) setEditing(profile);
      else if (key === shortcuts.open && event.target instanceof HTMLSelectElement) void connect();
      else return;
      event.preventDefault();
    }}>
      <div className="dialog-body ftp-connections">
        {loading ? <p role="status">{t("Loading connections…")}</p> : profiles.length ? (
          <label className="field">{t("Saved connections")}
            <select size={6} value={selected} autoFocus onChange={(event) => setSelected(event.target.value)}
              onDoubleClick={() => { void connect(); }}>
              {profiles.map(({ id, label, host, port }) => <option key={id} value={id}>{label} · {host}:{port}</option>)}
            </select>
          </label>
        ) : <p>{t("No saved FTP connections.")}</p>}
        {error && !removing && <p className="dialog-error" role="alert">{errorText(error)}</p>}
      </div>
      <footer className="dialog-footer">
        <Button type="button" disabled={working || loading} shortcut={showShortcut(shortcuts.addFtpProfile)}
          onClick={() => setEditing(null)}>{t("Add")}</Button>
        <Button type="button" disabled={!profile || working} shortcut={showShortcut(shortcuts.editFtpProfile)}
          onClick={() => setEditing(profile)}>{t("Edit")}</Button>
        <Button type="button" disabled={!profile || working} onClick={() => { setError(""); setRemoving(true); }}>{t("Remove")}</Button>
        <Button type="button" disabled={working} onClick={onClose}>{t("Cancel")}</Button>
        <Button type="button" className="primary" disabled={!profile || working} shortcut={showShortcut(shortcuts.open)}
          onClick={() => { void connect(); }}>{working && !removing ? t("Connecting…") : t("Connect")}</Button>
      </footer>
    </Dialog>
    {editing !== undefined && <ProfileDialog profile={editing} windowsCodePage={codePage}
      onClose={() => setEditing(undefined)} onSave={async (input) => {
        const id = await api.saveFtpProfile(input);
        const { password: _password, ...publicFields } = input;
        const saved = { ...publicFields, id };
        setProfiles((items) => editing ? items.map((item) => item.id === id ? saved : item) : [...items, saved]);
        setSelected(id);
        setError("");
        setEditing(undefined);
        requestAnimationFrame(() => document.querySelector<HTMLSelectElement>(".ftp-connections select")?.focus());
      }} />}
    {removing && profile && <Dialog title={t("Remove FTP connection")} tone="warning" onClose={() => { if (!working) setRemoving(false); }}>
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

function ProfileDialog({ profile, windowsCodePage, onSave, onClose }: {
  profile: FtpProfile | null;
  windowsCodePage: number | null;
  onSave: (profile: Parameters<typeof api.saveFtpProfile>[0]) => Promise<void>;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(profile?.label ?? "");
  const [host, setHost] = useState(profile?.host ?? "");
  const [port, setPort] = useState(String(profile?.port ?? 21));
  const [username, setUsername] = useState(profile?.username ?? "");
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
        <div className="dialog-body ftp-fields">
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
