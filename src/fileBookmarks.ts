import { documentPath, smbHost, windowsClient, type NamedFile } from "./api";
import { localPath } from "./panes";

const storageKey = "dirlume.file-bookmarks.v1";
export const maxBookmarkNameLength = 100;

export type MarkdownAnchor = { quote: string; before: string; after: string; offset: number };
type LineReference = { line: number; fingerprint: string };
export type FileBookmark = { path: string; name?: string } & (LineReference | { anchor: MarkdownAnchor });
export type LineBookmarkJump = LineReference & { request: number };
export type BookmarkJump = LineBookmarkJump | { anchor: MarkdownAnchor; request: number };
export type BookmarkResult = { request: number; requested: number; shown: number; changed: boolean };

export function bookmarkPath(file: NamedFile) {
  return file.place.kind === "local" && !smbHost(file.place) ? documentPath(file) : null;
}

export function bookmarkKey(path: string, line?: number) {
  const normalized = windowsClient ? path.replaceAll("/", "\\").toLowerCase() : path;
  return JSON.stringify([normalized, line]);
}

export function fileBookmarkKey(bookmark: FileBookmark) {
  if ("line" in bookmark) return bookmarkKey(bookmark.path, bookmark.line);
  const { quote, before, after, offset } = bookmark.anchor;
  return JSON.stringify([bookmarkKey(bookmark.path), quote, before, after, offset]);
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
      if (typeof item?.path !== "string" || !bookmarkFile(item.path)) continue;
      const name = typeof item.name === "string" ? item.name.trim().slice(0, maxBookmarkNameLength) || undefined : undefined;
      const anchor = item.anchor;
      let bookmark: FileBookmark;
      if (anchor && typeof anchor.quote === "string" && anchor.quote.trim() &&
          typeof anchor.before === "string" && typeof anchor.after === "string" &&
          Number.isSafeInteger(anchor.offset) && anchor.offset >= 0) {
        const { quote, before, after, offset } = anchor;
        bookmark = { path: item.path, name, anchor: { quote, before, after, offset } };
      } else if (Number.isSafeInteger(item.line) && item.line > 0 &&
          typeof item.fingerprint === "string" && /^\d+:\d+$/.test(item.fingerprint)) {
        bookmark = { path: item.path, name, line: item.line, fingerprint: item.fingerprint };
      } else continue;
      unique.set(fileBookmarkKey(bookmark), bookmark);
    }
    return [...unique.values()];
  } catch { return []; }
}

export function saveFileBookmarks(bookmarks: readonly FileBookmark[]) {
  localStorage.setItem(storageKey, JSON.stringify(bookmarks));
}
