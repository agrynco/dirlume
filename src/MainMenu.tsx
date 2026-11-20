import { Fragment, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { BookOpen, Bug, ChevronRight, CodeXml, Coffee, Package, X } from "lucide-react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { api, describeError } from "./api";
import { errorText, t } from "./i18n";
import appIcon from "../src-tauri/icons/128x128.png";

const donationUrl = "https://send.monobank.ua/jar/6ZninEa3R4";
const repositoryUrl = "https://github.com/agrynco/dirlume";
const licenseUrl = `${repositoryUrl}/blob/main/LICENSE`;
const aboutLinks = [
  { label: "Source code", href: repositoryUrl, Icon: CodeXml },
  { label: "Report an issue", href: `${repositoryUrl}/issues/new`, Icon: Bug },
  { label: "Releases", href: `${repositoryUrl}/releases`, Icon: Package },
];

export interface MenuAction {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  separatorBefore?: boolean;
  run: () => void;
}

type MenuItem = MenuAction | (Omit<MenuAction, "run"> & { items: MenuAction[] });
export type MenuGroup = { label: string; items: MenuItem[] };
export type MainMenuHandle = { open: () => void };

export function MainMenu({ groups, shortcut, ref, label = "Main menu" }: {
  groups: MenuGroup[];
  shortcut: string;
  ref?: Ref<MainMenuHandle>;
  label?: string;
}) {
  const bar = useRef<HTMLElement>(null);
  const priorFocus = useRef<HTMLElement | null>(null);
  const [active, setActive] = useState(0);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [cursor, setCursor] = useState(0);
  const [submenu, setSubmenu] = useState<{ item: number; cursor: number } | null>(null);

  function close(restore: boolean) {
    setExpanded(null);
    setSubmenu(null);
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
    setSubmenu(null);
  }

  useImperativeHandle(ref, () => ({
    open: () => {
      if (expanded === null) open(active);
      else close(true);
    },
  }), [active, expanded]);

  useLayoutEffect(() => {
    if (expanded !== null) {
      const selector = submenu ? `[data-submenu-item="${submenu.cursor}"]` : `[data-menu-item="${cursor}"]`;
      bar.current?.querySelector<HTMLElement>(selector)?.focus();
    }
  }, [expanded, cursor, submenu]);

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

  const submenuItem = expanded !== null && submenu ? groups[expanded].items[submenu.item] : undefined;
  const submenuIndex = submenu?.item;
  useLayoutEffect(() => {
    if (submenuIndex === undefined) return;
    const trigger = bar.current?.querySelector<HTMLElement>(`[data-menu-item="${submenuIndex}"]`);
    const popup = bar.current?.querySelector<HTMLElement>(".main-menu-submenu");
    const dropdown = trigger?.closest(".main-menu-dropdown");
    const group = popup?.parentElement;
    if (!trigger || !popup || !dropdown || !group) return;
    const place = () => {
      const parent = dropdown.getBoundingClientRect();
      const container = group.getBoundingClientRect();
      const top = trigger.getBoundingClientRect().top;
      const width = popup.getBoundingClientRect().width;
      const side = parent.right + width <= window.innerWidth - 8 ? parent.right : parent.left - width;
      popup.style.left = `${Math.max(8, side) - container.left}px`;
      popup.style.top = `${top - container.top}px`;
      popup.style.maxHeight = `${Math.max(0, window.innerHeight - top - 8)}px`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [expanded, submenuIndex]);

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
    const moveCursor = (position: number, count: number) => key === "Home" ? 0 : key === "End" ? count - 1 :
      (position + count + (key === "ArrowUp" ? -1 : 1)) % count;
    const vertical = key === "ArrowUp" || key === "ArrowDown" || key === "Home" || key === "End";
    if (submenu && submenuItem && "items" in submenuItem) {
      if (key === "Escape" || key === "ArrowLeft") setSubmenu(null);
      else if (vertical) setSubmenu({ ...submenu, cursor: moveCursor(submenu.cursor, submenuItem.items.length) });
      else if (key === "Enter" || key === " ") { event.stopPropagation(); return; }
      else if (key !== "ArrowRight") return;
    } else if (key === "Escape") {
      close(true);
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      const selected = inDropdown ? groups[active].items[cursor] : undefined;
      if (key === "ArrowRight" && selected && "items" in selected && !selected.disabled && selected.items.length) {
        setSubmenu({ item: cursor, cursor: 0 });
      } else {
        const index = (active + groups.length + (key === "ArrowRight" ? 1 : -1)) % groups.length;
        if (expanded !== null) open(index);
        else bar.current?.querySelector<HTMLElement>(`[data-menu-group="${index}"]`)?.focus();
      }
    } else if (vertical) {
      const count = groups[active].items.length;
      const last = key === "ArrowUp" || key === "End";
      if (inDropdown) setCursor(moveCursor(cursor, count));
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
    <nav ref={bar} className="main-menu" role="menubar" aria-label={t(label)}
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
          {shown && <div className="main-menu-dropdown" role="menu" aria-label={t(label)} data-tauri-drag-region="false">
            {items.map((action, item) => {
              const { label, shortcut, disabled, separatorBefore } = action;
              const nested = "items" in action;
              return <Fragment key={label}>
                  {separatorBefore && <div className="main-menu-separator" role="separator" />}
                  <Button type="button" role="menuitem" tabIndex={-1} data-menu-item={item}
                    aria-disabled={disabled || undefined} shortcut={shortcut} aria-haspopup={nested ? "menu" : undefined}
                    aria-expanded={nested ? submenu?.item === item : undefined}
                    onFocus={() => { setCursor(item); if (submenu && submenu.item !== item) setSubmenu(null); }}
                    onClick={() => {
                      if (disabled) return;
                      if ("items" in action) {
                        if (action.items.length) setSubmenu(submenu?.item === item ? null : { item, cursor: 0 });
                      } else {
                        close(true);
                        action.run();
                      }
                    }}>
                    <span>{t(label)}</span>{shortcut && <kbd aria-hidden="true">{shortcut}</kbd>}
                    {nested && <ChevronRight aria-hidden="true" />}
                  </Button>
                </Fragment>;
            })}
          </div>}
          {shown && submenuItem && "items" in submenuItem && (
            <div className="main-menu-dropdown main-menu-submenu" role="menu" aria-label={t(submenuItem.label)} data-tauri-drag-region="false">
              {submenuItem.items.map(({ label, disabled, run }, item) => (
                <Button key={label} type="button" role="menuitem" tabIndex={-1} data-submenu-item={item}
                  aria-disabled={disabled || undefined} onClick={() => {
                    if (disabled) return;
                    close(true);
                    run();
                  }}><span>{t(label)}</span></Button>
              ))}
            </div>
          )}
        </div>;
      })}
    </nav>
  );
}

export function AboutDialog({ onClose, onOpenGuide }: { onClose: () => void; onOpenGuide: () => void }) {
  const [version, setVersion] = useState("");
  const [error, setError] = useState("");
  const [linkError, setLinkError] = useState("");
  useEffect(() => {
    let open = true;
    void api.buildVersion().then(
      (value) => { if (open) setVersion(value); },
      (failure: unknown) => { if (open) setError(describeError(failure)); },
    );
    return () => { open = false; };
  }, []);

  function openLink(href: string) {
    setLinkError("");
    void api.openWebLink(href).catch((failure: unknown) => setLinkError(describeError(failure)));
  }

  return <Dialog title={t("About")} onClose={onClose} footer={<>
    <Button type="button" className="primary about-donate" onClick={() => openLink(donationUrl)}>
      <Coffee aria-hidden="true" /><span>{t("Donate via monobank")}</span>
    </Button>
    <Button data-initial-focus type="button" onClick={onClose}><X aria-hidden="true" />{t("Close")}</Button>
  </>}>
    <div className="dialog-body about-body">
      <div className="about-identity">
        <img src={appIcon} width={52} height={52} alt="" />
        <div>
          <strong>Dirlume</strong>
          <p>{t("Two-pane desktop file manager")}</p>
        </div>
      </div>
      <dl className="about-details">
        <dt>{t("Version")}</dt>
        <dd>{version ? <code>{version}</code> :
          error ? <p role="alert" className="dialog-error">{errorText(error)}</p> : <p role="status">{t("Reading version…")}</p>}</dd>
        <dt>{t("Created by")}</dt>
        <dd>bitcodepro</dd>
        <dt>{t("License")}</dt>
        <dd><a href={licenseUrl} onAuxClick={(event) => event.preventDefault()} onClick={(event) => {
          event.preventDefault();
          openLink(licenseUrl);
        }}>MIT</a></dd>
      </dl>
      <p className="about-stack">{t("Built with Rust, Tauri, React, and TypeScript.")}</p>
      <div className="about-actions">
        <Button type="button" onClick={onOpenGuide}><BookOpen aria-hidden="true" /><span>{t("User guide")}</span></Button>
        {aboutLinks.map(({ label, href, Icon }) => (
          <Button key={href} type="button" onClick={() => openLink(href)}>
            <Icon aria-hidden="true" /><span>{t(label)}</span>
          </Button>
        ))}
      </div>
      {linkError && <p role="alert" className="dialog-error">{errorText(linkError)}</p>}
    </div>
  </Dialog>;
}
