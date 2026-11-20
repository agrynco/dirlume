import type { Entry } from "./api";
import { fileMask } from "./fileMask";

export const sortModes = {
  name: { label: "Name", key: "Ctrl+F3", asc: true },
  baseName: { label: "Name only", key: "", asc: true },
  extension: { label: "Extension", key: "Ctrl+F4", asc: true },
  modified: { label: "Write time", key: "Ctrl+F5", asc: false },
  size: { label: "Size", key: "Ctrl+F6", asc: false },
  unsorted: { label: "Unsorted", key: "Ctrl+F7", asc: true },
  created: { label: "Creation time", key: "Ctrl+F8", asc: false },
  accessed: { label: "Access time", key: "Ctrl+F9", asc: false },
  changed: { label: "Change time", key: "", asc: false },
  description: { label: "Descriptions", key: "Ctrl+F10", asc: true },
  owner: { label: "Owner", key: "Ctrl+F11", asc: true },
  allocated: { label: "Allocated size", key: "", asc: false },
  hardLinks: { label: "Number of hard links", key: "", asc: false },
  streamCount: { label: "Number of streams", key: "", asc: false },
  streamSize: { label: "Size of streams", key: "", asc: false },
} as const;
export type SortMode = keyof typeof sortModes;
export const sortModeIds = Object.keys(sortModes) as SortMode[];
export type SortColumn = SortMode | "time";
export type SortCriterion = { mode: Exclude<SortMode, "unsorted">; asc: boolean };
export type SortGroup = { mask: string; position: "before" | "after" };
export type FileSort = { column: SortColumn; asc: boolean; directoriesFirst: boolean; markedFirst: boolean; groups: boolean };
export type SortSettings = { groups: SortGroup[]; criteria: Partial<Record<SortMode, SortCriterion[]>> };

export const defaultFileSort: FileSort = { column: "name", asc: true, directoriesFirst: true, markedFirst: false, groups: false };
export const defaultSortSettings: SortSettings = { groups: [], criteria: {} };

export function sortMode(column: SortColumn): SortMode {
  return column === "time" ? "modified" : column;
}

export function isSortMode(value: unknown): value is SortMode {
  return typeof value === "string" && Object.hasOwn(sortModes, value);
}

export function readFileSort(value: Partial<FileSort> | undefined): FileSort {
  const column = value?.column;
  return !value || (column !== "time" && !isSortMode(column)) ? defaultFileSort : {
    column,
    asc: typeof value.asc === "boolean" ? value.asc : sortModes[sortMode(column)].asc,
    directoriesFirst: value.directoriesFirst !== false,
    markedFirst: value.markedFirst === true,
    groups: value.groups === true,
  };
}

export function readSortSettings(value: unknown): SortSettings {
  if (!value || typeof value !== "object") return defaultSortSettings;
  const saved = value as Partial<SortSettings>;
  const groups = Array.isArray(saved.groups) ? saved.groups.filter((item): item is SortGroup =>
    !!item && typeof item.mask === "string" && !!item.mask.trim() && (item.position === "before" || item.position === "after")) : [];
  const criteria: SortSettings["criteria"] = {};
  for (const mode of sortModeIds) {
    const values = saved.criteria?.[mode];
    if (!Array.isArray(values)) continue;
    const seen = new Set<SortMode>([mode, "unsorted"]);
    criteria[mode] = values.filter((item) => {
      if (!item || !isSortMode(item.mode) || typeof item.asc !== "boolean" || seen.has(item.mode)) return false;
      seen.add(item.mode);
      return true;
    });
  }
  return { groups, criteria };
}

export function defaultSortCriteria(mode: SortMode): SortCriterion[] {
  if (mode === "baseName") return [{ mode: "extension", asc: true }];
  if (mode === "extension") return [{ mode: "baseName", asc: true }];
  return mode === "name" || mode === "unsorted" ? [] : [{ mode: "name", asc: true }];
}

export function usesSortGroups(mode: SortMode) {
  return mode === "name" || mode === "baseName" || mode === "extension";
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

type SortValue = string | number | null | undefined;

export function compareFileEntries(
  entries: Entry[], sort: FileSort, mode: SortMode, settings: SortSettings, marked: readonly string[],
  fileName: (entry: Entry) => string, value: (entry: Entry, criterion: SortMode) => SortValue,
) {
  const criteria = settings.criteria[mode] ?? defaultSortCriteria(mode);
  const marks = new Set(sort.markedFirst ? marked : []);
  const groups = sort.groups && usesSortGroups(mode) ? settings.groups.map(({ mask, position }, index) => ({
    match: fileMask(mask.trim()), rank: position === "before" ? index - settings.groups.length : index + 1,
  })) : [];
  const items = entries.map((entry, index) => {
    const name = fileName(entry);
    const dot = entry.directory ? -1 : name.lastIndexOf(".");
    const extension = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : "";
    return {
      entry, index, rank: groups.find(({ match }) => match(name))?.rank ?? 0, extension,
      baseName: extension ? name.slice(0, dot) : name,
    };
  });
  type Item = typeof items[number];
  const read = (item: Item, criterion: SortMode): SortValue => {
    if (criterion === "name") return item.entry.name;
    if (criterion === "baseName" || criterion === "extension") return item[criterion];
    return value(item.entry, criterion);
  };
  const compare = (left: Item, right: Item, criterion: SortMode, asc: boolean) => {
    const a = read(left, criterion);
    const b = read(right, criterion);
    if (a == null || b == null) return Number(a == null) - Number(b == null);
    const order = typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b));
    return asc ? order : -order;
  };
  return items.sort((a, b) => {
    if (sort.directoriesFirst && a.entry.directory !== b.entry.directory) return Number(b.entry.directory) - Number(a.entry.directory);
    if (sort.markedFirst) {
      const markedOrder = Number(marks.has(b.entry.name)) - Number(marks.has(a.entry.name));
      if (markedOrder) return markedOrder;
    }
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (mode === "unsorted") return a.index - b.index;
    const primary = compare(a, b, mode, sort.asc);
    if (primary) return primary;
    for (const { mode, asc } of criteria) {
      const secondary = compare(a, b, mode, asc);
      if (secondary) return secondary;
    }
    return a.index - b.index;
  }).map(({ entry }) => entry);
}
