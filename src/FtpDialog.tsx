import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, describeError, type FtpEncryption, type FtpProfile } from "./api";
import { Button } from "./Button";
import { ConnectionHostFields, ConnectionNameField, NetBoxSession, type ConnectionDraft } from "./ConnectionProtocol";
import { errorText, t } from "./i18n";
import type { Bindings } from "./preferences";
import { NetBoxDirectoriesPage } from "./NetBoxDirectoriesPage";
import { defaultDirectoryPreferences } from "./netboxDirectories";
import { defaultEnvironmentPreferences, NetBoxEnvironmentPage } from "./NetBoxEnvironmentPage";
import { defaultConnectionPreferences, NetBoxConnectionPage } from "./NetBoxConnectionPage";
import { defaultFtpOptions, NetBoxFtpPage } from "./NetBoxFtpPage";
import { NetBoxProxyPage, proxyDraft, proxyInput } from "./NetBoxProxyPage";

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
  const [encryption, setEncryption] = useState<FtpEncryption>(profile?.encryption ?? draft?.ftpEncryption ?? "plain");
  const [ftpOptions, setFtpOptions] = useState(profile?.ftpOptions ?? draft?.ftpOptions ?? defaultFtpOptions);
  const [connection, setConnection] = useState(() => ({
    host: profile?.host ?? draft?.host ?? "",
    port: draft?.portEdited ? draft.port : String(profile?.port ?? (encryption === "implicitTls" ? 990 : 21)),
    username: profile?.username ?? draft?.username ?? "",
    portEdited: profile ? profile.port !== (encryption === "implicitTls" ? 990 : 21) : draft?.portEdited ?? false,
  }));
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [codePage, setCodePage] = useState(profile?.codePage?.toString() ?? "");
  const [directories, setDirectories] = useState(profile?.directories ?? draft?.directories ?? defaultDirectoryPreferences);
  const [environment, setEnvironment] = useState(profile?.environment ?? draft?.environment ?? defaultEnvironmentPreferences);
  const [connectionOptions, setConnectionOptions] = useState(profile?.connectionOptions ?? draft?.connectionOptions ?? defaultConnectionPreferences);
  const [proxy, setProxy] = useState(() => draft?.proxy ?? proxyDraft(profile?.proxy));
  const [working, setWorking] = useState<"save" | "test">();
  const [error, setError] = useState("");
  const [verified, setVerified] = useState(false);
  const testing = useRef<AbortController>(null);
  useEffect(() => () => testing.current?.abort(), []);

  async function submit(action: "save" | "test") {
    if (working) return;
    setWorking(action);
    setError("");
    setVerified(false);
    const attempt = action === "test" ? new AbortController() : null;
    testing.current = attempt;
    try {
      const input: Parameters<typeof api.saveFtpProfile>[0] = {
        id: profile?.id, label: label.trim(), host: connection.host, port: Number(connection.port), username: connection.username,
        password: ftpOptions.emptyPassword ? undefined : clearPassword ? "" : password || undefined,
        codePage: codePage && Number(codePage) !== 65001 ? Number(codePage) : null,
        encryption,
        ftpOptions,
        directories: { ...directories, resolveLinks: false },
        environment,
        connectionOptions,
        proxy: proxyInput(proxy),
      };
      if (action === "save") await onSave(input);
      else {
        await api.testFtpConnection(input, attempt?.signal);
        if (!attempt?.signal.aborted) setVerified(true);
      }
    } catch (failure) {
      if (!attempt?.signal.aborted) setError(describeError(failure));
    } finally {
      testing.current = null;
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
    onCancelTest={() => testing.current?.abort()}
    pages={{ environment: <NetBoxEnvironmentPage value={environment} ftpEncoding={encoding}
      onChange={(settings) => { setEnvironment(settings); change(); }} />, directories: <NetBoxDirectoriesPage value={directories} symbolicLinks={false}
      onChange={(settings) => { setDirectories(settings); change(); }} />,
      ftp: <NetBoxFtpPage value={ftpOptions} onChange={(settings) => { setFtpOptions(settings); change(); }} />,
      connection: <NetBoxConnectionPage value={connectionOptions} ftp
        onChange={(settings) => { setConnectionOptions(settings); change(); }} />,
      proxy: <NetBoxProxyPage value={proxy} saved={profile?.proxy} activeFtp={ftpOptions.activeMode}
        onChange={(settings) => { setProxy(settings); change(); }} /> }}
    feedback={error ? <p className="dialog-error" role="alert">{errorText(error)}</p> :
      verified ? <p role="status">{t(encryption === "plain" ? "FTP connection successful." : "FTPS connection successful.")}</p> : undefined}
    onChangeProtocol={onUseSftp && (() => onUseSftp({ label, ...connection, directories, environment, connectionOptions,
      proxy, ftpEncryption: encryption, ftpOptions, sshCompatibility: draft?.sshCompatibility }))}>
          <ConnectionNameField protocol="ftp" label={label} onChange={(value) => { setLabel(value); change(); }} />
          <label className="field">{t("Encryption")}
            <select aria-label={t("Encryption")} value={encryption} onChange={({ target }) => {
              const mode = target.value === "explicitTls" || target.value === "implicitTls" ? target.value : "plain";
              setEncryption(mode);
              setConnection((current) => current.portEdited ? current : { ...current, port: mode === "implicitTls" ? "990" : "21" });
              change();
            }}>
              <option value="plain">{t("No encryption")}</option>
              <option value="explicitTls">{t("Explicit TLS")}</option>
              <option value="implicitTls">{t("Implicit TLS")}</option>
            </select>
          </label>
          <ConnectionHostFields protocol="ftp" connection={connection} onChange={(update) => {
            setConnection((current) => ({ ...current, ...update }));
            change();
          }} />
          <label className="field">{t("Password")}
            <input type="password" autoComplete="new-password" placeholder={profile ? t("Keep saved password") : undefined}
              value={ftpOptions.emptyPassword ? "" : password} disabled={clearPassword || ftpOptions.emptyPassword}
              onChange={(event) => { setPassword(event.target.value); change(); }} />
          </label>
          {profile && <label className="field-checkbox">
            <span>{t("Clear saved password")}</span>
            <input type="checkbox" checked={clearPassword} disabled={ftpOptions.emptyPassword}
              onChange={(event) => { setClearPassword(event.target.checked); change(); }} />
          </label>}
          {encryption === "plain" && <p className="search-hint">{t("Plain FTP sends credentials and files without encryption.")}</p>}
          <div className="dialog-actions">
            <Button type="button" disabled={!!working || !canTest} onClick={({ currentTarget }) => {
              if (currentTarget.form?.reportValidity()) void submit("test");
            }}>
              {t(working === "test" ? "Testing…" : "Test connection")}
            </Button>
          </div>
  </NetBoxSession>;
}
