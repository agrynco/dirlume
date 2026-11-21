import { Channel } from "@tauri-apps/api/core";
import { invokeWithDiagnostics as invoke, reportFrontendError } from "./diagnostics";

export interface Entry extends Partial<PanelMetadata> {
  name: string;
  directory: boolean;
  link: boolean;
  hidden: boolean;
  system?: boolean;
  size: number | null;
  modified: number | null;
  connection?: SavedConnection;
  description?: string | null;
  allocationId?: string;
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

export type SortMetadataField = "created" | "accessed" | "changed" | "allocated" | "streamCount" | "streamSize";

export interface PanelMetadataRequest {
  directory: string;
  name: string;
  owner: boolean;
  links: boolean;
  sortFields?: SortMetadataField[];
}

export interface PanelMetadata extends Partial<Record<SortMetadataField, number | null>> {
  owner: string | null;
  hardLinks: number | null;
}

export interface Listing {
  entries: Entry[];
  omitted: number;
}

export type FtpSearchEvent =
  | { kind: "batch"; segments: string[]; prefix: string; entries: Entry[] }
  | { kind: "done"; omitted: number };

export interface LocalListing extends Listing {
  path: string;
  parent: string | null;
}

export type FolderLinkType = "none" | "junction" | "symbolic";
export interface FolderCreation {
  last: string | null;
  failure: { name: string; error: string } | null;
}

export interface CopyOptions {
  access: "default" | "copy" | "inherit";
  preserveTimestamps: boolean;
  followLinks: boolean;
  mask?: string;
}

type SmbConnection =
  | { kind: "opened"; listing: LocalListing; warning: string | null }
  | { kind: "shares"; server: string; names: string[]; warning: string | null }
  | { kind: "credentials_required"; error: string | null };

export interface QuickLocation {
  label: string;
  path: string;
}

export type FileLocation =
  | { kind: "local"; path: string; parent: string | null }
  | { kind: "smbRoot"; path: string }
  | { kind: "server"; id: number; share: string; address: string; origin: string; segments: string[] }
  | { kind: "ftp"; id: number; profileId: string; address: string; origin: string; segments: string[] }
  | { kind: "archive"; id: number; path: string; parent: string; segments: string[]; writable: boolean; address: string }
  | { kind: "ssh"; id: number; profileId: string; address: string; origin: string; segments: string[] }
  | { kind: "kswitcher"; directory: string; peer: string; address: string; path: string; parent: string | null };

export const connectionSourceNames = { ftp: "FTP", ssh: "SSH", smb: "SMB", remote: "Remote machine" } as const;
export type ConnectionSource = keyof typeof connectionSourceNames;
export type ConnectionLocation = { kind: "connections"; source: ConnectionSource; from: FileLocation | null };
export type Place = FileLocation | ConnectionLocation;
export type SavedConnection =
  | ({ kind: "ftp" } & FtpProfile)
  | ({ kind: "ssh" } & SshProfile)
  | { kind: "smb"; id: string; label: string; path: string }
  | { kind: "server"; id: string; label: string; credential: string }
  | { kind: "kswitcher"; id: string; label: string; peer: string };

export type RemotePlace = Exclude<FileLocation, { kind: "local" | "smbRoot" | "archive" }>;
export type SmbPlace = Extract<Place, { kind: "local" | "smbRoot" }>;
export type FilePlace = Exclude<FileLocation, { kind: "smbRoot" }>;
export type FtpPlace = Extract<Place, { kind: "ftp" }>;
export type SshPlace = Extract<Place, { kind: "ssh" }>;
type FileServerPlace = FtpPlace | SshPlace;
export type FileServer = Pick<FileServerPlace, "kind" | "id">;
export function isFileServer(place: Place | null | undefined): place is FileServerPlace {
  return place?.kind === "ftp" || place?.kind === "ssh";
}
export type ArchivePlace = Extract<Place, { kind: "archive" }>;
export type TextPlace = Extract<Place, { kind: "local" | "server" | "ftp" | "ssh" | "archive" }>;

export type ArchiveSettings = {
  format: string; appendExtension: boolean; level: number; method: string; solid: boolean; encrypted: boolean;
  encryptHeaders: boolean; volumeBytes: number | null; selfExtracting: boolean; exclude: string;
  openForWriting: boolean; keepWarnings: boolean;
};

export type CreateArchive = Omit<ArchiveSettings, "encrypted"> & {
  directory: string; names: string[]; destination: string; password: string | null;
  deleteSources: boolean; overwrite: boolean;
};

export interface FtpProfile {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  codePage: number | null;
}

export interface SshProfile {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  auth: { kind: "password" } | { kind: "privateKey"; path: string };
  hasSecret: boolean;
}

export interface SshHostVerification {
  host: string;
  port: number;
  fingerprint: string;
}

type SshVerificationRequired = { kind: "verifyHost"; verification: SshHostVerification };
type SshConnection = ({ kind: "connected" } & Connection & { segments: string[] }) | SshVerificationRequired;
type SshProfileInput = Omit<SshProfile, "id" | "hasSecret"> & { id?: string; secret?: string; clearSecret?: boolean };

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

export interface DiskSpace {
  available: number;
  total: number;
}

export interface GitBranch {
  reference: string;
  name: string;
  tip: string;
  remote: boolean;
}

export interface GitRepository {
  root: string;
  name: string;
  headRef: string | null;
  head: string | null;
  branches: GitBranch[];
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitHistory {
  commits: GitCommit[];
  nextOffset: number | null;
}

export interface GitDetails {
  message: string;
  merge: boolean;
  changes: { status: string; path: string; previousPath: string | null }[];
}

export type TerminalOutput = { event: "data"; data: string } | { event: "closed" };
export type TerminalCommand = { command: string; directory: string } | null;
export type TerminalSession = { id: number; path: string; refreshEnvironment: boolean } &
  ({ kind: "local" } | { kind: "ssh"; connection: number; address: string; segments: string[] });
export type CommandCompletion = { index: number; length: number; matches: { label: string; text: string; directory: boolean }[] };
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
  | { kind: "archive"; archive: number; segments: string[] }
  | { kind: "ssh"; connection: number; segments: string[] }
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
  origin: string;
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
  executable: string | null;
  canTerminate: boolean;
}

export type McpConnection = { endpoint: string; token: string };

export type AppUpdate = { kind: "install"; version: string } | { kind: "debian"; version: string; url: string };
export type UpdateProgress = { downloaded: number; total: number | null };

export const api = {
  startMcp: () => invoke<McpConnection>("start_mcp"),
  stopMcp: () => invoke<void>("stop_mcp"),
  mcpConnection: () => invoke<McpConnection | null>("mcp_connection"),
  mcpDecision: (id: string, approved: boolean) => invoke<void>("mcp_decision", { id, approved }),
  mcpResult: (id: string, output: { result?: unknown; error?: string }) => invoke<void>("mcp_result", { id, output }),
  buildVersion: () => invoke<string>("build_version"),
  readSettingsArchive: (title: string) => invoke<string | null>("read_settings_archive", { title }),
  writeSettingsArchive: (title: string, contents: string) => invoke<boolean>("write_settings_archive", { title, contents }),
  readPortableState: () => invoke<{ preferences: object | null; settingsError: string | null; updateError: string | null } | null>("read_portable_state"),
  savePortablePreferences: (preferences: object) => invoke<void>("save_portable_preferences", { preferences }),
  errorLog: () => invoke<string | null>("error_log"),
  checkForUpdate: () => invoke<AppUpdate | null>("check_for_update"),
  openToolWindow: (title: string, size?: { width: number; height: number }, comparison?: { left: NamedFile; right: NamedFile },
    initialPage?: import("./featureOptions").FeaturePage) =>
    invoke<void>("open_tool_window", { title, ...size, comparison, initialPage }),
  setAppearancePicker: (picking: boolean) => invoke<void>("set_appearance_picker", { picking }),
  pickScreenColor: () => invoke<string | null>("pick_screen_color"),
  installUpdate: (version: string, onProgress: Channel<UpdateProgress>) =>
    invoke<void>("install_update", { version, onProgress }),
  locations: () => invoke<QuickLocation[]>("locations"),
  spaceMount: (path: string) => invoke<{ path: string; share: boolean }>("space_mount", { path }),
  listSpaceDirectory: (root: string, segments: string[]) => invoke<Listing>("list_space_directory", { root, segments }),
  gitRepository: (path: string) => invoke<GitRepository>("git_repository", { path }),
  gitHistory: (root: string, tip: string, offset: number) => invoke<GitHistory>("git_history", { root, tip, offset }),
  gitDetails: (root: string, hash: string) => invoke<GitDetails>("git_details", { root, hash }),
  requestedLocation: () => invoke<string | null>("requested_location"),
  listProcesses: () => invoke<ProcessInfo[]>("list_processes"),
  processIcons: (ids: ProcessId[]) => invoke<(string | null)[]>("process_icons", { ids }),
  streamSortSupported: (directory: string) => invoke<boolean>("stream_sort_supported", { directory }),
  panelMetadata: (items: PanelMetadataRequest[]) => invoke<PanelMetadata[]>("panel_metadata", { items }),
  fileIcons: (items: { directory: string; name: string }[]) => invoke<(string | null)[]>("file_icons", { items }),
  terminateProcesses: (ids: ProcessId[]) => invoke<string[]>("terminate_processes", { ids }),
  lockingProcesses: (paths: string[]) => invoke<{ processes: ProcessInfo[]; incomplete: boolean }>("locking_processes", { paths }),
  windowsItemMenu: (directory: string, name?: string) => invoke<void>("windows_item_menu", { directory, name }),
  openElevated: (directory: string) => invoke<void>("open_elevated", { directory }),
  copyFileReferences: (items: { directory: string; name: string }[]) => invoke<void>("copy_file_references", { items }),
  clipboardFiles: () => invoke<{ directory: string; entry: Entry }[]>("clipboard_files"),
  copyText: (text: string) => invoke<void>("copy_path", { path: text }),
  clipboardText: () => invoke<string>("clipboard_text"),
  droppedFiles: (paths: string[]) => invoke<{ directory: string; entry: Entry }[]>("dropped_files", { paths }),
  listLocal: (path: string) => invoke<LocalListing>("list_directory", { path }),
  formatTimestamps: (timestamps: number[], style: "date" | "time" | "date_time") =>
    invoke<(string | null)[]>("format_timestamps", { timestamps, style }),
  createFolders: (directory: string, request: { name: string; multiple: boolean; linkType: FolderLinkType; target: string }) =>
    invoke<FolderCreation>("create_folders", { directory, request }),
  archiveCapabilities: () => invoke<{ formats: string[]; sfx: boolean }>("archive_capabilities"),
  createArchive: (id: number, request: CreateArchive, output: Channel<number>) =>
    invoke<{ paths: string[]; warning: string }>("create_archive", { id, request, output }),
  cancelArchive: (id: number) => invoke<void>("cancel_archive", { id }),
  openArchive: (path: string, password?: string) =>
    invoke<{ id: number; path: string; parent: string; writable: boolean; listing: Listing }>("open_archive", { path, password: password ?? null }),
  listArchive: (id: number, segments: string[]) => invoke<Listing>("list_archive", { id, segments }),
  readArchiveText: (id: number, segments: string[]) => invoke<TextDocument>("read_archive_text", { id, segments }),
  readArchiveBytes: (id: number, segments: string[], offset: number) => invoke<BytePage>("read_archive_bytes", { id, segments, offset }),
  saveArchiveText: (id: number, segments: string[], revision: string, text: string, encoding: TextEncoding) =>
    invoke<TextDocument>("save_archive_text", { id, segments, revision, text, encoding }),
  deleteArchiveEntries: (id: number, paths: string[][]) => invoke<void>("delete_archive_entries", { id, paths }),
  diskSpace: (path: string) => invoke<DiskSpace>("disk_space", { path }),
  connectSmb: (path: string, credentials: { username: string; password: string } | null, remember: boolean) =>
    invoke<SmbConnection>("connect_smb", { path, credentials, remember }),
  fileAttributes: (directory: string, name: string) =>
    invoke<FileAttributes>("file_attributes", { directory, name }),
  updateFileAttributes: (directory: string, name: string, changes: AttributeChange[]) =>
    invoke<FileAttributes>("update_file_attributes", { directory, name, changes }),
  operate: (directory: string, operation: Operation) =>
    invoke<void>("operate", { directory, operation }, operation.kind),
  connect: (invitation: string) => invoke<Connection & { share: string }>("connect_server", { invitation }),
  connectSavedServer: (credential: string) => invoke<Connection & { share: string }>("connect_saved_server", { credential }),
  saveServerInvitation: (invitation: string) => invoke<string>("save_server_invitation", { invitation }),
  removeServerInvitation: (credential: string) => invoke<void>("remove_server_invitation", { credential }),
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
  searchFtp: (id: number, request: { connection: number; segments: string[]; mask: string; showHidden: boolean },
    output: Channel<FtpSearchEvent>) => invoke<void>("search_ftp", { id, request, output }),
  cancelFtpSearch: (id: number) => invoke<void>("cancel_ftp_search", { id }),
  sshProfiles: () => invoke<SshProfile[]>("ssh_profiles"),
  saveSshProfile: (input: SshProfileInput) =>
    invoke<SshProfile>("save_ssh_profile", { input }),
  testSshConnection: (input: SshProfileInput, approval?: SshHostVerification) =>
    invoke<{ kind: "success" } | SshVerificationRequired>("test_ssh_connection", { input, approval }),
  removeSshProfile: (id: string) => invoke<void>("remove_ssh_profile", { id }),
  connectSsh: (id: string, approval?: SshHostVerification, segments?: string[]) =>
    invoke<SshConnection>("connect_ssh", { id, approval, segments }),
  disconnectSsh: (id: number) => invoke<void>("disconnect_ssh", { id }),
  listSsh: (id: number, segments: string[], sudoPassword?: string, reuseSudo?: boolean) =>
    invoke<Listing & { elevated: boolean }>("list_ssh", { id, segments, sudoPassword, reuseSudo }),
  deleteSsh: (id: number, segments: string[], recursive: boolean) => invoke<void>("delete_ssh", { id, segments, recursive }),
  renameFtp: (id: number, segments: string[], name: string) => invoke<void>("rename_ftp", { id, segments, name }),
  deleteFtp: (id: number, segments: string[], recursive: boolean) =>
    invoke<void>("delete_ftp", { id, segments, recursive }),
  readFtpText: (id: number, segments: string[]) => invoke<TextDocument>("read_ftp_text", { id, segments }),
  readFtpBytes: (id: number, segments: string[], offset: number) =>
    invoke<BytePage>("read_ftp_bytes", { id, segments, offset }),
  saveFtpText: (id: number, segments: string[], revision: string, text: string) =>
    invoke<TextDocument>("save_ftp_text", { id, segments, revision, text }),
  readSshText: (id: number, segments: string[], sudoPassword?: string) => invoke<TextDocument>("read_ssh_text", { id, segments, sudoPassword }),
  readSshBytes: (id: number, segments: string[], offset: number) =>
    invoke<BytePage>("read_ssh_bytes", { id, segments, offset }),
  saveSshText: (id: number, segments: string[], revision: string, text: string, sudoPassword?: string) =>
    invoke<TextDocument>("save_ssh_text", { id, segments, revision, text, sudoPassword }),
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
  saveTextAs: (path: string, encoding: TextEncoding, text: string) =>
    invoke<void>("save_text_as", { path, encoding, text }),
  openKSwitcher: (directory: string) => invoke<void>("open_kswitcher", { directory }),
  hasKSwitcherBridge: (directory: string) => invoke<boolean>("has_kswitcher_bridge", { directory }),
  kswitcherPeers: (directory: string) => invoke<KSwitcherPeer[]>("kswitcher_peers", { directory }),
  listKSwitcher: (directory: string, peer: string, path: string) =>
    invoke<Listing & { parent: string | null }>("list_kswitcher", { directory, peer, path }),
  installedFonts: () => invoke<string[]>("installed_fonts"),
  openTerminal: (session: TerminalSession, promptToken: string, rows: number, cols: number, output: Channel<TerminalOutput>) =>
    invoke<boolean>("open_terminal", { request: { id: session.id, directory: session.path, promptToken, rows, cols,
      refreshEnvironment: session.refreshEnvironment,
      ssh: session.kind === "ssh" ? { connection: session.connection, segments: session.segments } : undefined,
    }, output }),
  completeCommand: (line: string, caret: number, directory: string, refreshEnvironment: boolean) =>
    invoke<CommandCompletion>("complete_command", { request: { line, caret, directory, refreshEnvironment } }),
  writeTerminal: (id: number, data: string) => invoke<void>("write_terminal", { id, data }),
  resizeTerminal: (id: number, rows: number, cols: number) => invoke<void>("resize_terminal", { id, rows, cols }),
  closeTerminal: (id: number) => invoke<void>("close_terminal", { id }),
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
    source: TransferSource; destination: string; ftpDestination?: number; sshDestination?: number; multiple: boolean; moving: boolean;
    policy: ConflictPolicy; askReadOnly: boolean; copyOptions?: CopyOptions;
  }, output: Channel<TransferEvent>) => invoke<TransferOutcome>("transfer_item", { id, request, output }),
};

export function placePath(place: Place) {
  if (place.kind === "server" || isFileServer(place)) return "/" + place.segments.join("/");
  if (place.kind === "archive") return place.path + "!/" + place.segments.join("/");
  return place.kind === "connections" ? connectionSourceNames[place.source] : place.path;
}

export function documentPath({ place, name }: NamedFile) {
  if (place.kind === "server" || isFileServer(place)) {
    return place.origin + "/" + [...place.segments, name].map(encodeURIComponent).join("/");
  }
  if (place.kind === "local") {
    const [host, ...segments] = uncParts(place.path);
    if (host && segments.length) return "smb://" + host + "/" + [...segments, name].map(encodeURIComponent).join("/");
  }
  const folder = placePath(place);
  const separator = place.kind === "local" && windowsClient ? "\\" : "/";
  return folder.replace(/[\\/]$/, "") + separator + name;
}

export function smbLocation(result: Exclude<SmbConnection, { kind: "credentials_required" }>): { place: SmbPlace; listing: Listing } {
  if (result.kind === "opened") {
    const { path, parent } = result.listing;
    return { place: { kind: "local", path, parent }, listing: result.listing };
  }
  const entries = result.names.map((name) => ({ name, directory: true, link: false, hidden: false, size: null, modified: null }));
  return { place: { kind: "smbRoot", path: result.server }, listing: { entries, omitted: 0 } };
}

export async function connectFtpLocation(profileId: string, segments?: string[]) {
  const { listing, ...location } = await api.connectFtp(profileId, segments);
  const place: FtpPlace = { kind: "ftp", profileId, ...location };
  return { place, listing };
}

export function readPlaceText(file: NamedFile, sudoPassword?: string) {
  const { place, name } = file;
  if (place.kind === "local") return api.readText(place.path, name);
  const segments = [...place.segments, name];
  if (place.kind === "archive") return api.readArchiveText(place.id, segments);
  if (place.kind === "ssh") return api.readSshText(place.id, segments, sudoPassword);
  return place.kind === "ftp" ? api.readFtpText(place.id, segments) : api.readServerText(place.id, segments);
}

export function readPlacePreviewImage({ place, name }: NamedFile) {
  const source = place.kind === "local" ? { kind: place.kind, directory: place.path, name }
    : { kind: place.kind, id: place.id, segments: [...place.segments, name] };
  return invoke<ArrayBuffer>("read_preview_image", { source });
}

export async function savePlaceText({ place, name }: NamedFile, document: TextDocument, text: string, sudoPassword?: string): Promise<TextDocument> {
  if (place.kind === "archive") {
    if (!place.writable || !document.revision) throw new Error("The archive is read-only.");
    return api.saveArchiveText(place.id, [...place.segments, name], document.revision, text, document.encoding);
  }
  if (place.kind === "ftp") {
    if (!document.revision) throw new Error("Reopen the FTP file before saving again.");
    return api.saveFtpText(place.id, [...place.segments, name], document.revision, text);
  }
  if (place.kind === "ssh") {
    if (!document.revision) throw new Error("Reopen the SSH file before saving again.");
    return api.saveSshText(place.id, [...place.segments, name], document.revision, text, sudoPassword);
  }
  if (place.kind === "server") throw new Error("This source is read-only.");
  await api.saveText(place.path, name, document.text, text);
  return { ...document, text };
}

export function readPlaceBytes({ place, name }: NamedFile, offset: number) {
  if (place.kind === "local") return api.readBytes(place.path, name, offset);
  const segments = [...place.segments, name];
  if (place.kind === "archive") return api.readArchiveBytes(place.id, segments, offset);
  if (place.kind === "ssh") return api.readSshBytes(place.id, segments, offset);
  return place.kind === "ftp" ? api.readFtpBytes(place.id, segments, offset) : api.readServerBytes(place.id, segments, offset);
}

export function writableTextPlace(place: TextPlace) {
  return place.kind !== "server" && (place.kind !== "archive" || place.writable);
}

let nextDirectoryWatch = 0;

export function watchDirectory(path: string, onChange: () => void, name?: string) {
  const id = ++nextDirectoryWatch;
  const changes = new Channel<null>();
  changes.onmessage = onChange;
  const ready = invoke<void>("watch_directory", { id, path, name: name ?? null, changes });
  return {
    ready,
    stop: () => {
      changes.onmessage = () => {};
      void ready.then(() => invoke<void>("unwatch_directory", { id })).catch(() => {});
    },
  };
}

export function isPermissionError(error: string) {
  return /\bos error (?:5|13)\b|access (?:is )?denied|permission denied/i.test(error);
}

export function isLockError(error: string) {
  return /\bos error (?:32|33)\b|sharing violation|being used by another process/i.test(error);
}

export function folderLabel(place: Place) {
  if (place.kind === "connections") return connectionSourceNames[place.source];
  if (place.kind === "server" || isFileServer(place)) return place.segments.at(-1) ?? place.address;
  if (place.kind === "archive" && place.segments.length) return place.segments.at(-1)!;
  if (place.kind === "kswitcher" && !place.path) return place.address;
  return place.path.split(windowsClient ? /[\\/]/ : "/").filter(Boolean).at(-1) ?? place.path;
}

export const windowsClient = /Windows/i.test(navigator.userAgent);

export function uncParts(path: string) {
  if (!windowsClient) return [];
  const normalized = path.replaceAll("/", "\\").replace(/^\\\\\?\\UNC\\/i, "\\\\");
  if (!normalized.startsWith("\\\\")) return [];
  const parts = normalized.slice(2).split("\\");
  if (!parts[0] || /^[.?]$|[@:\s]/.test(parts[0])) return [];
  return parts.filter(Boolean);
}

export function smbHost(place: Place | null) {
  return place?.kind === "local" || place?.kind === "smbRoot" ? uncParts(place.path)[0] : undefined;
}

export function describeError(error: unknown) {
  reportFrontendError("desktop_action", error);
  return error instanceof Error ? error.message : String(error);
}
