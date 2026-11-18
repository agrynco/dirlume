import { Channel, invoke } from "@tauri-apps/api/core";

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
export type TextPlace = Extract<Place, { kind: "local" | "server" }>;

export interface NamedFile {
  place: TextPlace;
  name: string;
}

export interface KSwitcherPeer {
  id: string;
  name: string;
}

export type TerminalOutput = { event: "data"; data: string } | { event: "closed" };
export interface SizeResult {
  name: string;
  bytes: number;
  incomplete: boolean;
}

export type Operation =
  | { kind: "open" | "create_folder" | "create_file" | "recycle" | "delete"; name: string }
  | { kind: "rename"; name: string; new_name: string };

export type TransferSource =
  | { kind: "local"; directory: string; name: string }
  | { kind: "server"; connection: number; segments: string[]; folder: boolean }
  | { kind: "kswitcher"; directory: string; peer: string; path: string; name: string };

export type ConflictPolicy = "ask" | "skip" | "overwrite" | "rename" | "newer";
export type TransferEntryDetails = { size: number; modified: number | null; directory: boolean };
export type TransferConflict = {
  path: string; directory: boolean; readOnly: boolean; replaceable: boolean; allowRemember: boolean;
  incoming: TransferEntryDetails | null; existing: TransferEntryDetails;
};
export type TransferOutcome = { kind: "completed" | "skipped" };
export type TransferProgress = { file: string; bytes: number; total: number | null };
export type TransferEvent = ({ kind: "progress" } & TransferProgress) | { kind: "conflict"; conflict: TransferConflict };

interface Connection {
  id: number;
  address: string;
  listing: Listing;
}

export interface TextDocument {
  text: string;
  encoding: "utf8" | "utf8_bom" | "utf16_le" | "utf16_be";
}

export interface BytePage {
  length: number;
  data: number[];
}

export interface ProcessId {
  pid: number;
  started: number;
}

export interface ProcessInfo extends ProcessId {
  name: string;
  cpu: number;
  memory: number;
  canTerminate: boolean;
}

export const api = {
  locations: () => invoke<QuickLocation[]>("locations"),
  requestedLocation: () => invoke<string | null>("requested_location"),
  listProcesses: () => invoke<ProcessInfo[]>("list_processes"),
  terminateProcesses: (ids: ProcessId[]) => invoke<string[]>("terminate_processes", { ids }),
  lockingProcesses: (paths: string[]) => invoke<{ processes: ProcessInfo[]; incomplete: boolean }>("locking_processes", { paths }),
  windowsItemMenu: (directory: string, name: string) => invoke<void>("windows_item_menu", { directory, name }),
  openElevated: (directory: string) => invoke<void>("open_elevated", { directory }),
  copyFileReferences: (items: { directory: string; name: string }[]) => invoke<void>("copy_file_references", { items }),
  clipboardFiles: () => invoke<{ directory: string; entry: Entry }[]>("clipboard_files"),
  listLocal: (path: string) => invoke<LocalListing>("list_directory", { path }),
  operate: (directory: string, operation: Operation) =>
    invoke<void>("operate", { directory, operation }),
  connect: (invitation: string) => invoke<Connection>("connect_server", { invitation }),
  disconnect: (id: number) => invoke<void>("disconnect_server", { id }),
  listServer: (id: number, segments: string[]) =>
    invoke<Listing>("list_server", { id, segments }),
  readText: (directory: string, name: string) =>
    invoke<TextDocument>("read_text", { directory, name }),
  readServerText: (id: number, segments: string[]) =>
    invoke<TextDocument>("read_server_text", { id, segments }),
  readBytes: (directory: string, name: string, offset: number) =>
    invoke<BytePage>("read_bytes", { directory, name, offset }),
  readServerBytes: (id: number, segments: string[], offset: number) =>
    invoke<BytePage>("read_server_bytes", { id, segments, offset }),
  saveText: (directory: string, name: string, original: string, text: string) =>
    invoke<void>("save_text", { directory, name, original, text }),
  openKSwitcher: (directory: string) => invoke<void>("open_kswitcher", { directory }),
  hasKSwitcherBridge: (directory: string) => invoke<boolean>("has_kswitcher_bridge", { directory }),
  kswitcherPeers: (directory: string) => invoke<KSwitcherPeer[]>("kswitcher_peers", { directory }),
  listKSwitcher: (directory: string, peer: string, path: string) =>
    invoke<Listing & { parent: string | null }>("list_kswitcher", { directory, peer, path }),
  installedFonts: () => invoke<string[]>("installed_fonts"),
  openTerminal: (id: number, directory: string, rows: number, cols: number, output: Channel<TerminalOutput>) =>
    invoke<void>("open_terminal", { id, directory, rows, cols, output }),
  writeTerminal: (id: number, data: string) => invoke<void>("write_terminal", { id, data }),
  resizeTerminal: (id: number, rows: number, cols: number) => invoke<void>("resize_terminal", { id, rows, cols }),
  closeTerminal: (id: number) => invoke<void>("close_terminal", { id }),
  watchDirectory: (id: number, path: string, changes: Channel<null>) =>
    invoke<void>("watch_directory", { id, path, changes }),
  unwatchDirectory: (id: number) => invoke<void>("unwatch_directory", { id }),
  measureFolders: (id: number, directory: string, names: string[], output: Channel<SizeResult>) =>
    invoke<void>("measure_folders", { id, directory, names, output }),
  cancelMeasurement: (id: number) => invoke<void>("cancel_measurement", { id }),
  beginTransfer: (id: number) => invoke<void>("begin_transfer", { id }),
  cancelTransfer: (id: number) => invoke<void>("cancel_transfer", { id }),
  finishTransfer: (id: number) => invoke<void>("finish_transfer", { id }),
  resolveTransfer: (id: number, decision: "overwrite" | "skip", remember: boolean) =>
    invoke<void>("resolve_transfer", { id, decision, remember }),
  transfer: (id: number, request: {
    source: TransferSource; destination: string; multiple: boolean; moving: boolean;
    policy: ConflictPolicy; askReadOnly: boolean;
  }, output: Channel<TransferEvent>) => invoke<TransferOutcome>("transfer_item", { id, request, output }),
};

export function placePath(place: Place) {
  if (place.kind === "server") return "/" + place.segments.join("/");
  return place.path;
}

export function readPlaceText(file: NamedFile) {
  const { place, name } = file;
  return place.kind === "local" ? api.readText(place.path, name) : api.readServerText(place.id, [...place.segments, name]);
}

export function readPlaceBytes({ place, name }: NamedFile, offset: number) {
  return place.kind === "local" ? api.readBytes(place.path, name, offset)
    : api.readServerBytes(place.id, [...place.segments, name], offset);
}

export function isPermissionError(error: string) {
  return /\bos error (?:5|13)\b|access (?:is )?denied|permission denied/i.test(error);
}

export function isLockError(error: string) {
  return /\bos error (?:32|33)\b|sharing violation|being used by another process/i.test(error);
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
