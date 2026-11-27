import { Channel } from "@tauri-apps/api/core";
import { api, describeError, folderLabel, isFileServer, placePath, windowsClient, type Entry, type FileLocation, type FilePlace, type Listing, type Place, type SpaceChange, type SpaceScanEvent } from "./api";
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

export function spaceRelativePath(root: SpacePlace, target: SpacePlace): string[] | null {
  if (root.kind !== target.kind) return null;
  if ((root.kind === "server" || isFileServer(root)) && (!(target.kind === "server" || isFileServer(target)) || root.id !== target.id)) return null;
  if (root.kind === "kswitcher" && (target.kind !== "kswitcher" || root.peer !== target.peer || root.directory !== target.directory)) return null;
  const windows = root.kind === "kswitcher" || root.kind === "local" && windowsClient;
  const split = (place: SpacePlace) => placePath(place).split(windows ? /[\\/]+/ : /\/+/).filter(Boolean);
  const base = split(root);
  const destination = split(target);
  const compare = (part: string) => windows ? part.toLowerCase() : part;
  return destination.length >= base.length && base.every((part, index) => compare(part) === compare(destination[index]))
    ? destination.slice(base.length) : null;
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
  nodes: readonly SpaceNode[];
  supportsAllocation: boolean;
  phase: "scanning" | "complete" | "partial" | "error";
  error: string;
}

// Files have no descendants. Keep their empty child list shared across large scans.
const noChildren: SpaceNode[] = [];
Object.freeze(noChildren);

function node(id: number, name: string, directory: boolean, parent: SpaceNode | null): SpaceNode {
  return { id, name, directory, parent, children: directory ? [] : noChildren, logical: 0, allocated: 0, missingLogical: 0,
    missingAllocated: 0, pending: directory ? 1 : 0, partial: false, shared: false, error: "" };
}

export function initialSpaceResult(place: FilePlace): SpaceResult {
  const root = node(0, folderLabel(place), true, null);
  return { root, nodes: [root], supportsAllocation: place.kind === "local", phase: "scanning", error: "" };
}

export function spaceLocation(root: SpacePlace, entry: SpaceNode): { place: SpacePlace; reveal?: string } {
  const reveal = entry.directory ? undefined : entry.name;
  const segments = spaceSegments(reveal === undefined ? entry : entry.parent);
  return { place: segments.reduce((place, name) => childPlace(place, name) as SpacePlace, root), reveal };
}

export function spaceSegments(entry: SpaceNode | null) {
  const segments: string[] = [];
  for (let current = entry; current?.parent; current = current.parent) {
    segments.push(current.name);
  }
  return segments.reverse();
}

export function nearestSpaceNode(root: SpaceNode, segments: readonly string[]) {
  let current = root;
  for (const name of segments) {
    const child = current.children.find((entry) => entry.name === name);
    if (!child) break;
    current = child;
  }
  return current;
}

export type SpaceLocalItem = { place: Extract<Place, { kind: "local" }>; entry: Entry };
export type SpaceItemCommand = "copy" | "move" | "recycle" | "delete";

export function spaceLocalItem(root: SpacePlace, node: SpaceNode): SpaceLocalItem | null {
  if (root.kind !== "local" || !node.parent) return null;
  const parent = spaceLocation(root, node.parent).place;
  if (parent.kind !== "local") return null;
  return { place: parent, entry: { name: node.name, directory: node.directory, link: false, hidden: false,
    size: node.missingLogical ? null : node.logical, modified: null } };
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

async function scanLocalSpace(
  place: Extract<SpacePlace, { kind: "local" }>,
  signal: AbortSignal,
  report: (result: SpaceResult) => void,
) {
  if (signal.aborted) return;
  const id = crypto.getRandomValues(new Uint32Array(2)).join("-");
  let result = initialSpaceResult(place);
  let nodes = [result.root];
  let files = 0;
  let knownAllocations = 0;
  let lastReport = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;

  function publish() {
    clearTimeout(timer);
    timer = undefined;
    if (signal.aborted) return;
    lastReport = performance.now();
    result.supportsAllocation = files === 0 || knownAllocations > 0;
    report({ ...result });
  }

  function update(change: SpaceChange) {
    if ("closed" in change) {
      const entry = nodes[change.closed];
      entry.error = change.error ?? "";
      for (let p: SpaceNode | null = entry; p; p = p.parent) {
        p.pending--;
        p.partial ||= change.partial;
      }
      return;
    }
    const parent = nodes[change.parent];
    const child = node(nodes.length, change.name, change.directory, parent);
    nodes.push(child);
    parent.children.push(child);
    if (!child.directory) {
      files++;
      if (change.allocated !== null) knownAllocations++;
      child.logical = change.size ?? 0;
      child.allocated = change.allocated ?? 0;
      child.missingLogical = Number(change.size === null);
      child.missingAllocated = Number(change.allocated === null);
      child.shared = change.shared;
    }
    for (let p: SpaceNode | null = parent; p; p = p.parent) {
      p.pending += child.pending;
      p.logical += child.logical;
      p.allocated += child.allocated;
      p.missingLogical += child.missingLogical;
      p.missingAllocated += child.missingAllocated;
    }
  }

  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  function cancel() {
    clearTimeout(timer);
    if (started) void api.cancelSpaceScan(id).catch(() => {});
    finish();
  }
  const output = new Channel<SpaceScanEvent>((event) => {
    if (event.kind === "start") {
      started = true;
      if (signal.aborted) { cancel(); return; }
      // A failed MFT read restarts with an empty tree and a fresh sequence of node IDs.
      result = initialSpaceResult(place);
      nodes = [result.root];
      result.nodes = nodes;
      files = knownAllocations = 0;
      publish();
      lastReport = -Infinity;
      return;
    }
    if (signal.aborted) return;
    if (event.kind === "finished") {
      result.phase = result.root.partial ? "partial" : "complete";
      publish();
      finish();
      return;
    }
    for (const change of event.changes) update(change);
    const delay = 75 - (performance.now() - lastReport);
    if (delay <= 0) publish();
    else timer ??= setTimeout(publish, delay);
  });
  signal.addEventListener("abort", cancel, { once: true });
  publish();
  try {
    // The command response can arrive ahead of the last ordered channel message.
    await Promise.all([api.scanLocalSpace(place.path, id, output), finished]);
  } catch (error) {
    result.phase = "error";
    result.error = describeError(error);
    publish();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}


function connectionLost(error: string) {
  return /connect to the .* server first|could not reach the .* server|connection (?:closed|reset|refused|aborted|lost|error)|broken pipe|network is unreachable|timed out|unexpected eof|disconnected|error sending request/i.test(error);
}

function bytes(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export async function scanSpace(
  rootPlace: FilePlace,
  signal: AbortSignal,
  report: (result: SpaceResult) => void,
) {
  if (rootPlace.kind === "local") return scanLocalSpace(rootPlace, signal, report);
  const result = initialSpaceResult(rootPlace);
  const nodes = [result.root];
  result.nodes = nodes;
  const jobs: { entry: SpaceNode; place: FilePlace }[] = [{ entry: result.root, place: rootPlace }];
  const identities = new Set<string>();
  let allocatedFiles = 0;
  let lastReport = 0;
  let nextReport: ReturnType<typeof setTimeout> | undefined;
  function publish() {
    clearTimeout(nextReport);
    nextReport = undefined;
    if (signal.aborted) return;
    result.supportsAllocation = allocatedFiles > 0;
    lastReport = performance.now();
    report({ ...result });
  }
  publish();
  while (jobs.length && !signal.aborted) {
    const job = jobs.pop()!;
    const { entry, place } = job;
    const children: typeof jobs = [];
    try {
      const listing: Listing = (await readPlace(place, undefined, undefined, signal)).listing;
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
        const child = node(nodes.length, file.name, file.directory, entry);
        nodes.push(child);
        entry.children.push(child);
        if (file.directory) {
          children.push({ entry: child, place: childPlace(place, file.name) as FilePlace });
          continue;
        }
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
      } else if (connectionLost(entry.error)) {
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
