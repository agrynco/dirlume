import { useState } from "react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { api, describeError } from "./api";
import { errorText, t } from "./i18n";
import { preferenceGroups, type Preferences } from "./preferences";
import {
  exportSettings, prepareSettingsImport, settingsGroupIds,
  type SettingsArchive, type SettingsSelection,
} from "./settingsArchive";

export type SettingsArchiveAction = { kind: "export" } | { kind: "import"; archive: SettingsArchive };
type Replacements = ReturnType<typeof prepareSettingsImport>["replacements"];

function toggle<T>(values: T[], value: T) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function SettingsArchiveDialog({ action, preferences, onImport, onClose }: {
  action: SettingsArchiveAction;
  preferences: Preferences;
  onImport: (patch: Partial<Preferences>) => Promise<void>;
  onClose: () => void;
}) {
  const archive = action.kind === "import" ? action.archive : undefined;
  const title = t(archive ? "Import settings" : "Export settings");
  const groups = archive ? settingsGroupIds.filter((id) => Object.hasOwn(archive.groups, id)) : settingsGroupIds;
  const schemes = archive?.schemes ?? preferences.schemes;
  const [selection, setSelection] = useState<SettingsSelection>(() => ({ groups, schemes: schemes.map(({ id }) => id) }));
  const [confirmation, setConfirmation] = useState<Replacements | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function applyImport(source: SettingsArchive, confirmed = false) {
    try {
      const { patch, replacements } = prepareSettingsImport(preferences, source, selection);
      if (replacements.length && (!confirmed || JSON.stringify(confirmation) !== JSON.stringify(replacements))) {
        setConfirmation(replacements);
        return;
      }
      setSaving(true);
      await onImport(patch);
      onClose();
    } catch (error) {
      setConfirmation(null);
      setError(errorText(describeError(error)));
    } finally {
      setSaving(false);
    }
  }

  async function submit() {
    setError("");
    if (archive) { await applyImport(archive); return; }
    setSaving(true);
    try {
      if (await api.writeSettingsArchive(title, exportSettings(preferences, selection))) onClose();
    } catch (error) {
      setError(errorText(describeError(error)));
    } finally {
      setSaving(false);
    }
  }

  return <>
    <Dialog title={title} onClose={() => { if (!saving) onClose(); }} footer={<>
      <Button type="button" disabled={saving} onClick={onClose}>{t("Cancel")}</Button>
      <Button type="button" className="primary" disabled={saving || !selection.groups.length && !selection.schemes.length}
        onClick={() => void submit()}>{t(archive ? "Import" : "Export")}</Button>
    </>}>
      <div className="dialog-body">
        {groups.length > 0 && <fieldset className="settings-archive-items">
          <legend>{t("Settings groups")}</legend>
          {groups.map((group, index) => <label className="field-checkbox" key={group}>
            <input type="checkbox" data-initial-focus={index === 0 || undefined} disabled={saving} checked={selection.groups.includes(group)}
              onChange={() => setSelection((current) => ({ ...current, groups: toggle(current.groups, group) }))} />
            <span>{t(preferenceGroups[group])}</span>
          </label>)}
        </fieldset>}
        {schemes.length > 0 && <fieldset className="settings-archive-items">
          <legend>{t("Color schemes")}</legend>
          {schemes.map(({ id, name }, index) => <label className="field-checkbox" key={id}>
            <input type="checkbox" data-initial-focus={!groups.length && index === 0 || undefined} disabled={saving} checked={selection.schemes.includes(id)}
              onChange={() => setSelection((current) => ({ ...current, schemes: toggle(current.schemes, id) }))} />
            <span>{name}</span>
          </label>)}
        </fieldset>}
        {error && <p className="dialog-error" role="alert">{error}</p>}
      </div>
    </Dialog>
    {archive && confirmation && <Dialog title={t("Replace color schemes?")} tone="warning" onClose={() => { if (!saving) setConfirmation(null); }} footer={<>
      <Button type="button" data-initial-focus disabled={saving} onClick={() => setConfirmation(null)}>{t("Cancel")}</Button>
      <Button type="button" className="alert-confirm" disabled={saving} onClick={() => void applyImport(archive, true)}>{t("Replace and import")}</Button>
    </>}>
      <div className="dialog-body">
        <p>{t("Importing will replace these local color schemes.")}</p>
        <ul>{confirmation.map(({ id, name }) => <li key={id}>{name}</li>)}</ul>
      </div>
    </Dialog>}
  </>;
}
