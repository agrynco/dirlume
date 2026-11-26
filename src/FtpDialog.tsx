import { useState, type FormEvent } from "react";
import { api, describeError, type FtpProfile } from "./api";
import { Button } from "./Button";
import { ConnectionHostFields, ConnectionNameField, NetBoxSession, type ConnectionDraft } from "./ConnectionProtocol";
import { errorText, t } from "./i18n";
import type { Bindings } from "./preferences";

export function FtpProfileDialog({ profile, draft, onUseSftp, windowsCodePage, bindings, onSave, onClose }: {
  profile: FtpProfile | null;
  draft?: ConnectionDraft;
  onUseSftp?: (draft: ConnectionDraft) => void;
  windowsCodePage: number | null;
  bindings: Bindings;
  onSave: (profile: Parameters<typeof api.saveFtpProfile>[0]) => Promise<void>;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(profile?.label ?? draft?.label ?? "");
  const [connection, setConnection] = useState(() => ({
    host: profile?.host ?? draft?.host ?? "",
    port: draft?.port ?? String(profile?.port ?? 21),
    username: profile?.username ?? draft?.username ?? "",
    portEdited: draft?.portEdited ?? false,
  }));
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [codePage, setCodePage] = useState(profile?.codePage?.toString() ?? "");
  const [working, setWorking] = useState<"save" | "test">();
  const [error, setError] = useState("");
  const [verified, setVerified] = useState(false);

  async function submit(action: "save" | "test") {
    if (working) return;
    setWorking(action);
    setError("");
    setVerified(false);
    try {
      const input: Parameters<typeof api.saveFtpProfile>[0] = {
        id: profile?.id, label: label.trim(), host: connection.host, port: Number(connection.port), username: connection.username,
        password: clearPassword ? "" : password || undefined,
        codePage: codePage && Number(codePage) !== 65001 ? Number(codePage) : null,
      };
      if (action === "save") await onSave(input);
      else {
        await api.testFtpConnection(input);
        setVerified(true);
      }
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setWorking(undefined);
    }
  }

  function change() {
    setVerified(false);
    setError("");
  }

  function save(event: FormEvent) {
    event.preventDefault();
    void submit("save");
  }

  const port = Number(connection.port);
  const canTest = !!label.trim() && !!connection.host.trim() && Number.isInteger(port) && port >= 1 && port <= 65535;
  const encoding = <div className="ftp-encoding-row">
    <label className="field">{t("Filename code page")}
      <input type="number" min={1} max={65535} placeholder="UTF-8" value={codePage}
        onChange={(event) => { setCodePage(event.target.value); change(); }} />
    </label>
    {windowsCodePage && windowsCodePage !== 65001 && <Button type="button" onClick={() => { setCodePage(String(windowsCodePage)); change(); }}>
      {t("Use Windows code page")}
    </Button>}
  </div>;
  return <NetBoxSession editing={!!profile} protocol="ftp" working={working} bindings={bindings} onSave={save} onClose={onClose}
    pages={{ environment: encoding }} feedback={error ? <p className="dialog-error" role="alert">{errorText(error)}</p> :
      verified ? <p role="status">{t("FTP connection successful.")}</p> : undefined}
    onChangeProtocol={onUseSftp && (() => onUseSftp({ label, ...connection }))}>
          <ConnectionNameField protocol="ftp" label={label} onChange={(value) => { setLabel(value); change(); }} />
          <ConnectionHostFields protocol="ftp" connection={connection} onChange={(update) => {
            setConnection((current) => ({ ...current, ...update }));
            change();
          }} />
          <label className="field">{t("Password")}
            <input type="password" autoComplete="new-password" placeholder={profile ? t("Keep saved password") : undefined}
              value={password} disabled={clearPassword} onChange={(event) => { setPassword(event.target.value); change(); }} />
          </label>
          {profile && <label className="field-checkbox">
            <span>{t("Clear saved password")}</span>
            <input type="checkbox" checked={clearPassword} onChange={(event) => { setClearPassword(event.target.checked); change(); }} />
          </label>}
          <p className="search-hint">{t("Plain FTP sends credentials and files without encryption.")}</p>
          <div className="dialog-actions">
            <Button type="button" disabled={!!working || !canTest} onClick={() => { void submit("test"); }}>
              {t(working === "test" ? "Testing…" : "Test connection")}
            </Button>
          </div>
  </NetBoxSession>;
}
