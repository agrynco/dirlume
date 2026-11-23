import { useEffect, useState, type FormEvent } from "react";
import { api, describeError, type ConnectionSource, type KSwitcherPeer, type SavedConnection } from "./api";
import { Button } from "./Button";
import type { ConnectionDraft } from "./ConnectionProtocol";
import { Dialog } from "./Dialog";
import { FtpProfileDialog } from "./FtpDialog";
import { HistoryField } from "./HistoryField";
import { errorText, t } from "./i18n";
import { kswitcherAddress, rememberKSwitcherAddress } from "./kswitcherAddresses";
import { Message } from "./Message";
import type { Provider } from "./preferences";
import { removeSavedConnection, saveRemoteConnection, saveSmbLocation } from "./savedConnections";
import { SshProfileDialog } from "./SshDialog";

export const connectionCommands = {
  ftp: ["addFtpProfile", "editFtpProfile"],
  ssh: ["addSshProfile", "editSshProfile"],
  smb: ["addSmbProfile", "editSmbProfile"],
  remote: ["addRemoteProfile", "editRemoteProfile"],
} as const;

export function SavedConnectionDialog({ source, profile, remoteProvider, kswitcherDirectory, onSaved, onClose }: {
  source: ConnectionSource;
  profile?: SavedConnection;
  remoteProvider: Provider;
  kswitcherDirectory: string;
  onSaved: (kind: SavedConnection["kind"], id: string) => void;
  onClose: () => void;
}) {
  const [selection, setSelection] = useState<{ kind: "ftp" | "ssh"; draft?: ConnectionDraft }>({ kind: source === "ssh" ? "ssh" : "ftp" });
  const [codePage, setCodePage] = useState<number | null>(null);
  const kind = profile?.kind ?? selection.kind;
  useEffect(() => {
    if (source !== "ftp" || kind !== "ftp") return;
    let mounted = true;
    void api.ftpWindowsCodePage().then((page) => { if (mounted) setCodePage(page); }).catch(() => {});
    return () => { mounted = false; };
  }, [source, kind]);

  if (source === "ftp" || source === "ssh") {
    const changeProtocol = source === "ftp" && !profile;
    return kind === "ftp" ? (
      <FtpProfileDialog profile={profile?.kind === "ftp" ? profile : null} draft={selection.draft} windowsCodePage={codePage}
        onClose={onClose} onSave={async (input) => onSaved("ftp", await api.saveFtpProfile(input))}
        onUseSftp={changeProtocol ? (draft) => setSelection({ kind: "ssh", draft: { ...draft, port: draft.port === "21" ? "22" : draft.port } }) : undefined} />
    ) : (
      <SshProfileDialog profile={profile?.kind === "ssh" ? profile : null} draft={selection.draft} sftp={source === "ftp"}
        onClose={onClose} onSave={async (input) => onSaved("ssh", (await api.saveSshProfile(input)).id)}
        onUseFtp={changeProtocol ? (draft) => setSelection({ kind: "ftp", draft: { ...draft, port: draft.port === "22" ? "21" : draft.port } }) : undefined} />
    );
  }
  return <LocationConnectionDialog source={source} profile={profile} remoteProvider={remoteProvider}
    kswitcherDirectory={kswitcherDirectory} onSaved={onSaved} onClose={onClose} />;
}

function LocationConnectionDialog({ source, profile, remoteProvider, kswitcherDirectory, onSaved, onClose }: {
  source: "smb" | "remote";
  profile?: SavedConnection;
  remoteProvider: Provider;
  kswitcherDirectory: string;
  onSaved: (kind: SavedConnection["kind"], id: string) => void;
  onClose: () => void;
}) {
  const smb = profile?.kind === "smb" ? profile : undefined;
  const remote = profile?.kind === "server" || profile?.kind === "kswitcher" ? profile : undefined;
  const provider = remote?.kind ?? remoteProvider;
  const paired = source === "remote" && provider === "kswitcher";
  const [label, setLabel] = useState(profile?.label ?? "");
  const [value, setValue] = useState(smb?.path ?? (remote?.kind === "kswitcher" ? remote.peer : ""));
  const [host, setHost] = useState(() => kswitcherAddress(remote?.kind === "kswitcher" ? remote.peer : ""));
  const [peers, setPeers] = useState<KSwitcherPeer[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!paired) return;
    let current = true;
    void api.kswitcherPeers(kswitcherDirectory).then((result) => {
      if (!current) return;
      setPeers(result);
      if (!profile && result[0]) {
        setValue(result[0].id);
        setHost(kswitcherAddress(result[0].id));
      }
    }).catch((failure: unknown) => { if (current) setError(describeError(failure)); });
    return () => { current = false; };
  }, [paired, kswitcherDirectory, profile]);

  async function save(event: FormEvent) {
    event.preventDefault();
    const name = label.trim();
    if (working || !name) return;
    setError("");
    setWorking(true);
    try {
      if (source === "smb") onSaved("smb", saveSmbLocation(name, value, smb));
      else {
        const id = await saveRemoteConnection(name, provider, value.trim(), remote);
        if (paired) rememberKSwitcherAddress(value, host);
        onSaved(provider, id);
      }
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setWorking(false);
    }
  }

  const title = source === "smb" ? (profile ? "Edit SMB connection" : "Add SMB connection") :
    (profile ? "Edit remote machine" : "Add remote machine");
  return <Dialog title={t(title)} onClose={() => { if (!working) onClose(); }}>
    <form className="dialog-form" onSubmit={(event) => { void save(event); }} autoComplete="off">
      <div className="dialog-body ftp-fields" inert={working}>
        <label className="field">{t("Connection name")}
          <input data-initial-focus required value={label} onChange={(event) => setLabel(event.target.value)} />
        </label>
        {source === "smb" ? <label className="field">{t("SMB server or share")}
          <HistoryField historyKey="smb-share" required value={value} onValueChange={setValue} />
        </label> : paired ? <>
          <label className="field">{t("Paired machine")}
            <select value={value} onChange={(event) => {
              const id = event.target.value;
              setValue(id);
              setHost(kswitcherAddress(id));
            }} required>
              {!peers.some(({ id }) => id === value) && <option value={value}>{value}</option>}
              {peers.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
          <label className="field">{t("Computer name or IPv4 address")}
            <input spellCheck={false} value={host} placeholder={peers.find(({ id }) => id === value)?.name}
              onChange={(event) => setHost(event.target.value)} />
          </label>
        </> : <label className="field">{t("Server invitation")}
          <input type="password" autoComplete="off" spellCheck={false} value={value} required={!remote}
            placeholder={t(remote ? "Keep saved invitation" : "Paste the invitation from the remote machine")}
            onChange={(event) => setValue(event.target.value)} />
        </label>}
        {error && <p className="dialog-error" role="alert">{errorText(error)}</p>}
      </div>
      <footer className="dialog-footer">
        <Button type="button" disabled={working} onClick={onClose}>{t("Cancel")}</Button>
        <Button type="submit" className="primary" disabled={working || !label.trim() || (paired && !value)}>
          {t(working ? "Saving…" : "Save connection")}</Button>
      </footer>
    </form>
  </Dialog>;
}

export function RemoveConnectionDialog({ profile, onRemoved, onClose }: {
  profile: SavedConnection; onRemoved: () => void; onClose: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    if (working) return;
    setWorking(true);
    setError("");
    try {
      await removeSavedConnection(profile);
      onRemoved();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setWorking(false);
    }
  }
  return <Dialog title={t("Remove connection")} tone="warning" onClose={() => { if (!working) onClose(); }}>
    <div className="dialog-body">
      <p><Message text="Remove the saved connection {0}?"><strong>{profile.label}</strong></Message></p>
      {error && <p className="dialog-error" role="alert">{errorText(error)}</p>}
    </div>
    <footer className="dialog-footer">
      <Button type="button" data-initial-focus disabled={working} onClick={onClose}>{t("Cancel")}</Button>
      <Button type="button" className="alert-confirm" disabled={working} onClick={() => { void remove(); }}>{t("Remove connection")}</Button>
    </footer>
  </Dialog>;
}
