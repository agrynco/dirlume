import { useId, useState } from "react";
import { builtInThemes } from "./appearance";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { t } from "./i18n";
import { panelModeName } from "./panelModes";
import { builtInProfileNames, commandLabel, panelLayouts, showShortcuts, type Preferences, type SettingsProfile } from "./preferences";
import {
  applySettingsProfile, availableProfileValues, builtInProfiles, changedProfileShortcuts, profileValues, sameProfileValues,
} from "./settingsProfiles";

type NameDialog = {
  kind: "name";
  action: "save" | "duplicate" | "rename";
  name: string;
  profile?: SettingsProfile;
  switchTo?: SettingsProfile;
};

type ProfileDialog = NameDialog | { kind: "switch" | "delete"; profile: SettingsProfile };

export function ProfileSettings({ preferences, saved, onChange }: {
  preferences: Preferences;
  saved: Preferences;
  onChange: (preferences: Preferences) => void;
}) {
  const [dialog, setDialog] = useState<ProfileDialog | null>(null);
  const form = useId();
  const profiles = [...builtInProfiles, ...preferences.settingsProfiles];
  const current = profiles.find(({ id }) => id === preferences.activeSettingsProfile);
  const custom = current && !Object.hasOwn(builtInProfileNames, current.id) ? current : undefined;
  const values = profileValues(preferences);
  const savedValues = profileValues(saved);
  const modified = current && !sameProfileValues(values, availableProfileValues(preferences, current.values));
  const pending = preferences.activeSettingsProfile !== saved.activeSettingsProfile || !sameProfileValues(values, savedValues);
  const changedShortcuts = changedProfileShortcuts(savedValues.bindings, values.bindings);
  const scheme = preferences.schemes.find(({ id }) => id === values.colorSchemeId);
  const color = scheme?.name ?? t(builtInThemes[values.theme]);
  const missingScheme = current?.values.colorSchemeId && !preferences.schemes.some(({ id }) => id === current.values.colorSchemeId);
  const close = () => setDialog(null);

  function switchProfile(profile: SettingsProfile) {
    const original = current ?? builtInProfiles[0];
    if (!sameProfileValues(values, availableProfileValues(preferences, original.values))) {
      setDialog({ kind: "switch", profile });
    } else onChange(applySettingsProfile(preferences, profile));
  }

  const name = dialog?.kind === "name" ? dialog.name.trim() : "";
  const duplicateName = dialog?.kind === "name" && profiles.some((profile) =>
    (dialog.action !== "rename" || profile.id !== dialog.profile?.id) &&
    profile.name.normalize("NFC").toLowerCase() === name.normalize("NFC").toLowerCase());

  function saveName() {
    if (dialog?.kind !== "name" || !name || duplicateName) return;
    if (dialog.action === "rename" && dialog.profile) {
      onChange({ ...preferences, settingsProfiles: preferences.settingsProfiles.map((profile) =>
        profile.id === dialog.profile?.id ? { ...profile, name } : profile) });
    } else {
      let n = 1;
      while (profiles.some(({ id }) => id === `profile-${n}`)) n++;
      const profile = {
        id: `profile-${n}`, name, values: dialog.action === "duplicate" && dialog.profile ? dialog.profile.values : values,
      };
      const updated = { ...preferences, settingsProfiles: [...preferences.settingsProfiles, profile] };
      onChange(dialog.action === "duplicate" ? updated : applySettingsProfile(updated, dialog.switchTo ?? profile));
    }
    close();
  }

  return <div className="dialog-body settings-general">
    <label className="field">
      {t("Current profile")}
      <select value={current?.id ?? ""} onChange={(event) => {
        const profile = profiles.find(({ id }) => id === event.target.value);
        if (profile) switchProfile(profile);
      }}>
        {!current && <option value="" disabled>{t("No profile")}</option>}
        {profiles.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
      </select>
    </label>
    {(modified || pending) && <div className="profile-status" role="status">
      {modified && <span>{t("Modified")}</span>}
      {pending && <span>{t("Apply or choose Done to use these settings.")}</span>}
    </div>}
    {current && missingScheme && <p role="status">{t("The saved color scheme is missing. The profile uses {0}.", t(builtInThemes[current.values.theme]))}</p>}
    <dl className="profile-summary">
      <dt>{t("Color scheme")}</dt><dd>{color}</dd>
      <dt>{t("Panel layout")}</dt><dd>{t(panelLayouts[values.layout])}</dd>
      <dt>{t("Left pane mode")}</dt><dd>{panelModeName(values.selectedPanelModes.left, preferences.panelModes)}</dd>
      <dt>{t("Right pane mode")}</dt><dd>{panelModeName(values.selectedPanelModes.right, preferences.panelModes)}</dd>
      <dt>{t("Right-click selection")}</dt><dd>{t(values.rightClickSelection ? "Enabled" : "Disabled")}</dd>
    </dl>
    {changedShortcuts.length > 0 && <fieldset className="profile-shortcuts">
      <legend>{t("Changed shortcuts")}</legend>
      <dl className="profile-summary">
        {changedShortcuts.map((command) => <div key={command}>
          <dt>{commandLabel(command)}</dt>
          <dd>{showShortcuts(savedValues.bindings[command]) || t("Unassigned")} → {showShortcuts(values.bindings[command]) || t("Unassigned")}</dd>
        </div>)}
      </dl>
    </fieldset>}
    <div className="dialog-actions">
      <Button type="button" onClick={() => setDialog({ kind: "name", action: "save", name: "" })}>{t("Save current setup as profile")}</Button>
      {current && <Button type="button" onClick={() =>
        setDialog({ kind: "name", action: "duplicate", name: t("Copy of {0}", current.name), profile: current })}>{t("Duplicate profile")}</Button>}
      {modified && current && <Button type="button" onClick={() => switchProfile(current)}>{t("Reapply profile")}</Button>}
    </div>
    {custom && <div className="dialog-actions">
      <Button type="button" onClick={() =>
        setDialog({ kind: "name", action: "rename", name: custom.name, profile: custom })}>{t("Rename profile")}</Button>
      <Button type="button" disabled={!modified} onClick={() => onChange({ ...preferences, settingsProfiles:
        preferences.settingsProfiles.map((profile) => profile.id === custom.id ? { ...profile, values } : profile),
      })}>{t("Update profile")}</Button>
      <Button type="button" onClick={() => setDialog({ kind: "delete", profile: custom })}>{t("Delete profile")}</Button>
    </div>}

    {dialog?.kind === "switch" && <Dialog title={t("Switch profile")} onClose={close} footer={<>
      <Button type="button" data-initial-focus onClick={close}>{t("Cancel")}</Button>
      <Button type="button" onClick={() => { onChange(applySettingsProfile(preferences, dialog.profile)); close(); }}>{t("Discard and switch")}</Button>
      <Button type="button" className="primary" onClick={() =>
        setDialog({ kind: "name", action: "save", name: "", switchTo: dialog.profile })}>{t("Save as profile and switch")}</Button>
    </>}>
      <div className="dialog-body"><p>{t("Switching to {0} replaces the current profile settings. Save the current setup first to use it again.", dialog.profile.name)}</p></div>
    </Dialog>}
    {dialog?.kind === "delete" && <Dialog title={t("Delete profile")} onClose={close} footer={<>
      <Button type="button" data-initial-focus onClick={close}>{t("Cancel")}</Button>
      <Button type="button" className="negative" onClick={() => {
        onChange({ ...preferences, activeSettingsProfile: null, settingsProfiles: preferences.settingsProfiles.filter(({ id }) => id !== dialog.profile.id) });
        close();
      }}>{t("Delete profile")}</Button>
    </>}>
      <div className="dialog-body"><p>{t("Delete {0}? The current setup stays in place.", dialog.profile.name)}</p></div>
    </Dialog>}
    {dialog?.kind === "name" && <Dialog title={t(dialog.action === "rename" ? "Rename profile" :
      dialog.action === "duplicate" ? "Duplicate profile" : "Save current setup as profile")} onClose={close} footer={<>
      <Button type="button" onClick={close}>{t("Cancel")}</Button>
      <Button type="submit" className="primary" form={form} disabled={!name || duplicateName}>{t("Save profile")}</Button>
    </>}>
      <form id={form} className="dialog-body" onSubmit={(event) => { event.preventDefault(); saveName(); }}>
        <label className="field">
          {t("Profile name")}
          <input data-initial-focus required maxLength={64} value={dialog.name} aria-invalid={duplicateName || undefined}
            onChange={(event) => setDialog({ ...dialog, name: event.target.value })} />
        </label>
        {duplicateName && <p role="alert" className="dialog-error">{t("A profile with this name already exists.")}</p>}
      </form>
    </Dialog>}
  </div>;
}
