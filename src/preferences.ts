import { readSchemes, readTheme, type Scheme, type Theme } from "./appearance";
import { validViewFontSize, viewFontKeys, type ViewFontSizes } from "./viewFonts";
import { readLanguage, type Language } from "./i18n";

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
  parent: { label: "Parent folder", key: "Backspace" },
  back: { label: "Back", key: "Alt+ArrowLeft" },
  forward: { label: "Forward", key: "Alt+ArrowRight" },
  address: { label: "Go to path", key: "Ctrl+L" },
  refresh: { label: "Refresh", key: "Ctrl+R" },
  refreshAlternate: { label: "Refresh (alternate)", key: "F2" },
  filter: { label: "Filter folder", key: "" },
  quickSearch: { label: "Quick search by name prefix", key: "Alt+Letter" },
  hidden: { label: "Show or hide hidden files", key: "Ctrl+H" },
  rename: { label: "Rename", key: "" },
  view: { label: "View text or measure folder", key: "F3" },
  cancelMeasure: { label: "Clear command line or cancel folder size scan", key: "Escape" },
  edit: { label: "Edit text", key: "F4" },
  newFile: { label: "New file", key: "Shift+F4" },
  copy: { label: "Copy", key: "F5" },
  move: { label: "Move", key: "F6" },
  mkdir: { label: "New folder", key: "F7" },
  search: { label: "Find files", key: "Alt+F7" },
  copyClipboard: { label: "Copy files to clipboard", key: "Ctrl+C" },
  pasteClipboard: { label: "Paste files from clipboard", key: "Ctrl+V" },
  recycle: { label: "Move to Trash", key: "F8" },
  delete: { label: "Delete permanently", key: "Shift+Delete" },
  menu: { label: "Open commands menu", key: "F9" },
  close: { label: "Close main window", key: "F10" },
  leftLocations: { label: "Left pane sources", key: "Alt+F1" },
  rightLocations: { label: "Right pane sources", key: "Alt+F2" },
  shrinkLeft: { label: "Move pane divider left", key: "Ctrl+ArrowLeft" },
  growLeft: { label: "Move pane divider right", key: "Ctrl+ArrowRight" },
  zoomFont: { label: "Font zoom with mouse wheel", key: "Ctrl+Wheel" },
  compare: { label: "Compare files", key: "Shift+F11" },
  terminal: { label: "Show or hide file panels", key: "Ctrl+O" },
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
  saveTextAlternate: { label: "Save text (alternate)", key: "F2" },
  closeText: { label: "Close the viewer or editor", key: "F10" },
  cancelText: { label: "Exit the viewer or editor", key: "Escape" },
  previousChange: { label: "Previous difference", key: "F7" },
  nextChange: { label: "Next difference", key: "F8" },
  ftpSources: { label: "Select FTP in the sources menu", key: "1" },
  addFtpProfile: { label: "Add FTP connection", key: "Shift+F4" },
  editFtpProfile: { label: "Edit FTP connection", key: "F4" },
} as const;

export type Command = keyof typeof commands;
export type Bindings = Record<Command, string>;
export type Provider = "server" | "kswitcher";

export function commandScope(command: Command) {
  if (command === "help") return "global";
  if (command === "zoomFont") return "wheel";
  if (command === "ftpSources") return "sources";
  if (command === "addFtpProfile" || command === "editFtpProfile") return "ftp";
  if (command === "viewAsHex") return "viewer";
  if (command === "saveText" || command === "saveTextAlternate" || command === "closeText" || command === "cancelText") return "text";
  if (command === "previousChange" || command === "nextChange") return "compare";
  return "main";
}

export function shortcutScopesOverlap(left: Command, right: Command) {
  const leftScope = commandScope(left);
  const rightScope = commandScope(right);
  return leftScope === rightScope ||
    (leftScope !== "wheel" && rightScope !== "wheel" && (leftScope === "global" || rightScope === "global"));
}

export interface Preferences {
  language: Language;
  theme: Theme;
  activeScheme: string | null;
  schemes: Scheme[];
  hidden: boolean;
  provider: Provider;
  kswitcher: string;
  shortcuts: Bindings;
  viewFontSizes: ViewFontSizes;
}

const preferenceKey = "dirlume.preferences.v1";
const mac = /Mac/i.test(navigator.userAgent);
export const commandNames = Object.keys(commands) as Command[];
export const wheelBindings = ["Ctrl+Wheel", "Meta+Wheel", "Alt+Wheel", "Shift+Wheel"];
export const defaultBindings = Object.fromEntries(
  commandNames.map((command) => [command, mac && command !== "settings" && command !== "nextDocument" && command !== "previousDocument" && command !== "zoomFont"
    ? commands[command].key.replace(/^Ctrl\+/, "Meta+") : commands[command].key]),
) as Bindings;

export function readPreferences(): Preferences {
  const defaults: Preferences = {
    theme: "system", activeScheme: null, schemes: [], provider: "server", hidden: false, kswitcher: "", shortcuts: defaultBindings,
    viewFontSizes: {}, language: "en",
  };
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? "null") as (Partial<Preferences> & { bindingDefaults?: number }) | null;
    if (!saved) return defaults;
    const shortcuts = { ...defaultBindings };
    const oldDefaults: Partial<Bindings> = {
      firstRow: "Home", lastRow: "End", mark: "Space", rename: "F2",
      filter: mac ? "Meta+F" : "Ctrl+F", terminal: mac ? "Meta+`" : "Ctrl+`",
      previousChange: "Alt+ArrowUp", nextChange: "Alt+ArrowDown",
    };
    const configured = new Set<Command>();
    for (const command of commandNames) {
      const value = saved.shortcuts?.[command];
      if (typeof value !== "string" || (!saved.bindingDefaults && value === oldDefaults[command])) continue;
      if (command === "settings" && (saved.bindingDefaults ?? 0) < 3 && value === (mac ? "Meta+," : "Ctrl+,")) continue;
      shortcuts[command] = value;
      configured.add(command);
    }
    const enabled: Command[] = [];
    for (const command of [...configured, ...commandNames.filter((command) => !configured.has(command))]) {
      const value = shortcuts[command];
      if (!value) continue;
      if (enabled.some((other) => shortcuts[other] === value && shortcutScopesOverlap(other, command))) shortcuts[command] = "";
      else enabled.push(command);
    }
    const schemes = readSchemes(saved.schemes);
    const viewFontSizes: ViewFontSizes = {};
    for (const view of viewFontKeys) {
      const size = saved.viewFontSizes?.[view];
      if (validViewFontSize(size)) viewFontSizes[view] = size;
    }
    return {
      language: readLanguage(saved.language),
      theme: readTheme(saved.theme),
      activeScheme: schemes.find(({ id }) => id === saved.activeScheme)?.id ?? null,
      schemes,
      provider: saved.provider === "kswitcher" ? "kswitcher" : "server",
      hidden: saved.hidden === true,
      kswitcher: typeof saved.kswitcher === "string" ? saved.kswitcher : "",
      shortcuts,
      viewFontSizes,
    };
  } catch {
    return defaults;
  }
}

export function persistPreferences(preferences: Preferences) {
  localStorage.setItem(preferenceKey, JSON.stringify({ ...preferences, bindingDefaults: 3 }));
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

export function quickSearchSeed(event: KeyboardEvent, binding: string): string | null {
  if (!binding) return null;
  if (binding !== "Alt+Letter") return eventShortcut(event) === binding ? "" : null;
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (Array.from(event.key).length === 1 && /\p{L}/u.test(event.key)) return event.key;
  // Option on macOS can emit a symbol or dead key for a physical letter key.
  if (mac && /^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
  return null;
}

export function wheelShortcut(event: WheelEvent) {
  return eventShortcut({ key: "Wheel", ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey });
}

export function showShortcut(shortcut: string) {
  if (mac) return shortcut.replaceAll("Meta+", "⌘").replaceAll("Ctrl+", "⌃").replaceAll("Alt+", "⌥").replaceAll("Shift+", "⇧");
  return shortcut;
}
