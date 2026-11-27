import { useRef, useState, type FormEvent } from "react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Message } from "./Message";
import { describeError } from "./api";
import { errorText, t } from "./i18n";

export function SudoDialog({ address, path, operation, onConfirm, onClose }: {
  address: string;
  path: string;
  operation: "browse" | "read" | "save" | "createFolder" | "createFile" | "transfer" | "delete";
  onConfirm: (password: string) => Promise<void>;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const descriptions = {
    browse: "Use sudo on {0} to open this folder?",
    read: "Use sudo on {0} to read this file?",
    save: "Use sudo on {0} to save changes to this file?",
    createFolder: "Use sudo on {0} to create this folder?",
    createFile: "Use sudo on {0} to create this file?",
    transfer: "Use sudo on {0} to continue this transfer?",
    delete: "Use sudo on {0} to continue removing this item?",
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (running.current || !input.current) return;
    const password = input.current.value;
    input.current.value = "";
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await onConfirm(password);
      onClose();
    } catch (failure) {
      setError(describeError(failure));
      requestAnimationFrame(() => input.current?.focus());
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return <Dialog title={t("SSH permissions")} tone="warning" onClose={() => { if (!running.current) onClose(); }}>
    <form className="dialog-form" onSubmit={(event) => { void submit(event); }}>
      <div className="dialog-body sudo-body">
        <p><Message text={descriptions[operation]}><strong>{address}</strong></Message></p>
        <p><code>{path}</code></p>
        <label className="field">{t("Sudo password")}
          <input ref={input} data-initial-focus type="password" autoComplete="off" disabled={busy} />
        </label>
        <small>{t("Leave blank if the server allows sudo without a password.")}</small>
        <small>{t("Sudo access on this connection expires after 5 minutes of inactivity.")}</small>
        {error && <p className="dialog-error" role="alert">{errorText(error)}</p>}
      </div>
      <footer className="dialog-footer">
        <Button type="button" disabled={busy} onClick={onClose}>{t("Cancel")}</Button>
        <Button type="submit" className="alert-confirm" disabled={busy}>{t(busy ? "Working…" : "Continue with sudo")}</Button>
      </footer>
    </form>
  </Dialog>;
}
