import { ChevronLeft, ChevronRight } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { ConnectionPreferences, DirectoryPreferences, EnvironmentPreferences } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { HistoryField } from "./HistoryField";
import { t } from "./i18n";
import { bindingMatches, eventShortcut, showShortcut, type Bindings } from "./preferences";

export type ConnectionDraft = {
  label: string; host: string; port: string; username: string; portEdited: boolean; directories?: DirectoryPreferences;
  environment?: EnvironmentPreferences;
  connectionOptions?: ConnectionPreferences;
};

const pageLabels = {
  session: "Session", environment: "Environment", directories: "Directories",
  sftp: "SFTP", shell: "Shell", ftp: "FTP(S)", connection: "Connection", proxy: "Proxy",
} as const;
type Page = keyof typeof pageLabels;
type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export function NetBoxSession({ editing, protocol, onChangeProtocol, working, saveDisabled, onSave, onClose, onCancelTest, children, pages, feedback, bindings }: {
  editing: boolean;
  protocol: "ftp" | "sftp";
  onChangeProtocol?: () => void;
  working?: "save" | "test";
  saveDisabled?: boolean;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
  onCancelTest: () => void;
  children: ReactNode;
  pages?: Partial<Record<Exclude<Page, "session">, ReactNode>>;
  feedback?: ReactNode;
  bindings: Bindings;
}) {
  const id = useId();
  const [page, setPage] = useState<Page>("session");
  const available = (Object.keys(pageLabels) as Page[]).filter((key) => key === "session" ||
    pages?.[key] != null && (key === "ftp" ? protocol === "ftp" : key === "sftp" || key === "shell" ? protocol === "sftp" : true));
  const selected = available.includes(page) ? page : "session";
  const index = available.indexOf(selected);
  const activeTab = useRef<HTMLButtonElement>(null);
  const focusTab = useRef(false);
  const invalidControl = useRef<FormControl>(null);
  const reportingValidity = useRef(false);
  const previous = bindings.netboxPreviousPage;
  const next = bindings.netboxNextPage;

  useLayoutEffect(() => {
    if (page !== selected) setPage(selected);
    activeTab.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (focusTab.current) {
      focusTab.current = false;
      activeTab.current?.focus({ preventScroll: true });
    }
  }, [page, selected]);

  function showPage(target?: Page, bringFocus = false) {
    if (!target || target === selected || working) return;
    focusTab.current = bringFocus;
    setPage(target);
  }

  function pageKeys(event: KeyboardEvent) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.getModifierState("AltGraph")) return;
    const target = event.target as HTMLElement;
    if (target.closest("select, [aria-expanded=true]")) return;
    const shortcut = eventShortcut(event);
    const direction = bindingMatches(previous, shortcut) ? -1 : bindingMatches(next, shortcut) ? 1 : 0;
    if (!direction || target.closest("input, textarea, [contenteditable]") &&
        (!event.ctrlKey || event.key !== "PageUp" && event.key !== "PageDown")) return;
    event.preventDefault();
    showPage(available[index + direction], true);
  }

  function invalid(event: FormEvent<HTMLFormElement>) {
    if (reportingValidity.current) return;
    const control = event.target as FormControl;
    const owner = control.closest<HTMLElement>("[data-netbox-page]")?.dataset.netboxPage as Page | undefined;
    if (!owner) return;
    event.preventDefault();
    if (invalidControl.current) return;
    invalidControl.current = control;
    showPage(owner);
    requestAnimationFrame(() => {
      invalidControl.current = null;
      if (!control.isConnected) return;
      control.focus();
      reportingValidity.current = true;
      try { control.reportValidity(); }
      finally { reportingValidity.current = false; }
    });
  }

  function cancel() {
    if (working === "test") onCancelTest();
    if (!working) onClose();
  }

  return <Dialog title={t(editing ? "Edit NetBox connection" : "Add NetBox connection")} onClose={cancel}>
    <form className="dialog-form" onSubmit={onSave} onInvalidCapture={invalid} onKeyDown={pageKeys} autoComplete="off">
      <div className="netbox-page-header" inert={!!working}>
        <div className="netbox-tabs" role="tablist" aria-label={t("NetBox settings pages")} onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          const target = event.key === "ArrowLeft" ? available[index - 1] : event.key === "ArrowRight" ? available[index + 1] :
            event.key === "Home" ? available[0] : event.key === "End" ? available.at(-1) : undefined;
          if (!target) return;
          event.preventDefault();
          showPage(target, true);
        }}>
          {available.map((key) => <Button key={key} ref={key === selected ? activeTab : undefined}
            id={`${id}-tab-${key}`} type="button" role="tab" aria-controls={`${id}-page-${key}`}
            aria-selected={key === selected} tabIndex={key === selected ? 0 : -1}
            onClick={() => showPage(key)}>{t(pageLabels[key])}</Button>)}
        </div>
        <div className="netbox-page-arrows">
          <Button className="icon-button" type="button" aria-label={t("Previous settings page")}
            shortcut={showShortcut(previous[0])} disabled={index === 0} onClick={() => showPage(available[index - 1], true)}>
            <ChevronLeft />
          </Button>
          <Button className="icon-button" type="button" aria-label={t("Next settings page")}
            shortcut={showShortcut(next[0])} disabled={index === available.length - 1} onClick={() => showPage(available[index + 1], true)}>
            <ChevronRight />
          </Button>
        </div>
      </div>
      <div className="dialog-body" inert={!!working}>
        {available.map((key) => <div className="netbox-page ftp-fields" key={key} role="tabpanel"
          id={`${id}-page-${key}`} aria-labelledby={`${id}-tab-${key}`} data-netbox-page={key} hidden={key !== selected}>
          {key === "session" ? <>
            <label className="field">{t("Protocol")}
              <select aria-label={t("Protocol")} value={protocol} disabled={!onChangeProtocol} onChange={onChangeProtocol}>
                <option value="ftp">FTP</option>
                <option value="sftp">SFTP (SSH)</option>
              </select>
            </label>
            {children}
          </> : pages?.[key]}
        </div>)}
        {feedback && <div className="netbox-feedback">{feedback}</div>}
      </div>
      <footer className="dialog-footer">
        <Button type="button" disabled={working === "save"} onClick={cancel}>{t(working === "test" ? "Cancel test" : "Cancel")}</Button>
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
