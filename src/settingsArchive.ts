import { readSchemes, type Scheme } from "./appearance";
import { migrateSharedViewerZoom } from "./viewFonts";
import {
  migratePreferenceValues, normalizePreferences, preferenceBindingVersion, preferenceDefinitions, preferenceGroups, preferenceKeys,
  type PreferenceGroup, type Preferences,
} from "./preferences";

const portableKeys = preferenceKeys.filter((key) => preferenceDefinitions[key].portable === true);
export const settingsGroupIds = (Object.keys(preferenceGroups) as PreferenceGroup[]).filter((group) =>
  portableKeys.some((key) => preferenceDefinitions[key].group === group));
type GroupValues = Record<string, unknown>;
type Groups = Partial<Record<PreferenceGroup, GroupValues>>;
export type SettingsArchive = { groups: Groups; schemes: Scheme[] };
export type SettingsSelection = { groups: PreferenceGroup[]; schemes: string[] };

const format = "dirlume-settings";
const version = 2;
const invalidFile = "The settings file is invalid.";

function isRecord(value: unknown): value is GroupValues {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  return keys.length === Object.values(right).filter((value) => value !== undefined).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

function readArchiveScheme(value: unknown): Scheme {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim() ||
      typeof value.name !== "string" || !value.name.trim() || !isRecord(value.colors) || !isRecord(value.fonts)) {
    throw new Error(invalidFile);
  }
  const scheme = readSchemes([value])[0];
  if (!scheme || scheme.name !== value.name || !sameValue(value.colors, scheme.colors) ||
      Object.hasOwn(value, "fileTypes") && !sameValue(value.fileTypes, scheme.fileTypes) ||
      Object.entries(value.fonts).some(([key, font]) => !isRecord(font) || !Object.hasOwn(scheme.fonts, key) ||
        !sameValue(font, scheme.fonts[key as keyof Scheme["fonts"]]))) throw new Error(invalidFile);
  return scheme;
}

function schemeName(name: string) {
  return name.trim().normalize("NFC").toLowerCase();
}

export function exportSettings(preferences: Preferences, selection: SettingsSelection): string {
  const saved = normalizePreferences({ ...preferences, bindingDefaults: preferenceBindingVersion });
  const groups = Object.fromEntries(selection.groups.map((group) => [group,
    Object.fromEntries(portableKeys.filter((key) => preferenceDefinitions[key].group === group).map((key) => [key, saved[key] ?? null]))]));
  const schemes = saved.schemes.filter(({ id }) => selection.schemes.includes(id));
  return JSON.stringify({ format, version, groups, schemes }, null, 2) + "\n";
}

export function parseSettingsArchive(contents: string): SettingsArchive {
  let raw: unknown;
  try { raw = JSON.parse(contents.replace(/^\uFEFF/, "")); }
  catch { throw new Error(invalidFile); }
  if (!isRecord(raw)) throw new Error(invalidFile);
  if (!Object.hasOwn(raw, "format")) {
    if (Object.hasOwn(raw, "version")) throw new Error(invalidFile);
    return { groups: {}, schemes: [readArchiveScheme(raw)] };
  }
  if (raw.format !== format || (raw.version !== version && raw.version !== 1 && raw.version !== 0)) {
    throw new Error("This settings file version is not supported.");
  }
  if (!isRecord(raw.groups) || !Array.isArray(raw.schemes)) throw new Error(invalidFile);
  const bindings = raw.version === 0 ? 0 : preferenceBindingVersion;
  const values: GroupValues = Object.create(null);
  for (const [group, data] of Object.entries(raw.groups)) {
    if (!Object.hasOwn(preferenceGroups, group)) continue;
    if (!isRecord(data)) throw new Error(invalidFile);
    Object.assign(values, data);
  }
  if (raw.version !== version && Object.hasOwn(values, "viewFontSizes")) {
    values.viewFontSizes = migrateSharedViewerZoom(values.viewFontSizes);
  }
  const migrated = migratePreferenceValues({ ...values, bindingDefaults: bindings });
  const schemes = raw.schemes.map(readArchiveScheme);
  if (new Set(schemes.map(({ id }) => id)).size !== schemes.length ||
      new Set(schemes.map(({ name }) => schemeName(name))).size !== schemes.length) throw new Error(invalidFile);
  const normalized = normalizePreferences({ ...migrated, schemes, bindingDefaults: bindings });
  const groups: Groups = {};
  for (const key of portableKeys) {
    if (!Object.hasOwn(migrated, key)) continue;
    const { group, acceptsReference } = preferenceDefinitions[key];
    const valid = sameValue(migrated[key], normalized[key] ?? null) || acceptsReference?.(migrated[key]);
    if (!valid) throw new Error(invalidFile);
    (groups[group] ??= {})[key] = migrated[key];
  }
  if (!Object.keys(groups).length && !schemes.length) throw new Error("The settings file contains no supported settings or color schemes.");
  return { groups, schemes };
}

export function prepareSettingsImport(current: Preferences, archive: SettingsArchive, selection: SettingsSelection) {
  const schemes = [...current.schemes];
  const importedIds = new Map<string, string>();
  const replacements: Pick<Scheme, "id" | "name">[] = [];
  for (const scheme of archive.schemes.filter(({ id }) => selection.schemes.includes(id))) {
    const matches = current.schemes.filter(({ id, name }) => id === scheme.id || schemeName(name) === schemeName(scheme.name));
    const [match] = matches;
    if (matches.length > 1 || match && [...importedIds.values()].includes(match.id)) {
      throw new Error("The selected color schemes conflict with more than one local scheme.");
    }
    if (match) {
      replacements.push({ id: match.id, name: match.name });
      schemes[current.schemes.indexOf(match)] = { ...scheme, id: match.id };
    } else {
      schemes.push(scheme);
    }
    importedIds.set(scheme.id, match?.id ?? scheme.id);
  }

  const values: GroupValues = Object.assign({}, ...selection.groups.map((group) => archive.groups[group]));
  if (Object.hasOwn(values, "activeShortcutScheme") && !Object.hasOwn(values, "profileBindings")) values.profileBindings = undefined;
  if (typeof values.activeScheme === "string") values.activeScheme = importedIds.get(values.activeScheme) ?? values.activeScheme;
  for (const key of ["systemLightScheme", "systemDarkScheme"]) {
    const favorite = values[key];
    if (typeof favorite !== "string" || !favorite.startsWith("custom:")) continue;
    const id = importedIds.get(favorite.slice(7));
    if (id) values[key] = "custom:" + id;
  }
  const normalized = normalizePreferences({ ...current, ...values, schemes, bindingDefaults: preferenceBindingVersion });
  const keys = Object.keys(values) as (keyof Preferences)[];
  const patch = Object.fromEntries(keys.map((key) => [key, normalized[key]])) as Partial<Preferences>;
  if (importedIds.size) patch.schemes = schemes;
  return { patch, replacements };
}
