import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { ToolWindow } from "./ToolWindows";
import type { NamedFile } from "./api";
import { installDiagnosticListeners, reportFrontendError } from "./diagnostics";
import { setLanguage } from "./i18n";
import { readPreferences } from "./preferences";
import { installTooltips } from "./tooltips";
import "./styles.css";

installDiagnosticListeners();
installTooltips();
const preferences = readPreferences();
setLanguage(preferences.language);
const label = isTauri() ? getCurrentWindow().label : "main";
const comparison = (window as Window & { __dirlumeComparison?: { left: NamedFile; right: NamedFile } }).__dirlumeComparison;
createRoot(document.getElementById("root")!, {
  onCaughtError: (error) => reportFrontendError("react_render", error),
  onRecoverableError: (error) => reportFrontendError("react_render", error),
}).render(label === "options" || comparison ? <ToolWindow initialPreferences={preferences} comparison={comparison} /> :
  <App initialPreferences={preferences} />);
