import { t } from "./i18n";
import { Button } from "./Button";
import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Terminal, type ITerminalOptions, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { X } from "lucide-react";
import { api, describeError, type TerminalOutput } from "./api";
import { eventShortcut } from "./preferences";
import type { Scheme, Theme } from "./appearance";
import { changeShellDirectory } from "./shell";
import "@xterm/xterm/css/xterm.css";

// Focus and device reports are forwarded to the PTY without changing input state.
const terminalReport = /^\x1b(?:\[(?:[IO]|\??[\d;]+[Rcnt])|\][\s\S]*(?:\x07|\x1b\\))$/;

const lightAnsi: ITheme = {
  red: "#a12033", green: "#245d26", yellow: "#765000", blue: "#164ea5", magenta: "#783179", cyan: "#005e67",
  brightRed: "#ae304b", brightGreen: "#306b35", brightYellow: "#815500", brightBlue: "#245bb5",
  brightMagenta: "#88428b", brightCyan: "#006b74",
};
const darkAnsi: ITheme = {
  red: "#ee808a", green: "#91cf94", yellow: "#dfb758", blue: "#81b0f1", magenta: "#dba0e6", cyan: "#72d0d5",
  brightRed: "#ffa2a8", brightGreen: "#a9ebb1", brightYellow: "#f8d477", brightBlue: "#a5caff",
  brightMagenta: "#efbff4", brightCyan: "#9ee9ed",
};

function isLightBackground(hex: string) {
  // Choose the ANSI palette against the resolved background, including custom schemes.
  const luminance = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * luminance[0] + 0.7152 * luminance[1] + 0.0722 * luminance[2] > 0.179;
}

function terminalAppearance(): ITerminalOptions {
  const root = getComputedStyle(document.documentElement);
  const value = (name: string) => root.getPropertyValue(name).trim();
  const background = value("--text-bg");
  return {
    fontFamily: value("--mono"),
    fontSize: Number.parseFloat(value("--mono-size")),
    minimumContrastRatio: 4.5,
    theme: {
      ...(isLightBackground(background) ? lightAnsi : darkAnsi),
      background, foreground: value("--text-ink"),
      cursor: value("--accent"), cursorAccent: background, selectionBackground: value("--panel-selection"),
    },
  };
}

export default function TerminalPanel({ session, directory, theme, scheme, shortcut, historyShortcut, pendingCommands,
  onCommandsQueued, onShortcut, onHistory, onClose }: {
  session: { id: number; path: string };
  directory: string | null;
  theme: Theme;
  scheme: Scheme | null;
  shortcut: string;
  historyShortcut: string;
  pendingCommands: string[];
  onCommandsQueued: (count: number) => void;
  onShortcut: () => void;
  onHistory: () => void;
  onClose: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
  const shortcuts = useRef({ onShortcut, shortcut, onHistory, historyShortcut });
  shortcuts.current = { onShortcut, shortcut, onHistory, historyShortcut };
  const [shellDirectory, setShellDirectory] = useState(session.path);
  const enqueue = useRef<((data: string) => void) | null>(null);
  const moveTo = useRef<((path: string | null) => void) | null>(null);
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
      const { onShortcut, shortcut, onHistory, historyShortcut } = shortcuts.current;
      const key = eventShortcut(event);
      const action = key && key === shortcut ? onShortcut : key && key === historyShortcut ? onHistory : null;
      if (!action) return true;
      event.preventDefault();
      if (event.type === "keydown" && !event.repeat) action();
      return false;
    });
    instance.current = { term, fit };
    fit.fit();
    if (!document.activeElement?.closest(".command-bar")) term.focus();
    const output = new Channel<TerminalOutput>();
    let stopped = false;
    let closed = false;
    let ready = false;
    let atPrompt = false;
    let draft = false;
    let currentDirectory: string | null = session.path;
    let nextDirectory: string | null = null;
    let queued = Promise.resolve();
    const promptToken = `Dirlume-${crypto.getRandomValues(new Uint32Array(4)).join("-")}`;
    const promptPrefix = promptToken + ":";
    const decoder = new TextDecoder();
    function synchronize() {
      if (!atPrompt || draft || closed || stopped || nextDirectory === null) return;
      const next = nextDirectory;
      nextDirectory = null;
      if (currentDirectory !== next) send(changeShellDirectory(next) + "\r");
    }
    function prompt(title: string) {
      if (!title.startsWith(promptPrefix)) return false;
      const separator = title.indexOf(":", promptPrefix.length);
      if (separator < 0) return false;
      const path = title.slice(separator + 1);
      try {
        currentDirectory = path ? decoder.decode(Uint8Array.from(atob(path), (byte) => byte.charCodeAt(0))) : null;
      } catch { return true; }
      setShellDirectory(currentDirectory ?? "");
      atPrompt = true;
      synchronize();
      return true;
    }
    const titles = [0, 2].map((code) => term.parser.registerOscHandler(code, prompt));
    moveTo.current = (path) => { nextDirectory = path; synchronize(); };
    output.onmessage = (message) => {
      if (stopped) return;
      if (message.event === "closed") {
        closed = true;
        term.writeln("\r\nShell exited.");
      } else {
        term.write(Uint8Array.from(atob(message.data), (byte) => byte.charCodeAt(0)));
      }
    };
    const opening = api.openTerminal(session.id, session.path, promptToken, term.rows, term.cols, output);
    void opening.then(() => { ready = true; }, (error: unknown) => {
      if (!stopped) term.writeln(describeError(error));
    });
    function send(data: string) {
      if (data.endsWith("\r") || data.endsWith("\n") || data === "\x03") {
        atPrompt = false;
        draft = false;
      } else if (!terminalReport.test(data)) draft = true;
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
      moveTo.current = null;
      data.dispose();
      resized.dispose();
      titles.forEach((title) => title.dispose());
      resize.disconnect();
      output.onmessage = () => {};
      term.dispose();
      void opening.then(() => api.closeTerminal(session.id)).catch(() => {});
    };
  }, [session.id, session.path]);

  useEffect(() => { moveTo.current?.(directory); }, [directory]);

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
    <section className="terminal-card" aria-label={t("Terminal")}>
      <header><h2>{t("Terminal")}</h2><span title={shellDirectory}>{shellDirectory}</span>
        <Button type="button" className="icon-button" aria-label={t("Close terminal")} onClick={onClose}><X /></Button>
      </header>
      <div className="terminal-surface" ref={container} />
    </section>
  );
}
