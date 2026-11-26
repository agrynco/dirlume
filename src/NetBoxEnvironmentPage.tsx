import { useState, type ReactNode } from "react";
import type { EnvironmentPreferences, RemoteRecyclePreferences } from "./api";
import { t } from "./i18n";

export const defaultEnvironmentPreferences: EnvironmentPreferences = {
  lineEnding: "lf", listingTime: "asReported", serverOffsetMinutes: 0,
  daylightSaving: "atTimestamp", preserveDownloadTimestamps: true,
};

export function NetBoxEnvironmentPage({ value, onChange, ftpEncoding }: {
  value: EnvironmentPreferences;
  onChange: (value: EnvironmentPreferences) => void;
  ftpEncoding?: ReactNode;
}) {
  const [offset, setOffset] = useState(String(value.serverOffsetMinutes));
  const recycleBin = value.recycleBin ?? { folder: "", keepDeleted: false, keepOverwritten: false };
  function change(update: Partial<EnvironmentPreferences>) {
    onChange({ ...value, ...update });
  }
  function changeRecycle(update: Partial<RemoteRecyclePreferences>) {
    change({ recycleBin: { ...recycleBin, ...update } });
  }

  return <>
    {ftpEncoding}
    <label className="field">{t("Line endings for files without line breaks")}
      <select value={value.lineEnding} onChange={(event) => change({ lineEnding: event.target.value === "crlf" ? "crlf" : "lf" })}>
        <option value="lf">{t("LF (Unix)")}</option>
        <option value="crlf">{t("CRLF (Windows)")}</option>
      </select>
    </label>
    {ftpEncoding && <>
      <label className="field">{t("FTP LIST timestamp interpretation")}
        <select value={value.listingTime} onChange={(event) => {
          const mode = event.target.value;
          change({ listingTime: mode === "fixedOffset" || mode === "localZone" ? mode : "asReported" });
        }}>
          <option value="asReported">{t("Treat LIST times as UTC")}</option>
          <option value="fixedOffset">{t("Use a fixed server offset from UTC")}</option>
          <option value="localZone">{t("Interpret times in this computer’s time zone")}</option>
        </select>
      </label>
      {value.listingTime === "fixedOffset" && <label className="field">{t("Server offset from UTC (minutes)")}
        <input type="number" min={-1439} max={1439} required value={offset} onChange={(event) => {
          setOffset(event.target.value);
          if (Number.isInteger(event.target.valueAsNumber)) change({ serverOffsetMinutes: event.target.valueAsNumber });
        }} />
      </label>}
      {value.listingTime === "localZone" && <label className="field">{t("Daylight saving time")}
        <select value={value.daylightSaving} onChange={(event) => change({
          daylightSaving: event.target.value === "currentOffset" ? "currentOffset" : "atTimestamp",
        })}>
          <option value="atTimestamp">{t("Use the offset on the file’s date")}</option>
          <option value="currentOffset">{t("Use the current local offset for all dates")}</option>
        </select>
      </label>}
      <p className="search-hint">{t("These time settings apply to legacy FTP LIST timestamps. UTC timestamps are used as received.")}</p>
    </>}
    <label className="field-checkbox">
      <span>{t("Preserve modification times on downloads")}</span>
      <input type="checkbox" checked={value.preserveDownloadTimestamps}
        onChange={(event) => change({ preserveDownloadTimestamps: event.target.checked })} />
    </label>
    <fieldset className="view-font-group">
      <legend>{t("Remote recycle bin")}</legend>
      <label className="field">{t("Recycle-bin folder")}
        <input type="text" placeholder="/recycle" value={recycleBin.folder}
          required={recycleBin.keepDeleted || (!ftpEncoding && recycleBin.keepOverwritten)}
          onChange={({ target }) => changeRecycle({ folder: target.value })} />
      </label>
      <label className="field-checkbox">
        <span>{t("Move deleted items to the remote recycle bin")}</span>
        <input type="checkbox" checked={recycleBin.keepDeleted}
          onChange={({ target }) => changeRecycle({ keepDeleted: target.checked })} />
      </label>
      {!ftpEncoding && <label className="field-checkbox">
        <span>{t("Keep previous versions of overwritten SFTP files")}</span>
        <input type="checkbox" checked={recycleBin.keepOverwritten}
          onChange={({ target }) => changeRecycle({ keepOverwritten: target.checked })} />
      </label>}
    </fieldset>
  </>;
}
