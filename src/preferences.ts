import { readRetainedFonts, readSchemes, readSystemScheme, readTheme, type RetainedFonts, type Scheme, type Theme } from "./appearance";
import { migrateSharedViewerZoom, validViewFontSize, viewFontKeys, type ViewFontSizes } from "./viewFonts";
import { readLanguage, t, type Language } from "./i18n";
import { reportFrontendError } from "./diagnostics";
import { isTauri } from "@tauri-apps/api/core";
import { folderGroups, type FolderGroup } from "./folderShortcuts";
import { api, windowsClient, type QuickLocation } from "./api";
import { isPanelMode, panelModeDigits, panelModeIds, panelModeNames, readPanelModes, type PanelModeId, type PanelModes } from "./panelModes";

import { isSortMode, readSortSettings, sortModeIds, sortModes, type SortMode, type SortSettings } from "./fileSort";

type SortModeCommand = `sortMode-${SortMode}`;
const sortModeCommands = Object.fromEntries(sortModeIds.map((mode) =>
  [sortModeCommand(mode), { label: "Sort by {0}", key: sortModes[mode].key }],
)) as Record<SortModeCommand, { label: string; key: string }>;

export function sortModeCommand(mode: SortMode): SortModeCommand {
  return `sortMode-${mode}`;
}

export function commandSortMode(command: Command): SortMode | undefined {
  if (!command.startsWith("sortMode-")) return;
  const mode = command.slice("sortMode-".length);
  if (isSortMode(mode)) return mode;
}

type FolderGroupCommand = `addFolderGroup${FolderGroup}` | `openFolderGroup${FolderGroup}`;
export type PanelModeCommand = `panelMode-${PanelModeId}`;
const panelModeCommands = Object.fromEntries(panelModeIds.map((id) =>
  [panelModeCommand(id), { label: "Switch to {0} panel mode", key: `LeftCtrl+${panelModeDigits[id]}` }],
)) as Record<PanelModeCommand, { label: string; key: string }>;

export function panelModeCommand(id: PanelModeId): PanelModeCommand {
  return `panelMode-${id}`;
}

export function commandPanelMode(command: Command): PanelModeId | undefined {
  if (!command.startsWith("panelMode-")) return;
  const id = command.slice("panelMode-".length);
  if (isPanelMode(id)) return id;
}
const macDocumentKeys = typeof navigator !== "undefined" && /Macintosh/.test(navigator.userAgent);
const documentModifier = macDocumentKeys ? "Meta" : "Ctrl";
const folderGroupCommands = Object.fromEntries(folderGroups.flatMap((group) => [
  [`addFolderGroup${group}`, { label: "Add folder shortcut to group {0}", key: `Ctrl+Shift+${group}` }],
  [`openFolderGroup${group}`, { label: "Open folder shortcut group {0}", key: `RightCtrl+${group}` }],
])) as Record<FolderGroupCommand, { label: string; key: string }>;
const driveLetters = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
  "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z"] as const;
export type DriveSourceCommand = `drive${typeof driveLetters[number]}Sources`;
const driveSourceCommands = Object.fromEntries(driveLetters.map((letter) => [
  `drive${letter}Sources`, { label: "Select drive {0} in the sources menu", key: windowsClient ? letter : "" },
])) as Record<DriveSourceCommand, { label: string; key: string }>;

export function driveSourceCommand({ path, label }: QuickLocation): DriveSourceCommand | undefined {
  const letter = windowsClient && /^([a-z]):[\\/]$/i.exec(path)?.[1]?.toUpperCase();
  return letter && label.toUpperCase() === `${letter}:` ? `drive${letter}Sources` as DriveSourceCommand : undefined;
}

export const commands = {
  switchPane: { label: "Switch pane", key: "Tab" },
  swap: { label: "Swap panes", key: "Ctrl+U" },
  upRow: { label: "Previous item", key: "ArrowUp" },
  downRow: { label: "Next item", key: "ArrowDown" },
  selectUpRow: { label: "Extend selection up", key: "Shift+ArrowUp" },
  selectDownRow: { label: "Extend selection down", key: "Shift+ArrowDown" },
  firstRow: { label: "First item", key: "ArrowLeft" },
  lastRow: { label: "Last item", key: "ArrowRight" },
  pageUp: { label: "Previous page", key: "PageUp" },
  pageDown: { label: "Next page", key: "PageDown" },
  mark: { label: "Mark or unmark item", key: "Insert" },
  open: { label: "Open", key: "Enter" },
  parent: { label: "Parent folder", key: "" },
  back: { label: "Back", key: "Alt+ArrowLeft" },
  forward: { label: "Forward", key: "Alt+ArrowRight" },
  address: { label: "Go to path", key: "Ctrl+L" },
  refresh: { label: "Refresh", key: "Ctrl+R" },
  filter: { label: "Filter folder", key: "" },
  attributes: { label: "File attributes", key: "Ctrl+A" },
  quickSearch: { label: "Quick search by name prefix", key: "Alt+Letter" },
  hidden: { label: "Show or hide hidden files", key: "Ctrl+H" },
  rename: { label: "Rename", key: "F2" },
  lockingProcesses: { label: "Find locking processes", key: "" },
  view: { label: "View text or measure folder", key: "F3" },
  quickView: { label: "Quick View", key: "Ctrl+Q" },
  gitView: { label: "Git View", key: "Ctrl+Shift+G" },
  environmentVariables: { label: "Environment variables", key: "" },
  analyzeSpace: { label: "Analyze space", key: "Ctrl+Shift+D" },
  cancelMeasure: { label: "Cancel folder operation or clear command line", key: "Escape" },
  edit: { label: "Edit text", key: "F4" },
  newFile: { label: "New file", key: "Shift+F4" },
  createArchive: { label: "Create archive", key: "Shift+F1" },
  copy: { label: "Copy", key: "F5" },
  move: { label: "Move", key: "F6" },
  mkdir: { label: "New folder", key: "F7" },
  search: { label: "Find files", key: "Alt+F7" },
  copyClipboard: { label: "Copy files to clipboard", key: "Ctrl+C" },
  copyFullPath: { label: "Copy full path", key: "Ctrl+Shift+C" },
  copyItemNames: { label: "Copy item names", key: "Ctrl+Insert" },
  pasteClipboard: { label: "Paste files from clipboard", key: "Ctrl+V" },
  recycle: { label: "Move to Trash", key: "F8" },
  recycleAlternate: { label: "Move to Trash (alternate)", key: "Delete" },
  delete: { label: "Delete permanently", key: "Shift+Delete" },
  menu: { label: "Open main menu", key: "F9" },
  menuAlternate: { label: "Open main menu (alternate)", key: "Alt" },
  close: { label: "Close main window", key: "F10" },
  leftLocations: { label: "Left pane sources", key: "Alt+F1" },
  rightLocations: { label: "Right pane sources", key: "Alt+F2" },
  shrinkLeft: { label: "Move pane divider left", key: "Ctrl+ArrowLeft" },
  growLeft: { label: "Move pane divider right", key: "Ctrl+ArrowRight" },
  zoomFont: { label: "Font zoom with mouse wheel", key: "Ctrl+Wheel" },
  compare: { label: "Compare files", key: "Shift+F11" },
  terminal: { label: "Show or hide file panels", key: "Ctrl+O" },
  toggleTerminal: { label: "Toggle terminal", key: "F12" },
  pasteTerminalText: { label: "Paste text into terminal", key: "Ctrl+V" },
  expandTerminal: { label: "Make the terminal taller", key: "Ctrl+ArrowUp" },
  collapseTerminal: { label: "Make the terminal shorter", key: "Ctrl+ArrowDown" },
  commandPath: { label: "Insert selected path in command line", key: "Ctrl+F" },
  commandName: { label: "Insert selected name in command line", key: "Ctrl+Enter" },
  previousCommand: { label: "Previous command", key: "Ctrl+E" },
  commandHistory: { label: "Command history", key: "Alt+F8" },
  connect: { label: "Connect to a remote machine", key: "Ctrl+Shift+K" },
  settings: { label: "Options", key: "Ctrl+Alt+S" },
  help: { label: "Help", key: "F1" },
  nextDocument: { label: "Next open window", key: "Ctrl+Tab" },
  previousDocument: { label: "Previous open window", key: "Ctrl+Shift+Tab" },
  viewAsHex: { label: "Toggle hexadecimal viewer", key: "F4" },
  switchDocumentMode: { label: "Switch between Viewer and Editor", key: "F6" },
  saveText: { label: "Save text", key: "Ctrl+S" },
  closeText: { label: "Close the viewer or editor", key: "F10" },
  cancelText: { label: "Exit the viewer or editor", key: "Escape" },
  documentBack: { label: "Markdown back", key: "Alt+ArrowLeft" },
  documentForward: { label: "Markdown forward", key: "Alt+ArrowRight" },
  documentSearch: { label: "Search rendered Markdown", key: `${documentModifier}+F` },
  documentCopy: { label: "Copy document selection", key: `${documentModifier}+C` },
  documentSelectAll: { label: "Select all document text", key: `${documentModifier}+A` },
  documentUndo: { label: "Undo text edit", key: `${documentModifier}+Z` },
  documentRedo: { label: "Redo text edit", key: macDocumentKeys ? "Meta+Shift+Z" : "Ctrl+Y" },
  documentStart: { label: "Go to start of document", key: macDocumentKeys ? "Meta+ArrowUp" : "Ctrl+Home" },
  documentEnd: { label: "Go to end of document", key: macDocumentKeys ? "Meta+ArrowDown" : "Ctrl+End" },
  previousChange: { label: "Previous difference", key: "F7" },
  nextChange: { label: "Next difference", key: "F8" },
  folderNameHistory: { label: "Folder name history", key: "Alt+ArrowDown" },
  processSources: { label: "Select Processes in the sources menu", key: "1" },
  ftpSources: { label: "Select FTP in the sources menu", key: "2" },
  smbSources: { label: "Select SMB in the sources menu", key: "3" },
  remoteSources: { label: "Select Remote machine in the sources menu", key: "4" },
  sshSources: { label: "Select SSH in the sources menu", key: "5" },
  ...driveSourceCommands,
  addFtpProfile: { label: "Add FTP connection", key: "Shift+F4" },
  editFtpProfile: { label: "Edit FTP connection", key: "F4" },
  addSshProfile: { label: "Add SSH connection", key: "Shift+F4" },
  editSshProfile: { label: "Edit SSH connection", key: "F4" },
  addSmbProfile: { label: "Add SMB connection", key: "Shift+F4" },
  editSmbProfile: { label: "Edit SMB connection", key: "F4" },
  addRemoteProfile: { label: "Add remote machine", key: "Shift+F4" },
  editRemoteProfile: { label: "Edit remote machine", key: "F4" },
  folderShortcuts: { label: "Folder shortcuts", key: "" },
  addFolderShortcut: { label: "Bookmark current folder in group 8", key: "Ctrl+Shift+F8" },
  ...folderGroupCommands,
  ...panelModeCommands,
  ...sortModeCommands,
  sortMenu: { label: "Sort modes", key: "Ctrl+F12" },
  sortGroups: { label: "Use sort groups", key: "" },
  sortMarkedFirst: { label: "Show selected first", key: "Shift+F12" },
  sortDirectoriesFirst: { label: "Show directories first", key: "" },
  sortAscending: { label: "Sort ascending", key: "+" },
  sortDescending: { label: "Sort descending", key: "-" },
  sortReverse: { label: "Reverse sort direction", key: "*" },
  sortEditCriteria: { label: "Edit sort tie-breakers", key: "F4" },
  pickerAddFolder: { label: "Add a folder shortcut from the picker", key: "Insert" },
  pickerEditFolder: { label: "Edit the selected folder shortcut", key: "F4" },
  pickerRemoveFolder: { label: "Remove the selected folder shortcut", key: "Delete" },
  pickerFolderUp: { label: "Move the folder shortcut up", key: "Ctrl+ArrowUp" },
  pickerFolderDown: { label: "Move the folder shortcut down", key: "Ctrl+ArrowDown" },
} as const;

export type Command = keyof typeof commands;
export type Bindings = Record<Command, readonly string[]>;
export type ShortcutScheme = { id: string; name: string; bindings: Bindings };
export type Provider = "server" | "kswitcher";

const alternateDefaults: Partial<Record<Command, { oldCommand: string; key: string }>> = {
  sortAscending: { oldCommand: "sortAscendingAlternate", key: "Shift++" },
  sortReverse: { oldCommand: "sortReverseAlternate", key: "Shift+*" },
  firstRow: { oldCommand: "firstRowAlternate", key: "Home" },
  lastRow: { oldCommand: "lastRowAlternate", key: "End" },
  refresh: { oldCommand: "refreshAlternate", key: "" },
  saveText: { oldCommand: "saveTextAlternate", key: "F2" },
  documentRedo: { oldCommand: "documentRedoAlternate", key: macDocumentKeys ? "" : "Ctrl+Shift+Z" },
};

export function folderGroupCommand(command: Command) {
  const match = /^(addFolderGroup|openFolderGroup)([0-9])$/.exec(command);
  return match ? { add: match[1] === "addFolderGroup", group: Number(match[2]) as FolderGroup } : null;
}

export function commandLabel(command: Command) {
  const folder = folderGroupCommand(command);
  const drive = /^drive([A-Z])Sources$/.exec(command)?.[1];
  if (drive) return t(commands[command].label, `${drive}:`);
  const sort = commandSortMode(command);
  if (sort) return t(commands[command].label, t(sortModes[sort].label).toLocaleLowerCase());
  const mode = commandPanelMode(command);
  if (mode) return t(commands[command].label, t(panelModeNames[mode]));
  return folder ? t(commands[command].label, folder.group) : t(commands[command].label);
}

export function commandScope(command: Command) {
  if (command === "help" || command === "menu" || command === "menuAlternate") return "global";
  if (command === "zoomFont") return "wheel";
  if (command === "pasteTerminalText") return "terminal";
  if (command.endsWith("Sources")) return "sources";
  if (command === "addFtpProfile" || command === "editFtpProfile") return "ftp";
  if (command === "addSshProfile" || command === "editSshProfile") return "ssh";
  if (command === "addSmbProfile" || command === "editSmbProfile") return "smb";
  if (command === "addRemoteProfile" || command === "editRemoteProfile") return "remote";
  if (command === "viewAsHex") return "viewer";
  if (command === "switchDocumentMode" || command === "saveText" || command === "closeText" ||
      command === "cancelText" || command.startsWith("document")) return "text";
  if (command === "previousChange" || command === "nextChange") return "compare";
  if (command === "folderNameHistory") return "folderDialog";
  if (command.startsWith("picker")) return "folderPicker";
  if (command === "sortAscending" || command === "sortDescending" || command === "sortReverse" || command === "sortEditCriteria") return "sortMenu";
  return "main";
}

export function shortcutScopesOverlap(left: Command, right: Command) {
  const leftScope = commandScope(left);
  const rightScope = commandScope(right);
  if (leftScope === rightScope) return true;
  if (leftScope === "wheel" || rightScope === "wheel") return false;
  if (leftScope === "global" || rightScope === "global") return true;
  const commands = [left, right];
  if (commands.includes("open") && [leftScope, rightScope].some((scope) => ["ftp", "ssh", "smb", "remote"].includes(scope))) return true;
  if (commands.includes("viewAsHex") && (leftScope === "text" || rightScope === "text")) return true;
  if (commands.includes("swap") && (leftScope === "compare" || rightScope === "compare")) return true;
  return (leftScope === "text" || rightScope === "text" || leftScope === "viewer" || rightScope === "viewer") &&
    (commands.includes("nextDocument") || commands.includes("previousDocument") || commands.includes("settings"));
}

function shortcutOverlap(left: string, right: string) {
  return left === right || left.replace(/^(Left|Right)Ctrl\+/, "Ctrl+") === right ||
    right.replace(/^(Left|Right)Ctrl\+/, "Ctrl+") === left;
}

export function shortcutConflicts(bindings: Bindings, command: Command, key: string) {
  return commandNames.filter((other) => other !== command && bindings[other].some((binding) => shortcutOverlap(binding, key)) && shortcutScopesOverlap(other, command));
}

export function assignShortcut(bindings: Bindings, command: Command, key: string, replacing?: string): Bindings {
  const next = { ...bindings };
  for (const other of shortcutConflicts(bindings, command, key)) next[other] = bindings[other].filter((binding) => !shortcutOverlap(binding, key));
  if (!bindings[command].includes(key)) {
    const current = bindings[command];
    next[command] = replacing ? current.flatMap((binding) => binding === replacing ? [key] :
      shortcutOverlap(binding, key) ? [] : [binding]) : [...current.filter((binding) => !shortcutOverlap(binding, key)), key];
  }
  return next;
}

export const panelLayouts = { standard: "Standard", twin: "Twin panels", classic: "Classic commander" } as const;
export type PanelLayout = keyof typeof panelLayouts;

export const actionButtonWidths = { full: "Full width", compact: "Compact" } as const;
export type ActionButtonWidth = keyof typeof actionButtonWidths;
export const menuPositions = { left: "Left", center: "Center", right: "Right" } as const;
export type MenuPosition = keyof typeof menuPositions;

export interface Preferences {
  language: Language;
  theme: Theme;
  layout: PanelLayout;
  panelModes: PanelModes;
  sortSettings: SortSettings;
  selectedPanelModes: Record<"left" | "right", PanelModeId>;
  actionButtonWidth: ActionButtonWidth;
  hideActionButtonIcons: boolean;
  mainMenuAlignment: MenuPosition;
  systemLightScheme: string;
  systemDarkScheme: string;
  showTitlebarScheme: boolean;
  showStatusBar: boolean;
  activeScheme: string | null;
  schemes: Scheme[];
  retainedFonts?: RetainedFonts;
  hidden: boolean;
  refreshEnvironment: boolean;
  terminalPasteOnRightClick: boolean;
  provider: Provider;
  kswitcher: string;
  activeShortcutScheme: string | null;
  shortcutSchemes: ShortcutScheme[];
  viewFontSizes: ViewFontSizes;
  viewerContentWidth?: number;
  viewerMarkdownContentWidth?: number | "full";
  terminalResizeRows: number;
}

export const minViewerContentWidth = 320;
export const maxViewerContentWidth = 2400;
export const maxTerminalResizeRows = 50;

export const preferenceKey = "dirlume.preferences.v1";
export const preferenceBindingVersion = 7;
const mac = /Mac/i.test(navigator.userAgent);
const metaKeyLabel = windowsClient ? "Win" : /Linux/i.test(navigator.userAgent) ? "Super" : "Meta";
export const commandNames = Object.keys(commands) as Command[];
export const wheelBindings = ["Ctrl+Wheel", "Meta+Wheel", "Alt+Wheel", "Shift+Wheel"];
export const defaultBindings = Object.fromEntries<readonly string[]>(commandNames.map((command) => {
  const key = mac && command !== "settings" && command !== "nextDocument" && command !== "previousDocument" && command !== "zoomFont" &&
    command !== "expandTerminal" && command !== "collapseTerminal" &&
    command !== "addFolderShortcut" && command !== "pasteTerminalText" && command !== "copyItemNames" && command !== "quickView" &&
    !folderGroupCommand(command) && !command.startsWith("sort") && commandScope(command) !== "folderPicker"
    ? commands[command].key.replace(/^Ctrl\+/, "Meta+") : commands[command].key;
  const alternate = mac && (command === "shrinkLeft" || command === "growLeft") ? commands[command].key : alternateDefaults[command]?.key;
  return [command, [key, alternate].filter((value): value is string => Boolean(value))];
})) as Bindings;

export function shortcutBindings(preferences: Preferences) {
  return preferences.shortcutSchemes.find(({ id }) => id === preferences.activeShortcutScheme)?.bindings ?? defaultBindings;
}

function readBindings(saved: Record<string, unknown> | undefined, version: number): Bindings {
  const oldDefaults: Partial<Record<Command, string>> = {
    firstRow: "Home", lastRow: "End", mark: "Space", rename: "F2",
    filter: mac ? "Meta+F" : "Ctrl+F", terminal: mac ? "Meta+`" : "Ctrl+`",
    previousChange: "Alt+ArrowUp", nextChange: "Alt+ArrowDown",
  };
  const candidates = commandNames.flatMap((command) => {
    const value = saved?.[command];
    const group = folderGroupCommand(command);
    const legacyDefault = group && !group.add && version < 7 ? `Ctrl+${group.group}` : undefined;
    const migrated = legacyDefault && (value === legacyDefault ||
      (Array.isArray(value) && value.length === 1 && value[0] === legacyDefault));
    if (migrated) return defaultBindings[command].map((key) => ({ command, key, configured: false }));
    if (Array.isArray(value)) return value.flatMap((key: unknown) =>
      typeof key === "string" && key && (command !== "zoomFont" || wheelBindings.includes(key)) ? [{ command, key, configured: true }] : []);
    const useSaved = typeof value === "string" && (version > 0 || value !== oldDefaults[command]) &&
      !(command === "settings" && version < 3 && value === (mac ? "Meta+," : "Ctrl+,")) &&
      !(command === "ftpSources" && version < 5 && value === "1") &&
      !(command === "rename" && version < 4 && !value && saved?.refreshAlternate === "F2");
    const alternate = alternateDefaults[command];
    const alternateValue = alternate && saved?.[alternate.oldCommand];
    const configuredAlternate = typeof alternateValue === "string" && !(command === "refresh" && version < 4 && alternateValue === "F2");
    return [
      { command, key: useSaved ? value : defaultBindings[command][0], configured: useSaved },
      { command, key: configuredAlternate ? alternateValue : defaultBindings[command][1], configured: configuredAlternate },
    ];
  });
  const accepted = new Set<(typeof candidates)[number]>();
  const owners: { key: string; command: Command }[] = [];
  // Existing choices take precedence over newly introduced defaults.
  for (const binding of [...candidates.filter(({ configured }) => configured), ...candidates.filter(({ configured }) => !configured)]) {
    const { command, key } = binding;
    if (!key || (command === "zoomFont" && !wheelBindings.includes(key))) continue;
    if (owners.some((other) => shortcutOverlap(other.key, key) && shortcutScopesOverlap(other.command, command))) continue;
    accepted.add(binding);
    owners.push({ key, command });
  }
  return Object.fromEntries<readonly string[]>(commandNames.map((command) => [command,
    candidates.flatMap((binding) => binding.command === command && binding.key && accepted.has(binding) ? [binding.key] : []),
  ])) as Bindings;
}

function readShortcutSchemes(value: unknown, version: number): ShortcutScheme[] {
  if (!Array.isArray(value)) return [];
  const schemes: ShortcutScheme[] = [];
  for (const item of value as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const { id, name, bindings } = item as { id?: unknown; name?: unknown; bindings?: unknown };
    if (typeof id !== "string" || !id || typeof name !== "string" || !name.trim() || schemes.some((scheme) => scheme.id === id) ||
        !bindings || typeof bindings !== "object" || Array.isArray(bindings)) continue;
    schemes.push({ id, name: name.trim(), bindings: readBindings(bindings as Record<string, unknown>, version) });
  }
  return schemes;
}

function readMenuAlignment(value: unknown): MenuPosition | undefined {
  return value === "left" || value === "center" || value === "right" ? value : undefined;
}

export const preferenceGroups = {
  general: "General",
  appearance: "Appearance",
  shortcuts: "Keyboard shortcuts",
  filePanels: "Main File Panels",
  terminal: "Terminal",
  viewer: "Viewer",
} as const;

export type PreferenceGroup = keyof typeof preferenceGroups;
type PreferenceValues = Record<string, unknown>;
type ReadPreference = <K extends keyof Preferences>(key: K) => Preferences[K];
type PreferenceDefinition<K extends keyof Preferences> = {
  group: PreferenceGroup;
  portable: boolean | "items";
  read: (value: unknown, get: ReadPreference, bindingVersion: number) => Preferences[K];
  acceptsReference?: (value: unknown) => boolean;
};

function readViewFontSizes(value: unknown): ViewFontSizes {
  const saved = preferenceValues(value);
  const sizes: ViewFontSizes = {};
  for (const view of viewFontKeys) if (validViewFontSize(saved[view])) sizes[view] = saved[view];
  return sizes;
}

function readInteger(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

function customSchemeReference(value: unknown) {
  return typeof value === "string" && /^custom:.+$/.test(value);
}

export const preferenceDefinitions: { [K in keyof Preferences]-?: PreferenceDefinition<K> } = {
  language: { group: "general", portable: true, read: readLanguage },
  mainMenuAlignment: { group: "general", portable: true, read: (value) => readMenuAlignment(value) ?? "center" },
  provider: { group: "general", portable: true, read: (value) => value === "kswitcher" ? "kswitcher" : "server" },
  kswitcher: { group: "general", portable: false, read: (value) => typeof value === "string" ? value : "" },
  theme: { group: "appearance", portable: true, read: readTheme },
  schemes: { group: "appearance", portable: "items", read: readSchemes },
  retainedFonts: { group: "appearance", portable: true, read: readRetainedFonts },
  activeScheme: { group: "appearance", portable: true,
    read: (value, get) => get("schemes").find(({ id }) => id === value)?.id ?? null,
    acceptsReference: (value) => value === null || typeof value === "string" && value.length > 0 },
  systemLightScheme: { group: "appearance", portable: true,
    read: (value, get) => readSystemScheme(value, get("schemes"), "light"), acceptsReference: customSchemeReference },
  systemDarkScheme: { group: "appearance", portable: true,
    read: (value, get) => readSystemScheme(value, get("schemes"), "dark"), acceptsReference: customSchemeReference },
  showTitlebarScheme: { group: "appearance", portable: true, read: (value) => value === true },
  showStatusBar: { group: "appearance", portable: true, read: (value) => value !== false },
  viewFontSizes: { group: "appearance", portable: true, read: readViewFontSizes },
  shortcutSchemes: { group: "shortcuts", portable: true, read: (value, _get, version) => readShortcutSchemes(value, version) },
  activeShortcutScheme: { group: "shortcuts", portable: true, read: (value, get) => get("shortcutSchemes").find(({ id }) => id === value)?.id ?? null },
  layout: { group: "filePanels", portable: true, read: (value) =>
    typeof value === "string" && Object.hasOwn(panelLayouts, value) ? value as PanelLayout : "standard" },
  sortSettings: { group: "filePanels", portable: true, read: readSortSettings },
  panelModes: { group: "filePanels", portable: true, read: readPanelModes },
  selectedPanelModes: { group: "filePanels", portable: true, read: (value) => {
    const { left, right } = preferenceValues(value);
    return { left: isPanelMode(left) ? left : "full", right: isPanelMode(right) ? right : "full" };
  } },
  actionButtonWidth: { group: "filePanels", portable: true, read: (value) => value === "full" ? "full" : "compact" },
  hideActionButtonIcons: { group: "filePanels", portable: true, read: (value) => value === true },
  hidden: { group: "filePanels", portable: true, read: (value) => value === true },
  refreshEnvironment: { group: "terminal", portable: true, read: (value) => value !== false },
  terminalPasteOnRightClick: { group: "terminal", portable: true, read: (value) => value !== false },
  terminalResizeRows: { group: "terminal", portable: true, read: (value) => readInteger(value, 1, maxTerminalResizeRows) ?? 1 },
  viewerContentWidth: { group: "viewer", portable: true, read: (value) => readInteger(value, minViewerContentWidth, maxViewerContentWidth) },
  viewerMarkdownContentWidth: { group: "viewer", portable: true, read: (value) => value === "full" ? "full" :
    readInteger(value, minViewerContentWidth, maxViewerContentWidth) },
};

export const preferenceKeys = Object.keys(preferenceDefinitions) as (keyof Preferences)[];

function preferenceValues(value: unknown): PreferenceValues {
  return value && typeof value === "object" && !Array.isArray(value) ? value as PreferenceValues : {};
}

export function migratePreferenceValues(value: unknown): PreferenceValues {
  const saved = { ...preferenceValues(value) };
  const legacyAlignment = readMenuAlignment(saved.menuPosition);
  if (legacyAlignment && !readMenuAlignment(saved.mainMenuAlignment)) saved.mainMenuAlignment = legacyAlignment;

  const bindingVersion = typeof saved.bindingDefaults === "number" ? saved.bindingDefaults : 0;
  if (!Array.isArray(saved.shortcutSchemes) && saved.shortcuts) {
    const bindings = readBindings(preferenceValues(saved.shortcuts), bindingVersion);
    const custom = commandNames.some((command) => bindings[command].length !== defaultBindings[command].length ||
      bindings[command].some((key, index) => key !== defaultBindings[command][index]));
    if (custom) {
      saved.activeShortcutScheme = "my-shortcuts";
      saved.shortcutSchemes = [{ id: saved.activeShortcutScheme, name: "My shortcuts", bindings }];
    }
  }
  return saved;
}

export function normalizePreferences(value: unknown): Preferences {
  const saved = migratePreferenceValues(value);
  const version = typeof saved.bindingDefaults === "number" ? saved.bindingDefaults : 0;
  const settings = {} as Preferences;
  function get<K extends keyof Preferences>(key: K): Preferences[K] {
    if (!Object.hasOwn(settings, key)) {
      const definition = preferenceDefinitions[key] as PreferenceDefinition<K>;
      settings[key] = definition.read(saved[key], get, version);
    }
    return settings[key];
  }
  for (const key of preferenceKeys) get(key);
  return settings;
}

export function readPreferences(): Preferences {
  try {
    const saved = preferenceValues(JSON.parse(localStorage.getItem(preferenceKey) ?? "null"));
    return normalizePreferences(saved.independentViewerZoom === true ? saved :
      { ...saved, viewFontSizes: migrateSharedViewerZoom(saved.viewFontSizes) });
  } catch (error) {
    reportFrontendError("load_preferences", error);
    return normalizePreferences(null);
  }
}

let portableSettings = false;
let portableSnapshot: string | undefined;
let pendingPortableWrite = Promise.resolve();
let writeQueue = pendingPortableWrite;

export async function restorePortablePreferences(main: boolean) {
  if (!windowsClient || !isTauri()) return null;
  try {
    const state = await api.readPortableState();
    if (!state) return null;
    portableSettings = !state.settingsError;
    if (state.preferences) {
      portableSnapshot = JSON.stringify(state.preferences);
      if (main) localStorage.setItem(preferenceKey, portableSnapshot);
    }
    return state;
  } catch (error) {
    reportFrontendError("portable_settings", error);
    return null;
  }
}

export function flushPortablePreferences() {
  return pendingPortableWrite;
}

export function persistPreferences(preferences: Preferences) {
  const settings = Object.fromEntries(preferenceKeys.map((key) => [key, preferences[key]]));
  settings.bindingDefaults = preferenceBindingVersion;
  Object.assign(settings, { independentViewerZoom: true });
  const snapshot = JSON.stringify(settings);
  localStorage.setItem(preferenceKey, snapshot);
  if (!portableSettings || portableSnapshot === snapshot) return;
  portableSnapshot = snapshot;
  pendingPortableWrite = writeQueue.then(() => api.savePortablePreferences(settings));
  writeQueue = pendingPortableWrite.catch((error: unknown) => {
    if (portableSnapshot === snapshot) portableSnapshot = undefined;
    window.dispatchEvent(new CustomEvent("dirlume-portable-settings-error", {
      detail: error instanceof Error ? error.message : String(error),
    }));
  });
}

const heldControl = new Set<"ControlLeft" | "ControlRight">();

export function trackControlKeys() {
  function track(event: KeyboardEvent) {
    if (!event.ctrlKey) heldControl.clear();
    if (event.code !== "ControlLeft" && event.code !== "ControlRight") return;
    if (event.type === "keyup") heldControl.delete(event.code);
    else if (!event.repeat) heldControl.add(event.code);
  }

  window.addEventListener("keydown", track, true);
  window.addEventListener("keyup", track, true);
  window.addEventListener("blur", () => heldControl.clear());
}

function controlSide() {
  if (heldControl.size !== 1) return undefined;
  return heldControl.has("ControlLeft") ? "LeftCtrl" : "RightCtrl";
}

export function bindingMatches(bindings: readonly string[], shortcut: string) {
  if (!shortcut) return false;
  if (bindings.includes(shortcut)) return true;
  const side = controlSide();
  return Boolean(side && shortcut.startsWith("Ctrl+") && bindings.includes(side + shortcut.slice(4)));
}

export function captureShortcut(event: KeyboardEvent, distinguishControl: boolean) {
  if (event.getModifierState("AltGraph") && event.code === "AltRight") return "";
  const shortcut = eventShortcut(event);
  if (!distinguishControl || !shortcut.startsWith("Ctrl+")) return shortcut;
  const side = controlSide();
  return side && !event.getModifierState("AltGraph") ? side + shortcut.slice(4) : "";
}

export function eventShortcut(event: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }, key = event.key) {
  const { ctrlKey, metaKey, altKey, shiftKey } = event;
  if (ctrlKey && !metaKey && !altKey && event.code && key === event.key) {
    if (/^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
    else if (/^Numpad[0-9]$/.test(event.code) && /^[0-9]$/.test(key)) key = event.code;
  }
  if (["Control", "Meta", "Alt", "AltGraph", "Shift", "Unidentified", "Dead", "Process"].includes(key)) return "";
  return [
    ...(ctrlKey ? ["Ctrl"] : []),
    ...(metaKey ? ["Meta"] : []),
    ...(altKey ? ["Alt"] : []),
    ...(shiftKey ? ["Shift"] : []),
    key === " " ? "Space" : key.length === 1 ? key.toUpperCase() : key,
  ].join("+");
}


export function quickSearchSeed(event: KeyboardEvent, bindings: readonly string[], includeDigits = false): string | null {
  const shortcut = eventShortcut(event);
  if (bindingMatches(bindings, shortcut)) return "";
  if (!bindings.includes("Alt+Letter")) return null;
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (includeDigits) {
    if (/^[0-9]$/.test(event.key)) return event.key;
    if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  }
  if (Array.from(event.key).length === 1 && /\p{L}/u.test(event.key)) return event.key;
  // Option on macOS can emit a symbol or dead key for a physical letter key.
  if (mac && /^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
  return null;
}

export function wheelShortcut(event: WheelEvent) {
  return eventShortcut({ key: "Wheel", ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey });
}

const arrows: Record<string, string> = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };

export function showShortcut(shortcut = ""): string {
  const readable = shortcut.replace(/\bArrow(?:Left|Right|Up|Down)\b/g, (key) => arrows[key]);
  if (readable.startsWith("LeftCtrl+")) return t("Left Ctrl") + "+" + showShortcut(readable.slice(9));
  if (readable.startsWith("RightCtrl+")) return t("Right Ctrl") + "+" + showShortcut(readable.slice(10));
  if (mac) return readable.replaceAll("Meta+", "⌘").replaceAll("Ctrl+", "⌃").replaceAll("Alt+", "⌥").replaceAll("Shift+", "⇧");
  return readable.replace(/(^|\+)Meta\+/, "$1" + metaKeyLabel + "+");
}

/** A narrow label for the function-key bar. */
export function compactShortcut(shortcut: string) {
  return showShortcut(shortcut).replace(/^Shift\+/, "⇧").replace(/\bInsert\b/, "Ins").replace(/\bDelete\b/, "Del");
}

export function showShortcuts(bindings: readonly string[]) {
  return bindings.map((binding) => showShortcut(binding)).join(", ");
}
