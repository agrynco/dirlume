import { useEffect, useEffectEvent, useLayoutEffect } from "react";
import { wheelShortcut } from "./preferences";
import { sharedViewFonts, viewFonts, type ViewFont, type ViewFontSizes, type ZoomViewFont } from "./viewFonts";

const pixelsPerStep = 60;

export function useFontZoom(bindings: readonly string[], sizes: ViewFontSizes, onZoom: ZoomViewFont) {
  const resize = useEffectEvent(onZoom);
  useLayoutEffect(() => {
    const style = document.documentElement.style;
    for (const view of sharedViewFonts) {
      const size = sizes[view];
      if (size === undefined) style.removeProperty(`--font-zoom-${view}`);
      else style.setProperty(`--font-zoom-${view}`, `${size}px`);
    }
  }, [sizes]);
  useEffect(() => {
    if (!bindings.length) return;
    let pending = 0;
    let lastWheel = 0;
    let previousArea: Element | null = null;

    const zoom = (event: WheelEvent) => {
      if (!event.deltaY || event.defaultPrevented || !bindings.includes(wheelShortcut(event)) || !(event.target instanceof Element)) return;
      const area = event.target.closest<HTMLElement>("[data-font-zoom]");
      const view = area?.dataset.fontZoom as ViewFont | undefined;
      if (!view || !Object.hasOwn(viewFonts, view) || !area) return;
      event.preventDefault();
      event.stopPropagation();

      const direction = Math.sign(event.deltaY);
      if (area !== previousArea || event.timeStamp - lastWheel > 200 || Math.sign(pending) !== direction) pending = 0;
      lastWheel = event.timeStamp;
      previousArea = area;
      // Accumulate small trackpad deltas, with one step for a wheel notch.
      pending += event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? event.deltaY : direction * pixelsPerStep;
      if (Math.abs(pending) < pixelsPerStep) return;
      pending = 0;
      const base = parseFloat(getComputedStyle(area).getPropertyValue(`--${viewFonts[view].group}-size`));
      if (Number.isFinite(base)) resize(view, -direction, base);
    };

    document.addEventListener("wheel", zoom, { capture: true, passive: false });
    return () => document.removeEventListener("wheel", zoom, true);
  }, [bindings]);
}
