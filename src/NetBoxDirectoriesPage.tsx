import type { DirectoryPreferences } from "./api";
import { t } from "./i18n";

export function NetBoxDirectoriesPage({ value, onChange, symbolicLinks }: {
  value: DirectoryPreferences;
  onChange: (value: DirectoryPreferences) => void;
  symbolicLinks: boolean;
}) {
  function change(update: Partial<DirectoryPreferences>) {
    const next = { ...value, ...update };
    if (!next.cacheListings && !next.cacheChanges) next.persistentCache = false;
    onChange(next);
  }

  return <>
    <label className="field">{t("Starting folder")}
      <input value={value.startingFolder} pattern="/.*" placeholder={t("Server default")}
        onChange={(event) => change({ startingFolder: event.target.value })} />
    </label>
    <label className="field-checkbox">
      <span>{t("Remember last used directory")}</span>
      <input type="checkbox" checked={value.rememberLast} onChange={(event) => change({ rememberLast: event.target.checked })} />
    </label>
    <label className="field-checkbox">
      <span>{t("Cache visited directory listings")}</span>
      <input type="checkbox" checked={value.cacheListings} onChange={(event) => change({ cacheListings: event.target.checked })} />
    </label>
    <label className="field-checkbox">
      <span>{t("Cache directory changes")}</span>
      <input type="checkbox" checked={value.cacheChanges} onChange={(event) => change({ cacheChanges: event.target.checked })} />
    </label>
    <label className="field-checkbox">
      <span>{t("Keep directory cache after closing Dirlume")}</span>
      <input type="checkbox" checked={value.persistentCache} disabled={!value.cacheListings && !value.cacheChanges}
        onChange={(event) => change({ persistentCache: event.target.checked })} />
    </label>
    <label className="field-checkbox">
      <span>{t("Resolve directory symbolic links")}</span>
      <input type="checkbox" checked={symbolicLinks && value.resolveLinks} disabled={!symbolicLinks}
        onChange={(event) => change({ resolveLinks: event.target.checked })} />
    </label>
    {!symbolicLinks && <p className="search-hint">{t("Directory symbolic link resolution is available for SFTP.")}</p>}
  </>;
}
