import { api, windowsClient, type Entry, type Listing, type Place, type SizeResult } from "./api";
import { locale } from "./i18n";

export type Side = "left" | "right";
export type SortColumn = "name" | "size" | "modified";

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
  sizes: ReadonlyMap<string, SizeResult>;
  measuring: string[];
  history: Place[];
  position: number;
  filter: string;
  loading: boolean;
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
      const metric = (entry: Entry) => column === "size" ? (pane.sizes.get(entry.name)?.bytes ?? entry.size) : entry.modified;
      const order = column === "name" ? byName : (metric(a) ?? -1) - (metric(b) ?? -1) || byName;
      return asc ? order : -order;
    });
  if (!pane.search && pane.place?.kind === "ftp" && pane.place.segments.length) {
    visible.unshift({ name: "..", directory: true, link: false, hidden: false, size: null, modified: null });
  }
  return visible;
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

export function paneItem(pane: PaneState, entry?: Entry): { place: Place; entry: Entry } | null {
  if (!entry || entry.name === ".." || !pane.place) return null;
  if (pane.search) {
    const match = pane.search.matches.get(entry.name);
    return match ? { place: match.directory, entry: match.entry } : null;
  }
  return { place: pane.place, entry };
}

export const opposite = (side: Side): Side => side === "left" ? "right" : "left";

export function localPath(path: string): Place {
  return { kind: "local", path, parent: null };
}

export function childPlace(place: Place, name: string): Place {
  if (place.kind === "server" || place.kind === "ftp") return { ...place, segments: [...place.segments, name] };
  if (place.kind === "kswitcher") {
    const path = place.path ? place.path + (place.path.endsWith("\\") ? "" : "\\") + name : name + "\\";
    return { ...place, path, parent: null };
  }
  const separator = windowsClient ? "\\" : "/";
  return localPath(place.path + (place.path.endsWith(separator) ? "" : separator) + name);
}

export function parentPlace(place: Place): Place | null {
  if (place.kind === "server" || place.kind === "ftp") {
    return place.segments.length ? { ...place, segments: place.segments.slice(0, -1) } : null;
  }
  if (place.kind === "kswitcher") return place.parent === null ? null : { ...place, path: place.parent, parent: null };
  return place.parent ? localPath(place.parent) : null;
}

export async function readPlace(place: Place): Promise<{ place: Place; listing: Listing }> {
  if (place.kind === "ftp") return { place, listing: await api.listFtp(place.id, place.segments) };
  if (place.kind === "server") return { place, listing: await api.listServer(place.id, place.segments) };
  if (place.kind === "kswitcher") {
    const listing = await api.listKSwitcher(place.directory, place.peer, place.path);
    return { place: { ...place, parent: listing.parent }, listing };
  }
  const listing = await api.listLocal(place.path);
  return { place: { kind: "local", path: listing.path, parent: listing.parent }, listing };
}

export function applyListing(pane: PaneState, place: Place, listing: Listing, action: "push" | "refresh" | number): PaneState {
  if (action === "refresh" && pane.search) {
    const updated = applyListing(closeSearchResults(pane), place, listing, action);
    return { ...updated, selected: pane.selected, marked: pane.marked, filter: pane.filter,
      search: { ...pane.search, previous: { selected: updated.selected, marked: updated.marked, filter: updated.filter } } };
  }
  pane = closeSearchResults(pane);
  const samePlace = JSON.stringify(pane.place) === JSON.stringify(place);
  const retained = new Set(listing.entries.map((entry) => entry.name));
  if (place.kind === "ftp" && place.segments.length) retained.add("..");
  const history = action === "push" && !samePlace
    ? [...pane.history.slice(0, pane.position + 1), place]
    : pane.history;
  return {
    ...pane,
    place,
    entries: listing.entries,
    omitted: listing.omitted,
    selected: samePlace && pane.selected && retained.has(pane.selected) ? pane.selected : null,
    marked: samePlace ? pane.marked.filter((name) => retained.has(name)) : [],
    sizes: samePlace ? new Map([...pane.sizes].filter(([name]) => retained.has(name))) : new Map(),
    measuring: samePlace ? pane.measuring : [],
    filter: samePlace ? pane.filter : "",
    history,
    position: typeof action === "number" ? action : history === pane.history ? pane.position : history.length - 1,
    loading: false,
    error: "",
    elevationPath: undefined,
  };
}

const formats = new Map<string, { number: Intl.NumberFormat; time: Intl.DateTimeFormat }>();

function currentFormats() {
  const language = locale();
  let format = formats.get(language);
  if (!format) {
    format = {
      number: new Intl.NumberFormat(language, { maximumFractionDigits: 1 }),
      time: new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" }),
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

export function formatDate(time: number | null) {
  return time === null ? "–" : currentFormats().time.format(new Date(time * 1000));
}
