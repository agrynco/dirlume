import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Channel } from "@tauri-apps/api/core";
import { api, describeError, type ArchiveSettings } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { errorText, t } from "./i18n";
import { PathField } from "./PathField";

export const passwordError = "The archive needs a correct password.";
const exists = "The destination archive already exists.";
const profileKey = "dirlume.archive-profiles.v1";
const defaultsKey = "dirlume.archive-defaults.v1";
const defaults: ArchiveSettings = {
  format: "7z", appendExtension: true, level: 5, method: "", solid: true, encrypted: false,
  encryptHeaders: false, volumeBytes: null, selfExtracting: false, exclude: "", openForWriting: false, keepWarnings: false,
};
const methods: Record<string, string[]> = {
  "7z": ["LZMA2", "LZMA", "PPMd", "BZip2", "Copy"],
  zip: ["Deflate", "Deflate64", "BZip2", "Copy"],
};
let nextJob = 0;

export const isArchiveName = (name: string) => /\.(?:7z|zip|tar|tgz|rar|wim|gz|bz2|xz|zst)(?:\.001)?$/i.test(name);

function readSettings(input: unknown): ArchiveSettings {
  if (!input || typeof input !== "object") return defaults;
  const candidate = input as Record<string, unknown>;
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const value = candidate[key];
    return [key, key === "volumeBytes" ? typeof value === "number" && value > 0 ? value : null :
      typeof value === typeof fallback ? value : fallback];
  })) as ArchiveSettings;
}

type Profile = { name: string; settings: ArchiveSettings };
function readProfiles() {
  try {
    const loaded: unknown = JSON.parse(localStorage.getItem(profileKey) ?? "[]");
    return Array.isArray(loaded) ? loaded.filter((item): item is Profile => typeof item?.name === "string")
      .map((item) => ({ name: item.name, settings: readSettings(item.settings) })) : [];
  } catch { return []; }
}

export function ArchiveDialog({ directory, names, showHidden, onClose, onCreated }: {
  directory: string; names: string[]; showHidden: boolean; onClose: () => void; onCreated: () => void;
}) {
  const destinationId = useId();
  const [settings, setSettings] = useState(() => {
    try { return readSettings(JSON.parse(localStorage.getItem(defaultsKey) ?? "null")); } catch { return defaults; }
  });
  const [profiles, setProfiles] = useState(readProfiles);
  const [profile, setProfile] = useState("");
  const [profileName, setProfileName] = useState("");
  const [capabilities, setCapabilities] = useState<{ formats: string[]; sfx: boolean }>();
  const [destination, setDestination] = useState(names.length === 1 ? names[0].replace(/\.[^.]+$/, "") || names[0] : "Archive");
  const [deleteSources, setDeleteSources] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [replace, setReplace] = useState(false);
  const [warning, setWarning] = useState("");
  const [error, setError] = useState("");
  const running = useRef(0);
  const encryption = settings.format === "7z" || settings.format === "zip";
  const destinationSuffix = settings.selfExtracting ? "exe" : settings.format;
  const suggestedFile = destination.endsWith("." + destinationSuffix) || !settings.appendExtension
    ? destination : destination + "." + destinationSuffix;

  useEffect(() => {
    let live = true;
    void api.archiveCapabilities().then((available) => {
      if (!live) return;
      setCapabilities(available);
      setSettings((current) => available.formats.includes(current.format)
        ? { ...current, selfExtracting: current.selfExtracting && available.sfx }
        : { ...defaults, format: available.formats[0] ?? "7z" });
    }, (failure: unknown) => { if (live) setError(describeError(failure)); });
    return () => {
      live = false;
      if (running.current) void api.cancelArchive(running.current).catch(() => {});
    };
  }, []);

  function change<K extends keyof ArchiveSettings>(key: K, value: ArchiveSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function format(format: string) {
    setSettings((current) => ({ ...current, format, method: "", encrypted: false, encryptHeaders: false, selfExtracting: false }));
  }

  function chooseProfile(name: string) {
    setProfile(name);
    const loaded = profiles.find((item) => item.name === name);
    if (!loaded || !capabilities?.formats.includes(loaded.settings.format)) return;
    setSettings({ ...loaded.settings, selfExtracting: loaded.settings.selfExtracting && capabilities.sfx });
    setPassword("");
    setConfirmPassword("");
  }

  function saveProfile() {
    const name = profileName.trim();
    if (!name) return;
    const next = [{ name, settings }, ...profiles.filter((item) => item.name !== name)];
    try {
      localStorage.setItem(profileKey, JSON.stringify(next));
      setProfiles(next);
      setProfile(name);
      setProfileName("");
    } catch (failure) { setError(describeError(failure)); }
  }

  function close() {
    if (running.current) {
      setCanceling(true);
      void api.cancelArchive(running.current).catch((failure: unknown) => setError(describeError(failure)));
    } else onClose();
  }

  async function submit(overwrite: boolean) {
    if (running.current || !capabilities?.formats.includes(settings.format)) return;
    if (settings.encrypted && encryption && (!password || password !== confirmPassword)) {
      setError(t("Enter matching archive passwords."));
      return;
    }
    setError("");
    setReplace(false);
    const id = ++nextJob;
    const channel = new Channel<number>();
    channel.onmessage = setProgress;
    running.current = id;
    setProgress(0);
    try {
      const { encrypted, ...options } = settings;
      const created = await api.createArchive(id, {
        ...options, directory, names, destination, deleteSources, overwrite,
        password: encrypted && encryption ? password : null,
        encryptHeaders: encrypted && options.format === "7z" && options.encryptHeaders,
      }, channel);
      try { localStorage.setItem(defaultsKey, JSON.stringify(settings)); } catch { /* Archive creation already succeeded. */ }
      onCreated();
      if (created.warning) setWarning(created.warning);
      else onClose();
    } catch (failure) {
      const error = describeError(failure);
      if (error === exists && !settings.volumeBytes) setReplace(true);
      else setError(error);
    } finally {
      channel.onmessage = () => {};
      running.current = 0;
      setProgress(null);
      setCanceling(false);
    }
  }

  const fieldCheck = (label: string, checked: boolean, toggle: (value: boolean) => void, disabled = false) =>
    <label className="transfer-checkbox"><input type="checkbox" checked={checked} disabled={disabled}
      onChange={(event) => toggle(event.target.checked)} /> {t(label)}</label>;

  return <>
    <Dialog title={t("Create archive")} wide onClose={close}>
      <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); void submit(false); }}>
        <div className="dialog-body">
          {progress !== null ? <div className="archive-progress">
            <progress aria-label={t("Archive progress")} value={progress} max={100} />
            <span>{progress}%</span>
          </div> : warning ? <p role="status">{t(warning)}</p> : <>
            <div className="field">
              <label htmlFor={destinationId}>{t("Archive path")}</label>
              <PathField id={destinationId} label={t("Archive path")} value={destination} onChange={setDestination}
                baseDirectory={directory} includeFiles showHidden={showHidden} required initialFocus browse="save"
                browsePath={/^(?:[A-Z]:[\\/]|[\\/])/i.test(suggestedFile) ? suggestedFile : directory + "/" + suggestedFile} />
            </div>
            {fieldCheck("Append extension", settings.appendExtension, (value) => change("appendExtension", value))}
            <div className="archive-settings">
              <label className="field">{t("Format")}
                <select value={settings.format} aria-label={t("Format")} onChange={(event) => format(event.target.value)}>
                  {(capabilities?.formats ?? [settings.format]).map((type) => <option key={type} value={type}>{type.toUpperCase()}</option>)}
                </select>
              </label>
              <label className="field">{t("Compression level")}
                <select value={settings.level} aria-label={t("Compression level")} disabled={!encryption}
                  onChange={(event) => change("level", Number(event.target.value))}>
                  {[0, 1, 3, 5, 7, 9].map((level) => <option key={level}>{level}</option>)}
                </select>
              </label>
              <label className="field">{t("Compression method")}
                <select value={settings.method} aria-label={t("Compression method")} disabled={!encryption}
                  onChange={(event) => change("method", event.target.value)}>
                  <option value="">{t("Default")}</option>
                  {(methods[settings.format] ?? []).map((method) => <option key={method}>{method}</option>)}
                </select>
              </label>
              {settings.format === "7z" && fieldCheck("Solid compression", settings.solid, (value) => change("solid", value))}
            </div>
            {encryption && fieldCheck("Encrypt archive", settings.encrypted, (value) => change("encrypted", value))}
            {settings.encrypted && encryption && <>
              <div className="archive-settings">
                <label className="field">{t("Password")} <input type={showPassword ? "text" : "password"} autoComplete="new-password"
                  value={password} onChange={(event) => setPassword(event.target.value)} /></label>
                <label className="field">{t("Confirm password")} <input type={showPassword ? "text" : "password"} autoComplete="new-password"
                  value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
              </div>
              {fieldCheck("Show password", showPassword, setShowPassword)}
              {settings.format === "7z" && fieldCheck("Encrypt headers", settings.encryptHeaders, (value) => change("encryptHeaders", value))}
            </>}
            <details className="archive-advanced">
              <summary>{t("Advanced options")}</summary>
              <div className="archive-settings">
                <label className="field">{t("Volume size (MiB)")}
                  <input type="number" min="1" step="1" disabled={settings.selfExtracting} value={settings.volumeBytes ? settings.volumeBytes / 1048576 : ""}
                    onChange={(event) => change("volumeBytes", Number(event.target.value) * 1048576 || null)} /></label>
                <label className="field">{t("Exclude names matching")}
                  <input type="text" placeholder="*.tmp; *.log" value={settings.exclude} onChange={(event) => change("exclude", event.target.value)} /></label>
              </div>
              {capabilities?.sfx && settings.format === "7z" && fieldCheck("Self-extracting archive", settings.selfExtracting,
                (value) => change("selfExtracting", value), settings.volumeBytes !== null)}
              {fieldCheck("Include files open for writing", settings.openForWriting, (value) => change("openForWriting", value))}
              {fieldCheck("Keep archive if 7-Zip reports warnings", settings.keepWarnings, (value) => change("keepWarnings", value))}
              {fieldCheck("Move source items to Trash after archiving", deleteSources, setDeleteSources)}
            </details>
            <div className="archive-profiles">
              <label className="field">{t("Archive profile")} <select aria-label={t("Archive profile")} value={profile} onChange={(event) => chooseProfile(event.target.value)}>
                <option value="">{t("Custom")}</option>
                {profiles.map(({ name, settings }) => <option key={name} disabled={!capabilities?.formats.includes(settings.format)}>{name}</option>)}
              </select></label>
              <label className="field">{t("Profile name")} <input value={profileName} onChange={(event) => setProfileName(event.target.value)} /></label>
              <Button type="button" onClick={saveProfile} disabled={!profileName.trim()}>{t("Save profile")}</Button>
            </div>
          </>}
          {error && <p className="dialog-error" role="alert">{errorText(error)}</p>}
        </div>
        <footer className="dialog-footer">
          <Button type="button" disabled={canceling} onClick={close}>{t(warning ? "Done" : canceling ? "Canceling…" : "Cancel")}</Button>
          {progress === null && !warning && <Button type="submit" className="primary" disabled={!capabilities?.formats.length || !destination.trim()}>{t("Create")}</Button>}
        </footer>
      </form>
    </Dialog>
    {replace && <Dialog title={t("Replace archive?")} onClose={() => setReplace(false)}>
      <div className="dialog-body"><p>{t(exists)}</p><p>{suggestedFile}</p></div>
      <footer className="dialog-footer">
        <Button type="button" data-initial-focus onClick={() => setReplace(false)}>{t("Cancel")}</Button>
        <Button type="button" className="negative" onClick={() => { void submit(true); }}>{t("Overwrite")}</Button>
      </footer>
    </Dialog>}
  </>;
}

export function ArchivePasswordDialog({ onOpen, onClose }: { onOpen: (password: string) => Promise<void>; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try { await onOpen(password); } catch (failure) { setError(describeError(failure)); } finally { setBusy(false); }
  }
  return <Dialog title={t("Archive password")} onClose={() => { if (!busy) onClose(); }}>
    <form className="dialog-form" onSubmit={(event) => { void submit(event); }}>
      <div className="dialog-body">
        <label className="field">{t("Password")}
          <input type={visible ? "text" : "password"} data-initial-focus required autoComplete="off" disabled={busy}
            value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        <label className="transfer-checkbox"><input type="checkbox" checked={visible}
          onChange={(event) => setVisible(event.target.checked)} /> {t("Show password")}</label>
        {error && <p role="alert" className="dialog-error">{errorText(error)}</p>}
      </div>
      <footer className="dialog-footer">
        <Button type="button" disabled={busy} onClick={onClose}>{t("Cancel")}</Button>
        <Button type="submit" className="primary" disabled={busy || !password}>{t(busy ? "Working…" : "Open")}</Button>
      </footer>
    </form>
  </Dialog>;
}
