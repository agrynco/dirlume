import { t } from "./i18n";
import { Button } from "./Button";
import { useId, useLayoutEffect, useRef, useState, type KeyboardEventHandler, type ReactNode } from "react";
import { X } from "lucide-react";

type Dimensions = { width: number; height: number };
const sizePrefix = "dirlume.dialog-size.";
const resizeEdges = ["n", "ne", "e", "s", "sw", "w", "nw"] as const;

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

export function Dialog({ title, children, onClose, onKeyDown, wide = false, resizeKey, standalone = false, dismissOnOutside = false }: {
  title: string;
  children: ReactNode;
  onClose?: () => void;
  onKeyDown?: KeyboardEventHandler<HTMLDialogElement>;
  wide?: boolean;
  resizeKey?: string;
  standalone?: boolean;
  dismissOnOutside?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [size, setSize] = useState(() => readDialogSize(resizeKey));
  const drag = useRef<(Dimensions & { x: number; y: number; horizontal: number; vertical: number }) | null>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    const focused = document.activeElement;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    return () => {
      dialog?.close();
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus();
    };
  }, []);

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
    <dialog ref={ref} className={"dialog" + (wide ? " dialog-wide" : "") + (resizeKey ? " dialog-resizable" : "") + (standalone ? " dialog-window" : "")}
      style={size} aria-labelledby={heading} onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest("dialog") === event.currentTarget) onKeyDown?.(event);
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
        if (!resizeKey || event.button !== 0 || !(event.target instanceof HTMLElement)) return;
        const handle = event.target.closest<HTMLElement>("[data-resize-edge]");
        if (handle?.closest("dialog") !== event.currentTarget) return;
        event.preventDefault();
        if (handle instanceof HTMLButtonElement) handle.focus({ preventScroll: true });
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
        const start = drag.current;
        if (!start || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        // The dialog stays centered, so each edge moves by half of its size change.
        resize(start.width + 2 * start.horizontal * (event.clientX - start.x),
          start.height + 2 * start.vertical * (event.clientY - start.y));
      }}
      onLostPointerCapture={finishResize}
      onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose?.(); }}>
      <header className="dialog-heading">
        <h2 id={heading}>{title}</h2>
        {onClose && !standalone && <Button type="button" className="icon-button" aria-label={t("Close dialog")} onClick={onClose}><X /></Button>}
      </header>
      {children}
      {resizeKey && resizeEdges.map((edge) =>
        <div key={edge} className="dialog-resize-edge" data-resize-edge={edge} aria-hidden="true" />)}
      {resizeKey && <Button type="button" className="dialog-resize-grip" aria-label={t("Resize {0}", title)}
        title={t("Resize {0} (drag or use arrow keys)", title)}
        data-resize-edge="se"
        onKeyDown={(event) => {
          const bounds = ref.current?.getBoundingClientRect();
          if (!bounds || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          const w = event.key === "ArrowRight" ? 16 : event.key === "ArrowLeft" ? -16 : 0;
          const h = event.key === "ArrowDown" ? 16 : event.key === "ArrowUp" ? -16 : 0;
          resize(bounds.width + w, bounds.height + h, true);
        }} />}
    </dialog>
  );
}
