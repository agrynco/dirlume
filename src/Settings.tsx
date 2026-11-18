import { Button } from "./Button";
import { useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, Delete, RotateCcw, Search } from "lucide-react";
import { Dialog } from "./Dialog";
import { AppearanceSettings, type AppearanceSection } from "./AppearanceSettings";
import { SettingsPreview } from "./SettingsPreview";
import { colorGroups, fontGroups } from "./appearance";
import { windowsClient } from "./api";
import {
  commandNames, commands, commandScope, defaultBindings, eventShortcut, showShortcut,
  type Command, type Preferences, type Provider,
} from "./preferences";

type Page = AppearanceSection | "general" | "shortcuts";
const appearancePages = [
  ...Object.entries(colorGroups).map(([id, group]) => ({
    id: id as AppearanceSection, label: group.label, terms: Object.values(group.colors).join(" "),
  })),
  { id: "fonts" as const, label: "Fonts", terms: Object.values(fontGroups).map(({ label }) => label).join(" ") + " family size installed" },
];

export function Settings({ preferences: saved, onChange: applyPreferences, onClose }: {
  preferences: Preferences;
  onChange: (value: Preferences) => void;
  onClose: () => void;
}) {
  const [page, setPage] = useState<Page>("general");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(true);
  const [preferences, onChange] = useState(saved);
  const [capture, setCapture] = useState<Command | null>(null);
  const [conflict, setConflict] = useState("");
  const hasChanges = JSON.stringify(preferences) !== JSON.stringify(saved);
  const searching = Boolean(query.trim());
  const terms = query.trim().toLowerCase().split(/\s+/);
  const matches = (text: string) => terms.every((term) => text.toLowerCase().includes(term));
  const showGeneral = matches("General Show hidden files Remote connection Dirlume server KSwitcher installation folder");
  const appearanceMatches = appearancePages.filter(({ label, terms }) => matches(`Appearance Color scheme ${label} ${terms}`));
  const allShortcuts = matches("Keyboard shortcuts keymap bindings");
  const visibleCommands = allShortcuts ? commandNames : commandNames.filter((command) =>
    matches(`${commands[command].label} ${preferences.shortcuts[command]} ${showShortcut(preferences.shortcuts[command])}`));
  const showShortcuts = allShortcuts || visibleCommands.length > 0;
  const isAppearance = page !== "general" && page !== "shortcuts";
  const title = isAppearance ? appearancePages.find(({ id }) => id === page)?.label : page === "general" ? "General" : "Keyboard shortcuts";

  function select(page: Page) {
    setPage(page);
    setCapture(null);
    setConflict("");
  }

  function apply() {
    if (hasChanges) applyPreferences(preferences);
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
      setConflict(`${showShortcut(shortcut)} is assigned to ${commands[existing].label}.`);
      return;
    }
    onChange({ ...preferences, shortcuts: { ...preferences.shortcuts, [command]: shortcut } });
    setCapture(null);
    setConflict("");
  }

  return (
    <Dialog title="Options" onClose={onClose} wide>
      <div className="settings-layout">
        <aside className="settings-sidebar">
          <label className="settings-search"><Search aria-hidden="true" />
            <input type="search" aria-label="Search settings" placeholder="Search settings" value={query}
              data-initial-focus onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !searching) return;
                event.preventDefault();
                if (showGeneral) select("general");
                else if (appearanceMatches.length) select(appearanceMatches[0].id);
                else if (showShortcuts) select("shortcuts");
              }} />
          </label>
          <nav className="settings-tree" aria-label="Options sections">
            {showGeneral && <Button type="button" aria-pressed={page === "general"} onClick={() => select("general")}>General</Button>}
            {appearanceMatches.length > 0 && (
              <>
                <Button type="button" aria-expanded={expanded || searching} aria-controls="options-appearance-pages"
                  onClick={() => {
                    if (!isAppearance) { select("panels"); setExpanded(true); }
                    else setExpanded(!expanded);
                  }}>
                  {expanded || searching ? <ChevronDown /> : <ChevronRight />} Appearance
                </Button>
                <div id="options-appearance-pages" className="settings-tree-branch" hidden={!expanded && !searching}>
                  {appearanceMatches.map(({ id, label }) => (
                    <Button key={id} type="button" aria-pressed={page === id} onClick={() => select(id)}>{label}</Button>
                  ))}
                </div>
              </>
            )}
            {showShortcuts && <Button type="button" aria-pressed={page === "shortcuts"} onClick={() => select("shortcuts")}>Keyboard shortcuts</Button>}
            {!showGeneral && !appearanceMatches.length && !showShortcuts && <p role="status">No settings match.</p>}
          </nav>
        </aside>
        <div className="settings-main">
          <header className="settings-page-heading">
            {isAppearance && <><span>Appearance</span><ChevronRight aria-hidden="true" /></>}
            <h3>{title}</h3>
          </header>
          <div className="settings-page-body">
      {page === "general" ? (
        <div className="dialog-body settings-general">
          <label className="setting"><span>Show hidden files</span>
            <input type="checkbox" checked={preferences.hidden} onChange={(event) => onChange({ ...preferences, hidden: event.target.checked })} />
          </label>
          <label className="setting"><span>Remote connection</span>
            <select value={preferences.provider} onChange={(event) => onChange({ ...preferences, provider: event.target.value as Provider })}>
              <option value="server">Dirlume server</option>
              <option value="kswitcher" disabled={!windowsClient}>KSwitcher (Windows)</option>
            </select>
          </label>
          {preferences.provider === "kswitcher" && (
            <label className="field">KSwitcher installation folder
              <input type="text" spellCheck={false} autoComplete="off" value={preferences.kswitcher}
                onChange={(event) => onChange({ ...preferences, kswitcher: event.target.value })} />
            </label>
          )}
        </div>
      ) : isAppearance ? (
        <AppearanceSettings section={page} preferences={preferences} onChange={onChange} />
      ) : (
        <>
          <div className="shortcut-list">
            {visibleCommands.map((command) => (
              <div key={command} className="shortcut-setting">
                <span>{commands[command].label}</span>
                {capture === command ? (
                  <input aria-label={`New shortcut for ${commands[command].label}`} readOnly autoFocus
                    placeholder="Press a shortcut" onKeyDown={(event) => assign(event, command)}
                    onBlur={() => { setCapture(null); setConflict(""); }} />
                ) : (
                  <Button type="button" className="shortcut-key" aria-label={`Change shortcut for ${commands[command].label}`}
                    onClick={() => { setCapture(command); setConflict(""); }}>
                    {showShortcut(preferences.shortcuts[command]) || "Unassigned"}
                  </Button>
                )}
                <Button type="button" className="icon-button" aria-label={`Clear shortcut for ${commands[command].label}`}
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
            <RotateCcw /> Restore defaults
          </Button>
        )}
        <Button type="button" disabled={!hasChanges} onClick={apply}>Apply</Button>
        <Button type="button" className="primary" onClick={() => { apply(); onClose(); }}>Done</Button>
      </footer>
    </Dialog>
  );
}
