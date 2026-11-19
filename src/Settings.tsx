import { Button } from "./Button";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, Delete, RotateCcw, Search } from "lucide-react";
import { Dialog } from "./Dialog";
import { AppearanceSettings, ViewFontSettings, type AppearanceSection } from "./AppearanceSettings";
import { PathField } from "./PathField";
import { SettingsPreview } from "./SettingsPreview";
import { colorGroups, fontGroups } from "./appearance";
import { api, windowsClient } from "./api";
import {
  commandNames, commands, commandScope, defaultBindings, eventShortcut, showShortcut, wheelBindings,
  type Command, type Preferences, type Provider,
} from "./preferences";
import { viewFonts } from "./viewFonts";
import { featureOptions, isFeaturePage, type FeaturePage } from "./featureOptions";
import { languages, readLanguage, t } from "./i18n";

type Page = AppearanceSection | FeaturePage | "viewFonts" | "general" | "shortcuts";
type OptionsLocation = { page: Page; query: string; expanded: boolean; scrollTop: number };
const optionsLocationKey = "dirlume.options-location";
const featurePages = Object.keys(featureOptions) as FeaturePage[];
const appearancePages = [
  ...Object.entries(colorGroups).map(([id, group]) => ({
    id: id as AppearanceSection, label: group.label, terms: Object.values(group.colors),
  })),
  { id: "fonts" as const, label: "Fonts", terms: [...Object.values(fontGroups).map(({ label }) => label), "family size installed"] },
  { id: "viewFonts" as const, label: "View font sizes", terms: [...Object.values(viewFonts).map(({ label }) => label), "zoom wheel"] },
];

function readOptionsLocation(): OptionsLocation {
  const defaults: OptionsLocation = { page: "general", query: "", expanded: true, scrollTop: 0 };
  try {
    const saved = JSON.parse(localStorage.getItem(optionsLocationKey) ?? "null") as Partial<OptionsLocation> | null;
    const page = saved?.page;
    if (!page || (page !== "general" && page !== "shortcuts" && !isFeaturePage(page) &&
        !appearancePages.some(({ id }) => id === page))) return defaults;
    const scrollTop = saved.scrollTop;
    return {
      page,
      query: typeof saved.query === "string" ? saved.query : defaults.query,
      expanded: typeof saved.expanded === "boolean" ? saved.expanded : defaults.expanded,
      scrollTop: typeof scrollTop === "number" && Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : defaults.scrollTop,
    };
  } catch { return defaults; }
}

export function Settings({ preferences: saved, onChange: applyPreferences, onClose }: {
  preferences: Preferences;
  onChange: (value: Preferences) => void;
  onClose: () => void;
}) {
  const [initialLocation] = useState(readOptionsLocation);
  const [page, setPage] = useState(initialLocation.page);
  const [query, setQuery] = useState(initialLocation.query);
  const [expanded, setExpanded] = useState(initialLocation.expanded);
  const pageBody = useRef<HTMLDivElement>(null);
  const [preferences, onChange] = useState(saved);
  const [capture, setCapture] = useState<Command | null>(null);
  const [conflict, setConflict] = useState("");
  const [buildVersion, setBuildVersion] = useState("");
  const hasChanges = JSON.stringify(preferences) !== JSON.stringify(saved);
  const searching = Boolean(query.trim());
  const terms = query.trim().toLocaleLowerCase().split(/\s+/);
  const matches = (...labels: string[]) => {
    const text = [...labels, ...labels.map((label) => t(label))].join(" ").toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  };
  const showGeneral = matches("General", "Language", ...Object.values(languages), "Remote connection", "Dirlume server", "KSwitcher installation folder", "Version");
  const featureMatches = featurePages.filter((feature) => {
    const { label, font, views } = featureOptions[feature];
    const panelTerms = feature === "filePanels" ? ["Show hidden files", ...Object.values(colorGroups.panels.colors)] : [];
    return matches(label, fontGroups[font].label, "Font family", "Size (px)", "font size", ...views.map((view) => viewFonts[view].label), ...panelTerms);
  });
  const appearanceMatches = appearancePages.filter(({ label, terms }) => matches("Appearance", "Color scheme", label, ...terms));
  const allShortcuts = matches("Keyboard shortcuts", "keymap bindings");
  const visibleCommands = allShortcuts ? commandNames : commandNames.filter((command) =>
    matches(commands[command].label, preferences.shortcuts[command], showShortcut(preferences.shortcuts[command])));
  const showShortcuts = allShortcuts || visibleCommands.length > 0;
  const feature = isFeaturePage(page) ? featureOptions[page] : undefined;
  const isAppearance = !feature && page !== "general" && page !== "shortcuts";
  const title = feature?.label ?? (isAppearance ? appearancePages.find(({ id }) => id === page)?.label : page === "general" ? "General" : "Keyboard shortcuts");

  useLayoutEffect(() => {
    if (pageBody.current) pageBody.current.scrollTop = initialLocation.scrollTop;
  }, [initialLocation]);

  useEffect(() => {
    if (page !== "general" || buildVersion) return;
    let current = true;
    void api.buildVersion().then((version) => { if (current) setBuildVersion(version); }).catch(() => {});
    return () => { current = false; };
  }, [page, buildVersion]);

  function select(next: Page) {
    if (next !== page && pageBody.current) pageBody.current.scrollTop = 0;
    setPage(next);
    setCapture(null);
    setConflict("");
  }

  function apply() {
    if (hasChanges) applyPreferences(preferences);
  }

  function close() {
    const location: OptionsLocation = { page, query, expanded, scrollTop: pageBody.current?.scrollTop ?? 0 };
    try { localStorage.setItem(optionsLocationKey, JSON.stringify(location)); } catch { /* Options can still close. */ }
    onClose();
  }

  function assign(event: KeyboardEvent, command: Command) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") return setCapture(null);
    const shortcut = eventShortcut(event);
    if (!shortcut) return;
    const existing = commandNames.find((item) => item !== command && commandScope(item) === commandScope(command) &&
      preferences.shortcuts[item] === shortcut);
    if (existing) {
      setConflict(t("{0} is assigned to {1}.", showShortcut(shortcut), t(commands[existing].label)));
      return;
    }
    onChange({ ...preferences, shortcuts: { ...preferences.shortcuts, [command]: shortcut } });
    setCapture(null);
    setConflict("");
  }

  return (
    <Dialog title={t("Options")} onClose={close} wide resizeKey="options">
      <div className="settings-layout">
        <aside className="settings-sidebar">
          <label className="settings-search"><Search aria-hidden="true" />
            <input type="search" aria-label={t("Search settings")} placeholder={t("Search settings")} value={query}
              data-initial-focus onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !searching) return;
                event.preventDefault();
                if (showGeneral) select("general");
                else if (featureMatches.length) select(featureMatches[0]);
                else if (appearanceMatches.length) select(appearanceMatches[0].id);
                else if (showShortcuts) select("shortcuts");
              }} />
          </label>
          <nav className="settings-tree" aria-label={t("Options sections")}>
            {showGeneral && <Button type="button" aria-pressed={page === "general"} onClick={() => select("general")}>{t("General")}</Button>}
            {featureMatches.map((id) => <Button key={id} type="button" aria-pressed={page === id} onClick={() => select(id)}>
              {t(featureOptions[id].label)}
            </Button>)}
            {appearanceMatches.length > 0 && (
              <>
                <Button type="button" aria-expanded={expanded || searching} aria-controls="options-appearance-pages"
                  onClick={() => {
                    if (!isAppearance) { select("panels"); setExpanded(true); }
                    else setExpanded(!expanded);
                  }}>
                  {expanded || searching ? <ChevronDown /> : <ChevronRight />} {t("Appearance")}
                </Button>
                <div id="options-appearance-pages" className="settings-tree-branch" hidden={!expanded && !searching}>
                  {appearanceMatches.map(({ id, label }) => (
                    <Button key={id} type="button" aria-pressed={page === id} onClick={() => select(id)}>{t(label)}</Button>
                  ))}
                </div>
              </>
            )}
            {showShortcuts && <Button type="button" aria-pressed={page === "shortcuts"} onClick={() => select("shortcuts")}>{t("Keyboard shortcuts")}</Button>}
            {!showGeneral && !featureMatches.length && !appearanceMatches.length && !showShortcuts && <p role="status">{t("No settings match.")}</p>}
          </nav>
        </aside>
        <div className="settings-main">
          <header className="settings-page-heading">
            {isAppearance && <><span>{t("Appearance")}</span><ChevronRight aria-hidden="true" /></>}
            <h3>{t(title ?? "General")}</h3>
          </header>
          <div className="settings-page-body" ref={pageBody}>
      {page === "general" ? (
        <div className="dialog-body settings-general">
          <label className="setting"><span>{t("Language")}</span>
            <select aria-label={t("Language")} value={preferences.language}
              onChange={(event) => onChange({ ...preferences, language: readLanguage(event.target.value) })}>
              {Object.entries(languages).map(([code, label]) => <option key={code} value={code} lang={code}>{label}</option>)}
            </select>
          </label>
          <label className="setting"><span>{t("Remote connection")}</span>
            <select value={preferences.provider} onChange={(event) => onChange({ ...preferences, provider: event.target.value as Provider })}>
              <option value="server">{t("Dirlume server")}</option>
              <option value="kswitcher" disabled={!windowsClient}>KSwitcher (Windows)</option>
            </select>
          </label>
          {preferences.provider === "kswitcher" && (
            <div className="field">
              <label htmlFor="kswitcher-folder">{t("KSwitcher installation folder")}</label>
              <PathField id="kswitcher-folder" label={t("KSwitcher installation folder")} value={preferences.kswitcher}
                browse="folder" showHidden={preferences.hidden} onChange={(path) => onChange({ ...preferences, kswitcher: path })} />
            </div>
          )}
          {buildVersion && <div className="setting"><span>{t("Version")}</span><code>{buildVersion}</code></div>}
        </div>
      ) : isFeaturePage(page) ? (
        <>
          {page === "filePanels" && <div className="dialog-body settings-general">
            <label className="setting"><span>{t("Show hidden files")}</span>
              <input type="checkbox" checked={preferences.hidden} onChange={(event) => onChange({ ...preferences, hidden: event.target.checked })} />
            </label>
          </div>}
          <AppearanceSettings section={page === "filePanels" ? "panels" : "fonts"} fontGroup={featureOptions[page].font}
            views={featureOptions[page].views} preferences={preferences} onChange={onChange} />
        </>
      ) : page === "viewFonts" ? (
        <div className="dialog-body appearance-settings"><ViewFontSettings preferences={preferences} onChange={onChange} /></div>
      ) : isAppearance ? (
        <AppearanceSettings section={page} preferences={preferences} onChange={onChange} />
      ) : (
        <>
          <div className="shortcut-list">
            {visibleCommands.map((command) => (
              <div key={command} className="shortcut-setting">
                <span>{t(commands[command].label)}</span>
                {command === "zoomFont" ? (
                  <select className="shortcut-key" aria-label={t("Change shortcut for {0}", t(commands[command].label))}
                    value={preferences.shortcuts[command]}
                    onChange={(event) => onChange({ ...preferences, shortcuts: { ...preferences.shortcuts, [command]: event.target.value } })}>
                    <option value="">{t("Unassigned")}</option>
                    {wheelBindings.map((binding) => <option key={binding} value={binding}>{showShortcut(binding)}</option>)}
                  </select>
                ) : capture === command ? (
                  <input aria-label={t("New shortcut for {0}", t(commands[command].label))} readOnly autoFocus
                    placeholder={t("Press a shortcut")} onKeyDown={(event) => assign(event, command)}
                    onBlur={() => { setCapture(null); setConflict(""); }} />
                ) : (
                  <Button type="button" className="shortcut-key" aria-label={t("Change shortcut for {0}", t(commands[command].label))}
                    onClick={() => { setCapture(command); setConflict(""); }}>
                    {showShortcut(preferences.shortcuts[command]) || t("Unassigned")}
                  </Button>
                )}
                <Button type="button" className="icon-button" aria-label={t("Clear shortcut for {0}", t(commands[command].label))}
                  disabled={!preferences.shortcuts[command]}
                  onClick={() => onChange({ ...preferences, shortcuts: { ...preferences.shortcuts, [command]: "" } })}>
                  <Delete />
                </Button>
              </div>
            ))}
          </div>
          {conflict && <p className="dialog-error" role="alert">{conflict}</p>}
        </>
      )}
          </div>
          <SettingsPreview page={page} preferences={preferences} />
        </div>
      </div>
      <footer className="dialog-footer">
        {page === "shortcuts" && (
          <Button type="button" onClick={() => { onChange({ ...preferences, shortcuts: defaultBindings }); setCapture(null); setConflict(""); }}>
            <RotateCcw /> {t("Restore defaults")}
          </Button>
        )}
        <Button type="button" disabled={!hasChanges} onClick={apply}>{t("Apply")}</Button>
        <Button type="button" className="primary" onClick={() => { apply(); close(); }}>{t("Done")}</Button>
      </footer>
    </Dialog>
  );
}
