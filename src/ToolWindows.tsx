import { useEffect, useLayoutEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitTo } from "@tauri-apps/api/event";
import { applyAppearance } from "./appearance";
import { saveDialogSize } from "./Dialog";
import { HelpDialog } from "./HelpDialog";
import { setLanguage, t } from "./i18n";
import { eventShortcut, persistPreferences, preferenceKey, readPreferences, type Preferences } from "./preferences";
import { Settings } from "./Settings";
import { CompareDialog } from "./TextTools";
import type { NamedFile } from "./api";

export function ToolWindow({ initialPreferences, comparison }: {
  initialPreferences: Preferences;
  comparison?: { left: NamedFile; right: NamedFile };
}) {
  const [preferences, setPreferences] = useState(initialPreferences);
  const [help, setHelp] = useState(false);
  const scheme = preferences.schemes.find(({ id }) => id === preferences.activeScheme) ?? null;
  const theme = scheme?.base ?? preferences.theme;
  const title = t(comparison ? "Compare files" : "Options");
  const windowHandle = getCurrentWindow();

  useLayoutEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => applyAppearance(theme, scheme);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme, scheme]);

  useEffect(() => {
    void windowHandle.setTheme(theme === "system" ? null : theme === "light" ? "light" : "dark").catch(() => {});
    void windowHandle.setTitle(title).catch(() => {});
  }, [theme, title]);

  useEffect(() => {
    if (!comparison) {
      const saveSize = () => {
        void windowHandle.isMaximized().then((maximized) => {
          if (!maximized && innerWidth >= 600 && innerHeight >= 380) {
            saveDialogSize("options", { width: innerWidth, height: innerHeight });
          }
        }).catch(() => {});
      };
      window.addEventListener("resize", saveSize);
      return () => window.removeEventListener("resize", saveSize);
    }
    const sync = (event: StorageEvent) => {
      if (event.key !== preferenceKey) return;
      const next = readPreferences();
      setLanguage(next.language);
      setPreferences(next);
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [comparison]);

  const reportDirty = (dirty: boolean) => emitTo("main", "dirlume:comparison-dirty", { label: windowHandle.label, dirty });
  const close = () => {
    if (comparison) void reportDirty(false).finally(() => windowHandle.destroy()).catch(() => {});
    else void windowHandle.close();
  };
  if (comparison) return <CompareDialog {...comparison} standalone
    previousShortcut={preferences.shortcuts.previousChange} nextShortcut={preferences.shortcuts.nextChange}
    onDirtyChange={(dirty) => { void reportDirty(dirty).catch(() => {}); }} onClose={close} />;

  return <div onKeyDownCapture={(event) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || eventShortcut(event) !== preferences.shortcuts.help ||
        !preferences.shortcuts.help || (event.target instanceof Element && event.target.closest("[data-shortcut-capture]"))) return;
    event.preventDefault();
    setHelp(true);
  }}>
    <Settings standalone preferences={preferences} onClose={close} onChange={(draft) => {
      const next = readPreferences();
      for (const key of Object.keys(draft) as (keyof Preferences)[]) {
        if (JSON.stringify(draft[key]) !== JSON.stringify(preferences[key])) Object.assign(next, { [key]: draft[key] });
      }
      persistPreferences(next);
      setLanguage(next.language);
      setPreferences(next);
      return next;
    }} />
    {help && <HelpDialog initialTopic="general" language={preferences.language} onClose={() => setHelp(false)} />}
  </div>;
}
