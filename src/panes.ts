import { api, isFileServer, placePath, smbLocation, uncParts, windowsClient, type Entry, type FileLocation, type FilePlace, type Listing, type Place, type SizeResult, type SshPlace } from "./api";
import { locale, t } from "./i18n";
import { connectionEntries } from "./savedConnections";

export type Side = "left" | "right";
import { compareFileEntries, defaultFileSort, sortMode, type FileSort, type SortMode, type SortSettings } from "./fileSort";
import type { PanelMetadata } from "./api";
export type { SortColumn } from "./fileSort";
export type ListingAction = "push" | "refresh" | number;

export interface DeniedSshListing {
  place: SshPlace;
  action: ListingAction;
  reveal?: string;
}

export interface SearchMatch {
  directory: FileLocation;
  entry: Entry;
  relativePath: string;
}

interface SearchResults {
  mask: string;
  matches: ReadonlyMap<string, SearchMatch>;
  incomplete: boolean;
  previous: Pick<PaneState, "selected" | "marked" | "filter">;
}

export interface PaneState {
  place: Place | null;
  entries: Entry[];
  selected: string | null;
  revealedHidden?: string;
  marked: string[];
  sizes: ReadonlyMap<string, SizeResult>;
  measuring: string[];
  history: Place[];
  position: number;
  filter: string;
  loading: boolean;
  loadingPath?: string;
  addressRevision?: number;
  omitted: number;
  error: string;
  elevationPath?: string;
  deniedSshListing?: DeniedSshListing;
  sudoListing?: boolean;
  search: SearchResults | null;
  sort: FileSort;
}

export const emptyPane: PaneState = {
  place: null, entries: [], selected: null, marked: [], sizes: new Map(), measuring: [], history: [], position: -1,
  filter: "", loading: false, omitted: 0, error: "", search: null, sort: defaultFileSort,
};



export function hasParentRow(place: Place | null) {
  if (place?.kind === "connections") return true;
  // The KSwitcher drive list is a source chooser, outside the drive itself.
  return place !== null && !(place.kind === "kswitcher" && place.parent === "") && parentPlace(place) !== null;
}

export function folderMeasurement(pane: PaneState, entry: Entry) {
  return entry.directory && !entry.link && !pane.search ? pane.sizes.get(entry.name) : undefined;
}

export function visibleEntries(pane: PaneState, hidden: boolean, settings: SortSettings,
  canSort: (mode: SortMode) => boolean, metadata: ReadonlyMap<string, PanelMetadata>, descriptions: ReadonlyMap<string, string>, pending: boolean) {
  const filter = pane.filter.toLocaleLowerCase();
  const chosen = sortMode(pane.sort.column);
  const available = canSort(chosen) && !pending;
  const sort = available ? pane.sort : { ...pane.sort, asc: true };
  const entries = pane.search
    ? Array.from(pane.search.matches.values(), ({ entry, relativePath }) => ({ ...entry, name: relativePath }))
    : pane.entries;
  const visible = compareFileEntries(
    entries.filter((entry) => (hidden || !entry.hidden || entry.name === pane.revealedHidden && entry.name === pane.selected) &&
      (!filter || entry.name.toLocaleLowerCase().includes(filter))),
    sort, available ? chosen : "name", settings, pane.marked,
    (entry) => pane.search?.matches.get(entry.name)?.entry.name ?? entry.name,
    (entry, field) => {
      switch (field) {
        case "modified": return entry.modified;
        case "size": return folderMeasurement(pane, entry)?.bytes ?? entry.size;
        case "description": return entry.description ?? descriptions.get(entry.name);
        case "hardLinks": return entry.directory || entry.link ? undefined : entry.hardLinks ?? metadata.get(entry.name)?.hardLinks;
        case "owner":
        case "created":
        case "accessed":
        case "changed":
        case "allocated":
        case "streamCount":
        case "streamSize":
          return entry[field] ?? metadata.get(entry.name)?.[field];
        default: return undefined;
      }
    },
  );
  if (!pane.search && hasParentRow(pane.place)) {
    visible.unshift({ name: "..", directory: true, link: false, hidden: false, size: null, modified: null });
  }
  return visible;
}

export function paneCursorIndex(pane: PaneState, entries: readonly Entry[]) {
  const selected = entries.findIndex((entry) => entry.name === pane.selected);
  if (selected >= 0 || !entries.length) return selected;
  return entries[0].name === ".." && entries.length > 1 && !isFileServer(pane.place) ? 1 : 0;
}

export function selectableRange(entries: readonly Entry[], first: number, last: number) {
  return entries.slice(Math.min(first, last), Math.max(first, last) + 1)
    .map(({ name }) => name).filter((name) => name !== "..");
}

export function toggleMarkAndMoveCursor(pane: PaneState, entries: readonly Entry[], from: number, to: number): PaneState {
  const selected = entries[to].name;
  const { name } = entries[from];
  if (name === "..") return { ...pane, selected };
  const marked = pane.marked.includes(name)
    ? pane.marked.filter((item) => item !== name)
    : [...pane.marked, name];
  return { ...pane, selected, marked };
}

export function showSearchResults(pane: PaneState, mask: string, matches: readonly SearchMatch[], incomplete: boolean, selected: string) {
  const previous = pane.search?.previous ?? { selected: pane.selected, marked: pane.marked, filter: pane.filter };
  return {
    ...pane, selected, marked: [], filter: "", error: "",
    search: { mask, matches: new Map(matches.map((match) => [match.relativePath, match])), incomplete, previous },
  };
}

export function closeSearchResults(pane: PaneState): PaneState {
  return pane.search ? { ...pane, ...pane.search.previous, search: null } : pane;
}

export function paneItem(pane: PaneState, entry?: Entry): { place: FilePlace; entry: Entry } | null {
  if (!entry || entry.name === ".." || !pane.place || pane.place.kind === "smbRoot" || pane.place.kind === "connections") return null;
  if (pane.search) {
    const match = pane.search.matches.get(entry.name);
    return match && match.directory.kind !== "smbRoot" ? { place: match.directory, entry: match.entry } : null;
  }
  return { place: pane.place, entry };
}

export const opposite = (side: Side): Side => side === "left" ? "right" : "left";

export function localPath(path: string): Extract<Place, { kind: "local" }> {
  return { kind: "local", path, parent: null };
}

export function filesystemPlace(path: string): FileLocation {
  const [host, share] = uncParts(path);
  return host && !share ? { kind: "smbRoot", path: "\\\\" + host } : localPath(path);
}

export function childPlace(place: FileLocation, name: string): FileLocation {
  if (place.kind === "server" || isFileServer(place) || place.kind === "archive") return { ...place, segments: [...place.segments, name] };
  if (place.kind === "kswitcher") {
    const path = place.path ? place.path + (place.path.endsWith("\\") ? "" : "\\") + name : name + "\\";
    return { ...place, path, parent: null };
  }
  const separator = windowsClient ? "\\" : "/";
  return localPath(place.path + (place.path.endsWith(separator) ? "" : separator) + name);
}

export function parentPlace(place: Place): FileLocation | null {
  if (place.kind === "connections") return place.from;
  if (place.kind === "archive") return place.segments.length
    ? { ...place, segments: place.segments.slice(0, -1) } : localPath(place.parent);
  if (place.kind === "server" || isFileServer(place)) {
    return place.segments.length ? { ...place, segments: place.segments.slice(0, -1) } : null;
  }
  if (place.kind === "kswitcher") return place.parent === null ? null : { ...place, path: place.parent, parent: null };
  if (place.kind === "smbRoot") return null;
  const [host, share, folder] = uncParts(place.path);
  if (host && share && !folder) return { kind: "smbRoot", path: "\\\\" + host };
  return place.parent ? filesystemPlace(place.parent) : null;
}

export class SmbCredentialsRequired extends Error {
  constructor() { super(t("Enter your SMB credentials.")); }
}

function folderInAncestor(from: Place | null, to: Place) {
  if (!from || from.kind !== to.kind) return;
  if ((to.kind === "server" || isFileServer(to)) && (!("id" in from) || from.id !== to.id)) return;
  if (to.kind === "kswitcher" && (from.kind !== "kswitcher" || from.peer !== to.peer || from.directory !== to.directory)) return;
  const windowsPath = to.kind === "local" && windowsClient;
  const parts = (place: Place) => placePath(place).split(windowsPath ? /[\\/]/ : "/").filter(Boolean);
  const source = parts(from);
  const ancestor = parts(to);
  if (ancestor.length >= source.length) return;
  if (ancestor.every((part, index) => windowsPath ? part.toLowerCase() === source[index].toLowerCase() : part === source[index])) {
    return source[ancestor.length];
  }
}

type PlaceListing<Location extends Place> = { place: Location; listing: Listing; elevated?: boolean };
export function readPlace(place: FileLocation, sudoPassword?: string, reuseSudo?: boolean): Promise<PlaceListing<FileLocation>>;
export function readPlace(place: Place, sudoPassword?: string, reuseSudo?: boolean): Promise<PlaceListing<Place>>;
export async function readPlace(place: Place, sudoPassword?: string, reuseSudo?: boolean): Promise<PlaceListing<Place>> {
  if (place.kind === "connections") return { place, listing: { entries: await connectionEntries(place.source), omitted: 0 } };
  if (place.kind === "archive") return { place, listing: await api.listArchive(place.id, place.segments) };
  if (place.kind === "ftp") return { place, listing: await api.listFtp(place.id, place.segments) };
  if (place.kind === "ssh") {
    const { elevated, ...listing } = await api.listSsh(place.id, place.segments, sudoPassword, reuseSudo);
    return { place, listing, elevated };
  }
  if (place.kind === "server") return { place, listing: await api.listServer(place.id, place.segments) };
  if (place.kind === "kswitcher") {
    const listing = await api.listKSwitcher(place.directory, place.peer, place.path);
    return { place: { ...place, parent: listing.parent }, listing };
  }
  const unc = uncParts(place.path);
  if (place.kind === "smbRoot" || unc.length === 2) {
    const result = await api.connectSmb("\\\\" + unc.join("\\"), null, false);
    if (result.kind === "credentials_required") throw new SmbCredentialsRequired();
    return smbLocation(result);
  }
  const listing = await api.listLocal(place.path);
  return { place: { kind: "local", path: listing.path, parent: listing.parent }, listing };
}

function pushHistory(pane: PaneState, place: Place) {
  const history = [...pane.history.slice(0, pane.position + 1), place];
  if (place.kind !== "archive") return history;
  // Each distinct open archive retains a native index, file handle and possibly a password.
  const archives = new Set<number>();
  for (let i = history.length - 1; i >= 0 && archives.size < 8; i--) {
    const previous = history[i];
    if (previous.kind === "archive") archives.add(previous.id);
  }
  return history.filter((item) => item.kind !== "archive" || archives.has(item.id));
}

export function applyListing(pane: PaneState, place: Place, listing: Listing, action: "push" | "refresh" | "background" | number): PaneState {
  if ((action === "refresh" || action === "background") && pane.search) {
    const updated = applyListing(closeSearchResults(pane), place, listing, action);
    return { ...updated, selected: pane.selected, marked: pane.marked, filter: pane.filter,
      search: { ...pane.search, previous: { selected: updated.selected, marked: updated.marked, filter: updated.filter } } };
  }
  pane = closeSearchResults(pane);
  const samePlace = JSON.stringify(pane.place) === JSON.stringify(place);
  const current = new Map(listing.entries.map((entry) => [entry.name, entry]));
  const keepMeasurements = samePlace && action === "background";
  const unchangedFolders = new Set(keepMeasurements ? pane.entries.flatMap((entry) => {
    const next = current.get(entry.name);
    return entry.directory && !entry.link && next?.directory && !next.link && next.modified === entry.modified
      ? [entry.name] : [];
  }) : []);
  const departed = action === "refresh" || action === "background" ? undefined : folderInAncestor(pane.place, place);
  const history = action === "push" && !samePlace
    ? pushHistory(pane, place)
    : pane.history;
  return {
    ...pane,
    place,
    entries: listing.entries,
    omitted: listing.omitted,
    selected: samePlace && pane.selected &&
      (pane.selected === ".." ? hasParentRow(place) : current.has(pane.selected)) ? pane.selected : departed && current.has(departed) ? departed : null,
    revealedHidden: samePlace && pane.revealedHidden && current.has(pane.revealedHidden) ? pane.revealedHidden : undefined,
    marked: samePlace ? pane.marked.filter((name) => current.has(name)) : [],
    sizes: new Map([...pane.sizes].filter(([name]) => unchangedFolders.has(name))),
    measuring: pane.measuring.filter((name) => unchangedFolders.has(name)),

    filter: samePlace ? pane.filter : "",
    history,
    position: typeof action === "number" ? action : history === pane.history ? pane.position : history.length - 1,
    loading: false,
    loadingPath: undefined,
    error: "",
    elevationPath: undefined,
    deniedSshListing: undefined,
    sudoListing: undefined,
  };
}

type DatePart = "timestamp" | "date" | "time";
const formats = new Map<string, { number: Intl.NumberFormat } & Record<DatePart, Intl.DateTimeFormat>>();

function currentFormats() {
  const language = locale();
  let format = formats.get(language);
  if (!format) {
    format = {
      number: new Intl.NumberFormat(language, { maximumFractionDigits: 1 }),
      timestamp: new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" }),
      date: new Intl.DateTimeFormat(language, { dateStyle: "short" }),
      time: new Intl.DateTimeFormat(language, { timeStyle: "short" }),
    };
    formats.set(language, format);
  }
  return format;
}

export function formatSize(size: number | null) {
  if (size === null) return "–";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${currentFormats().number.format(size)} ${units[unit]}`;
}

export function formatDate(time: number | null, part: DatePart = "timestamp") {
  return time === null ? "–" : currentFormats()[part].format(new Date(time * 1000));
}
