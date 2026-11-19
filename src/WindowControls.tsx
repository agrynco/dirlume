import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X, Copy } from "lucide-react";
import { Button } from "./Button";
import { reportFrontendError } from "./diagnostics";
import { t } from "./i18n";

export function WindowControls() {
  const window = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const window = getCurrentWindow();
    let active = true;
    const sync = () => {
      void window.isMaximized().then((value) => {
        if (active) setMaximized(value);
      }).catch((error: unknown) => reportFrontendError("window_state", error));
    };
    const resize = window.onResized(sync);
    sync();
    return () => {
      active = false;
      void resize.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  const run = (action: Promise<void>) => {
    void action.catch((error: unknown) => reportFrontendError("window_control", error));
  };
  return <div className="window-controls" aria-label={t("Window controls")} role="group" data-tauri-drag-region="false">
    <Button type="button" aria-label={t("Minimize window")} onClick={() => run(window.minimize())}><Minus /></Button>
    <Button type="button" aria-label={t(maximized ? "Restore window" : "Maximize window")} onClick={() => run(window.toggleMaximize())}>
      {maximized ? <Copy /> : <Square />}
    </Button>
    <Button type="button" className="window-close" aria-label={t("Close window")} onClick={() => run(window.close())}><X /></Button>
  </div>;
}
