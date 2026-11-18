import { useEffect, useRef } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { X } from "lucide-react";
import { api, describeError, type TerminalOutput } from "./api";
import { eventShortcut } from "./preferences";
import type { Scheme, Theme } from "./appearance";
import "@xterm/xterm/css/xterm.css";

function terminalAppearance() {
  const root = getComputedStyle(document.documentElement);
  const value = (name: string) => root.getPropertyValue(name).trim();
  return {
    fontFamily: value("--mono"),
    fontSize: Number.parseFloat(value("--mono-size")),
    theme: {
      background: value("--text-bg"), foreground: value("--text-ink"),
      cursor: value("--accent"), selectionBackground: value("--panel-selection"),
    },
  };
}

export default function TerminalPanel({ session, theme, scheme, shortcut, pendingCommands, onCommandsQueued, onShortcut, onClose }: {
  session: { id: number; path: string };
  theme: Theme;
  scheme: Scheme | null;
  shortcut: string;
  pendingCommands: string[];
  onCommandsQueued: (count: number) => void;
  onShortcut: () => void;
  onClose: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
  const toggle = useRef({ onShortcut, shortcut });
  toggle.current = { onShortcut, shortcut };
  const enqueue = useRef<((data: string) => void) | null>(null);
  const acknowledge = useRef(onCommandsQueued);
  acknowledge.current = onCommandsQueued;

  useEffect(() => {
    if (!container.current) return;
    const term = new Terminal({
      ...terminalAppearance(), cursorBlink: true, screenReaderMode: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current);
    term.attachCustomKeyEventHandler((event) => {
      const { onShortcut, shortcut } = toggle.current;
      if (shortcut && eventShortcut(event) === shortcut) {
        if (event.type === "keydown") onShortcut();
        return false;
      }
      return true;
    });
    instance.current = { term, fit };
    fit.fit();
    if (!document.activeElement?.closest(".command-bar")) term.focus();
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
    function send(data: string) {
      queued = queued.then(async () => {
        await opening;
        if (!closed && !stopped) await api.writeTerminal(session.id, data);
      }).catch(() => {});
    }
    enqueue.current = send;
    const data = term.onData(send);
    const resized = term.onResize(({ rows, cols }) => {
      if (ready && !closed && !stopped) void api.resizeTerminal(session.id, rows, cols).catch(() => {});
    });
    const resize = new ResizeObserver(() => fit.fit());
    resize.observe(container.current);
    return () => {
      stopped = true;
      instance.current = null;
      enqueue.current = null;
      data.dispose();
      resized.dispose();
      resize.disconnect();
      output.onmessage = () => {};
      term.dispose();
      void opening.then(() => api.closeTerminal(session.id)).catch(() => {});
    };
  }, [session.id, session.path]);

  useEffect(() => {
    if (!enqueue.current || !pendingCommands.length) return;
    pendingCommands.forEach(enqueue.current);
    acknowledge.current(pendingCommands.length);
  }, [pendingCommands]);

  useEffect(() => {
    const match = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      if (!instance.current) return;
      const { term, fit } = instance.current;
      const appearance = terminalAppearance();
      term.options = appearance;
      fit.fit();
    };
    const frame = requestAnimationFrame(update);
    const onChange = () => requestAnimationFrame(update);
    match.addEventListener("change", onChange);
    return () => { cancelAnimationFrame(frame); match.removeEventListener("change", onChange); };
  }, [theme, scheme]);

  return (
    <section className="terminal-card" aria-label="Terminal">
      <header><h2>Terminal</h2><span title={session.path}>{session.path}</span>
        <button type="button" className="icon-button" aria-label="Close terminal" onClick={onClose}><X /></button>
      </header>
      <div className="terminal-surface" ref={container} />
    </section>
  );
}
