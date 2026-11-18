import { useEffect, useRef } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { X } from "lucide-react";
import { api, describeError, type TerminalOutput } from "./api";
import { eventShortcut, type Theme } from "./preferences";
import "@xterm/xterm/css/xterm.css";

function themeColors() {
  const root = getComputedStyle(document.documentElement);
  const value = (name: string) => root.getPropertyValue(name).trim();
  return {
    background: value("--canvas"), foreground: value("--ink"),
    cursor: value("--accent"), selectionBackground: value("--active-row"),
  };
}

export default function TerminalPanel({ session, theme, shortcut, onClose }: {
  session: { id: number; path: string };
  theme: Theme;
  shortcut: string;
  onClose: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<Terminal | null>(null);
  const toggle = useRef({ onClose, shortcut });
  toggle.current = { onClose, shortcut };

  useEffect(() => {
    if (!container.current) return;
    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono"),
      fontSize: 13, theme: themeColors(), cursorBlink: true, screenReaderMode: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current);
    term.attachCustomKeyEventHandler((event) => {
      const { onClose, shortcut } = toggle.current;
      if (shortcut && eventShortcut(event) === shortcut) {
        if (event.type === "keydown") onClose();
        return false;
      }
      return true;
    });
    instance.current = term;
    fit.fit();
    term.focus();
    const output = new Channel<TerminalOutput>();
    let stopped = false;
    let closed = false;
    let ready = false;
    let queued = Promise.resolve();
    output.onmessage = (message) => {
      if (stopped) return;
      if (message.event === "closed") {
        closed = true;
        term.writeln("\r\nShell exited.");
      } else {
        term.write(Uint8Array.from(atob(message.data), (byte) => byte.charCodeAt(0)));
      }
    };
    const opening = api.openTerminal(session.id, session.path, term.rows, term.cols, output);
    void opening.then(() => { ready = true; }, (error: unknown) => {
      if (!stopped) term.writeln(describeError(error));
    });
    const data = term.onData((data) => {
      queued = queued.then(async () => {
        await opening;
        if (!closed && !stopped) await api.writeTerminal(session.id, data);
      }).catch(() => {});
    });
    const resize = new ResizeObserver(() => {
      fit.fit();
      if (ready && !closed && !stopped) void api.resizeTerminal(session.id, term.rows, term.cols).catch(() => {});
    });
    resize.observe(container.current);
    return () => {
      stopped = true;
      instance.current = null;
      data.dispose();
      resize.disconnect();
      output.onmessage = () => {};
      term.dispose();
      void opening.then(() => api.closeTerminal(session.id)).catch(() => {});
    };
  }, [session.id, session.path]);

  useEffect(() => {
    const match = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      if (instance.current) instance.current.options.theme = themeColors();
    };
    const frame = requestAnimationFrame(update);
    const onChange = () => requestAnimationFrame(update);
    match.addEventListener("change", onChange);
    return () => { cancelAnimationFrame(frame); match.removeEventListener("change", onChange); };
  }, [theme]);

  return (
    <section className="terminal-card" aria-label="Terminal">
      <header><h2>Terminal</h2><span title={session.path}>{session.path}</span>
        <button type="button" className="icon-button" aria-label="Close terminal" onClick={onClose}><X /></button>
      </header>
      <div className="terminal-surface" ref={container} />
    </section>
  );
}
