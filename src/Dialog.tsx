import { t } from "./i18n";
import { Button } from "./Button";
import { useId, useLayoutEffect, useRef, useState, type KeyboardEventHandler, type ReactNode } from "react";
import { X } from "lucide-react";
import { ResizeMarker, WindowResizeMarker } from "./ResizeGrip";
import type { HelpTopic } from "./helpTopics";

type Dimensions = { width: number; height: number };
const sizePrefix = "dirlume.dialog-size.";
const resizeEdges = ["n", "ne", "e", "s", "sw", "w", "nw"] as const;
const dialogActions = ".dialog-footer, .dialog-actions, .dialog-action-strip";
const actionButton = "button:not([role]), button[role='button']";

const moveActionFocus: KeyboardEventHandler<HTMLDialogElement> = (event) => {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 :
    event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : 0;
  if (!direction || !(event.target instanceof Element)) return;

  const current = event.target.closest<HTMLButtonElement>(actionButton);
  const actions = current?.closest(dialogActions);
  if (!current || !actions || actions.closest("dialog") !== event.currentTarget) return;

  const buttons = Array.from(actions.querySelectorAll<HTMLButtonElement>(actionButton)).filter((button) =>
    button.closest(dialogActions) === actions && button.closest("dialog") === event.currentTarget &&
    button.tabIndex >= 0 && !button.closest(":disabled, [aria-disabled='true'], [hidden], [inert]") &&
    button.getClientRects().length > 0 && getComputedStyle(button).visibility === "visible");
  const index = buttons.indexOf(current);
  if (index < 0 || buttons.length < 2) return;

  event.preventDefault();
  event.stopPropagation();
  buttons[index + direction]?.focus();
};

export function readDialogSize(key: string | undefined): Dimensions | undefined {
  if (!key) return;
  try {
    const value = JSON.parse(localStorage.getItem(sizePrefix + key) ?? "null") as Dimensions | null;
    if (value && Number.isFinite(value.width) && Number.isFinite(value.height) && value.width > 0 && value.height > 0) return value;
  } catch { /* Use the default size. */ }
}

export function saveDialogSize(key: string, size: Dimensions) {
  try { localStorage.setItem(sizePrefix + key, JSON.stringify(size)); } catch { /* The current size still applies. */ }
}

export function Dialog({ title, children, footer, onClose, onKeyDown, onKeyDownCapture,
  wide = false, resizeKey, dismissOnOutside = false, standalone = false, modeless = false, suspended = false, tone, font, fontZoom, helpTopic, contextHelp = false }: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
  onKeyDown?: KeyboardEventHandler<HTMLDialogElement>;
  onKeyDownCapture?: KeyboardEventHandler<HTMLDialogElement>;
  wide?: boolean;
  resizeKey?: string;
  standalone?: boolean;
  modeless?: boolean;
  suspended?: boolean;
  dismissOnOutside?: boolean;
  tone?: "warning";
  font?: "options";
  fontZoom?: "compare" | "none";
  helpTopic?: HelpTopic;
  contextHelp?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [size, setSize] = useState(() => readDialogSize(resizeKey));
  const drag = useRef<(Dimensions & { x: number; y: number; horizontal: number; vertical: number }) | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const moving = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    const focused = document.activeElement;
    const container = contextHelp ? focused?.closest<HTMLElement>("dialog, [data-pane-side], .text-window, .terminal-card") : null;
    return () => {
      dialog?.close();
      if (!contextHelp) {
        if (focused instanceof HTMLElement && focused.isConnected) focused.focus();
        return;
      }
      const afterClose = document.activeElement;
      requestAnimationFrame(() => {
        if (document.querySelector("dialog[data-context-help]")) return;
        const opener = focused instanceof HTMLElement && focused.isConnected && focused.getClientRects().length &&
          !focused.closest("[inert], [hidden], :disabled") ? focused : null;
        const scope = container?.isConnected ? container : null;
        const fallback = opener ? null : scope?.querySelector<HTMLElement>("[data-help-return]");
        const active = document.activeElement;
        if (!fallback && active !== afterClose && active !== document.body && active?.isConnected) return;
        const target = opener ?? fallback ?? scope?.querySelector<HTMLElement>("[tabindex=\"0\"], button:enabled");
        target?.focus({ preventScroll: true });
      });
    };
  }, [contextHelp]);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (suspended) dialog.close();
    else if (!dialog.open) {
      if (modeless) dialog.show();
      else dialog.showModal();
      dialog.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    }
  }, [suspended, modeless]);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!modeless || !dialog) return;
    const keepOnScreen = () => {
      const { width, height } = dialog.getBoundingClientRect();
      setPosition((current) => current && {
        left: Math.max(0, Math.min(current.left, innerWidth - width)),
        top: Math.max(0, Math.min(current.top, innerHeight - height)),
      });
    };
    window.addEventListener("resize", keepOnScreen);
    const observer = new ResizeObserver(keepOnScreen);
    observer.observe(dialog);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", keepOnScreen);
    };
  }, [modeless]);

  function resize(width: number, height: number, persist = false) {
    const next = {
      width: Math.min(window.innerWidth - 36, Math.max(500, width)),
      height: Math.min(window.innerHeight - 42, Math.max(350, height)),
    };
    setSize(next);
    if (persist && resizeKey) saveDialogSize(resizeKey, next);
  }

  function finishResize() {
    if (!drag.current) return;
    drag.current = null;
    const bounds = ref.current?.getBoundingClientRect();
    if (bounds) resize(bounds.width, bounds.height, true);
  }

  return (
    <dialog ref={ref} className={"dialog" + (wide ? " dialog-wide" : "") + (resizeKey ? " dialog-resizable" : "") + (standalone ? " dialog-window" : "") + (modeless ? " dialog-modeless" : "")}
      style={{ ...size, ...position }} data-tone={tone} data-font={font} data-font-zoom={fontZoom ?? font ?? "dialog"}
      data-help-topic={helpTopic} data-context-help={contextHelp || undefined} aria-labelledby={heading} onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest("dialog") !== event.currentTarget) return;
        onKeyDown?.(event);
        moveActionFocus(event);
        if (modeless && event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          onClose?.();
        }
      }}
      onKeyDownCapture={(event) => {
        if ((event.target as HTMLElement).closest("dialog") === event.currentTarget) onKeyDownCapture?.(event);
      }}
      onPointerDown={(event) => {
        if (dismissOnOutside && event.button === 0 && event.target === event.currentTarget) {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (event.clientX < bounds.left || event.clientX > bounds.right ||
              event.clientY < bounds.top || event.clientY > bounds.bottom) {
            event.preventDefault();
            onClose?.();
          }
        }
        if (event.button !== 0 || !(event.target instanceof HTMLElement)) return;
        if (modeless && event.target.closest(".dialog-heading") && !event.target.closest("button")) {
          event.preventDefault();
          const { left, top } = event.currentTarget.getBoundingClientRect();
          moving.current = { x: event.clientX, y: event.clientY, left, top };
          event.currentTarget.setPointerCapture(event.pointerId);
          return;
        }
        if (!resizeKey) return;
        const handle = event.target.closest<HTMLElement>("[data-resize-edge]");
        if (handle?.closest("dialog") !== event.currentTarget) return;
        event.preventDefault();
        const edge = handle.dataset.resizeEdge ?? "";
        const { width, height } = event.currentTarget.getBoundingClientRect();
        drag.current = {
          width, height, x: event.clientX, y: event.clientY,
          horizontal: Number(edge.includes("e")) - Number(edge.includes("w")),
          vertical: Number(edge.includes("s")) - Number(edge.includes("n")),
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const move = moving.current;
        if (move) {
          const { width, height } = event.currentTarget.getBoundingClientRect();
          setPosition({
            left: Math.max(0, Math.min(innerWidth - width, move.left + event.clientX - move.x)),
            top: Math.max(0, Math.min(innerHeight - height, move.top + event.clientY - move.y)),
          });
          return;
        }
        const start = drag.current;
        if (!start) return;
        // The dialog stays centered, so each edge moves by half of its size change.
        resize(start.width + 2 * start.horizontal * (event.clientX - start.x),
          start.height + 2 * start.vertical * (event.clientY - start.y));
      }}
      onLostPointerCapture={() => { moving.current = null; finishResize(); }}
      onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose?.(); }}>
      <header className="dialog-heading">
        <h2 id={heading}>{title}</h2>
        {onClose && !standalone && <Button type="button" className="icon-button" aria-label={t("Close dialog")} onClick={onClose}><X /></Button>}
      </header>
      {children}
      {footer && <footer className="dialog-footer">{footer}</footer>}
      {resizeKey && <ResizeMarker edge="se" />}
      {standalone && <WindowResizeMarker />}
      {resizeKey && resizeEdges.map((edge) =>
        <div key={edge} className="dialog-resize-edge" data-resize-edge={edge} aria-hidden="true" />)}
    </dialog>
  );
}
