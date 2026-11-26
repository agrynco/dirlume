import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { ToolWindow } from "./ToolWindows";
import { NativeAppearancePicker } from "./AppearancePicker";
import { api, type NamedFile, windowsClient } from "./api";
import { installDiagnosticListeners, reportReactError } from "./diagnostics";
import { setLanguage } from "./i18n";
import { readDiagramWindow } from "./diagramWindow";
import { isFeaturePage } from "./featureOptions";
import { normalizePreferences, readPreferences, restorePortablePreferences, trackControlKeys } from "./preferences";
import { installTooltips } from "./tooltips";
import "./styles.css";

installDiagnosticListeners();
trackControlKeys();
installTooltips();
const label = isTauri() ? getCurrentWindow().label : "main";
const tool = window as Window & {
  __dirlumeComparison?: { left: NamedFile; right: NamedFile };
  __dirlumeOptionsPage?: string;
};
const comparison = tool.__dirlumeComparison;
const optionsPage = tool.__dirlumeOptionsPage;
const diagram = readDiagramWindow();
const windowsStartup = windowsClient && isTauri() && !diagram ? api.windowsStartup().catch(() => null) : Promise.resolve(null);
void windowsStartup.then(async (startup) => {
  const portable = diagram ? undefined : await restorePortablePreferences(label === "main", startup?.handoff);
  const preferences = startup?.workspace ? normalizePreferences(startup.workspace.preferences) : readPreferences();
  setLanguage(preferences.language);
  createRoot(document.getElementById("root")!, {
    onCaughtError: reportReactError,
    onRecoverableError: reportReactError,
    onUncaughtError: reportReactError,
  }).render(<>
    {label === "options" || comparison || diagram ? <ToolWindow initialPreferences={preferences} comparison={comparison} diagram={diagram}
      optionsPage={optionsPage && isFeaturePage(optionsPage) ? optionsPage : undefined} /> :
      <App initialPreferences={preferences} portableUpdateError={portable?.updateError} portableSettingsError={portable?.settingsError}
        administrator={startup?.administrator} administratorWorkspace={startup?.workspace} administratorWorkspaceUnavailable={startup?.workspaceUnavailable} />}
    {label !== "options" && !diagram && isTauri() && <NativeAppearancePicker />}
  </>);
});
