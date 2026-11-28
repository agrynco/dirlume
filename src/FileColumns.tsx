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
  name: "name", rightName: "name", markedName: "name", git: "git", size: "size", bytes: "size", date: "modified",
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

const autoWidths: Record<PanelField, number> = {
  name: 5, markedName: 5, rightName: 5, git: 5, size: 9, bytes: 12, date: 13, time: 9, owner: 15, links: 5,
};
export type ColumnSamples = Partial<Record<PanelField, readonly string[]>>;
const panelColumnFields = Object.keys(panelFields) as PanelField[];

export const isSizeField = (field: PanelField) => field === "size" || field === "bytes";

export function panelColumnTracks(columns: PanelColumn[], status = false) {
  const names = columns.filter(({ field }) => isNameField(field)).length;
  const flexibleNames = columns.filter(({ field, width }) => isNameField(field) && width === "0").length;
  const minimumPerName = names ? `min(5ch, ${55 / names}%)` : "0px";
  const nameMinimum = names ? `min(${names * 5}ch, 55%)` : "0px";
  const preferredWidth = (field: PanelField, width: string) => {
    const variable = `--${status ? "status" : "file"}-${field}-width`;
    const padded = `calc(${Number(width) || autoWidths[field]}ch + 8px)`;
    if (width === "0") return `var(${variable}, ${padded})`;
    return padded;
  };
  const fixed = columns.flatMap(({ field, width }, i) => {
    const measuredSize = isSizeField(field);
    const variable = `--${status ? "status" : "file"}-${field}-width`;
    const measuredWidth = `var(${variable}, 0px)`;
    const percentage = width.endsWith("%");
    if (percentage && !measuredSize) return [];
    if (width === "0" && isNameField(field)) return [];
    const chars = Number(width) || autoWidths[field];
    if (measuredSize) return [{ i, chars, expression: percentage ? measuredWidth : `max(${measuredWidth}, ${preferredWidth(field, width)})` }];
    const preferred = preferredWidth(field, width);
    const expression = isNameField(field) ? `max(0px, calc(${preferred} - ${minimumPerName}))` : preferred;
    return [{ i, chars, expression }];
  });
  const totalFixed = fixed.reduce((total, { chars }) => total + chars, 0);
  const used = fixed.map(({ expression }) => expression).join(" + ") || "0px";
  const percentageShare = columns.reduce((total, { width }) => total + (width.endsWith("%") ? Number.parseInt(width, 10) / 100 : 0), 0);
  const hasPercentage = percentageShare > 0;
  return columns.map(({ field, width }, i) => {
    const slot = fixed.find((item) => item.i === i);
    if (slot && isSizeField(field)) {
      if (!width.endsWith("%")) return slot.expression;
      const share = Number.parseInt(width, 10) / 100;
      return `calc(${slot.expression} + max(0px, calc((100% - (${used}) - ${nameMinimum}) * ${share})))`;
    }
    if (width.endsWith("%") && !slot) {
      const share = Number.parseInt(width, 10) / 100;
      const extra = `max(0px, calc((100% - (${used}) - ${nameMinimum}) * ${share}))`;
      return isNameField(field) ? `calc(${minimumPerName} + ${extra})` : extra;
    }
    if (slot) {
      // Intrinsic tracks fit their preferred widths before the flexible Name takes the rest.
      if (!hasPercentage) {
        const minimum = isNameField(field) ? minimumPerName : "0px";
        return `minmax(${minimum}, ${preferredWidth(field, width)})`;
      }
      const available = `(100% - ${nameMinimum})`;
      const proportional = `calc(${available} * ${slot.chars / totalFixed})`;
      const remaining = `calc(${available} - (${used}) + ${slot.expression})`;
      const extra = `min(${slot.expression}, max(0px, ${proportional}, ${remaining}))`;
      return isNameField(field) ? `calc(${minimumPerName} + ${extra})` : extra;
    }
    if (flexibleNames <= 1) return `minmax(${minimumPerName}, 1fr)`;
    // Use content widths to distribute the space left over after fitting the metadata.
    const preferred = `var(--${status ? "status" : "file"}-${field}-width, 0px)`;
    const share = `calc((100% - (${used}) - ${nameMinimum}) * ${(1 - percentageShare) / flexibleNames})`;
    return `minmax(max(${minimumPerName}, min(${preferred}, calc(${minimumPerName} + ${share}))), 1fr)`;
  }).join(" ");
}

export function FileColumns({ container, groups, columns, tracks, samples, statusSamples, visibility, sort, onSort, onVisibility }: {
  container: Ref<HTMLDivElement>;
  groups: PanelColumn[][];
  columns: PanelColumn[];
  tracks: string;
  samples: ColumnSamples;
  statusSamples: ColumnSamples;
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
    const text = document.createElement("canvas").getContext("2d");
    const measure = () => {
      // A document temporarily hides the panes. Keep their last measurements until they are visible again.
      if (pane.getBoundingClientRect().width === 0) return;
      for (const cell of cells) {
        let width = cell.getBoundingClientRect().width;
        const sampleStyle = cell.querySelector<HTMLElement>("[data-text-field]");
        if (text && sampleStyle) {
          const field = sampleStyle.dataset.textField as PanelField;
          const style = getComputedStyle(sampleStyle);
          text.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
          for (const label of samples[field] ?? []) width = Math.max(width, text.measureText(label).width + padding);
        }
        width = Math.ceil(width);
        const variable = `--${cell.dataset.status === undefined ? "file" : "status"}-${cell.dataset.column}-width`;
        if (width) pane.style.setProperty(variable, `${width}px`);
        else pane.style.removeProperty(variable);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const cell of cells) observer.observe(cell);
    document.fonts.addEventListener("loadingdone", measure);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", measure);
    };
  }, [samples]);

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
      {panelColumnFields.map((field) => <div key={field} data-column={field}>
        <button type="button" tabIndex={-1}><span>{t(friendlyLabel(field))}</span><ArrowUp /></button>
        {field === "owner" || isNameField(field)
          ? samples[field] && <span data-text-field={field} className={`file-column-probe-value probe-${field}`}>0</span>
          : samples[field]?.map((label) => <span key={label} className="file-column-probe-value">{label}</span>)}
      </div>)}
      {panelColumnFields.map((field) => <div key={field} data-column={field} data-status="">
        {statusSamples[field]?.map((label) => <span key={label} className="file-column-probe-status">{label}</span>)}
      </div>)}
    </div>
    {menu && <ColumnMenu anchor={menu} choices={choices} fallback={() => nameColumn.current?.querySelector("button")}
      onClose={() => setMenu(null)} />}
  </div>;
}
