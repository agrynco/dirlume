import { api, connectFtpLocation, mountedSmbPath, smbLocation, windowsClient,
  type Entry, type FilePlace, type GoogleDrivePlace, type Listing, type TextPlace } from "./api";
import { readPlace } from "./panes";
import { readRemoteProfiles } from "./savedConnections";
import type { RecentLocation } from "./recentLocations";

type Origin =
  | { kind: "local"; path: string }
  | { kind: "archive"; path: string; segments: string[] }
  | { kind: "googleDrive"; profileId: string; account: string; item: string; folders: GoogleDrivePlace["folders"] }
  | { kind: "ftp" | "ssh"; profileId: string; address: string; segments: string[] }
  | { kind: "server"; share?: string; profileId?: string; groupPeer?: string; address: string; segments: string[] }
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

export function collectionContents(entries: readonly CollectionEntry[]) {
  const folders: string[][] = [];
  const references: { reference: CollectionReference; destination: string[] }[] = [];
  function visit(items: readonly CollectionEntry[], parent: string[]) {
    for (const item of items) {
      if (item.kind === "reference") references.push({ reference: item, destination: parent });
      else {
        const path = [...parent, item.name];
        folders.push(path);
        visit(item.children, path);
      }
    }
  }
  visit(entries, []);
  return { folders, references };
}

const storageKey = "dirlume.collections.v1";

function newId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function readCollections(): CollectionFolder[] {
  const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
  if (!Array.isArray(stored) || !stored.every(isCollectionFolder)) throw new Error("Invalid saved collections.");
  return stored;
}

export function persistCollections(collections: CollectionFolder[]) {
  localStorage.setItem(storageKey, JSON.stringify(collections));
}

export function collectionTrail(collections: CollectionEntry[], path: readonly string[]): CollectionFolder[] {
  const trail: CollectionFolder[] = [];
  let entries = collections;
  for (const id of path) {
    const folder = entries.find((entry): entry is CollectionFolder => entry.kind === "folder" && entry.id === id);
    if (!folder) break;
    trail.push(folder);
    entries = folder.children;
  }
  return trail;
}

export function editCollectionEntries(
  collections: CollectionFolder[], path: readonly string[], edit: (entries: CollectionEntry[]) => CollectionEntry[],
): CollectionFolder[] {
  function visit(entries: CollectionEntry[], depth: number): CollectionEntry[] {
    if (depth === path.length) return edit(entries);
    return entries.map((entry) => entry.kind === "folder" && entry.id === path[depth]
      ? { ...entry, children: visit(entry.children, depth + 1) } : entry);
  }
  return visit(collections, 0).filter((entry): entry is CollectionFolder => entry.kind === "folder");
}

export function collectionReferencePath({ origin, name }: CollectionReference) {
  switch (origin.kind) {
    case "local":
    case "kswitcher": return origin.path.replace(/[/\\]$/, "") +
      (origin.path.includes("\\") ? "\\" : "/") + name;
    case "archive": return origin.path + "!/" + [...origin.segments, name].join("/");
    case "googleDrive": return origin.account + ":/" + ["My Drive", ...origin.folders.map(({ name }) => name), name].join("/");
    default: return origin.address + " · /" + [...origin.segments, name].join("/");
  }
}

export async function resolveCollectionReference(
  reference: CollectionReference,
  bridgeDirectory: string,
  register: (place: TextPlace) => void,
  archivePassword?: string,
  activePlaces: readonly (FilePlace | null)[] = [],
) {
  const { origin, name } = reference;
  let place: TextPlace;
  let listing: Listing;
  switch (origin.kind) {
    case "googleDrive": {
      const profile = (await api.googleDriveProfiles()).find(({ id }) => id === origin.profileId);
      if (!profile || profile.signInNeeded) throw new Error("Reconnect the Google Drive account in the pane sources.");
      place = { kind: "googleDrive", id: profile.id, address: profile.label, email: profile.email, folders: origin.folders };
      listing = (await readPlace(place)).listing;
      break;
    }
    case "local": {
      if (/^smb:\/\//i.test(origin.path) || origin.path.startsWith("\\\\")) {
        const result = await api.connectSmb(origin.path, null, false);
        if (result.kind !== "opened") throw new Error("Reconnect to the SMB share before copying.");
        const connected = smbLocation(result);
        if (connected.place.kind !== "local") throw new Error("Open the SMB share before copying.");
        ({ place, listing } = { place: connected.place, listing: connected.listing });
      } else {
        const folder = await api.listLocal(origin.path);
        place = { kind: "local", path: folder.path, parent: folder.parent };
        listing = folder;
      }
      break;
    }
    case "ftp": {
      ({ place, listing } = await connectFtpLocation(origin.profileId, origin.segments));
      register(place);
      break;
    }
    case "ssh": {
      const result = await api.connectSsh(origin.profileId, undefined, origin.segments);
      if (result.kind === "verifyHost") throw new Error("Verify the host key in SSH connections before copying.");
      place = { kind: "ssh", id: result.id, profileId: origin.profileId, address: result.address,
        origin: result.origin, segments: result.segments };
      register(place);
      listing = result.listing;
      break;
    }
    case "server": {
      const active = activePlaces.find((item) => item?.kind === "server" &&
        (origin.profileId === undefined || item.profileId === origin.profileId) &&
        (origin.share === undefined || item.share === origin.share));
      if (active?.kind === "server") {
        place = { ...active, segments: origin.segments };
        listing = await api.listServer(active.id, origin.segments);
        break;
      }
      if (origin.groupPeer) {
        const result = await api.connectLanGroupPeer(origin.groupPeer, origin.segments);
        place = { kind: "server", id: result.id, share: result.share, address: origin.address, groupPeer: origin.groupPeer,
          origin: result.origin, segments: origin.segments, pairedComputer: true };
        register(place);
        listing = result.listing;
        if (origin.share && result.share !== origin.share) throw new Error("The Dirlume server share has changed.");
        break;
      }
      const profile = readRemoteProfiles().find((item) => item.kind === "server" && item.id === origin.profileId);
      if (profile?.kind !== "server") throw new Error("Reconnect to the Dirlume server before copying.");
      const result = await api.connectSavedServer(profile.credential, origin.segments);
      place = { kind: "server", id: result.id, share: result.share, profileId: profile.id, address: profile.label,
        origin: result.origin, segments: origin.segments, pairedComputer: profile.lan };
      register(place);
      listing = result.listing;
      if (origin.share && result.share !== origin.share) throw new Error("The Dirlume server share has changed.");
      break;
    }
    case "kswitcher": {
      listing = await api.listKSwitcher(bridgeDirectory, origin.peer, origin.path);
      place = { kind: "kswitcher", directory: bridgeDirectory, peer: origin.peer, address: origin.address, path: origin.path, parent: null };
      break;
    }
    case "archive": {
      const active = activePlaces.find((item) => item?.kind === "archive" && item.path === origin.path);
      if (active?.kind === "archive") {
        place = { ...active, segments: origin.segments };
        listing = await api.listArchive(active.id, origin.segments);
        break;
      }
      const { listing: root, ...opened } = await api.openArchive(origin.path, archivePassword);
      place = { kind: "archive", ...opened, address: origin.path, segments: origin.segments };
      register(place);
      listing = origin.segments.length ? await api.listArchive(opened.id, origin.segments) : root;
      break;
    }
  }
  if ((place.kind === "ftp" || place.kind === "ssh") && "segments" in origin &&
      JSON.stringify(place.segments) !== JSON.stringify(origin.segments)) throw new Error("The original folder is unavailable.");
  const entry = listing.entries.find((item) => item.name === (origin.kind === "googleDrive" ? origin.item : name) && item.directory === reference.directory);
  if (!entry) throw new Error("The original item is unavailable.");
  return { place, entry, listing };
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
    case "googleDrive": return typeof origin.profileId === "string" && typeof origin.account === "string" &&
      typeof origin.item === "string" && Array.isArray(origin.folders) &&
      origin.folders.every((folder) => folder && typeof folder.id === "string" && typeof folder.name === "string");
    case "ftp":
    case "ssh": return typeof origin.profileId === "string" && typeof origin.address === "string" && validSegments(origin.segments);
    case "server": return (typeof origin.share === "string" || typeof origin.profileId === "string") && typeof origin.address === "string" &&
      (origin.profileId === undefined || typeof origin.profileId === "string") &&
      (origin.groupPeer === undefined || typeof origin.groupPeer === "string") && validSegments(origin.segments);
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
  return { kind: "folder", id: newId(), name: collectionName(siblings, value), children: [] };
}

export function collectionReference(place: TextPlace, entry: Pick<Entry, "name" | "directory" | "googleDrive">): CollectionReference {
  const origin: Origin = (() => {
    switch (place.kind) {
      case "local": return { kind: "local", path: place.smb ? mountedSmbPath(place.path, place.smb) : place.path };
      case "archive": return { kind: "archive", path: place.path, segments: place.segments };
      case "googleDrive": return { kind: "googleDrive", profileId: place.id, account: place.email ?? place.address,
        item: entry.name, folders: place.folders };
      case "ftp":
      case "ssh": return { kind: place.kind, profileId: place.profileId, address: place.address, segments: place.segments };
      case "server": return { kind: "server", share: place.share, profileId: place.profileId, groupPeer: place.groupPeer,
        address: place.address, segments: place.segments };
      case "kswitcher": return { kind: "kswitcher", peer: place.peer, address: place.address, path: place.path };
    }
  })();
  return { kind: "reference", id: newId(), name: entry.googleDrive?.name ?? entry.name, directory: entry.directory, origin };
}

export function collectionReferenceFromRecent(location: RecentLocation): CollectionReference | undefined {
  if ("segments" in location) {
    const name = location.segments.at(-1);
    if (!name) return undefined;
    return { kind: "reference", id: newId(), name, directory: true, origin: {
      kind: location.kind, profileId: location.profileId, address: location.source, segments: location.segments.slice(0, -1),
    } };
  }
  const path = location.path.replace(/[/\\]+$/, "");
  const offset = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (offset < 0) return undefined;
  const parent = path.slice(0, offset + 1);
  const uri = /^smb:\/\//i.test(path);
  let name = path.slice(offset + 1);
  if (uri) {
    try { name = decodeURIComponent(name); } catch { return undefined; }
  }
  if (location.kind === "smb" && (uri ? parent.split("/").filter(Boolean).length < 3 : parent.split("\\").filter(Boolean).length < 2)) {
    return undefined;
  }
  const origin: Origin = location.kind === "kswitcher"
    ? { kind: "kswitcher", path: parent, peer: location.peer, address: location.source }
    : { kind: "local", path: parent };
  return { kind: "reference", id: newId(), name, directory: true, origin };
}

function referenceKey(reference: CollectionReference) {
  const { origin, name } = reference;
  switch (origin.kind) {
    case "local": return windowsClient
      ? JSON.stringify([origin.kind, origin.path.replace(/[\\/]+$/, "").toLowerCase(), name.toLowerCase()])
      : JSON.stringify([origin.kind, origin.path.replace(/\/+$/, ""), name]);
    case "archive": return JSON.stringify([origin.kind, origin.path, origin.segments, name]);
    case "googleDrive": return JSON.stringify([origin.kind, origin.profileId, origin.item]);
    case "ftp":
    case "ssh": return JSON.stringify([origin.kind, origin.profileId, origin.segments, name]);
    case "server": return JSON.stringify([origin.kind, origin.groupPeer ?? origin.profileId ?? origin.share, origin.segments, name]);
    case "kswitcher": return JSON.stringify([origin.kind, origin.peer, origin.path.replace(/[\\/]+$/, "").toLowerCase(), name.toLowerCase()]);
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

export function copyCollectionEntries(collections: CollectionFolder[], from: string[], into: string[],
  selected: readonly CollectionEntry[], moving: boolean) {
  const source = collectionTrail(collections, from);
  const destination = collectionTrail(collections, into);
  if (source.length !== from.length || destination.length !== into.length) throw new Error("The original collection folder is unavailable.");
  if (JSON.stringify(from) === JSON.stringify(into)) throw new Error("Choose a different destination collection folder.");
  const current = source.at(-1)?.children ?? collections;
  const ids = new Set(selected.map(({ id }) => id));
  const items = current.filter(({ id }) => ids.has(id));
  if (items.length !== ids.size) throw new Error("The original collection item is unavailable.");
  if (withinSelectedFolder(into, items)) throw new Error("Choose a destination outside the selected collection folders.");
  if (!into.length && items.some(({ kind }) => kind === "reference")) throw new Error("Open a collection folder first.");
  function duplicate(item: CollectionEntry): CollectionEntry {
    return item.kind === "folder" ? { ...item, id: newId(), children: item.children.map(duplicate) } : { ...item, id: newId() };
  }
  function add(siblings: CollectionEntry[]) {
    const updated = siblings.slice();
    const saved = new Set(siblings.filter((item) => item.kind === "reference").map(referenceKey));
    for (const item of items) {
      if (item.kind === "folder") collectionName(updated, item.name);
      else if (saved.has(referenceKey(item))) {
        if (moving) throw new Error("The destination already contains a reference to this item.");
        continue;
      } else saved.add(referenceKey(item));
      updated.push(moving ? item : duplicate(item));
    }
    return updated;
  }
  const result = editCollectionEntries(collections, into, add);
  return moving ? editCollectionEntries(result, from, (entries) => entries.filter(({ id }) => !ids.has(id))) : result;
}

function withinSelectedFolder(path: readonly string[], selected: readonly CollectionEntry[]) {
  return selected.some((entry) => entry.kind === "folder" && path.includes(entry.id));
}
