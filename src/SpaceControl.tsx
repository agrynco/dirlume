import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "./Button";
import { t } from "./i18n";
import { formatSize } from "./panes";
import { containingScope, spacePath, type Scope, type SpacePlace } from "./spaceScan";
import type { DiskSpace } from "./api";

export function SpaceControl({ place, free, onAnalyze }: {
  place: SpacePlace;
  free: DiskSpace | null;
  onAnalyze: (place: SpacePlace) => void;
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

  const capacity = free ? t("{0} free of {1}", formatSize(free.available), formatSize(free.total)) : "";
  const used = free && free.total > 0 ? Math.max(0, Math.min(100, 100 * (1 - free.available / free.total))) : 0;
  return <div className="space-control">
    <Button className="space-control-main" aria-label={t("Analyze space")} tooltip={capacity || t("Analyze space")}
      onClick={() => onAnalyze(place)}>
      {free ? <>
        <span className="pane-free-full">{capacity}</span>
        <span className="pane-free-short">{t("{0} free", formatSize(free.available))}</span>
        <span className="space-meter" aria-hidden="true"><span style={{ width: used + "%" }} /></span>
      </> : t("Analyze space")}
    </Button>
    {scope && <details ref={details} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
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
          <span>{t(scope.kind === "volume" ? "Analyze volume" : scope.kind === "share" ? "Analyze share" : "Analyze connection root")}</span>
          <small>{spacePath(scope.place)}</small>
        </Button>
      </div>
    </details>}
  </div>;
}
