import { HistoryField } from "./HistoryField";
import { t } from "./i18n";
import { Button } from "./Button";
import { useEffect, useLayoutEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import {
  basePalette, baseThemes, builtInThemes, colorGroups, colorKeysForSurface, colorLabels, effectiveFontSize, fontGroups, inheritedFont,
  isAvailableFont, isHexColor, surfaceColors,
  maxFontSize, maxSchemeNameLength, mermaidColors, minFontSize, readSystemScheme, resolveAppearance, selectAppearance, useSystemTheme, viewerColors,
  type Color, type Font, type FontGroup, type Palette, type Scheme, type Surface,
} from "./appearance";
import { maxViewerContentWidth, minViewerContentWidth, type Preferences } from "./preferences";
import { api, describeError } from "./api";
import { ColorPicker } from "./ColorPicker";
import { FontFamilyField, type InstalledFonts } from "./FontFamilyField";
import { SchemeOptions } from "./SchemeOptions";
import { maxViewFontSize, minViewFontSize, viewFontKeys, viewFonts, type ViewFont } from "./viewFonts";
import { featureOptions, optionSurfaces } from "./featureOptions";
import { MenuAlignmentSetting } from "./MenuAlignmentSetting";
import { SettingSearchLabel } from "./SettingSearchLabel";
import { pickedSurface, type AppearancePick } from "./appearancePick";

export type AppearanceSection = keyof typeof colorGroups | "fonts";
const sharedFonts = ["ui", "panel", "dialog", "mono"] as const;

export function ViewFontSettings({ preferences, onChange, views }: {
  preferences: Preferences;
  onChange: (value: Preferences) => void;
  views?: readonly ViewFont[];
}) {
  const { scheme } = resolveAppearance(preferences, useSystemTheme());
  function fields(keys: readonly ViewFont[]) {
    return keys.map((view) => {
      const { label, group } = viewFonts[view];
      const fallback = effectiveFontSize(scheme?.fonts, group);
      return <label className="view-font-setting" key={view}>
        <SettingSearchLabel label={label} aliases={["zoom", "wheel", "font size"]} />
        <FontSizeInput label={label} size={preferences.viewFontSizes[view]} fallback={fallback}
          min={minViewFontSize} max={maxViewFontSize}
          onChange={(size) => onChange({ ...preferences, viewFontSizes: { ...preferences.viewFontSizes, [view]: size } })} />
      </label>;
    });
  }
  if (views) return <div className="font-settings feature-font-sizes">
    <p className="appearance-hint">{t("Font sizes are in pixels. Clear a size to use the scheme default.")}</p>
    {fields(views)}
  </div>;
  return <div className="font-settings">
    <p className="appearance-hint">{t("Font sizes are in pixels. Clear a size to use the scheme default.")}</p>
    {Object.values(featureOptions).filter(({ views }) => views.length).map(({ label, views }) => (
      <fieldset className="view-font-group" key={label}>
        <legend>{t(label)}</legend>
        {fields(views)}
      </fieldset>
    ))}
  </div>;
}

export function AppearanceSettings({ section, preferences, onChange, fontGroup, views, selection }: {
  section: AppearanceSection;
  preferences: Preferences;
  onChange: (value: Preferences) => void;
  fontGroup?: FontGroup;
  views?: readonly ViewFont[];
  selection?: AppearancePick;
}) {
  const [deleting, setDeleting] = useState(false);
  const system = useSystemTheme();
  const [palette, setPalette] = useState<Palette>({});
  const [picker, setPicker] = useState<{ color: Color; label: string; initial: string; previous: Preferences; surface?: Surface } | null>(null);
  const [installed, setInstalled] = useState<InstalledFonts>(null);
  const active = preferences.schemes.find(({ id }) => id === preferences.activeScheme);
  const { scheme: applied, theme } = resolveAppearance(preferences, system);
  const base = theme;
  const overrides = applied?.colors;
  const picked = selection && pickedSurface(selection);
  const surfaces: readonly Surface[] = selection ? picked ? [picked] : [] :
    fontGroup === "viewer" || fontGroup === "editor" || fontGroup === "terminal" ? optionSurfaces[fontGroup] :
      section === "text" ? optionSurfaces.text : [];
  const groups = surfaces.length ? [] : selection ? selection.font ? [selection.font] : [] :
    fontGroup ? [fontGroup] : section === "fonts" ? sharedFonts : [];
  const showingFonts = groups.length > 0 || surfaces.length > 0;
  const colorSections = selection || section === "fonts" ? [] : section === "panels" && fontGroup === "panel" ? ["panels", "files"] as const : [section];

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
    setDeleting(false);
    onChange(selectAppearance(preferences, value));
  }

  function create(fonts = applied?.fonts ?? {}, colors = applied?.colors ?? {}, viewFontSizes = preferences.viewFontSizes) {
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
    const schemes = preferences.schemes.map((item) => item.id === scheme.id ? scheme : item);
    onChange({ ...preferences, viewFontSizes, schemes,
      systemLightScheme: readSystemScheme(preferences.systemLightScheme, schemes, "light"),
      systemDarkScheme: readSystemScheme(preferences.systemDarkScheme, schemes, "dark") });
  }

  function setFont(group: FontGroup, font?: Font) {
    const fonts = { ...applied?.fonts, [group]: font };
    const viewFontSizes = { ...preferences.viewFontSizes };
    for (const view of viewFontKeys) {
      const viewGroup = viewFonts[view].group;
      if (effectiveFontSize(applied?.fonts, viewGroup) !== effectiveFontSize(fonts, viewGroup)) delete viewFontSizes[view];
    }
    const scheme = Object.hasOwn(surfaceColors, group) ? applied : active;
    if (scheme) update({ ...scheme, fonts }, viewFontSizes);
    else create(fonts, applied?.colors, viewFontSizes);
  }

  function setColor(color: Color, value?: string, surface?: Surface) {
    const scheme = surface ? applied : active;
    if (scheme) update({ ...scheme, colors: { ...scheme.colors, [color]: value } });
    else if (value) create(applied?.fonts, { ...applied?.colors, [color]: value });
  }

  function remove(scheme: Scheme) {
    const schemes = preferences.schemes.filter(({ id }) => id !== scheme.id);
    onChange({
      ...preferences, theme: scheme.base, activeScheme: null,
      schemes,
      systemLightScheme: readSystemScheme(preferences.systemLightScheme, schemes, "light"),
      systemDarkScheme: readSystemScheme(preferences.systemDarkScheme, schemes, "dark"),
    });
    setDeleting(false);
  }

  function colorFields(keys: readonly Color[], surface?: Surface) {
    return keys.map((color) => {
      const label = colorLabels[color];
      const value = palette[color] ?? (color === "editor-active-line" ? "" : "#000000");
      return <ColorField key={color} label={label} value={value} surface={surface}
        custom={Boolean((surface ? applied : active)?.colors[color])} onChange={(value) => setColor(color, value, surface)}
        onOpen={() => setPicker({ color, label, initial: value || "#000000", previous: preferences, surface })} />;
    });
  }

  return (
    <div className="dialog-body appearance-settings">
      {selection && !picked && <p className="appearance-hint">{t("Color and font settings on this page also affect elements that share them.")}</p>}
      {!selection && section === "window" && <>
        <div className="appearance-header">
          <label className="field"><SettingSearchLabel label="Color scheme" aliases={Object.values(builtInThemes)} />
            <select aria-label={t("Color scheme")} value={active ? `custom:${active.id}` : preferences.theme} onChange={(event) => select(event.target.value)}>
              <SchemeOptions schemes={preferences.schemes} />
            </select>
          </label>
          <Button type="button" className="appearance-button" onClick={() => create()}><Plus /> <SettingSearchLabel label="New scheme" /></Button>
        </div>
        <MenuAlignmentSetting label="Main menu alignment" value={preferences.mainMenuAlignment}
          onChange={(mainMenuAlignment) => onChange({ ...preferences, mainMenuAlignment })} />
        <label className="field-checkbox">
          <SettingSearchLabel label="Show color scheme switcher in the title bar" />
          <input type="checkbox" checked={preferences.showTitlebarScheme}
            onChange={(event) => onChange({ ...preferences, showTitlebarScheme: event.target.checked })} />
        </label>
        <div className="favorite-schemes">
          <label className="field"><SettingSearchLabel label="Favorite light scheme" />
            <select value={preferences.systemLightScheme} onChange={(event) => onChange({ ...preferences, systemLightScheme: event.target.value })}>
              <SchemeOptions schemes={preferences.schemes} mode="light" />
            </select>
          </label>
          <label className="field"><SettingSearchLabel label="Favorite dark scheme" />
            <select value={preferences.systemDarkScheme} onChange={(event) => onChange({ ...preferences, systemDarkScheme: event.target.value })}>
              <SchemeOptions schemes={preferences.schemes} mode="dark" />
            </select>
          </label>
        </div>
        {active && (
          <div className="appearance-header scheme-identity">
            <label className="field"><SettingSearchLabel label="Scheme name" />
              <HistoryField historyKey="appearance-scheme-name" aria-label={t("Scheme name")} type="text" value={active.name}
                maxLength={maxSchemeNameLength} onValueChange={(name) => update({ ...active, name })} />
            </label>
            <label className="field"><SettingSearchLabel label="Base theme" aliases={baseThemes.map((theme) => builtInThemes[theme])} />
              <select aria-label={t("Base theme")} value={active.base} onChange={(event) => update({ ...active, base: event.target.value as Scheme["base"] })}>
                {baseThemes.map((item) => <option key={item} value={item}>{t(builtInThemes[item])}</option>)}
              </select>
            </label>
            <Button type="button" className="icon-button appearance-button" aria-label={t("Delete scheme")}
              tooltip={t("Delete scheme")} onClick={() => setDeleting(!deleting)}><Trash2 /></Button>
          </div>
        )}
        {active && deleting && <div className="scheme-confirm">
          <span>{t("Delete this color scheme?")}</span>
          <Button type="button" onClick={() => setDeleting(false)}>{t("Keep scheme")}</Button>
          <Button type="button" className="negative" onClick={() => remove(active)}>{t("Delete scheme")}</Button>
        </div>}
      </>}
      {!(surfaces.length ? applied : active) && <p className="appearance-hint">{showingFonts ? t("Changing a font creates a custom scheme.") :
        t("Editing a color creates a custom scheme.")}</p>}
      {surfaces.map((surface) => {
        const surfaceViews = (selection ? selection.view ? [selection.view] : [] : views ?? []).filter((view) => viewFonts[view].group === surface);
        return <FontFields key={surface} group={surface} surface
          font={applied?.fonts[surface]} inherited={inheritedFont(applied, surface, installed?.error ? undefined : installed?.families)}
          installed={installed} disabled={!applied} onChange={(font) => setFont(surface, font)}>
          <div className="color-settings">{colorFields(colorKeysForSurface(surface), surface)}</div>
          {surfaceViews.length > 0 && <ViewFontSettings views={surfaceViews} preferences={preferences} onChange={onChange} />}
        </FontFields>;
      })}
      {showingFonts && (
        <div className="font-settings">
          {groups.map((group) => <FontFields key={group} group={group}
            font={applied?.fonts[group]} inherited={inheritedFont(applied, group)} installed={installed} disabled={!active}
            onChange={(font) => setFont(group, font)}>
            {!!(selection?.view || views?.length) && <ViewFontSettings views={selection?.view ? [selection.view] : views}
              preferences={preferences} onChange={onChange} />}
          </FontFields>)}
        </div>
      )}
      {colorSections.map((colorSection) => (
        <div className="color-settings" key={colorSection}>
          {colorSections.length > 1 && <h4>{t(colorGroups[colorSection].label)}</h4>}
          {colorSections.length === 1 && colorSection === "text" && <h4>{t("Shared text colors")}</h4>}
          {colorFields(Object.keys(colorGroups[colorSection].colors) as Color[])}
        </div>
      ))}
      {selection && !picked && <div className="color-settings">
        {colorFields(selection.colors)}
      </div>}
      {!selection && fontGroup === "viewer" && <>
        <fieldset className="view-font-group reading-area-settings">
          <legend><SettingSearchLabel label="Reading area" /></legend>
          <label className="setting unit-setting"><SettingSearchLabel label="Max width (px)" aliases={["Maximum content width (px)", "Full width"]} />
            <OptionalNumberInput label={t("Max width (px)")} size={preferences.viewerContentWidth} fallback={t("Full width")}
              min={minViewerContentWidth} max={maxViewerContentWidth}
              onChange={(viewerContentWidth) => onChange({ ...preferences, viewerContentWidth })} />
          </label>
          {colorFields(Object.keys(viewerColors) as Color[])}
        </fieldset>
        <fieldset className="view-font-group">
          <legend><SettingSearchLabel label="Mermaid diagrams" /></legend>
          {colorFields(Object.keys(mermaidColors) as Color[])}
        </fieldset>
      </>}
      {picker && <ColorPicker label={picker.label} initial={picker.initial}
        onChange={(value) => setColor(picker.color, value, picker.surface)} onCommit={() => setPicker(null)}
        onCancel={() => { onChange(picker.previous); setPicker(null); }} />}
    </div>
  );
}
function ColorField({ label, value, custom, surface, onChange, onOpen }: {
  label: string;
  value: string;
  custom: boolean;
  surface?: Surface;
  onChange: (value?: string) => void;
  onOpen: () => void;
}) {
  const [hex, setHex] = useState(value);
  useEffect(() => setHex(value), [value]);

  return (
    <div className="color-setting">
      <span><SettingSearchLabel label={label} aliases={surface ? [fontGroups[surface].label] : []} />
        {surface && <small className="appearance-value">{t(custom ? "Customized" : "Inherited")}</small>}
      </span>
      <Button type="button" className="color-swatch" aria-label={t("{0} color", t(label))} aria-haspopup="dialog"
        style={{ "--swatch": value || "transparent" } as CSSProperties} onClick={onOpen} />
      <HistoryField historyKey="appearance-hex" type="text" aria-label={t("{0} hex", t(label))} value={hex} maxLength={7} spellCheck={false}
        placeholder={value ? undefined : t("No highlight")}
        onBlur={() => setHex(value)} onValueChange={(change) => {
          setHex(change);
          if (isHexColor(change)) onChange(change.toLowerCase());
        }} />
      <Button type="button" className="icon-button" aria-label={t("Reset {0}", t(label).toLocaleLowerCase())}
        tooltip={t("Reset color")} disabled={!custom} onClick={() => onChange()}><RotateCcw /></Button>
    </div>
  );
}

function FontFields({ group, font, inherited, installed, disabled, surface, onChange, children }: {
  group: FontGroup;
  font: Font | undefined;
  inherited: Required<Font>;
  installed: InstalledFonts;
  disabled: boolean;
  surface?: boolean;
  onChange: (value?: Font) => void;
  children?: ReactNode;
}) {
  const label = fontGroups[group].label;
  const unavailable = installed && !installed.error && Boolean(font?.family?.trim()) &&
    !isAvailableFont(font?.family?.trim(), installed.families);

  return (
    <fieldset className={surface ? "font-setting text-surface-settings" : "font-setting"}>
      <legend><SettingSearchLabel label={label} /></legend>
      <div className={surface ? "surface-font-family" : undefined}>
        <FontFamilyField label={label} value={font?.family ?? ""} fallback={t(inherited.family)} installed={installed} builtIn={disabled}
          onChange={(family) => onChange({ ...font, family: family || undefined })} />
        {surface && <>
          <Button type="button" className="icon-button" aria-label={t("Reset {0} font family", t(label).toLocaleLowerCase())}
            disabled={!font?.family} onClick={() => onChange({ ...font, family: undefined })}><RotateCcw /></Button>
          <small className="appearance-value">
            {unavailable ? t("Unavailable. Using {0}.", t(inherited.family)) : t(font?.family ? "Customized" : "Inherited")}
          </small>
        </>}
      </div>
      <div className="font-size-controls">
          <label className="field font-size-field"><SettingSearchLabel label="Size (px)" aliases={["Font size", label]} />
          <FontSizeInput label={label} size={font?.size} fallback={inherited.size} min={minFontSize} max={maxFontSize}
            onChange={(size) => onChange({ ...font, size })} />
          {surface && <small className="appearance-value">{t(font?.size === undefined ? "Inherited" : "Customized")}</small>}
        </label>
        {surface ? <Button type="button" className="icon-button" aria-label={t("Reset {0} font size", t(label).toLocaleLowerCase())}
          disabled={font?.size === undefined} onClick={() => onChange({ ...font, size: undefined })}><RotateCcw /></Button> :
          <Button type="button" className="icon-button" aria-label={t("Reset {0} font", t(label).toLocaleLowerCase())}
          tooltip={t("Reset font")} disabled={disabled || (!font?.family && !font?.size)}
          onClick={() => onChange()}><RotateCcw /></Button>}
      </div>
      {children}
    </fieldset>
  );
}

function FontSizeInput({ label, size, fallback, min, max, disabled, onChange }: {
  label: string;
  size?: number;
  fallback: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (size?: number) => void;
}) {
  return <OptionalNumberInput label={t("{0} font size", t(label))} size={size} fallback={String(fallback)}
    min={min} max={max} disabled={disabled} onChange={onChange} />;
}

export function OptionalNumberInput({ label, size, fallback, min, max, disabled, onChange }: {
  label: string;
  size?: number;
  fallback: string;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (size?: number) => void;
}) {
  const [text, setText] = useState(String(size ?? ""));
  useEffect(() => setText(String(size ?? "")), [size]);

  return <input aria-label={label} type="number" min={min} max={max}
    value={text} placeholder={fallback} disabled={disabled} onBlur={() => setText(String(size ?? ""))}
    onChange={(event) => {
      const { value, valueAsNumber, validity } = event.target;
      setText(value);
      if (validity.badInput) return;
      if (!value) onChange();
      else if (Number.isInteger(valueAsNumber) && valueAsNumber >= min && valueAsNumber <= max) onChange(valueAsNumber);
    }} />;
}
