import { useId, useLayoutEffect, useRef, type KeyboardEventHandler, type ReactNode } from "react";
import { X } from "lucide-react";

export function Dialog({ title, children, onClose, onKeyDown, wide = false }: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onKeyDown?: KeyboardEventHandler<HTMLDialogElement>;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
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

  return (
    <dialog ref={ref} className={wide ? "dialog dialog-wide" : "dialog"} aria-labelledby={heading} onKeyDown={onKeyDown}
      onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <header className="dialog-heading">
        <h2 id={heading}>{title}</h2>
        <button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}><X /></button>
      </header>
      {children}
    </dialog>
  );
}
