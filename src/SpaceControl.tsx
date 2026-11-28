import { useEffect, useRef, useState } from "react";
import { ChevronDown, HardDrive } from "lucide-react";
import { Button } from "./Button";
import { helpIsOpen } from "./contextHelp";
import { t } from "./i18n";
import { formatSize } from "./panes";
import { containingScope, spacePath, type Scope, type SpacePlace } from "./spaceScan";
import type { DiskSpace } from "./api";

export function SpaceControl({ place, free, onAnalyze, disabled }: {
  place: SpacePlace;
  free: DiskSpace | null;
  onAnalyze: (place: SpacePlace) => void;
  disabled: boolean;
}) {
  const [scope, setScope] = useState<Scope | null>(null);
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  useEffect(() => {
    let canceled = false;
    setScope(null);
    void containingScope(place).then((next) => {
      if (!canceled) setScope(next);
    }).catch(() => {});
    return () => { canceled = true; };
  }, [place]);

  const drive = place.kind === "googleDrive";
  const capacity = free ? t(drive ? "Google storage: {0} free of {1}" : "{0} free of {1}", formatSize(free.available), formatSize(free.total)) : "";
  const used = free ? Math.max(0, free.total - free.available) : 0;
  const usedPercent = free && free.total > 0 ? Math.min(100, 100 * used / free.total) : 0;
  const capacityDetail = free ? drive ? capacity : t("{0} free of {1}, {2} used", formatSize(free.available), formatSize(free.total), formatSize(used)) : undefined;
  return <div className="space-control" data-help-topic="spaceScope">
    <Button className="space-control-main" aria-label={t("Analyze space")} aria-description={capacityDetail}
      tooltip={capacityDetail ?? t("Open Space Analyzer to scan the current folder.")} data-tooltip-on-focus={free ? "true" : undefined}
      onClick={() => onAnalyze(place)} disabled={disabled}>
      <HardDrive className="space-control-icon" aria-hidden="true" />
      {free ? <>
        <span className="pane-free-full">{capacity}</span>
        <span className="pane-free-short">{t(drive ? "Google storage: {0} free" : "{0} free", formatSize(free.available))}</span>
        {free.total > 0 && <span className="space-meter" aria-hidden="true"><span style={{ width: usedPercent + "%" }} /></span>}
      </> : <span className="space-control-label">{t("Analyze space")}</span>}
    </Button>
    {scope && !disabled && <details ref={details} onBlur={(event) => {
      if (!helpIsOpen() && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
    }} onKeyDown={(event) => {
      if (event.key !== "Escape" || !event.currentTarget.open) return;
      event.stopPropagation();
      event.currentTarget.open = false;
      summary.current?.focus();
    }}>
      <summary ref={summary} aria-label={t("Analysis scope")}><ChevronDown aria-hidden="true" /></summary>
      <div className="space-scope">
        <Button onClick={() => {
          if (details.current) details.current.open = false;
          onAnalyze(scope.place);
        }}>
          <span>{t(scope.kind === "googleDrive" ? "Analyze My Drive" : scope.kind === "volume" ? "Analyze volume" : scope.kind === "share" ? "Analyze share" : "Analyze connection root")}</span>
          <small>{spacePath(scope.place)}</small>
        </Button>
      </div>
    </details>}
  </div>;
}
