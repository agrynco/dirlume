import { useEffect, type RefObject } from "react";
import { wheelShortcut } from "./preferences";
import { viewFonts, type ViewFont, type ZoomViewFont } from "./viewFonts";

const pixelsPerStep = 60;

export function useFontZoom(ref: RefObject<HTMLElement | null>, binding: string, view: ViewFont, onZoom: ZoomViewFont) {
  useEffect(() => {
    const element = ref.current;
    if (!element || !binding) return;
    let pending = 0;
    let lastWheel = 0;

    const zoom = (event: WheelEvent) => {
      if (!event.deltaY || wheelShortcut(event) !== binding ||
        (event.target instanceof Element && event.target.closest("dialog"))) return;
      event.preventDefault();

      const direction = Math.sign(event.deltaY);
      if (event.timeStamp - lastWheel > 200 || Math.sign(pending) !== direction) pending = 0;
      lastWheel = event.timeStamp;
      // Accumulate small trackpad deltas, with one step for a wheel notch.
      pending += event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? event.deltaY : direction * pixelsPerStep;
      if (Math.abs(pending) < pixelsPerStep) return;
      pending = 0;
      const base = parseFloat(getComputedStyle(element).getPropertyValue(viewFonts[view].size));
      if (Number.isFinite(base)) onZoom(view, -direction, base);
    };

    element.addEventListener("wheel", zoom, { passive: false });
    return () => element.removeEventListener("wheel", zoom);
  }, [ref, binding, view, onZoom]);
}
