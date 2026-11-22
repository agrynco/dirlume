import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { Button } from "./Button";
import { helpIsOpen } from "./contextHelp";
import { t } from "./i18n";

export type ColumnMenuAnchor = { x: number; y: number; trigger: HTMLElement | null };
type ColumnChoice = { key: string; label: string; checked: boolean; disabled?: boolean; toggle: () => void };

export function columnMenuBindings<T extends HTMLElement>(open: (header: T, anchor: ColumnMenuAnchor) => void) {
  const trigger = (event: MouseEvent<T> | KeyboardEvent<T>) =>
    event.target instanceof Element ? event.target.closest<HTMLElement>("button, [tabindex]") : null;
  return {
    onContextMenu(event: MouseEvent<T>) {
      event.preventDefault();
      event.stopPropagation();
      open(event.currentTarget, { x: event.clientX, y: event.clientY, trigger: trigger(event) });
    },
    onKeyDown(event: KeyboardEvent<T>) {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      event.stopPropagation();
      const target = trigger(event);
      const bounds = (target ?? event.currentTarget).getBoundingClientRect();
      open(event.currentTarget, { x: bounds.left, y: bounds.bottom, trigger: target });
    },
  };
}

export function ColumnMenu({ anchor, choices, fallback, onClose }: {
  anchor: ColumnMenuAnchor;
  choices: ColumnChoice[];
  fallback: () => HTMLElement | null | undefined;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    element.style.left = `${Math.max(6, Math.min(anchor.x, window.innerWidth - element.offsetWidth - 6))}px`;
    element.style.top = `${Math.max(6, Math.min(anchor.y, window.innerHeight - element.offsetHeight - 6))}px`;
    element.querySelector<HTMLButtonElement>("button:enabled")?.focus({ preventScroll: true });
  }, [anchor]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!helpIsOpen() && event.target instanceof Node && !menu.current?.contains(event.target)) onClose();
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div className="file-column-menu" ref={menu} role="menu" data-help-topic="paneColumns" aria-label={t("Columns")}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onBlur={(event) => { if (!helpIsOpen() && !event.currentTarget.contains(event.relatedTarget)) onClose(); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          (anchor.trigger?.isConnected && anchor.trigger.getClientRects().length ? anchor.trigger : fallback())?.focus({ preventScroll: true });
          onClose();
          return;
        }
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:enabled")];
        const index = options.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 :
          (index + (event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length;
        options[next]?.focus();
      }}>
      {choices.map(({ key, label, checked, disabled, toggle }) =>
        <Button type="button" key={key} role="menuitemcheckbox" aria-checked={checked} disabled={disabled} onClick={toggle}>
          <span className="file-column-check" aria-hidden="true">{checked && <Check />}</span>{t(label)}
        </Button>)}
    </div>, document.body);
}
