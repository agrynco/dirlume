import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Entry } from "./api";
import { childPlace, type PaneBackgroundSize, type PaneState } from "./panes";
import { scanSpace, spaceSegments, unavailable, type Metric, type SpaceNode, type SpaceResult } from "./spaceScan";

type Scan = {
  path: string;
  order: number;
  result?: SpaceResult;
};

type Branch = Scan & { segments: readonly string[] };
type BranchSize = { order: number; logical: Size; allocated: Size };
type Size = Omit<PaneBackgroundSize, "name">;
const missing: Size = { bytes: 0, incomplete: true, pending: false, unavailable: true };
const pending: Size = { ...missing, pending: true, unavailable: false };

function completedSize(node: SpaceNode, metric: Metric): Size {
  const bytes = node[metric];
  const unavailableSize = unavailable(node, metric) > 0 || !!node.error;
  return { bytes, pending: false, incomplete: node.partial || node.pending > 0 || unavailableSize,
    unavailable: unavailableSize && bytes === 0 };
}

function settled(result: SpaceResult | undefined, node: SpaceNode, metric: Metric) {
  return node.pending === 0 || (result?.phase === "partial" && node[metric] > 0);
}

export function usePaneFolderSizes(pane: PaneState, enabled: boolean, tree: boolean) {
  const path = !pane.search && pane.place?.kind === "local" ? pane.place.path : undefined;
  const backgroundPath = enabled ? path : undefined;
  const treePath = tree ? path : undefined;
  const order = useRef(0);
  const backgroundController = useRef<AbortController | null>(null);
  const branchJob = useRef<{ controller: AbortController; scan: Branch } | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [state, setState] = useState<{ current: Scan; previous?: Scan } | null>(null);
  const [branch, setBranch] = useState<Branch | null>(null);
  const [branchSizes, setBranchSizes] = useState<{ path: string; values: Map<string, BranchSize> } | null>(null);
  const [preferredMetric, setMetric] = useState<Metric>("logical");
  const current = state?.current.path === backgroundPath ? state?.current : undefined;
  const previous = current ? state?.previous : undefined;
  const scopedBranch = branch?.path === treePath ? branch : null;
  const cachedBranchSizes = branchSizes?.path === treePath ? branchSizes?.values : undefined;

  useEffect(() => {
    if (!backgroundPath) {
      setState(null);
      return;
    }
    const controller = new AbortController();
    backgroundController.current = controller;
    const scan = { path: backgroundPath, order: ++order.current };
    setState((prior) => ({
      current: scan,
      previous: prior?.current.path === backgroundPath && prior.current.result && prior.current.result.phase !== "error"
        ? prior.current : prior?.previous?.path === backgroundPath ? prior.previous : undefined,
    }));
    void scanSpace({ kind: "local", path: backgroundPath, parent: null }, controller.signal, (result) => {
      if (!controller.signal.aborted) setState((value) => value?.current.order === scan.order
        ? { ...value, current: { ...scan, result } } : value);
    }).finally(() => {
      if (backgroundController.current === controller) backgroundController.current = null;
    });
    return () => {
      controller.abort();
      if (backgroundController.current === controller) backgroundController.current = null;
    };
  }, [backgroundPath, epoch]);

  useEffect(() => {
    setBranch(null);
    setBranchSizes(null);
    return () => {
      branchJob.current?.controller.abort();
      branchJob.current = null;
    };
  }, [treePath]);

  function refresh() {
    if (backgroundPath && !backgroundController.current) setEpoch((value) => value + 1);
  }

  function measureBranch(segments: readonly string[]) {
    if (!treePath || !segments.length) return;
    const prior = branchJob.current;
    if (prior?.scan.path === treePath && prior.scan.result?.phase === "scanning" &&
      prior.scan.segments.join("/") === segments.join("/")) return;
    prior?.controller.abort();
    const priorScan = prior?.scan;
    if (priorScan?.path === treePath && priorScan.result) {
      setBranchSizes((cache) => {
        const values = new Map(cache?.path === treePath ? cache.values : undefined);
        for (const node of priorScan.result?.nodes ?? []) {
          if (!node.directory || node.pending > 0) continue;
          const key = [...priorScan.segments, ...spaceSegments(node)].join("/");
          values.set(key, { order: priorScan.order, logical: completedSize(node, "logical"), allocated: completedSize(node, "allocated") });
        }
        return { path: treePath, values };
      });
    }
    const controller = new AbortController();
    const scan: Branch = { path: treePath, order: ++order.current, segments };
    const job = { controller, scan };
    branchJob.current = job;
    setBranch(scan);
    const root = segments.reduce((place, name) => childPlace(place, name) as typeof place,
      { kind: "local", path: treePath, parent: null } as Extract<PaneState["place"], { kind: "local" }>);
    void scanSpace(root, controller.signal, (result) => {
      if (!controller.signal.aborted) {
        job.scan = { ...scan, result };
        setBranch(job.scan);
      }
    });
  }

  const backgroundScanning = !!backgroundPath && (!current?.result || current.result.phase === "scanning");
  const branchScanning = !!scopedBranch && (!scopedBranch.result || scopedBranch.result.phase === "scanning");
  const support = current?.result && !backgroundScanning ? current.result.supportsAllocation :
    previous?.result?.supportsAllocation ?? current?.result?.supportsAllocation ?? false;
  const metric = support ? preferredMetric : "logical";
  const indexes = useMemo(() => new WeakMap<SpaceNode, Map<string, SpaceNode>>(), [current?.result, previous?.result, scopedBranch?.result]);
  const measures = useCallback((entries: readonly Entry[]) => {
    if (!backgroundPath && !scopedBranch && !cachedBranchSizes) return undefined;
    const sizes = new Map<string, PaneBackgroundSize>();
    function lookup(result: SpaceResult | undefined, segments: readonly string[]) {
      let node = result?.root;
      for (const segment of segments) {
        if (!node) return;
        let children = indexes.get(node);
        if (!children) {
          children = new Map(node.children.map((child) => [child.name, child]));
          indexes.set(node, children);
        }
        node = children.get(segment);
      }
      return node;
    }
    for (const entry of entries) {
      if (entry.name === ".." || entry.link || (!entry.directory && metric === "logical")) continue;
      const segments = entry.tree?.segments ?? [entry.name];
      const covered = entry.directory && scopedBranch && scopedBranch.segments.every((part, index) => part === segments[index]);
      const focusedNode = covered && scopedBranch ? lookup(scopedBranch.result, segments.slice(scopedBranch.segments.length)) : undefined;
      const cached = entry.directory ? cachedBranchSizes?.get(segments.join("/")) : undefined;
      const focusedReady = focusedNode?.directory && settled(scopedBranch?.result, focusedNode, metric);
      const focused = focusedReady && scopedBranch ? { order: scopedBranch.order, size: completedSize(focusedNode, metric) }
        : cached ? { order: cached.order, size: cached[metric] } : undefined;
      const nextNode = lookup(current?.result, segments);
      const ready = nextNode?.directory === entry.directory && settled(current?.result, nextNode, metric);
      const retain = backgroundScanning || current?.result?.phase === "error";
      const oldNode = retain ? lookup(previous?.result, segments) : undefined;
      const background = ready && current ? { order: current.order, size: completedSize(nextNode, metric) }
        : oldNode?.directory === entry.directory && settled(previous?.result, oldNode, metric) && previous
          ? { order: previous.order, size: completedSize(oldNode, metric) } : undefined;
      const measured = focused && (!background || focused.order >= background.order) ? focused : background;
      if (measured) sizes.set(entry.name, { name: entry.name, ...measured.size });
      else if (backgroundPath || covered) sizes.set(entry.name, { name: entry.name,
        ...(backgroundScanning || (covered && branchScanning) ? pending : missing) });
    }
    return sizes.size ? sizes : undefined;
  }, [backgroundPath, backgroundScanning, branchScanning, cachedBranchSizes, current, indexes, metric, previous, scopedBranch]);

  return {
    active: !!backgroundPath, branchActive: !!scopedBranch || !!cachedBranchSizes,
    scanning: backgroundScanning || branchScanning, error: scopedBranch?.result?.error || current?.result?.error,
    metric, support, setMetric, measures, refresh, measureBranch,
  };
}
