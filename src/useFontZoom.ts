import { useEffect, useState, type CSSProperties, type RefObject } from "react";
import { wheelShortcut } from "./preferences";

const pixelsPerStep = 60;

export function useFontZoom(ref: RefObject<HTMLElement | null>, binding: string) {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element || !binding) return;
    let pending = 0;
    let lastWheel = 0;

    function zoom(event: WheelEvent) {
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
      setLevel((current) => Math.min(12, Math.max(-3, current - direction)));
    }

    element.addEventListener("wheel", zoom, { passive: false });
    return () => element.removeEventListener("wheel", zoom);
  }, [ref, binding]);

  const scale = 1 + level / 12;
  return { scale, style: { "--font-scale": scale } as CSSProperties };
}
