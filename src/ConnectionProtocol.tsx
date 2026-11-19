import { t } from "./i18n";

export type ConnectionDraft = { label: string; host: string; port: string; username: string };

export function ConnectionProtocol({ value, onChange }: { value: "ftp" | "sftp"; onChange: () => void }) {
  return <label className="field">{t("Protocol")}
    <select aria-label={t("Protocol")} value={value} onChange={onChange}>
      <option value="ftp">FTP</option>
      <option value="sftp">SFTP (SSH)</option>
    </select>
  </label>;
}
