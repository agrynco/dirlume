import { t } from "./i18n";
import { Button } from "./Button";
import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal, type ITerminalOptions, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { X } from "lucide-react";
import { api, describeError, windowsClient, type TerminalCommand, type TerminalOutput, type TerminalSession } from "./api";
import type { Scheme, Theme } from "./appearance";
import { changeShellDirectory } from "./shell";
import { bindingMatches, eventShortcut } from "./preferences";
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
  const background = value("--terminal-bg");
  return {
    fontFamily: value("--terminal-font"),
    fontSize: Number.parseFloat(value("--terminal-size")),
    minimumContrastRatio: 4.5,
    theme: {
      ...(isLightBackground(background) ? lightAnsi : darkAnsi),
      background, foreground: value("--terminal-ink"),
      cursor: value("--terminal-cursor"), cursorAccent: background, selectionBackground: value("--terminal-selection"),
    },
  };
}

export default function TerminalPanel({ session, directory, visible, theme, scheme, pendingCommands, watchEnvironment,
  pasteShortcut, pasteOnRightClick, onPasteError, onCommandsQueued, rowHeight, onCommandSubmitted, onDirectoryChange, focusRequested, focusHint, onClose }: {
  session: TerminalSession;
  directory: string | null;
  visible: boolean;
  focusHint?: string;
  theme: Theme;
  scheme: Scheme | null;
  pendingCommands: TerminalCommand[];
  watchEnvironment: boolean;
  pasteShortcut: readonly string[];
  pasteOnRightClick: boolean;
  onPasteError: (error: unknown) => void;
  onCommandsQueued: (count: number) => void;
  onCommandSubmitted: (command: string) => void;
  onDirectoryChange: (directory: string) => void;
  rowHeight: { current: number };
  focusRequested: { current: number | null };
  onClose: () => void;
}) {
  const remoteTerminal = session.kind === "ssh";
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<{ term: Terminal; fit: () => void } | null>(null);
  const [shellDirectory, setShellDirectory] = useState(session.path);
  const [environmentChanged, setEnvironmentChanged] = useState(false);
  const enqueue = useRef<((command: TerminalCommand) => void) | null>(null);
  const moveTo = useRef<((path: string | null) => void) | null>(null);
  const acknowledge = useRef(onCommandsQueued);
  acknowledge.current = onCommandsQueued;
  const record = useRef(onCommandSubmitted);
  record.current = onCommandSubmitted;
  const reportDirectory = useRef(onDirectoryChange);
  reportDirectory.current = onDirectoryChange;
  const pasteSettings = useRef({ pasteShortcut, pasteOnRightClick, onPasteError, visible });
  pasteSettings.current = { pasteShortcut, pasteOnRightClick, onPasteError, visible };

  useEffect(() => {
    if (!windowsClient || !watchEnvironment) return;
    let open = true;
    const listener = listen("terminal-environment-changed", () => {
      if (open) setEnvironmentChanged(true);
    });
    return () => {
      open = false;
      void listener.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [watchEnvironment]);

  useEffect(() => {
    const surface = container.current;
    if (!surface) return;
    const term = new Terminal({
      ...terminalAppearance(), cursorBlink: true, screenReaderMode: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(surface);
    const fit = () => {
      if (!surface.clientWidth || !surface.clientHeight) return;
      fitAddon.fit();
      const height = surface.querySelector(".xterm-screen")?.getBoundingClientRect().height;
      if (height && term.rows) rowHeight.current = height / term.rows;
    };
    instance.current = { term, fit };
    fit();
    const output = new Channel<TerminalOutput>();
    let stopped = false;
    let closed = false;
    let atPrompt = false;
    let tracksPrompt = true;
    let draft = false;
    let currentDirectory: string | null = session.path;
    let nextDirectory: string | null = null;
    let followingPane = false;
    let queued = Promise.resolve();
    let resizing = Promise.resolve();
    const remote = session.kind === "ssh";
    const windows = !remote && windowsClient;
    let installedPrompt = false;
    const promptToken = `Dirlume-${crypto.getRandomValues(new Uint32Array(4)).join("-")}`;
    const promptPrefix = promptToken + ":";
    const decoder = new TextDecoder();
    const internalPrefix = windows ? "$null = '" + promptToken + "'; " : ": '" + promptToken + "'; ";
    let lastCommand = 0;
    const submitted = new Map<string, { original: string; pending: number }>();
    const applicationQueue: Exclude<TerminalCommand, null>[] = [];

    function runQueuedCommand() {
      if (closed || stopped || (tracksPrompt && (!atPrompt || draft))) return false;
      const entry = applicationQueue.shift();
      if (!entry) return false;
      const { command, directory } = entry;
      const prefix = tracksPrompt ? internalPrefix : "";
      const text = prefix + changeShellDirectory(directory, windows) + (windows ? "; " : " && ") + (tracksPrompt ? shellCommand(command) : command);
      const prior = submitted.get(text);
      if (submitted.size >= 1000 && !prior) {
        const oldest = submitted.keys().next().value;
        if (oldest !== undefined) submitted.delete(oldest);
      }
      submitted.set(text, { original: command, pending: (prior?.pending ?? 0) + 1 });
      send(text + "\r");
      return true;
    }

    function shellCommand(command: string) {
      if (!/\p{Cc}/u.test(command)) return command;
      const encoded = btoa(Array.from(new TextEncoder().encode(command), (byte) => String.fromCharCode(byte)).join(""));
      if (windows) return ". ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded + "'))))";
      return "__dirlume_command=$(printf '%s' '" + encoded + "' | base64 -d; printf .); eval -- \"${__dirlume_command%.}\"";
    }

    function decode(value: string) {
      return decoder.decode(Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0)));
    }

    function reportCommand(text: string) {
      if (!text.startsWith(internalPrefix)) {
        if (text.trim()) record.current(text);
        return;
      }
      const entry = submitted.get(text);
      if (entry && entry.pending > 0) entry.pending--;
      else if (entry) record.current(entry.original);
    }
    function recordMarker(encoded: string, sequence?: string) {
      if (!encoded) return;
      if (sequence !== undefined) {
        const count = Number(sequence);
        if (!Number.isSafeInteger(count) || count <= lastCommand) return;
        lastCommand = count;
      }
      reportCommand(decode(encoded));
    }
    function synchronize() {
      if (!atPrompt || draft || closed || stopped) return;
      if (nextDirectory === null) return;
      const next = nextDirectory;
      nextDirectory = null;
      if (currentDirectory !== next) {
        followingPane = true;
        send(internalPrefix + changeShellDirectory(next, windows) + "\r");
      }
    }
    function prompt(title: string) {
      if (!title.startsWith(promptPrefix)) return false;
      if (remote && title === promptPrefix + "init") {
        if (!installedPrompt) {
          installedPrompt = true;
          const mark = `printf '\\033]2;${promptToken}:0:%s\\007' "$(printf '%s' "$PWD" | base64 | tr -d '\\n')"`;
          send(`__dirlume_prompt() { ${mark}; }; if [ -n "$BASH_VERSION" ]; then eval 'PROMPT_COMMAND+=(__dirlume_prompt)'; elif [ -n "$ZSH_VERSION" ]; then eval 'precmd_functions+=(__dirlume_prompt)'; else PS1='$(__dirlume_prompt)'"$PS1"; fi\r`);
        }
        return true;
      }
      const separator = title.indexOf(":", promptPrefix.length);
      if (separator < 0) return false;
      const path = title.slice(separator + 1);
      const previousDirectory = currentDirectory;
      try {
        if (title.slice(promptPrefix.length, separator) === "command") {
          const fields = path.split(":");
          if (fields.length === 2) recordMarker(fields[1], fields[0]);
          else recordMarker(path);
          return true;
        }
        const [directory, sequence, encoded] = path.split(":");
        if (encoded) recordMarker(encoded, sequence);
        currentDirectory = directory ? decode(directory) : null;
      } catch { return true; }
      setShellDirectory(currentDirectory ?? "");
      atPrompt = true;
      draft = false;
      if (!followingPane && nextDirectory === null && currentDirectory && currentDirectory !== previousDirectory) {
        reportDirectory.current(currentDirectory);
      }
      followingPane = false;
      if (!runQueuedCommand()) synchronize();
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
    const opening = api.openTerminal(session, promptToken, term.rows, term.cols, output);
    void opening.then((tracked) => {
      tracksPrompt = tracked;
      if (!tracked) while (runQueuedCommand()) { /* Unsupported shells have no prompt marker. */ }
    }, (error: unknown) => {
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
    enqueue.current = (entry) => {
      if (!entry) {
        send("\r");
        return;
      }
      applicationQueue.push(entry);
      runQueuedCommand();
    };
    const data = term.onData(send);
    let pasting = Promise.resolve();
    function paste() {
      pasting = pasting.then(async () => {
        if (stopped || closed || !pasteSettings.current.visible) return;
        const text = await api.clipboardText();
        if (!stopped && !closed && pasteSettings.current.visible && text) term.paste(text);
      }).catch((error: unknown) => { if (!stopped) pasteSettings.current.onPasteError(error); });
    }
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || event.isComposing) return true;
      const command = eventShortcut(event);
      if (!bindingMatches(pasteSettings.current.pasteShortcut, command)) {
        if (command === "Ctrl+V") event.preventDefault();
        return true;
      }
      event.preventDefault();
      if (!event.repeat) paste();
      return false;
    });
    function pasteOnContextMenu(event: MouseEvent) {
      if (event.button !== 2 || !pasteSettings.current.pasteOnRightClick) return;
      event.preventDefault();
      event.stopPropagation();
      term.focus();
      paste();
    }
    surface.addEventListener("contextmenu", pasteOnContextMenu, true);
    const keys = term.onKey(({ domEvent }) => {
      // xterm can leave a WebView function-key default enabled in screen reader mode.
      if (/^F\d+$/.test(domEvent.key)) domEvent.preventDefault();
    });
    const resized = term.onResize(({ rows, cols }) => {
      resizing = resizing.then(async () => {
        await opening;
        if (!closed && !stopped) await api.resizeTerminal(session.id, rows, cols);
      }).catch(() => {});
    });
    const resize = new ResizeObserver(fit);
    resize.observe(surface);
    return () => {
      stopped = true;
      instance.current = null;
      enqueue.current = null;
      moveTo.current = null;
      data.dispose();
      keys.dispose();
      resized.dispose();
      surface.removeEventListener("contextmenu", pasteOnContextMenu, true);
      titles.forEach((title) => title.dispose());
      resize.disconnect();
      output.onmessage = () => {};
      term.dispose();
      void opening.then(() => api.closeTerminal(session.id)).catch(() => {});
    };
  }, [session, rowHeight]);

  useEffect(() => {
    if (!visible || !instance.current) return;
    instance.current.fit();
    if (focusRequested.current === session.id) {
      focusRequested.current = null;
      if (!document.querySelector("dialog[open]")) instance.current.term.focus();
    }
  }, [visible, session.id, focusRequested]);

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
      fit();
    };
    const frame = requestAnimationFrame(update);
    const onChange = () => requestAnimationFrame(update);
    match.addEventListener("change", onChange);
    return () => { cancelAnimationFrame(frame); match.removeEventListener("change", onChange); };
  }, [theme, scheme]);

  return (
    <section className="terminal-card" data-help-topic="terminal" aria-label={t("Terminal")} hidden={!visible}>
      <header onClick={(event) => { if (!(event.target as Element).closest("button")) instance.current?.term.focus(); }}><h2>{t(remoteTerminal ? "SSH terminal" : "Terminal")}</h2><span data-tooltip={shellDirectory}>{remoteTerminal ? session.address + " · " : ""}{shellDirectory}</span>
        <Button type="button" className="icon-button" aria-label={t("Close terminal")} onClick={onClose}><X /></Button>
      </header>
      {watchEnvironment && environmentChanged && <p className="terminal-environment-notice" role="status">
        {t("Windows environment changed. Reopen the terminal to apply the updated variables.")}
      </p>}
      {focusHint !== undefined && <p className="terminal-focus-hint" role="status">{focusHint}</p>}
      <div className="terminal-surface" ref={container} />
    </section>
  );
}
