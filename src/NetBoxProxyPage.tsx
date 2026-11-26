import type { ProxyInput, ProxyMode, ProxySettings } from "./api";
import { t } from "./i18n";

export type ProxyDraft = Omit<ProxySettings, "port" | "hasPassword"> & {
  port: string;
  password: string;
  clearPassword: boolean;
};

const defaultPorts = { none: "", socks5: "1080", httpConnect: "8080" };

export function proxyDraft(saved?: ProxySettings): ProxyDraft {
  return {
    mode: saved?.mode ?? "none",
    host: saved?.host ?? "",
    port: saved?.port ? String(saved.port) : defaultPorts[saved?.mode ?? "none"],
    username: saved?.username ?? "",
    skipLoopback: saved?.skipLoopback ?? false,
    resolveLocally: saved?.resolveLocally ?? false,
    password: "",
    clearPassword: false,
  };
}

export function proxyInput({ port, password, clearPassword, ...settings }: ProxyDraft): ProxyInput {
  const credentials = settings.mode !== "none" && settings.username.trim();
  return { ...settings, port: Number(port), password: credentials ? clearPassword ? "" : password || undefined : undefined };
}

export function NetBoxProxyPage({ value, saved, onChange, activeFtp, jumpRoute }: {
  value: ProxyDraft;
  saved?: ProxySettings;
  onChange: (value: ProxyDraft) => void;
  activeFtp?: boolean;
  jumpRoute?: boolean;
}) {
  const update = (patch: Partial<ProxyDraft>) => onChange({ ...value, ...patch });
  const keepPassword = saved?.hasPassword && saved.mode === value.mode &&
    saved.host.toLowerCase() === value.host.trim().toLowerCase() && saved.port === Number(value.port) &&
    saved.username === value.username.trim();
  return <>
    <label className="field">{t("Proxy type")}
      <select aria-label={t("Proxy type")} value={value.mode} onChange={(event) => {
        const mode = event.target.value as ProxyMode;
        const port = !value.port || value.port === defaultPorts[value.mode] ? defaultPorts[mode] : value.port;
        update({ mode, port });
      }}>
        <option value="none">{t("None")}</option>
        <option value="socks5">SOCKS5</option>
        <option value="httpConnect">HTTP CONNECT</option>
      </select>
    </label>
    {value.mode !== "none" && <>
      <div className="ftp-host-row">
        <label className="field">{t("Proxy host")}
          <input required value={value.host} onChange={(event) => update({ host: event.target.value })} />
        </label>
        <label className="field">{t("Proxy port")}
          <input type="number" min={1} max={65535} required value={value.port}
            onChange={(event) => update({ port: event.target.value })} />
        </label>
      </div>
      <label className="field">{t("Proxy username")}
        <input autoComplete="off" value={value.username} onChange={(event) => update({ username: event.target.value })} />
      </label>
      <label className="field">{t("Proxy password")}
        <input type="password" autoComplete="new-password" disabled={!value.username.trim() || value.clearPassword}
          value={value.password} placeholder={keepPassword ? t("Keep saved password") : undefined}
          onChange={(event) => update({ password: event.target.value })} />
      </label>
      {keepPassword && <label className="field-checkbox">
        <span>{t("Clear saved password")}</span>
        <input type="checkbox" checked={value.clearPassword}
          onChange={(event) => update({ clearPassword: event.target.checked })} />
      </label>}
      <label className="field">{t("Resolve destination names")}
        <select aria-label={t("Resolve destination names")} value={value.resolveLocally ? "local" : "proxy"}
          onChange={(event) => update({ resolveLocally: event.target.value === "local" })}>
          <option value="proxy">{t("At the proxy")}</option>
          <option value="local">{t("On this computer")}</option>
        </select>
      </label>
      <label className="field-checkbox">
        <span>{t("Connect directly to localhost and loopback addresses")}</span>
        <input type="checkbox" checked={value.skipLoopback}
          onChange={(event) => update({ skipLoopback: event.target.checked })} />
      </label>
      {activeFtp && <p className="search-hint">{t("FTP proxy connections require passive data mode.")}</p>}
      {jumpRoute && <p className="search-hint">{t("The proxy connects to the first SSH jump host. SSH handles the remaining hops.")}</p>}
    </>}
  </>;
}
