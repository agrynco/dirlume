import { useEffectEvent, useLayoutEffect, useState } from "react";
import { helpTopics, type HelpTopic } from "./helpContent";
import { bindingMatches, eventShortcut } from "./preferences";

export function topicForControl(target: EventTarget | null, fallback: HelpTopic): HelpTopic {
  const topic = target instanceof Element ? target.closest<HTMLElement>("[data-help-topic]")?.dataset.helpTopic : undefined;
  return topic && Object.hasOwn(helpTopics, topic) ? topic as HelpTopic : fallback;
}

export function useHelpShortcut(bindings: readonly string[], fallback: HelpTopic) {
  const [topic, setTopic] = useState<HelpTopic | null>(null);
  const open = useEffectEvent((target: EventTarget | null) => {
    const topic = topicForControl(target, fallback);
    setTopic((current) => current ?? topic);
  });

  useLayoutEffect(() => {
    if (!bindings.length) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || !bindingMatches(bindings, eventShortcut(event)) ||
          event.target instanceof Element && event.target.closest("[data-shortcut-capture]")) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) open(event.target);
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [bindings]);

  return [topic, setTopic] as const;
}
