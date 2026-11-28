import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { helpIsOpen } from "./contextHelp";
import type { HelpTopic } from "./helpTopics";
import { t } from "./i18n";

export function FileContextMenu({ x, y, label = "File actions", helpTopic = "operations", container = document.body, className, onClose, onReturn, children }: {
  label?: string;
  helpTopic?: HelpTopic;
  container?: HTMLElement;
  className?: string;
  x: number; y: number; onClose: () => void; onReturn: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4))}px`;
    (menu.querySelector<HTMLButtonElement>("button:enabled") ?? menu).focus({ preventScroll: true });
  }, [x, y]);

  useEffect(() => {
    function dismiss() { close.current(); }
    function outside(event: PointerEvent) {
      if (!helpIsOpen() && event.target instanceof Node && !ref.current?.contains(event.target)) dismiss();
    }
    window.addEventListener("pointerdown", outside);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, []);

  return createPortal(<div ref={ref} className={"file-column-menu" + (className ? " " + className : "")} role="menu" tabIndex={-1} data-help-topic={helpTopic} aria-label={t(label)}
    onContextMenu={(event) => event.preventDefault()}
    onBlur={(event) => { if (!helpIsOpen() && !event.currentTarget.contains(event.relatedTarget)) onClose(); }}
    onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        onReturn();
        return;
      }
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:enabled")];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
        (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    }}>{children}</div>, container);
}
