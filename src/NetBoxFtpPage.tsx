import { useState } from "react";
import type { FtpOptions } from "./api";
import { t } from "./i18n";

export const defaultFtpOptions: FtpOptions = {
  mlsd: "auto", activeMode: false, emptyPassword: false, postLoginCommands: [], rawIacCommands: false, rawIacPwd: false,
};

export function NetBoxFtpPage({ value, onChange }: { value: FtpOptions; onChange: (value: FtpOptions) => void }) {
  const [commands, setCommands] = useState(() => value.postLoginCommands.join("\n"));
  return <>
    <label className="field">{t("MLSD policy")}
      <select aria-label={t("MLSD policy")} value={value.mlsd} onChange={({ target }) => {
        const mode = target.value;
        onChange({ ...value, mlsd: mode === "on" || mode === "off" ? mode : "auto" });
      }}>
        <option value="auto">{t("Auto")}</option>
        <option value="on">{t("On")}</option>
        <option value="off">{t("Off")}</option>
      </select>
    </label>
    <label className="field">{t("Data connection mode")}
      <select aria-label={t("Data connection mode")} value={value.activeMode ? "active" : "passive"}
        onChange={({ target }) => onChange({ ...value, activeMode: target.value === "active" })}>
        <option value="passive">{t("Passive")}</option>
        <option value="active">{t("Active")}</option>
      </select>
    </label>
    {value.activeMode && <p className="search-hint">{t("Active mode requires the server to reach a listener on this computer.")}</p>}
    <label className="field-checkbox">
      <span>{t("Send an empty password")}</span>
      <input type="checkbox" checked={value.emptyPassword}
        onChange={({ target }) => onChange({ ...value, emptyPassword: target.checked })} />
    </label>
    <label className="field">{t("Post-login commands (one per line)")}
      <textarea rows={3} value={commands} onChange={({ target }) => {
        setCommands(target.value);
        onChange({ ...value, postLoginCommands: target.value.split("\n").map((command) => command.trimStart()).filter((command) => command.trim()) });
      }} />
    </label>
    <label className="field-checkbox">
      <span>{t("Send byte 0xFF without doubling")}</span>
      <input type="checkbox" checked={value.rawIacCommands}
        onChange={({ target }) => onChange({ ...value, rawIacCommands: target.checked })} />
    </label>
    <label className="field-checkbox">
      <span>{t("Keep doubled 0xFF bytes in PWD replies")}</span>
      <input type="checkbox" checked={value.rawIacPwd}
        onChange={({ target }) => onChange({ ...value, rawIacPwd: target.checked })} />
    </label>
  </>;
}
