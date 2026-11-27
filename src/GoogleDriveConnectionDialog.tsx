import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ExternalLink, LoaderCircle } from "lucide-react";
import { api, describeError, type GoogleDriveProfile } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { errorText, t } from "./i18n";

export function GoogleDriveConnectionDialog({ profile, onSaved, onRemove, onClose }: {
  profile?: GoogleDriveProfile;
  onSaved: (id: string) => void;
  onRemove: (profile: GoogleDriveProfile) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(profile?.label ?? "");
  const [working, setWorking] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState("");
  const attempt = useRef<string | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const signInButton = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (signingIn) cancelButton.current?.focus();
    else if (error) signInButton.current?.focus();
  }, [signingIn, error]);

  function close() {
    if (working) return;
    if (attempt.current) void api.cancelGoogleDriveSignIn(attempt.current).catch(() => {});
    attempt.current = null;
    onClose();
  }

  async function signIn() {
    if (attempt.current || working) return;
    const id = crypto.randomUUID();
    attempt.current = id;
    setSigningIn(true);
    setError("");
    try {
      const saved = await api.signInGoogleDrive(id, profile?.id);
      if (attempt.current === id) onSaved(saved);
    } catch (failure) {
      if (attempt.current === id) setError(describeError(failure));
    } finally {
      if (attempt.current === id) {
        attempt.current = null;
        setSigningIn(false);
      }
    }
  }

  async function rename(event: FormEvent) {
    event.preventDefault();
    if (!profile || !name.trim() || signingIn || working) return;
    setWorking(true);
    setError("");
    try {
      await api.renameGoogleDrive(profile.id, name.trim());
      onSaved(profile.id);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setWorking(false);
    }
  }

  const browserButton = !signingIn && <Button ref={signInButton} type="button"
    className={profile ? undefined : "primary"} data-initial-focus={profile ? undefined : true}
    disabled={working} onClick={() => { void signIn(); }}>
    {t(profile ? "Reconnect" : "Sign in with Google")}<ExternalLink aria-hidden="true" />
  </Button>;

  return <Dialog title={t(profile ? "Edit Google Drive connection" : "Add Google Drive connection")}
    helpTopic="googleDrive" onClose={close}>
    <form className="dialog-form" onSubmit={(event) => { void rename(event); }}>
      <div className="dialog-body google-drive-connection-body">
        {profile && <>
          <label className="field">{t("Connection name")}
            <input data-initial-focus required value={name} onChange={(event) => setName(event.target.value)} disabled={working || signingIn} />
          </label>
          <div className="google-drive-account">
            <div><strong>{t("Account email")}</strong><p dir="auto">{profile.email}</p></div>
            {browserButton}
          </div>
        </>}
        {signingIn ? <div className="google-drive-sign-in-status" role="status">
          <LoaderCircle className="spin" aria-hidden="true" />
          <div>
            <strong>{t("Waiting for Google")}</strong>
            <p>{t("Finish signing in to Google in your browser.")}</p>
          </div>
        </div> : !profile && <p>{t("Dirlume opens your browser to request access to view and manage files in My Drive.")}</p>}
        {error && <p className="dialog-error" role="alert">{errorText(error)}</p>}
      </div>
      <footer className="dialog-footer">
        {profile && !signingIn && <Button type="button" className="google-drive-remove" disabled={working}
          onClick={() => onRemove(profile)}>{t("Remove connection")}</Button>}
        <Button ref={cancelButton} type="button" disabled={working} onClick={close}>
          {t(signingIn ? "Cancel sign-in" : "Cancel")}
        </Button>
        {!profile && browserButton}
        {profile && !signingIn && <Button className="primary" type="submit"
          disabled={working || !name.trim() || name.trim() === profile.label}>{t("Save")}</Button>}
      </footer>
    </form>
  </Dialog>;
}
