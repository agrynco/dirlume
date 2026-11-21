import type { CSSProperties } from "react";

export const viewFonts = {
  left: { label: "Left file pane", group: "panel", family: "--panel-font", sample: "Documents" },
  right: { label: "Right file pane", group: "panel", family: "--panel-font", sample: "report.pdf" },
  viewer: { label: "Text viewer", group: "viewer", family: "--viewer-font", sample: "README.txt" },
  hex: { label: "Hexadecimal view", group: "hex", family: "--hex-font", sample: "00000000  48 65 6C 6C 6F" },
  editor: { label: "Text editor", group: "editor", family: "--editor-font", sample: "let count = 42;" },
  markdown: { label: "Markdown reading view", group: "markdown", family: "--markdown-font", sample: "Getting started" },
} as const;

export type ViewFont = keyof typeof viewFonts;
export type ViewFontSizes = Partial<Record<ViewFont, number>>;
export type ZoomViewFont = (view: ViewFont, change: number, base: number) => void;
export const viewFontKeys = Object.keys(viewFonts) as ViewFont[];
export const minViewFontSize = 8;
export const maxViewFontSize = 48;

export function validViewFontSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minViewFontSize && value <= maxViewFontSize;
}

export function migrateSharedViewerZoom(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.hasOwn(value, "hex")) return value;
  const sizes = value as Partial<Record<ViewFont, unknown>>;
  return validViewFontSize(sizes.viewer) ? { ...sizes, hex: sizes.viewer } : value;
}

export function viewFontStyle(size?: number): CSSProperties | undefined {
  return size === undefined ? undefined : { "--view-font-size": `${size}px` } as CSSProperties;
}
