import { Button } from "./Button";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronDown, ChevronRight, Crosshair, Pencil, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import { Dialog } from "./Dialog";
import { AppearanceSettings, OptionalNumberInput, ViewFontSettings, type AppearanceSection } from "./AppearanceSettings";
import { PathField } from "./PathField";
import { HistoryField } from "./HistoryField";
import { SettingsPreview } from "./SettingsPreview";
import { SettingsArchiveDialog, type SettingsArchiveAction } from "./SettingsArchiveDialog";
import { parseSettingsArchive } from "./settingsArchive";
import { builtInThemes, colorGroups, colorKeysForSurface, colorLabels, fontGroups, mermaidColors, viewerColors, type Surface } from "./appearance";
import { MenuAlignmentSetting, menuAlignmentTerms } from "./MenuAlignmentSetting";
import { matchesSettings, SettingSearchLabel, SettingsSearchTerms } from "./SettingSearchLabel";
import { api, describeError, windowsClient } from "./api";
import {
  actionButtonWidths, assignShortcut, commandLabel, commandNames, commands, defaultBindings, captureShortcut, commandPanelMode, folderGroupCommand, maxTerminalResizeRows,
  panelLayouts, shortcutBindings, shortcutConflicts, showShortcut, wheelBindings, type ActionButtonWidth, type Bindings, type Command,
  type PanelLayout, type Preferences, type Provider,
} from "./preferences";
import { viewFonts } from "./viewFonts";
import { featureOptions, isFeaturePage, optionSurfaces, type FeaturePage } from "./featureOptions";
import type { HelpTopic } from "./helpContent";
import { errorText, languages, locale, readLanguage, t } from "./i18n";
import { localPickDate, pickLabel, readPickHistory, savePickHistory, type AppearancePick, type PickHistoryEntry } from "./appearancePick";

import { SortGroupsSettings } from "./FileSortMenu";
import { PanelModeSettings, panelModeSettingsLabels } from "./PanelModeSettings";
import { defaultPanelModes, isPanelMode, panelModeIds, panelModeName, panelModeNames, validPanelMode, type PanelModeId } from "./panelModes";

type Page = AppearanceSection | FeaturePage | PanelModeId | "sortGroups" | "viewFonts" | "general" | "shortcuts";
type OptionsLocation = { page: Page; query: string; expanded: boolean; scrollTop: number };
type ShortcutCapture = { command: Command; replacing?: string };
type ShortcutSchemeDialog = { kind: "new" | "rename"; name: string } | { kind: "delete" };
const optionsLocationKey = "dirlume.options-location";
const featurePages = Object.keys(featureOptions) as FeaturePage[];
const surfaceTerms = (surfaces: readonly Surface[]) => surfaces.flatMap((surface) =>
  [fontGroups[surface].label, "Font family", "Font size", ...colorKeysForSurface(surface).map((color) => colorLabels[color])]);
const appearancePages = [
  ...Object.entries(colorGroups).map(([id, group]) => ({
    id: id as AppearanceSection, label: group.label,
    terms: [...Object.values(group.colors), ...(id === "text" ? surfaceTerms(optionSurfaces.text) : [])],
  })),
  { id: "fonts" as const, label: "Fonts", terms: [fontGroups.ui.label, fontGroups.panel.label,
    fontGroups.dialog.label, fontGroups.mono.label, "family size installed"] },
  { id: "viewFonts" as const, label: "View font sizes", terms: [...Object.values(viewFonts).map(({ label }) => label), "zoom wheel"] },
];

function optionsHelpTopic(page: Page): HelpTopic {
  if (page === "filePanels" || page === "sortGroups" || isPanelMode(page)) return "files";
  if (page === "files") return "fileTypes";
  if (page === "text") return "textTools";
  return page;
}

function readOptionsLocation(): OptionsLocation {
  const defaults: OptionsLocation = { page: "general", query: "", expanded: true, scrollTop: 0 };
  try {
    const saved = JSON.parse(localStorage.getItem(optionsLocationKey) ?? "null") as Partial<OptionsLocation> | null;
    const page = saved?.page;
    if (!page || (page !== "general" && page !== "shortcuts" && page !== "sortGroups" && !isFeaturePage(page) &&
        !isPanelMode(page) && !appearancePages.some(({ id }) => id === page))) return defaults;
    const scrollTop = saved.scrollTop;
    return {
      page,
      query: typeof saved.query === "string" ? saved.query : defaults.query,
      expanded: typeof saved.expanded === "boolean" ? saved.expanded : defaults.expanded,
      scrollTop: typeof scrollTop === "number" && Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : defaults.scrollTop,
    };
  } catch { return defaults; }
}

export function Settings({ preferences: saved, onChange: applyPreferences, onClose, onPick, initialPage, standalone = false }: {
  preferences: Preferences;
  onChange: (value: Preferences) => Preferences;
  onClose: () => void;
  onPick?: () => Promise<AppearancePick | null>;
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
  const [modesExpanded, setModesExpanded] = useState(isPanelMode(initialLocation.page));
  const pageBody = useRef<HTMLDivElement>(null);
  const schemeSelect = useRef<HTMLSelectElement>(null);
  const [preferences, onChange] = useState(saved);
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState(false);
  const [selection, setSelection] = useState<PickHistoryEntry | null>(null);
  const [pickHistory, setPickHistory] = useState(readPickHistory);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const pickButton = useRef<HTMLButtonElement>(null);
  const historyDates = new Map<string, PickHistoryEntry[]>();
  for (const entry of pickHistory) {
    const date = localPickDate(entry.time);
    const entries = historyDates.get(date);
    if (entries) entries.push(entry);
    else historyDates.set(date, [entry]);
  }
  const [capture, setCapture] = useState<ShortcutCapture | null>(null);
  const [distinguishControl, setDistinguishControl] = useState(false);
  const [conflict, setConflict] = useState<{ key: string; owners: Command[] } | null>(null);
  const [schemeDialog, setSchemeDialog] = useState<ShortcutSchemeDialog | null>(null);
  const [settingsArchive, setSettingsArchive] = useState<SettingsArchiveAction | null>(null);
  const [loadingArchive, setLoadingArchive] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [saveError, setSaveError] = useState("");
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
      "Show hidden files", "Panel layout", "Action button width", "Hide action button icons",
      ...Object.values(panelLayouts), ...Object.values(actionButtonWidths), ...Object.values(colorGroups.panels.colors),
    ] :
      feature === "viewer" ? ["Reading area", "Max width (px)", "Maximum content width (px)", "Full width", "Mermaid diagrams",
        "Markdown reading width", "Markdown max width (px)", "Use shared width", "Custom width",
        ...Object.values(viewerColors), ...Object.values(mermaidColors)] :
      feature === "terminal" ? ["Resize step (rows)", "Paste on right-click", ...(windowsClient ? ["Automatically refresh environment variables"] : [])] : [];
    return matches(label, fontGroups[font].label, "Font family", "Installed fonts", "Size (px)", "font size",
      ...(views.length ? ["zoom", "wheel"] : []), ...views.map((view) => viewFonts[view].label), ...terms,
      ...surfaceTerms(feature === "filePanels" ? [] : optionSurfaces[feature]));
  });
  const appearanceMatches = appearancePages.filter(({ id, label, terms }) => matches("Appearance", label, ...terms,
    ...(id === "window" ? ["Color scheme", "Keep current fonts", "New scheme", "Scheme name", "Base theme", "Delete scheme",
      "Favorite light scheme", "Favorite dark scheme", "Show color scheme switcher in the title bar",
      "Main menu alignment", ...menuAlignmentTerms, ...Object.values(builtInThemes)] : [])));
  const modesMatch = panelModeIds.filter((id) => matches("Panel modes", panelModeNames[id],
    panelModeName(id, preferences.panelModes), ...panelModeSettingsLabels));
  const showSortGroups = matches("Sort groups", "Use sort groups", "Filename mask", "Before unmatched items", "After unmatched items");
  const invalidSettings = preferences.sortSettings.groups.some(({ mask }) => !mask.trim());
  const modePage = isPanelMode(page) ? page : undefined;
  const invalidModes = panelModeIds.filter((id) => !validPanelMode(preferences.panelModes[id]));
  const allShortcuts = matches("Keyboard shortcuts", "keymap bindings", "Shortcut scheme");
  const visibleCommands = commandNames.filter((command) =>
    (windowsClient || !/^drive[A-Z]Sources$/.test(command)) &&
    (allShortcuts || matches(commands[command].label, commandLabel(command), ...shortcuts[command], ...shortcuts[command].map(showShortcut))));
  const showShortcuts = allShortcuts || visibleCommands.length > 0;
  const feature = isFeaturePage(page) ? featureOptions[page] : undefined;
  const isAppearance = !feature && page !== "sortGroups" && !isPanelMode(page) && page !== "general" && page !== "shortcuts";
  const title = feature?.label ?? (isAppearance ? appearancePages.find(({ id }) => id === page)?.label : page === "general" ? "General" : page === "sortGroups" ? "Sort groups" : "Keyboard shortcuts");

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
    if ((next !== page || selection) && pageBody.current) pageBody.current.scrollTop = 0;
    setSelection(null);
    setPage(next);
    setCapture(null);
    setConflict(null);
  }

  function openPick(entry: PickHistoryEntry) {
    if (pageBody.current) pageBody.current.scrollTop = 0;
    setCapture(null);
    setConflict(null);
    setQuery("");
    setSelection(entry);
    setHistoryExpanded(true);
  }

  async function pick() {
    if (!onPick || picking) return;
    setPickError(false);
    setPicking(true);
    try {
      const result = await onPick();
      if (!result) return;
      const time = Date.now();
      const entry = { ...result, id: `${time}-${pickHistory.length}`, time };
      const history = [entry, ...pickHistory];
      savePickHistory(history);
      setPickHistory(history);
      openPick(entry);
    } catch {
      setPickError(true);
    } finally {
      setPicking(false);
      requestAnimationFrame(() => pickButton.current?.focus());
    }
  }

  function apply() {
    if (invalidModes.length || invalidSettings) return false;
    if (!hasChanges) return true;
    try {
      onChange(applyPreferences(preferences));
      setSaveError("");
      return true;
    } catch (error) {
      setSaveError(errorText(describeError(error)));
      return false;
    }
  }

  async function startImport() {
    setLoadingArchive(true);
    try {
      const contents = await api.readSettingsArchive(t("Import settings"));
      if (contents !== null) setSettingsArchive({ kind: "import", archive: parseSettingsArchive(contents) });
    } catch (error) {
      setArchiveError(errorText(describeError(error)));
    } finally {
      setLoadingArchive(false);
    }
  }

  function applyImport(patch: Partial<Preferences>) {
    const applied = applyPreferences({ ...saved, ...patch });
    const draft = { ...applied };
    for (const key of Object.keys(preferences) as (keyof Preferences)[]) {
      if (!Object.hasOwn(patch, key) && JSON.stringify(preferences[key]) !== JSON.stringify(saved[key])) {
        Object.assign(draft, { [key]: preferences[key] });
      }
    }
    onChange(draft);
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
        setSelection(null);
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

  function beginCapture(command: Command, replacing?: string) {
    setDistinguishControl(replacing ? /^(Left|Right)Ctrl\+/.test(replacing) :
      !!commandPanelMode(command) || folderGroupCommand(command)?.add === false);
    setCapture({ command, replacing });
  }

  function captureKey(event: KeyboardEvent, current: ShortcutCapture) {
    event.preventDefault();
    event.stopPropagation();
    const { command } = current;
    if (event.key === "Escape") return finishCapture(command);
    if (event.repeat || event.nativeEvent.isComposing) return;
    const shortcut = command === "menuAlternate" && event.key === "Alt" && !event.ctrlKey && !event.metaKey && !event.shiftKey ? "Alt" : captureShortcut(event.nativeEvent, distinguishControl);
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
    <Dialog title={t("Options")} helpTopic={selection ? "appearance" : optionsHelpTopic(page)} onClose={close}
      wide resizeKey={standalone ? undefined : "options"} standalone={standalone} suspended={picking && !standalone} footer={<>
      {saveError && <p className="dialog-error settings-save-error" role="alert">
        {t("Could not save settings. Try again, or close Options to discard unapplied changes.")} {saveError}
      </p>}
      <div className="settings-archive-actions">
        <Button type="button" disabled={loadingArchive} onClick={() => void startImport()}>{t("Import settings")}</Button>
        <Button type="button" disabled={loadingArchive} onClick={() => setSettingsArchive({ kind: "export" })}>{t("Export settings")}</Button>
      </div>
      {!selection && page === "shortcuts" && (
        <Button type="button" disabled={!activeScheme} onClick={() => { updateShortcuts(defaultBindings); setCapture(null); }}>
          <RotateCcw /> {t("Restore defaults")}
        </Button>
      )}
      {!selection && modePage && <Button type="button" onClick={() => onChange({
        ...preferences, panelModes: { ...preferences.panelModes, [modePage]: defaultPanelModes[modePage] },
      })}><RotateCcw /> {t("Reset")}</Button>}
      {(standalone || modePage) && <Button type="button" onClick={close}>{t("Cancel")}</Button>}
      <Button type="button" disabled={!hasChanges || invalidModes.length > 0 || invalidSettings} onClick={apply}>{t("Apply")}</Button>
      <Button type="button" className="primary" disabled={invalidModes.length > 0 || invalidSettings} onClick={() => { if (apply()) close(); }}>{t("Done")}</Button>
    </>}>
      <div className="settings-layout">
        <aside className="settings-sidebar">
          <div className="settings-search-actions">
          <label className="settings-search"><Search aria-hidden="true" />
            <HistoryField historyKey="settings-search" type="search" aria-label={t("Search settings")} placeholder={t("Search settings")} value={query}
              data-initial-focus onValueChange={(value) => { setQuery(value); setCapture(null); setSelection(null); }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !searching) return;
                event.preventDefault();
                if (showGeneral) select("general");
                else if (featureMatches.length) select(featureMatches[0]);
                else if (modesMatch.length) select(modesMatch[0]);
                else if (showSortGroups) select("sortGroups");
                else if (appearanceMatches.length) select(appearanceMatches[0].id);
                else if (showShortcuts) select("shortcuts");
              }} />
          </label>
          {onPick && <Button ref={pickButton} type="button" className="icon-button" data-help-topic="appearance" aria-label={t("Pick an element")}
            tooltip={t("Pick an element")} disabled={picking} onClick={() => { void pick(); }}><Crosshair /></Button>}
          </div>
          {pickError && <p role="alert" className="dialog-error">{t("Could not start the appearance picker.")}</p>}
          <nav className="settings-tree" aria-label={t("Options sections")}>
            {showGeneral && <Button type="button" data-help-topic="general" aria-pressed={!selection && page === "general"} onClick={() => select("general")}>{t("General")}</Button>}
            {featureMatches.map((id) => <Button key={id} type="button" data-help-topic={optionsHelpTopic(id)} aria-pressed={!selection && page === id} onClick={() => select(id)}>
              {t(featureOptions[id].label)}
            </Button>)}
            {showSortGroups && <Button type="button" data-help-topic="files" aria-pressed={!selection && page === "sortGroups"} onClick={() => select("sortGroups")}>
              {t("Sort groups")}
            </Button>}
            {modesMatch.length > 0 && <>
              <Button type="button" data-help-topic="files" aria-expanded={modesExpanded || searching} aria-controls="options-panel-modes"
                onClick={() => {
                  if (!modePage || selection) { select(modesMatch[0]); setModesExpanded(true); }
                  else setModesExpanded(!modesExpanded);
                }}>
                {modesExpanded || searching ? <ChevronDown /> : <ChevronRight />} {t("Panel modes")}
              </Button>
              <div id="options-panel-modes" className="settings-tree-branch" hidden={!modesExpanded && !searching}>
                {modesMatch.map((id) => <Button key={id} type="button" data-help-topic="files" aria-pressed={!selection && page === id} onClick={() => select(id)}>
                  {panelModeName(id, preferences.panelModes)}
                </Button>)}
              </div>
            </>}
            {appearanceMatches.length > 0 && (
              <>
                <Button type="button" data-help-topic="appearance" aria-expanded={expanded || searching} aria-controls="options-appearance-pages"
                  onClick={() => {
                    if (!isAppearance || selection) { select(appearanceMatches[0].id); setExpanded(true); }
                    else setExpanded(!expanded);
                  }}>
                  {expanded || searching ? <ChevronDown /> : <ChevronRight />} {t("Appearance")}
                </Button>
                <div id="options-appearance-pages" className="settings-tree-branch" hidden={!expanded && !searching}>
                  {appearanceMatches.map(({ id, label }) => (
                    <Button key={id} type="button" data-help-topic={optionsHelpTopic(id)} aria-pressed={!selection && page === id} onClick={() => select(id)}>{t(label)}</Button>
                  ))}
                </div>
              </>
            )}
            {showShortcuts && <Button type="button" data-help-topic="shortcuts" aria-pressed={!selection && page === "shortcuts"} onClick={() => select("shortcuts")}>{t("Keyboard shortcuts")}</Button>}
            {!searching && onPick && <>
              <Button type="button" aria-expanded={historyExpanded} aria-controls="options-picker-history"
                onClick={() => setHistoryExpanded(!historyExpanded)}>
                {historyExpanded ? <ChevronDown /> : <ChevronRight />} {t("Picker history")}
              </Button>
              <div id="options-picker-history" className="settings-tree-branch picker-history" hidden={!historyExpanded}>
                {!pickHistory.length && <p>{t("Picked elements will appear here.")}</p>}
                {[...historyDates].map(([date, entries]) => <section key={date} aria-label={date}>
                  <h4>{date}</h4>
                  {entries.map((entry) => <Button key={entry.id} type="button" aria-pressed={selection?.id === entry.id}
                    onClick={() => openPick(entry)}>{pickLabel(entry)}</Button>)}
                </section>)}
              </div>
            </>}
            {!showGeneral && !featureMatches.length && !appearanceMatches.length && !modesMatch.length && !showSortGroups && !showShortcuts && <p role="status">{t("No settings match.")}</p>}
          </nav>
        </aside>
        <div className="settings-main">
          <header className="settings-page-heading">
            {(isAppearance || selection) && <><span>{t("Appearance")}</span><ChevronRight aria-hidden="true" /></>}
            {!selection && modePage && <><span>{t("Panel modes")}</span><ChevronRight aria-hidden="true" /></>}
            <h3>{selection ? pickLabel(selection) : modePage ? panelModeName(modePage, preferences.panelModes) : t(title ?? "General")}</h3>
          </header>
          {!selection && page === "shortcuts" && <div className="shortcut-scheme-bar">
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
      {selection ? <AppearanceSettings key={selection.id} section="fonts" selection={selection}
        views={selection.view ? [selection.view] : undefined} preferences={preferences} onChange={onChange} /> : page === "general" ? (
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
            <label className="field-checkbox"><SettingSearchLabel label="Hide action button icons" />
              <input type="checkbox" checked={preferences.hideActionButtonIcons}
                onChange={(event) => onChange({ ...preferences, hideActionButtonIcons: event.target.checked })} />
            </label>
          </div>}
          <AppearanceSettings section={page === "filePanels" ? "panels" : "fonts"} fontGroup={featureOptions[page].font}
            views={featureOptions[page].views} preferences={preferences} onChange={onChange} />
        </>
      ) : page === "sortGroups" ? (
        <SortGroupsSettings groups={preferences.sortSettings.groups} onChange={(groups) =>
          onChange({ ...preferences, sortSettings: { ...preferences.sortSettings, groups } })} />
      ) : isPanelMode(page) ? (
        <PanelModeSettings key={page} mode={preferences.panelModes[page]} defaultName={t(panelModeNames[page])}
          onChange={(mode) => onChange({ ...preferences, panelModes: { ...preferences.panelModes, [page]: mode } })} />
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
                      onClick={() => beginCapture(command, binding)}><span>{showShortcut(binding)}</span></Button>
                    <Button type="button" className="icon-button shortcut-remove" aria-label={t("Remove {0} from {1}", showShortcut(binding), label)} onClick={() => {
                      updateShortcuts({ ...shortcuts, [command]: bindings.filter((key) => key !== binding) });
                      finishCapture(command);
                    }}><X aria-hidden="true" /></Button>
                  </div>)}
                  <Button type="button" className="shortcut-add" data-add-shortcut={command} aria-label={t("Add shortcut for {0}", label)}
                    onClick={() => beginCapture(command)}><Plus aria-hidden="true" /> {t("Add shortcut")}</Button>
                  {capture?.command === command && <div className="shortcut-capture"><input key={capture.replacing ?? "add"}
                    aria-label={capture.replacing ? t("New shortcut to replace {0} for {1}", showShortcut(capture.replacing), label) : t("New shortcut for {0}", label)}
                    readOnly autoFocus data-shortcut-capture placeholder={t("Press a shortcut")}
                                        onKeyDown={(event) => {
                      if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) return;
                      captureKey(event, capture);
                    }} />
                    <label><input type="checkbox" checked={distinguishControl}
                      onChange={(event) => setDistinguishControl(event.target.checked)} /> {t("Distinguish left and right Ctrl")}</label>
                  </div>}
                </div>}
              </div>;
            })}
          </div>
        </>
      )}
          </div>
          {((!isPanelMode(page) && page !== "sortGroups") || selection) && <SettingsPreview page={isPanelMode(page) || page === "sortGroups" ? "general" : page} preferences={preferences} pick={selection ?? undefined} />}
        </div>
      </div>
    </Dialog>
    {settingsArchive && <SettingsArchiveDialog action={settingsArchive} preferences={saved}
      onImport={applyImport} onClose={() => setSettingsArchive(null)} />}
    {archiveError && <Dialog title={t("Could not import settings")} onClose={() => setArchiveError("")} footer={
      <Button type="button" data-initial-focus onClick={() => setArchiveError("")}>{t("Close")}</Button>
    }>
      <div className="dialog-body"><p role="alert">{archiveError}</p></div>
    </Dialog>}
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
        <Button type="button" className="alert-confirm" onClick={() => {
          onChange({ ...preferences, activeShortcutScheme: null, shortcutSchemes: shortcutSchemes.filter(({ id }) => id !== activeScheme.id) });
          setSchemeDialog(null);
          requestAnimationFrame(() => schemeSelect.current?.focus());
        }}>{t("Delete scheme")}</Button>
      </>}>
      <div className="dialog-body"><p>{t("Delete the shortcut scheme {0}?", activeScheme.name)}</p></div>
    </Dialog>}
    {capture && conflict && <Dialog title={t("Shortcut conflict")} tone="warning" onClose={() => setConflict(null)} footer={<>
      <Button type="button" data-initial-focus onClick={() => setConflict(null)}>{t("Choose another shortcut")}</Button>
        <Button type="button" className="alert-confirm" onClick={() => saveShortcut(conflict.key, capture)}>{t("Reassign shortcut")}</Button>
    </>}>
      <div className="dialog-body">
        <p>{t("{0} is assigned to {1}.", showShortcut(conflict.key), new Intl.ListFormat(locale()).format(conflict.owners.map(commandLabel)))}</p>
        <p>{t("Move this shortcut to {0}?", commandLabel(capture.command))}</p>
      </div>
    </Dialog>}
  </SettingsSearchTerms>;
}
