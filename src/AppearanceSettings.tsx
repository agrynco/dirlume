import { Button } from "./Button";
import { useEffect, useLayoutEffect, useState, type CSSProperties } from "react";
import { ChevronDown, Plus, RotateCcw, Trash2 } from "lucide-react";
import {
  basePalette, builtInThemes, colorGroups, fontGroups, fontKeys, isHexColor,
  maxFontFamilyLength, maxFontSize, maxSchemeNameLength, minFontSize, systemTheme,
  type Color, type Font, type FontGroup, type Palette, type Scheme, type Theme,
} from "./appearance";
import type { Preferences } from "./preferences";
import { api, describeError } from "./api";
import { Dialog } from "./Dialog";
import { ColorPicker } from "./ColorPicker";
import { maxViewFontSize, minViewFontSize, viewFontKeys, viewFonts } from "./viewFonts";

export type AppearanceSection = keyof typeof colorGroups | "fonts";
const baseThemes = ["dark", "light", "slate"] as const;

export function ViewFontSettings({ preferences, onChange }: {
  preferences: Preferences;
  onChange: (value: Preferences) => void;
}) {
  return <div className="dialog-body appearance-settings">
    <p className="appearance-hint">Font sizes are in pixels. Clear a size to use the scheme default.</p>
    <div className="font-settings">
      {viewFontKeys.map((view) => (
        <label className="view-font-setting" key={view}>
          <span>{viewFonts[view].label}</span>
          <FontSizeInput label={viewFonts[view].label} size={preferences.viewFontSizes[view]}
            min={minViewFontSize} max={maxViewFontSize}
            onChange={(size) => onChange({ ...preferences, viewFontSizes: { ...preferences.viewFontSizes, [view]: size } })} />
        </label>
      ))}
    </div>
  </div>;
}

export function AppearanceSettings({ section, preferences, onChange }: {
  section: AppearanceSection;
  preferences: Preferences;
  onChange: (value: Preferences) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [system, setSystem] = useState(systemTheme);
  const [palette, setPalette] = useState<Palette>({});
  const [picker, setPicker] = useState<{ color: Color; label: string; initial: string; previous: Preferences } | null>(null);
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

  function create(fonts = active?.fonts ?? {}, colors = active?.colors ?? {}) {
    let number = 1;
    while (preferences.schemes.some(({ id }) => id === `scheme-${number}`)) number++;
    const scheme: Scheme = {
      id: `scheme-${number}`, name: number === 1 ? "Custom scheme" : `Custom scheme ${number}`,
      base, colors, fonts,
    };
    setDeleting(false);
    onChange({ ...preferences, activeScheme: scheme.id, schemes: [...preferences.schemes, scheme] });
  }

  function update(scheme: Scheme) {
    onChange({ ...preferences, schemes: preferences.schemes.map((item) => item.id === scheme.id ? scheme : item) });
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
        <Button type="button" className="appearance-button" onClick={() => create()}><Plus /> New scheme</Button>
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
          <Button type="button" className="icon-button appearance-button" aria-label="Delete scheme"
            title="Delete scheme" onClick={() => setDeleting(!deleting)}><Trash2 /></Button>
        </div>
      ) : <p className="appearance-hint">{section === "fonts" ? "Choose an installed font to create a custom scheme." :
        "Editing a color creates a custom scheme."}</p>}
      {active && deleting && <div className="scheme-confirm">
        <span>Delete this color scheme?</span>
        <Button type="button" onClick={() => setDeleting(false)}>Keep scheme</Button>
        <Button type="button" className="negative" onClick={() => remove(active)}>Delete scheme</Button>
      </div>}
      {section === "fonts" ? (
        <div className="font-settings">
          {fontKeys.map((group) => <FontFields key={`${active?.id ?? preferences.theme}-${group}`} group={group}
            font={active?.fonts[group]} disabled={!active}
            onChange={(font) => {
              const fonts = { ...active?.fonts, [group]: font };
              if (active) update({ ...active, fonts });
              else create(fonts);
            }} />)}
        </div>
      ) : (
        <div className="color-settings">
          {Object.entries(colorGroups[section].colors).map(([key, label]) => {
            const color = key as Color;
            const value = palette[color] ?? "#000000";
            return <ColorField key={key} label={label} value={value}
              custom={Boolean(active?.colors[color])} onChange={(value) => setColor(color, value)}
              onOpen={() => setPicker({ color, label, initial: value, previous: preferences })} />;
          })}
        </div>
      )}
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
      <span>{label}</span>
      <Button type="button" className="color-swatch" aria-label={label + " color"} aria-haspopup="dialog"
        style={{ "--swatch": value } as CSSProperties} onClick={onOpen} />
      <input type="text" aria-label={`${label} hex`} value={hex} maxLength={7} spellCheck={false}
        onBlur={() => setHex(value)} onChange={(event) => {
          const change = event.target.value;
          setHex(change);
          if (isHexColor(change)) onChange(change.toLowerCase());
        }} />
      <Button type="button" className="icon-button" aria-label={`Reset ${label.toLowerCase()}`}
        title="Reset color" disabled={!custom} onClick={() => onChange()}><RotateCcw /></Button>
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
  const [choosing, setChoosing] = useState(false);

  return (
    <fieldset className="font-setting">
      <legend>{label}</legend>
      <div className="font-family-field">
        <label className="field">Font family
          <input aria-label={`${label} font family`} type="text" placeholder="Default font"
            value={font?.family ?? ""} disabled={disabled} maxLength={maxFontFamilyLength}
            onChange={(event) => onChange({ ...font, family: event.target.value || undefined })} />
        </label>
        <Button type="button" className="icon-button" aria-label={`Browse installed fonts for ${label.toLowerCase()}`}
          title="Browse installed fonts" onClick={() => setChoosing(true)}><ChevronDown /></Button>
      </div>
      <label className="field">Size (px)
        <FontSizeInput label={label} size={font?.size} min={minFontSize} max={maxFontSize} disabled={disabled}
          onChange={(size) => onChange({ ...font, size })} />
      </label>
      <Button type="button" className="icon-button" aria-label={`Reset ${label.toLowerCase()} font`}
        title="Reset font" disabled={disabled || (!font?.family && !font?.size)}
        onClick={() => onChange()}><RotateCcw /></Button>
      {choosing && <FontPicker current={font?.family ?? ""} onClose={() => setChoosing(false)}
        onChoose={(family) => { onChange({ ...font, family }); setChoosing(false); }} />}
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

  return <input aria-label={`${label} font size`} type="number" min={min} max={max}
    value={text} placeholder="Default" disabled={disabled} onBlur={() => setText(String(size ?? ""))}
    onChange={(event) => {
      const { value, valueAsNumber, validity } = event.target;
      setText(value);
      if (validity.badInput) return;
      if (!value) onChange();
      else if (Number.isInteger(valueAsNumber) && valueAsNumber >= min && valueAsNumber <= max) onChange(valueAsNumber);
    }} />;
}

function FontPicker({ current, onClose, onChoose }: {
  current: string;
  onClose: () => void;
  onChoose: (family: string) => void;
}) {
  const [families, setFamilies] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(current);
  useEffect(() => {
    let canceled = false;
    void api.installedFonts().then(
      (fonts) => { if (!canceled) setFamilies(fonts); },
      (failure: unknown) => { if (!canceled) setError(describeError(failure)); },
    );
    return () => { canceled = true; };
  }, []);
  const search = query.trim().toLocaleLowerCase();
  const matches = families?.filter((family) => family.toLocaleLowerCase().includes(search)) ?? [];
  const choice = matches.includes(selected) ? selected : matches[0] ?? "";

  return (
    <Dialog title="Installed fonts" onClose={onClose}>
      <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); if (choice) onChoose(choice); }}>
        <div className="dialog-body font-picker">
          <label className="field">Search fonts
            <input type="search" data-initial-focus value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          {matches.length > 0 ? (
            <select size={8} aria-label="Font families" value={choice} onChange={(event) => setSelected(event.target.value)}>
              {matches.map((family) => <option key={family} value={family}>{family}</option>)}
            </select>
          ) : error ? (
            <p role="alert" className="dialog-error">{error}</p>
          ) : (
            <p role="status">{families === null ? "Loading system fonts…" :
              families.length === 0 ? "No system fonts available." : "No matching fonts."}</p>
          )}
        </div>
        <footer className="dialog-footer">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" className="primary" disabled={!choice}>Use font</Button>
        </footer>
      </form>
    </Dialog>
  );
}
