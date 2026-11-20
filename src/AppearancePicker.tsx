import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { isTauri } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { pickLabel, readAppearancePick, resolvePick, type AppearancePick } from "./appearancePick";
import { reportFrontendError } from "./diagnostics";
import { t } from "./i18n";

const modeEvent = "dirlume:appearance-picker";
const resultEvent = "dirlume:appearance-pick-result";

export async function pickFromDesktop(): Promise<AppearancePick | null> {
  let finish: (value: AppearancePick | null) => void = () => {};
  const result = new Promise<AppearancePick | null>((resolve) => { finish = resolve; });
  const unlisten = await listen<unknown>(resultEvent, ({ payload }) => finish(readAppearancePick(payload)));
  try {
    await emit(modeEvent, true);
    await api.setAppearancePicker(true);
    return await result;
  } catch (error) {
    await emit(modeEvent, false).catch(() => {});
    throw error;
  } finally {
    unlisten();
  }
}

export function NativeAppearancePicker() {
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    const listener = listen<boolean>(modeEvent, ({ payload }) => {
      if (active) setPicking(payload === true);
    });
    void listener.catch((error: unknown) => reportFrontendError("appearance_picker", error));
    return () => {
      active = false;
      void listener.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);
  if (!picking) return null;
  return <AppearancePicker onFinish={(pick) => {
    setPicking(false);
    void emit(modeEvent, false).then(() => api.setAppearancePicker(false))
      .then(() => emitTo("options", resultEvent, pick))
      .catch((error: unknown) => {
        reportFrontendError("appearance_picker", error);
        void emitTo("options", resultEvent, null).catch(() => {});
      });
  }} />;
}

export function AppearancePicker({ onFinish }: { onFinish: (pick: AppearancePick | null) => void }) {
  const [hover, setHover] = useState<{ rect: DOMRect; label: string } | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [dialog, setDialog] = useState<Element | null>(null);
  useLayoutEffect(() => {
    const activeDialog = () => [...document.querySelectorAll("dialog[open]")].at(-1) ?? null;
    setDialog(activeDialog());
    function target(event: MouseEvent) {
      const element = document.elementFromPoint(event.clientX, event.clientY);
      if (element instanceof HTMLDialogElement) {
        const rect = element.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return null;
      }
      return element ? resolvePick(element) : null;
    }
    function stop(event: Event) { event.preventDefault(); event.stopImmediatePropagation(); }
    function move(event: PointerEvent) {
      const hit = target(event);
      setHover(hit ? { rect: hit.element.getBoundingClientRect(), label: pickLabel(hit.pick) } : null);
      setDialog(activeDialog());
      event.stopImmediatePropagation();
    }
    function click(event: MouseEvent) {
      stop(event);
      const hit = target(event);
      if (hit) onFinish(hit.pick);
      else setUnsupported(true);
    }
    function key(event: KeyboardEvent) {
      stop(event);
      if (event.key === "Escape") onFinish(null);
    }
    const blocked = ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "contextmenu"];
    blocked.forEach((event) => window.addEventListener(event, stop, true));
    window.addEventListener("pointermove", move, true);
    window.addEventListener("click", click, true);
    window.addEventListener("keydown", key, true);
    return () => {
      blocked.forEach((event) => window.removeEventListener(event, stop, true));
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("click", click, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [onFinish]);

  return createPortal(<div className="appearance-picker" data-appearance-picker>
    {hover && <div className="appearance-picker-outline" style={{
      left: hover.rect.left, top: hover.rect.top, width: hover.rect.width, height: hover.rect.height,
    }} aria-hidden="true" />}
    <p role="status">{unsupported ? t("No appearance settings here. Pick another element or press Esc.")
      : t("Click an element to find its appearance settings. Press Esc to cancel.")}</p>
    {hover && <span className="appearance-picker-target" aria-hidden="true">{hover.label}</span>}
  </div>, dialog ?? document.body);
}
