import { t } from "./i18n";
import { useEffect, useLayoutEffect, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Check } from "lucide-react";
import { Button } from "./Button";
import { formatDate, formatSize, type PaneState, type Side, type SortColumn } from "./panes";

const columns = [
  { key: "name", label: "Name" },
  { key: "size", label: "Size" },
  { key: "modified", label: "Date" },
  { key: "time", label: "Time" },
] as const;
const storageKey = (side: Side) => `dirlume.file-column-layout.${side}`;
type OptionalColumn = Exclude<SortColumn, "name">;
type ColumnVisibility = Partial<Record<OptionalColumn, boolean>>;
type ColumnLayout = { visibility: ColumnVisibility };

export function readColumnLayout(side: Side): ColumnLayout {
  const layout: ColumnLayout = { visibility: {} };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(side)) ?? "null") as (Partial<ColumnLayout> & { version?: number }) | null;
    for (const { key } of columns) {
      if (key !== "name") {
        const visible = saved?.visibility?.[key] ?? (key === "time" && saved?.version !== 2 ? saved?.visibility?.modified : undefined);
        if (typeof visible === "boolean") layout.visibility[key] = visible;
      }
    }
  } catch { /* Use defaults if the saved layout cannot be read. */ }
  return layout;
}

export function saveColumnLayout(side: Side, layout: ColumnLayout) {
  try { localStorage.setItem(storageKey(side), JSON.stringify({ ...layout, version: 2 })); } catch { /* The current layout still applies. */ }
}

type ColumnMenu = { x: number; y: number; visible: Record<OptionalColumn, boolean>; trigger: HTMLElement | null };

export function FileColumns({ container, layout, sort, onSort, onVisibility }: {
  container: Ref<HTMLDivElement>;
  layout: ColumnLayout;
  sort: PaneState["sort"];
  onSort: (column: SortColumn) => void;
  onVisibility: (column: OptionalColumn, visible: boolean) => void;
}) {
  const { visibility } = layout;
  const nameColumn = useRef<HTMLDivElement>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  const widthProbes = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<ColumnMenu | null>(null);

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
    setMenu({ x, y, visible: { size: displayed("size"), modified: displayed("modified"), time: displayed("time") },
      trigger: trigger ?? nameColumn.current?.querySelector("button") ?? null });
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
      {columns.map(({ key, label }) => (
        <div key={key} ref={key === "name" ? nameColumn : undefined} className={`file-column col-${key}`}>
          <Button type="button" onClick={() => onSort(key)} tooltip={t("Sort by {0}", t(label).toLocaleLowerCase())}>
            <span>{t(label)}</span>{sort.column === key && (sort.asc ? <ArrowUp /> : <ArrowDown />)}
          </Button>
        </div>
      ))}
    </div>
    <div ref={widthProbes} className="file-column-probes" aria-hidden="true">
      {columns.slice(1).map(({ key, label }) => {
        const date = new Date(2088, 10, 28, 11, 48).getTime() / 1000;
        const sample = key === "size" ? `≥ ${formatSize(1023.9 * 1024 ** 4)}` : formatDate(date, key === "time" ? "time" : "date");
        return <div key={key} data-column={key}><span>{t(label)}</span><span>{sample}</span></div>;
      })}
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
