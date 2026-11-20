import { isFileServer, placePath, windowsClient, type KSwitcherPeer, type Place } from "./api";

export const folderGroups = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type FolderGroup = typeof folderGroups[number];
export interface FolderShortcut {
  title: string;
  path: string;
  peer?: KSwitcherPeer;
  remote?: { kind: "ftp" | "ssh" | "server"; id: string; name: string };
}
export type FolderShortcuts = FolderShortcut[][];

const storageKey = "dirlume.folder-shortcuts.v1";

export function normalizeFolderPath(path: string, paired: boolean, remote = false): string | null {
  if (path.includes("\0")) return null;
  if (remote) {
    if (!path.startsWith("/")) return null;
    const segments = path.split("/").filter(Boolean);
    if (segments.some((part) => part === "." || part === "..")) return null;
    return "/" + segments.join("/");
  }
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
  if (isFileServer(place) || place?.kind === "server") {
    return {
      title: "", path: placePath(place),
      remote: { kind: place.kind, id: place.kind === "server" ? place.share : place.profileId, name: place.address },
    };
  }
  if (place?.kind === "kswitcher" && place.path) {
    return { title: "", path: place.path, peer: { id: place.peer, name: place.address } };
  }
}

export function sameFolderShortcut(a: FolderShortcut, b: FolderShortcut) {
  if (a.peer?.id !== b.peer?.id || a.remote?.kind !== b.remote?.kind || a.remote?.id !== b.remote?.id) return false;
  const left = normalizeFolderPath(a.path, !!a.peer, !!a.remote);
  const right = normalizeFolderPath(b.path, !!b.peer, !!b.remote);
  return left !== null && right !== null &&
    (!a.remote && (windowsClient || a.peer) ? left.toLowerCase() === right.toLowerCase() : left === right);
}

function savedShortcut(value: unknown): FolderShortcut | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<FolderShortcut>;
  if (typeof item.title !== "string" || typeof item.path !== "string") return null;
  const { peer, remote } = item;
  if (peer !== undefined && (!peer || typeof peer.id !== "string" || !peer.id || typeof peer.name !== "string")) return null;
  if (remote !== undefined && (!remote || peer || !["ssh", "ftp", "server"].includes(remote.kind) ||
      typeof remote.id !== "string" || !remote.id || typeof remote.name !== "string")) return null;
  const path = normalizeFolderPath(item.path, !!peer, !!remote);
  return path ? { title: item.title, path, peer, remote } : null;
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
