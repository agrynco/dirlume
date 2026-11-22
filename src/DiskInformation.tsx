import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FolderTree, HardDrive } from "lucide-react";
import { api, describeError, type VolumeInformation } from "./api";
import { Button } from "./Button";
import { errorText, locale, t } from "./i18n";
import { formatSize, type Side } from "./panes";

export function DiskInformation({ side, path, active, onClose, onFocus, onScan }: {
  side: Side;
  path: string;
  active: boolean;
  onClose: () => void;
  onFocus: () => void;
  onScan: (root: string) => void;
}) {
  const pane = useRef<HTMLElement>(null);
  const [information, setInformation] = useState<VolumeInformation | null>(null);
  const [error, setError] = useState("");
  useLayoutEffect(() => { pane.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    let current = true;
    void api.volumeInformation(path).then((result) => {
      if (current) setInformation(result);
    }, (failure: unknown) => {
      if (current) setError(describeError(failure));
    });
    return () => { current = false; };
  }, [path]);

  const capacity = information?.capacity;
  const available = capacity && capacity.total > 0 ? Math.min(1, capacity.available / capacity.total) : null;
  const free = available === null ? "" : new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 1 }).format(available);

  return <section ref={pane} id={`${side}-disk-information`} tabIndex={-1} aria-label={t("Disk information")}
    className={`pane disk-information disk-information-${side}${active ? " active" : ""}`} data-pane-side={side} data-help-topic="diskInformation"
    onFocusCapture={onFocus} onKeyDown={(event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }}>
    <header className="pane-heading">
      <span className="pane-title"><HardDrive aria-hidden="true" />{t("Disk information")}</span>
      <Button onClick={onClose}>{t("Close")}</Button>
    </header>
    {information ? <div className="disk-content">
      <div className="disk-identity">
        <strong>{information.label || information.path}</strong>
        {information.label && <span>{information.path}</span>}
        {information.filesystem && <small>{information.filesystem}</small>}
      </div>
      <dl className="disk-capacity">
        <div><dt>{t("Total capacity")}</dt><dd>{capacity ? formatSize(capacity.total) : t("Unavailable")}</dd></div>
        <div><dt>{t("Available to you")}</dt><dd>{capacity ? formatSize(capacity.available) : t("Unavailable")}{free && <small>{free}</small>}</dd></div>
      </dl>
      {available !== null && <meter min={0} max={1} value={available} aria-label={t("Available to you")} />}
      <div className="disk-scan-action">
        <Button className="primary" onClick={() => onScan(information.path)}>
          <FolderTree aria-hidden="true" />{t(information.share ? "Scan share" : "Scan volume")}
        </Button>
      </div>
    </div> : error ? <p className="space-error" role="alert">{t("Could not read disk information.")} {errorText(error)}</p> :
      <p className="pane-empty" role="status">{t("Reading disk information…")}</p>}
  </section>;
}
