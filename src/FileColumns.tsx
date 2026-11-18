import { t } from "./i18n";
import { useRef, type CSSProperties, type Ref } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "./Button";
import type { PaneState, Side, SortColumn } from "./panes";

const columns = [
  { key: "name", label: "Name", min: 64 },
  { key: "size", label: "Size", min: 48 },
  { key: "modified", label: "Modified", min: 74 },
] as const;
const maxWidth = 2400;
const storageKey = (side: Side) => `dirlume.file-column-widths.${side}`;
export type ColumnWidths = Partial<Record<SortColumn, number>>;

function clampWidth(width: number, min: number) {
  return Math.max(min, Math.min(maxWidth, Math.round(width)));
}

export function readColumnWidths(side: Side): ColumnWidths {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(side)) ?? "null") as ColumnWidths | null;
    const widths: ColumnWidths = {};
    for (const { key, min } of columns) {
      const width = saved?.[key];
      if (typeof width === "number" && Number.isFinite(width)) widths[key] = clampWidth(width, min);
    }
    return widths;
  } catch { return {}; }
}

export function saveColumnWidths(side: Side, widths: ColumnWidths) {
  try { localStorage.setItem(storageKey(side), JSON.stringify(widths)); } catch { /* The current layout still applies. */ }
}

export function columnWidthsStyle(widths: ColumnWidths): CSSProperties {
  const style: Record<string, string> = {};
  for (const { key } of columns) {
    if (widths[key] !== undefined) style[`--file-${key}-width`] = `${widths[key]}px`;
  }
  return style as CSSProperties;
}

type Drag = { pointer: number; x: number; width: number; base: ColumnWidths; latest: ColumnWidths | null };

export function FileColumns({ container, widths, sort, onSort, onResize }: {
  container: Ref<HTMLDivElement>;
  widths: ColumnWidths;
  sort: PaneState["sort"];
  onSort: (column: SortColumn) => void;
  onResize: (widths: ColumnWidths, persist: boolean) => void;
}) {
  const nameColumn = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  function captureWidths(): ColumnWidths {
    if (widths.name !== undefined || !nameColumn.current) return widths;
    // Keep Name in place when a neighboring column changes width.
    return { ...widths, name: clampWidth(nameColumn.current.getBoundingClientRect().width, columns[0].min) };
  }

  function reset(key: SortColumn) {
    const next = { ...widths };
    delete next[key];
    onResize(next, true);
  }

  return <div className="file-columns" ref={container}>
    <div className="file-column-grid">
      {columns.map(({ key, label, min }) => (
        <div key={key} ref={key === "name" ? nameColumn : undefined} className={`file-column col-${key}`}>
          <Button type="button" onClick={() => onSort(key)} title={t("Sort by {0}", t(label).toLocaleLowerCase())}>
            <span>{t(label)}</span>{sort.column === key && (sort.asc ? <ArrowUp /> : <ArrowDown />)}
          </Button>
          <div className="file-column-resize" role="separator" aria-orientation="vertical" tabIndex={0}
            aria-label={t("Resize {0} column", t(label))} aria-valuemin={min} aria-valuemax={maxWidth} aria-valuenow={widths[key]}
            aria-valuetext={widths[key] === undefined ? t("Automatic width") : t("{0} pixels", widths[key])}
            title={t("Resize {0} column (drag or use the arrow keys, double-click to reset)", t(label))}
            onPointerDown={(event) => {
              if (event.button !== 0 || drag.current || !event.currentTarget.parentElement) return;
              event.preventDefault();
              event.currentTarget.focus({ preventScroll: true });
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { pointer: event.pointerId, x: event.clientX,
                width: event.currentTarget.parentElement.getBoundingClientRect().width, base: captureWidths(), latest: null };
            }}
            onPointerMove={(event) => {
              const start = drag.current;
              if (!start || start.pointer !== event.pointerId || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
              const width = clampWidth(start.width + event.clientX - start.x, min);
              if (width === (start.latest?.[key] ?? Math.round(start.width))) return;
              start.latest = { ...start.base, [key]: width };
              onResize(start.latest, false);
            }}
            onLostPointerCapture={(event) => {
              const start = drag.current;
              if (!start || start.pointer !== event.pointerId) return;
              drag.current = null;
              if (start.latest) onResize(start.latest, true);
            }}
            onDoubleClick={() => reset(key)}
            onKeyDown={(event) => {
              if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
                  (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
              event.preventDefault();
              const width = event.currentTarget.parentElement!.getBoundingClientRect().width;
              onResize({ ...captureWidths(), [key]: clampWidth(width + (event.key === "ArrowLeft" ? -8 : 8), min) }, true);
            }} />
        </div>
      ))}
    </div>
  </div>;
}
