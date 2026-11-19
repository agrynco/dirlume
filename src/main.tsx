import { createRoot } from "react-dom/client";
import App from "./App";
import { installDiagnosticListeners, reportFrontendError } from "./diagnostics";
import { setLanguage } from "./i18n";
import { readPreferences } from "./preferences";
import "./styles.css";

installDiagnosticListeners();
const preferences = readPreferences();
setLanguage(preferences.language);
createRoot(document.getElementById("root")!, {
  onCaughtError: (error) => reportFrontendError("react_render", error),
  onRecoverableError: (error) => reportFrontendError("react_render", error),
}).render(<App initialPreferences={preferences} />);
