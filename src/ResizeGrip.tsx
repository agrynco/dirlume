import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { reportFrontendError } from "./diagnostics";

type ResizeMarkerProps = Pick<ComponentPropsWithoutRef<"div">, "onPointerDown" | "onPointerMove" | "onLostPointerCapture"> & {
  edge?: "se";
};

export function ResizeMarker({ edge, ...pointerEvents }: ResizeMarkerProps) {
  return <div className="window-resize-marker" data-resize-edge={edge} aria-hidden="true" {...pointerEvents} />;
}

export function WindowResizeMarker() {
  const [canResize, setCanResize] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; width: number; height: number } | null>(null);
  const pendingSize = useRef<LogicalSize | undefined>(undefined);
  const resizing = useRef(false);
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
  const macOS = /Macintosh/.test(navigator.userAgent);
  async function resize() {
    resizing.current = true;
    try {
      while (pendingSize.current) {
        const size = pendingSize.current;
        pendingSize.current = undefined;
        await handle.setSize(size);
      }
    } catch (error) {
      pendingSize.current = undefined;
      reportFrontendError("window_control", error);
    } finally {
      resizing.current = false;
    }
  }
  return <ResizeMarker onPointerDown={(event) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    if (!macOS) {
      void handle.startResizeDragging("SouthEast").catch((error: unknown) => reportFrontendError("window_control", error));
      return;
    }
    // Tao does not implement native resize dragging on macOS.
    drag.current = { id: event.pointerId, x: event.screenX, y: event.screenY, width: innerWidth, height: innerHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
  }} onPointerMove={(event) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    pendingSize.current = new LogicalSize(
      Math.max(1, start.width + event.screenX - start.x),
      Math.max(1, start.height + event.screenY - start.y),
    );
    if (!resizing.current) void resize();
  }} onLostPointerCapture={() => { drag.current = null; }} />;
}
