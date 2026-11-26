import { useState } from "react";
import type { ConnectionPreferences, ConnectionTiming } from "./api";
import { t } from "./i18n";

export const defaultConnectionPreferences: ConnectionPreferences = {
  timeout: { mode: "default" }, keepalive: { mode: "default" }, addressFamily: "auto", optimizeBuffer: false,
};

function TimingField({ label, interval, value, initialSeconds, onChange }: {
  label: string;
  interval: string;
  value: ConnectionTiming;
  initialSeconds: number;
  onChange: (value: ConnectionTiming) => void;
}) {
  const [seconds, setSeconds] = useState(value.mode === "custom" ? String(value.seconds) : String(initialSeconds));
  return <>
    <label className="field">{t(label)}
      <select value={value.mode} onChange={({ target }) => {
        const mode = target.value;
        if (mode === "custom") {
          const duration = Number(seconds);
          onChange({ mode, seconds: duration >= 1 && duration <= 3600 ? duration : initialSeconds });
        } else onChange({ mode: mode === "disabled" ? "disabled" : "default" });
      }}>
        <option value="default">{t("Default")}</option>
        <option value="disabled">{t("Disabled")}</option>
        <option value="custom">{t("Custom")}</option>
      </select>
    </label>
    {value.mode === "custom" && <label className="field">{t(interval)}
      <input type="number" required min={1} max={3600} value={seconds} onChange={({ target }) => {
        setSeconds(target.value);
        if (Number.isInteger(target.valueAsNumber)) onChange({ mode: "custom", seconds: target.valueAsNumber });
      }} />
    </label>}
  </>;
}

export function NetBoxConnectionPage({ value, ftp, jumpRoute = false, onChange }: {
  value: ConnectionPreferences;
  ftp: boolean;
  jumpRoute?: boolean;
  onChange: (value: ConnectionPreferences) => void;
}) {
  return <>
    <TimingField label="Server response timeout" interval="Response timeout (seconds)" value={value.timeout}
      initialSeconds={ftp ? 12 : 15} onChange={(timeout) => onChange({ ...value, timeout })} />
    <TimingField label="Connection keepalive" interval="Keepalive interval (seconds)" value={value.keepalive}
      initialSeconds={30} onChange={(keepalive) => onChange({ ...value, keepalive })} />
    <p className="search-hint">{t(ftp ? "FTP uses TCP keepalive probes." : "SSH uses keepalive messages within the SSH connection.")}</p>
    <label className="field">{t("IP address family")}
      <select value={value.addressFamily} onChange={({ target }) => {
        const family = target.value;
        onChange({ ...value, addressFamily: family === "ipv4" || family === "ipv6" ? family : "auto" });
      }}>
        <option value="auto">{t("Auto")}</option>
        <option value="ipv4">IPv4</option>
        <option value="ipv6">IPv6</option>
      </select>
    </label>
    {jumpRoute && <p className="search-hint">{t("The address family applies only to the first SSH jump host. Each hop resolves the next host.")}</p>}
    {ftp && <label className="field-checkbox">
      <span>{t("Use larger FTP data buffers")}</span>
      <input type="checkbox" checked={value.optimizeBuffer}
        onChange={({ target }) => onChange({ ...value, optimizeBuffer: target.checked })} />
    </label>}
  </>;
}
