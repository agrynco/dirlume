import { useEffect, useState, type FormEvent } from "react";
import { api, describeError, type ComputerSharing, type SavedConnection } from "./api";
import { Button } from "./Button";
import { errorText, t } from "./i18n";
import { RemoveConnectionDialog } from "./SavedConnectionDialog";
import { readRemoteProfiles, saveRemoteConnection } from "./savedConnections";

export function ComputersSettings() {
  const [name, setName] = useState("");
  const [computers, setComputers] = useState(readRemoteProfiles);
  const [removing, setRemoving] = useState<SavedConnection | null>(null);
  const [activeSharing, setActiveSharing] = useState<ComputerSharing | null>(null);
  const [pairCode, setPairCode] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let current = true;
    void api.computerName().then((name) => { if (current) setName(name ?? ""); }).catch(() => {});
    void api.activeComputerSharing().then((sharing) => { if (current) setActiveSharing(sharing); })
      .catch((error: unknown) => { if (current) setError(describeError(error)); });
    const refresh = () => setComputers(readRemoteProfiles());
    window.addEventListener("storage", refresh);
    return () => {
      current = false;
      window.removeEventListener("storage", refresh);
    };
  }, []);

  async function runPairing(action: () => Promise<void>) {
    setWorking(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(describeError(error));
    } finally {
      setWorking(false);
    }
  }

  function addComputer(event: FormEvent) {
    event.preventDefault();
    void runPairing(async () => {
      const code = pairCode.trim();
      const remoteName = await api.verifyComputerPairing(code);
      await saveRemoteConnection(remoteName, "server", code, undefined, true);
      setComputers(readRemoteProfiles());
      setPairCode("");
    });
  }

  return <div className="dialog-body settings-general">
    {name && <div className="setting"><span>{t("This computer")}</span><strong>{name}</strong></div>}
    <fieldset>
      <legend>{t("Saved computers")}</legend>
      {computers.length === 0 ? <p>{t("No saved computers.")}</p> :
        <ul className="computer-settings-list">
          {computers.map((computer) => <li key={computer.id}>
            <span>{computer.label}</span>
            <Button type="button" aria-label={t("Forget {0}", computer.label)} onClick={() => setRemoving(computer)}>
              {t("Forget computer")}
            </Button>
          </li>)}
        </ul>}
    </fieldset>
    <fieldset disabled={working}>
      <legend>{t("Dirlume LAN")}</legend>
      <p>{t("Pairing lets another computer browse and download files from your local drives while Dirlume is running.")}</p>
      <div className="dialog-actions">
        {activeSharing ? <>
          <Button type="button" onClick={() => { void runPairing(async () => {
            await api.copyText(activeSharing.invitation);
            setCopied(true);
          }); }}>{t("Copy pairing code")}</Button>
          <Button type="button" onClick={() => { void runPairing(async () => {
            await api.stopComputerSharing();
            setActiveSharing(null);
            setCopied(false);
          }); }}>{t("Stop access to this computer")}</Button>
        </> : <Button type="button" onClick={() => { void runPairing(async () => {
          setActiveSharing(await api.startComputerSharing());
        }); }}>{t("Generate pairing code")}</Button>}
      </div>
      {copied && <p role="status">{t("Pairing code copied.")}</p>}
      <form onSubmit={addComputer}>
        <label className="field">{t("Pairing code")}
          <input type="password" autoComplete="off" spellCheck={false} value={pairCode}
            onChange={(event) => setPairCode(event.target.value)} required />
        </label>
        <Button type="submit" disabled={!pairCode.trim()}>{t("Pair computer")}</Button>
      </form>
      {error && <p role="alert" className="dialog-error">{errorText(error)}</p>}
    </fieldset>
    {removing && <RemoveConnectionDialog profile={removing} onRemoved={() => {
      setComputers(readRemoteProfiles());
      setRemoving(null);
    }} onClose={() => setRemoving(null)} />}
  </div>;
}
