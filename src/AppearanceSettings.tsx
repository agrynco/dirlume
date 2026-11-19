import { t } from "./i18n";
import { Button } from "./Button";
import { useEffect, useLayoutEffect, useState, type CSSProperties } from "react";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import {
  basePalette, baseThemes, builtInThemes, colorGroups, fontGroups, isHexColor,
  maxFontSize, maxSchemeNameLength, minFontSize, systemTheme,
  type Color, type Font, type FontGroup, type Palette, type Scheme, type Theme,
} from "./appearance";
import type { Preferences } from "./preferences";
import { api, describeError } from "./api";
import { ColorPicker } from "./ColorPicker";
import { FontFamilyField, type InstalledFonts } from "./FontFamilyField";
import { maxViewFontSize, minViewFontSize, viewFontKeys, viewFonts, type ViewFont } from "./viewFonts";

export type AppearanceSection = keyof typeof colorGroups | "fonts";
const sharedFonts = ["ui", "panel", "dialog", "mono"] as const;

export function ViewFontSettings({ preferences, onChange, views = viewFontKeys }: {
  preferences: Preferences;
  onChange: (value: Preferences) => void;
  views?: readonly ViewFont[];
}) {
  return <div className="font-settings">
    <p className="appearance-hint">{t("Font sizes are in pixels. Clear a size to use the scheme default.")}</p>
    {views.map((view) => (
      <label className="view-font-setting" key={view}>
        <span>{t(viewFonts[view].label)}</span>
        <FontSizeInput label={t(viewFonts[view].label)} size={preferences.viewFontSizes[view]}
          min={minViewFontSize} max={maxViewFontSize}
          onChange={(size) => onChange({ ...preferences, viewFontSizes: { ...preferences.viewFontSizes, [view]: size } })} />
      </label>
    ))}
  </div>;
}

export function AppearanceSettings({ section, preferences, onChange, fontGroup, views }: {
  section: AppearanceSection;
  preferences: Preferences;
  onChange: (value: Preferences) => void;
  fontGroup?: FontGroup;
  views?: readonly ViewFont[];
}) {
  const [deleting, setDeleting] = useState(false);
  const [system, setSystem] = useState(systemTheme);
  const [palette, setPalette] = useState<Palette>({});
  const [picker, setPicker] = useState<{ color: Color; label: string; initial: string; previous: Preferences } | null>(null);
  const [installed, setInstalled] = useState<InstalledFonts>(null);
  const active = preferences.schemes.find(({ id }) => id === preferences.activeScheme);
  const base = active?.base ?? (preferences.theme === "system" ? system : preferences.theme);
  const overrides = active?.colors;
  const groups = fontGroup ? [fontGroup] : section === "fonts" ? sharedFonts : [];
  const showingFonts = groups.length > 0;
  const colorSections = section === "fonts" ? [] : section === "panels" && fontGroup === "panel" ? ["panels", "files"] as const : [section];

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setSystem(systemTheme());
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);

  useLayoutEffect(() => setPalette(basePalette(base, overrides)), [base, overrides]);

  useEffect(() => {
    if (!showingFonts) return;
    let current = true;
    void api.installedFonts().then(
      (families) => { if (current) setInstalled({ families }); },
      (error: unknown) => { if (current) setInstalled({ families: [], error: describeError(error) }); },
    );
    return () => { current = false; };
  }, [showingFonts]);

  function select(value: string) {
    const custom = preferences.schemes.find(({ id }) => value === `custom:${id}`);
    setDeleting(false);
    onChange({ ...preferences, activeScheme: custom?.id ?? null, theme: custom ? preferences.theme : value as Theme });
  }

  function create(fonts = active?.fonts ?? {}, colors = active?.colors ?? {}, viewFontSizes = preferences.viewFontSizes) {
    let number = 1;
    while (preferences.schemes.some(({ id }) => id === `scheme-${number}`)) number++;
    const scheme: Scheme = {
      id: `scheme-${number}`, name: number === 1 ? t("Custom scheme") : t("Custom scheme {0}", number),
      base, colors, fonts,
    };
    setDeleting(false);
    onChange({ ...preferences, viewFontSizes, activeScheme: scheme.id, schemes: [...preferences.schemes, scheme] });
  }

  function update(scheme: Scheme, viewFontSizes = preferences.viewFontSizes) {
    onChange({ ...preferences, viewFontSizes, schemes: preferences.schemes.map((item) => item.id === scheme.id ? scheme : item) });
  }

  function setFont(group: FontGroup, font?: Font) {
    const fonts = { ...active?.fonts, [group]: font };
    const viewFontSizes = { ...preferences.viewFontSizes };
    if (font?.size !== active?.fonts[group]?.size) {
      for (const view of viewFontKeys) {
        const viewGroup = viewFonts[view].group;
        const inheritsMono = viewGroup !== "panel" && active?.fonts[viewGroup]?.size === undefined;
        if (viewGroup === group || (group === "mono" && inheritsMono)) delete viewFontSizes[view];
      }
    }
    if (active) update({ ...active, fonts }, viewFontSizes);
    else create(fonts, {}, viewFontSizes);
  }

  function setColor(color: Color, value?: string) {
    if (active) update({ ...active, colors: { ...active.colors, [color]: value } });
    else if (value) create({}, { [color]: value });
  }

  function remove(scheme: Scheme) {
    onChange({
      ...preferences, theme: scheme.base, activeScheme: null,
      schemes: preferences.schemes.filter(({ id }) => id !== scheme.id),
    });
    setDeleting(false);
  }

  return (
    <div className="dialog-body appearance-settings">
      <div className="appearance-header">
        <label className="field">{t("Color scheme")}
          <select aria-label={t("Color scheme")} value={active ? `custom:${active.id}` : preferences.theme} onChange={(event) => select(event.target.value)}>
            <optgroup label={t("Built in")}>
              {Object.entries(builtInThemes).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
            </optgroup>
            {preferences.schemes.length > 0 && <optgroup label={t("Custom")}>
              {preferences.schemes.map(({ id, name }) => <option key={id} value={`custom:${id}`}>{name.trim() || t("Custom scheme")}</option>)}
            </optgroup>}
          </select>
        </label>
        <Button type="button" className="appearance-button" onClick={() => create()}><Plus /> {t("New scheme")}</Button>
      </div>
      {active ? (
        <div className="appearance-header scheme-identity">
          <label className="field">{t("Scheme name")}
            <input type="text" value={active.name} maxLength={maxSchemeNameLength}
              onChange={(event) => update({ ...active, name: event.target.value })} />
          </label>
          <label className="field">{t("Base theme")}
            <select aria-label={t("Base theme")} value={active.base} onChange={(event) => update({ ...active, base: event.target.value as Scheme["base"] })}>
              {baseThemes.map((item) => <option key={item} value={item}>{t(builtInThemes[item])}</option>)}
            </select>
          </label>
          <Button type="button" className="icon-button appearance-button" aria-label={t("Delete scheme")}
            title={t("Delete scheme")} onClick={() => setDeleting(!deleting)}><Trash2 /></Button>
        </div>
      ) : <p className="appearance-hint">{showingFonts ? t("Changing a font creates a custom scheme.") :
        t("Editing a color creates a custom scheme.")}</p>}
      {active && deleting && <div className="scheme-confirm">
        <span>{t("Delete this color scheme?")}</span>
        <Button type="button" onClick={() => setDeleting(false)}>{t("Keep scheme")}</Button>
        <Button type="button" className="negative" onClick={() => remove(active)}>{t("Delete scheme")}</Button>
      </div>}
      {showingFonts && (
        <div className="font-settings">
          {groups.map((group) => <FontFields key={group} group={group}
            font={active?.fonts[group]} installed={installed} disabled={!active}
            onChange={(font) => setFont(group, font)} />)}
        </div>
      )}
      {views && views.length > 0 && <ViewFontSettings views={views} preferences={preferences} onChange={onChange} />}
      {colorSections.map((colorSection) => (
        <div className="color-settings" key={colorSection}>
          {colorSections.length > 1 && <h4>{t(colorGroups[colorSection].label)}</h4>}
          {Object.entries(colorGroups[colorSection].colors).map(([key, label]) => {
            const color = key as Color;
            const value = palette[color] ?? "#000000";
            return <ColorField key={key} label={label} value={value}
              custom={Boolean(active?.colors[color])} onChange={(value) => setColor(color, value)}
              onOpen={() => setPicker({ color, label, initial: value, previous: preferences })} />;
          })}
        </div>
      ))}
      {picker && <ColorPicker label={picker.label} initial={picker.initial}
        onChange={(value) => setColor(picker.color, value)} onCommit={() => setPicker(null)}
        onCancel={() => { onChange(picker.previous); setPicker(null); }} />}
    </div>
  );
}
function ColorField({ label, value, custom, onChange, onOpen }: {
  label: string;
  value: string;
  custom: boolean;
  onChange: (value?: string) => void;
  onOpen: () => void;
}) {
  const [hex, setHex] = useState(value);
  useEffect(() => setHex(value), [value]);

  return (
    <div className="color-setting">
      <span>{t(label)}</span>
      <Button type="button" className="color-swatch" aria-label={t("{0} color", t(label))} aria-haspopup="dialog"
        style={{ "--swatch": value } as CSSProperties} onClick={onOpen} />
      <input type="text" aria-label={t("{0} hex", t(label))} value={hex} maxLength={7} spellCheck={false}
        onBlur={() => setHex(value)} onChange={(event) => {
          const change = event.target.value;
          setHex(change);
          if (isHexColor(change)) onChange(change.toLowerCase());
        }} />
      <Button type="button" className="icon-button" aria-label={t("Reset {0}", t(label).toLocaleLowerCase())}
        title={t("Reset color")} disabled={!custom} onClick={() => onChange()}><RotateCcw /></Button>
    </div>
  );
}

function FontFields({ group, font, installed, disabled, onChange }: {
  group: FontGroup;
  font: Font | undefined;
  installed: InstalledFonts;
  disabled: boolean;
  onChange: (value?: Font) => void;
}) {
  const label = fontGroups[group].label;

  return (
    <fieldset className="font-setting">
      <legend>{t(label)}</legend>
      <FontFamilyField label={label} value={font?.family ?? ""} installed={installed} builtIn={disabled}
        onChange={(family) => onChange({ ...font, family: family || undefined })} />
      <label className="field">{t("Size (px)")}
        <FontSizeInput label={label} size={font?.size} min={minFontSize} max={maxFontSize}
          onChange={(size) => onChange({ ...font, size })} />
      </label>
      <Button type="button" className="icon-button" aria-label={t("Reset {0} font", t(label).toLocaleLowerCase())}
        title={t("Reset font")} disabled={disabled || (!font?.family && !font?.size)}
        onClick={() => onChange()}><RotateCcw /></Button>
    </fieldset>
  );
}

function FontSizeInput({ label, size, min, max, disabled, onChange }: {
  label: string;
  size?: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (size?: number) => void;
}) {
  const [text, setText] = useState(String(size ?? ""));
  useEffect(() => setText(String(size ?? "")), [size]);

  return <input aria-label={t("{0} font size", t(label))} type="number" min={min} max={max}
    value={text} placeholder={t("Default")} disabled={disabled} onBlur={() => setText(String(size ?? ""))}
    onChange={(event) => {
      const { value, valueAsNumber, validity } = event.target;
      setText(value);
      if (validity.badInput) return;
      if (!value) onChange();
      else if (Number.isInteger(valueAsNumber) && valueAsNumber >= min && valueAsNumber <= max) onChange(valueAsNumber);
    }} />;
}
