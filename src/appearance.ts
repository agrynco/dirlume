import { useEffect, useState } from "react";
import type { Entry } from "./api";
import type { Preferences } from "./preferences";

export const builtInThemes = {
  system: "System",
  dark: "Dark",
  light: "Light",
  slate: "Slate",
  "classic-blue": "Classic blue",
  lavender: "Lavender",
  emerald: "Emerald",
  aurora: "Aurora",
  midnight: "Midnight blue",
  sunrise: "Sunrise",
  graphite: "Graphite",
} as const;

export type Theme = keyof typeof builtInThemes;
export type BaseTheme = Exclude<Theme, "system">;

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(builtInThemes, value);
}

function isBaseTheme(value: unknown): value is BaseTheme {
  return isTheme(value) && value !== "system";
}

export const baseThemes = Object.keys(builtInThemes).filter(isBaseTheme);

const lightThemes = new Set<BaseTheme>(["light", "lavender", "sunrise"]);
// These themes share rounded cards, glowing backgrounds and chip-style key buttons.
const modernThemes = new Set<BaseTheme>(["lavender", "emerald", "aurora", "midnight", "sunrise", "graphite"]);

export const isLightTheme = (theme: BaseTheme) => lightThemes.has(theme);
export const readTheme = (value: unknown): Theme => isTheme(value) ? value : "system";

const syntaxColors = {
  "syntax-keyword": "Syntax keywords",
  "syntax-string": "Syntax strings",
  "syntax-number": "Syntax numbers and constants",
  "syntax-comment": "Syntax comments",
  "syntax-type": "Syntax types and tags",
  "syntax-property": "Syntax properties and functions",
} as const;

export const colorGroups = {
  window: {
    label: "Window",
    colors: {
      canvas: "Window background",
      surface: "Toolbar and status bar",
      raised: "Raised surfaces",
      ink: "Window text",
      muted: "Secondary window text",
      line: "Borders",
      accent: "Accent and focus",
      "accent-fill": "Primary button background",
      "on-accent": "Primary button text",
    },
  },
  panels: {
    label: "Panels",
    colors: {
      "panel-bg": "Panel background",
      "panel-header": "Panel headers and footers",
      "panel-ink": "File and folder names",
      "panel-muted": "Panel details",
      folder: "Folder icons",
      "panel-selection": "Active selection background",
      "panel-selected-ink": "Active selection text",
      "panel-inactive-selection": "Inactive selection background",
      "panel-marked": "Marked items",
      "panel-current-marked-bg": "Current marked row background",
      "panel-current-marked-outline": "Current marked row outline",
    },
  },
  files: {
    label: "File types",
    colors: {
      "file-hidden": "Hidden files and folders",
      "file-system": "System files and folders",
      "file-source": "Source code",
      "file-text": "Text and Markdown",
      "file-document": "Office documents and PDF",
      "file-image": "Images",
      "file-media": "Audio and video",
      "file-archive": "Archives and disk images",
      "file-config": "Configuration and data",
      "file-executable": "Executables and scripts",
    },
  },
  dialogs: {
    label: "Dialogs",
    colors: {
      "dialog-bg": "Dialog background",
      "dialog-header": "Dialog headers and footers",
      "dialog-input": "Dialog fields",
      "dialog-ink": "Dialog text",
      "dialog-muted": "Secondary dialog text",
      "danger-bg": "Warning background",
      danger: "Warning text",
      "danger-action": "Alert confirmation background",
      "on-danger-action": "Alert confirmation text",
    },
  },
  text: {
    label: "Text tools",
    colors: {
      "text-bg": "Editor, viewer, and terminal background",
      "text-ink": "Editor, viewer, and terminal text",
      ...syntaxColors,
      added: "Added lines",
      removed: "Removed lines",
    },
  },
} as const;

type FileColor = keyof typeof colorGroups.files.colors;
type ExtensionColor = Exclude<FileColor, "file-hidden" | "file-system">;
const extensions: Record<ExtensionColor, string> = {
  "file-source": "c cc cpp cs css go h hpp html htm java js jsx kt less lua php py rb rs sass scss sql swift ts tsx vue",
  "file-text": "log markdown md rst txt",
  "file-document": "doc docx epub odf odg odp ods odt pdf ppt pptx rtf xls xlsx",
  "file-image": "avif bmp gif heic ico jpeg jpg png raw svg tif tiff webp",
  "file-media": "aac avi flac m4a m4v mkv mov mp3 mp4 mpeg ogg opus wav webm wma",
  "file-archive": "7z bz2 cab dmg gz img iso rar tar tgz xz zip zst",
  "file-config": "cfg conf csv db env ini json jsonl lock sqlite toml tsv xml yaml yml",
  "file-executable": "appimage bat bin cmd com deb dll exe msi ps1 rpm sh so",
};
const fileColors = new Map(Object.entries(extensions).flatMap(([color, values]) =>
  values.split(" ").map((extension): [string, ExtensionColor] => [extension, color as ExtensionColor])));

export function fileColor({ name, directory, hidden, system }: Pick<Entry, "name" | "system"> &
  Partial<Pick<Entry, "directory" | "hidden">>): FileColor | undefined {
  if (system) return "file-system";
  if (hidden) return "file-hidden";
  if (directory) return undefined;
  const filename = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
  if (filename === "makefile" || filename === "dockerfile") return "file-source";
  if (filename === ".env" || filename.startsWith(".env.")) return "file-config";
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? fileColors.get(filename.slice(dot + 1)) : undefined;
}

export type Color = {
  [Group in keyof typeof colorGroups]: keyof (typeof colorGroups)[Group]["colors"];
}[keyof typeof colorGroups] | keyof typeof viewerColors | keyof typeof mermaidColors | SurfaceColor;
export const viewerColors = {
  "viewer-bg": "Viewer background",
  "viewer-outside-bg": "Outside reading area background",
} as const;
export const mermaidColors = {
  "mermaid-node-bg": "Block background",
  "mermaid-node-ink": "Block text",
  "mermaid-node-border": "Block border",
} as const;
type ColorFields = Record<string, readonly [label: string, fallback: string]>;
function surfaceSyntax<Prefix extends "viewer" | "editor">(prefix: Prefix) {
  return Object.fromEntries(Object.entries(syntaxColors).map(([key, label]) => [
    `${prefix}-${key}`, [label, `var(--${key})`] as const,
  ])) as Record<`${Prefix}-${keyof typeof syntaxColors}`, readonly [string, string]>;
}

export const surfaceColors = {
  viewer: {
    "viewer-text-bg": ["Viewer text background", "var(--viewer-bg)"],
    "viewer-ink": ["Viewer text", "var(--text-ink)"],
    "viewer-selection": ["Viewer selection", "Highlight"],
    ...surfaceSyntax("viewer"),
  },
  editor: {
    "editor-bg": ["Editor background", "var(--text-bg)"],
    "editor-ink": ["Editor text", "var(--text-ink)"],
    "editor-selection": ["Editor selection", "Highlight"],
    "editor-caret": ["Editor caret", "var(--text-ink)"],
    "editor-gutter": ["Editor line-number gutter", "var(--raised)"],
    "editor-active-line": ["Editor active line", "transparent"],
    ...surfaceSyntax("editor"),
  },
  hex: {
    "hex-bg": ["Hex Viewer background", "var(--viewer-bg)"],
    "hex-ink": ["Hex Viewer text", "var(--text-ink)"],
  },
  markdown: {
    "markdown-bg": ["Markdown background", "var(--viewer-bg)"],
    "markdown-ink": ["Markdown body text", "var(--text-ink)"],
    "markdown-link": ["Markdown links", "var(--accent)"],
    "markdown-search": ["Markdown search highlights", "var(--accent-fill)"],
  },
  terminal: {
    "terminal-bg": ["Terminal background", "var(--text-bg)"],
    "terminal-ink": ["Terminal text", "var(--text-ink)"],
    "terminal-cursor": ["Terminal cursor", "var(--accent)"],
    "terminal-selection": ["Terminal selection", "var(--panel-selection)"],
  },
  command: {
    "command-bg": ["Command line input background", "var(--canvas)"],
    "command-ink": ["Command line text", "var(--ink)"],
    "command-caret": ["Command line caret", "var(--ink)"],
    "command-selection": ["Command line selection", "Highlight"],
  },
  compare: {
    "compare-bg": ["Compare files background", "var(--text-bg)"],
    "compare-ink": ["Compare files text", "var(--text-ink)"],
    "compare-selection": ["Compare files selection", "Highlight"],
    "compare-added": ["Compare files added lines", "var(--added)"],
    "compare-removed": ["Compare files removed lines", "var(--removed)"],
  },
} as const satisfies Record<string, ColorFields>;

export type Surface = keyof typeof surfaceColors;
type SurfaceColor = { [Group in Surface]: keyof (typeof surfaceColors)[Group] }[Surface];
const surfaceColorFields = Object.assign({}, ...Object.values(surfaceColors)) as Record<SurfaceColor, readonly [string, string]>;
export const colorLabels = Object.assign({}, ...Object.values(colorGroups).map(({ colors }) => colors),
  viewerColors, mermaidColors, Object.fromEntries(Object.entries(surfaceColorFields).map(([key, [label]]) => [key, label]))) as Record<Color, string>;
const colors = Object.keys(colorLabels) as Color[];

export function colorKeysForSurface(surface: Surface): SurfaceColor[] {
  return Object.keys(surfaceColors[surface]) as SurfaceColor[];
}

export const bundledFontFamily = "GoMono Nerd Font Mono";

export const fontGroups = {
  ui: { label: "Main window", fallback: "var(--system-font)" },
  panel: { label: "File panels", fallback: "var(--bundled-font), monospace" },
  dialog: { label: "Dialogs", fallback: "var(--ui-font)" },
  mono: { label: "Editor, viewer, and terminal", fallback: "var(--bundled-font), monospace" },
  viewer: { label: "Viewer", fallback: "var(--mono)" },
  editor: { label: "Editor", fallback: "var(--mono)" },
  terminal: { label: "Terminal", fallback: "var(--mono)" },
  hex: { label: "Hex Viewer", fallback: "var(--viewer-font)" },
  markdown: { label: "Markdown preview", fallback: "var(--markdown-inherited-font)" },
  command: { label: "Command line", fallback: "var(--terminal-font)" },
  compare: { label: "Compare files", fallback: "var(--mono)" },
} as const;

export type FontGroup = keyof typeof fontGroups;
export type Font = { family?: string; size?: number };
export type Palette = Partial<Record<Color, string>>;
export type Fonts = Partial<Record<FontGroup, Font>>;

export interface Scheme {
  // Draft-only name suggested for a scheme created while editing appearance.
  suggestedName?: string;
  id: string;
  name: string;
  base: BaseTheme;
  colors: Palette;
  fonts: Fonts;
}

export const fontKeys = Object.keys(fontGroups) as FontGroup[];
const fontProperty = (group: FontGroup) => group === "mono" ? "--mono" : `--${group}-font` as const;
const typographyProperties = [
  ...fontKeys.flatMap((group) => [fontProperty(group), `--${group}-size`] as const),
  "--markdown-inherited-font", "--markdown-code-font", "--compare-editor-font", "--compare-editor-size",
] as const;
export type RetainedFonts = Record<typeof typographyProperties[number], string>;

export function readRetainedFonts(value: unknown): RetainedFonts | undefined {
  if (!value || typeof value !== "object") return;
  const fonts = value as Record<string, unknown>;
  if (!typographyProperties.every((property) => {
    const setting = fonts[property];
    return typeof setting === "string" && setting.length <= 512 &&
      CSS.supports(property.endsWith("-size") ? "font-size" : "font-family", setting);
  })) return;
  return Object.fromEntries(typographyProperties.map((property) => [property, fonts[property]])) as RetainedFonts;
}

export const minFontSize = 10;
export const maxFontSize = 24;
export const maxFontFamilyLength = 80;
export const maxSchemeNameLength = 48;
export const isHexColor = (value: string) => /^#[a-f\d]{6}$/i.test(value);

const fontParents: Partial<Record<FontGroup, FontGroup>> = {
  dialog: "ui", viewer: "mono", editor: "mono", terminal: "mono",
  hex: "viewer", markdown: "viewer", command: "terminal", compare: "mono",
};

export function effectiveFontSize(fonts: Fonts | undefined, group: FontGroup): number {
  return fonts?.[group]?.size ?? inheritedFontSize(fonts, group);
}

function inheritedFontSize(fonts: Fonts | undefined, group: FontGroup): number {
  const parent = fontParents[group];
  return parent ? effectiveFontSize(fonts, parent) : group === "ui" ? 14 : group === "panel" ? 15 : 18;
}

export function inheritedFont(scheme: Scheme | null, group: FontGroup, families?: readonly string[]): Required<Font> {
  function family(key: FontGroup): string {
    if (key === "markdown" && !scheme?.fonts.viewer?.family?.trim() && !scheme?.fonts.mono?.family?.trim()) {
      return savedFamily("ui") ?? "System font";
    }
    const parent = fontParents[key];
    return parent ? savedFamily(parent) ?? family(parent) : key === "ui" ? "System font" : bundledFontFamily;
  }
  function savedFamily(key: FontGroup) {
    const name = scheme?.fonts[key]?.family?.trim();
    return isAvailableFont(name, families) ? name : undefined;
  }
  return { family: family(group), size: inheritedFontSize(scheme?.fonts, group) };
}

export function isAvailableFont(name: string | undefined, families: readonly string[] | undefined): name is string {
  return Boolean(name && (!families || name.toLocaleLowerCase() === bundledFontFamily.toLocaleLowerCase() ||
    families.some((family) => family.toLocaleLowerCase() === name.toLocaleLowerCase())));
}

const systemColorQuery = "(prefers-color-scheme: dark)";

export function systemTheme(): "light" | "dark" {
  return matchMedia(systemColorQuery).matches ? "dark" : "light";
}

export function useSystemTheme() {
  const [theme, setTheme] = useState(systemTheme);
  useEffect(() => {
    const query = matchMedia(systemColorQuery);
    const changed = () => setTheme(query.matches ? "dark" : "light");
    changed();
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  return theme;
}

export function schemeFits(base: BaseTheme, mode: "light" | "dark") {
  return isLightTheme(base) === (mode === "light");
}

export function readSystemScheme(value: unknown, schemes: Scheme[], fallback: "light" | "dark"): string {
  if (isBaseTheme(value) && schemeFits(value, fallback)) return value;
  if (typeof value === "string" && schemes.some(({ id, base }) => value === `custom:${id}` && schemeFits(base, fallback))) return value;
  return fallback;
}

export function selectAppearance(preferences: Preferences, value: string): Preferences {
  const custom = preferences.schemes.find(({ id }) => value === `custom:${id}`);
  return { ...preferences, activeScheme: custom?.id ?? null, theme: custom ? preferences.theme : readTheme(value) };
}

export function resolveAppearance(preferences: Preferences, system: "light" | "dark"): { theme: BaseTheme; scheme: Scheme | null } {
  const explicit = preferences.schemes.find(({ id }) => id === preferences.activeScheme);
  if (explicit) return { theme: explicit.base, scheme: explicit };
  if (preferences.theme !== "system") return { theme: preferences.theme, scheme: null };
  const favorite = system === "dark" ? preferences.systemDarkScheme : preferences.systemLightScheme;
  const scheme = preferences.schemes.find(({ id }) => favorite === `custom:${id}`) ?? null;
  return { theme: scheme?.base ?? (isBaseTheme(favorite) ? favorite : system), scheme };
}

export function readSchemes(value: unknown): Scheme[] {
  if (!Array.isArray(value)) return [];
  const result: Scheme[] = [];
  for (const scheme of value as Partial<Scheme>[]) {
    if (!scheme || typeof scheme.id !== "string" || typeof scheme.name !== "string" ||
        result.some(({ id }) => id === scheme.id) ||
        !isBaseTheme(scheme.base)) continue;
    const palette: Palette = {};
    for (const color of colors) {
      const value = scheme.colors?.[color];
      if (typeof value === "string" && isHexColor(value)) palette[color] = value;
    }
    const fonts: Fonts = {};
    for (const group of fontKeys) {
      const font = scheme.fonts?.[group];
      const family = typeof font?.family === "string" ? font.family.trim().slice(0, maxFontFamilyLength) : undefined;
      const size = font?.size;
      fonts[group] = {
        family: family || undefined,
        size: typeof size === "number" && Number.isInteger(size) && size >= minFontSize && size <= maxFontSize ? size : undefined,
      };
    }
    result.push({ id: scheme.id, name: scheme.name.slice(0, maxSchemeNameLength), base: scheme.base, colors: palette, fonts });
  }
  return result;
}

export function applyAppearance(theme: BaseTheme, scheme: Scheme | null, root = document.documentElement, retainedFonts?: RetainedFonts) {
  const base = scheme?.base ?? theme;
  root.dataset.theme = base;
  if (modernThemes.has(base)) root.dataset.look = "modern";
  else delete root.dataset.look;
  applyColors(root, scheme?.colors);
  const windowBackground = scheme?.colors.canvas;
  if (windowBackground) root.style.setProperty("--backdrop", windowBackground);
  else root.style.removeProperty("--backdrop");
  for (const group of fontKeys) {
    const font = scheme?.fonts[group];
    const family = fontProperty(group);
    const name = font?.family?.trim();
    if (name) root.style.setProperty(family, `${CSS.escape(name)}, ${fontGroups[group].fallback}`);
    else root.style.removeProperty(family);
    if (font?.size) root.style.setProperty(`--${group}-size`, `${font.size}px`);
    else root.style.removeProperty(`--${group}-size`);
  }
  root.style.setProperty("--markdown-inherited-font",
    scheme?.fonts.viewer?.family?.trim() || scheme?.fonts.mono?.family?.trim() ? "var(--viewer-font)" : "var(--ui-font)");
  const compareFamily = scheme?.fonts.compare?.family?.trim();
  if (compareFamily) root.style.setProperty("--compare-editor-font", `${CSS.escape(compareFamily)}, var(--editor-font)`);
  else root.style.removeProperty("--compare-editor-font");
  if (scheme?.fonts.compare?.size) root.style.setProperty("--compare-editor-size", `${scheme.fonts.compare.size}px`);
  else root.style.removeProperty("--compare-editor-size");
  const markdownFamily = scheme?.fonts.markdown?.family?.trim();
  if (markdownFamily) root.style.setProperty("--markdown-code-font", `${CSS.escape(markdownFamily)}, var(--viewer-font)`);
  else root.style.removeProperty("--markdown-code-font");
  if (retainedFonts) {
    for (const property of typographyProperties) root.style.setProperty(property, retainedFonts[property]);
  }
}

export function captureFonts(theme: BaseTheme, scheme: Scheme | null): RetainedFonts {
  const sample = document.createElement("div");
  sample.hidden = true;
  document.body.append(sample);
  try {
    applyAppearance(theme, scheme, sample);
    const style = getComputedStyle(sample);
    return Object.fromEntries(typographyProperties.map((property) =>
      [property, style.getPropertyValue(property).trim()])) as RetainedFonts;
  } finally {
    sample.remove();
  }
}

function applyColors(root: HTMLElement, palette?: Palette) {
  for (const color of colors) {
    const value = palette?.[color] ?? surfaceColorFields[color as SurfaceColor]?.[1];
    if (value) root.style.setProperty(`--${color}`, value);
    else root.style.removeProperty(`--${color}`);
  }
  for (const color of ["viewer-selection", "editor-selection", "compare-selection", "command-selection", "markdown-search"] as const) {
    const value = palette?.[color];
    const fallback = color === "markdown-search" ? "var(--on-accent)" : "HighlightText";
    root.style.setProperty(`--${color}-ink`, value ? contrastingText(value) : fallback);
  }
}

function contrastingText(hex: string) {
  const [red, green, blue] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue > 0.179 ? "#000000" : "#ffffff";
}

export function basePalette(base: BaseTheme, overrides?: Palette): Palette {
  // Resolve the built-in values from the stylesheet, including any token aliases.
  const sample = document.createElement("div");
  sample.hidden = true;
  sample.dataset.theme = base;
  applyColors(sample, overrides);
  document.body.append(sample);
  const style = getComputedStyle(sample);
  const result: Palette = {};
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const pixel = canvas.getContext("2d", { willReadFrequently: true });
  for (const color of colors) {
    const value = style.getPropertyValue(`--${color}`).trim();
    if (isHexColor(value)) {
      result[color] = value;
    } else if (value && value !== "transparent" && pixel) {
      sample.style.color = "var(--" + color + ")";
      pixel.clearRect(0, 0, 1, 1);
      pixel.fillStyle = getComputedStyle(sample).color;
      pixel.fillRect(0, 0, 1, 1);
      const [red, green, blue] = pixel.getImageData(0, 0, 1, 1).data;
      result[color] = "#" + [red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("");
    }
  }
  sample.remove();
  return result;
}
