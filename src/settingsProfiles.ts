import {
  assignShortcut, builtInProfileNames, commandNames, normalizePreferences, shortcutBindings,
  type Bindings, type Preferences, type ProfileValues, type SettingsProfile,
} from "./preferences";

export function profileValues(preferences: Preferences): ProfileValues {
  const scheme = preferences.schemes.find(({ id }) => id === preferences.activeScheme);
  return {
    theme: scheme?.base ?? preferences.theme,
    colorSchemeId: scheme?.id,
    layout: preferences.layout,
    selectedPanelModes: preferences.selectedPanelModes,
    rightClickSelection: preferences.rightClickSelection,
    bindings: shortcutBindings(preferences),
  };
}

const defaults = profileValues(normalizePreferences(null));

export const builtInProfiles: readonly SettingsProfile[] = [
  { id: "dirlume", name: builtInProfileNames.dirlume, values: defaults },
  { id: "far", name: builtInProfileNames.far, values: {
    ...defaults, theme: "classic-blue", layout: "classic", selectedPanelModes: { left: "brief", right: "brief" },
    rightClickSelection: true, bindings: assignShortcut(defaults.bindings, "parent", "Ctrl+PageUp"),
  } },
  { id: "total", name: builtInProfileNames.total, values: {
    ...defaults, theme: "light", layout: "classic", selectedPanelModes: { left: "full", right: "full" },
    rightClickSelection: false,
    bindings: assignShortcut(assignShortcut(defaults.bindings, "rename", "Shift+F6"), "folderShortcuts", "Ctrl+D"),
  } },
];

export function availableProfileValues(preferences: Preferences, values: ProfileValues): ProfileValues {
  const scheme = preferences.schemes.find(({ id }) => id === values.colorSchemeId);
  return { ...values, theme: scheme?.base ?? values.theme, colorSchemeId: scheme?.id };
}

export function applySettingsProfile(preferences: Preferences, profile: SettingsProfile): Preferences {
  const values = availableProfileValues(preferences, profile.values);
  return {
    ...preferences, activeSettingsProfile: profile.id, theme: values.theme, activeScheme: values.colorSchemeId ?? null,
    layout: values.layout, selectedPanelModes: { ...values.selectedPanelModes },
    rightClickSelection: values.rightClickSelection, profileBindings: values.bindings,
  };
}

export function changedProfileShortcuts(before: Bindings, after: Bindings) {
  return commandNames.filter((command) => before[command].length !== after[command].length ||
    before[command].some((key, index) => key !== after[command][index]));
}

export function sameProfileValues(left: ProfileValues, right: ProfileValues) {
  return left.theme === right.theme && left.colorSchemeId === right.colorSchemeId && left.layout === right.layout &&
    left.selectedPanelModes.left === right.selectedPanelModes.left && left.selectedPanelModes.right === right.selectedPanelModes.right &&
    left.rightClickSelection === right.rightClickSelection && changedProfileShortcuts(left.bindings, right.bindings).length === 0;
}
