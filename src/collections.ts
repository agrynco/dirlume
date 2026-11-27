import { mountedSmbPath, windowsClient, type Entry, type TextPlace } from "./api";

type Origin =
  | { kind: "local"; path: string }
  | { kind: "archive"; path: string; segments: string[] }
  | { kind: "ftp" | "ssh"; profileId: string; address: string; segments: string[] }
  | { kind: "server"; share: string; profileId?: string; address: string; segments: string[] }
  | { kind: "kswitcher"; peer: string; address: string; path: string };

export type CollectionReference = {
  kind: "reference";
  id: string;
  name: string;
  directory: boolean;
  origin: Origin;
};
export type CollectionFolder = {
  kind: "folder";
  id: string;
  name: string;
  children: CollectionEntry[];
};
export type CollectionEntry = CollectionFolder | CollectionReference;

const storageKey = "dirlume.collections.v1";

export function readCollections(): CollectionFolder[] {
  const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
  if (!Array.isArray(stored) || !stored.every(isCollectionFolder)) throw new Error("Invalid saved collections.");
  return stored;
}

export function persistCollections(collections: CollectionFolder[]) {
  localStorage.setItem(storageKey, JSON.stringify(collections));
}

function isCollectionFolder(value: unknown): value is CollectionFolder {
  if (!value || typeof value !== "object") return false;
  const folder = value as Partial<CollectionFolder>;
  return folder.kind === "folder" && typeof folder.id === "string" && typeof folder.name === "string" &&
    Array.isArray(folder.children) && folder.children.every((entry: unknown) => isCollectionFolder(entry) || isCollectionReference(entry));
}

function isCollectionReference(value: unknown): value is CollectionReference {
  if (!value || typeof value !== "object") return false;
  const reference = value as Partial<CollectionReference>;
  if (reference.kind !== "reference" || typeof reference.id !== "string" ||
    typeof reference.name !== "string" || typeof reference.directory !== "boolean") return false;
  const origin = reference.origin;
  if (!origin || typeof origin !== "object") return false;
  switch (origin.kind) {
    case "local": return typeof origin.path === "string";
    case "archive": return typeof origin.path === "string" && validSegments(origin.segments);
    case "ftp":
    case "ssh": return typeof origin.profileId === "string" && typeof origin.address === "string" && validSegments(origin.segments);
    case "server": return typeof origin.share === "string" && typeof origin.address === "string" &&
      (origin.profileId === undefined || typeof origin.profileId === "string") && validSegments(origin.segments);
    case "kswitcher": return typeof origin.peer === "string" && typeof origin.address === "string" && typeof origin.path === "string";
    default: return false;
  }
}

function validSegments(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((part) => typeof part === "string" && !!part &&
    part !== "." && part !== ".." && !part.includes("/") && !part.includes("\0"));
}

export function collectionName(siblings: CollectionEntry[], value: string, except?: string) {
  const name = value.trim();
  if (!name || name === "." || name === ".." || /[/\\\u0000-\u001f]/.test(name)) {
    throw new Error("Enter a valid name.");
  }
  if (siblings.some((item) => item.kind === "folder" && item.id !== except &&
    item.name.toLowerCase() === name.toLowerCase())) throw new Error("A folder with this name already exists here.");
  return name;
}

export function createCollectionFolder(siblings: CollectionEntry[], value: string): CollectionFolder {
  return { kind: "folder", id: crypto.randomUUID(), name: collectionName(siblings, value), children: [] };
}

export function collectionReference(place: TextPlace, entry: Pick<Entry, "name" | "directory">): CollectionReference {
  const origin: Origin = (() => {
    switch (place.kind) {
      case "local": return { kind: "local", path: place.smb ? mountedSmbPath(place.path, place.smb) : place.path };
      case "archive": return { kind: "archive", path: place.path, segments: place.segments };
      case "ftp":
      case "ssh": return { kind: place.kind, profileId: place.profileId, address: place.address, segments: place.segments };
      case "server": return { kind: "server", share: place.share, profileId: place.profileId, address: place.address, segments: place.segments };
      case "kswitcher": return { kind: "kswitcher", peer: place.peer, address: place.address, path: place.path };
    }
  })();
  return { kind: "reference", id: crypto.randomUUID(), name: entry.name, directory: entry.directory, origin };
}

function referenceKey(reference: CollectionReference) {
  const { origin, name } = reference;
  switch (origin.kind) {
    case "local": return windowsClient
      ? JSON.stringify([origin.kind, origin.path.toLowerCase(), name.toLowerCase()])
      : JSON.stringify([origin.kind, origin.path, name]);
    case "archive": return JSON.stringify([origin.kind, origin.path, origin.segments, name]);
    case "ftp":
    case "ssh": return JSON.stringify([origin.kind, origin.profileId, origin.segments, name]);
    case "server": return JSON.stringify([origin.kind, origin.profileId, origin.share, origin.segments, name]);
    case "kswitcher": return JSON.stringify([origin.kind, origin.peer, origin.path.toLowerCase(), name.toLowerCase()]);
  }
}

export function addCollectionReferences(folder: CollectionFolder, references: CollectionReference[]): CollectionFolder {
  const keys = new Set(folder.children.filter((entry) => entry.kind === "reference").map(referenceKey));
  const added: CollectionReference[] = [];
  for (const reference of references) {
    const key = referenceKey(reference);
    if (keys.has(key)) continue;
    keys.add(key);
    added.push(reference);
  }
  return added.length ? { ...folder, children: [...folder.children, ...added] } : folder;
}
