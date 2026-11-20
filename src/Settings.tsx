import { Button } from "./Button";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronDown, ChevronRight, Pencil, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import { Dialog } from "./Dialog";
import { AppearanceSettings, OptionalNumberInput, ViewFontSettings, type AppearanceSection } from "./AppearanceSettings";
import { PathField } from "./PathField";
import { HistoryField } from "./HistoryField";
import { SettingsPreview } from "./SettingsPreview";
import { builtInThemes, colorGroups, fontGroups, mermaidColors, viewerColors } from "./appearance";
import { MenuAlignmentSetting, menuAlignmentTerms } from "./MenuAlignmentSetting";
import { matchesSettings, SettingSearchLabel, SettingsSearchTerms } from "./SettingSearchLabel";
import { api, windowsClient } from "./api";
import {
  actionButtonWidths, assignShortcut, commandLabel, commandNames, commands, defaultBindings, eventShortcut, maxTerminalResizeRows,
  panelLayouts, shortcutBindings, shortcutConflicts, showShortcut, wheelBindings, type ActionButtonWidth, type Bindings, type Command,
  type PanelLayout, type Preferences, type Provider,
} from "./preferences";
import { viewFonts } from "./viewFonts";
import { featureOptions, isFeaturePage, type FeaturePage } from "./featureOptions";
import { languages, locale, readLanguage, t } from "./i18n";

type Page = AppearanceSection | FeaturePage | "viewFonts" | "general" | "shortcuts";
type OptionsLocation = { page: Page; query: string; expanded: boolean; scrollTop: number };
type ShortcutCapture = { command: Command; replacing?: string };
type ShortcutSchemeDialog = { kind: "new" | "rename"; name: string } | { kind: "delete" };
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

export function Settings({ preferences: saved, onChange: applyPreferences, onClose, initialPage, standalone = false }: {
  preferences: Preferences;
  onChange: (value: Preferences) => Preferences;
  onClose: () => void;
  standalone?: boolean;
  initialPage?: FeaturePage;
}) {
  const [initialLocation] = useState(() => {
    const saved = readOptionsLocation();
    return initialPage ? { ...saved, page: initialPage, query: "", scrollTop: 0 } : saved;
  });
  const [page, setPage] = useState(initialLocation.page);
  const [query, setQuery] = useState(initialLocation.query);
  const [expanded, setExpanded] = useState(initialLocation.expanded);
  const pageBody = useRef<HTMLDivElement>(null);
  const schemeSelect = useRef<HTMLSelectElement>(null);
  const [preferences, onChange] = useState(saved);
  const [capture, setCapture] = useState<ShortcutCapture | null>(null);
  const [conflict, setConflict] = useState<{ key: string; owners: Command[] } | null>(null);
  const [schemeDialog, setSchemeDialog] = useState<ShortcutSchemeDialog | null>(null);
  const [buildVersion, setBuildVersion] = useState("");
  const { shortcutSchemes, activeShortcutScheme } = preferences;
  const activeScheme = shortcutSchemes.find(({ id }) => id === activeShortcutScheme);
  const shortcuts = shortcutBindings(preferences);
  const hasChanges = JSON.stringify(preferences) !== JSON.stringify(saved);
  const searching = Boolean(query.trim());
  const terms = searching ? query.trim().toLocaleLowerCase().split(/\s+/) : [];
  const matches = (...labels: string[]) => matchesSettings(terms, labels);
  const showGeneral = matches("General", "Language", ...Object.values(languages), "Main menu position",
    ...menuAlignmentTerms, "Remote connection", "Dirlume server", "KSwitcher (Windows)", "KSwitcher installation folder", "Version");
  const featureMatches = featurePages.filter((feature) => {
    const { label, font, views } = featureOptions[feature];
    const terms = feature === "filePanels" ? [
      "Show hidden files", "Panel layout", "Action button width",
      ...Object.values(panelLayouts), ...Object.values(actionButtonWidths), ...Object.values(colorGroups.panels.colors),
    ] :
      feature === "viewer" ? ["Reading area", "Max width (px)", "Maximum content width (px)", "Full width", "Mermaid diagrams",
        ...Object.values(viewerColors), ...Object.values(mermaidColors)] :
      feature === "terminal" ? ["Resize step (rows)", "Paste on right-click", ...(windowsClient ? ["Automatically refresh environment variables"] : [])] : [];
    return matches(label, fontGroups[font].label, "Font family", "Installed fonts", "Size (px)", "font size",
      ...(views.length ? ["zoom", "wheel"] : []), ...views.map((view) => viewFonts[view].label), ...terms);
  });
  const appearanceMatches = appearancePages.filter(({ id, label, terms }) => matches("Appearance", label, ...terms,
    ...(id === "window" ? ["Color scheme", "New scheme", "Scheme name", "Base theme", "Delete scheme",
      "Favorite light scheme", "Favorite dark scheme", "Show color scheme switcher in the title bar",
      "Main menu alignment", ...menuAlignmentTerms, ...Object.values(builtInThemes)] : [])));
  const allShortcuts = matches("Keyboard shortcuts", "keymap bindings", "Shortcut scheme");
  const visibleCommands = allShortcuts ? commandNames : commandNames.filter((command) =>
    matches(commands[command].label, commandLabel(command), ...shortcuts[command], ...shortcuts[command].map(showShortcut)));
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
    setConflict(null);
  }

  function apply() {
    if (hasChanges) onChange(applyPreferences(preferences));
  }

  function saveLocation() {
    const location: OptionsLocation = { page, query, expanded, scrollTop: pageBody.current?.scrollTop ?? 0 };
    try { localStorage.setItem(optionsLocationKey, JSON.stringify(location)); } catch { /* Options can still close. */ }
  }

  const saveLocationRef = useRef(saveLocation);
  saveLocationRef.current = saveLocation;
  useEffect(() => {
    if (!standalone) return;
    const window = getCurrentWindow();
    const listeners = [
      window.onCloseRequested(() => saveLocationRef.current()),
      window.listen<string>("dirlume:options-page", ({ payload }) => {
        if (!isFeaturePage(payload)) return;
        setPage(payload);
        setQuery("");
        setCapture(null);
        setConflict(null);
        if (pageBody.current) pageBody.current.scrollTop = 0;
      }),
    ];
    return () => { listeners.forEach((listener) => { void listener.then((unlisten) => unlisten()).catch(() => {}); }); };
  }, [standalone]);

  function close() {
    saveLocation();
    onClose();
  }

  function finishCapture(command: Command) {
    setCapture(null);
    setConflict(null);
    requestAnimationFrame(() => pageBody.current?.querySelector<HTMLButtonElement>(`[data-add-shortcut="${command}"]`)?.focus());
  }

  function schemeNameTaken(name: string, except?: string) {
    const normalized = name.toLocaleLowerCase();
    return normalized === "default" || normalized === t("Default").toLocaleLowerCase() ||
      shortcutSchemes.some((scheme) => scheme.id !== except && scheme.name.toLocaleLowerCase() === normalized);
  }

  function createShortcutScheme(name: string, bindings: Bindings) {
    let number = 1;
    while (shortcutSchemes.some(({ id }) => id === `shortcut-scheme-${number}`)) number++;
    const scheme = { id: `shortcut-scheme-${number}`, name, bindings };
    onChange({ ...preferences, activeShortcutScheme: scheme.id, shortcutSchemes: [...shortcutSchemes, scheme] });
  }

  function updateShortcuts(bindings: Bindings) {
    if (activeScheme) {
      onChange({ ...preferences, shortcutSchemes: shortcutSchemes.map((scheme) =>
        scheme.id === activeScheme.id ? { ...scheme, bindings } : scheme) });
      return;
    }
    let name = "My shortcuts";
    for (let number = 2; schemeNameTaken(name); number++) name = `My shortcuts ${number}`;
    createShortcutScheme(name, bindings);
  }

  function openSchemeDialog(dialog: ShortcutSchemeDialog) {
    setCapture(null);
    setSchemeDialog(dialog);
  }

  function saveShortcut(key: string, { command, replacing }: ShortcutCapture) {
    updateShortcuts(assignShortcut(shortcuts, command, key, replacing));
    finishCapture(command);
  }

  function captureKey(event: KeyboardEvent, current: ShortcutCapture) {
    event.preventDefault();
    event.stopPropagation();
    const { command } = current;
    if (event.key === "Escape") return finishCapture(command);
    if (event.repeat || event.nativeEvent.isComposing) return;
    const shortcut = command === "menuAlternate" && event.key === "Alt" && !event.ctrlKey && !event.metaKey && !event.shiftKey ? "Alt" : eventShortcut(event);
    if (!shortcut) return;
    if (shortcuts[command].includes(shortcut)) return finishCapture(command);
    const owners = shortcutConflicts(shortcuts, command, shortcut);
    if (owners.length) setConflict({ key: shortcut, owners });
    else saveShortcut(shortcut, current);
  }

  const schemeName = schemeDialog && "name" in schemeDialog ? schemeDialog.name.trim() : "";
  const renameScheme = schemeDialog?.kind === "rename";
  const duplicateSchemeName = Boolean(schemeName) && schemeNameTaken(schemeName, renameScheme ? activeScheme?.id : undefined);

  return <SettingsSearchTerms value={terms}>
    <Dialog title={t("Options")} onClose={close} wide resizeKey={standalone ? undefined : "options"} standalone={standalone} footer={<>
      {page === "shortcuts" && (
        <Button type="button" disabled={!activeScheme} onClick={() => { updateShortcuts(defaultBindings); setCapture(null); }}>
          <RotateCcw /> {t("Restore defaults")}
        </Button>
      )}
      {standalone && <Button type="button" onClick={close}>{t("Cancel")}</Button>}
      <Button type="button" disabled={!hasChanges} onClick={apply}>{t("Apply")}</Button>
      <Button type="button" className="primary" onClick={() => { apply(); close(); }}>{t("Done")}</Button>
    </>}>
      <div className="settings-layout">
        <aside className="settings-sidebar">
          <label className="settings-search"><Search aria-hidden="true" />
            <HistoryField historyKey="settings-search" type="search" aria-label={t("Search settings")} placeholder={t("Search settings")} value={query}
              data-initial-focus onValueChange={(value) => { setQuery(value); setCapture(null); }}
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
                    if (!isAppearance) { select(appearanceMatches[0].id); setExpanded(true); }
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
          {page === "shortcuts" && <div className="shortcut-scheme-bar">
            <label><SettingSearchLabel label="Shortcut scheme" aliases={["keymap", "bindings"]} />
              <select ref={schemeSelect} value={activeShortcutScheme ?? ""} onChange={(event) => {
                setCapture(null);
                onChange({ ...preferences, activeShortcutScheme: event.target.value || null });
              }}>
                <option value="">{t("Default")}</option>
                {shortcutSchemes.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
              </select>
            </label>
            <Button type="button" onClick={() => openSchemeDialog({ kind: "new", name: "" })}><Plus aria-hidden="true" /> {t("New scheme")}</Button>
            <Button type="button" className="icon-button" aria-label={t("Rename shortcut scheme")} disabled={!activeScheme}
              onClick={() => activeScheme && openSchemeDialog({ kind: "rename", name: activeScheme.name })}><Pencil aria-hidden="true" /></Button>
            <Button type="button" className="icon-button" aria-label={t("Delete shortcut scheme")} disabled={!activeScheme}
              onClick={() => openSchemeDialog({ kind: "delete" })}><Trash2 aria-hidden="true" /></Button>
          </div>}
          <div className="settings-page-body" ref={pageBody}>
      {page === "general" ? (
        <div className="dialog-body settings-general">
          <label className="setting"><SettingSearchLabel label="Language" aliases={Object.values(languages)} />
            <select aria-label={t("Language")} value={preferences.language}
              onChange={(event) => onChange({ ...preferences, language: readLanguage(event.target.value) })}>
              {Object.entries(languages).map(([code, label]) => <option key={code} value={code} lang={code}>{label}</option>)}
            </select>
          </label>
          <MenuAlignmentSetting label="Main menu position" value={preferences.mainMenuAlignment}
            onChange={(mainMenuAlignment) => onChange({ ...preferences, mainMenuAlignment })} />
          <label className="setting"><SettingSearchLabel label="Remote connection" aliases={["Dirlume server", "KSwitcher (Windows)"]} />
            <select value={preferences.provider} onChange={(event) => onChange({ ...preferences, provider: event.target.value as Provider })}>
              <option value="server">{t("Dirlume server")}</option>
              <option value="kswitcher" disabled={!windowsClient}>KSwitcher (Windows)</option>
            </select>
          </label>
          {preferences.provider === "kswitcher" && (
            <div className="field">
              <label htmlFor="kswitcher-folder"><SettingSearchLabel label="KSwitcher installation folder" /></label>
              <PathField id="kswitcher-folder" label={t("KSwitcher installation folder")} value={preferences.kswitcher}
                browse="folder" showHidden={preferences.hidden} onChange={(path) => onChange({ ...preferences, kswitcher: path })} />
            </div>
          )}
          {buildVersion && <div className="setting"><SettingSearchLabel label="Version" /><code>{buildVersion}</code></div>}
        </div>
      ) : isFeaturePage(page) ? (
        <>
          {page === "terminal" && <div className="dialog-body settings-general">
            <label className="view-font-setting unit-setting"><SettingSearchLabel label="Resize step (rows)" />
              <OptionalNumberInput label={t("Resize step (rows)")} size={preferences.terminalResizeRows === 1 ? undefined : preferences.terminalResizeRows}
                fallback="1" min={1} max={maxTerminalResizeRows}
                onChange={(rows) => onChange({ ...preferences, terminalResizeRows: rows ?? 1 })} />
            </label>
            <label className="field-checkbox"><SettingSearchLabel label="Paste on right-click" />
              <input type="checkbox" checked={preferences.terminalPasteOnRightClick}
                onChange={(event) => onChange({ ...preferences, terminalPasteOnRightClick: event.target.checked })} />
            </label>
            {windowsClient && <label className="field-checkbox"><SettingSearchLabel label="Automatically refresh environment variables" />
              <input type="checkbox" checked={preferences.refreshEnvironment}
                onChange={(event) => onChange({ ...preferences, refreshEnvironment: event.target.checked })} />
            </label>}
          </div>}
          {page === "filePanels" && <div className="dialog-body settings-general">
            <label className="field-checkbox"><SettingSearchLabel label="Show hidden files" />
              <input type="checkbox" checked={preferences.hidden} onChange={(event) => onChange({ ...preferences, hidden: event.target.checked })} />
            </label>
            <label className="setting"><SettingSearchLabel label="Panel layout" aliases={Object.values(panelLayouts)} />
              <select value={preferences.layout} onChange={(event) => onChange({ ...preferences, layout: event.target.value as PanelLayout })}>
                {Object.entries(panelLayouts).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
              </select>
            </label>
            <label className="setting"><SettingSearchLabel label="Action button width" aliases={Object.values(actionButtonWidths)} />
              <select value={preferences.actionButtonWidth}
                onChange={(event) => onChange({ ...preferences, actionButtonWidth: event.target.value as ActionButtonWidth })}>
                {Object.entries(actionButtonWidths).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
              </select>
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
            {visibleCommands.map((command) => {
              const label = commandLabel(command);
              const bindings = shortcuts[command];
              return <div key={command} className="shortcut-setting">
                <SettingSearchLabel label={label} aliases={[commands[command].label, ...bindings, ...bindings.map(showShortcut)]} />
                {command === "zoomFont" ? <select className="shortcut-key" aria-label={t("Change shortcut for {0}", label)}
                  value={bindings[0] ?? ""} onChange={(event) => {
                    const key = event.target.value;
                    updateShortcuts({ ...shortcuts, [command]: key ? [key] : [] });
                  }}>
                  <option value="">{t("Unassigned")}</option>
                  {wheelBindings.map((binding) => <option key={binding} value={binding}>{showShortcut(binding)}</option>)}
                </select> : <div className="shortcut-bindings">
                  {bindings.map((binding) => <div key={binding} className="shortcut-binding">
                    <Button type="button" className="shortcut-key" aria-label={t("Change {0} for {1}", showShortcut(binding), label)}
                      onClick={() => setCapture({ command, replacing: binding })}><span>{showShortcut(binding)}</span></Button>
                    <Button type="button" className="icon-button shortcut-remove" aria-label={t("Remove {0} from {1}", showShortcut(binding), label)} onClick={() => {
                      updateShortcuts({ ...shortcuts, [command]: bindings.filter((key) => key !== binding) });
                      finishCapture(command);
                    }}><X aria-hidden="true" /></Button>
                  </div>)}
                  <Button type="button" className="shortcut-add" data-add-shortcut={command} aria-label={t("Add shortcut for {0}", label)}
                    onClick={() => setCapture({ command })}><Plus aria-hidden="true" /> {t("Add shortcut")}</Button>
                  {capture?.command === command && <input key={capture.replacing ?? "add"}
                    aria-label={capture.replacing ? t("New shortcut to replace {0} for {1}", showShortcut(capture.replacing), label) : t("New shortcut for {0}", label)}
                    readOnly autoFocus data-shortcut-capture placeholder={t("Press a shortcut")}
                    onKeyDown={(event) => captureKey(event, capture)} />}
                </div>}
              </div>;
            })}
          </div>
        </>
      )}
          </div>
          <SettingsPreview page={page} preferences={preferences} />
        </div>
      </div>
    </Dialog>
    {schemeDialog && "name" in schemeDialog && <Dialog title={t(renameScheme ? "Rename shortcut scheme" : "New shortcut scheme")}
      onClose={() => setSchemeDialog(null)} footer={<>
        <Button type="button" onClick={() => setSchemeDialog(null)}>{t("Cancel")}</Button>
        <Button type="submit" className="primary" form="shortcut-scheme-form" disabled={!schemeName || duplicateSchemeName}>
          {t(renameScheme ? "Save" : "Create")}
        </Button>
      </>}>
      <form id="shortcut-scheme-form" className="dialog-body" onSubmit={(event) => {
        event.preventDefault();
        if (!schemeName || duplicateSchemeName) return;
        if (renameScheme) {
          onChange({ ...preferences, shortcutSchemes: shortcutSchemes.map((scheme) =>
            scheme.id === activeShortcutScheme ? { ...scheme, name: schemeName } : scheme) });
        } else createShortcutScheme(schemeName, shortcuts);
        setSchemeDialog(null);
      }}>
        <label className="field">{t("Scheme name")}
          <input data-initial-focus maxLength={64} required value={schemeDialog.name} aria-invalid={duplicateSchemeName || undefined}
            aria-describedby={duplicateSchemeName ? "shortcut-scheme-name-error" : undefined}
            onChange={(event) => setSchemeDialog({ ...schemeDialog, name: event.target.value })} />
        </label>
        {duplicateSchemeName && <p id="shortcut-scheme-name-error" role="alert" className="dialog-error">{t("A shortcut scheme with this name already exists.")}</p>}
      </form>
    </Dialog>}
    {schemeDialog?.kind === "delete" && activeScheme && <Dialog title={t("Delete shortcut scheme")} tone="warning"
      onClose={() => setSchemeDialog(null)} footer={<>
        <Button type="button" data-initial-focus onClick={() => setSchemeDialog(null)}>{t("Cancel")}</Button>
        <Button type="button" className="negative" onClick={() => {
          onChange({ ...preferences, activeShortcutScheme: null, shortcutSchemes: shortcutSchemes.filter(({ id }) => id !== activeScheme.id) });
          setSchemeDialog(null);
          requestAnimationFrame(() => schemeSelect.current?.focus());
        }}>{t("Delete scheme")}</Button>
      </>}>
      <div className="dialog-body"><p>{t("Delete the shortcut scheme {0}?", activeScheme.name)}</p></div>
    </Dialog>}
    {capture && conflict && <Dialog title={t("Shortcut conflict")} onClose={() => setConflict(null)} footer={<>
      <Button type="button" data-initial-focus onClick={() => setConflict(null)}>{t("Choose another shortcut")}</Button>
      <Button type="button" className="primary" onClick={() => saveShortcut(conflict.key, capture)}>{t("Reassign shortcut")}</Button>
    </>}>
      <div className="dialog-body">
        <p>{t("{0} is assigned to {1}.", showShortcut(conflict.key), new Intl.ListFormat(locale()).format(conflict.owners.map(commandLabel)))}</p>
        <p>{t("Move this shortcut to {0}?", commandLabel(capture.command))}</p>
      </div>
    </Dialog>}
  </SettingsSearchTerms>;
}
