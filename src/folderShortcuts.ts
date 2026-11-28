import { isFileServer, mountedSmbPath, placePath, smbHost, windowsClient, type GoogleDrivePlace, type KSwitcherPeer, type Place } from "./api";
import type { RecentLocation } from "./recentLocations";

export const folderGroups = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type FolderGroup = typeof folderGroups[number];
export type FolderShortcutLocation =
  | { kind: "smb"; url: string }
  | { kind: "archive"; file: string; segments: string[] }
  | { kind: "googleDrive"; id: string; account: string; folders: GoogleDrivePlace["folders"] }
  | { kind: "lan"; peer: string; name: string; segments: string[] }
  | { kind: "collection"; folders: string[] };
export interface FolderShortcut {
  title: string;
  path: string;
  peer?: KSwitcherPeer;
  remote?: { kind: "ftp" | "ssh" | "server"; id: string; name: string; profileId?: string };
  location?: FolderShortcutLocation;
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
  if (place?.kind === "local") {
    const url = place.smb ? mountedSmbPath(place.path, place.smb) : smbHost(place) ? place.path : undefined;
    return url ? { title: "", path: url, location: { kind: "smb", url } } : { title: "", path: place.path };
  }
  if (place?.kind === "archive") return { title: "", path: placePath(place),
    location: { kind: "archive", file: place.path, segments: place.segments } };
  if (place?.kind === "googleDrive") {
    const account = place.email ?? place.address;
    return { title: "", path: `${account} · ${placePath(place)}`,
      location: { kind: "googleDrive", id: place.id, account, folders: place.folders } };
  }
  if (place?.kind === "server" && place.groupPeer) return { title: "", path: `${place.address} · ${placePath(place)}`,
    location: { kind: "lan", peer: place.groupPeer, name: place.address, segments: place.segments } };
  if (isFileServer(place) || place?.kind === "server") {
    return {
      title: "", path: placePath(place),
      remote: { kind: place.kind, id: place.kind === "server" ? place.share : place.profileId, name: place.address,
        profileId: place.kind === "server" ? place.profileId : undefined },
    };
  }
  if (place?.kind === "kswitcher" && place.path) {
    return { title: "", path: place.path, peer: { id: place.peer, name: place.address } };
  }
}

export function shortcutFromRecent(location: RecentLocation): FolderShortcut {
  const { kind, source } = location;
  if (kind === "smb" && "path" in location) return { title: "", path: location.path, location: { kind, url: location.path } };
  if (kind === "kswitcher") return { title: "", path: location.path, peer: { id: location.peer, name: source } };
  if ("path" in location) return { title: "", path: location.path };
  return { title: "", path: "/" + location.segments.join("/"),
    remote: { kind: location.kind, id: location.profileId, name: source,
      profileId: location.kind === "server" ? location.profileId : undefined } };
}

function locationIdentity(location: FolderShortcutLocation) {
  switch (location.kind) {
    case "smb": return [location.kind, location.url.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()];
    case "archive": return [location.kind, windowsClient ? location.file.toLowerCase() : location.file, location.segments];
    case "googleDrive": return [location.kind, location.id, location.folders.at(-1)?.id ?? "root"];
    case "lan": return [location.kind, location.peer, location.segments];
    case "collection": return [location.kind, location.folders];
  }
}

export function folderShortcutKey(entry: FolderShortcut) {
  if (entry.location) return JSON.stringify(locationIdentity(entry.location));
  const path = normalizeFolderPath(entry.path, !!entry.peer, !!entry.remote);
  return JSON.stringify([entry.peer?.id, entry.remote?.kind, entry.remote?.id,
    !entry.remote && (windowsClient || entry.peer) ? path?.toLowerCase() : path]);
}

export function sameFolderShortcut(a: FolderShortcut, b: FolderShortcut) {
  return folderShortcutKey(a) === folderShortcutKey(b);
}

function readLocation(value: unknown): FolderShortcutLocation | undefined {
  if (!value || typeof value !== "object") return;
  const fields = value as Record<string, unknown>;
  const identifier = (value: unknown): value is string => typeof value === "string" && !!value && !value.includes("\0");
  const components = (value: unknown): value is string[] => Array.isArray(value) && value.every((part) =>
    identifier(part) && part !== "." && part !== ".." && !part.includes("/"));
  const { kind, url, file, segments, id, account, folders, peer, name } = fields;
  switch (kind) {
    case "smb": if (identifier(url) && /^(smb:\/\/[^/@]+\/|\\\\[^\\@]+\\)/i.test(url)) return { kind, url }; break;
    case "archive": if (identifier(file) && normalizeFolderPath(file, false) && components(segments)) return { kind, file, segments }; break;
    case "googleDrive": if (identifier(id) && identifier(account) && Array.isArray(folders) &&
      folders.every((folder) => folder && identifier(folder.id) && identifier(folder.name))) {
      return { kind, id, account, folders: folders.map(({ id, name }) => ({ id, name })) };
    } break;
    case "lan": if (identifier(peer) && identifier(name) && components(segments) && segments.length) return { kind, peer, name, segments }; break;
    case "collection": if (components(folders)) return { kind, folders }; break;
  }
}

function savedShortcut(value: unknown): FolderShortcut | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<FolderShortcut>;
  if (typeof item.title !== "string" || typeof item.path !== "string") return null;
  const { peer, remote } = item;
  if (item.location !== undefined) {
    const location = readLocation(item.location);
    return location && !peer && !remote ? { title: item.title, path: item.path, location } : null;
  }
  if (peer !== undefined && (!peer || typeof peer.id !== "string" || !peer.id || typeof peer.name !== "string")) return null;
  if (remote !== undefined && (!remote || peer || !["ssh", "ftp", "server"].includes(remote.kind) ||
      typeof remote.id !== "string" || !remote.id || typeof remote.name !== "string" ||
      (remote.profileId !== undefined && typeof remote.profileId !== "string"))) return null;
  const path = normalizeFolderPath(item.path, !!peer, !!remote);
  return path ? { title: item.title, path,
    peer: peer && { id: peer.id, name: peer.name },
    remote: remote && { kind: remote.kind, id: remote.id, name: remote.name, profileId: remote.profileId } } : null;
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
