import { api, windowsClient, type Entry, type Listing, type Place } from "./api";

export type Side = "left" | "right";
export type SortColumn = "name" | "size" | "modified";

export interface PaneState {
  place: Place | null;
  entries: Entry[];
  selected: string | null;
  marked: string[];
  history: Place[];
  position: number;
  filter: string;
  loading: boolean;
  omitted: number;
  error: string;
  sort: { column: SortColumn; asc: boolean };
}

export const emptyPane: PaneState = {
  place: null, entries: [], selected: null, marked: [], history: [], position: -1,
  filter: "", loading: false, omitted: 0, error: "", sort: { column: "name", asc: true },
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function visibleEntries(pane: PaneState, hidden: boolean) {
  const filter = pane.filter.toLocaleLowerCase();
  const { column, asc } = pane.sort;
  return pane.entries
    .filter((entry) => (hidden || !entry.hidden) && (!filter || entry.name.toLocaleLowerCase().includes(filter)))
    .sort((a, b) => {
      if (a.directory !== b.directory) return a.directory ? -1 : 1;
      const byName = collator.compare(a.name, b.name);
      const order = column === "name" ? byName : (a[column] ?? -1) - (b[column] ?? -1) || byName;
      return asc ? order : -order;
    });
}

export const opposite = (side: Side): Side => side === "left" ? "right" : "left";

export function localPath(path: string): Place {
  return { kind: "local", path, parent: null };
}

export function childPlace(place: Place, name: string): Place {
  if (place.kind === "server") return { ...place, segments: [...place.segments, name] };
  if (place.kind === "kswitcher") {
    const path = place.path ? place.path + (place.path.endsWith("\\") ? "" : "\\") + name : name + "\\";
    return { ...place, path, parent: null };
  }
  const separator = windowsClient ? "\\" : "/";
  return localPath(place.path + (place.path.endsWith(separator) ? "" : separator) + name);
}

export function parentPlace(place: Place): Place | null {
  if (place.kind === "server") {
    return place.segments.length ? { ...place, segments: place.segments.slice(0, -1) } : null;
  }
  if (place.kind === "kswitcher") return place.parent === null ? null : { ...place, path: place.parent, parent: null };
  return place.parent ? localPath(place.parent) : null;
}

export async function readPlace(place: Place): Promise<{ place: Place; listing: Listing }> {
  if (place.kind === "server") return { place, listing: await api.listServer(place.id, place.segments) };
  if (place.kind === "kswitcher") {
    const listing = await api.listKSwitcher(place.directory, place.peer, place.path);
    return { place: { ...place, parent: listing.parent }, listing };
  }
  const listing = await api.listLocal(place.path);
  return { place: { kind: "local", path: listing.path, parent: listing.parent }, listing };
}

export function applyListing(pane: PaneState, place: Place, listing: Listing, action: "push" | "refresh" | number): PaneState {
  const samePlace = JSON.stringify(pane.place) === JSON.stringify(place);
  const retained = new Set(listing.entries.map((entry) => entry.name));
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
    filter: samePlace ? pane.filter : "",
    history,
    position: typeof action === "number" ? action : history === pane.history ? pane.position : history.length - 1,
    loading: false,
    error: "",
  };
}

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

export function formatSize(size: number | null) {
  if (size === null) return "–";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${numberFormat.format(size)} ${units[unit]}`;
}

export function formatDate(time: number | null) {
  return time === null ? "–" : timeFormat.format(new Date(time * 1000));
}
