import { readSchemes, readSystemScheme, readTheme, type Scheme, type Theme } from "./appearance";
import { validViewFontSize, viewFontKeys, type ViewFontSizes } from "./viewFonts";
import { readLanguage, t, type Language } from "./i18n";
import { reportFrontendError } from "./diagnostics";
import { folderGroups, type FolderGroup } from "./folderShortcuts";
import { windowsClient } from "./api";

type FolderGroupCommand = `addFolderGroup${FolderGroup}` | `openFolderGroup${FolderGroup}`;
const folderGroupCommands = Object.fromEntries(folderGroups.flatMap((group) => [
  [`addFolderGroup${group}`, { label: "Add folder shortcut to group {0}", key: `Ctrl+Shift+${group}` }],
  [`openFolderGroup${group}`, { label: "Open folder shortcut group {0}", key: `Ctrl+${group}` }],
])) as Record<FolderGroupCommand, { label: string; key: string }>;

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
  saveText: { label: "Save text", key: "Ctrl+S" },
  closeText: { label: "Close the viewer or editor", key: "F10" },
  cancelText: { label: "Exit the viewer or editor", key: "Escape" },
  previousChange: { label: "Previous difference", key: "F7" },
  nextChange: { label: "Next difference", key: "F8" },
  folderNameHistory: { label: "Folder name history", key: "Alt+ArrowDown" },
  processSources: { label: "Select Processes in the sources menu", key: "1" },
  ftpSources: { label: "Select FTP in the sources menu", key: "2" },
  smbSources: { label: "Select SMB in the sources menu", key: "3" },
  remoteSources: { label: "Select Remote machine in the sources menu", key: "4" },
  sshSources: { label: "Select SSH in the sources menu", key: "5" },
  addFtpProfile: { label: "Add FTP connection", key: "Shift+F4" },
  editFtpProfile: { label: "Edit FTP connection", key: "F4" },
  addSshProfile: { label: "Add SSH connection", key: "Shift+F4" },
  editSshProfile: { label: "Edit SSH connection", key: "F4" },
  folderShortcuts: { label: "Folder shortcuts", key: "" },
  addFolderShortcut: { label: "Bookmark current folder in group 8", key: "Ctrl+Shift+F8" },
  ...folderGroupCommands,
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
  firstRow: { oldCommand: "firstRowAlternate", key: "Home" },
  lastRow: { oldCommand: "lastRowAlternate", key: "End" },
  refresh: { oldCommand: "refreshAlternate", key: "" },
  saveText: { oldCommand: "saveTextAlternate", key: "F2" },
};

export function folderGroupCommand(command: Command) {
  const match = /^(addFolderGroup|openFolderGroup)([0-9])$/.exec(command);
  return match ? { add: match[1] === "addFolderGroup", group: Number(match[2]) as FolderGroup } : null;
}

export function commandLabel(command: Command) {
  const folder = folderGroupCommand(command);
  return folder ? t(commands[command].label, folder.group) : t(commands[command].label);
}

export function commandScope(command: Command) {
  if (command === "help" || command === "menu") return "global";
  if (command === "zoomFont") return "wheel";
  if (command.endsWith("Sources")) return "sources";
  if (command === "addFtpProfile" || command === "editFtpProfile") return "ftp";
  if (command === "addSshProfile" || command === "editSshProfile") return "ssh";
  if (command === "viewAsHex") return "viewer";
  if (command === "saveText" || command === "closeText" || command === "cancelText") return "text";
  if (command === "previousChange" || command === "nextChange") return "compare";
  if (command === "folderNameHistory") return "folderDialog";
  if (command.startsWith("picker")) return "folderPicker";
  return "main";
}

export function shortcutScopesOverlap(left: Command, right: Command) {
  const leftScope = commandScope(left);
  const rightScope = commandScope(right);
  if (leftScope === rightScope) return true;
  if (leftScope === "wheel" || rightScope === "wheel") return false;
  if (leftScope === "global" || rightScope === "global") return true;
  const commands = [left, right];
  if (commands.includes("open") && (leftScope === "ftp" || rightScope === "ftp")) return true;
  if (commands.includes("viewAsHex") && (commands.includes("closeText") || commands.includes("cancelText"))) return true;
  return (leftScope === "text" || rightScope === "text" || leftScope === "viewer" || rightScope === "viewer") &&
    (commands.includes("nextDocument") || commands.includes("previousDocument") || commands.includes("settings"));
}

export function shortcutConflicts(bindings: Bindings, command: Command, key: string) {
  return commandNames.filter((other) => other !== command && bindings[other].includes(key) && shortcutScopesOverlap(other, command));
}

export function assignShortcut(bindings: Bindings, command: Command, key: string, replacing?: string): Bindings {
  const next = { ...bindings };
  for (const other of shortcutConflicts(bindings, command, key)) next[other] = bindings[other].filter((binding) => binding !== key);
  if (!bindings[command].includes(key)) {
    next[command] = replacing ? bindings[command].map((binding) => binding === replacing ? key : binding) : [...bindings[command], key];
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
  actionButtonWidth: ActionButtonWidth;
  mainMenuAlignment: MenuPosition;
  systemLightScheme: string;
  systemDarkScheme: string;
  showTitlebarScheme: boolean;
  activeScheme: string | null;
  schemes: Scheme[];
  hidden: boolean;
  refreshEnvironment: boolean;
  provider: Provider;
  kswitcher: string;
  activeShortcutScheme: string | null;
  shortcutSchemes: ShortcutScheme[];
  viewFontSizes: ViewFontSizes;
  viewerContentWidth?: number;
  terminalResizeRows: number;
}

export const minViewerContentWidth = 320;
export const maxViewerContentWidth = 2400;
export const maxTerminalResizeRows = 50;

export const preferenceKey = "dirlume.preferences.v1";
const mac = /Mac/i.test(navigator.userAgent);
const metaKeyLabel = windowsClient ? "Win" : /Linux/i.test(navigator.userAgent) ? "Super" : "Meta";
export const commandNames = Object.keys(commands) as Command[];
export const wheelBindings = ["Ctrl+Wheel", "Meta+Wheel", "Alt+Wheel", "Shift+Wheel"];
export const defaultBindings = Object.fromEntries<readonly string[]>(commandNames.map((command) => {
  const key = mac && command !== "settings" && command !== "nextDocument" && command !== "previousDocument" && command !== "zoomFont" &&
    command !== "expandTerminal" && command !== "collapseTerminal" &&
    command !== "addFolderShortcut" && !folderGroupCommand(command) && commandScope(command) !== "folderPicker"
    ? commands[command].key.replace(/^Ctrl\+/, "Meta+") : commands[command].key;
  return [command, [key, alternateDefaults[command]?.key].filter((value): value is string => Boolean(value))];
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
      { command, key: configuredAlternate ? alternateValue : alternate?.key, configured: configuredAlternate },
    ];
  });
  const accepted = new Set<(typeof candidates)[number]>();
  const owners = new Map<string, Command[]>();
  // Existing choices take precedence over newly introduced defaults.
  for (const binding of [...candidates.filter(({ configured }) => configured), ...candidates.filter(({ configured }) => !configured)]) {
    const { command, key } = binding;
    if (!key || (command === "zoomFont" && !wheelBindings.includes(key))) continue;
    const previous = owners.get(key) ?? [];
    if (previous.some((other) => shortcutScopesOverlap(other, command))) continue;
    accepted.add(binding);
    owners.set(key, [...previous, command]);
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

export function readPreferences(): Preferences {
  const defaults: Preferences = {
    theme: "system", layout: "standard", actionButtonWidth: "compact", activeScheme: null, schemes: [], provider: "server", hidden: false, refreshEnvironment: true, kswitcher: "",
    mainMenuAlignment: "center", activeShortcutScheme: null, shortcutSchemes: [],
    viewFontSizes: {}, language: "en", systemLightScheme: "light", systemDarkScheme: "dark", showTitlebarScheme: false,
    terminalResizeRows: 1,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? "null") as
      (Partial<Preferences> & { menuPosition?: unknown; shortcuts?: Record<string, unknown>; bindingDefaults?: number }) | null;
    if (!saved) return defaults;
    const schemes = readSchemes(saved.schemes);
    const bindingVersion = saved.bindingDefaults ?? 0;
    const shortcutSchemes = readShortcutSchemes(saved.shortcutSchemes, bindingVersion);
    let activeShortcutScheme = shortcutSchemes.find(({ id }) => id === saved.activeShortcutScheme)?.id ?? null;
    if (!Array.isArray(saved.shortcutSchemes) && saved.shortcuts) {
      const bindings = readBindings(saved.shortcuts, bindingVersion);
      if (commandNames.some((command) => bindings[command].length !== defaultBindings[command].length ||
          bindings[command].some((key, index) => key !== defaultBindings[command][index]))) {
        activeShortcutScheme = "my-shortcuts";
        shortcutSchemes.push({ id: activeShortcutScheme, name: "My shortcuts", bindings });
      }
    }
    const viewFontSizes: ViewFontSizes = {};
    for (const view of viewFontKeys) {
      const size = saved.viewFontSizes?.[view];
      if (validViewFontSize(size)) viewFontSizes[view] = size;
    }
    return {
      language: readLanguage(saved.language),
      theme: readTheme(saved.theme),
      layout: typeof saved.layout === "string" && Object.hasOwn(panelLayouts, saved.layout) ? saved.layout as PanelLayout : "standard",
      actionButtonWidth: saved.actionButtonWidth === "full" || saved.actionButtonWidth === "compact"
        ? saved.actionButtonWidth : defaults.actionButtonWidth,
      mainMenuAlignment: readMenuAlignment(saved.mainMenuAlignment) ?? readMenuAlignment(saved.menuPosition) ?? defaults.mainMenuAlignment,
      systemLightScheme: readSystemScheme(saved.systemLightScheme, schemes, "light"),
      systemDarkScheme: readSystemScheme(saved.systemDarkScheme, schemes, "dark"),
      showTitlebarScheme: saved.showTitlebarScheme === true,
      activeScheme: schemes.find(({ id }) => id === saved.activeScheme)?.id ?? null,
      schemes,
      provider: saved.provider === "kswitcher" ? "kswitcher" : "server",
      hidden: saved.hidden === true,
      refreshEnvironment: saved.refreshEnvironment !== false,
      kswitcher: typeof saved.kswitcher === "string" ? saved.kswitcher : "",
      activeShortcutScheme,
      shortcutSchemes,
      viewFontSizes,
      terminalResizeRows: typeof saved.terminalResizeRows === "number" && Number.isInteger(saved.terminalResizeRows) &&
        saved.terminalResizeRows >= 1 && saved.terminalResizeRows <= maxTerminalResizeRows ? saved.terminalResizeRows : 1,
      viewerContentWidth: typeof saved.viewerContentWidth === "number" && Number.isInteger(saved.viewerContentWidth) &&
        saved.viewerContentWidth >= minViewerContentWidth && saved.viewerContentWidth <= maxViewerContentWidth ? saved.viewerContentWidth : undefined,
    };
  } catch (error) {
    reportFrontendError("load_preferences", error);
    return defaults;
  }
}

export function persistPreferences(preferences: Preferences) {
  localStorage.setItem(preferenceKey, JSON.stringify({ ...preferences, bindingDefaults: 6 }));
}

export function eventShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }, key = event.key) {
  const { ctrlKey, metaKey, altKey, shiftKey } = event;
  if (["Control", "Meta", "Alt", "Shift", "Unidentified", "Dead", "Process"].includes(key)) return "";
  return [
    ...(ctrlKey ? ["Ctrl"] : []),
    ...(metaKey ? ["Meta"] : []),
    ...(altKey ? ["Alt"] : []),
    ...(shiftKey ? ["Shift"] : []),
    key === " " ? "Space" : key.length === 1 ? key.toUpperCase() : key,
  ].join("+");
}

export function physicalFolderBinding(event: KeyboardEvent, shortcuts: Bindings): FolderGroupCommand | undefined {
  if (!event.ctrlKey || event.metaKey || event.altKey || event.getModifierState("AltGraph") || !/^Digit[0-9]$/.test(event.code)) return;
  const command = `${event.shiftKey ? "addFolderGroup" : "openFolderGroup"}${event.code.at(-1)}` as FolderGroupCommand;
  if (shortcuts[command].includes(defaultBindings[command][0])) return command;
}

export function quickSearchSeed(event: KeyboardEvent, bindings: readonly string[]): string | null {
  const shortcut = eventShortcut(event);
  if (shortcut && bindings.includes(shortcut)) return "";
  if (!bindings.includes("Alt+Letter")) return null;
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (Array.from(event.key).length === 1 && /\p{L}/u.test(event.key)) return event.key;
  // Option on macOS can emit a symbol or dead key for a physical letter key.
  if (mac && /^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
  return null;
}

export function wheelShortcut(event: WheelEvent) {
  return eventShortcut({ key: "Wheel", ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey });
}

const arrows: Record<string, string> = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };

export function showShortcut(shortcut = "") {
  const readable = shortcut.replace(/\bArrow(?:Left|Right|Up|Down)\b/g, (key) => arrows[key]);
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
