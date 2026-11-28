import { Channel, isTauri } from "@tauri-apps/api/core";
import { invokeWithDiagnostics as invoke, reportFrontendError } from "./diagnostics";
import { t } from "./i18n";
import type { ImageTransform, Size } from "./imageCrop";

export interface Entry extends Partial<PanelMetadata> {
  name: string;
  directory: boolean;
  link: boolean;
  hidden: boolean;
  system?: boolean;
  size: number | null;
  modified: number | null;
  connection?: SavedConnection;
  googleDrive?: GoogleDriveItem;
  description?: string | null;
  allocationId?: string;
  tree?: {
    parent: TreePlace;
    segments: readonly string[];
    expanded: boolean;
    loading: boolean;
    error?: string;
    stale?: boolean;
  };
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

export type SpaceChange =
  | { parent: number; name: string; directory: boolean; size: number | null; allocated: number | null; shared: boolean }
  | { closed: number; error: string | null; partial: boolean };

export type SpaceScanEvent =
  | { kind: "start"; strategy: "walk" | "mft" }
  | { kind: "batch"; changes: SpaceChange[] }
  | { kind: "finished" };

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

type SmbMount = { server: string; root: string; share: string };
type SmbConnection =
  | { kind: "opened"; listing: LocalListing; warning: string | null; mount?: SmbMount }
  | { kind: "shares"; server: string; names: string[]; warning: string | null }
  | { kind: "credentials_required"; error: string | null };

export interface QuickLocation {
  label: string;
  path: string;
}

export interface ComputerDrive {
  name: string;
  type?: number | null;
  total: number | null;
  available: number | null;
}

export interface ComputerSharing {
  address: string;
  invitation: string;
}

export interface LanGroupStatus {
  active: boolean;
  remembered: boolean;
  writable: boolean;
  storageError: string | null;
}

export type GoogleDriveItem = {
  id: string; name: string; directory: boolean; size: number | null; modified: number | null;
  webViewLink: string | null; download: boolean;
};
export type GoogleDriveProfile = { kind: "googleDrive"; id: string; label: string; email: string; signInNeeded: boolean };
export type GoogleDrivePlace = { kind: "googleDrive"; id: string; address: string; email?: string; folders: { id: string; name: string }[] };
export type GoogleDriveChange =
  | { kind: "createFolder" | "createFile"; parent: string; name: string }
  | { kind: "rename"; item: string; name: string }
  | { kind: "trash" | "delete"; item: string };
export const googleDriveSignInRequired = "Sign in to this Google Drive account again.";

export type FileLocation =
  | GoogleDrivePlace
  | { kind: "local"; path: string; parent: string | null; smb?: SmbMount }
  | { kind: "smbRoot"; path: string }
  | { kind: "server"; id: number; share: string; address: string; origin: string; segments: string[]; writable?: boolean; pairedComputer?: boolean; profileId?: string; groupPeer?: string }
  | { kind: "ftp"; id: number; profileId: string; address: string; origin: string; segments: string[];
      directories?: DirectoryPreferences; environment?: EnvironmentPreferences }
  | { kind: "archive"; id: number; path: string; parent: string; segments: string[]; writable: boolean; canAdd: boolean; address: string }
  | { kind: "ssh"; id: number; profileId: string; address: string; origin: string; segments: string[];
      directories?: DirectoryPreferences; environment?: EnvironmentPreferences }
  | { kind: "kswitcher"; directory: string; peer: string; address: string; path: string; parent: string | null; capabilities?: KSwitcherCapabilities };

export const connectionSourceNames = { netbox: "NetBox", smb: "SMB", remote: "Remote machine", googleDrive: "Google Drive" } as const;
export type ConnectionSource = keyof typeof connectionSourceNames;
export type ConnectionLocation = { kind: "connections"; source: ConnectionSource; from: FileLocation | null; trail?: FileLocation };
export type Place = FileLocation | ConnectionLocation;
export type SavedConnection =
  | GoogleDriveProfile
  | ({ kind: "ftp" } & FtpProfile)
  | ({ kind: "ssh" } & SshProfile)
  | { kind: "smb"; id: string; label: string; path: string }
  | { kind: "server"; id: string; label: string; credential: string; lan?: boolean }
  | { kind: "kswitcher"; id: string; label: string; peer: string };

export type RemotePlace = Exclude<FileLocation, { kind: "local" | "smbRoot" | "archive" }>;
export type SmbPlace = Extract<Place, { kind: "local" | "smbRoot" }>;
export type FilePlace = Exclude<FileLocation, { kind: "smbRoot" }>;
export type FtpPlace = Extract<Place, { kind: "ftp" }>;
export type SshPlace = Extract<Place, { kind: "ssh" }>;
export type FileServerPlace = FtpPlace | SshPlace;
export type LanGroupPlace = Extract<Place, { kind: "server" }> & { groupPeer: string };
export type WritableServerPlace = LanGroupPlace | (Extract<Place, { kind: "server" }> & { writable: true });
export type TreePlace = FilePlace;
export type LanChange = { kind: "folder" } | { kind: "create_text"; encoding: TextEncoding } |
  { kind: "delete"; recursive: boolean } | { kind: "rename"; name: string };
export function isLanGroupPlace(place: Place | null | undefined): place is LanGroupPlace {
  return place?.kind === "server" && typeof place.groupPeer === "string";
}
export function isWritableServerPlace(place: Place | null | undefined): place is WritableServerPlace {
  if (isLanGroupPlace(place)) return place.segments.length > 0;
  return place?.kind === "server" && place.writable === true;
}
export type FileServer = Pick<FileServerPlace, "kind" | "id">;
export function isFileServer(place: Place | null | undefined): place is FileServerPlace {
  return place?.kind === "ftp" || place?.kind === "ssh";
}
export function supportsFileTree(place: Place | null | undefined): place is TreePlace {
  return !!place && place.kind !== "connections" && place.kind !== "smbRoot" &&
    (place.kind !== "kswitcher" || !!place.path) && (!isLanGroupPlace(place) || !!place.segments.length);
}
export type ArchivePlace = Extract<Place, { kind: "archive" }>;
export type ArchiveChange = { kind: "folder"; parent: string[]; name: string }
  | { kind: "text"; parent: string[]; name: string; encoding: TextEncoding }
  | { kind: "rename"; segments: string[]; name: string };
export type TextPlace = FilePlace;
export type KSwitcherPlace = Extract<Place, { kind: "kswitcher" }>;

export type ArchiveSettings = {
  format: string; appendExtension: boolean; level: number; method: string; solid: boolean; encrypted: boolean;
  encryptHeaders: boolean; volumeBytes: number | null; selfExtracting: boolean; exclude: string;
  openForWriting: boolean; keepWarnings: boolean;
};

export type CreateArchive = Omit<ArchiveSettings, "encrypted"> & {
  directory: string; names: string[]; destination: string; password: string | null;
  deleteSources: boolean; overwrite: boolean;
};

export interface DirectoryPreferences {
  startingFolder: string;
  rememberLast: boolean;
  cacheListings: boolean;
  cacheChanges: boolean;
  persistentCache: boolean;
  resolveLinks: boolean;
}

export interface EnvironmentPreferences {
  lineEnding: "lf" | "crlf";
  listingTime: "asReported" | "fixedOffset" | "localZone";
  serverOffsetMinutes: number;
  daylightSaving: "atTimestamp" | "currentOffset";
  preserveDownloadTimestamps: boolean;
  recycleBin?: RemoteRecyclePreferences;
}

export interface RemoteRecyclePreferences {
  folder: string;
  keepDeleted: boolean;
  keepOverwritten: boolean;
}

export interface FtpProfile {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  codePage: number | null;
  encryption?: FtpEncryption;
  ftpOptions?: FtpOptions;
  directories?: DirectoryPreferences;
  environment?: EnvironmentPreferences;
  connectionOptions?: ConnectionPreferences;
  proxy?: ProxySettings;
}

export type ProxyMode = "none" | "socks5" | "httpConnect";
export interface ProxySettings {
  mode: ProxyMode;
  host: string;
  port: number;
  username: string;
  skipLoopback: boolean;
  resolveLocally: boolean;
  hasPassword?: boolean;
}
export type ProxyInput = Omit<ProxySettings, "hasPassword"> & { password?: string };
type FtpProfileInput = Omit<FtpProfile, "id" | "proxy"> & { id?: string; password?: string; proxy?: ProxyInput };

export type FtpEncryption = "plain" | "explicitTls" | "implicitTls";
export interface FtpOptions {
  mlsd: "auto" | "on" | "off";
  activeMode: boolean;
  emptyPassword: boolean;
  postLoginCommands: string[];
  rawIacCommands: boolean;
  rawIacPwd: boolean;
}

export type ConnectionTiming = { mode: "default" | "disabled" } | { mode: "custom"; seconds: number };
export interface ConnectionPreferences {
  timeout: ConnectionTiming;
  keepalive: ConnectionTiming;
  addressFamily: "auto" | "ipv4" | "ipv6";
  optimizeBuffer: boolean;
}

async function netBoxRequest<T>(signal: AbortSignal | undefined, run: (request?: string) => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  if (!signal || !isTauri()) return run();
  const request = await invoke<string>("begin_netbox_request");
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    void invoke<void>("finish_netbox_request", { id: request }).catch(() => {});
  };
  signal.addEventListener("abort", finish, { once: true });
  try {
    signal.throwIfAborted();
    return await run(request);
  } finally {
    signal.removeEventListener("abort", finish);
    finish();
  }
}

export interface SshHostSettings {
  host: string;
  port: number;
  username: string;
  auth: { kind: "password" } | { kind: "privateKey"; path: string };
}

export interface SshJumpHost extends SshHostSettings {
  id: string;
  hasSecret: boolean;
}

export interface SshProfile extends SshHostSettings {
  id: string;
  label: string;
  hasSecret: boolean;
  jumpHosts?: SshJumpHost[];
  directories?: DirectoryPreferences;
  environment?: EnvironmentPreferences;
  connectionOptions?: ConnectionPreferences;
  proxy?: ProxySettings;
  compatibility?: SshCompatibility;
}

export interface SshCompatibility {
  sftpCommand: string;
  signedTimestamps: boolean;
  shell: "automatic" | "bash" | "zsh" | "sh";
}

export interface SshHostVerification {
  host: string;
  port: number;
  fingerprint: string;
}

type SshVerificationRequired = { kind: "verifyHost"; verification: SshHostVerification };
type ConnectedFileServer = Connection & {
  segments: string[]; directories?: DirectoryPreferences; environment?: EnvironmentPreferences; unavailableFolders?: string[];
};
type SshConnection = ({ kind: "connected" } & ConnectedFileServer) | SshVerificationRequired;
export type SshHostInput = SshHostSettings & { secret?: string; clearSecret?: boolean };
type SshProfileInput = SshHostInput & {
  id?: string; label: string; jumpHosts?: (SshHostInput & { id?: string })[]; directories?: DirectoryPreferences; environment?: EnvironmentPreferences;
  connectionOptions?: ConnectionPreferences;
  proxy?: ProxyInput;
  compatibility?: SshCompatibility;
};

export interface NamedFile {
  place: TextPlace;
  name: string;
  driveItem?: string;
}

export interface KSwitcherPeer {
  id: string;
  name: string;
  online?: boolean;
}

export interface KSwitcherCapabilities {
  write: boolean;
  delete: boolean;
  revisionRead: boolean;
  onHostTransfer: boolean;
  localEndpoint: boolean;
  conflictPrompt?: boolean;
}

type KSwitcherChange = { kind: "create_file"; encoding: TextEncoding } | { kind: "create_folder" | "recycle" } |
  { kind: "rename"; name: string } | { kind: "delete"; recursive: boolean };

export function kswitcherPath(directory: string, name: string) {
  return directory.replace(/[\\/]+$/, "") + "\\" + name;
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

export interface VolumeInformation {
  path: string;
  share: boolean;
  label: string | null;
  filesystem: string | null;
  capacity: DiskSpace | null;
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
  tags?: { reference: string; name: string }[];
}

export type GitBranchAction = "create" | "track" | "switch" | "rename" | "delete";
export interface GitBranchRequest {
  action: GitBranchAction;
  expectedHeadRef: string | null;
  expectedHead: string | null;
  reference: string | null;
  tip: string | null;
  name: string | null;
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

export interface GitComparison {
  base: string;
  target: string;
  baseOnly: GitHistory;
  targetOnly: GitHistory;
  changes: GitDetails["changes"];
}

export type GitRevisionDiff = Pick<GitWorkingDiff, "patch" | "fallback">;

export type GitChangeGroup = "staged" | "unstaged" | "untracked";
export type GitWorkingChange = GitDetails["changes"][number] & { group: GitChangeGroup };
export interface GitIndexSnapshot {
  headRef: string | null;
  head: string | null;
  gitDir: string;
  index: string;
}
export interface GitWorkingIndex {
  snapshot: GitIndexSnapshot;
  writeBlocked: boolean;
  submodules: string[];
  changes: GitWorkingChange[];
}
export type GitIndexAction = "stage" | "unstage";
export interface GitWorkingDiff {
  workingPath: string | null;
  workingText: boolean;
  patch: string | null;
  fallback: "binary" | "conflict" | "oversized" | "unsupported" | null;
  unborn: boolean;
}

export type EnvironmentScope = "user" | "system" | "process";
export type EnvironmentKind = "literal" | "expandable";
export interface EnvironmentRow {
  name: string;
  source: string;
  overriddenBy: string | null;
}
export interface EnvironmentValue extends EnvironmentRow {
  value: string;
  kind: EnvironmentKind;
}
export interface EnvironmentInfo {
  target: string;
  activation: string;
  startupFile: string | null;
  integrationEnabled: boolean;
  expandable: boolean;
}
export interface EnvironmentEdit {
  name: string;
  value: string;
  kind: EnvironmentKind;
  expected: EnvironmentValue | null;
  replacePath: boolean;
}
export type EnvironmentOutcome = "saved" | "conflict" | "invalid" | "denied" | "failed";
export interface EnvironmentSave {
  outcomes: { name: string; result: EnvironmentOutcome }[];
  integration: EnvironmentOutcome | null;
}

import type { MenuRun, MenuEntry, MenuSource, MenuSourceVersion } from "./userMenu";

export type TerminalOutput = { event: "data"; data: string } | { event: "finished"; code: number } | { event: "closed" | "disconnected" };
export type TerminalCommand = { command: string; directory: string } | null;
export type TerminalSession = { id: number; path: string; refreshEnvironment: boolean } &
  ({ kind: "local"; userMenu?: MenuRun } | { kind: "ssh"; connection: number; address: string; segments: string[] });
export type CommandCompletion = { index: number; length: number; exclusive?: boolean; matches: { label: string; text: string; directory: boolean }[] };
export type ShellCompletionEnvironment = Record<string, string | null>;
export type TerminalCompletionContext = { searchPath?: string; environment?: ShellCompletionEnvironment };
export interface SizeResult {
  name: string;
  bytes: number;
  incomplete: boolean;
}

export type Operation =
  | { kind: "open" | "create_folder" | "recycle" | "delete"; name: string }
  | { kind: "create_file"; name: string; encoding?: TextEncoding }
  | { kind: "rename"; name: string; new_name: string };

export type Deletion = { directory: string; names: string[]; permanent: boolean; relativePaths?: string[][] };
export type DeletionCounts = { completed: number; skipped: number; failed: number; unprocessed: number };
export type DeletionSelection = { files: number; folders: number; bytes: number; incomplete: boolean; availableBefore: number | null };
export type DeletionProgress = { path: string; currentTotal: number; currentProcessed: number; counts: DeletionCounts };
export type DeletionEvent =
  | { phase: "preparing"; path: string; selection: DeletionSelection }
  | { phase: "removing"; progress: DeletionProgress; selection: DeletionSelection }
  | { phase: "locked"; token: number; path: string };
export type DeletionResult = { selection: DeletionSelection; counts: DeletionCounts; cancelled: boolean; removedPaths: string[][];
  availableAfter: number | null; failures: { path: string; message: string }[] };
export type DeletionDecision = "retry" | "skip" | "skipRemaining";

export type TransferSource =
  | { kind: "google_drive"; profile: string; item: string; name: string; parent: string; folder: boolean }
  | { kind: "local"; directory: string; name: string }
  | { kind: "server"; connection: number; segments: string[]; folder: boolean; modified?: number; writable_server?: true }
  | { kind: "ftp"; connection: number; segments: string[] }
  | { kind: "archive"; archive: number; segments: string[] }
  | { kind: "ssh"; connection: number; segments: string[] }
  | { kind: "kswitcher"; directory: string; peer: string; path: string; name: string; folder: boolean; modified?: number };

export type ConflictPolicy = "ask" | "skip" | "overwrite" | "rename" | "newer";
export type TransferEntryDetails = { size: number; modified: number | null; directory: boolean };
export type TransferConflict = {
  path: string; directory: boolean; readOnly: boolean; confirmReadOnly: boolean; replaceable: boolean; allowRemember: boolean;
  incoming: TransferEntryDetails | null; existing: TransferEntryDetails;
};
export type TransferOutcome = { kind: "completed" | "skipped" }
  | { kind: "source_retained"; destination: string; source: string; error: string };
export type TransferProgress = { file: string; path?: string; bytes: number; total: number | null };
export type TransferSudoRequest = { kind: "sudo_required"; ticket: string; address: string; path: string };
export type TransferEvent = ({ kind: "progress" } & TransferProgress) |
  { kind: "conflict"; conflict: TransferConflict } |
  TransferSudoRequest;

export type FileHistoryDirection = "undo" | "redo";
export interface FileHistory {
  entries: {
    id: number;
    moving: boolean;
    source: string;
    destination: string;
    time: number;
    outcome: string;
    reason: string | null;
    rows: { source: string; destination: string; outcome: string; error: string | null }[];
  }[];
  undo: number | null;
  redo: number | null;
  pending: FileHistoryDirection | null;
  changed: boolean;
}

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

export interface TextPages {
  id: number;
  encoding: TextEncoding;
  length: number;
  pageCount: number;
}

export interface TextPage {
  text: string;
  original: { start: number; end: number };
}

export interface BytePage {
  length: number;
  data: number[];
}
export const fileBytePageSize = 1024;

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

export type ReleaseHighlights = { version: string; highlights: string[] };
export type InstalledRelease = ReleaseHighlights & { showOnStartup: boolean };
export type AppUpdate = ReleaseHighlights & ({ kind: "install" } | { kind: "debian"; url: string });
export type UpdateProgress = { downloaded: number; total: number | null };

export type AdministratorWorkspace = {
  side: "left" | "right";
  directory: string;
  selected?: string | null;
  otherFolder?: string | null;
  otherAnalyzer?: string | null;
  split: number;
  preferences: object;
};

export const api = {
  googleDriveProfiles: () => invoke<Omit<GoogleDriveProfile, "kind">[]>("google_drive_profiles"),
  signInGoogleDrive: (id: string, profileId?: string) => invoke<string>("sign_in_google_drive", { id, profileId }),
  cancelGoogleDriveSignIn: (id: string) => invoke<void>("cancel_google_drive_sign_in", { id }),
  renameGoogleDrive: (id: string, label: string) => invoke<void>("rename_google_drive", { id, label }),
  removeGoogleDrive: (id: string) => invoke<void>("remove_google_drive", { id }),
  listGoogleDrive: (id: string, folder: string) => invoke<GoogleDriveItem[]>("list_google_drive", { id, folder }),
  changeGoogleDrive: (id: string, change: GoogleDriveChange) => invoke<string | null>("change_google_drive", { id, change }),
  startMcp: () => invoke<McpConnection>("start_mcp"),
  stopMcp: () => invoke<void>("stop_mcp"),
  mcpConnection: () => invoke<McpConnection | null>("mcp_connection"),
  mcpDecision: (id: string, approved: boolean) => invoke<void>("mcp_decision", { id, approved }),
  mcpResult: (id: string, output: { result?: unknown; error?: string }) => invoke<void>("mcp_result", { id, output }),
  buildVersion: () => invoke<string>("build_version"),
  readSettingsArchive: (title: string) => invoke<string | null>("read_settings_archive", { title }),
  writeSettingsArchive: (title: string, contents: string) => invoke<boolean>("write_settings_archive", { title, contents }),
  readWindowsSettings: () => invoke<{ preferences: object | null; settingsError: string | null; updateError: string | null } | null>("read_windows_settings"),
  saveWindowsPreferences: (preferences: object, onlyIfMissing = false) =>
    invoke<boolean>("save_windows_preferences", { preferences, onlyIfMissing }),
  errorLog: () => invoke<string | null>("error_log"),
  clearErrorLog: () => invoke<void>("clear_error_log"),
  checkForUpdate: (trigger: "automatic" | "manual") => invoke<AppUpdate | null>("check_for_update", { trigger }),
  installedRelease: () => invoke<InstalledRelease>("installed_release"),
  acknowledgeRelease: () => invoke<void>("acknowledge_release"),
  openToolWindow: (title: string, size?: { width: number; height: number }, comparison?: { left: NamedFile; right: NamedFile },
    initialPage?: import("./featureOptions").FeaturePage) =>
    invoke<void>("open_tool_window", { title, ...size, comparison, initialPage }),
  setAppearancePicker: (picking: boolean) => invoke<void>("set_appearance_picker", { picking }),
  pickScreenColor: () => invoke<string | null>("pick_screen_color"),
  installUpdate: (version: string, onProgress: Channel<UpdateProgress>) =>
    invoke<void>("install_update", { version, onProgress }),
  locations: () => invoke<QuickLocation[]>("locations"),
  spaceMount: (path: string) => invoke<{ path: string; share: boolean }>("space_mount", { path }),
  volumeInformation: (path: string) => invoke<VolumeInformation>("volume_information", { path }),
  scanLocalSpace: (root: string, id: string, output: Channel<SpaceScanEvent>) =>
    invoke<void>("scan_local_space", { root, id, output }),
  cancelSpaceScan: (id: string) => invoke<void>("cancel_space_scan", { id }),
  gitRepository: (path: string) => invoke<GitRepository>("git_repository", { path }),
  gitHistory: (root: string, tip: string, offset: number) => invoke<GitHistory>("git_history", { root, tip, offset }),
  gitCommitGraph: (root: string, tip: string, search: string) =>
    invoke<string>("git_commit_graph", { root, tip, search }),
  gitFileHistory: (root: string, tip: string, path: string, offset: number) =>
    invoke<GitHistory>("git_file_history", { root, tip, path, offset }),
  gitFileBlame: (root: string, tip: string, path: string) =>
    invoke<string>("git_file_blame", { root, tip, path }),
  gitDetails: (root: string, hash: string) => invoke<GitDetails>("git_details", { root, hash }),
  gitUpdateBranch: (root: string, request: GitBranchRequest) =>
    invoke<GitRepository>("git_update_branch", { root, request }),
  gitCompareRevisions: (root: string, base: string, target: string) =>
    invoke<GitComparison>("git_compare_revisions", { root, base, target }),
  gitRevisionHistory: (root: string, included: string, excluded: string, offset: number) =>
    invoke<GitHistory>("git_revision_history", { root, included, excluded, offset }),
  gitRevisionDiff: (root: string, base: string, target: string, path: string, previousPath: string | null) =>
    invoke<GitRevisionDiff>("git_revision_diff", { root, base, target, path, previousPath }),
  gitIndexState: (root: string) => invoke<GitWorkingIndex>("git_index_state", { root }),
  gitUpdateIndex: (root: string, expected: GitIndexSnapshot, change: GitWorkingChange, action: GitIndexAction, replace: boolean) =>
    invoke<void>("git_update_index", { root, expected, change, action, replace }),
  gitCommitChanges: (root: string, expected: GitIndexSnapshot, message: string) =>
    invoke<string>("git_commit_changes", { root, expected, message }),
  gitWorkingDiff: (root: string, change: GitWorkingChange) => invoke<GitWorkingDiff>("git_working_diff", { root, change }),
  environmentScope: (scope: EnvironmentScope) => invoke<{ rows: EnvironmentRow[]; info: EnvironmentInfo }>("environment_scope", { scope }),
  environmentValue: (scope: EnvironmentScope, name: string) => invoke<EnvironmentValue | null>("environment_value", { scope, name }),
  saveEnvironment: (scope: EnvironmentScope, edits: EnvironmentEdit[], integrate = false) =>
    invoke<EnvironmentSave>("save_environment", { scope, edits, integrate }),
  requestedLocation: () => invoke<string | null>("requested_location"),
  listProcesses: () => invoke<ProcessInfo[]>("list_processes"),
  processIcons: (ids: ProcessId[]) => invoke<(string | null)[]>("process_icons", { ids }),
  streamSortSupported: (directory: string) => invoke<boolean>("stream_sort_supported", { directory }),
  panelMetadata: (items: PanelMetadataRequest[]) => invoke<PanelMetadata[]>("panel_metadata", { items }),
  fileIcons: (items: { directory: string; name: string }[]) => invoke<(string | null)[]>("file_icons", { items }),
  terminateProcesses: (ids: ProcessId[]) => invoke<string[]>("terminate_processes", { ids }),
  lockingProcesses: (paths: string[], progress?: (update: { checked: number; processes: ProcessInfo[] }) => void) =>
    invoke<{ processes: ProcessInfo[]; incomplete: boolean }>("locking_processes", {
      paths, output: new Channel(progress),
    }),
  windowsItemMenu: (directory: string, name?: string) => invoke<boolean>("windows_item_menu", { directory, name }),
  openElevated: (workspace: AdministratorWorkspace) => invoke<boolean>("open_elevated", { workspace }),
  windowsStartup: () => invoke<{ administrator: boolean; handoff: boolean; workspace: AdministratorWorkspace | null; workspaceUnavailable: boolean } | null>("windows_startup"),
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
  createRemoteFolder: (place: FileServerPlace, name: string, sudoPassword?: string) =>
    invoke<void>(place.kind === "ftp" ? "create_ftp_folder" : "create_ssh_folder",
      { id: place.id, segments: [...place.segments, name], sudoPassword }),
  createRemoteTextFile: (place: FileServerPlace, name: string, encoding: TextEncoding, sudoPassword?: string) =>
    invoke<void>(place.kind === "ftp" ? "create_ftp_text_file" : "create_ssh_text_file",
      { id: place.id, segments: [...place.segments, name], encoding, sudoPassword }),
  archiveCapabilities: () => invoke<{ formats: string[]; sfx: boolean }>("archive_capabilities"),
  createArchive: (id: number, request: CreateArchive, output: Channel<number>) =>
    invoke<{ paths: string[]; warning: string }>("create_archive", { id, request, output }),
  cancelArchive: (id: number) => invoke<void>("cancel_archive", { id }),
  closeArchive: (id: number) => invoke<void>("close_archive", { id }),
  openArchive: (path: string, password?: string) =>
    invoke<{ id: number; path: string; parent: string; writable: boolean; canAdd: boolean; listing: Listing }>("open_archive", { path, password: password ?? null }),
  listArchive: (id: number, segments: string[]) => invoke<Listing>("list_archive", { id, segments }),
  readArchiveText: (id: number, segments: string[]) => invoke<TextDocument>("read_archive_text", { id, segments }),
  readArchiveBytes: (id: number, segments: string[], offset: number) => invoke<BytePage>("read_archive_bytes", { id, segments, offset }),
  saveArchiveText: (id: number, segments: string[], revision: string, text: string, encoding: TextEncoding) =>
    invoke<TextDocument>("save_archive_text", { id, segments, revision, text, encoding }),
  deleteArchiveEntries: (id: number, paths: string[][]) => invoke<void>("delete_archive_entries", { id, paths }),
  changeArchive: (id: number, archive: number, change: ArchiveChange, output: Channel<number>) =>
    invoke<void>("change_archive", { id, archive, change, output }),
  copyIntoArchive: (id: number, archive: ArchivePlace, sources: { directory: string; name: string }[],
    policy: ConflictPolicy, output: Channel<TransferEvent>) =>
    invoke<boolean[]>("copy_into_archive", { id, archive: archive.id, segments: archive.segments, sources, policy, output }),
  diskSpace: (path: string) => invoke<DiskSpace>("disk_space", { path }),
  connectSmb: (path: string, credentials: { username: string; password: string } | null, remember: boolean) =>
    invoke<SmbConnection>("connect_smb", { path, credentials, remember }),
  fileAttributes: (directory: string, name: string) =>
    invoke<FileAttributes>("file_attributes", { directory, name }),
  updateFileAttributes: (directory: string, name: string, changes: AttributeChange[]) =>
    invoke<FileAttributes>("update_file_attributes", { directory, name, changes }),
  operate: (directory: string, operation: Operation | { kind: "open_directory" }) =>
    invoke<void>("operate", { directory, operation }, operation.kind),
  prepareCollectionFolders: (directory: string, paths: string[][]) =>
    invoke<void>("prepare_collection_folders", { directory, paths }),
  connectSavedServer: (credential: string, segments?: string[]) =>
    invoke<Connection & { share: string; writable?: boolean }>("connect_saved_server", { credential, segments }),
  connect: (invitation: string) => invoke<Connection & { share: string; writable?: boolean }>("connect_server", { invitation }),
  listSavedComputerDrives: (credential: string) => invoke<ComputerDrive[]>("list_saved_computer_drives", { credential }),
  listConnectedComputerDrives: (id: number) => invoke<ComputerDrive[]>("list_connected_computer_drives", { id }),
  lanGroupStatus: () => invoke<LanGroupStatus>("lan_group_status"),
  setLanGroupWritable: (writable: boolean) => invoke<void>("set_lan_group_writable", { writable }),
  startLanGroup: (code?: string) => invoke<LanGroupStatus>("start_lan_group", { code }),
  copyLanGroupCode: () => invoke<void>("copy_lan_group_code"),
  leaveLanGroup: () => invoke<LanGroupStatus>("leave_lan_group"),
  lanGroupPeers: () => invoke<{ id: string; name: string; online: boolean }[]>("list_lan_group_peers"),
  listLanGroupDrives: (peer: string) => invoke<ComputerDrive[]>("list_lan_group_drives", { peer }),
  connectLanGroupPeer: (peer: string, segments: string[]) =>
    invoke<Connection & { share: string }>("connect_lan_group_peer", { peer, segments }),
  changeServerItem: (place: WritableServerPlace, relative: string[], change: LanChange) =>
    invoke<void>("change_lan_item", { id: place.id, segments: [...place.segments, ...relative], change }),
  saveServerText: (place: WritableServerPlace, name: string, revision: string, text: string) =>
    invoke<string>("save_lan_text", { id: place.id, segments: [...place.segments, name], revision, text }),
  activeComputerSharing: () => invoke<ComputerSharing | null>("active_desktop_share"),
  startComputerSharing: () => invoke<ComputerSharing>("start_desktop_computer_share"),
  stopComputerSharing: () => invoke<void>("stop_desktop_share"),
  verifyComputerPairing: (invitation: string) => invoke<string>("verify_computer_pairing", { invitation }),
  saveServerInvitation: (invitation: string) => invoke<string>("save_server_invitation", { invitation }),
  removeServerInvitation: (credential: string) => invoke<void>("remove_server_invitation", { credential }),
  disconnect: (id: number) => invoke<void>("disconnect_server", { id }),
  ftpProfiles: () => invoke<FtpProfile[]>("ftp_profiles"),
  ftpWindowsCodePage: () => invoke<number | null>("ftp_windows_code_page"),
  saveFtpProfile: (input: FtpProfileInput) =>
    invoke<string>("save_ftp_profile", { input }),
  testFtpConnection: (input: FtpProfileInput, signal?: AbortSignal) =>
    netBoxRequest(signal, (request) => invoke<void>("test_ftp_connection", { input, request })),
  removeFtpProfile: (id: string) => invoke<void>("remove_ftp_profile", { id }),
  connectFtp: (id: string, segments?: string[], remembered?: string[], signal?: AbortSignal) =>
    netBoxRequest(signal, (request) => invoke<ConnectedFileServer>("connect_ftp", { id, segments, remembered, request })),
  disconnectFtp: (id: number) => invoke<void>("disconnect_ftp", { id }),
  listFtp: (id: number, segments: string[], signal?: AbortSignal) =>
    netBoxRequest(signal, (request) => invoke<Listing>("list_ftp", { id, segments, request })),
  searchFtp: (id: number, request: { connection: number; segments: string[]; mask: string; showHidden: boolean },
    output: Channel<FtpSearchEvent>) => invoke<void>("search_ftp", { id, request, output }),
  cancelFtpSearch: (id: number) => invoke<void>("cancel_ftp_search", { id }),
  sshProfiles: () => invoke<SshProfile[]>("ssh_profiles"),
  saveSshProfile: (input: SshProfileInput) =>
    invoke<SshProfile>("save_ssh_profile", { input }),
  testSshConnection: (input: SshProfileInput, approvals: readonly SshHostVerification[], signal?: AbortSignal) =>
    netBoxRequest(signal, (request) => invoke<{ kind: "success" } | SshVerificationRequired>("test_ssh_connection", {
      input, approval: approvals[0], approvals, request,
    })),
  removeSshProfile: (id: string) => invoke<void>("remove_ssh_profile", { id }),
  connectSsh: (id: string, approvals?: readonly SshHostVerification[], segments?: string[], remembered?: string[], signal?: AbortSignal) =>
    netBoxRequest(signal, (request) =>
      invoke<SshConnection>("connect_ssh", { id, approval: approvals?.[0], approvals, segments, remembered, request })),
  disconnectSsh: (id: number) => invoke<void>("disconnect_ssh", { id }),
  listSsh: (id: number, segments: string[], sudoPassword?: string, reuseSudo?: boolean, signal?: AbortSignal) =>
    netBoxRequest(signal, (request) =>
      invoke<Listing & { elevated: boolean; segments?: string[] }>("list_ssh", { id, segments, sudoPassword, reuseSudo, request })),
  deleteSsh: (id: number, segments: string[], recursive: boolean, recycle: boolean, job: number, output: Channel<TransferEvent>) =>
    invoke<void>("delete_ssh", { id, request: { segments, recursive, recycle }, job, output }),
  renameFtp: (id: number, segments: string[], name: string) => invoke<void>("rename_ftp", { id, segments, name }),
  renameSsh: (id: number, segments: string[], name: string, sudoPassword?: string) =>
    invoke<void>("rename_ssh", { id, segments, name, sudoPassword }),
  deleteFtp: (id: number, segments: string[], recursive: boolean, recycle = false) =>
    invoke<void>("delete_ftp", { id, segments, recursive, recycle }),
  readFtpText: (id: number, segments: string[]) => invoke<TextDocument>("read_ftp_text", { id, segments }),
  readFtpBytes: (id: number, segments: string[], offset: number) =>
    invoke<BytePage>("read_ftp_bytes", { id, segments, offset }),
  saveFtpText: (id: number, segments: string[], revision: string, text: string) =>
    invoke<TextDocument>("save_ftp_text", { id, segments, revision, text }),
  readSshText: (id: number, segments: string[], sudoPassword?: string) => invoke<TextDocument>("read_ssh_text", { id, segments, sudoPassword }),
  readSshBytes: (id: number, segments: string[], offset: number, sudoPassword?: string) =>
    invoke<BytePage>("read_ssh_bytes", { id, segments, offset, sudoPassword }),
  saveSshText: (id: number, segments: string[], revision: string, text: string, sudoPassword?: string) =>
    invoke<TextDocument>("save_ssh_text", { id, segments, revision, text, sudoPassword }),
  listServer: (id: number, segments: string[]) =>
    invoke<Listing>("list_server", { id, segments }),
  readText: (directory: string, name: string, surface?: TextReadSurface) =>
    invoke<TextDocument>("read_text", { directory, name, surface }),
  openLocalTextPages: (directory: string, name: string, editing: boolean) =>
    invoke<TextPages | null>("open_local_text_pages", { directory, name, editing }),
  openArchiveTextPages: (id: number, segments: string[], editing: boolean) =>
    invoke<TextPages | null>("open_archive_text_pages", { id, segments, editing }),
  openFtpTextPages: (id: number, segments: string[], editing: boolean) =>
    invoke<TextPages | null>("open_ftp_text_pages", { id, segments, editing }),
  openSshTextPages: (id: number, segments: string[], editing: boolean, sudoPassword?: string) =>
    invoke<TextPages | null>("open_ssh_text_pages", { id, segments, editing, sudoPassword }),
  openServerTextPages: (id: number, segments: string[]) =>
    invoke<TextPages | null>("open_server_text_pages", { id, segments }),
  readTextPage: (id: number, index: number) => invoke<TextPage>("read_text_page", { id, index }),
  editTextPage: (id: number, index: number, text: string) => invoke<boolean>("edit_text_page", { id, index, text }),
  saveTextPages: (id: number, sudoPassword?: string) => invoke<TextPages>("save_text_pages", { id, sudoPassword }),
  closeTextPages: (id: number) => invoke<void>("close_text_pages", { id }),
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
  openImageEdit: (directory: string, name: string) =>
    invoke<Size & { id: string; canReplace: boolean }>("open_image_edit", { directory, name }),
  readImageEdit: (id: string) => invoke<ArrayBuffer>("read_image_edit", { id }),
  saveImageEdit: (id: string, target: string | null, edit: ImageTransform) =>
    invoke<void>("save_image_edit", { id, target, edit }),
  closeImageEdit: (id: string) => invoke<void>("close_image_edit", { id }),
  kswitcherPeers: (directory: string) => invoke<KSwitcherPeer[]>("kswitcher_peers", { directory }),
  listKSwitcher: (directory: string, peer: string, path: string) =>
    invoke<Listing & { parent: string | null; drives?: ComputerDrive[] | null }>("list_kswitcher", { directory, peer, path }),
  kswitcherCapabilities: (peer: string) => invoke<KSwitcherCapabilities>("kswitcher_capabilities", { peer }),
  changeKSwitcher: (peer: string, path: string, change: KSwitcherChange) =>
    invoke<void>("change_kswitcher", { peer, path, change }),
  installedFonts: () => invoke<string[]>("installed_fonts"),
  computerName: () => invoke<string | null>("computer_name"),
  userMenuSources: (folder: string) => invoke<MenuSource[]>("user_menu_sources", { folder }),
  approveUserMenu: (source: MenuSourceVersion) => invoke<void>("approve_user_menu", { source }),
  saveUserMenu: (source: MenuSourceVersion, entries: MenuEntry[]) => invoke<MenuSource>("save_user_menu", { source, entries }),
  openTerminal: (session: TerminalSession, promptToken: string, rows: number, cols: number, output: Channel<TerminalOutput>) =>
    invoke<boolean>("open_terminal", { request: { id: session.id, directory: session.path, promptToken, rows, cols,
      refreshEnvironment: session.refreshEnvironment,
      userMenu: session.kind === "local" ? session.userMenu : undefined,
      ssh: session.kind === "ssh" ? { connection: session.connection, segments: session.segments } : undefined,
    }, output }),
  completeCommand: (line: string, caret: number, directory: string, refreshEnvironment: boolean, shellEnvironment?: ShellCompletionEnvironment) =>
    invoke<CommandCompletion>("complete_command", { request: { line, caret, directory, refreshEnvironment, shellEnvironment } }),
  completeSshTerminal: (id: number, line: string, caret: number, directory: string, searchPath: string, shellEnvironment?: ShellCompletionEnvironment) =>
    invoke<CommandCompletion>("complete_ssh_terminal", { id, request: { line, caret, directory, searchPath, shellEnvironment } }),
  completeSshCommand: (id: number, segments: string[], line: string, caret: number) =>
    invoke<CommandCompletion>("complete_ssh_command", { id, segments, line, caret }),
  writeTerminal: (id: number, data: string) => invoke<void>("write_terminal", { id, data }),
  resizeTerminal: (id: number, rows: number, cols: number) => invoke<void>("resize_terminal", { id, rows, cols }),
  closeTerminal: (id: number) => invoke<void>("close_terminal", { id }),
  measureFolders: (id: number, source: { kind: "local"; directory: string } |
    { kind: "ftp"; connection: number; segments: string[] } |
    { kind: "google_drive"; profile: string; folders: Record<string, string> }, names: string[], output: Channel<SizeResult>) =>
    invoke<void>("measure_folders", { id, source, names, output }),
  cancelMeasurement: (id: number) => invoke<void>("cancel_measurement", { id }),
  beginTransfer: (id: number, history?: { moving: boolean; source: string; destination: string; multipleDestinations: boolean }) =>
    invoke<void>("begin_transfer", { id, history }),
  fileOperationHistory: () => invoke<FileHistory>("file_operation_history"),
  reverseFileOperation: (direction: FileHistoryDirection, expected: number) =>
    invoke<FileHistory>("reverse_file_operation", { direction, expected }),
  deleteSelection: (id: number, selection: Deletion, onProgress: Channel<DeletionEvent>) =>
    invoke<DeletionResult>("delete_selection", { id, ...selection, onProgress }),
  cancelDeletion: (id: number) => invoke<void>("cancel_deletion", { id }),
  resolveDeletion: (id: number, token: number, decision: DeletionDecision) =>
    invoke<void>("resolve_deletion", { id, token, decision }),
  cancelTransfer: (id: number) => invoke<void>("cancel_transfer", { id }),
  finishTransfer: (id: number) => invoke<void>("finish_transfer", { id }),
  resolveTransfer: (id: number, decision: "overwrite" | "overwrite_all" | "skip", remember: boolean) =>
    invoke<void>("resolve_transfer", { id, decision, remember }),
  authorizeTransferSudo: (id: number, ticket: string, password: string) =>
    invoke<void>("authorize_transfer_sudo", { id, ticket, password }),
  declineTransferSudo: (id: number, ticket: string) =>
    invoke<void>("decline_transfer_sudo", { id, ticket }),
  transfer: (id: number, request: {
    source: TransferSource; destination: string; ftpDestination?: number; sshDestination?: number; serverDestination?: number;
    archiveDestination?: Pick<ArchivePlace, "id" | "segments">;
    googleDriveDestination?: { profile: string; parent: string };
    kswitcherDestination?: string; kswitcherBroker?: boolean; multiple: boolean; moving: boolean;
    policy: ConflictPolicy; askReadOnly: boolean; retry?: boolean; copyOptions?: CopyOptions;
  }, output: Channel<TransferEvent>) => invoke<TransferOutcome>("transfer_item", { id, request, output }),
};

export function placePath(place: Place) {
  if (place.kind === "googleDrive") return [t("My Drive"), ...place.folders.map(({ name }) => name)].join("/");
  if (place.kind === "server" || isFileServer(place)) return "/" + place.segments.join("/");
  if (place.kind === "archive") return place.path + "!/" + place.segments.join("/");
  return place.kind === "connections" ? connectionSourceNames[place.source] : place.path;
}

export function placeAddress(place: Place) {
  return place.kind === "local" && place.smb ? mountedSmbPath(place.path, place.smb) : placePath(place);
}

export function documentPath({ place, name }: NamedFile) {
  if (place.kind === "server" || isFileServer(place)) {
    return place.origin + "/" + [...place.segments, name].map(encodeURIComponent).join("/");
  }
  if (place.kind === "kswitcher") return "kswitcher://" + encodeURIComponent(place.peer) + "/" +
    kswitcherPath(place.path, name).split(/[/\\]/).map(encodeURIComponent).join("/");
  if (place.kind === "local") {
    if (place.smb) return mountedSmbPath(place.path, place.smb) + "/" + encodeURIComponent(name);
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
    return { place: { kind: "local", path, parent, smb: result.mount }, listing: result.listing };
  }
  const entries = result.names.map((name) => ({ name, directory: true, link: false, hidden: false, size: null, modified: null }));
  return { place: { kind: "smbRoot", path: result.server }, listing: { entries, omitted: 0 } };
}

export function mountedSmbPath(path: string, mount: SmbMount) {
  const segments = path.slice(mount.root.length).split("/").filter(Boolean).map(encodeURIComponent);
  return [mount.share, ...segments].join("/");
}

export async function connectFtpLocation(profileId: string, segments?: string[], remembered?: string[], signal?: AbortSignal) {
  const { listing, unavailableFolders, ...location } = await api.connectFtp(profileId, segments, remembered, signal);
  const place: FtpPlace = { kind: "ftp", profileId, ...location };
  return { place, listing, unavailableFolders };
}

type TextReadSurface = "viewer" | "editor" | "compare" | "sort_metadata" | "mcp";

export function openPlaceTextPages({ place, name }: NamedFile, editing: boolean, sudoPassword?: string) {
  if (place.kind === "local") return api.openLocalTextPages(place.path, name, editing);
  if (place.kind === "kswitcher" || place.kind === "googleDrive") return Promise.resolve(null);
  const segments = [...place.segments, name];
  if (place.kind === "archive") return api.openArchiveTextPages(place.id, segments, editing);
  if (place.kind === "ftp") return api.openFtpTextPages(place.id, segments, editing);
  if (place.kind === "ssh") return api.openSshTextPages(place.id, segments, editing, sudoPassword);
  return api.openServerTextPages(place.id, segments);
}

export function readPlaceText(file: NamedFile, sudoPassword?: string, surface?: TextReadSurface) {
  const { place, name } = file;
  if (place.kind === "local") return api.readText(place.path, name, surface);
  if (place.kind === "googleDrive") return invoke<TextDocument>("read_google_drive_text", { id: place.id, item: file.driveItem });
  if (place.kind === "kswitcher") return invoke<TextDocument>("read_kswitcher_text", {
    peer: place.peer, path: kswitcherPath(place.path, name),
  });
  const segments = [...place.segments, name];
  if (place.kind === "archive") return api.readArchiveText(place.id, segments);
  if (place.kind === "ssh") return api.readSshText(place.id, segments, sudoPassword);
  return place.kind === "ftp" ? api.readFtpText(place.id, segments) : api.readServerText(place.id, segments);
}

export function readPlacePreviewText(file: NamedFile, sudoPassword?: string) {
  const { place, name } = file;
  return place.kind === "local" ? invoke<TextDocument | { page: BytePage }>("read_text", {
    directory: place.path, name, surface: "quick_view",
  }) : readPlaceText(file, sudoPassword);
}

export function readPlacePreviewImage({ place, name, driveItem }: NamedFile, sudoPassword?: string) {
  if (place.kind === "googleDrive") return invoke<ArrayBuffer>("read_google_drive_image", { id: place.id, item: driveItem });
  if (place.kind === "kswitcher") return invoke<ArrayBuffer>("read_kswitcher_preview", { peer: place.peer, path: kswitcherPath(place.path, name) });
  const source = place.kind === "local" ? { kind: place.kind, directory: place.path, name }
    : { kind: place.kind, id: place.id, segments: [...place.segments, name] };
  return invoke<ArrayBuffer>("read_preview_image", { source, sudoPassword });
}

export async function savePlaceText({ place, name, driveItem }: NamedFile, document: TextDocument, text: string, sudoPassword?: string): Promise<TextDocument> {
  if (place.kind === "googleDrive") {
    if (!document.revision) throw new Error("Reopen the Google Drive file before saving again.");
    return invoke<TextDocument>("save_google_drive_text", { id: place.id, item: driveItem, revision: document.revision, encoding: document.encoding, text });
  }
  if (place.kind === "kswitcher") {
    if (!document.revision) throw new Error("Reopen the KSwitcher file before saving again.");
    return invoke<TextDocument>("save_kswitcher_text", { peer: place.peer, path: kswitcherPath(place.path, name),
      revision: document.revision, encoding: document.encoding, text });
  }
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
  if (place.kind === "server") {
    if (!isWritableServerPlace(place)) throw new Error("This source is read-only.");
    if (!document.revision) throw new Error("Reopen the shared file before saving again.");
    const revision = await api.saveServerText(place, name, document.revision, text);
    return { ...document, text, revision };
  }
  await api.saveText(place.path, name, document.text, text);
  return { ...document, text };
}

export function readPlaceBytes({ place, name, driveItem }: NamedFile, offset: number, sudoPassword?: string) {
  if (place.kind === "googleDrive") return invoke<BytePage>("read_google_drive_bytes", { id: place.id, item: driveItem, offset });
  if (place.kind === "local") return api.readBytes(place.path, name, offset);
  if (place.kind === "kswitcher") return invoke<BytePage>("read_kswitcher_bytes", { peer: place.peer, path: kswitcherPath(place.path, name), offset });
  const segments = [...place.segments, name];
  if (place.kind === "archive") return api.readArchiveBytes(place.id, segments, offset);
  if (place.kind === "ssh") return api.readSshBytes(place.id, segments, offset, sudoPassword);
  return place.kind === "ftp" ? api.readFtpBytes(place.id, segments, offset) : api.readServerBytes(place.id, segments, offset);
}

export function writableTextPlace(place: TextPlace) {
  if (place.kind === "kswitcher") return Boolean(place.capabilities?.write);
  return place.kind === "server" ? isWritableServerPlace(place) : place.kind !== "archive" || place.writable;
}

let nextDirectoryWatch = 0;

export function watchDirectory(path: string, onChange: () => void, name?: string, recursive = false) {
  const id = ++nextDirectoryWatch;
  const changes = new Channel<null>();
  changes.onmessage = onChange;
  const ready = invoke<void>("watch_directory", { id, path, name: name ?? null, recursive, changes });
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
  if (place.kind === "googleDrive") return place.folders.at(-1)?.name ?? t("My Drive");
  if (place.kind === "connections") return connectionSourceNames[place.source];
  if (place.kind === "server" || isFileServer(place)) return place.segments.at(-1) ?? place.address;
  if (place.kind === "archive" && place.segments.length) return place.segments.at(-1)!;
  if (place.kind === "kswitcher" && !place.path) return place.address;
  if (place.kind === "smbRoot" && /^smb:\/\//i.test(place.path)) return smbHost(place) ?? place.path;
  if (place.kind === "local" && place.smb?.root === place.path) {
    return decodeURIComponent(place.smb.share.slice(place.smb.share.lastIndexOf("/") + 1));
  }
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
  const url = place?.kind === "local" ? place.smb?.server :
    place?.kind === "smbRoot" && /^smb:\/\//i.test(place.path) ? place.path : undefined;
  if (url) {
    try { return new URL(url).host; } catch { return undefined; }
  }
  return place?.kind === "local" || place?.kind === "smbRoot" ? uncParts(place.path)[0] : undefined;
}

export function describeError(error: unknown) {
  reportFrontendError("desktop_action", error);
  return error instanceof Error ? error.message : String(error);
}
