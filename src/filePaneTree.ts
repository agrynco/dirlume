import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { describeError, watchDirectory, windowsClient, type Entry, type PanelMetadata, type TreePlace } from "./api";
import type { SortMode, SortSettings } from "./fileSort";
import { childPlace, placeKey, readPlace, visibleEntries, type PaneBackgroundSize, type PaneState } from "./panes";
type Branch = {
  segments: readonly string[];
  expanded: boolean;
  revision: number;
  entries?: readonly Entry[];
  error?: string;
};

const emptyBranches = new Map<string, Branch>();
const emptyMetadata = new Map<string, PanelMetadata>();
const emptyDescriptions = new Map<string, string>();

function childFolder(root: TreePlace, segments: readonly string[]) {
  return segments.reduce((place, name) => childPlace(place, name) as TreePlace, root);
}

export function usePaneTreeRevision(path: string | undefined, active: boolean, fileRevision: number) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!path || !active || !isTauri()) return;
    let timer: number | undefined;
    const watch = watchDirectory(path, () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setRevision((value) => value + 1), 220);
    }, undefined, true);
    void watch.ready.catch(() => {});
    return () => { window.clearTimeout(timer); watch.stop(); };
  }, [active, path]);
  return fileRevision + revision;
}

export function useFilePaneTree(root: TreePlace | null, enabled: boolean, revision: number) {
  const scope = root ? placeKey(root) : undefined;
  const [snapshot, setSnapshot] = useState<{ scope?: string; branches: ReadonlyMap<string, Branch> }>({ branches: emptyBranches });
  const pending = useRef(new Map<string, Branch>());
  const branches = snapshot.scope === scope ? snapshot.branches : emptyBranches;

  useEffect(() => {
    pending.current.clear();
    setSnapshot({ scope, branches: emptyBranches });
    return () => pending.current.clear();
  }, [scope]);

  useEffect(() => {
    if (!enabled || !root) return;
    for (const [key, branch] of branches) {
      if (branch.revision === revision || pending.current.get(key)?.segments === branch.segments) continue;
      pending.current.set(key, branch);
      const complete = (entries?: readonly Entry[], error?: string) => {
        if (pending.current.get(key) !== branch) return;
        pending.current.delete(key);
        setSnapshot((current) => {
          const latest = current.branches.get(key);
          if (current.scope !== scope || latest?.segments !== branch.segments) return current;
          return { scope, branches: new Map(current.branches).set(key, { ...latest, entries: entries ?? latest.entries, revision, error }) };
        });
      };
      void readPlace(childFolder(root, branch.segments), undefined, false).then(({ listing }) => {
        complete(listing.entries);
      }, (error: unknown) => complete(undefined, describeError(error)));
    }
  }, [branches, enabled, revision, root, scope]);

  function toggle(entry: Entry) {
    if (!root || !entry.tree || !entry.directory || entry.link) return;
    const { name, tree } = entry;
    setSnapshot((current) => {
      const branches = new Map(current.scope === scope ? current.branches : emptyBranches);
      const previous = branches.get(name);
      branches.set(name, previous ? { ...previous, expanded: !previous.expanded,
        revision: previous.error ? -1 : previous.revision } :
        { segments: tree.segments, expanded: true, revision: -1 });
      return { scope, branches };
    });
  }

  const row = useCallback((entry: Entry, parentSegments: readonly string[]): Entry => {
    const segments = [...parentSegments, entry.name];
    const name = segments.join("/");
    const branch = branches.get(name);
    return { ...entry, name, tree: {
      parent: childFolder(root!, parentSegments), segments, expanded: branch?.expanded ?? false,
      loading: !!branch?.expanded && !branch.entries && branch.revision !== revision,
      error: branch?.error,
      stale: !!branch?.entries && !!branch.error,
    } };
  }, [branches, revision, root]);

  function lookup(pane: PaneState, key: string) {
    if (!root || key === "..") return undefined;
    const path = key.split("/");
    let entries: readonly Entry[] = pane.entries;
    for (let depth = 0; depth < path.length; depth++) {
      const entry = entries.find(({ name }) => name === path[depth]);
      if (!entry) return null;
      if (depth === path.length - 1) return row(entry, path.slice(0, depth));
      if (!entry.directory || entry.link) return null;
      const branch = branches.get(path.slice(0, depth + 1).join("/"));
      if (!branch?.entries) return undefined;
      entries = branch.entries;
    }
  }

  async function reveal(pane: PaneState, path: readonly string[], current: () => boolean) {
    if (!root) return null;
    let entries: readonly Entry[] = pane.entries;
    const segments: string[] = [];
    const opened = new Map<string, Branch>();
    for (const [index, part] of path.entries()) {
      const match = entries.find(({ name }) => root.kind === "local" && windowsClient ? name.toLowerCase() === part.toLowerCase() : name === part);
      if (!current() || !match?.directory || match.link) return null;
      segments.push(match.name);
      if (index + 1 === path.length) break;
      const key = segments.join("/");
      const existing = branches.get(key);
      try {
        entries = existing?.entries && existing.revision === revision && !existing.error ? existing.entries :
          (await readPlace(childFolder(root, segments), undefined, false)).listing.entries;
      } catch { return null; }
      opened.set(key, { segments: [...segments], expanded: true, revision, entries });
    }
    if (!current()) return null;
    if (opened.size) setSnapshot((snapshot) => ({ scope, branches: new Map([...(snapshot.scope === scope ? snapshot.branches : emptyBranches), ...opened]) }));
    return segments.join("/") || "..";
  }

  const visible = useCallback((
    pane: PaneState, top: Entry[], hidden: boolean, settings: SortSettings, canSort: (mode: SortMode) => boolean,
    measures: (entries: readonly Entry[]) => ReadonlyMap<string, PaneBackgroundSize> | undefined,
  ) => {
    if (!enabled || !root) return top;
    const output: Entry[] = [];
    const stack = top.map((entry) => entry.name === ".." ? entry : row(entry, [])).reverse();
    while (stack.length) {
      const entry = stack.pop()!;
      output.push(entry);
      const branch = entry.tree?.expanded ? branches.get(entry.name) : undefined;
      if (!branch?.entries || !entry.directory || entry.link) continue;
      const nested = branch.entries.map((child) => row(child, branch.segments));
      const children = visibleEntries({ ...pane, place: null, entries: nested, backgroundSizes: measures(nested) },
        hidden, settings, canSort, emptyMetadata, emptyDescriptions, false);
      for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
    }
    return output;
  }, [branches, enabled, root, row]);

  return { enabled: enabled && !!root, branches, lookup, reveal, toggle, visible };
}
