import { useState, type KeyboardEvent } from "react";
import { Delete, RotateCcw } from "lucide-react";
import { Dialog } from "./Dialog";
import { windowsClient } from "./api";
import {
  commandNames, commands, defaultBindings, eventShortcut, showShortcut,
  type Command, type Preferences, type Provider, type Theme,
} from "./preferences";

export function Settings({ preferences, onChange, onClose }: {
  preferences: Preferences;
  onChange: (value: Preferences) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"general" | "shortcuts">("general");
  const [capture, setCapture] = useState<Command | null>(null);
  const [conflict, setConflict] = useState("");

  function assign(event: KeyboardEvent, command: Command) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") return setCapture(null);
    const shortcut = eventShortcut(event);
    if (!shortcut) return;
    const existing = commandNames.find((item) => item !== command && preferences.shortcuts[item] === shortcut);
    if (existing) {
      setConflict(`${showShortcut(shortcut)} is assigned to ${commands[existing].label}.`);
      return;
    }
    onChange({ ...preferences, shortcuts: { ...preferences.shortcuts, [command]: shortcut } });
    setCapture(null);
    setConflict("");
  }

  return (
    <Dialog title="Options" onClose={onClose}>
      <nav className="dialog-tabs" aria-label="Options sections">
        <button type="button" aria-pressed={tab === "general"} onClick={() => setTab("general")}>General</button>
        <button type="button" aria-pressed={tab === "shortcuts"} onClick={() => setTab("shortcuts")}>Keyboard shortcuts</button>
      </nav>
      {tab === "general" ? (
        <div className="dialog-body settings-general">
          <label className="setting"><span>Color scheme</span>
            <select value={preferences.theme} onChange={(event) => onChange({ ...preferences, theme: event.target.value as Theme })}>
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="slate">Slate</option>
            </select>
          </label>
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
      ) : (
        <>
          <div className="shortcut-list">
            {commandNames.map((command) => (
              <div key={command} className="shortcut-setting">
                <span>{commands[command].label}</span>
                {capture === command ? (
                  <input aria-label={`New shortcut for ${commands[command].label}`} readOnly autoFocus
                    placeholder="Press a shortcut" onKeyDown={(event) => assign(event, command)}
                    onBlur={() => { setCapture(null); setConflict(""); }} />
                ) : (
                  <button type="button" className="shortcut-key" aria-label={`Change shortcut for ${commands[command].label}`}
                    onClick={() => { setCapture(command); setConflict(""); }}>
                    {showShortcut(preferences.shortcuts[command]) || "Unassigned"}
                  </button>
                )}
                <button type="button" className="icon-button" aria-label={`Clear shortcut for ${commands[command].label}`}
                  disabled={!preferences.shortcuts[command]}
                  onClick={() => onChange({ ...preferences, shortcuts: { ...preferences.shortcuts, [command]: "" } })}>
                  <Delete />
                </button>
              </div>
            ))}
          </div>
          {conflict && <p className="dialog-error" role="alert">{conflict}</p>}
        </>
      )}
      <footer className="dialog-footer">
        {tab === "shortcuts" && (
          <button type="button" onClick={() => { onChange({ ...preferences, shortcuts: defaultBindings }); setCapture(null); setConflict(""); }}>
            <RotateCcw /> Restore defaults
          </button>
        )}
        <button type="button" className="primary" onClick={onClose}>Done</button>
      </footer>
    </Dialog>
  );
}
