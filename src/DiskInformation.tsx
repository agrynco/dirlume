import { useEffect, useState } from "react";
import { FolderTree, HardDrive } from "lucide-react";
import { api, describeError, type GoogleDrivePlace, type GoogleDriveQuota, type VolumeInformation } from "./api";
import { Button } from "./Button";
import { errorText, locale, t } from "./i18n";
import { formatSize, localPath, type Side } from "./panes";
import type { SpacePlace } from "./spaceScan";

export type DiskInformationTarget = GoogleDrivePlace | { kind: "local"; path: string };

export function DiskInformation({ side, target, active, onClose, onFocus, onScan }: {
  side: Side;
  target: DiskInformationTarget;
  active: boolean;
  onClose: () => void;
  onFocus: () => void;
  onScan: (root: SpacePlace) => void;
}) {
  const [information, setInformation] = useState<VolumeInformation | null>(null);
  const [quota, setQuota] = useState<GoogleDriveQuota | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    const result = target.kind === "googleDrive"
      ? api.googleDriveQuota(target.id).then((next) => { if (current) setQuota(next); })
      : api.volumeInformation(target.path).then((next) => { if (current) setInformation(next); });
    void result.catch((failure: unknown) => {
      if (current) setError(describeError(failure));
    });
    return () => { current = false; };
  }, [target]);

  const capacity = information?.capacity;
  const available = capacity && capacity.total > 0 ? Math.min(1, capacity.available / capacity.total) : null;
  const free = available === null ? "" : new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 1 }).format(available);
  const driveFree = quota?.limit != null && quota.usage != null ? Math.max(0, quota.limit - quota.usage) : null;
  const quotaRows = [
    ["Reported limit", quota?.limit],
    ["Total used across Google services", quota?.usage],
    ["Used in Google Drive", quota?.usageInDrive],
    ["Used in Drive Trash", quota?.usageInDriveTrash],
    ...(driveFree === null ? [] : [["Available Google storage", driveFree] as const]),
  ] as const;

  return <section id={`${side}-disk-information`} tabIndex={-1} aria-label={t("Disk information")}
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
    {target.kind === "googleDrive" ? <div className="disk-content">
      <div className="disk-identity">
        <strong>{t("Google storage")}</strong>
        <span>{target.email ?? target.address}</span>
      </div>
      {!quota && !error ? <p role="status">{t("Reading Google storage…")}</p> : <dl className="disk-capacity">
        {quotaRows.map(([label, size]) => <div key={label}><dt>{t(label)}</dt><dd>{size == null ? t("Unavailable") : formatSize(size)}</dd></div>)}
      </dl>}
      {error && <p className="space-error" role="alert">{t("Could not read Google storage.")} {errorText(error)}</p>}
      {driveFree !== null && quota?.limit != null && quota.limit > 0 &&
        <meter min={0} max={quota.limit} value={driveFree} aria-label={t("Available Google storage")} />}
      <p>{t("Google Workspace may report the storage limit and total usage for the whole organization.")}</p>
      <div className="disk-scan-action">
        <Button className="primary" onClick={() => onScan({ ...target, folders: [] })}>
          <FolderTree aria-hidden="true" />{t("Scan My Drive")}
        </Button>
      </div>
    </div> : information ? <div className="disk-content">
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
        <Button className="primary" onClick={() => onScan(localPath(information.path))}>
          <FolderTree aria-hidden="true" />{t(information.share ? "Scan share" : "Scan volume")}
        </Button>
      </div>
    </div> : error ? <p className="space-error" role="alert">{t("Could not read disk information.")} {errorText(error)}</p> :
      <p className="pane-empty" role="status">{t("Reading disk information…")}</p>}
  </section>;
}
