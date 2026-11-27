import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitTo } from "@tauri-apps/api/event";
import { applyAppearance, isLightTheme, resolveAppearance, useSystemTheme } from "./appearance";
import { reportFrontendError } from "./diagnostics";
import { saveDialogSize } from "./Dialog";
import { useHelpShortcut } from "./contextHelp";
import { setLanguage, t } from "./i18n";
import { acceptWindowsPreferences, persistPreferences, preferenceKey, readPreferences, shortcutBindings, type Preferences } from "./preferences";
import { Settings } from "./Settings";
import type { FeaturePage } from "./featureOptions";
import { CompareDialog } from "./TextTools";
import { pickFromDesktop } from "./AppearancePicker";
import { windowsClient, type NamedFile } from "./api";
import { useFontZoom } from "./useFontZoom";
import { resizeViewFont } from "./viewFonts";
import { DiagramViewer } from "./MermaidDiagram";
import type { DiagramWindowData } from "./diagramWindow";

const HelpDialog = lazy(() => import("./HelpDialog"));

export function ToolWindow({ initialPreferences, comparison, diagram, optionsPage }: {
  initialPreferences: Preferences;
  comparison?: { left: NamedFile; right: NamedFile };
  diagram?: DiagramWindowData;
  optionsPage?: FeaturePage;
}) {
  const [preferences, setPreferences] = useState(initialPreferences);
  const latest = useRef(preferences);
  latest.current = preferences;
  const shortcuts = shortcutBindings(preferences);
  useFontZoom(shortcuts.zoomFont, preferences.viewFontSizes, (view, change, base) => {
    const current = latest.current;
    const sizes = resizeViewFont(current.viewFontSizes, view, change, base);
    if (sizes === current.viewFontSizes) return;
    const next = { ...current, viewFontSizes: sizes };
    latest.current = next;
    setPreferences(next);
    void persistPreferences(next).catch((error: unknown) => {
      reportFrontendError("save_preferences", error);
    });
  });
  const [help, setHelp] = useHelpShortcut(shortcuts.help, diagram ? "viewer" : comparison ? "compare" : "general");
  const { scheme, theme } = resolveAppearance(preferences, useSystemTheme());
  const title = t(diagram ? "Mermaid diagram" : comparison ? "Compare files" : "Options");
  const windowHandle = isTauri() ? getCurrentWindow() : null;

  useLayoutEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => applyAppearance(theme, scheme, document.documentElement, preferences.retainedFonts);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme, scheme, preferences.retainedFonts]);

  useEffect(() => {
    // Forcing a native Windows theme also overrides the system color query in WebView2.
    if (!windowsClient) void windowHandle?.setTheme(isLightTheme(theme) ? "light" : "dark").catch(() => {});
    document.title = title;
    void windowHandle?.setTitle(title).catch(() => {});
  }, [theme, title]);

  useEffect(() => {
    if (!isTauri()) return;
    const window = getCurrentWindow();
    void window.show().then(() => window.setFocus()).catch((error: unknown) => {
      reportFrontendError("show_tool_window", error, "native_error");
    });
  }, []);

  useEffect(() => {
    const saveSize = () => {
      void windowHandle?.isMaximized().then((maximized) => {
        if (!maximized && innerWidth >= 600 && innerHeight >= 380) {
          saveDialogSize("options", { width: innerWidth, height: innerHeight });
        }
      }).catch(() => {});
    };
    if (!comparison && !diagram) {
      window.addEventListener("resize", saveSize);
    }
    const sync = (event: StorageEvent) => {
      if (event.key !== preferenceKey) return;
      const next = readPreferences();
      acceptWindowsPreferences(next);
      setLanguage(next.language);
      setPreferences(next);
    };
    window.addEventListener("storage", sync);
    return () => {
      if (!comparison && !diagram) window.removeEventListener("resize", saveSize);
      window.removeEventListener("storage", sync);
    };
  }, [comparison, diagram]);

  const reportDirty = (dirty: boolean) => emitTo("main", "dirlume:comparison-dirty", { label: windowHandle?.label, dirty });
  const close = () => {
    if (comparison) void reportDirty(false).finally(() => windowHandle?.destroy()).catch(() => {});
    else if (windowHandle) void windowHandle.close();
    else window.close();
  };
  return <>
    {diagram ? <DiagramViewer diagram={diagram} shortcuts={shortcuts} onClose={close} /> :
      comparison ? <CompareDialog {...comparison} standalone
      previousShortcut={shortcuts.previousChange} nextShortcut={shortcuts.nextChange} swapShortcut={shortcuts.swap}
      onDirtyChange={(dirty) => { void reportDirty(dirty).catch(() => {}); }} onClose={close} /> :
      <Settings standalone initialPage={optionsPage} preferences={preferences} onClose={close} onPick={pickFromDesktop} onChange={async (draft) => {
      const next = readPreferences();
      for (const key of Object.keys(draft) as (keyof Preferences)[]) {
        if (JSON.stringify(draft[key]) !== JSON.stringify(preferences[key])) Object.assign(next, { [key]: draft[key] });
      }
      await persistPreferences(next);
      setLanguage(next.language);
      setPreferences(next);
      return next;
    }} />}
    {help && <Suspense fallback={null}>
      <HelpDialog initialTopic={help.topic} side={help.side} language={preferences.language}
        searchShortcuts={shortcuts.searchHelp} onClose={() => setHelp(null)} />
    </Suspense>}
  </>;
}
