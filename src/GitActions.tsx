import { createContext, useContext, useEffect, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "./Button";
import { FileContextMenu } from "./FileContextMenu";
import { t } from "./i18n";
import { bindingMatches, eventShortcut } from "./preferences";

export type GitAction = {
  label: string;
  icon: LucideIcon;
  run: () => void;
  tooltip?: string;
  disabled?: boolean;
  pressed?: boolean;
  destructive?: boolean;
  submit?: boolean;
};

export function GitActionButtons({ actions }: { actions: readonly GitAction[] }) {
  return actions.map(({ label, icon: Icon, tooltip, run, disabled, pressed, destructive, submit }) =>
    <Button key={label} type={submit ? "submit" : "button"} className={destructive ? "git-action negative" : "git-action"}
      tooltip={t(tooltip ?? label)} data-tooltip-on-focus="true" data-tooltip-always="true"
      disabled={disabled} aria-pressed={pressed} onClick={submit ? undefined : run}>
      <Icon aria-hidden="true" />{t(label)}
    </Button>);
}

type Menu = {
  anchor: HTMLElement;
  x: number;
  y: number;
  target?: string;
  actions: readonly GitAction[];
};

const GitMenu = createContext<{ shortcut: readonly string[]; open: (menu: Menu) => void } | null>(null);

export function GitActionMenuProvider({ children, shortcut, revision }: {
  children: ReactNode;
  shortcut: readonly string[];
  revision: number;
}) {
  const [menu, setMenu] = useState<Menu>();
  useEffect(() => { setMenu(undefined); }, [revision]);
  function dismiss() { setMenu(undefined); }
  function returnFocus() { if (menu?.anchor.isConnected) menu.anchor.focus({ preventScroll: true }); }

  const ordinary = menu?.actions.filter((action) => !action.destructive) ?? [];
  const destructive = menu?.actions.filter((action) => action.destructive) ?? [];
  return <GitMenu.Provider value={{ shortcut, open: setMenu }}>
    {children}
    {menu && <FileContextMenu x={menu.x} y={menu.y} label={menu.target ? t("Git actions for {0}", menu.target) : "Git actions"} helpTopic="gitView"
      container={menu.anchor.closest("dialog") ?? undefined} onClose={dismiss} onReturn={returnFocus}>
      {menu.target && <div className="process-menu-heading" role="presentation"><strong>{menu.target}</strong></div>}
      {[...ordinary, ...destructive].map(({ label, icon: Icon, disabled, pressed, run, destructive }, index) =>
        <div key={label} role="presentation">
          {index === ordinary.length && ordinary.length > 0 && <div role="separator" className="main-menu-separator" />}
          <Button type="button" role={pressed === undefined ? "menuitem" : "menuitemcheckbox"} aria-checked={pressed}
            disabled={disabled} className={destructive ? "negative" : undefined}
            onClick={() => { dismiss(); returnFocus(); run(); }}>
            <Icon aria-hidden="true" />{t(label)}
          </Button>
        </div>)}
    </FileContextMenu>}
  </GitMenu.Provider>;
}

export function useGitMenu() {
  const menu = useContext(GitMenu);
  return (actions: readonly GitAction[], target?: string) => {
    function actionTarget(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) {
      return actions.length > 0 && !event.defaultPrevented && event.target instanceof Element &&
        !event.target.closest("input, textarea, select, [contenteditable=true]") ? event.target : null;
    }
    function open(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, point?: { x: number; y: number }) {
      const element = actionTarget(event);
      if (!menu || !element) return;
      event.preventDefault();
      event.stopPropagation();
      const focusable = element.closest<HTMLElement>("button, [tabindex]");
      const anchor = focusable && event.currentTarget.contains(focusable) ? focusable : event.currentTarget;
      const bounds = anchor.getBoundingClientRect();
      menu.open({ anchor, x: point?.x ?? bounds.left + 8, y: point?.y ?? bounds.bottom, target, actions });
    }
    return {
      onMouseDown(event: MouseEvent<HTMLElement>) {
        // Keep the toolbar and rows in place until the secondary-click target is known.
        if (actionTarget(event) && (event.button === 2 || event.button === 0 && event.ctrlKey && /Mac/i.test(navigator.userAgent))) {
          event.preventDefault();
        }
      },
      onContextMenu(event: MouseEvent<HTMLElement>) {
        // Chromium also emits this event for its built-in Shift+F10 binding.
        if (event.button < 0 && actionTarget(event)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        open(event, { x: event.clientX, y: event.clientY });
      },
      onKeyDown(event: KeyboardEvent<HTMLElement>) {
        if (!menu || event.key !== "ContextMenu" && !bindingMatches(menu.shortcut, eventShortcut(event))) return;
        open(event);
      },
    };
  };
}
