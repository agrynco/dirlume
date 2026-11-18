import { createRoot } from "react-dom/client";
import App from "./App";
import { setLanguage } from "./i18n";
import { readPreferences } from "./preferences";
import "./styles.css";

const preferences = readPreferences();
setLanguage(preferences.language);
createRoot(document.getElementById("root")!).render(<App initialPreferences={preferences} />);
