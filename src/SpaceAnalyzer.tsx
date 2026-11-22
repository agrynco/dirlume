import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type Ref, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ChevronDown, ChevronRight, File, Folder, HardDrive, LoaderCircle } from "lucide-react";
import { CompactAddressBreadcrumbs } from "./AddressField";
import { Button } from "./Button";
import { api, describeError, smbHost, watchDirectory, windowsClient, type FileLocation } from "./api";
import { FileContextMenu } from "./FileContextMenu";
import { errorText, locale, t } from "./i18n";
import { formatSize, type Side } from "./panes";
import { bindingMatches, eventShortcut, type Bindings, type PanelLayout, type SpaceAnalyzerView } from "./preferences";
import { SpaceSunburst } from "./SpaceSunburst";
import { useRightClickSelection } from "./useRightClickSelection";
import {
  canAnalyze, initialSpaceResult, nearestSpaceNode, scanSpace, sortedSpaceChildren, spaceLocalItem, spaceLocation, spacePath, spaceSegments,
  spaceShare, unavailable, type Metric, type SpaceItemCommand, type SpaceLocalItem, type SpaceNode, type SpacePlace, type SpaceResult,
} from "./spaceScan";

function percent(share: number) {
  return new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 1 }).format(share);
}

function rowNote(entry: SpaceNode, metric: Metric, running: boolean) {
  if (entry.error || (!entry.directory && unavailable(entry, metric))) return t("Unavailable");
  if (entry.partial || unavailable(entry, metric) || (entry.pending && !running)) return t("Partial results");
  if (entry.pending) return t("Scanning…");
  if (entry.shared && metric === "allocated") return t("Shared allocation");
  return "";
}

const rowHeight = 29;
const rowKey = (node: SpaceNode) => node.parent ? JSON.stringify(spaceSegments(node)) : "..";

function SpaceTree({ result, metric, selected, select, expanded, toggle, tree, itemContext, itemShortcut,
  marked, changeMarks, clearMarks, bindings, rightClickSelection, scope }: {
  result: SpaceResult;
  metric: Metric;
  selected: number;
  select: (id: number) => void;
  expanded: ReadonlySet<number>;
  toggle: (id: number) => void;
  tree: RefObject<HTMLDivElement | null>;
  itemContext?: (entry: SpaceNode, x: number, y: number) => void;
  itemShortcut?: (entry: SpaceNode, event: KeyboardEvent) => boolean;
  marked: ReadonlySet<string>;
  changeMarks: (names: readonly string[], mark: boolean) => void;
  clearMarks: () => void;
  bindings: Bindings;
  rightClickSelection: boolean;
  scope: string;
}) {
  const id = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const anchor = useRef<string | null>(null);
  const [window, setWindow] = useState({ top: 0, height: rowHeight * 12 });
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const resize = new ResizeObserver(() => setWindow({ top: element.scrollTop, height: element.clientHeight }));
    resize.observe(element);
    return () => resize.disconnect();
  }, []);
  const rows = useMemo(() => {
    const rows: { entry: SpaceNode; level: number; name: string }[] = [];
    const stack = [{ entry: result.root, level: 1, name: ".." }];
    while (stack.length) {
      const row = stack.pop()!;
      rows.push(row);
      if (!expanded.has(row.entry.id)) continue;
      const children = sortedSpaceChildren(row.entry, metric);
      for (let i = children.length - 1; i >= 0; i -= 1) stack.push({ entry: children[i], level: row.level + 1, name: rowKey(children[i]) });
    }
    return rows;
  }, [result, metric, expanded]);
  const start = Math.max(0, Math.floor(window.top / rowHeight) - 6);
  const end = Math.min(rows.length, Math.ceil((window.top + window.height) / rowHeight) + 6);
  const visible = rows.slice(start, end);
  const selectedIndex = rows.findIndex(({ entry }) => entry.id === selected);
  const rightClick = useRightClickSelection({ list: tree, entries: rows, marked, enabled: rightClickSelection, scope,
    onMark: (names, mark) => {
      changeMarks(names, mark);
      const last = rows.find((row) => row.name === names.at(-1));
      if (last) { anchor.current = last.name; select(last.entry.id); }
    },
    onContext: (x, y, row) => { if (row) itemContext?.(row.entry, x, y); },
  });

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || selectedIndex < 0) return;
    const top = selectedIndex * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + element.clientHeight) element.scrollTop = top + rowHeight - element.clientHeight;
  }, [selectedIndex]);

  function choose(index: number) {
    const next = Math.max(0, Math.min(rows.length - 1, index));
    select(rows[next].entry.id);
  }

  function keyDown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
    const index = Math.max(0, selectedIndex);
    const { entry, name } = rows[index];
    if (itemContext && (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      const bounds = (document.getElementById(id + selected) ?? event.currentTarget).getBoundingClientRect();
      itemContext(entry, bounds.left + 20, bounds.bottom);
      return;
    }
    if (itemShortcut?.(entry, event)) return;
    const shortcut = eventShortcut(event);
    const up = bindingMatches(bindings.selectUpRow, shortcut);
    if (up || bindingMatches(bindings.selectDownRow, shortcut) || bindingMatches(bindings.mark, shortcut)) {
      event.preventDefault();
      if (name !== "..") changeMarks([name], !marked.has(name));
      choose(index + (up ? -1 : 1));
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const open = expanded.has(entry.id);
    switch (event.key) {
      case "ArrowDown": choose(index + 1); break;
      case "ArrowUp": choose(index - 1); break;
      case "Home": choose(0); break;
      case "End": choose(rows.length - 1); break;
      case "ArrowRight":
        if (entry.children.length) {
          if (open) choose(index + 1);
          else toggle(entry.id);
        }
        break;
      case "ArrowLeft":
        if (entry.children.length && open) toggle(entry.id);
        else if (entry.parent) choose(rows.findIndex(({ entry: item }) => item === entry.parent));
        break;
      case " ":
      case "Enter":
        if (entry.children.length) toggle(entry.id);
        break;
      default: return;
    }
    event.preventDefault();
  }

  return <div ref={tree} className="space-tree" role="treegrid" data-help-topic="spaceTree" aria-label={t("Space usage")} aria-rowcount={rows.length + 1}
    tabIndex={0} data-help-return onKeyDown={keyDown} aria-multiselectable="true" {...rightClick.events}
    aria-activedescendant={visible.some(({ entry }) => entry.id === selected) ? id + selected : undefined}>
    {rightClick.spinner && createPortal(<span className="right-selection-hold" role="status"
      aria-label={t("Release to open the context menu")} style={{
        left: Math.min(innerWidth - 22, rightClick.spinner.x + 12), top: Math.min(innerHeight - 22, rightClick.spinner.y + 12),
      }}><LoaderCircle className="spin" aria-hidden="true" /></span>, document.body)}
    <div className="space-tree-columns" role="row">
      <span role="columnheader">{t("Name")}</span><span role="columnheader" aria-sort="descending">{t("Size")}</span>
    </div>
    <div className="space-tree-scroll" ref={viewport} onScroll={(event) => {
      setWindow({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight });
    }}>
      <div style={{ height: rows.length * rowHeight, paddingTop: start * rowHeight }}>
        {visible.map(({ entry, level, name }, index) => {
          const Icon = entry.directory ? Folder : File;
          const open = expanded.has(entry.id);
          const share = spaceShare(entry, metric);
          const note = rowNote(entry, metric, result.phase === "scanning");
          const current = entry.id === selected;
          const isMarked = marked.has(name);
          return <div key={name} id={id + entry.id} className={`file-row space-tree-row${isMarked ? " marked" : ""}`}
            data-current={current || undefined} data-entry-index={start + index}
            role="row" aria-rowindex={start + index + 2} aria-level={level}
            aria-expanded={entry.children.length ? open : undefined} aria-selected={current || isMarked}
            style={{ height: rowHeight }} onClick={(event) => {
              if (event.shiftKey) {
                const position = start + index;
                const anchorIndex = rows.findIndex((row) => row.name === anchor.current);
                const from = anchorIndex >= 0 ? anchorIndex : Math.max(0, selectedIndex);
                changeMarks(rows.slice(Math.min(from, position), Math.max(from, position) + 1).map((row) => row.name).filter((key) => key !== ".."), true);
              } else {
                anchor.current = name;
                if (name !== ".." && (event.ctrlKey || event.metaKey)) changeMarks([name], !isMarked);
                else if (!isMarked) clearMarks();
              }
              select(entry.id);
              event.currentTarget.closest<HTMLElement>("[role=treegrid]")?.focus({ preventScroll: true });
            }} onDoubleClick={() => { if (entry.children.length) toggle(entry.id); }}
            onContextMenu={itemContext ? (event) => {
              event.preventDefault();
              if (!rightClick.suppressContextMenu(event)) itemContext(entry, event.clientX, event.clientY);
            } : undefined}>
            <span className="file-name space-tree-name" role="gridcell" style={{ paddingInlineStart: Math.min(level - 1, 12) * 13 }}
              title={entry.error || entry.name}>
              <span className="space-expand" aria-hidden="true" onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => {
                if (event.detail === 1 && entry.children.length) toggle(entry.id);
              }}>{entry.children.length > 0 && (open ? <ChevronDown /> : <ChevronRight />)}</span>
              <Icon aria-hidden="true" /><span className="space-entry-label">{entry.name}</span>
              {note && <small>{note}</small>}
            </span>
            <span className="space-size" role="gridcell" style={{ "--space-fill": share * 100 + "%" } as CSSProperties}>
              <span>{entry.error || (!entry.directory && unavailable(entry, metric)) ? "—" : formatSize(entry[metric])}</span>
              <span>{percent(share)}</span>
            </span>
          </div>;
        })}
      </div>
    </div>
  </div>;
}

type Tile = { entry: SpaceNode | null; size: number; style?: CSSProperties };

function tilesIn(tiles: Tile[], x = 0, y = 0, width = 100, height = 100) {
  if (tiles.length <= 1) {
    if (tiles.length) tiles[0].style = { left: x + "%", top: y + "%", width: width + "%", height: height + "%" };
    return;
  }
  const total = tiles.reduce((sum, tile) => sum + tile.size, 0);
  let split = 1;
  let first = tiles[0].size;
  while (split < tiles.length - 1 && Math.abs(first + tiles[split].size - total / 2) < Math.abs(first - total / 2)) {
    first += tiles[split++].size;
  }
  if (width >= height) {
    const edge = width * first / total;
    tilesIn(tiles.slice(0, split), x, y, edge, height);
    tilesIn(tiles.slice(split), x + edge, y, width - edge, height);
  } else {
    const edge = height * first / total;
    tilesIn(tiles.slice(0, split), x, y, width, edge);
    tilesIn(tiles.slice(split), x, y + edge, width, height - edge);
  }
}

type ChartMenu = (entry: SpaceNode, x: number, y: number, returnFocus?: HTMLElement) => void;

function TreemapTileLabel({ name, size }: { name: string; size: string }) {
  const label = useRef<HTMLSpanElement>(null);
  const value = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const container = label.current;
    const text = value.current;
    if (!container || !text) return;

    const fitLabel = () => {
      const available = container.getBoundingClientRect();
      const needed = text.getBoundingClientRect();
      const fitsSize = available.width >= needed.width && available.height >= needed.height;
      if (!fitsSize) container.dataset.fit = "none";
      else container.dataset.fit = available.height >= needed.height * 2 ? "both" : "size";
    };

    fitLabel();
    const resize = new ResizeObserver(fitLabel);
    resize.observe(container);
    resize.observe(text);
    return () => resize.disconnect();
  }, []);

  return <span ref={label} className="space-tile-label" aria-hidden="true">
    <strong>{name}</strong><span ref={value}>{size}</span>
  </span>;
}

function Treemap({ folder, metric, selected, onActivate, openMenu }: {
  folder: SpaceNode;
  metric: Metric;
  selected: number;
  onActivate: (entry: SpaceNode | null) => void;
  openMenu: ChartMenu;
}) {
  const children = sortedSpaceChildren(folder, metric).filter((child) => child[metric] > 0);
  const limit = 64;
  const tiles: Tile[] = children.slice(0, limit).map((entry) => ({ entry, size: entry[metric] }));
  if (children.length > limit) tiles.push({ entry: null, size: children.slice(limit).reduce((sum, child) => sum + child[metric], 0) });
  tilesIn(tiles);
  return tiles.length ? <div className="space-map-canvas" aria-label={t("Treemap")}>
    {tiles.map(({ entry, size, style }) => {
      const name = entry?.name ?? t("More items");
      const formatted = formatSize(size);
      return <Button key={entry?.id ?? "more"} className="space-tile" style={style}
        data-folder={entry?.directory || undefined} data-selected={entry?.id === selected || undefined}
        aria-label={t("{0}, {1}", name, formatted)} onClick={() => onActivate(entry)}
        onContextMenu={entry ? (event) => {
          event.preventDefault();
          openMenu(entry, event.clientX, event.clientY, event.currentTarget);
        } : undefined} onKeyDown={(event) => {
          if (!entry || !(event.key === "ContextMenu" || event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          openMenu(entry, bounds.left + 12, bounds.bottom, event.currentTarget);
        }}>
        <TreemapTileLabel name={name} size={formatted} />
      </Button>;
    })}
  </div> : <p className="pane-empty">{t("No space to display.")}</p>;
}

const treeActions = ["copy", "move", "recycle", "recycleAlternate", "delete"] as const;

export type SpaceNavigation = { segments: readonly string[]; focus: boolean; revealTree?: boolean };
export type SpaceAnalyzerHandle = { focus: () => void; runAction: (command: SpaceItemCommand) => void };
type ItemMenu = { x: number; y: number } & ({ kind: "tree"; item: SpaceLocalItem } |
  { kind: "chart"; path: string[]; returnFocus?: HTMLElement });

export default function SpaceAnalyzer({ ref, side, place, currentFolder, navigation, active, layout, fileRevision, shortcuts, operationsAvailable,
  rightClickSelection, initialView, onViewChoice, onItemAction, onClose, onFocus, onNavigate, onLocation, onReveal, resolvePlace }: {
  ref?: Ref<SpaceAnalyzerHandle>;
  side: Side;
  place: SpacePlace;
  currentFolder: SpacePlace;
  navigation: SpaceNavigation;
  active: boolean;
  layout: PanelLayout;
  fileRevision: number;
  shortcuts: Bindings;
  operationsAvailable: boolean;
  rightClickSelection: boolean;
  initialView: SpaceAnalyzerView;
  onViewChoice: (view: SpaceAnalyzerView) => void;
  onItemAction: (items: readonly SpaceLocalItem[], command: SpaceItemCommand) => void;
  onClose: () => void;
  onFocus: () => void;
  onNavigate: (place: SpacePlace) => void;
  onLocation: (location: { place: SpacePlace; reveal?: string }) => void;
  onReveal: (place: SpacePlace, reveal?: string) => Promise<void>;
  resolvePlace: (place: SpacePlace) => SpacePlace;
}) {
  const [result, setResult] = useState(() => initialSpaceResult(place));
  const scan = useRef<AbortController | null>(null);
  const tree = useRef<HTMLDivElement>(null);
  const viewModes = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const revealRequest = useRef(0);
  const [revision, setRevision] = useState(0);
  const [metricChoice, setMetric] = useState<Metric | null>(null);
  const [view, setView] = useState<SpaceAnalyzerView>(initialView);
  const [expandedPaths, setExpandedPaths] = useState(() => new Map<string, string[]>([["[]", []]]));
  const [selectedPath, setSelectedPath] = useState<readonly string[]>([]);
  const [marked, setMarked] = useState<ReadonlySet<string>>(() => new Set());
  const [zoomPath, setZoomPath] = useState<string[]>([]);
  const [menu, setMenu] = useState<ItemMenu | null>(null);
  const menuRequest = useRef(0);
  const [revealError, setRevealError] = useState("");
  const metric = result.supportsAllocation ? metricChoice ?? "allocated" : "logical";
  const scanning = result.phase === "scanning";
  const incomplete = result.phase === "partial" || unavailable(result.root, metric) > 0;
  const folder = nearestSpaceNode(result.root, zoomPath);
  const entry = nearestSpaceNode(result.root, selectedPath);
  const selected = entry.id;
  const expanded = useMemo(() => new Set([...expandedPaths.values()].flatMap((path) => {
    const node = nearestSpaceNode(result.root, path);
    return spaceSegments(node).length === path.length ? [node.id] : [];
  })), [expandedPaths, result]);
  const watchPath = currentFolder.kind === "local" ? currentFolder.path : undefined;
  const localRevision = place.kind === "local" ? fileRevision : 0;

  function focus() {
    (tree.current ?? viewModes.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ?? closeButton.current)
      ?.focus({ preventScroll: true });
  }
  useImperativeHandle(ref, () => ({ focus, runAction: (command) => runAction(entry, command) }));

  useLayoutEffect(() => {
    const { segments, focus: moveFocus, revealTree } = navigation;
    setSelectedPath(segments);
    setZoomPath([...segments]);
    expandPath(segments);
    if (revealTree) setView("tree");
    if (!moveFocus) return;
    const frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [navigation]);
  useEffect(() => () => { menuRequest.current++; }, []);
  useEffect(() => {
    const controller = new AbortController();
    scan.current = controller;
    void scanSpace(resolvePlace(place), controller.signal, (next) => {
      if (controller.signal.aborted) return;
      setResult(next);
    });
    return () => { controller.abort(); revealRequest.current += 1; };
  }, [revision, localRevision, place, resolvePlace]);

  useEffect(() => {
    if (!isTauri() || !watchPath) return;
    let timer: number | undefined;
    const watch = watchDirectory(watchPath, () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        scan.current?.abort();
        setRevision((value) => value + 1);
      }, 180);
    });
    void watch.ready.catch(() => {});
    return () => {
      window.clearTimeout(timer);
      watch.stop();
    };
  }, [watchPath]);

  function select(id: number) {
    const node = result.nodes[id] ?? result.root;
    setSelectedPath(spaceSegments(node));
    onLocation(spaceLocation(place, node));
  }

  function changeMarks(names: readonly string[], mark: boolean) {
    setMarked((current) => {
      const next = new Set(current);
      for (const name of names) {
        if (mark) next.add(name);
        else next.delete(name);
      }
      return next;
    });
  }

  function toggle(id: number) {
    const path = spaceSegments(result.nodes[id] ?? null);
    const key = JSON.stringify(path);
    setExpandedPaths((previous) => {
      const next = new Map(previous);
      if (!next.delete(key)) next.set(key, path);
      return next;
    });
  }

  function stop() {
    scan.current?.abort();
    setResult((current) => ({ ...current, phase: "partial" }));
  }

  function rescan() {
    scan.current?.abort();
    setRevealError("");
    setRevision((value) => value + 1);
  }

  function browse(folder: SpaceNode) {
    const path = spaceSegments(folder);
    setZoomPath(path);
    select(folder.id);
  }

  function expandPath(path: readonly string[], includeFolder = false) {
    setExpandedPaths((previous) => {
      const next = new Map(previous);
      for (let depth = 0; depth < path.length + Number(includeFolder); depth++) {
        const parent = path.slice(0, depth);
        next.set(JSON.stringify(parent), parent);
      }
      return next;
    });
  }

  function changeView(next: SpaceAnalyzerView) {
    onViewChoice(next);
    if (next === view) return;
    const current = entry.directory ? entry : entry.parent;
    if (next === "tree") expandPath(spaceSegments(entry), entry.directory);
    else setZoomPath(spaceSegments(current));
    setView(next);
  }

  function activateChartEntry(node: SpaceNode | null) {
    if (!node) {
      expandPath(spaceSegments(folder), true);
      setView("tree");
      requestAnimationFrame(focus);
    } else if (node.directory) browse(node);
    else select(node.id);
  }

  function runAction(node: SpaceNode, command: SpaceItemCommand) {
    if (!operationsAvailable || view !== "tree") return;
    const selectedNodes = marked.size ? [...marked].flatMap((key) => {
      const path: string[] = JSON.parse(key);
      const candidate = nearestSpaceNode(result.root, path);
      return rowKey(candidate) === key ? [candidate] : [];
    }) : [node];
    const folders = new Set(selectedNodes.filter((candidate) => candidate.directory).map(rowKey));
    const items = selectedNodes.flatMap((candidate) => {
      const path = spaceSegments(candidate);
      if (path.some((_, depth) => depth > 0 && folders.has(JSON.stringify(path.slice(0, depth))))) return [];
      const item = spaceLocalItem(place, candidate);
      return item ? [item] : [];
    });
    if (items.length) onItemAction(items, command);
  }

  function itemShortcut(node: SpaceNode, event: KeyboardEvent) {
    const shortcut = eventShortcut(event);
    const command = treeActions.find((key) => bindingMatches(shortcuts[key], shortcut));
    if (!command) return false;
    event.preventDefault();
    if (!event.repeat) runAction(node, command === "recycleAlternate" ? "recycle" : command);
    return true;
  }

  function openItemMenu(node: SpaceNode, x: number, y: number) {
    const item = spaceLocalItem(place, node);
    if (!operationsAvailable || !item) return;
    select(node.id);
    tree.current?.focus({ preventScroll: true });
    const request = ++menuRequest.current;
    setMenu(null);
    if (!isTauri() || !windowsClient || marked.size > 0) { setMenu({ kind: "tree", item, x, y }); return; }
    void api.windowsItemMenu(item.place.path, item.entry.name).then((invoked) => {
      if (menuRequest.current !== request) return;
      tree.current?.focus({ preventScroll: true });
      if (!invoked) return;
      scan.current?.abort();
      setRevision((value) => value + 1);
    }).catch(() => {
      if (menuRequest.current === request) setMenu({ kind: "tree", item, x, y });
    });
  }

  function openChartMenu(node: SpaceNode, x: number, y: number, returnFocus?: HTMLElement) {
    menuRequest.current++;
    setMenu({ kind: "chart", path: spaceSegments(node), x, y, returnFocus });
  }

  function returnFromMenu() {
    if (menu?.kind === "chart" && menu.returnFocus?.isConnected) menu.returnFocus.focus({ preventScroll: true });
    else focus();
  }

  function runMenuAction(command: SpaceItemCommand | "reveal") {
    if (!menu) return;
    returnFromMenu();
    setMenu(null);
    if (menu.kind === "tree") {
      if (command !== "reveal") runAction(entry, command);
      return;
    }
    const node = nearestSpaceNode(result.root, menu.path);
    if (spaceSegments(node).length !== menu.path.length) {
      setRevealError(t("This item is no longer in the scan."));
      return;
    }
    if (command === "reveal") void reveal(node);
    else {
      const item = spaceLocalItem(place, node);
      if (item && operationsAvailable) onItemAction([item], command);
    }
  }

  async function reveal(node = entry) {
    const request = ++revealRequest.current;
    setRevealError("");
    const target = spaceLocation(resolvePlace(place), node);
    try {
      await onReveal(target.place, target.reveal);
    } catch (error) {
      if (revealRequest.current === request) setRevealError(describeError(error));
    }
  }

  return <section className={`pane space-analyzer space-analyzer-${side}${active ? " active" : ""}`} aria-label={t("Space Analyzer")}
    data-help-topic="spaceAnalyzer" data-pane-side={side} data-layout={layout} onFocusCapture={onFocus}
    onKeyDown={(event) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }}>
    <header className="pane-heading">
      <span className="pane-title"><HardDrive aria-hidden="true" />{t("Space Analyzer")}</span>
      <Button ref={closeButton} data-help-topic="spaceActions" onClick={onClose}>{t("Close")}</Button>
    </header>
    <div className="space-target" data-help-topic="spacePath"><CompactAddressBreadcrumbs place={currentFolder} path={spacePath(currentFolder)}
      goTo={(target: FileLocation) => { if (canAnalyze(target)) onNavigate(target); }} /></div>
    <div className="space-toolbar">
      <div ref={viewModes} className="space-view-modes" role="group" aria-label={t("View")}>
        <Button data-help-topic="spaceTree" aria-pressed={view === "tree"} onClick={() => changeView("tree")}>{t("Tree")}</Button>
        <Button data-help-topic="spaceTreemap" aria-pressed={view === "treemap"} onClick={() => changeView("treemap")}>{t("Treemap")}</Button>
        <Button data-help-topic="spaceSunburst" aria-pressed={view === "sunburst"} onClick={() => changeView("sunburst")}>{t("Sunburst")}</Button>
      </div>
      {result.supportsAllocation ? <select data-help-topic="spaceMetric" aria-label={t("Size metric")} value={metric}
        onChange={(event) => setMetric(event.target.value as Metric)}>
        <option value="allocated">{t("Size on disk")}</option>
        <option value="logical">{t("File size")}</option>
      </select> : <span data-help-topic="spaceMetric">{t("File size")}</span>}
      {scanning && <Button data-help-topic="spaceActions" onClick={stop}>{t("Stop")}</Button>}
      <Button data-help-topic="spaceActions" onClick={rescan}>{t("Rescan")}</Button>
    </div>
    {result.phase !== "error" && (view === "tree" ? <SpaceTree result={result} metric={metric}
      expanded={expanded} toggle={toggle} selected={selected} select={select} tree={tree}
      itemContext={place.kind === "local" ? openItemMenu : undefined}
      itemShortcut={place.kind === "local" ? itemShortcut : undefined}
      marked={marked} changeMarks={changeMarks} clearMarks={() => setMarked(new Set())} bindings={shortcuts}
      rightClickSelection={rightClickSelection} scope={spacePath(place)} /> :
      <div className="space-map" data-help-topic={view === "treemap" ? "spaceTreemap" : "spaceSunburst"}>
        <div className="space-map-heading">
          <Button className="icon-button" aria-label={t("Parent folder")} disabled={!folder.parent}
            onClick={() => { if (folder.parent) browse(folder.parent); }}><ArrowLeft /></Button>
          <span title={folder.name}>{folder.name}</span><strong>{formatSize(folder[metric])}</strong>
        </div>
        {!entry.directory && <div className="space-chart-selection"><span>{entry.name}</span>
          <span>{formatSize(entry[metric])} · {percent(spaceShare(entry, metric))}</span></div>}
        {view === "treemap" ? <Treemap folder={folder} metric={metric} selected={selected} onActivate={activateChartEntry} openMenu={openChartMenu} /> :
          <SpaceSunburst folder={folder} metric={metric} selected={selected} result={result} onActivate={activateChartEntry} openMenu={openChartMenu} />}
      </div>)}
    {result.error && <p className="space-error" role="alert" data-help-topic="spaceActions">{t(result.phase === "error" ? "Could not scan the folder." :
      "Connection interrupted. Reconnect and rescan.")} {errorText(result.error)}</p>}
    {revealError && <p className="space-error" role="alert" data-help-topic="spaceActions">{errorText(revealError)}</p>}
    <footer className="space-footer" data-help-topic="spaceActions">
      <span role="status">{scanning ? t("Scanning…") : incomplete ? t("Partial results") : ""}</span>
      <Button disabled={result.phase === "error"} onClick={() => void reveal()}>{t("Show in other pane")}</Button>
    </footer>
    {menu && <FileContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} onReturn={returnFromMenu}>
      {menu.kind === "chart" && <Button role="menuitem" onClick={() => runMenuAction("reveal")}>{t("Show in other pane")}</Button>}
      {place.kind === "local" && operationsAvailable && <>
        <Button role="menuitem" onClick={() => runMenuAction("copy")}>{t("Copy")}</Button>
        <Button role="menuitem" onClick={() => runMenuAction("move")}>{t("Rename or move")}</Button>
        {!smbHost(place) && <Button role="menuitem" onClick={() => runMenuAction("recycle")}>{t("Move to Trash")}</Button>}
        <Button role="menuitem" onClick={() => runMenuAction("delete")}>{t("Delete permanently")}</Button>
      </>}
    </FileContextMenu>}
  </section>;
}
