import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { Button } from "./Button";
import { helpIsOpen } from "./contextHelp";
import type { HelpTopic } from "./helpTopics";
import { t } from "./i18n";

function menuItems(menu: HTMLDivElement) {
  return [...menu.querySelectorAll<HTMLButtonElement>("button:enabled")]
    .filter((button) => button.closest('[role="menu"]') === menu);
}

function moveMenuFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  const items = menuItems(event.currentTarget);
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
    (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
  items[next]?.focus();
}

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
    function position(element: HTMLDivElement) {
      element.style.left = `${Math.max(4, Math.min(x, window.innerWidth - element.offsetWidth - 4))}px`;
      element.style.top = `${Math.max(4, Math.min(y, window.innerHeight - element.offsetHeight - 4))}px`;
    }
    position(menu);
    (menuItems(menu)[0] ?? menu).focus({ preventScroll: true });
    const observer = new ResizeObserver(() => position(menu));
    observer.observe(menu);
    return () => observer.disconnect();
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
      moveMenuFocus(event);
    }}>{children}</div>, container);
}

export function FileContextSubmenu({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const submenu = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef(false);

  useLayoutEffect(() => {
    const menu = submenu.current;
    if (!open || !menu || !trigger.current) return;
    const bounds = trigger.current.getBoundingClientRect();
    const x = bounds.right + menu.offsetWidth <= innerWidth - 4 ? bounds.right - 1 : bounds.left - menu.offsetWidth + 1;
    menu.style.left = `${Math.max(4, x)}px`;
    menu.style.top = `${Math.max(4, Math.min(bounds.top, innerHeight - menu.offsetHeight - 4))}px`;
    if (focusOnOpen.current) (menuItems(menu)[0] ?? menu).focus({ preventScroll: true });
    focusOnOpen.current = false;
  }, [open]);

  function openAndFocus() {
    const menu = submenu.current;
    if (menu) (menuItems(menu)[0] ?? menu).focus({ preventScroll: true });
    else {
      focusOnOpen.current = true;
      setOpen(true);
    }
  }

  return <div role="none" onPointerLeave={() => {
    if (!submenu.current?.contains(document.activeElement)) setOpen(false);
  }} onBlur={(event) => {
    if (!helpIsOpen() && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <Button ref={trigger} className="file-submenu-trigger" role="menuitem" aria-haspopup="menu" aria-expanded={open}
      onPointerEnter={(event) => { if (event.pointerType === "mouse") setOpen(true); }}
      onClick={openAndFocus} onKeyDown={(event) => {
        if (event.key !== "ArrowRight") return;
        event.preventDefault();
        event.stopPropagation();
        openAndFocus();
      }}>{icon}{label}<ChevronRight aria-hidden="true" /></Button>
    {open && <div ref={submenu} className="file-column-menu file-menu-submenu" role="menu" aria-label={label} tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          trigger.current?.focus({ preventScroll: true });
          setOpen(false);
        } else moveMenuFocus(event);
      }}>{children}</div>}
  </div>;
}
