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
  const [groupActive, setGroupActive] = useState(false);
  const [groupCode, setGroupCode] = useState("");
  const [groupCopied, setGroupCopied] = useState(false);
  const [groupError, setGroupError] = useState("");
  const [groupWritable, setGroupWritable] = useState(false);
  const [groupPeers, setGroupPeers] = useState<Awaited<ReturnType<typeof api.lanGroupPeers>>>([]);

  useEffect(() => {
    let current = true;
    void api.computerName().then((name) => { if (current) setName(name ?? ""); }).catch(() => {});
    void api.activeLanGroup().then((active) => { if (current) setGroupActive(Boolean(active)); })
      .catch((failure: unknown) => { if (current) setGroupError(describeError(failure)); });
    void api.lanGroupWritable().then((writable) => { if (current) setGroupWritable(Boolean(writable)); })
      .catch((failure: unknown) => { if (current) setGroupError(describeError(failure)); });
    void api.activeComputerSharing().then((sharing) => { if (current) setActiveSharing(sharing); })
      .catch((error: unknown) => { if (current) setError(describeError(error)); });
    const refresh = () => setComputers(readRemoteProfiles());
    window.addEventListener("storage", refresh);
    return () => {
      current = false;
      window.removeEventListener("storage", refresh);
    };
  }, []);

  useEffect(() => {
    if (!groupActive) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const peers = await api.lanGroupPeers();
        if (current) setGroupPeers(peers ?? []);
      } finally {
        if (current) timer = setTimeout(() => void refresh().catch(() => {}), 2_000);
      }
    }
    void refresh().catch(() => {});
    return () => { current = false; clearTimeout(timer); };
  }, [groupActive]);

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

  async function runGroup(action: () => Promise<void>) {
    setWorking(true);
    setGroupError("");
    setGroupCopied(false);
    try { await action(); }
    catch (failure) { setGroupError(describeError(failure)); }
    finally { setWorking(false); }
  }

  function startGroup(code?: string) {
    void runGroup(async () => {
      await api.startLanGroup(code);
      setGroupCode("");
      setGroupWritable(false);
      setGroupActive(true);
    });
  }

  return <div className="dialog-body settings-general">
    {name && <div className="setting"><span>{t("This computer")}</span><strong>{name}</strong></div>}
    <fieldset disabled={working}>
      <legend>{t("Dirlume LAN group")}</legend>
      {groupActive ? <>
        <p role="status">{t("Your drives are shared with this group while Dirlume is running.")}</p>
        <label className="field-checkbox">
          <input type="checkbox" checked={groupWritable} onChange={(event) => {
            const writable = event.target.checked;
            void runGroup(async () => { await api.setLanGroupWritable(writable); setGroupWritable(writable); });
          }} />
          {t("Allow group members to change files and folders")}
        </label>
        <div className="dialog-actions">
          <Button type="button" onClick={() => void runGroup(async () => {
            await api.copyLanGroupCode();
            setGroupCopied(true);
          })}>{t("Copy group code")}</Button>
          <Button type="button" onClick={() => void runGroup(async () => {
            await api.leaveLanGroup();
            setGroupActive(false);
            setGroupPeers([]);
          })}>{t("Leave group")}</Button>
        </div>
        {groupCopied && <p role="status">{t("Group code copied. Paste the same code on each computer.")}</p>}
        {groupPeers.length ? <ul className="computer-settings-list" aria-label={t("Group members")}>
          {groupPeers.map((peer) => <li key={peer.id}><span>{peer.name}</span>
            {!peer.online && <span>{t("Offline")}</span>}</li>)}
        </ul> : <p role="status">{t("Waiting for group members…")}</p>}
      </> : <>
        <p>{t("Create a group on one computer and join it with the same code on the others. Members can browse and download from each other's drives.")}</p>
        <div className="dialog-actions">
          <Button type="button" onClick={() => startGroup()}>{t("Create group")}</Button>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); if (groupCode.trim()) startGroup(groupCode.trim()); }}>
          <label className="field">{t("Group code")}
            <input type="password" autoComplete="off" spellCheck={false} value={groupCode}
              onChange={(event) => setGroupCode(event.target.value)} required />
          </label>
          <Button type="submit" disabled={!groupCode.trim()}>{t("Join group")}</Button>
        </form>
      </>}
      {groupError && <p role="alert" className="dialog-error">{errorText(groupError)}</p>}
    </fieldset>
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
    <details open={Boolean(activeSharing)}>
    <summary>{t("Legacy pairing codes")}</summary>
    <fieldset disabled={working}>
      <legend>{t("Direct connection")}</legend>
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
    </details>
    {removing && <RemoveConnectionDialog profile={removing} onRemoved={() => {
      setComputers(readRemoteProfiles());
      setRemoving(null);
    }} onClose={() => setRemoving(null)} />}
  </div>;
}
