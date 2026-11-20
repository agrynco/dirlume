import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, describeError, placePath, smbLocation, type Listing, type SmbPlace } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { HistoryField } from "./HistoryField";
import { t } from "./i18n";

const savedKey = "dirlume.smb-locations";

function readSaved() {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(savedKey) ?? "[]");
    return Array.isArray(value) ? value.filter((path): path is string => typeof path === "string") : [];
  } catch { return []; }
}

export function SmbDialog({ initialPath, onClose, onConnect }: {
  initialPath?: string;
  onClose: () => void;
  onConnect: (place: SmbPlace, listing: Listing, warning: string | null) => void;
}) {
  const [path, setPath] = useState(initialPath ?? "");
  const [needsCredentials, setNeedsCredentials] = useState(!!initialPath);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [saveLocation, setSaveLocation] = useState(false);
  const [saved, setSaved] = useState(readSaved);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const usernameField = useRef<HTMLInputElement>(null);

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (needsCredentials && !busy) usernameField.current?.focus();
  }, [needsCredentials, busy]);

  function updateSaved(locations: string[]) {
    try {
      localStorage.setItem(savedKey, JSON.stringify(locations));
      setSaved(locations);
    } catch {
      setError(t("Could not save SMB locations."));
    }
  }

  function changePath(value: string) {
    setPath(value);
    setNeedsCredentials(false);
    setUsername("");
    setPassword("");
    setRemember(false);
    setError("");
  }

  async function connect(value: string, withCredentials: boolean) {
    if (request.current) return;
    const attempt = new AbortController();
    request.current = attempt;
    setBusy(true);
    setError("");
    try {
      const result = await api.connectSmb(value, withCredentials ? { username, password } : null, withCredentials && remember);
      if (attempt.signal.aborted) return;
      if (result.kind === "credentials_required") {
        setNeedsCredentials(true);
        setPassword("");
        setError(result.error ?? "");
        return;
      }
      const { place, listing } = smbLocation(result);
      const location = placePath(place);
      if (saveLocation && !saved.some((entry) => entry.toLowerCase() === location.toLowerCase())) updateSaved([...saved, location]);
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
    <form className="dialog-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void connect(path, needsCredentials); }}>
      <div className="dialog-body transfer-body">
        {!initialPath && saved.length > 0 && <div className="field">
          <span>{t("Saved SMB locations")}</span>
          <div className="smb-locations">
            {saved.map((location) => <div key={location} className="smb-location">
              <Button type="button" disabled={busy} onClick={() => {
                changePath(location);
                void connect(location, false);
              }}>{location}</Button>
              <Button type="button" disabled={busy} onClick={() => updateSaved(saved.filter((entry) => entry !== location))}>
                {t("Remove")}
              </Button>
            </div>)}
          </div>
        </div>}
        <label className="field">{t("SMB server or share")}
          <HistoryField historyKey="smb-share" data-initial-focus={!initialPath || undefined} required disabled={busy || !!initialPath}
            aria-describedby="smb-path-hint" placeholder="192.168.1.10" value={path} onValueChange={changePath} />
        </label>
        <p id="smb-path-hint" className="appearance-hint">
          {t("Enter an IP or server name to browse shares, or a path such as {0}.", "\\\\server\\documents")}
        </p>
        <label className="field-checkbox">
          <span>{t("Save SMB location")}</span>
          <input type="checkbox" checked={saveLocation} disabled={busy} onChange={(event) => setSaveLocation(event.target.checked)} />
        </label>
        {needsCredentials && <>
          <label className="field">{t("Username")}
            <input ref={usernameField} data-initial-focus={!!initialPath || undefined} value={username} disabled={busy} required autoComplete="username"
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
        </>}
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
