import { t } from "./i18n";
import { useRef, useState, type CSSProperties, type Ref } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "./Button";
import { ColumnMenu, columnMenuBindings, type ColumnMenuAnchor } from "./ColumnMenu";
import { ColumnResizeHandle, clampColumnWidth } from "./ColumnResizeHandle";
import type { PaneState, Side, SortColumn } from "./panes";

const columns = [
  { key: "name", label: "Name", min: 64 },
  { key: "size", label: "Size", min: 48 },
  { key: "modified", label: "Modified", min: 74 },
] as const;
const storageKey = (side: Side) => `dirlume.file-column-layout.${side}`;
export type ColumnWidths = Partial<Record<SortColumn, number>>;
type OptionalColumn = Exclude<SortColumn, "name">;
type ColumnVisibility = Partial<Record<OptionalColumn, boolean>>;
export type ColumnLayout = { widths: ColumnWidths; visibility: ColumnVisibility };

export function readColumnLayout(side: Side): ColumnLayout {
  const layout: ColumnLayout = { widths: {}, visibility: {} };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(side)) ?? "null") as Partial<ColumnLayout> | null;
    const widths = saved?.widths ?? JSON.parse(localStorage.getItem(`dirlume.file-column-widths.${side}`) ?? "null") as ColumnWidths | null;
    for (const { key, min } of columns) {
      const width = widths?.[key];
      if (typeof width === "number" && Number.isFinite(width)) layout.widths[key] = clampColumnWidth(width, min);
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

type FileColumnMenu = { anchor: ColumnMenuAnchor; visible: Record<OptionalColumn, boolean> };

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
  const [menu, setMenu] = useState<FileColumnMenu | null>(null);

  function openMenu(header: HTMLDivElement, anchor: ColumnMenuAnchor) {
    const displayed = (column: OptionalColumn) => {
      const cell = header.querySelector(`.col-${column}`);
      return !!cell && getComputedStyle(cell).display !== "none";
    };
    setMenu({ anchor, visible: { size: displayed("size"), modified: displayed("modified") } });
  }

  function captureWidths(): ColumnWidths {
    if (widths.name !== undefined || !nameColumn.current) return widths;
    // Keep Name in place when a neighboring column changes width.
    return { ...widths, name: clampColumnWidth(nameColumn.current.getBoundingClientRect().width, columns[0].min) };
  }

  function reset(key: SortColumn) {
    const next = { ...widths };
    delete next[key];
    onResize(next, true);
  }

  return <div className="file-columns" ref={container} {...columnMenuBindings(openMenu)}>
    <div className="file-column-grid">
      {columns.map(({ key, label, min }) => (
        <div key={key} ref={key === "name" ? nameColumn : undefined} className={`file-column col-${key}`}>
          <Button type="button" onClick={() => onSort(key)} title={t("Sort by {0}", t(label).toLocaleLowerCase())}>
            <span>{t(label)}</span>{sort.column === key && (sort.asc ? <ArrowUp /> : <ArrowDown />)}
          </Button>
          <ColumnResizeHandle label={label} min={min} width={widths[key]} onReset={() => reset(key)}
            onResize={(width, persist) => onResize({ ...captureWidths(), [key]: width }, persist)} />
        </div>
      ))}
    </div>
    {menu && <ColumnMenu anchor={menu.anchor} fallback={() => nameColumn.current?.querySelector("button")} onClose={() => setMenu(null)}
      choices={columns.map(({ key, label }) => {
        const checked = key === "name" || (visibility[key] ?? menu.visible[key]);
        return { key, label, checked, disabled: key === "name", toggle: () => { if (key !== "name") onVisibility(key, !checked); } };
      })} />}
  </div>;
}
