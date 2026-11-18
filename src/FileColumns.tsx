import { t } from "./i18n";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Check } from "lucide-react";
import { Button } from "./Button";
import type { PaneState, Side, SortColumn } from "./panes";

const columns = [
  { key: "name", label: "Name", min: 64 },
  { key: "size", label: "Size", min: 48 },
  { key: "modified", label: "Modified", min: 74 },
] as const;
const maxWidth = 2400;
const storageKey = (side: Side) => `dirlume.file-column-layout.${side}`;
export type ColumnWidths = Partial<Record<SortColumn, number>>;
type OptionalColumn = Exclude<SortColumn, "name">;
type ColumnVisibility = Partial<Record<OptionalColumn, boolean>>;
export type ColumnLayout = { widths: ColumnWidths; visibility: ColumnVisibility };

function clampWidth(width: number, min: number) {
  return Math.max(min, Math.min(maxWidth, Math.round(width)));
}

export function readColumnLayout(side: Side): ColumnLayout {
  const layout: ColumnLayout = { widths: {}, visibility: {} };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(side)) ?? "null") as Partial<ColumnLayout> | null;
    const widths = saved?.widths ?? JSON.parse(localStorage.getItem(`dirlume.file-column-widths.${side}`) ?? "null") as ColumnWidths | null;
    for (const { key, min } of columns) {
      const width = widths?.[key];
      if (typeof width === "number" && Number.isFinite(width)) layout.widths[key] = clampWidth(width, min);
      if (key !== "name") {
        const visible = saved?.visibility?.[key];
        if (typeof visible === "boolean") layout.visibility[key] = visible;
      }
    }
  } catch { /* Use defaults if the saved layout cannot be read. */ }
  return layout;
}

export function saveColumnLayout(side: Side, layout: ColumnLayout) {
  try { localStorage.setItem(storageKey(side), JSON.stringify(layout)); } catch { /* The current layout still applies. */ }
}

export function columnWidthsStyle(widths: ColumnWidths): CSSProperties {
  const style: Record<string, string> = {};
  for (const { key } of columns) {
    if (widths[key] !== undefined) style[`--file-${key}-width`] = `${widths[key]}px`;
  }
  return style as CSSProperties;
}

type Drag = { pointer: number; x: number; width: number; base: ColumnWidths; latest: ColumnWidths | null };
type ColumnMenu = { x: number; y: number; visible: Record<OptionalColumn, boolean>; trigger: HTMLElement | null };

export function FileColumns({ container, layout, sort, onSort, onResize, onVisibility }: {
  container: Ref<HTMLDivElement>;
  layout: ColumnLayout;
  sort: PaneState["sort"];
  onSort: (column: SortColumn) => void;
  onResize: (widths: ColumnWidths, persist: boolean) => void;
  onVisibility: (column: OptionalColumn, visible: boolean) => void;
}) {
  const { widths, visibility } = layout;
  const nameColumn = useRef<HTMLDivElement>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<ColumnMenu | null>(null);
  const drag = useRef<Drag | null>(null);

  useLayoutEffect(() => {
    const element = menuElement.current;
    if (!menu || !element) return;
    element.style.left = `${Math.max(6, Math.min(menu.x, window.innerWidth - element.offsetWidth - 6))}px`;
    element.style.top = `${Math.max(6, Math.min(menu.y, window.innerHeight - element.offsetHeight - 6))}px`;
    element.querySelector<HTMLButtonElement>("button:enabled")?.focus({ preventScroll: true });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuElement.current?.contains(event.target)) dismiss();
    };
    window.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [menu]);

  function openMenu(header: HTMLDivElement, x: number, y: number, target: EventTarget | null) {
    const displayed = (column: OptionalColumn) => {
      const cell = header.querySelector(`.col-${column}`);
      return !!cell && getComputedStyle(cell).display !== "none";
    };
    const trigger = target instanceof HTMLElement ? target.closest<HTMLElement>("button, [tabindex]") : null;
    setMenu({ x, y, visible: { size: displayed("size"), modified: displayed("modified") },
      trigger: trigger ?? nameColumn.current?.querySelector("button") ?? null });
  }

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

  return <div className="file-columns" ref={container} onContextMenu={(event) => {
    event.preventDefault();
    event.stopPropagation();
    openMenu(event.currentTarget, event.clientX, event.clientY, event.target);
  }} onKeyDown={(event) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = (event.target as HTMLElement).getBoundingClientRect();
    openMenu(event.currentTarget, bounds.left, bounds.bottom, event.target);
  }}>
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
    {menu && createPortal(
      <div className="file-column-menu" ref={menuElement} role="menu" aria-label={t("Columns")}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setMenu(null); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            (menu.trigger?.isConnected && menu.trigger.getClientRects().length ? menu.trigger :
              nameColumn.current?.querySelector("button"))?.focus({ preventScroll: true });
            setMenu(null);
            return;
          }
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Home" && event.key !== "End") return;
          event.preventDefault();
          event.stopPropagation();
          const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:enabled")];
          const index = choices.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 :
            (index + (event.key === "ArrowUp" ? -1 : 1) + choices.length) % choices.length;
          choices[next]?.focus();
        }}>
        {columns.map(({ key, label }) => {
          const checked = key === "name" || (visibility[key] ?? menu.visible[key]);
          return <Button type="button" key={key} role="menuitemcheckbox" aria-checked={checked} disabled={key === "name"}
            onClick={() => { if (key !== "name") onVisibility(key, !checked); }}>
            <span className="file-column-check" aria-hidden="true">{checked && <Check />}</span>{t(label)}
          </Button>;
        })}
      </div>, document.body)}
  </div>;
}
