import type { PointerEvent } from "react";

export function clampSplit(value: number) {
  return Math.max(20, Math.min(80, value));
}

export function SplitDivider({ label, className, value, onResize }: {
  label: string;
  className: string;
  value: number;
  onResize: (value: number) => void;
}) {
  function drag(event: PointerEvent<HTMLDivElement>) {
    const grip = event.currentTarget;
    if (!grip.hasPointerCapture(event.pointerId)) return;
    const bounds = grip.parentElement?.getBoundingClientRect();
    const gutter = grip.getBoundingClientRect().width;
    if (bounds && bounds.width > gutter) onResize(clampSplit((event.clientX - bounds.left - gutter / 2) / (bounds.width - gutter) * 100));
  }

  return <div className={className} role="separator" data-help-topic="workspace" aria-label={label} aria-orientation="vertical"
    aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(value)} tabIndex={0}
    onDoubleClick={() => onResize(50)}
    onPointerDown={(event) => {
      if (event.button === 0) event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={drag} onKeyDown={(event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      onResize(clampSplit(value + (event.key === "ArrowLeft" ? -1 : 1)));
    }} />;
}
