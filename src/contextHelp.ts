import { useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { helpTopics, type HelpTopic } from "./helpTopics";
import type { Side } from "./panes";
import { bindingMatches, eventShortcut } from "./preferences";

type HelpTarget = { topic: HelpTopic; side?: Side };
const topicSelector = "[data-help-topic]";

export function topicForControl(target: EventTarget | null, fallback: HelpTopic): HelpTopic {
  const topic = target instanceof Element ? target.closest<HTMLElement>(topicSelector)?.dataset.helpTopic : undefined;
  return topic && Object.hasOwn(helpTopics, topic) ? topic as HelpTopic : fallback;
}

export function helpIsOpen() {
  return document.querySelector("dialog[data-context-help]") !== null;
}

export function useHelpShortcut(bindings: readonly string[], fallback: HelpTopic) {
  const [request, setRequest] = useState<HelpTarget | null>(null);
  const pointer = useRef<Element | null>(null);
  const open = useEffectEvent((focus: Element | null) => {
    const dialog = focus?.closest("dialog:modal") ?? [...document.querySelectorAll("dialog:modal")].at(-1);
    const hovered = pointer.current;
    const target = hovered?.isConnected && (!dialog || dialog.contains(hovered)) ? hovered :
      dialog && !dialog.contains(focus) ? dialog : focus;
    const topic = topicForControl(target, fallback);
    const pane = target?.closest<HTMLElement>("[data-help-side], [data-pane-side]");
    const side = pane?.dataset.helpSide ?? pane?.dataset.paneSide;
    setRequest((current) => current ?? { topic, side: side === "left" || side === "right" ? side : undefined });
  });

  useLayoutEffect(() => {
    if (!bindings.length) return;
    function onPointerMove(event: PointerEvent) {
      if (event.pointerType === "mouse" || event.pointerType === "pen") {
        pointer.current = event.target instanceof Element ? event.target : null;
      }
    }
    function onFocus() { pointer.current = null; }
    function onKeyDown(event: KeyboardEvent) {
      if (!bindingMatches(bindings, eventShortcut(event))) {
        if (event.key !== "Alt" && event.key !== "Control" && event.key !== "Meta" && event.key !== "Shift") pointer.current = null;
        return;
      }
      if (event.defaultPrevented || event.isComposing ||
          event.target instanceof Element && event.target.closest("[data-shortcut-capture]")) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) open(document.activeElement);
    }
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [bindings]);

  return [request, (topic: HelpTopic | null) => setRequest(topic ? { topic } : null)] as const;
}
