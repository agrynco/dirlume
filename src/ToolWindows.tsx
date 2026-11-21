import { useEffect, useLayoutEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitTo } from "@tauri-apps/api/event";
import { applyAppearance, isLightTheme, resolveAppearance, useSystemTheme } from "./appearance";
import { reportFrontendError } from "./diagnostics";
import { saveDialogSize } from "./Dialog";
import { HelpDialog } from "./HelpDialog";
import { useHelpShortcut } from "./contextHelp";
import { setLanguage, t } from "./i18n";
import { persistPreferences, preferenceKey, readPreferences, shortcutBindings, type Preferences } from "./preferences";
import { Settings } from "./Settings";
import type { FeaturePage } from "./featureOptions";
import { CompareDialog } from "./TextTools";
import { pickFromDesktop } from "./AppearancePicker";
import { windowsClient, type NamedFile } from "./api";

export function ToolWindow({ initialPreferences, comparison, optionsPage }: {
  initialPreferences: Preferences;
  comparison?: { left: NamedFile; right: NamedFile };
  optionsPage?: FeaturePage;
}) {
  const [preferences, setPreferences] = useState(initialPreferences);
  const shortcuts = shortcutBindings(preferences);
  const [help, setHelp] = useHelpShortcut(shortcuts.help, comparison ? "compare" : "general");
  const { scheme, theme } = resolveAppearance(preferences, useSystemTheme());
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
    // Forcing a native Windows theme also overrides the system color query in WebView2.
    if (!windowsClient) void windowHandle.setTheme(isLightTheme(theme) ? "light" : "dark").catch(() => {});
    void windowHandle.setTitle(title).catch(() => {});
  }, [theme, title]);

  useEffect(() => {
    const window = getCurrentWindow();
    void window.show().then(() => window.setFocus()).catch((error: unknown) => {
      reportFrontendError("show_tool_window", error, "native_error");
    });
  }, []);

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
  return <>
    {comparison ? <CompareDialog {...comparison} standalone
      previousShortcut={shortcuts.previousChange} nextShortcut={shortcuts.nextChange}
      onDirtyChange={(dirty) => { void reportDirty(dirty).catch(() => {}); }} onClose={close} /> :
      <Settings standalone initialPage={optionsPage} preferences={preferences} onClose={close} onPick={pickFromDesktop} onChange={(draft) => {
      const next = readPreferences();
      for (const key of Object.keys(draft) as (keyof Preferences)[]) {
        if (JSON.stringify(draft[key]) !== JSON.stringify(preferences[key])) Object.assign(next, { [key]: draft[key] });
      }
      persistPreferences(next);
      setLanguage(next.language);
      setPreferences(next);
      return next;
    }} />}
    {help && <HelpDialog initialTopic={help} language={preferences.language} onClose={() => setHelp(null)} />}
  </>;
}
