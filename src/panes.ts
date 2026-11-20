import { api, smbLocation, uncParts, windowsClient, type Entry, type FilePlace, type Listing, type Place, type SizeResult } from "./api";
import { locale, t } from "./i18n";

export type Side = "left" | "right";
export type SortColumn = "name" | "size" | "modified" | "time";

export interface SearchMatch {
  directory: Place;
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
  marked: string[];
  keyboardRange?: { anchor: string; head: string; marking: boolean; changed: string[] };
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
  search: SearchResults | null;
  sort: { column: SortColumn; asc: boolean };
}

export const emptyPane: PaneState = {
  place: null, entries: [], selected: null, marked: [], sizes: new Map(), measuring: [], history: [], position: -1,
  filter: "", loading: false, omitted: 0, error: "", search: null, sort: { column: "name", asc: true },
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function hasParentRow(place: Place | null) {
  // The KSwitcher drive list is a source chooser, outside the drive itself.
  return place !== null && !(place.kind === "kswitcher" && place.parent === "") && parentPlace(place) !== null;
}

export function folderMeasurement(pane: PaneState, entry: Entry) {
  return entry.directory && !entry.link && !pane.search ? pane.sizes.get(entry.name) : undefined;
}

export function visibleEntries(pane: PaneState, hidden: boolean) {
  const filter = pane.filter.toLocaleLowerCase();
  const { column, asc } = pane.sort;
  const entries = pane.search
    ? Array.from(pane.search.matches.values(), ({ entry, relativePath }) => ({ ...entry, name: relativePath }))
    : pane.entries;
  const visible = entries
    .filter((entry) => (hidden || !entry.hidden) && (!filter || entry.name.toLocaleLowerCase().includes(filter)))
    .sort((a, b) => {
      if (a.directory !== b.directory) return a.directory ? -1 : 1;
      const byName = collator.compare(a.name, b.name);
      const metric = (entry: Entry) => column === "size" ? (folderMeasurement(pane, entry)?.bytes ?? entry.size) : entry.modified;
      const order = column === "name" ? byName : (metric(a) ?? -1) - (metric(b) ?? -1) || byName;
      return asc ? order : -order;
    });
  if (!pane.search && hasParentRow(pane.place)) {
    visible.unshift({ name: "..", directory: true, link: false, hidden: false, size: null, modified: null });
  }
  return visible;
}

export function paneCursorIndex(pane: PaneState, entries: readonly Entry[]) {
  const selected = entries.findIndex((entry) => entry.name === pane.selected);
  if (selected >= 0 || !entries.length) return selected;
  // Keep the initial cursor on the first item in existing non-FTP listings.
  return entries[0].name === ".." && entries.length > 1 && pane.place?.kind !== "ftp" ? 1 : 0;
}

export function selectableRange(entries: readonly Entry[], first: number, last: number) {
  return entries.slice(Math.min(first, last), Math.max(first, last) + 1)
    .map(({ name }) => name).filter((name) => name !== "..");
}

export function extendKeyboardRange(pane: PaneState, entries: readonly Entry[], from: number, to: number): PaneState {
  if (from === to) return pane;
  const previous = pane.keyboardRange;
  const anchor = previous && previous.head === pane.selected ? entries.findIndex(({ name }) => name === previous.anchor) : -1;
  const start = anchor < 0 ? from : anchor;
  const head = entries[to].name;
  const marking = anchor >= 0 && previous ? previous.marking : !pane.marked.includes(head);
  const marked = new Set(pane.marked);
  // Undo just the changes from the previous span, then apply the new span.
  if (anchor >= 0 && previous) {
    for (const name of previous.changed) {
      if (marking) marked.delete(name);
      else marked.add(name);
    }
  }
  const changed = selectableRange(entries, start, to).filter((name) => marked.has(name) !== marking);
  for (const name of changed) {
    if (marking) marked.add(name);
    else marked.delete(name);
  }
  return { ...pane, selected: head, marked: [...marked], keyboardRange: { anchor: entries[start].name, head, marking, changed } };
}

export function showSearchResults(pane: PaneState, mask: string, matches: readonly SearchMatch[], incomplete: boolean, selected: string) {
  const previous = pane.search?.previous ?? { selected: pane.selected, marked: pane.marked, filter: pane.filter };
  return {
    ...pane, selected, marked: [], keyboardRange: undefined, filter: "", error: "",
    search: { mask, matches: new Map(matches.map((match) => [match.relativePath, match])), incomplete, previous },
  };
}

export function closeSearchResults(pane: PaneState): PaneState {
  return pane.search ? { ...pane, ...pane.search.previous, keyboardRange: undefined, search: null } : pane;
}

export function paneItem(pane: PaneState, entry?: Entry): { place: FilePlace; entry: Entry } | null {
  if (!entry || entry.name === ".." || !pane.place || pane.place.kind === "smbRoot") return null;
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

export function filesystemPlace(path: string): Place {
  const [host, share] = uncParts(path);
  return host && !share ? { kind: "smbRoot", path: "\\\\" + host } : localPath(path);
}

export function childPlace(place: Place, name: string): Place {
  if (place.kind === "server" || place.kind === "ftp" || place.kind === "archive") return { ...place, segments: [...place.segments, name] };
  if (place.kind === "kswitcher") {
    const path = place.path ? place.path + (place.path.endsWith("\\") ? "" : "\\") + name : name + "\\";
    return { ...place, path, parent: null };
  }
  const separator = windowsClient ? "\\" : "/";
  return localPath(place.path + (place.path.endsWith(separator) ? "" : separator) + name);
}

export function parentPlace(place: Place): Place | null {
  if (place.kind === "archive") return place.segments.length
    ? { ...place, segments: place.segments.slice(0, -1) } : localPath(place.parent);
  if (place.kind === "server" || place.kind === "ftp") {
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

export async function readPlace(place: Place): Promise<{ place: Place; listing: Listing }> {
  if (place.kind === "archive") return { place, listing: await api.listArchive(place.id, place.segments) };
  if (place.kind === "ftp") return { place, listing: await api.listFtp(place.id, place.segments) };
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

export function applyListing(pane: PaneState, place: Place, listing: Listing, action: "push" | "refresh" | "background" | number): PaneState {
  if ((action === "refresh" || action === "background") && pane.search) {
    const updated = applyListing(closeSearchResults(pane), place, listing, action);
    return { ...updated, selected: pane.selected, marked: pane.marked, keyboardRange: pane.keyboardRange, filter: pane.filter,
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
  const keyboardRange = pane.keyboardRange;
  const history = action === "push" && !samePlace
    ? [...pane.history.slice(0, pane.position + 1), place]
    : pane.history;
  return {
    ...pane,
    place,
    entries: listing.entries,
    omitted: listing.omitted,
    selected: samePlace && pane.selected &&
      (pane.selected === ".." ? hasParentRow(place) : current.has(pane.selected)) ? pane.selected : null,
    marked: samePlace ? pane.marked.filter((name) => current.has(name)) : [],
    keyboardRange: samePlace && keyboardRange ? { ...keyboardRange, changed: keyboardRange.changed.filter((name) => current.has(name)) } : undefined,
    sizes: new Map([...pane.sizes].filter(([name]) => unchangedFolders.has(name))),
    measuring: pane.measuring.filter((name) => unchangedFolders.has(name)),
    filter: samePlace ? pane.filter : "",
    history,
    position: typeof action === "number" ? action : history === pane.history ? pane.position : history.length - 1,
    loading: false,
    loadingPath: undefined,
    error: "",
    elevationPath: undefined,
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
