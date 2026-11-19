import { useEffect, useState, type PointerEventHandler } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { MoveDiagonal2 } from "lucide-react";
import { Button } from "./Button";
import { reportFrontendError } from "./diagnostics";
import { t } from "./i18n";

export function ResizeGrip({ title, edge, onPointerDown, onResize }: {
  title: string;
  edge?: "se";
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
  onResize: (widthDelta: number, heightDelta: number) => void;
}) {
  return <Button type="button" className="window-resize-grip" aria-label={t("Resize {0}", title)}
    tooltip={t("Resize {0} (drag or use arrow keys)", title)} data-tooltip-placement="above"
    data-resize-edge={edge} onPointerDown={onPointerDown} onKeyDown={(event) => {
      const width = event.key === "ArrowRight" ? 16 : event.key === "ArrowLeft" ? -16 : 0;
      const height = event.key === "ArrowDown" ? 16 : event.key === "ArrowUp" ? -16 : 0;
      if (!width && !height) return;
      event.preventDefault();
      event.stopPropagation();
      onResize(width, height);
    }}><MoveDiagonal2 aria-hidden="true" /></Button>;
}

export function WindowResizeGrip({ title }: { title: string }) {
  const [canResize, setCanResize] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    const handle = getCurrentWindow();
    let active = true;
    let revision = 0;
    let frame = 0;
    const sync = () => {
      if (!active) return;
      const requested = ++revision;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        void Promise.all([handle.isResizable(), handle.isMaximized(), handle.isFullscreen()])
          .then(([resizable, maximized, fullscreen]) => {
            if (active && requested === revision) setCanResize(resizable && !maximized && !fullscreen);
          }).catch((error: unknown) => reportFrontendError("window_state", error));
      });
    };
    const resize = handle.onResized(sync);
    void resize.then(sync).catch((error: unknown) => reportFrontendError("window_state", error));
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      void resize.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  if (!canResize) return null;
  const handle = getCurrentWindow();
  return <ResizeGrip title={title} onPointerDown={(event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    void handle.startResizeDragging("SouthEast").catch((error: unknown) => reportFrontendError("window_control", error));
  }} onResize={(width, height) => {
    void Promise.all([handle.innerSize(), handle.scaleFactor()]).then(([size, scale]) =>
      handle.setSize(new LogicalSize(size.width / scale + width, size.height / scale + height)))
      .catch((error: unknown) => reportFrontendError("window_control", error));
  }} />;
}
