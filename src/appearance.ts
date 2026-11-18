export const builtInThemes = {
  system: "System",
  dark: "Dark",
  light: "Light",
  slate: "Slate",
} as const;

export type Theme = keyof typeof builtInThemes;
type BaseTheme = Exclude<Theme, "system">;

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
    },
  },
  text: {
    label: "Text tools",
    colors: {
      "text-bg": "Editor, viewer, and terminal background",
      "text-ink": "Editor, viewer, and terminal text",
      added: "Added lines",
      removed: "Removed lines",
    },
  },
} as const;

export type Color = {
  [Group in keyof typeof colorGroups]: keyof (typeof colorGroups)[Group]["colors"];
}[keyof typeof colorGroups];
const colors = Object.values(colorGroups).flatMap(({ colors }) => Object.keys(colors)) as Color[];

export const fontGroups = {
  ui: { label: "Main window", fallback: "system-ui" },
  panel: { label: "File panels", fallback: "system-ui" },
  dialog: { label: "Dialogs", fallback: "system-ui" },
  mono: { label: "Editor, viewer, and terminal", fallback: "monospace" },
} as const;

export type FontGroup = keyof typeof fontGroups;
export type Font = { family?: string; size?: number };
export type Palette = Partial<Record<Color, string>>;
export type Fonts = Partial<Record<FontGroup, Font>>;

export interface Scheme {
  id: string;
  name: string;
  base: BaseTheme;
  colors: Palette;
  fonts: Fonts;
}

export const fontKeys = Object.keys(fontGroups) as FontGroup[];
export const minFontSize = 10;
export const maxFontSize = 24;
export const maxFontFamilyLength = 80;
export const maxSchemeNameLength = 48;
export const isHexColor = (value: string) => /^#[a-f\d]{6}$/i.test(value);

export function systemTheme(): BaseTheme {
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function readSchemes(value: unknown): Scheme[] {
  if (!Array.isArray(value)) return [];
  const result: Scheme[] = [];
  for (const scheme of value as Partial<Scheme>[]) {
    if (!scheme || typeof scheme.id !== "string" || typeof scheme.name !== "string" ||
        result.some(({ id }) => id === scheme.id) ||
        (scheme.base !== "dark" && scheme.base !== "light" && scheme.base !== "slate")) continue;
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

export function applyAppearance(theme: Theme, scheme: Scheme | null) {
  const root = document.documentElement;
  root.dataset.theme = scheme?.base ?? (theme === "system" ? systemTheme() : theme);
  for (const color of colors) {
    const value = scheme?.colors[color];
    if (value) root.style.setProperty(`--${color}`, value);
    else root.style.removeProperty(`--${color}`);
  }
  for (const group of fontKeys) {
    const font = scheme?.fonts[group];
    const family = group === "mono" ? "--mono" : `--${group}-font`;
    const name = font?.family?.trim();
    if (name) root.style.setProperty(family, `${CSS.escape(name)}, ${fontGroups[group].fallback}`);
    else root.style.removeProperty(family);
    if (font?.size) root.style.setProperty(`--${group}-size`, `${font.size}px`);
    else root.style.removeProperty(`--${group}-size`);
  }
}

export function basePalette(base: BaseTheme, overrides?: Palette): Palette {
  // Resolve the built-in values from the stylesheet, including any token aliases.
  const sample = document.createElement("div");
  sample.hidden = true;
  sample.dataset.theme = base;
  for (const color of colors) {
    const value = overrides?.[color];
    if (value) sample.style.setProperty(`--${color}`, value);
  }
  document.body.append(sample);
  const style = getComputedStyle(sample);
  const result: Palette = {};
  for (const color of colors) {
    const value = style.getPropertyValue(`--${color}`).trim();
    if (isHexColor(value)) result[color] = value;
  }
  sample.remove();
  return result;
}
