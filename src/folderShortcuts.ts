import { windowsClient, type KSwitcherPeer, type Place } from "./api";

export const folderGroups = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type FolderGroup = typeof folderGroups[number];
export interface FolderShortcut {
  title: string;
  path: string;
  peer?: KSwitcherPeer;
}
export type FolderShortcuts = FolderShortcut[][];

const storageKey = "dirlume.folder-shortcuts.v1";

export function normalizeFolderPath(path: string, paired: boolean): string | null {
  if (path.includes("\0")) return null;
  const windows = paired || windowsClient;
  const separator = windows ? "\\" : "/";
  if (windows) {
    path = path.replaceAll("/", "\\")
      .replace(/^\\\\\?\\UNC\\/i, "\\\\")
      .replace(/^\\\\\?\\(?=[a-z]:\\)/i, "");
    if (/^\\\\[.?]\\/.test(path)) return null;
  }
  const root = windows
    ? /^[a-z]:\\/i.exec(path)?.[0] ?? (!paired ? /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.exec(path)?.[0] : undefined)
    : path.startsWith("/") ? "/" : undefined;
  if (!root) return null;
  const pieces: string[] = [];
  for (const part of path.slice(root.length).split(separator)) {
    if (part === "..") pieces.pop();
    else if (part && part !== ".") {
      if (windows && /[<>:"|?*\u0000-\u001f]|[. ]$/.test(part)) return null;
      pieces.push(part);
    }
  }
  if (!pieces.length) return windows && root.startsWith("\\\\") ? root.replace(/\\$/, "") : root;
  return root.endsWith(separator) ? root + pieces.join(separator) : root + separator + pieces.join(separator);
}

export function shortcutFromPlace(place: Place | null): FolderShortcut | undefined {
  if (place?.kind === "local") return { title: "", path: place.path };
  if (place?.kind === "kswitcher" && place.path) {
    return { title: "", path: place.path, peer: { id: place.peer, name: place.address } };
  }
}

export function sameFolderShortcut(a: FolderShortcut, b: FolderShortcut) {
  if (a.peer?.id !== b.peer?.id) return false;
  const left = normalizeFolderPath(a.path, !!a.peer);
  const right = normalizeFolderPath(b.path, !!b.peer);
  return left !== null && right !== null && (windowsClient || a.peer ? left.toLowerCase() === right.toLowerCase() : left === right);
}

function savedShortcut(value: unknown): FolderShortcut | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<FolderShortcut>;
  if (typeof item.title !== "string" || typeof item.path !== "string") return null;
  const { peer } = item;
  if (peer !== undefined && (!peer || typeof peer.id !== "string" || !peer.id || typeof peer.name !== "string")) return null;
  const path = normalizeFolderPath(item.path, !!peer);
  return path ? { title: item.title, path, ...(peer ? { peer } : {}) } : null;
}

export function readFolderShortcuts(): FolderShortcuts {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (Array.isArray(parsed)) {
      return folderGroups.map((digit) => {
        const group: unknown = parsed[digit];
        if (!Array.isArray(group)) return [];
        return group.map(savedShortcut).filter((item) => item !== null);
      });
    }
  } catch { /* Use empty groups when the saved state is unavailable. */ }
  return folderGroups.map(() => []);
}

export function persistFolderShortcuts(shortcuts: FolderShortcuts) {
  localStorage.setItem(storageKey, JSON.stringify(shortcuts));
}
