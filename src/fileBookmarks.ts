import { documentPath, smbHost, windowsClient, type NamedFile } from "./api";
import { localPath } from "./panes";

const storageKey = "dirlume.file-bookmarks.v1";
export const maxBookmarkNameLength = 100;

export type FileBookmark = { path: string; line: number; fingerprint: string; name?: string };
export type BookmarkJump = { line: number; fingerprint: string; request: number };
export type BookmarkResult = { request: number; requested: number; shown: number; changed: boolean };

export function bookmarkPath(file: NamedFile) {
  return file.place.kind === "local" && !smbHost(file.place) ? documentPath(file) : null;
}

export function bookmarkKey(path: string, line?: number) {
  const normalized = windowsClient ? path.replaceAll("/", "\\").toLowerCase() : path;
  return JSON.stringify([normalized, line]);
}

export function bookmarkFile(path: string): NamedFile | null {
  const end = windowsClient ? Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) : path.lastIndexOf("/");
  if (end < 0 || end === path.length - 1 || !(windowsClient ? /^[a-z]:[\\/]/i.test(path) : path.startsWith("/"))) return null;
  const directory = path.slice(0, end === 0 || windowsClient && end === 2 ? end + 1 : end);
  return { place: localPath(directory), name: path.slice(end + 1) };
}

export function lineFingerprint(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return `${text.length}:${hash >>> 0}`;
}

export function readFileBookmarks(): FileBookmark[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    if (!Array.isArray(stored)) return [];
    const unique = new Map<string, FileBookmark>();
    for (const item of stored) {
      if (typeof item?.path !== "string" || !bookmarkFile(item.path) || !Number.isSafeInteger(item.line) || item.line < 1 ||
          typeof item.fingerprint !== "string" || !/^\d+:\d+$/.test(item.fingerprint)) continue;
      unique.set(bookmarkKey(item.path, item.line), { path: item.path, line: item.line, fingerprint: item.fingerprint,
        name: typeof item.name === "string" ? item.name.trim().slice(0, maxBookmarkNameLength) || undefined : undefined });
    }
    return [...unique.values()];
  } catch { return []; }
}

export function saveFileBookmarks(bookmarks: readonly FileBookmark[]) {
  localStorage.setItem(storageKey, JSON.stringify(bookmarks));
}
