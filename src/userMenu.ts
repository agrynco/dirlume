export type MenuVisibility = "always" | "selection" | "file" | "folder";
export type MenuPrompt = { name: string; label: string; initial: string };
export type MenuEntry =
  | { kind: "command"; label: string; hotkey: string; visibility: MenuVisibility; mask: string; steps: string[]; prompts: MenuPrompt[] }
  | { kind: "submenu"; label: string; hotkey: string; children: MenuEntry[] }
  | { kind: "separator" };
export type MenuSource = { path: string; personal: boolean; writable: boolean; revision: string | null; approved: boolean;
  entries: MenuEntry[]; error: string | null };
export type MenuSourceVersion = Pick<MenuSource, "path" | "revision"> & { folder: string };
export type MenuContext = { folder: string; opposite: string | null;
  focused: { path: string; name: string; directory: boolean } | null; marked: string[] };
export type MenuRun = { source: MenuSourceVersion; index: number[]; opposite: string | null; focused: string | null;
  marked: string[]; inputs: Record<string, string> };

export const menuTokens = ["activeFolder", "oppositeFolder", "focusedName", "focusedPath", "focusedStem", "focusedExtension", "markedPaths"];

export function menuValues(context: MenuContext, inputs: Record<string, string> = {}) {
  const values: Record<string, string[]> = Object.create(null);
  values.activeFolder = [context.folder];
  if (context.opposite) values.oppositeFolder = [context.opposite];
  if (context.focused) {
    const { name, path } = context.focused;
    const dot = name.lastIndexOf(".");
    values.focusedName = [name];
    values.focusedPath = [path];
    values.focusedStem = [dot <= 0 ? name : name.slice(0, dot)];
    values.focusedExtension = [dot <= 0 ? "" : name.slice(dot + 1)];
  }
  if (context.marked.length) values.markedPaths = context.marked;
  for (const [key, value] of Object.entries(inputs)) values[`prompt:${key}`] = [value];
  return values;
}

export function menuPreview(template: string, values: Record<string, string[]>, command = false) {
  const missing: string[] = [];
  const text = template.replace(/\{\{([^{}]*)\}\}/g, (token, name: string) => {
    const valuesForToken = values[name.trim()];
    if (!valuesForToken) {
      missing.push(token);
      return token;
    }
    return valuesForToken.map((value) => command ? JSON.stringify(value) : value).join(" ");
  });
  if (template.replace(/\{\{[^{}]*\}\}/g, "").includes("{{")) missing.push("{{");
  return { text, missing };
}

export function menuVisible(entry: MenuEntry, context: MenuContext, windows: boolean) {
  if (entry.kind !== "command" || entry.visibility === "always") return true;
  if (entry.visibility === "selection") return context.marked.length > 0;
  const focused = context.focused;
  if (!focused || focused.directory !== (entry.visibility === "folder")) return false;
  if (!entry.mask) return true;
  const mask = Array.from(windows ? entry.mask.toLowerCase() : entry.mask);
  const name = Array.from(windows ? focused.name.toLowerCase() : focused.name);
  let position = 0, token = 0, star = -1, suffix = 0;
  while (position < name.length) {
    if (mask[token] === "*") { star = token++; suffix = position; }
    else if (mask[token] === "?" || mask[token] === name[position]) { token++; position++; }
    else if (star >= 0) { token = star + 1; position = ++suffix; }
    else return false;
  }
  return mask.slice(token).every((part) => part === "*");
}

export function menuLevel(entries: MenuEntry[], path: number[]): MenuEntry[] {
  for (const index of path) {
    const entry = entries[index];
    if (entry?.kind !== "submenu") return [];
    entries = entry.children;
  }
  return entries;
}

export function changeMenuLevel(entries: MenuEntry[], path: number[], change: (level: MenuEntry[]) => MenuEntry[]): MenuEntry[] {
  if (!path.length) return change(entries);
  const [first, ...rest] = path;
  return entries.map((entry, index) => index === first && entry.kind === "submenu"
    ? { ...entry, children: changeMenuLevel(entry.children, rest, change) } : entry);
}
