import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { Activity, ChevronDown, Clock3, Folder, HardDrive, Server } from "lucide-react";
import { api, describeError, windowsClient, type ComputerDrive, type ConnectionSource, type QuickLocation } from "./api";
import { Button } from "./Button";
import { helpIsOpen } from "./contextHelp";
import { errorText, t } from "./i18n";
import { formatSize, type Side } from "./panes";
import { bindingMatches, driveSourceCommand, eventShortcut, showShortcut, type Bindings } from "./preferences";
import { readRemoteProfiles } from "./savedConnections";

type LanHost = { kind: "dirlume"; id: string; name: string; credential: string } |
  { kind: "kswitcher"; id: string; name: string; online?: boolean };
type RemoteDrive = { host: LanHost; drive: string };
type LanComputer = { host: LanHost; drives?: ComputerDrive[]; error?: string };
export type PaneSource = QuickLocation | RemoteDrive | ConnectionSource | "processes" | "recent";
const driveTypes = ["", "", "Removable", "Fixed", "Network", "Optical", "RAM disk"];

export function PaneSources({ side, overlay, open, locations, shortcuts, onToggle, onClose, onPick }: {
  side: Side;
  overlay?: boolean;
  open: boolean;
  locations: readonly QuickLocation[];
  shortcuts: Bindings;
  onToggle: () => void;
  onClose: (restoreFocus: boolean) => void;
  onPick: (source: PaneSource) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [computers, setComputers] = useState<LanComputer[]>([]);
  const [kswitcherError, setKSwitcherError] = useState("");
  const dismiss = useEffectEvent(() => onClose(false));
  useLayoutEffect(() => {
    if (open) popup.current?.querySelector("button")?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    const hosts = readRemoteProfiles().flatMap((profile): LanHost[] => profile.kind === "server" && profile.lan === true ?
      [{ kind: "dirlume", id: profile.id, name: profile.label, credential: profile.credential }] : []);
    setComputers(hosts.map((host) => ({ host })));
    setKSwitcherError("");
    async function load(host: LanHost) {
      let update: Pick<LanComputer, "drives" | "error">;
      try {
        const drives = host.kind === "dirlume" ? await api.listSavedComputerDrives(host.credential) :
          (await api.listKSwitcher("", host.id, "")).drives ?? [];
        update = { drives };
      } catch (error) {
        update = { error: describeError(error) };
      }
      if (current) setComputers((computers) => computers.map((item) => item.host === host ? { host, ...update } : item));
    }
    for (const host of hosts) void load(host);
    if (windowsClient) void api.kswitcherPeers("").then(async (peers) => {
      if (!current) return;
      const paired = (peers ?? []).map((peer): LanHost => ({ kind: "kswitcher", ...peer }));
      setComputers((computers) => [...computers, ...paired.map((host) => ({ host }))]);
      for (const host of paired) {
        if (!current) break;
        if (host.kind === "kswitcher" && host.online !== false) await load(host);
      }
    }, (error: unknown) => {
      if (current) setKSwitcherError(describeError(error));
    });
    return () => { current = false; };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    function closeOutside(event: PointerEvent) {
      if (!helpIsOpen() && event.target instanceof Node && !box.current?.contains(event.target)) dismiss();
    }
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  const sources = [
    { label: t("Processes"), bindings: shortcuts.processSources, Icon: Activity, value: "processes" },
    { label: "NetBox", bindings: shortcuts.netboxSources, Icon: Server, value: "netbox" },
    { label: "SMB", bindings: shortcuts.smbSources, Icon: Server, value: "smb" as const },
    { label: t("Remote machine"), bindings: shortcuts.remoteSources, Icon: Server, value: "remote" },
  ] as const;
  const folders = locations.map((location) => {
    const command = driveSourceCommand(location);
    return { label: t(location.label), bindings: command ? shortcuts[command] : [], Icon: Folder, value: location };
  });
  const recent = { label: t("Recent"), bindings: [], Icon: Clock3, value: "recent" } as const;
  const downloads = locations.findIndex(({ label }) => label === "Downloads");
  const firstDrive = folders.findIndex(({ value }) => driveSourceCommand(value));
  const recentIndex = downloads >= 0 ? downloads + 1 : firstDrive >= 0 ? firstDrive : folders.length;
  const folderSources = [...folders.slice(0, recentIndex), recent, ...folders.slice(recentIndex)];
  const kswitcherStatus = kswitcherError === "Authorize this executable in KSwitcher → Computers → Trusted clients."
    ? t("To browse KSwitcher computers, add Dirlume.exe under KSwitcher → Computers → Trusted clients.")
    : errorText(kswitcherError);
  function sourceButton({ label, bindings, Icon, value }: (typeof sources)[number] | (typeof folderSources)[number]) {
    const path = typeof value === "object" ? value.path : undefined;
    return <Button key={path ?? label} tooltip={path} shortcut={showShortcut(bindings[0])} onClick={() => onPick(value)}>
      <Icon /> <span>{label}</span>{bindings.length > 0 && <kbd aria-hidden="true">{showShortcut(bindings[0])}</kbd>}
    </Button>;
  }

  return <div className="location-menu" data-overlay={overlay ? side : undefined} data-help-side={side} data-help-topic="paneSources" ref={box}>
    {!overlay && <Button className="icon-button location-trigger"
      aria-label={t(side === "left" ? "Locations for left pane" : "Locations for right pane")}
      aria-expanded={open} onClick={onToggle}><HardDrive /><ChevronDown /></Button>}
    {open && <div className="location-popup" ref={popup} role="group"
      aria-label={t(side === "left" ? "Left pane sources" : "Right pane sources")} onKeyDown={(event) => {
      if (event.defaultPrevented || event.nativeEvent.isComposing) return;
      const shortcut = eventShortcut(event);
      const item = shortcut && [...folders, ...sources].find(({ bindings }) => bindingMatches(bindings, shortcut));
      if (item) {
        event.preventDefault();
        event.stopPropagation();
        onPick(item.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const direction = event.key === "ArrowUp" ? -1 : 1;
        const next = current < 0 ? (direction > 0 ? 0 : buttons.length - 1) : (current + direction + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }}>
      <div className="lan-sources" role="group" aria-label={t("This computer")}>
        <strong>{t("This computer")}</strong>
        {folderSources.map(sourceButton)}
      </div>
      <div className="location-source-group" role="group" aria-label={t("Sources")}>{sources.map(sourceButton)}</div>
      {(["dirlume", "kswitcher"] as const).map((kind) => {
        const hosts = computers.filter(({ host }) => host.kind === kind);
        const status = kind === "kswitcher" && kswitcherStatus;
        if (!hosts.length && !status) return null;
        const heading = t(kind === "dirlume" ? "Dirlume LAN" : "KSwitcher LAN");
        return <div key={kind} className="location-source-group lan-sources" role="group" aria-label={heading}>
          <strong>{heading}</strong>
          {status && <p role="status">{status}</p>}
          {hosts.map(({ host, drives, error }) =>
            <div key={host.kind + host.id} role="group" aria-label={host.name}>
              <span>{host.name}</span>
              {host.kind === "kswitcher" && host.online === false ? <p>{t("Offline")}</p> :
                error ? <p role="status">{errorText(error)}</p> :
                !drives ? <p role="status">{t("Loading drives…")}</p> :
                drives.length === 0 ? <p>{t("No drives.")}</p> : drives.map(({ name, type, total, available }) =>
                  <Button key={name} type="button" onClick={() => onPick({ host, drive: name })}>
                    <HardDrive /> <span>{name}</span>
                    {type != null && driveTypes[type] && <small>{t(driveTypes[type])}</small>}
                    {total !== null && total > 0 && available !== null && <small>{t("{0} free of {1}", formatSize(available), formatSize(total))}</small>}
                  </Button>)}
            </div>)}
        </div>;
      })}
    </div>}
  </div>;
}
