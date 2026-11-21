import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, File, Folder, HardDrive } from "lucide-react";
import { ReadOnlyAddressBreadcrumbs } from "./AddressField";
import { Button } from "./Button";
import { describeError } from "./api";
import { errorText, locale, t } from "./i18n";
import { formatSize, type Side } from "./panes";
import {
  initialSpaceResult, scanSpace, sortedSpaceChildren, spaceLocation, spacePath, spaceShare, unavailable,
  type Metric, type SpaceNode, type SpacePlace, type SpaceResult,
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

function SpaceTree({ result, metric, selected, select, expanded, toggle }: {
  result: SpaceResult;
  metric: Metric;
  selected: number;
  select: (id: number) => void;
  expanded: ReadonlySet<number>;
  toggle: (id: number) => void;
}) {
  const id = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const [window, setWindow] = useState({ top: 0, height: rowHeight * 12 });
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const resize = new ResizeObserver(() => setWindow({ top: element.scrollTop, height: element.clientHeight }));
    resize.observe(element);
    return () => resize.disconnect();
  }, []);
  const rows = useMemo(() => {
    const rows: { entry: SpaceNode; level: number }[] = [];
    const stack = [{ entry: result.root, level: 1 }];
    while (stack.length) {
      const row = stack.pop()!;
      rows.push(row);
      if (!expanded.has(row.entry.id)) continue;
      const children = sortedSpaceChildren(row.entry, metric);
      for (let i = children.length - 1; i >= 0; i -= 1) stack.push({ entry: children[i], level: row.level + 1 });
    }
    return rows;
  }, [result, metric, expanded]);
  const start = Math.max(0, Math.floor(window.top / rowHeight) - 6);
  const end = Math.min(rows.length, Math.ceil((window.top + window.height) / rowHeight) + 6);
  const visible = rows.slice(start, end);

  function choose(index: number) {
    const element = viewport.current;
    const next = Math.max(0, Math.min(rows.length - 1, index));
    select(rows[next].entry.id);
    if (!element) return;
    const top = next * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + element.clientHeight) element.scrollTop = top + rowHeight - element.clientHeight;
  }

  function keyDown(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const index = Math.max(0, rows.findIndex(({ entry }) => entry.id === selected));
    const { entry } = rows[index];
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

  return <div className="space-tree" role="treegrid" aria-label={t("Space usage")} aria-rowcount={rows.length + 1}
    tabIndex={0} onKeyDown={keyDown}
    aria-activedescendant={visible.some(({ entry }) => entry.id === selected) ? id + selected : undefined}>
    <div className="space-tree-columns" role="row">
      <span role="columnheader">{t("Name")}</span><span role="columnheader" aria-sort="descending">{t("Size")}</span>
    </div>
    <div className="space-tree-scroll" ref={viewport} onScroll={(event) => {
      setWindow({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight });
    }}>
      <div style={{ height: rows.length * rowHeight, paddingTop: start * rowHeight }}>
        {visible.map(({ entry, level }, index) => {
          const Icon = entry.directory ? Folder : File;
          const open = expanded.has(entry.id);
          const share = spaceShare(entry, metric);
          const note = rowNote(entry, metric, result.phase === "scanning");
          return <div key={entry.id} id={id + entry.id} className="space-tree-row"
            role="row" aria-rowindex={start + index + 2} aria-level={level}
            aria-expanded={entry.children.length ? open : undefined} aria-selected={entry.id === selected}
            style={{ height: rowHeight }} onClick={(event) => {
              select(entry.id);
              event.currentTarget.closest<HTMLElement>("[role=treegrid]")?.focus({ preventScroll: true });
            }} onDoubleClick={() => { if (entry.children.length) toggle(entry.id); }}>
            <span className="space-tree-name" role="gridcell" style={{ paddingInlineStart: Math.min(level - 1, 12) * 13 }}
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

function Treemap({ folder, metric, selected, select, browse, showTree }: {
  folder: SpaceNode;
  metric: Metric;
  selected: number;
  select: (id: number) => void;
  browse: (entry: SpaceNode) => void;
  showTree: () => void;
}) {
  const children = sortedSpaceChildren(folder, metric).filter((child) => child[metric] > 0);
  const limit = 64;
  const tiles: Tile[] = children.slice(0, limit).map((entry) => ({ entry, size: entry[metric] }));
  if (children.length > limit) tiles.push({ entry: null, size: children.slice(limit).reduce((sum, child) => sum + child[metric], 0) });
  tilesIn(tiles);
  return <div className="space-map">
    <div className="space-map-heading">
      <Button className="icon-button" aria-label={t("Parent folder")} disabled={!folder.parent}
        onClick={() => { if (folder.parent) browse(folder.parent); }}><ArrowLeft /></Button>
      <span title={folder.name}>{folder.name}</span><strong>{formatSize(folder[metric])}</strong>
    </div>
    {tiles.length ? <div className="space-map-canvas" aria-label={t("Treemap")}>
      {tiles.map(({ entry, size, style }) => <Button key={entry?.id ?? "more"} className="space-tile" style={style}
        data-folder={entry?.directory || undefined} data-selected={entry?.id === selected || undefined}
        aria-label={t("{0}, {1}", entry?.name ?? t("More items"), formatSize(size))}
        tooltip={entry?.name ?? t("More items")} onClick={() => {
          if (!entry) showTree();
          else if (entry.directory) browse(entry);
          else select(entry.id);
        }}>
        <strong>{entry?.name ?? t("More items")}</strong>
        <span>{formatSize(size)}</span>
      </Button>)}
    </div> : <p className="pane-empty">{t("No space to display.")}</p>}
  </div>;
}

export default function SpaceAnalyzer({ side, place, onClose, onReveal, resolvePlace }: {
  side: Side;
  place: SpacePlace;
  onClose: () => void;
  onReveal: (place: SpacePlace, reveal?: string) => Promise<void>;
  resolvePlace: (place: SpacePlace) => SpacePlace;
}) {
  const [result, setResult] = useState(() => initialSpaceResult(place));
  const scan = useRef<AbortController | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const revealRequest = useRef(0);
  const [revision, setRevision] = useState(0);
  const [metricChoice, setMetric] = useState<Metric | null>(null);
  const [view, setView] = useState<"tree" | "treemap">("tree");
  const [expanded, setExpanded] = useState(new Set([0]));
  const [selected, setSelected] = useState(0);
  const [zoom, setZoom] = useState(0);
  const [revealError, setRevealError] = useState("");
  const metric = result.supportsAllocation ? metricChoice ?? "allocated" : "logical";
  const scanning = result.phase === "scanning";
  const incomplete = result.phase === "partial" || unavailable(result.root, metric) > 0;
  const folder = result.nodes.get(zoom) ?? result.root;
  const entry = result.nodes.get(selected) ?? result.root;

  useLayoutEffect(() => { closeButton.current?.focus(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    scan.current = controller;
    void scanSpace(resolvePlace(place), controller.signal, setResult);
    return () => { controller.abort(); revealRequest.current += 1; };
  }, [revision, place, resolvePlace]);

  function toggle(id: number) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function stop() {
    scan.current?.abort();
    setResult((current) => ({ ...current, phase: "partial" }));
  }

  function rescan() {
    scan.current?.abort();
    setExpanded(new Set([0]));
    setSelected(0);
    setZoom(0);
    setRevealError("");
    setRevision((value) => value + 1);
  }

  function browse(folder: SpaceNode) {
    setZoom(folder.id);
    setSelected(folder.id);
  }

  async function reveal() {
    const request = ++revealRequest.current;
    setRevealError("");
    const target = spaceLocation(resolvePlace(place), entry);
    try {
      await onReveal(target.place, target.reveal);
    } catch (error) {
      if (revealRequest.current === request) setRevealError(describeError(error));
    }
  }

  return <section className={"pane space-analyzer space-analyzer-" + side} aria-label={t("Space Analyzer")} data-help-topic="files" data-pane-side={side}
    onKeyDown={(event) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }}>
    <header className="pane-heading">
      <span className="pane-title"><HardDrive aria-hidden="true" />{t("Space Analyzer")}</span>
      <Button ref={closeButton} onClick={onClose}>{t("Close")}</Button>
    </header>
    <div className="space-target"><ReadOnlyAddressBreadcrumbs place={place} path={spacePath(place)} /></div>
    <div className="space-toolbar">
      <div className="space-view-modes" role="group" aria-label={t("View")}>
        <Button aria-pressed={view === "tree"} onClick={() => setView("tree")}>{t("Tree")}</Button>
        <Button aria-pressed={view === "treemap"} onClick={() => setView("treemap")}>{t("Treemap")}</Button>
      </div>
      {result.supportsAllocation ? <select aria-label={t("Size metric")} value={metric}
        onChange={(event) => setMetric(event.target.value as Metric)}>
        <option value="allocated">{t("Size on disk")}</option>
        <option value="logical">{t("File size")}</option>
      </select> : <span>{t("File size")}</span>}
      {scanning && <Button onClick={stop}>{t("Stop")}</Button>}
      <Button onClick={rescan}>{t("Rescan")}</Button>
    </div>
    {result.phase !== "error" && (view === "tree" ? <SpaceTree result={result} metric={metric}
      expanded={expanded} toggle={toggle} selected={selected} select={setSelected} /> :
      <Treemap folder={folder} metric={metric} selected={selected} select={setSelected} browse={browse} showTree={() => {
        setExpanded((previous) => {
          const next = new Set(previous);
          for (let node: SpaceNode | null = folder; node; node = node.parent) next.add(node.id);
          return next;
        });
        setView("tree");
      }} />)}
    {result.error && <p className="space-error" role="alert">{t(result.phase === "error" ? "Could not scan the folder." :
      "Connection interrupted. Reconnect and rescan.")} {errorText(result.error)}</p>}
    {revealError && <p className="space-error" role="alert">{errorText(revealError)}</p>}
    <footer className="space-footer">
      <span role="status">{scanning ? t("Scanning…") : incomplete ? t("Partial results") : ""}</span>
      <Button disabled={result.phase === "error"} onClick={() => void reveal()}>{t("Show in other pane")}</Button>
    </footer>
  </section>;
}
