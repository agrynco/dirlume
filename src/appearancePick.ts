import { colorKeysForSurface, colorLabels, fontGroups, mermaidColors, type Color, type FontGroup, type Surface } from "./appearance";
import { locale, t } from "./i18n";
import { panelLayouts, type PanelLayout } from "./preferences";
import { viewFonts, type ViewFont } from "./viewFonts";

const targets = {
  window: "Window", toolbar: "Toolbar", menu: "Main menu", status: "Status bar",
  button: "Button", panel: "File panels", panelHeader: "Panel headers and footers",
  row: "File row", dialog: "Dialog", dialogHeader: "Dialog header or footer",
  dialogField: "Dialog field", viewer: "Viewer", editor: "Editor", terminal: "Terminal",
  diagram: "Mermaid diagrams", comparison: "Compare files", hex: "Hex Viewer", markdown: "Markdown preview",
  command: "Command line",
} as const;

export type AppearancePick = {
  target: keyof typeof targets;
  colors: Color[];
  font?: FontGroup;
  view?: ViewFont;
  layout?: PanelLayout;
  row?: "current" | "marked" | "currentMarked";
};

export type PickHistoryEntry = AppearancePick & { id: string; time: number };
const historyKey = "dirlume.appearance-picks";
const pickedSurfaces: Partial<Record<AppearancePick["target"], Surface>> = {
  viewer: "viewer", editor: "editor", terminal: "terminal", comparison: "compare",
  hex: "hex", markdown: "markdown", command: "command",
};

export function pickedSurface(pick: Pick<AppearancePick, "target" | "font">) {
  return pick.font === "ui" ? undefined : pickedSurfaces[pick.target];
}

function surfacePick(target: AppearancePick["target"], surface: Surface): AppearancePick {
  return { target, font: surface, colors: colorKeysForSurface(surface), view: Object.hasOwn(viewFonts, surface) ? surface as ViewFont : undefined };
}

export function pickLabel(pick: AppearancePick) {
  if (pick.layout) {
    const row = pick.row === "currentMarked" ? "Current marked file row" :
      pick.row === "current" ? "Current file row" : pick.row === "marked" ? "Marked file row" : targets[pick.target];
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
  const target = pick.target === "viewer" && pick.view === "markdown" ? "markdown" : pick.target;
  const surface = pickedSurface({ target, font: pick.font });
  if (surface) return surfacePick(target, surface);
  return {
    target: pick.target, colors: [...new Set(pick.colors)],
    font: pick.font && Object.hasOwn(fontGroups, pick.font) ? pick.font : undefined,
    view: pick.view && Object.hasOwn(viewFonts, pick.view) ? pick.view : undefined,
    layout: pick.layout && Object.hasOwn(panelLayouts, pick.layout) ? pick.layout : undefined,
    row: pick.row === "current" || pick.row === "marked" || pick.row === "currentMarked" ? pick.row : undefined,
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
  const comparison = match(".comparison, .comparison-editor", surfacePick("comparison", "compare"));
  if (comparison) return comparison;
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
    const view = pane.id === "right-pane" ? "right" : "left";
    if (current && marked && active) return { element: row, pick: { target: "row",
      colors: ["panel-current-marked-bg", "panel-current-marked-outline", "panel-selected-ink", "panel-marked"],
      font: "panel", layout, view, row: "currentMarked" } };
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
      view, row: current ? "current" : marked ? "marked" : undefined } };
  }

  const text = element.closest(".text-window");
  if (text) {
    const editing = text.getAttribute("data-editing") === "true";
    return match(".mermaid-preview, .mermaid-diagram", { target: "diagram", colors: [...Object.keys(mermaidColors) as Color[], "markdown-bg"], font: "markdown", view: "markdown" }) ??
      match(".document-heading, .document-shortcuts, .syntax-toolbar", { target: editing ? "editor" : "viewer", colors: ["dialog-header", "ink", "muted", "line"], font: "ui" }) ??
      match(".hex-view", surfacePick("hex", "hex")) ??
      match(".markdown", surfacePick("markdown", "markdown")) ??
      { element: element.closest(".text-view, .code-surface") ?? text, pick: editing ? surfacePick("editor", "editor") : surfacePick("viewer", "viewer") };
  }

  return match(".statusbar", { target: "status", colors: ["surface", "muted", "line", ...(element.closest(".statusbar.danger") ? ["danger"] as const : [])], font: "ui" }) ??
    match(".terminal-surface", surfacePick("terminal", "terminal")) ??
    match(".terminal-card header", { target: "terminal", colors: ["raised", "ink", "muted", "line"], font: "ui" }) ??
    match(".terminal-card", surfacePick("terminal", "terminal")) ??
    match(".command-bar", surfacePick("command", "command")) ??
    match(".main-menu, [role=menu]", { target: "menu", colors: ["surface", "raised", "ink", "muted", "line", "accent"], font: "ui" }) ??
    match(".pane-heading, .pane-footer, .file-columns, .pane-tools, .pane address, .pane-drive-bar, .pane-status", {
      target: "panelHeader", colors: ["panel-header", "panel-ink", "panel-muted", "line", "accent"], font: "panel",
    }) ??
    match(".pane .file-list, .pane .pane-empty, .pane", { target: "panel", colors: ["panel-bg", "panel-ink", "panel-muted", "line", "accent"], font: "panel" }) ??
    match("button.primary", { target: "button", colors: ["accent-fill", "on-accent", "accent"], font: "ui" }) ??
    match(".topbar, .actionbar, .document-bar", { target: "toolbar", colors: ["surface", "raised", "ink", "muted", "line", "accent"], font: "ui" }) ??
    match(".app", { target: "window", colors: ["canvas", "ink", "muted", "line", "accent"], font: "ui" });
}
