import { invoke } from "@tauri-apps/api/core";

export interface Entry {
  name: string;
  directory: boolean;
  link: boolean;
  hidden: boolean;
  size: number | null;
  modified: number | null;
}

export interface Listing {
  entries: Entry[];
  omitted: number;
}

export interface LocalListing extends Listing {
  path: string;
  parent: string | null;
}

export interface QuickLocation {
  label: string;
  path: string;
}

export type Place =
  | { kind: "local"; path: string; parent: string | null }
  | { kind: "server"; id: number; address: string; segments: string[] }
  | { kind: "kswitcher"; directory: string; peer: string; address: string; path: string; parent: string | null };

export type RemotePlace = Exclude<Place, { kind: "local" }>;

export interface KSwitcherPeer {
  id: string;
  name: string;
}

export type Operation =
  | { kind: "open" | "create_folder" | "recycle"; name: string }
  | { kind: "copy" | "move"; name: string; target: string }
  | { kind: "rename"; name: string; new_name: string };

interface Connection {
  id: number;
  address: string;
  listing: Listing;
}

export interface TextDocument {
  text: string;
  encoding: "utf8" | "utf8_bom" | "utf16_le" | "utf16_be";
}

export const api = {
  locations: () => invoke<QuickLocation[]>("locations"),
  listLocal: (path: string) => invoke<LocalListing>("list_directory", { path }),
  operate: (directory: string, operation: Operation) =>
    invoke<void>("operate", { directory, operation }),
  connect: (invitation: string) => invoke<Connection>("connect_server", { invitation }),
  disconnect: (id: number) => invoke<void>("disconnect_server", { id }),
  listServer: (id: number, segments: string[]) =>
    invoke<Listing>("list_server", { id, segments }),
  download: (id: number, segments: string[], target: string) =>
    invoke<void>("download_server", { id, segments, target }),
  readText: (directory: string, name: string) =>
    invoke<TextDocument>("read_text", { directory, name }),
  saveText: (directory: string, name: string, original: string, text: string) =>
    invoke<void>("save_text", { directory, name, original, text }),
  openKSwitcher: (directory: string) => invoke<void>("open_kswitcher", { directory }),
  hasKSwitcherBridge: (directory: string) => invoke<boolean>("has_kswitcher_bridge", { directory }),
  kswitcherPeers: (directory: string) => invoke<KSwitcherPeer[]>("kswitcher_peers", { directory }),
  listKSwitcher: (directory: string, peer: string, path: string) =>
    invoke<Listing & { parent: string | null }>("list_kswitcher", { directory, peer, path }),
  downloadKSwitcher: (directory: string, peer: string, path: string, name: string, target: string) =>
    invoke<void>("download_kswitcher", { directory, peer, path, name, target }),
};

export function placePath(place: Place) {
  if (place.kind === "server") return "/" + place.segments.join("/");
  return place.path;
}

export function folderLabel(place: Place) {
  if (place.kind === "server") return place.segments.at(-1) ?? place.address;
  if (place.kind === "kswitcher" && !place.path) return place.address;
  return place.path.split(windowsClient ? /[\\/]/ : "/").filter(Boolean).at(-1) ?? place.path;
}

export const windowsClient = /Windows/i.test(navigator.userAgent);

export function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
