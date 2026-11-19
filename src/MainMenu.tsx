import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { BookOpen, Bug, CodeXml, Coffee, Package, X } from "lucide-react";
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
          {shown && <div className="main-menu-dropdown" role="menu" aria-label={t(label)} data-tauri-drag-region="false">
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
