import { api, describeError, folderLabel, isFileServer, placePath, type FileLocation, type Listing, type Place } from "./api";
import { childPlace, localPath, readPlace } from "./panes";

export type SpacePlace = Exclude<FileLocation, { kind: "archive" | "smbRoot" }>;
export type Metric = "allocated" | "logical";
export type Scope = { place: SpacePlace; kind: "volume" | "share" | "connection" };

export function canAnalyze(place: Place | null): place is SpacePlace {
  if (!place) return false;
  if (place.kind === "kswitcher") return !!place.path;
  return place.kind === "local" || place.kind === "server" || isFileServer(place);
}

export async function containingScope(place: SpacePlace): Promise<Scope | null> {
  if (place.kind === "local") {
    const mount = await api.spaceMount(place.path);
    return { kind: mount.share ? "share" : "volume", place: localPath(mount.path) };
  }
  if (place.kind === "server" || isFileServer(place)) {
    return { kind: place.kind === "server" ? "share" : "connection", place: { ...place, segments: [] } };
  }
  const drive = /^[a-z]:[\\/]/i.exec(place.path)?.[0];
  return drive ? { kind: "share", place: { ...place, path: drive, parent: "" } } : null;
}

export function spacePath(place: SpacePlace) {
  return place.kind === "server" || isFileServer(place) ? place.origin + placePath(place)
    : place.kind === "kswitcher" ? place.address + " · " + place.path : place.path;
}

export interface SpaceNode {
  id: number;
  name: string;
  directory: boolean;
  parent: SpaceNode | null;
  children: SpaceNode[];
  logical: number;
  allocated: number;
  missingLogical: number;
  missingAllocated: number;
  pending: number;
  partial: boolean;
  shared: boolean;
  error: string;
}

export interface SpaceResult {
  root: SpaceNode;
  nodes: ReadonlyMap<number, SpaceNode>;
  supportsAllocation: boolean;
  phase: "scanning" | "complete" | "partial" | "error";
  error: string;
}

function node(id: number, name: string, directory: boolean, parent: SpaceNode | null): SpaceNode {
  return { id, name, directory, parent, children: [], logical: 0, allocated: 0, missingLogical: 0,
    missingAllocated: 0, pending: directory ? 1 : 0, partial: false, shared: false, error: "" };
}

export function initialSpaceResult(place: SpacePlace): SpaceResult {
  const root = node(0, folderLabel(place), true, null);
  return { root, nodes: new Map([[0, root]]), supportsAllocation: place.kind === "local", phase: "scanning", error: "" };
}

export function spaceLocation(root: SpacePlace, entry: SpaceNode): { place: SpacePlace; reveal?: string } {
  const reveal = entry.directory ? undefined : entry.name;
  const segments: string[] = [];
  for (let current = reveal === undefined ? entry : entry.parent; current?.parent; current = current.parent) {
    segments.push(current.name);
  }
  return { place: segments.reverse().reduce((place, name) => childPlace(place, name) as SpacePlace, root), reveal };
}

export function sortedSpaceChildren(entry: SpaceNode, metric: Metric) {
  return [...entry.children].sort((a, b) => b[metric] - a[metric] || a.name.localeCompare(b.name) || a.id - b.id);
}

export function spaceShare(entry: SpaceNode, metric: Metric) {
  const total = (entry.parent ?? entry)[metric];
  return total > 0 ? Math.min(1, entry[metric] / total) : 0;
}

export function unavailable(entry: SpaceNode, metric: Metric) {
  return metric === "allocated" ? entry.missingAllocated : entry.missingLogical;
}

function insideScope(name: string, windowsPaths: boolean) {
  return !!name && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0") &&
    (!windowsPaths || !name.includes("\\") && !name.includes(":"));
}

async function listSpace(root: SpacePlace, place: SpacePlace, segments: string[]) {
  if (root.kind === "local") return api.listSpaceDirectory(root.path, segments);
  return (await readPlace(place)).listing;
}

function connectionLost(error: string) {
  return /connect to the .* server first|could not reach the .* server|connection (?:closed|reset|refused|aborted|lost|error)|broken pipe|network is unreachable|timed out|unexpected eof|disconnected|error sending request/i.test(error);
}

function bytes(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export async function scanSpace(
  rootPlace: SpacePlace,
  signal: AbortSignal,
  report: (result: SpaceResult) => void,
  list = listSpace,
) {
  const result = initialSpaceResult(rootPlace);
  const nodes = new Map(result.nodes);
  result.nodes = nodes;
  const jobs = [{ entry: result.root, place: rootPlace, segments: [] as string[] }];
  const identities = new Set<string>();
  let allocatedFiles = 0;
  let files = 0;
  let lastReport = 0;
  let nextReport: ReturnType<typeof setTimeout> | undefined;
  function publish() {
    clearTimeout(nextReport);
    nextReport = undefined;
    if (signal.aborted) return;
    result.supportsAllocation = allocatedFiles > 0 || (rootPlace.kind === "local" && files === 0);
    lastReport = performance.now();
    report({ ...result });
  }
  publish();
  while (jobs.length && !signal.aborted) {
    const job = jobs.pop()!;
    const { entry, place, segments } = job;
    const children: typeof jobs = [];
    try {
      const listing: Listing = await list(rootPlace, place, segments);
      if (signal.aborted) return;
      entry.partial = listing.omitted > 0;
      const names = new Set<string>();
      for (const file of listing.entries) {
        if (file.link) continue;
        if (!insideScope(file.name, rootPlace.kind === "kswitcher") || names.has(file.name)) {
          entry.partial = true;
          continue;
        }
        names.add(file.name);
        const child = node(nodes.size, file.name, file.directory, entry);
        nodes.set(child.id, child);
        entry.children.push(child);
        if (file.directory) {
          children.push({ entry: child, place: childPlace(place, file.name) as SpacePlace, segments: [...segments, file.name] });
          continue;
        }
        files += 1;
        const logical = bytes(file.size);
        const allocated = bytes(file.allocated);
        child.logical = logical ?? 0;
        child.missingLogical = Number(logical === null);
        child.missingAllocated = Number(allocated === null);
        if (allocated !== null) {
          allocatedFiles += 1;
          child.shared = !!file.allocationId && identities.has(file.allocationId);
          if (file.allocationId) identities.add(file.allocationId);
          child.allocated = child.shared ? 0 : allocated;
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      entry.error = describeError(error);
      entry.partial = true;
      if (entry === result.root) {
        result.phase = "error";
        result.error = entry.error;
      } else if (rootPlace.kind !== "local" && connectionLost(entry.error)) {
        result.phase = "partial";
        result.error = entry.error;
        jobs.length = 0;
      }
    }
    for (let current: SpaceNode | null = entry; current; current = current.parent) {
      current.pending += children.length - 1;
      current.partial ||= entry.partial;
      for (const child of entry.children) {
        current.logical += child.logical;
        current.allocated += child.allocated;
        current.missingLogical += child.missingLogical;
        current.missingAllocated += child.missingAllocated;
      }
    }
    // Use a stack so deeper results can appear before all top-level folders finish.
    for (let i = children.length - 1; i >= 0; i -= 1) jobs.push(children[i]);
    if (jobs.length) {
      const delay = 75 - (performance.now() - lastReport);
      if (entry === result.root || delay <= 0) {
        publish();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      } else {
        nextReport ??= setTimeout(publish, delay);
      }
    }
  }
  if (result.phase === "scanning") result.phase = result.root.partial ? "partial" : "complete";
  publish();
}
