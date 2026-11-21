import { useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";
import { Activity, ChevronDown, Folder, HardDrive, Server } from "lucide-react";
import { windowsClient, type ConnectionSource, type QuickLocation } from "./api";
import { Button } from "./Button";
import { t } from "./i18n";
import type { Side } from "./panes";
import { bindingMatches, driveSourceCommand, eventShortcut, showShortcut, type Bindings } from "./preferences";

export type PaneSource = QuickLocation | ConnectionSource | "processes";

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
  const dismiss = useEffectEvent(() => onClose(false));
  useLayoutEffect(() => {
    if (open) popup.current?.querySelector("button")?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !box.current?.contains(event.target)) dismiss();
    }
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  const sources = [
    { label: t("Processes"), bindings: shortcuts.processSources, Icon: Activity, value: "processes" },
    { label: "FTP", bindings: shortcuts.ftpSources, Icon: Server, value: "ftp" },
    { label: "SSH", bindings: shortcuts.sshSources, Icon: Server, value: "ssh" },
    ...(windowsClient ? [{ label: "SMB", bindings: shortcuts.smbSources, Icon: Server, value: "smb" as const }] : []),
    { label: t("Remote machine"), bindings: shortcuts.remoteSources, Icon: Server, value: "remote" },
  ] as const;
  const folders = locations.map((location) => {
    const command = driveSourceCommand(location);
    return { label: t(location.label), bindings: command ? shortcuts[command] : [], Icon: Folder, value: location };
  });
  function sourceButton({ label, bindings, Icon, value }: (typeof sources)[number] | (typeof folders)[number]) {
    const path = typeof value === "object" ? value.path : undefined;
    return <Button key={path ?? label} tooltip={path} shortcut={showShortcut(bindings[0])} onClick={() => onPick(value)}>
      <Icon /> <span>{label}</span>{bindings.length > 0 && <kbd aria-hidden="true">{showShortcut(bindings[0])}</kbd>}
    </Button>;
  }

  return <div className="location-menu" data-overlay={overlay ? side : undefined} ref={box}>
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
      {folders.map(sourceButton)}
      <div className="location-source-group" role="group" aria-label={t("Sources")}>{sources.map(sourceButton)}</div>
    </div>}
  </div>;
}
