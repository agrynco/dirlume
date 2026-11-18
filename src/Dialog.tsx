import { Button } from "./Button";
import { useId, useLayoutEffect, useRef, useState, type KeyboardEventHandler, type ReactNode } from "react";
import { X } from "lucide-react";

type Dimensions = { width: number; height: number };
const sizePrefix = "dirlume.dialog-size.";

function readSize(key: string | undefined): Dimensions | undefined {
  if (!key) return;
  try {
    const value = JSON.parse(localStorage.getItem(sizePrefix + key) ?? "null") as Dimensions | null;
    if (value && Number.isFinite(value.width) && Number.isFinite(value.height) && value.width > 0 && value.height > 0) return value;
  } catch { /* Use the default size. */ }
}

export function Dialog({ title, children, onClose, onKeyDown, wide = false, resizeKey }: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onKeyDown?: KeyboardEventHandler<HTMLDialogElement>;
  wide?: boolean;
  resizeKey?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [size, setSize] = useState(() => readSize(resizeKey));
  const drag = useRef<(Dimensions & { x: number; y: number }) | null>(null);
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
    if (persist && resizeKey) {
      try { localStorage.setItem(sizePrefix + resizeKey, JSON.stringify(next)); } catch { /* The current size still applies. */ }
    }
  }

  function finishResize() {
    if (!drag.current) return;
    drag.current = null;
    const bounds = ref.current?.getBoundingClientRect();
    if (bounds) resize(bounds.width, bounds.height, true);
  }

  return (
    <dialog ref={ref} className={"dialog" + (wide ? " dialog-wide" : "") + (resizeKey ? " dialog-resizable" : "")}
      style={size} aria-labelledby={heading} onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest("dialog") === event.currentTarget) onKeyDown?.(event);
      }}
      onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }}>
      <header className="dialog-heading">
        <h2 id={heading}>{title}</h2>
        <Button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}><X /></Button>
      </header>
      {children}
      {resizeKey && <Button type="button" className="dialog-resize-grip" aria-label={"Resize " + title}
        title={"Resize " + title + " (drag or use arrow keys)"}
        onPointerDown={(event) => {
          if (event.button !== 0 || !ref.current) return;
          const { width, height } = ref.current.getBoundingClientRect();
          drag.current = { width, height, x: event.clientX, y: event.clientY };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          // The dialog stays centered, so its corner moves by half of each size change.
          resize(start.width + 2 * (event.clientX - start.x), start.height + 2 * (event.clientY - start.y));
        }}
        onLostPointerCapture={finishResize}
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
