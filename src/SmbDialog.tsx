import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, describeError, placePath, smbLocation, type Listing, type SmbPlace } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { t } from "./i18n";
import { readSmbLocations, saveSmbLocation } from "./savedConnections";

export function SmbDialog({ path, onClose, onConnect }: {
  path: string;
  onClose: () => void;
  onConnect: (place: SmbPlace, listing: Listing, warning: string | null) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [saveLocation, setSaveLocation] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const usernameField = useRef<HTMLInputElement>(null);

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!busy) usernameField.current?.focus();
  }, [busy]);

  const saved = readSmbLocations().some((entry) => entry.path.toLowerCase() === path.toLowerCase());

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (request.current) return;
    const attempt = new AbortController();
    request.current = attempt;
    setBusy(true);
    setError("");
    try {
      const result = await api.connectSmb(path, { username, password }, remember);
      if (attempt.signal.aborted) return;
      if (result.kind === "credentials_required") {
        setPassword("");
        setError(result.error ?? "");
        return;
      }
      const { place, listing } = smbLocation(result);
      const location = placePath(place);
      if (saveLocation && !saved) saveSmbLocation(location, location);
      onConnect(place, listing, result.warning);
    } catch (failure) {
      if (!attempt.signal.aborted) setError(describeError(failure));
    } finally {
      if (!attempt.signal.aborted) {
        request.current = null;
        setBusy(false);
      }
    }
  }

  return <Dialog title={t("Connect to SMB")} onClose={onClose}>
    <form className="dialog-form" onSubmit={(event) => { void connect(event); }}>
      <div className="dialog-body transfer-body">
        <label className="field">{t("SMB server or share")}
          <input readOnly value={path} />
        </label>
        {!saved && <label className="field-checkbox">
          <span>{t("Save SMB location")}</span>
          <input type="checkbox" checked={saveLocation} disabled={busy} onChange={(event) => setSaveLocation(event.target.checked)} />
        </label>}
        <label className="field">{t("Username")}
          <input ref={usernameField} data-initial-focus value={username} disabled={busy} required autoComplete="username"
            onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label className="field">{t("Password")}
          <input type="password" value={password} disabled={busy} autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)} />
        </label>
        <label className="field-checkbox">
          <span>{t("Remember credentials")}</span>
          <input type="checkbox" checked={remember} disabled={busy} onChange={(event) => setRemember(event.target.checked)} />
        </label>
        {busy && <div role="status">{t("Connecting…")}</div>}
        {error && <div role="alert">{error}</div>}
      </div>
      <footer className="dialog-footer">
        <Button type="button" onClick={onClose}>{t("Cancel")}</Button>
        <Button type="submit" className="primary" disabled={busy}>{t("Connect")}</Button>
      </footer>
    </form>
  </Dialog>;
}
