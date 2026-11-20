import { useRef } from "react";
import { t } from "./i18n";

export const maxColumnWidth = 2400;
export function clampColumnWidth(width: number, min: number) {
  return Math.max(min, Math.min(maxColumnWidth, Math.round(width)));
}

type Drag = { pointer: number; x: number; width: number; latest?: number };

export function ColumnResizeHandle({ label, min, width, onResize, onReset }: {
  label: string;
  min: number;
  width: number | undefined;
  onResize: (width: number, persist: boolean) => void;
  onReset: () => void;
}) {
  const drag = useRef<Drag | null>(null);
  return <div className="file-column-resize" role="separator" aria-orientation="vertical" tabIndex={0}
    aria-label={t("Resize {0} column", t(label))} aria-valuemin={min} aria-valuemax={maxColumnWidth} aria-valuenow={width}
    aria-valuetext={width === undefined ? t("Automatic width") : t("{0} pixels", width)}
    data-tooltip={t("Resize {0} column (drag or use the arrow keys, double-click to reset)", t(label))}
    onPointerDown={(event) => {
      const handle = event.currentTarget;
      if (event.button !== 0 || drag.current || !handle.parentElement) return;
      event.preventDefault();
      handle.focus({ preventScroll: true });
      handle.setPointerCapture(event.pointerId);
      drag.current = { pointer: event.pointerId, x: event.clientX, width: handle.parentElement.getBoundingClientRect().width };
    }}
    onPointerMove={(event) => {
      const start = drag.current;
      if (!start || start.pointer !== event.pointerId || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const next = clampColumnWidth(start.width + event.clientX - start.x, min);
      if (next === (start.latest ?? Math.round(start.width))) return;
      start.latest = next;
      onResize(next, false);
    }}
    onLostPointerCapture={(event) => {
      const start = drag.current;
      if (!start || start.pointer !== event.pointerId) return;
      drag.current = null;
      if (start.latest !== undefined) onResize(start.latest, true);
    }}
    onDoubleClick={onReset}
    onKeyDown={(event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
      const column = event.currentTarget.parentElement;
      if (!column) return;
      event.preventDefault();
      event.stopPropagation();
      onResize(clampColumnWidth(column.getBoundingClientRect().width + (event.key === "ArrowLeft" ? -8 : 8), min), true);
    }} />;
}
