import { t } from "./i18n";

export const panelModeIds = ["brief", "medium", "full", "wide", "owners", "links", "alternativeFull"] as const;
export type PanelModeId = typeof panelModeIds[number];

export const panelModeNames = {
  brief: "Brief", medium: "Medium", full: "Full", wide: "Wide",
  owners: "File owners", links: "File links", alternativeFull: "Alternative full",
} as const;

export const panelModeDigits = {
  brief: 1, medium: 2, full: 3, wide: 4, owners: 8, links: 9, alternativeFull: 0,
} as const;

export const panelFields = {
  name: "Name", markedName: "Name with mark", rightName: "Name (keep end visible)",
  size: "Size", bytes: "Size in bytes", date: "Date", time: "Time", owner: "Owner", links: "Links",
} as const;
export type PanelField = keyof typeof panelFields;
export type PanelColumn = { field: PanelField; width: string };
export const panelNameOptions = {
  alignFiles: "Align file extensions",
  alignFolders: "Align folder extensions",
  uppercaseFolders: "Show folders in uppercase",
  lowercaseFiles: "Show files in lowercase",
  lowercaseUppercaseFiles: "Show uppercase file names in lowercase",
} as const;
export type PanelNameOption = keyof typeof panelNameOptions;
export type PanelMode = Record<PanelNameOption, boolean> & { name: string; list: PanelColumn[]; status: PanelColumn[] };
export type PanelModes = Record<PanelModeId, PanelMode>;

const columns = (...values: [PanelField, number][]): PanelColumn[] =>
  values.map(([field, width]) => ({ field, width: String(width) }));
const basicStatus = columns(["rightName", 0], ["size", 6], ["date", 0], ["time", 5]);
const nameStatus = columns(["rightName", 0]);

function mode(list: PanelColumn[], status = basicStatus): PanelMode {
  return {
    name: "", list, status, alignFiles: true, alignFolders: false, uppercaseFolders: false,
    lowercaseFiles: false, lowercaseUppercaseFiles: false,
  };
}

export const defaultPanelModes: PanelModes = {
  brief: mode(columns(["name", 0], ["name", 0], ["name", 0])),
  medium: mode(columns(["name", 0], ["name", 0])),
  full: mode(columns(["name", 0], ["size", 0], ["date", 0], ["time", 5]), nameStatus),
  wide: mode(columns(["name", 0], ["size", 6])),
  owners: mode(columns(["name", 0], ["size", 6], ["owner", 15]), columns(["rightName", 0], ["size", 6], ["date", 0], ["time", 15])),
  links: mode(columns(["name", 0], ["size", 6], ["links", 3])),
  alternativeFull: mode(columns(["markedName", 0], ["bytes", 10], ["date", 0]), nameStatus),
};

export function isPanelMode(value: unknown): value is PanelModeId {
  return typeof value === "string" && Object.hasOwn(panelModeNames, value);
}

export function panelModeName(id: PanelModeId, modes: PanelModes) {
  return modes[id].name.trim() || t(panelModeNames[id]);
}

export function isNameField(field: PanelField) {
  return field === "name" || field === "rightName" || field === "markedName";
}

export function validPanelWidth(width: string) {
  return /^(0|[1-9][0-9]{0,2})$/.test(width) ||
    /^(?:[1-9][0-9]?|100)%$/.test(width);
}

export function panelWidthsFit(columns: PanelColumn[]) {
  return columns.reduce((total, { width }) => total + (width.endsWith("%") ? Number.parseInt(width, 10) : 0), 0) <= 100;
}

export function validPanelMode(mode: PanelMode) {
  return mode.list.some(({ field }) => isNameField(field)) && [mode.list, mode.status].every((columns) =>
    panelWidthsFit(columns) && columns.every(({ width }) => validPanelWidth(width)));
}

export function readPanelModes(value: unknown): PanelModes {
  const result = { ...defaultPanelModes };
  if (!value || typeof value !== "object") return result;
  const saved = value as Partial<Record<PanelModeId, Partial<PanelMode> | null>>;
  for (const id of panelModeIds) {
    const item = saved[id];
    if (!item || typeof item !== "object") continue;
    const mode = { ...result[id] };
    if (typeof item.name === "string") mode.name = item.name;
    for (const key of Object.keys(panelNameOptions) as PanelNameOption[]) {
      const flag = item[key];
      if (typeof flag === "boolean") mode[key] = flag;
    }
    for (const key of ["list", "status"] as const) {
      const fields = item[key];
      if (Array.isArray(fields) && fields.every((column) => column && Object.hasOwn(panelFields, column.field) &&
          typeof column.width === "string" && validPanelWidth(column.width)) &&
          panelWidthsFit(fields) && (key === "status" || fields.some(({ field }) => isNameField(field)))) mode[key] = fields;
    }
    result[id] = mode;
  }
  return result;
}

export function panelColumnGroups(columns: PanelColumn[]) {
  const groups: PanelColumn[][] = [[]];
  let hadName = false;
  for (const column of columns) {
    if (isNameField(column.field)) {
      if (hadName) groups.push([]);
      hadName = true;
    }
    groups[groups.length - 1].push(column);
  }
  return groups;
}

export function displayPanelName(name: string, directory: boolean, mode: PanelMode) {
  const text = name.normalize("NFC");
  if (directory) return mode.uppercaseFolders ? text.toLocaleUpperCase() : text;
  return mode.lowercaseFiles || (mode.lowercaseUppercaseFiles && text === text.toLocaleUpperCase())
    ? text.toLocaleLowerCase() : text;
}
