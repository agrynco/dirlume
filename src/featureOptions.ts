import type { FontGroup, Surface } from "./appearance";
import type { ViewFont } from "./viewFonts";

export const featureOptions = {
  filePanels: { label: "Main File Panels", font: "panel", views: ["left", "right"] },
  viewer: { label: "Viewer", font: "viewer", views: ["viewer", "hex", "markdown"] },
  editor: { label: "Editor", font: "editor", views: ["editor"] },
  terminal: { label: "Terminal", font: "terminal", views: [] },
} as const satisfies Record<string, { label: string; font: FontGroup; views: readonly ViewFont[] }>;

export type FeaturePage = keyof typeof featureOptions;

export const optionSurfaces = {
  viewer: ["viewer", "hex", "markdown"],
  editor: ["editor"],
  terminal: ["terminal", "command"],
  text: ["compare"],
} as const satisfies Record<string, readonly Surface[]>;

export function isFeaturePage(page: string): page is FeaturePage {
  return Object.hasOwn(featureOptions, page);
}
