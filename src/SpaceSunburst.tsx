import { useMemo, useState, type CSSProperties } from "react";
import { Button } from "./Button";
import { locale, t } from "./i18n";
import { formatSize } from "./panes";
import { sortedSpaceChildren, spaceSegments, type Metric, type SpaceNode, type SpaceResult } from "./spaceScan";

type Sector = { key: string; entry: SpaceNode | null; start: number; end: number; size: number; share: number; depth: 0 | 1; color: number };
type OpenMenu = (entry: SpaceNode, x: number, y: number, returnFocus?: HTMLElement) => void;
const circle = Math.PI * 2;
const rings = [[52, 99], [101, 154]] as const;

function sectors(parent: SpaceNode, metric: Metric, start: number, end: number, depth: 0 | 1, color = 0): Sector[] {
  const children = sortedSpaceChildren(parent, metric).filter((child) => child[metric] > 0);
  const limit = depth ? 8 : 25;
  const total = children.reduce((sum, child) => sum + child[metric], 0);
  const groups = children.slice(0, limit).map((entry): { entry: SpaceNode | null; size: number } => ({ entry, size: entry[metric] }));
  if (children.length > limit) groups.push({ entry: null, size: children.slice(limit).reduce((sum, child) => sum + child[metric], 0) });
  let cursor = start;
  return groups.flatMap(({ entry, size }, index) => {
    const share = size / total;
    const next = cursor + share * (end - start);
    const currentColor = depth ? color : index % 5;
    const sector: Sector = { key: JSON.stringify(entry ? spaceSegments(entry) : [...spaceSegments(parent), null]),
      entry, start: cursor, end: next, size, share, depth, color: currentColor };
    cursor = next;
    return !depth && entry?.directory ? [sector, ...sectors(entry, metric, sector.start, sector.end, 1, currentColor)] : [sector];
  });
}

function sectorPath({ start, end, depth }: Sector) {
  const [inner, outer] = rings[depth];
  const last = Math.min(end, start + circle - .0001);
  const point = (angle: number, radius: number) => `${160 + Math.sin(angle) * radius} ${160 - Math.cos(angle) * radius}`;
  const wide = last - start > Math.PI ? 1 : 0;
  return `M ${point(start, outer)} A ${outer} ${outer} 0 ${wide} 1 ${point(last, outer)} L ${point(last, inner)} A ${inner} ${inner} 0 ${wide} 0 ${point(start, inner)} Z`;
}

export function SpaceSunburst({ folder, metric, selected, result, onActivate, openMenu }: {
  folder: SpaceNode;
  metric: Metric;
  selected: number;
  result: SpaceResult;
  onActivate: (entry: SpaceNode | null) => void;
  openMenu: OpenMenu;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const parts = useMemo(() => sectors(folder, metric, 0, circle, 0), [folder, metric, result]);
  const numbers = new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 1 });
  const label = (entry: SpaceNode | null) => entry?.name ?? t("More items");
  if (!parts.length) return <p className="pane-empty">{t("No space to display.")}</p>;

  return <div className="sunburst-layout">
    <div className="sunburst-chart" aria-hidden="true">
      <svg viewBox="0 0 320 320" onPointerLeave={() => setHovered(null)}>
        {parts.map((part) => <path key={part.key} d={sectorPath(part)} data-depth={part.depth} data-color={part.color}
          data-selected={hovered === part.key || part.entry?.id === selected || undefined}
          onPointerEnter={() => setHovered(part.key)} onClick={() => onActivate(part.entry)}
          onContextMenu={part.entry ? (event) => {
            event.preventDefault();
            openMenu(part.entry!, event.clientX, event.clientY);
          } : undefined}><title>{label(part.entry)} · {formatSize(part.size)} · {numbers.format(part.share)}</title></path>)}
      </svg>
      <span className="sunburst-center" title={folder.name}>{folder.name}</span>
    </div>
    <div className="sunburst-items" role="group" aria-label={t("Sunburst items")}>
      {parts.map((part) => <Button key={part.key} type="button" style={{ "--sunburst-depth": part.depth } as CSSProperties}
        aria-pressed={part.entry?.id === selected} tooltip={part.entry ? spaceSegments(part.entry).join("/") : undefined}
        onFocus={() => setHovered(part.key)} onBlur={() => setHovered(null)} onClick={() => onActivate(part.entry)}
        onContextMenu={part.entry ? (event) => {
          event.preventDefault();
          openMenu(part.entry!, event.clientX, event.clientY, event.currentTarget);
        } : undefined} onKeyDown={(event) => {
          if (!part.entry || !(event.key === "ContextMenu" || event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          openMenu(part.entry, bounds.left + 12, bounds.bottom, event.currentTarget);
        }}>
        <span>{label(part.entry)}</span><span>{formatSize(part.size)}</span><span>{numbers.format(part.share)}</span>
      </Button>)}
    </div>
  </div>;
}
