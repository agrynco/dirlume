export const commands = {
  switchPane: { label: "Switch pane", key: "Tab" },
  swap: { label: "Swap panes", key: "Ctrl+U" },
  upRow: { label: "Previous item", key: "ArrowUp" },
  downRow: { label: "Next item", key: "ArrowDown" },
  firstRow: { label: "First item", key: "Home" },
  lastRow: { label: "Last item", key: "End" },
  pageUp: { label: "Previous page", key: "PageUp" },
  pageDown: { label: "Next page", key: "PageDown" },
  mark: { label: "Mark or unmark item", key: "Space" },
  open: { label: "Open", key: "Enter" },
  parent: { label: "Parent folder", key: "Backspace" },
  back: { label: "Back", key: "Alt+ArrowLeft" },
  forward: { label: "Forward", key: "Alt+ArrowRight" },
  address: { label: "Go to path", key: "Ctrl+L" },
  refresh: { label: "Refresh", key: "Ctrl+R" },
  filter: { label: "Filter folder", key: "Ctrl+F" },
  hidden: { label: "Show or hide hidden files", key: "Ctrl+H" },
  rename: { label: "Rename", key: "F2" },
  view: { label: "View text", key: "F3" },
  edit: { label: "Edit text", key: "F4" },
  copy: { label: "Copy", key: "F5" },
  move: { label: "Move", key: "F6" },
  mkdir: { label: "New folder", key: "F7" },
  recycle: { label: "Move to Trash", key: "F8" },
  compare: { label: "Compare files", key: "Shift+F11" },
  connect: { label: "Connect to a remote machine", key: "Ctrl+Shift+K" },
  settings: { label: "Options", key: "Ctrl+," },
  saveText: { label: "Save text", key: "Ctrl+S" },
  previousChange: { label: "Previous difference", key: "Alt+ArrowUp" },
  nextChange: { label: "Next difference", key: "Alt+ArrowDown" },
} as const;

export type Command = keyof typeof commands;
export type Bindings = Record<Command, string>;
export type Theme = "system" | "dark" | "light" | "slate";
export type Provider = "server" | "kswitcher";

export interface Preferences {
  theme: Theme;
  hidden: boolean;
  provider: Provider;
  kswitcher: string;
  shortcuts: Bindings;
}

const preferenceKey = "dirlume.preferences.v1";
export const commandNames = Object.keys(commands) as Command[];
export const defaultBindings = Object.fromEntries(
  commandNames.map((command) => [command, commands[command].key]),
) as Bindings;

export function readPreferences(): Preferences {
  const defaults: Preferences = {
    theme: "system", provider: "server", hidden: false, kswitcher: "", shortcuts: defaultBindings,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? "null") as Partial<Preferences> | null;
    if (!saved) return defaults;
    const shortcuts = { ...defaultBindings };
    for (const command of commandNames) {
      const value = saved.shortcuts?.[command];
      if (typeof value === "string") shortcuts[command] = value;
    }
    const enabled = Object.values(shortcuts).filter(Boolean);
    return {
      theme: saved.theme === "dark" || saved.theme === "light" || saved.theme === "slate" ? saved.theme : "system",
      provider: saved.provider === "kswitcher" ? "kswitcher" : "server",
      hidden: saved.hidden === true,
      kswitcher: typeof saved.kswitcher === "string" ? saved.kswitcher : "",
      shortcuts: new Set(enabled).size === enabled.length ? shortcuts : defaultBindings,
    };
  } catch {
    return defaults;
  }
}

export function persistPreferences(preferences: Preferences) {
  localStorage.setItem(preferenceKey, JSON.stringify(preferences));
}

export function eventShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }) {
  const { key, ctrlKey, metaKey, altKey, shiftKey } = event;
  if (["Control", "Meta", "Alt", "Shift", "Unidentified", "Dead", "Process"].includes(key)) return "";
  return [
    ...(ctrlKey || metaKey ? ["Ctrl"] : []),
    ...(altKey ? ["Alt"] : []),
    ...(shiftKey ? ["Shift"] : []),
    key === " " ? "Space" : key.length === 1 ? key.toUpperCase() : key,
  ].join("+");
}

export function showShortcut(shortcut: string) {
  if (/Mac/i.test(navigator.userAgent)) return shortcut.replaceAll("Ctrl", "⌘").replaceAll("Alt", "⌥");
  return shortcut;
}
