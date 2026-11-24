import { t } from "./i18n";
import { useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import { ColumnMenu, columnMenuBindings, type ColumnMenuAnchor } from "./ColumnMenu";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "./Button";
import type { PaneState, Side, SortColumn } from "./panes";
import { isNameField, panelFields, type PanelColumn, type PanelField, type PanelModeId } from "./panelModes";

const sorts: Partial<Record<PanelField, SortColumn>> = {
  name: "name", rightName: "name", markedName: "name", size: "size", bytes: "size", date: "modified", time: "time", owner: "owner", links: "hardLinks",
};
export const fieldClass: Record<PanelField, string> = {
  name: "name", rightName: "name", markedName: "name", size: "size", bytes: "size", date: "modified",
  time: "time", owner: "owner", links: "links",
};
const storageKey = (side: Side, mode: PanelModeId) =>
  `dirlume.file-column-layout.${side}${mode === "full" ? "" : "." + mode}`;
export type ColumnVisibility = Partial<Record<string, boolean>>;

export function readColumnLayout(side: Side, mode: PanelModeId): ColumnVisibility {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(side, mode)) ?? "null") as
      { visibility?: ColumnVisibility; version?: number } | null;
    if (saved?.visibility) return {
      ...saved.visibility,
      time: saved.version !== 2 ? saved.visibility.time ?? saved.visibility.modified : saved.visibility.time,
    };
  } catch { /* Use defaults if the saved layout cannot be read. */ }
  return {};
}

export function saveColumnLayout(side: Side, mode: PanelModeId, visibility: ColumnVisibility) {
  try { localStorage.setItem(storageKey(side, mode), JSON.stringify({ visibility, version: 2 })); }
  catch { /* The current layout still applies. */ }
}



const friendlyLabel = (field: PanelField) => isNameField(field) ? "Name" : field === "bytes" ? "Size" : panelFields[field];

export function columnGroupTrack(groups: PanelColumn[][], index: number): CSSProperties {
  return { gridColumn: `${1 + groups.slice(0, index).reduce((count, group) => count + group.length, 0)} / span ${groups[index].length}` };
}

const autoWidths: Partial<Record<PanelField, number>> = { size: 9, bytes: 12, date: 13, time: 9, links: 5 };
export const measuredColumnFields = ["size", "bytes", "date", "time"] as const;
export type MeasuredColumnField = typeof measuredColumnFields[number];

export function panelColumnTracks(columns: PanelColumn[], fitMeasuredFolders = false) {
  const names = columns.filter(({ field }) => isNameField(field)).length;
  const minimumPerName = names ? `min(5ch, ${55 / names}%)` : "0px";
  const nameMinimum = names ? `min(${names * 5}ch, 55%)` : "0px";
  const fixed = columns.flatMap(({ field, width }, i) => {
    const measuredSize = fitMeasuredFolders && (field === "size" || field === "bytes");
    const measuredWidth = `var(--file-${field}-width, 0px)`;
    const percentage = width.endsWith("%");
    if (percentage && !measuredSize) return [];
    const chars = Number(width) || autoWidths[field];
    if (!chars) return [];
    if (percentage) return [{ i, chars, expression: measuredWidth }];
    const padded = `calc(${chars}ch + 8px)`;
    const expression = width === "0" && measuredColumnFields.some((candidate) => candidate === field)
      ? `var(--file-${field}-width, ${padded})` : measuredSize
        ? `max(${padded}, ${measuredWidth})` : isNameField(field)
        ? `max(0px, calc(${padded} - ${minimumPerName}))` : padded;
    return [{ i, chars, expression }];
  });
  const totalFixed = fixed.reduce((total, { chars }) => total + chars, 0);
  const used = fixed.map(({ expression }) => expression).join(" + ") || "0px";
  return columns.map(({ field, width }, i) => {
    const slot = fixed.find((item) => item.i === i);
    if (width.endsWith("%") && !slot) {
      const share = Number.parseInt(width, 10) / 100;
      const extra = `max(0px, calc((100% - (${used}) - ${nameMinimum}) * ${share}))`;
      return isNameField(field) ? `calc(${minimumPerName} + ${extra})` : extra;
    }
    if (slot) {
      const available = `(100% - ${nameMinimum})`;
      const proportional = `calc(${available} * ${slot.chars / totalFixed})`;
      const remaining = `calc(${available} - (${used}) + ${slot.expression})`;
      const extra = `min(${slot.expression}, max(0px, ${proportional}, ${remaining}))`;
      if (width.endsWith("%")) {
        // Reserve the measured label, then grant any remaining share of the row.
        const share = Number.parseInt(width, 10) / 100;
        const preferred = `calc((${remaining}) * ${share})`;
        const availableShare = `max(0px, calc((${available} - (${used})) * ${share}))`;
        return `max(${extra}, min(${preferred}, calc(${extra} + ${availableShare})))`;
      }
      return isNameField(field) ? `calc(${minimumPerName} + ${extra})` : extra;
    }
    return isNameField(field) ? `minmax(${minimumPerName}, 1fr)` : "minmax(0, 1fr)";
  }).join(" ");
}

export function FileColumns({ container, groups, columns, tracks, samples, visibility, sort, onSort, onVisibility }: {
  container: Ref<HTMLDivElement>;
  groups: PanelColumn[][];
  columns: PanelColumn[];
  tracks: string;
  samples: Partial<Record<MeasuredColumnField, readonly string[]>>;
  visibility: ColumnVisibility;
  sort: PaneState["sort"];
  onSort: (column: SortColumn) => void;
  onVisibility: (column: string, visible: boolean) => void;
}) {
  const nameColumn = useRef<HTMLDivElement>(null);

  const widthProbes = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<ColumnMenuAnchor | null>(null);

  useLayoutEffect(() => {
    const probes = widthProbes.current;
    const pane = probes?.closest<HTMLElement>(".pane");
    if (!probes || !pane) return;
    const cells = [...probes.querySelectorAll<HTMLElement>("[data-column]")];
    const measure = () => {
      for (const cell of cells) {
        const width = Math.ceil(cell.getBoundingClientRect().width);
        if (width) pane.style.setProperty(`--file-${cell.dataset.column}-width`, `${width}px`);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const cell of cells) observer.observe(cell);
    return () => observer.disconnect();
  }, []);

  const choices = [...new Map(columns.map(({ field }) => [fieldClass[field], friendlyLabel(field)]))]
    .map(([key, label]) => {
      const checked = key === "name" || visibility[key] !== false;
      return { key, label, checked, disabled: key === "name", toggle: () => onVisibility(key, !checked) };
    });

  return <div className="file-columns" data-help-topic="paneColumns" ref={container} {...columnMenuBindings((_, anchor) => setMenu(anchor))}>
    <div className="file-column-grid" style={{ gridTemplateColumns: tracks }}>
      {groups.map((group, groupIndex) => <div key={groupIndex} className="file-column-group" style={columnGroupTrack(groups, groupIndex)}>
        {group.map(({ field }, index) => {
          const key = sorts[field];
          const label = friendlyLabel(field);
          return <div key={index} ref={groupIndex === 0 && isNameField(field) ? nameColumn : undefined} className={`file-column col-${fieldClass[field]}`}>
            {key ? <Button type="button" onClick={() => onSort(key)} tooltip={t("Sort by {0}", t(label).toLocaleLowerCase())}>
              <span>{t(label)}</span>{sort.column === key && (sort.asc ? <ArrowUp /> : <ArrowDown />)}
            </Button> : <span className="file-column-label" data-tooltip={t(label)}>{t(label)}</span>}
          </div>;
        })}
      </div>)}
    </div>
    <div ref={widthProbes} className="file-column-probes" aria-hidden="true">
      {measuredColumnFields.map((field) => <div key={field} data-column={field}>
        <span className="file-column-probe-heading">{t(friendlyLabel(field))}</span>
        {samples[field]?.map((label) => <span key={label} className="file-column-probe-value">{label}</span>)}
      </div>)}
    </div>
    {menu && <ColumnMenu anchor={menu} choices={choices} fallback={() => nameColumn.current?.querySelector("button")}
      onClose={() => setMenu(null)} />}
  </div>;
}
