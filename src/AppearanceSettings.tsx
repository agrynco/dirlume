import { useEffect, useLayoutEffect, useState } from "react";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import {
  basePalette, builtInThemes, colorGroups, fontGroups, fontKeys, isHexColor,
  maxFontFamilyLength, maxFontSize, maxSchemeNameLength, minFontSize, systemTheme,
  type Color, type Font, type FontGroup, type Palette, type Scheme, type Theme,
} from "./appearance";
import type { Preferences } from "./preferences";

type Section = keyof typeof colorGroups | "fonts";
const colorSections = Object.keys(colorGroups) as (keyof typeof colorGroups)[];
const baseThemes = ["dark", "light", "slate"] as const;
const fontSuggestions = [
  "Arial", "Cascadia Mono", "Consolas", "DejaVu Sans", "DejaVu Sans Mono", "Inter",
  "JetBrains Mono", "Menlo", "Segoe UI", "SF Mono", "Ubuntu", "Verdana",
];

export function AppearanceSettings({ preferences, onChange }: {
  preferences: Preferences;
  onChange: (value: Preferences) => void;
}) {
  const [section, setSection] = useState<Section>("panels");
  const [deleting, setDeleting] = useState(false);
  const [system, setSystem] = useState(systemTheme);
  const [palette, setPalette] = useState<Palette>({});
  const active = preferences.schemes.find(({ id }) => id === preferences.activeScheme);
  const base = active?.base ?? (preferences.theme === "system" ? system : preferences.theme);
  const overrides = active?.colors;

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setSystem(systemTheme());
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);

  useLayoutEffect(() => setPalette(basePalette(base, overrides)), [base, overrides]);

  function select(value: string) {
    const custom = preferences.schemes.find(({ id }) => value === `custom:${id}`);
    setDeleting(false);
    onChange({ ...preferences, activeScheme: custom?.id ?? null, theme: custom ? preferences.theme : value as Theme });
  }

  function create() {
    let number = 1;
    while (preferences.schemes.some(({ id }) => id === `scheme-${number}`)) number++;
    const scheme: Scheme = {
      id: `scheme-${number}`, name: number === 1 ? "Custom scheme" : `Custom scheme ${number}`,
      base, colors: active?.colors ?? {}, fonts: active?.fonts ?? {},
    };
    setDeleting(false);
    onChange({ ...preferences, activeScheme: scheme.id, schemes: [...preferences.schemes, scheme] });
  }

  function update(scheme: Scheme) {
    onChange({ ...preferences, schemes: preferences.schemes.map((item) => item.id === scheme.id ? scheme : item) });
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
        <label className="field">Color scheme
          <select value={active ? `custom:${active.id}` : preferences.theme} onChange={(event) => select(event.target.value)}>
            <optgroup label="Built in">
              {Object.entries(builtInThemes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </optgroup>
            {preferences.schemes.length > 0 && <optgroup label="Custom">
              {preferences.schemes.map(({ id, name }) => <option key={id} value={`custom:${id}`}>{name.trim() || "Custom scheme"}</option>)}
            </optgroup>}
          </select>
        </label>
        <button type="button" className="appearance-button" onClick={create}><Plus /> New scheme</button>
      </div>
      {active ? (
        <div className="appearance-header scheme-identity">
          <label className="field">Scheme name
            <input type="text" value={active.name} maxLength={maxSchemeNameLength}
              onChange={(event) => update({ ...active, name: event.target.value })} />
          </label>
          <label className="field">Base theme
            <select value={active.base} onChange={(event) => update({ ...active, base: event.target.value as Scheme["base"] })}>
              {baseThemes.map((item) => <option key={item} value={item}>{builtInThemes[item]}</option>)}
            </select>
          </label>
          <button type="button" className="icon-button appearance-button" aria-label="Delete scheme"
            title="Delete scheme" onClick={() => setDeleting(!deleting)}><Trash2 /></button>
        </div>
      ) : <p className="appearance-hint">Create a custom scheme to change these colors and fonts.</p>}
      {active && deleting && <div className="scheme-confirm">
        <span>Delete this color scheme?</span>
        <button type="button" onClick={() => setDeleting(false)}>Keep scheme</button>
        <button type="button" className="negative" onClick={() => remove(active)}>Delete scheme</button>
      </div>}
      <nav className="appearance-sections" aria-label="Appearance sections">
        {colorSections.map((key) => (
          <button key={key} type="button" aria-pressed={section === key} onClick={() => setSection(key)}>{colorGroups[key].label}</button>
        ))}
        <button type="button" aria-pressed={section === "fonts"} onClick={() => setSection("fonts")}>Fonts</button>
      </nav>
      {section === "fonts" ? (
        <div className="font-settings">
          <datalist id="appearance-font-families">{fontSuggestions.map((font) => <option key={font} value={font} />)}</datalist>
          {fontKeys.map((group) => <FontFields key={`${active?.id ?? preferences.theme}-${group}`} group={group}
            font={active?.fonts[group]} disabled={!active}
            onChange={(font) => { if (active) update({ ...active, fonts: { ...active.fonts, [group]: font } }); }} />)}
        </div>
      ) : (
        <div className="color-settings">
          {Object.entries(colorGroups[section].colors).map(([key, label]) => {
            const color = key as Color;
            return <ColorField key={key} label={label} value={palette[color] ?? "#000000"}
              disabled={!active} custom={Boolean(active?.colors[color])}
              onChange={(value) => {
                if (active) update({ ...active, colors: { ...active.colors, [color]: value } });
              }} />;
          })}
        </div>
      )}
    </div>
  );
}

function ColorField({ label, value, disabled, custom, onChange }: {
  label: string;
  value: string;
  disabled: boolean;
  custom: boolean;
  onChange: (value?: string) => void;
}) {
  const [hex, setHex] = useState(value);
  useEffect(() => setHex(value), [value]);

  return (
    <div className="color-setting">
      <span>{label}</span>
      <input type="color" aria-label={`${label} color`} value={value} disabled={disabled}
        onChange={(event) => onChange(event.target.value)} />
      <input type="text" aria-label={`${label} hex`} value={hex} disabled={disabled} maxLength={7} spellCheck={false}
        onBlur={() => setHex(value)} onChange={(event) => {
          const change = event.target.value;
          setHex(change);
          if (isHexColor(change)) onChange(change.toLowerCase());
        }} />
      <button type="button" className="icon-button" aria-label={`Reset ${label.toLowerCase()}`}
        title="Reset color" disabled={!custom} onClick={() => onChange()}><RotateCcw /></button>
    </div>
  );
}

function FontFields({ group, font, disabled, onChange }: {
  group: FontGroup;
  font: Font | undefined;
  disabled: boolean;
  onChange: (value?: Font) => void;
}) {
  const label = fontGroups[group].label;
  const [sizeText, setSizeText] = useState(String(font?.size ?? ""));
  useEffect(() => setSizeText(String(font?.size ?? "")), [font?.size]);

  return (
    <fieldset className="font-setting">
      <legend>{label}</legend>
      <label className="field">Font family
        <input aria-label={`${label} font family`} type="text" placeholder="Default font"
          list="appearance-font-families" value={font?.family ?? ""} disabled={disabled} maxLength={maxFontFamilyLength}
          onChange={(event) => onChange({ ...font, family: event.target.value || undefined })} />
      </label>
      <label className="field">Size (px)
        <input aria-label={`${label} font size`} type="number" min={minFontSize} max={maxFontSize}
          value={sizeText} placeholder="Default" disabled={disabled} onBlur={() => setSizeText(String(font?.size ?? ""))}
          onChange={(event) => {
            const { value, valueAsNumber } = event.target;
            setSizeText(value);
            if (!value) onChange({ ...font, size: undefined });
            else if (Number.isInteger(valueAsNumber) && valueAsNumber >= minFontSize && valueAsNumber <= maxFontSize) {
              onChange({ ...font, size: valueAsNumber });
            }
          }} />
      </label>
      <button type="button" className="icon-button" aria-label={`Reset ${label.toLowerCase()} font`}
        title="Reset font" disabled={disabled || (!font?.family && !font?.size)}
        onClick={() => onChange()}><RotateCcw /></button>
    </fieldset>
  );
}
