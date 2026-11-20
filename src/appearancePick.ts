import { colorGroups, fontGroups, mermaidColors, viewerColors, type Color, type FontGroup } from "./appearance";
import { locale, t } from "./i18n";
import { panelLayouts, type PanelLayout } from "./preferences";
import { viewFonts, type ViewFont } from "./viewFonts";

const targets = {
  window: "Window", toolbar: "Toolbar", menu: "Main menu", status: "Status bar",
  button: "Button", panel: "File panels", panelHeader: "Panel headers and footers",
  row: "File row", dialog: "Dialog", dialogHeader: "Dialog header or footer",
  dialogField: "Dialog field", viewer: "Viewer", editor: "Editor", terminal: "Terminal",
  diagram: "Mermaid diagrams", comparison: "Compare files",
} as const;

export type AppearancePick = {
  target: keyof typeof targets;
  colors: Color[];
  font?: FontGroup;
  view?: ViewFont;
  layout?: PanelLayout;
  row?: "current" | "marked";
};

export type PickHistoryEntry = AppearancePick & { id: string; time: number };
const historyKey = "dirlume.appearance-picks";
export const colorLabels = Object.assign({}, ...Object.values(colorGroups).map(({ colors }) => colors),
  viewerColors, mermaidColors) as Record<Color, string>;

export function pickLabel(pick: AppearancePick) {
  if (pick.layout) {
    const row = pick.row === "current" ? "Current file row" : pick.row === "marked" ? "Marked file row" : targets[pick.target];
    return t("{0} ({1})", t(row), t(panelLayouts[pick.layout]));
  }
  return t(targets[pick.target]);
}

export function localPickDate(time: number) {
  return new Intl.DateTimeFormat(locale(), { dateStyle: "long" }).format(time);
}

export function readAppearancePick(value: unknown): AppearancePick | null {
  if (typeof value !== "object" || value === null) return null;
  const pick = value as Partial<AppearancePick>;
  if (typeof pick.target !== "string" || !Object.hasOwn(targets, pick.target) ||
      !Array.isArray(pick.colors) || !pick.colors.every((color) => typeof color === "string" && Object.hasOwn(colorLabels, color))) return null;
  return {
    target: pick.target, colors: [...new Set(pick.colors)],
    font: pick.font && Object.hasOwn(fontGroups, pick.font) ? pick.font : undefined,
    view: pick.view && Object.hasOwn(viewFonts, pick.view) ? pick.view : undefined,
    layout: pick.layout && Object.hasOwn(panelLayouts, pick.layout) ? pick.layout : undefined,
    row: pick.row === "current" || pick.row === "marked" ? pick.row : undefined,
  };
}

export function readPickHistory(): PickHistoryEntry[] {
  try {
    const items: unknown = JSON.parse(localStorage.getItem(historyKey) ?? "[]");
    if (!Array.isArray(items)) return [];
    return items.flatMap((entry) => {
      const pick = readAppearancePick(entry);
      return pick && typeof entry.id === "string" && Number.isFinite(entry.time) && Math.abs(entry.time) <= 8.64e15
        ? [{ ...pick, id: entry.id, time: entry.time as number }] : [];
    }).sort((a, b) => b.time - a.time);
  } catch { return []; }
}

export function savePickHistory(history: PickHistoryEntry[]) {
  try { localStorage.setItem(historyKey, JSON.stringify(history)); } catch { /* Keep the current session usable. */ }
}

type Target = { element: Element; pick: AppearancePick };

export function resolvePick(element: Element): Target | null {
  function match(selector: string, pick: AppearancePick): Target | null {
    const target = element.closest(selector);
    return target ? { element: target, pick } : null;
  }

  if (element.closest("[data-appearance-picker], .window-controls, .window-resize-marker, .dialog-resize-edge, .pane-divider, .terminal-divider, video, audio, .file-list > [aria-hidden=true]")) return null;
  const dialog = element.closest("dialog[open]");
  if (dialog && !dialog.classList.contains("dialog-window")) {
    const warning = dialog.hasAttribute("data-tone");
    return match("input, select, textarea", { target: "dialogField", colors: ["dialog-input", "dialog-ink", "line", "accent"], font: "dialog" }) ??
      match("button.alert-confirm", { target: "button", colors: ["danger-action", "on-danger-action", "accent"], font: "dialog" }) ??
      match("button.primary", { target: "button", colors: ["accent-fill", "on-accent", "accent"], font: "dialog" }) ??
      match(".dialog-heading, .dialog-footer", { target: "dialogHeader", colors: ["dialog-header", "dialog-ink", "dialog-muted", "line"], font: "dialog" }) ??
      { element: dialog, pick: { target: "dialog", colors: ["dialog-bg", "dialog-ink", "dialog-muted", "line", ...(warning ? ["danger"] as const : [])], font: "dialog" } };
  }

  const row = element.closest<HTMLElement>(".file-row");
  const pane = row?.closest<HTMLElement>(".pane");
  if (row && pane) {
    const layout = pane.dataset.layout as PanelLayout;
    const marked = row.classList.contains("marked");
    const current = row.dataset.current === "true";
    const active = pane.classList.contains("active");
    const fileColor = row.dataset.fileColor as Color | undefined;
    const colors: Color[] = ["panel-bg", "panel-ink", "panel-muted"];
    if (layout === "classic" && current && active) colors.push("accent-fill", ...(marked ? [] : ["on-accent"] as const));
    if (layout === "twin" && current && active) colors.push("accent");
    if (layout !== "classic" && layout !== "twin" && (current || marked)) {
      colors.push(active ? "panel-selection" : "panel-inactive-selection");
      if (active) colors.push("panel-selected-ink");
      colors.push("line", "accent");
    }
    if (marked) colors.push("panel-marked");
    if (fileColor && Object.hasOwn(colorLabels, fileColor) &&
        ((!current && !marked) || fileColor === "file-hidden" || fileColor === "file-system" ||
          (document.documentElement.dataset.theme === "classic-blue" && !active && !marked))) colors.push(fileColor);
    if (!marked && row.querySelector(".folder-icon")) colors.push("folder");
    return { element: row, pick: { target: "row", colors, font: "panel", layout,
      view: pane.id === "right-pane" ? "right" : "left", row: current ? "current" : marked ? "marked" : undefined } };
  }

  const text = element.closest(".text-window, .comparison-editor");
  if (text) {
    const editing = text.getAttribute("data-editing") === "true";
    const comparison = text.classList.contains("comparison-editor");
    const markdown = element.closest(".markdown-preview") !== null;
    const colors: Color[] = [editing || comparison ? "text-bg" : "viewer-bg", "text-ink", "line"];
    if (element.closest(".code-surface")) colors.push(...Object.keys(colorGroups.text.colors).filter((key) => key.startsWith("syntax-")) as Color[]);
    if (comparison) colors.push("added", "removed");
    return match(".mermaid-preview, .mermaid-diagram", { target: "diagram", colors: [...Object.keys(mermaidColors) as Color[], "viewer-bg"], font: "viewer", view: "markdown" }) ??
      match(".document-heading, .document-shortcuts, .syntax-toolbar", { target: editing ? "editor" : "viewer", colors: ["dialog-header", "ink", "muted", "line"], font: "ui" }) ??
      { element: element.closest(".text-view, .code-surface") ?? text, pick: { target: comparison ? "comparison" : editing ? "editor" : "viewer",
        colors, font: editing || comparison ? "editor" : "viewer", view: comparison || editing ? "editor" : markdown ? "markdown" : "viewer" } };
  }

  return match(".statusbar", { target: "status", colors: ["surface", "muted", "line", ...(element.closest(".statusbar.danger") ? ["danger"] as const : [])], font: "ui" }) ??
    match(".terminal-surface", { target: "terminal", colors: ["text-bg", "text-ink", "accent", "panel-selection"], font: "terminal" }) ??
    match(".terminal-card header", { target: "terminal", colors: ["raised", "ink", "muted", "line"], font: "ui" }) ??
    match(".terminal-card, .command-bar", { target: "terminal", colors: ["text-bg", "text-ink", "line"], font: "terminal" }) ??
    match(".main-menu, [role=menu]", { target: "menu", colors: ["surface", "raised", "ink", "muted", "line", "accent"], font: "ui" }) ??
    match(".pane-heading, .pane-footer, .file-columns, .pane-tools, .pane address, .pane-drive-bar, .pane-status", {
      target: "panelHeader", colors: ["panel-header", "panel-ink", "panel-muted", "line", "accent"], font: "panel",
    }) ??
    match(".pane .file-list, .pane .pane-empty, .pane", { target: "panel", colors: ["panel-bg", "panel-ink", "panel-muted", "line", "accent"], font: "panel" }) ??
    match("button.primary", { target: "button", colors: ["accent-fill", "on-accent", "accent"], font: "ui" }) ??
    match(".topbar, .actionbar, .document-bar", { target: "toolbar", colors: ["surface", "raised", "ink", "muted", "line", "accent"], font: "ui" }) ??
    match(".app", { target: "window", colors: ["canvas", "ink", "muted", "line", "accent"], font: "ui" });
}
