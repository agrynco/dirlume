import { Channel } from "@tauri-apps/api/core";
import { invokeWithDiagnostics as invoke, reportFrontendError } from "./diagnostics";

export interface Entry {
  name: string;
  directory: boolean;
  link: boolean;
  hidden: boolean;
  system?: boolean;
  size: number | null;
  modified: number | null;
}

export type FileFlag = "readOnly" | "archive" | "hidden" | "system" | "compressed" | "encrypted" | "notIndexed" | "ownerWritable";

export interface AttributeChange {
  flag: FileFlag;
  enabled: boolean;
}

export interface FileAttributes {
  flags: (AttributeChange & { writable: boolean })[];
  created: number | null;
  accessed: number | null;
  modified: number | null;
  owner: string | null;
  mode: string | null;
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
  | { kind: "ftp"; id: number; profileId: string; address: string; segments: string[] }
  | { kind: "kswitcher"; directory: string; peer: string; address: string; path: string; parent: string | null };

export type RemotePlace = Exclude<Place, { kind: "local" }>;
export type FtpPlace = Extract<Place, { kind: "ftp" }>;
export type TextPlace = Extract<Place, { kind: "local" | "server" | "ftp" }>;

export interface FtpProfile {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  codePage: number | null;
}

export interface NamedFile {
  place: TextPlace;
  name: string;
}

export interface KSwitcherPeer {
  id: string;
  name: string;
}

export const textEncodingLabels = {
  utf8: "UTF-8",
  utf8_bom: "UTF-8 with BOM",
  utf16_le: "UTF-16 LE",
  utf16_be: "UTF-16 BE",
} as const;
export type TextEncoding = keyof typeof textEncodingLabels;

export type TerminalOutput = { event: "data"; data: string } | { event: "closed" };
export interface SizeResult {
  name: string;
  bytes: number;
  incomplete: boolean;
}

export type Operation =
  | { kind: "open" | "create_folder" | "recycle" | "delete"; name: string }
  | { kind: "create_file"; name: string; encoding?: TextEncoding }
  | { kind: "rename"; name: string; new_name: string };

export type TransferSource =
  | { kind: "local"; directory: string; name: string }
  | { kind: "server"; connection: number; segments: string[]; folder: boolean }
  | { kind: "ftp"; connection: number; segments: string[] }
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
  encoding: TextEncoding;
  revision?: string;
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

export type AppUpdate = { kind: "install"; version: string } | { kind: "debian"; version: string; url: string };
export type UpdateProgress = { downloaded: number; total: number | null };

export const api = {
  buildVersion: () => invoke<string>("build_version"),
  checkForUpdate: (manual: boolean) => invoke<AppUpdate | null>("check_for_update", { manual }),
  installUpdate: (version: string, onProgress: Channel<UpdateProgress>) =>
    invoke<void>("install_update", { version, onProgress }),
  locations: () => invoke<QuickLocation[]>("locations"),
  requestedLocation: () => invoke<string | null>("requested_location"),
  listProcesses: () => invoke<ProcessInfo[]>("list_processes"),
  processIcons: (ids: ProcessId[]) => invoke<(string | null)[]>("process_icons", { ids }),
  fileIcons: (items: { directory: string; name: string }[]) => invoke<(string | null)[]>("file_icons", { items }),
  terminateProcesses: (ids: ProcessId[]) => invoke<string[]>("terminate_processes", { ids }),
  lockingProcesses: (paths: string[]) => invoke<{ processes: ProcessInfo[]; incomplete: boolean }>("locking_processes", { paths }),
  windowsItemMenu: (directory: string, name: string) => invoke<void>("windows_item_menu", { directory, name }),
  openElevated: (directory: string) => invoke<void>("open_elevated", { directory }),
  copyFileReferences: (items: { directory: string; name: string }[]) => invoke<void>("copy_file_references", { items }),
  clipboardFiles: () => invoke<{ directory: string; entry: Entry }[]>("clipboard_files"),
  listLocal: (path: string) => invoke<LocalListing>("list_directory", { path }),
  fileAttributes: (directory: string, name: string) =>
    invoke<FileAttributes>("file_attributes", { directory, name }),
  updateFileAttributes: (directory: string, name: string, changes: AttributeChange[]) =>
    invoke<FileAttributes>("update_file_attributes", { directory, name, changes }),
  operate: (directory: string, operation: Operation) =>
    invoke<void>("operate", { directory, operation }, operation.kind),
  connect: (invitation: string) => invoke<Connection>("connect_server", { invitation }),
  disconnect: (id: number) => invoke<void>("disconnect_server", { id }),
  ftpProfiles: () => invoke<FtpProfile[]>("ftp_profiles"),
  ftpWindowsCodePage: () => invoke<number | null>("ftp_windows_code_page"),
  saveFtpProfile: (input: Omit<FtpProfile, "id"> & { id?: string; password?: string }) =>
    invoke<string>("save_ftp_profile", { input }),
  removeFtpProfile: (id: string) => invoke<void>("remove_ftp_profile", { id }),
  connectFtp: (id: string, segments?: string[]) =>
    invoke<Connection & { segments: string[] }>("connect_ftp", { id, segments }),
  disconnectFtp: (id: number) => invoke<void>("disconnect_ftp", { id }),
  listFtp: (id: number, segments: string[]) => invoke<Listing>("list_ftp", { id, segments }),
  renameFtp: (id: number, segments: string[], name: string) => invoke<void>("rename_ftp", { id, segments, name }),
  deleteFtp: (id: number, segments: string[], recursive: boolean) =>
    invoke<void>("delete_ftp", { id, segments, recursive }),
  readFtpText: (id: number, segments: string[]) => invoke<TextDocument>("read_ftp_text", { id, segments }),
  readFtpBytes: (id: number, segments: string[], offset: number) =>
    invoke<BytePage>("read_ftp_bytes", { id, segments, offset }),
  saveFtpText: (id: number, segments: string[], revision: string, text: string) =>
    invoke<TextDocument>("save_ftp_text", { id, segments, revision, text }),
  listServer: (id: number, segments: string[]) =>
    invoke<Listing>("list_server", { id, segments }),
  readText: (directory: string, name: string) =>
    invoke<TextDocument>("read_text", { directory, name }),
  resolveTextLink: (directory: string, destination: string) =>
    invoke<{ directory: string; name: string }>("resolve_text_link", { directory, destination }),
  openWebLink: (href: string) => invoke<void>("open_web_link", { href }),
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
  openTerminal: (id: number, directory: string, promptToken: string, rows: number, cols: number, output: Channel<TerminalOutput>) =>
    invoke<void>("open_terminal", { id, directory, promptToken, rows, cols, output }),
  writeTerminal: (id: number, data: string) => invoke<void>("write_terminal", { id, data }),
  resizeTerminal: (id: number, rows: number, cols: number) => invoke<void>("resize_terminal", { id, rows, cols }),
  closeTerminal: (id: number) => invoke<void>("close_terminal", { id }),
  watchDirectory: (id: number, path: string, changes: Channel<null>) =>
    invoke<void>("watch_directory", { id, path, changes }),
  unwatchDirectory: (id: number) => invoke<void>("unwatch_directory", { id }),
  measureFolders: (id: number, source: { kind: "local"; directory: string } |
    { kind: "ftp"; connection: number; segments: string[] }, names: string[], output: Channel<SizeResult>) =>
    invoke<void>("measure_folders", { id, source, names, output }),
  cancelMeasurement: (id: number) => invoke<void>("cancel_measurement", { id }),
  beginTransfer: (id: number) => invoke<void>("begin_transfer", { id }),
  cancelTransfer: (id: number) => invoke<void>("cancel_transfer", { id }),
  finishTransfer: (id: number) => invoke<void>("finish_transfer", { id }),
  resolveTransfer: (id: number, decision: "overwrite" | "skip", remember: boolean) =>
    invoke<void>("resolve_transfer", { id, decision, remember }),
  transfer: (id: number, request: {
    source: TransferSource; destination: string; ftpDestination?: number; multiple: boolean; moving: boolean;
    policy: ConflictPolicy; askReadOnly: boolean;
  }, output: Channel<TransferEvent>) => invoke<TransferOutcome>("transfer_item", { id, request, output }),
};

export function placePath(place: Place) {
  if (place.kind === "server" || place.kind === "ftp") return "/" + place.segments.join("/");
  return place.path;
}

export async function connectFtpLocation(profileId: string, segments?: string[]) {
  const { listing, ...location } = await api.connectFtp(profileId, segments);
  const place: FtpPlace = { kind: "ftp", profileId, ...location };
  return { place, listing };
}

export function readPlaceText(file: NamedFile) {
  const { place, name } = file;
  if (place.kind === "local") return api.readText(place.path, name);
  const segments = [...place.segments, name];
  return place.kind === "ftp" ? api.readFtpText(place.id, segments) : api.readServerText(place.id, segments);
}

export async function savePlaceText({ place, name }: NamedFile, document: TextDocument, text: string): Promise<TextDocument> {
  if (place.kind === "ftp") {
    if (!document.revision) throw new Error("Reopen the FTP file before saving again.");
    return api.saveFtpText(place.id, [...place.segments, name], document.revision, text);
  }
  if (place.kind === "server") throw new Error("This source is read-only.");
  await api.saveText(place.path, name, document.text, text);
  return { ...document, text };
}

export function readPlaceBytes({ place, name }: NamedFile, offset: number) {
  if (place.kind === "local") return api.readBytes(place.path, name, offset);
  const segments = [...place.segments, name];
  return place.kind === "ftp" ? api.readFtpBytes(place.id, segments, offset) : api.readServerBytes(place.id, segments, offset);
}

export function isPermissionError(error: string) {
  return /\bos error (?:5|13)\b|access (?:is )?denied|permission denied/i.test(error);
}

export function isLockError(error: string) {
  return /\bos error (?:32|33)\b|sharing violation|being used by another process/i.test(error);
}

export function folderLabel(place: Place) {
  if (place.kind === "server" || place.kind === "ftp") return place.segments.at(-1) ?? place.address;
  if (place.kind === "kswitcher" && !place.path) return place.address;
  return place.path.split(windowsClient ? /[\\/]/ : "/").filter(Boolean).at(-1) ?? place.path;
}

export const windowsClient = /Windows/i.test(navigator.userAgent);

export function describeError(error: unknown) {
  reportFrontendError("desktop_action", error);
  return error instanceof Error ? error.message : String(error);
}
