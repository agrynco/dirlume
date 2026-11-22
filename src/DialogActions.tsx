import { ArrowDown, ArrowUp, ChevronDown, Trash2 } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type ComponentPropsWithRef, type ReactNode } from "react";
import { Button } from "./Button";
import { helpIsOpen } from "./contextHelp";

export function DialogIconButton({ label, className, children, ...props }:
  Omit<ComponentPropsWithRef<typeof Button>, "aria-label" | "type"> & { label: string }) {
  return <Button {...props} type="button" aria-label={label} className={`dialog-icon-button${className ? ` ${className}` : ""}`}>
    <span aria-hidden="true">{children}</span>
  </Button>;
}

export function RowOrderActions({ up, down, remove, first, last, onMove, onRemove }: {
  up: string; down: string; remove: string; first: boolean; last: boolean;
  onMove: (offset: number) => void; onRemove: () => void;
}) {
  return <div className="dialog-action-group">
    <DialogIconButton label={up} disabled={first} onClick={() => onMove(-1)}><ArrowUp /></DialogIconButton>
    <DialogIconButton label={down} disabled={last} onClick={() => onMove(1)}><ArrowDown /></DialogIconButton>
    <DialogIconButton label={remove} onClick={onRemove}><Trash2 /></DialogIconButton>
  </div>;
}

type MenuAction = { label: string; run: () => void; disabled?: boolean };

export function DialogDisclosure({ label, actions, children, className }: {
  label: string; actions?: readonly MenuAction[]; children?: ReactNode; className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  function dismiss() {
    trigger.current?.focus({ preventScroll: true });
    setOpen(false);
  }

  useLayoutEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("button:enabled, input:enabled, select:enabled")?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!helpIsOpen() && event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  return <div ref={root} className={`dialog-disclosure${className ? ` ${className}` : ""}`}
    onBlur={(event) => {
      if (!helpIsOpen() && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}
    onKeyDown={(event) => {
      if (!open || event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      } else if (actions && ["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        const items = [...(panel.current?.querySelectorAll<HTMLButtonElement>("button:enabled") ?? [])];
        if (!items.length) return;
        event.preventDefault();
        event.stopPropagation();
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
          current < 0 ? (event.key === "ArrowUp" ? items.length - 1 : 0) :
            (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}>
    <Button ref={trigger} type="button" id={`${id}-trigger`} aria-haspopup={actions ? "menu" : undefined}
      aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}
      onKeyDown={(event) => {
        if (open || !actions || event.key !== "ArrowDown") return;
        event.preventDefault();
        setOpen(true);
      }}>{label}<ChevronDown aria-hidden="true" /></Button>
    <div ref={panel} id={id} className="dialog-disclosure-panel" role={actions ? "menu" : "group"}
      aria-labelledby={`${id}-trigger`} hidden={!open}>
      {actions?.map(({ label, disabled, run }) => <Button key={label} type="button" role="menuitem" tabIndex={-1} disabled={disabled}
        onClick={() => { dismiss(); run(); }}>{label}</Button>)}
      {children}
    </div>
  </div>;
}
