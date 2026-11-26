import { useId, type FormEvent, type ReactNode } from "react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { HistoryField } from "./HistoryField";
import { t } from "./i18n";

export type ConnectionDraft = { label: string; host: string; port: string; username: string; portEdited: boolean };

export function NetBoxSession({ editing, protocol, onChangeProtocol, working, saveDisabled, onSave, onClose, children }: {
  editing: boolean;
  protocol: "ftp" | "sftp";
  onChangeProtocol?: () => void;
  working?: "save" | "test";
  saveDisabled?: boolean;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const heading = useId();
  return <Dialog title={t(editing ? "Edit NetBox connection" : "Add NetBox connection")} onClose={() => { if (!working) onClose(); }}>
    <form className="dialog-form" onSubmit={onSave} autoComplete="off">
      <div className="dialog-body ftp-fields" role="group" aria-labelledby={heading} inert={!!working}>
        <h3 id={heading}>{t("Session")}</h3>
        <label className="field">{t("Protocol")}
          <select aria-label={t("Protocol")} value={protocol} disabled={!onChangeProtocol} onChange={onChangeProtocol}>
            <option value="ftp">FTP</option>
            <option value="sftp">SFTP (SSH)</option>
          </select>
        </label>
        {children}
      </div>
      <footer className="dialog-footer">
        <Button type="button" disabled={!!working} onClick={onClose}>{t("Cancel")}</Button>
        <Button type="submit" className="primary" disabled={!!working || saveDisabled}>{t(working === "save" ? "Saving…" : "Save connection")}</Button>
      </footer>
    </form>
  </Dialog>;
}

export function ConnectionNameField({ protocol, label, onChange }: {
  protocol: "ftp" | "ssh";
  label: string;
  onChange: (label: string) => void;
}) {
  return <label className="field">{t("Connection name")}
    <HistoryField historyKey={protocol + "-name"} aria-label={t("Connection name")} data-initial-focus
      required value={label} onValueChange={onChange} />
  </label>;
}

export function ConnectionHostFields({ protocol, connection, onChange, jump = false }: {
  protocol: "ftp" | "ssh";
  connection: Pick<ConnectionDraft, "host" | "port" | "username" | "portEdited">;
  onChange: (change: Partial<Pick<ConnectionDraft, "host" | "port" | "username" | "portEdited">>) => void;
  jump?: boolean;
}) {
  return <>
    <div className="ftp-host-row">
      <label className="field">{t("Server")}
        <HistoryField historyKey={protocol + "-host"} aria-label={t("Server")} required spellCheck={false}
          placeholder={jump ? "bastion.example.com" : protocol + ".example.com"}
          value={connection.host} onValueChange={(host) => onChange({ host })} />
      </label>
      <label className="field">{t("Port")}
        <input required type="number" min={1} max={65535} value={connection.port}
          onChange={(event) => onChange({ port: event.target.value, portEdited: true })} />
      </label>
    </div>
    <label className="field">{t("Username")}
      <HistoryField historyKey={protocol + "-username"} aria-label={t("Username")} required={protocol === "ssh"}
        placeholder={protocol === "ftp" ? t("Anonymous") : undefined} spellCheck={false}
        value={connection.username} onValueChange={(username) => onChange({ username })} />
    </label>
  </>;
}
