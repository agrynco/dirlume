import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { api, describeError } from "./api";
import { errorText, t } from "./i18n";

interface MenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
}

export type MenuGroup = { label: string; items: MenuItem[] };
export type MainMenuHandle = { open: () => void };

export function MainMenu({ groups, shortcut, ref }: {
  groups: MenuGroup[];
  shortcut: string;
  ref: Ref<MainMenuHandle>;
}) {
  const bar = useRef<HTMLElement>(null);
  const priorFocus = useRef<HTMLElement | null>(null);
  const [active, setActive] = useState(0);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [cursor, setCursor] = useState(0);

  function close(restore: boolean) {
    setExpanded(null);
    if (restore) {
      if (priorFocus.current?.isConnected) priorFocus.current.focus();
      else if (bar.current?.contains(document.activeElement) && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    }
  }

  function open(index: number, item = 0) {
    setActive(index);
    setExpanded(index);
    setCursor(item);
  }

  useImperativeHandle(ref, () => ({
    open: () => {
      if (expanded === null) open(active);
      else close(true);
    },
  }), [active, expanded]);

  useLayoutEffect(() => {
    if (expanded !== null) bar.current?.querySelector<HTMLElement>(`[data-menu-item="${cursor}"]`)?.focus();
  }, [expanded, cursor]);

  useLayoutEffect(() => {
    const menu = bar.current?.querySelector<HTMLElement>(".main-menu-dropdown");
    if (!menu) return;
    const place = () => {
      menu.style.insetInlineStart = "0px";
      const bounds = menu.getBoundingClientRect();
      menu.style.maxHeight = `${Math.max(0, window.innerHeight - bounds.top - 8)}px`;
      menu.style.insetInlineStart = `${Math.min(0, window.innerWidth - bounds.right - 8)}px`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [expanded]);

  useEffect(() => {
    if (expanded === null) return;
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !bar.current?.contains(event.target)) setExpanded(null);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded]);

  function keyDown(event: KeyboardEvent<HTMLElement>) {
    const { key } = event;
    const inDropdown = (event.target as HTMLElement).closest('[role="menu"]') !== null;
    if (key === "Escape") {
      close(true);
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      const index = (active + groups.length + (key === "ArrowRight" ? 1 : -1)) % groups.length;
      if (expanded !== null) open(index);
      else bar.current?.querySelector<HTMLElement>(`[data-menu-group="${index}"]`)?.focus();
    } else if (key === "ArrowUp" || key === "ArrowDown" || key === "Home" || key === "End") {
      const count = groups[active].items.length;
      const last = key === "ArrowUp" || key === "End";
      if (inDropdown) setCursor(key === "Home" ? 0 : key === "End" ? count - 1 : (cursor + count + (last ? -1 : 1)) % count);
      else open(active, last ? count - 1 : 0);
    } else if (inDropdown && (key === "Enter" || key === " ")) {
      event.stopPropagation();
      return;
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <nav ref={bar} className="main-menu" role="menubar" aria-label={t("Main menu")}
      onFocusCapture={(event) => {
        const from = event.relatedTarget;
        if (from instanceof HTMLElement && !event.currentTarget.contains(from)) priorFocus.current = from;
      }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(null); }}
      onKeyDown={keyDown}>
      {groups.map(({ label, items }, index) => {
        const shown = expanded === index;
        return <div key={label} className="main-menu-group" role="none">
          <Button type="button" role="menuitem" data-menu-group={index} tabIndex={active === index ? 0 : -1}
            shortcut={shortcut} aria-haspopup="menu" aria-expanded={shown} onFocus={() => setActive(index)}
            onClick={() => { if (shown) close(true); else open(index); }}>{t(label)}</Button>
          {shown && <div className="main-menu-dropdown" role="menu" aria-label={t(label)}>
            {items.map(({ label, shortcut, disabled, run }, item) => (
              <Button key={label} type="button" role="menuitem" tabIndex={-1} data-menu-item={item}
                aria-disabled={disabled || undefined} shortcut={shortcut}
                onFocus={() => setCursor(item)} onClick={() => {
                  if (disabled) return;
                  close(true);
                  run();
                }}>
                <span>{t(label)}</span>{shortcut && <kbd aria-hidden="true">{shortcut}</kbd>}
              </Button>
            ))}
          </div>}
        </div>;
      })}
    </nav>
  );
}

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const [version, setVersion] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let open = true;
    void api.buildVersion().then(
      (value) => { if (open) setVersion(value); },
      (failure: unknown) => { if (open) setError(describeError(failure)); },
    );
    return () => { open = false; };
  }, []);
  return <Dialog title={t("About")} onClose={onClose}>
    <div className="dialog-body about-body">
      <strong>Dirlume</strong>
      {version ? <p>{t("Version")} <code>{version}</code></p> :
        error ? <p role="alert" className="dialog-error">{errorText(error)}</p> : <p role="status">{t("Reading version…")}</p>}
    </div>
    <footer className="dialog-footer"><Button data-initial-focus type="button" onClick={onClose}>{t("Close")}</Button></footer>
  </Dialog>;
}
