import type { CSSProperties } from "react";

export const viewFonts = {
  left: { label: "Left file pane", size: "--panel-size", family: "--panel-font", sample: "Documents" },
  right: { label: "Right file pane", size: "--panel-size", family: "--panel-font", sample: "report.pdf" },
  viewer: { label: "Text and hex viewer", size: "--mono-size", family: "--mono", sample: "README.txt" },
  editor: { label: "Text editor", size: "--mono-size", family: "--mono", sample: "let count = 42;" },
  markdown: { label: "Markdown preview", size: "--ui-size", family: "--ui-font", sample: "Getting started" },
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

export function viewFontStyle(size?: number): CSSProperties | undefined {
  return size === undefined ? undefined : { "--view-font-size": `${size}px` } as CSSProperties;
}
