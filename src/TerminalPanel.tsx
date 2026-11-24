import { errorText, t } from "./i18n";
import { Button } from "./Button";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal, type IBufferRange, type ITerminalOptions, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { X } from "lucide-react";
import { FileContextMenu } from "./FileContextMenu";
import { api, describeError, windowsClient, type ShellCompletionEnvironment, type TerminalCompletionContext, type TerminalCommand, type TerminalOutput, type TerminalSession } from "./api";
import type { Scheme, Theme } from "./appearance";
import { changeShellDirectory } from "./shell";
import { bindingMatches, eventShortcut, showShortcut } from "./preferences";
import { CommandSuggestions, commandSuggestions, moveSuggestion, type CommandSuggestion } from "./CommandSuggestions";
import { replaceTerminalRange, trackTerminalDraft, type TerminalDraft } from "./terminalDraft";
import { showTooltipAtPointer } from "./tooltips";
import "@xterm/xterm/css/xterm.css";

// Focus and device reports are forwarded to the PTY without changing input state.
const terminalReport = /^\x1b(?:\[(?:[IO]|\??[\d;]+[Rcnt])|\][\s\S]*(?:\x07|\x1b\\))$/;
const macClient = /Macintosh/.test(navigator.userAgent);

function isWebLink(text: string) {
  if (!/^https?:\/\/[^/\\?#\s]/i.test(text) || /[\p{Cc}\s\\]|%(?![\da-f]{2})/iu.test(text)) return false;
  try { return Boolean(new URL(text).hostname); } catch { return false; }
}

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
    fontSize: Number.parseFloat(value("--font-zoom-terminal") || value("--terminal-size")),
    minimumContrastRatio: 4.5,
    theme: {
      ...(isLightBackground(background) ? lightAnsi : darkAnsi),
      background, foreground: value("--terminal-ink"),
      cursor: value("--terminal-cursor"), cursorAccent: background, selectionBackground: value("--terminal-selection"),
    },
  };
}

export default function TerminalPanel({ session, directory, visible, theme, scheme, fontSize, pendingCommands, watchEnvironment,
  history, copyShortcut, pasteShortcut, pasteOnRightClick, onClipboardError, onTerminalError, onCommandsQueued, rowHeight, onCommandSubmitted, onDirectoryChange, onCompletionContext, focusRequested, focusHint, onClose }: {
  session: TerminalSession;
  directory: string | null;
  visible: boolean;
  focusHint?: React.ReactNode;
  theme: Theme;
  scheme: Scheme | null;
  fontSize?: number;
  pendingCommands: TerminalCommand[];
  watchEnvironment: boolean;
  history: readonly string[];
  copyShortcut: readonly string[];
  pasteShortcut: readonly string[];
  pasteOnRightClick: boolean;
  onClipboardError: (error: unknown) => void;
  onTerminalError: (message: string) => void;
  onCommandsQueued: (count: number) => void;
  onCommandSubmitted: (command: string) => void;
  onDirectoryChange: (directory: string) => void;
  onCompletionContext: (context: TerminalCompletionContext | null) => void;
  rowHeight: { current: number };
  focusRequested: { current: number | null };
  onClose: () => void;
}) {
  const remoteTerminal = session.kind === "ssh";
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<{ term: Terminal; fit: () => void; paste: () => void; copy: (text: string) => void; openLink: (href: string) => void } | null>(null);
  const [shellDirectory, setShellDirectory] = useState(session.path);
  const [environmentChanged, setEnvironmentChanged] = useState(false);
  const [commandsWaiting, setCommandsWaiting] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; selection: string; href: string | null } | null>(null);
  const suggestionId = useId();
  const [popup, setPopup] = useState<{ options: CommandSuggestion[]; selected: number; style: CSSProperties } | null>(null);
  const chooseSuggestion = useRef<(option: CommandSuggestion) => void>(() => {});
  const dismissSuggestions = useRef<() => void>(() => {});
  const localHistory = useRef(history);
  localHistory.current = history;
  const enqueue = useRef<((command: TerminalCommand) => void) | null>(null);
  const moveTo = useRef<((path: string | null) => void) | null>(null);
  const acknowledge = useRef(onCommandsQueued);
  acknowledge.current = onCommandsQueued;
  const record = useRef(onCommandSubmitted);
  record.current = onCommandSubmitted;
  const reportDirectory = useRef(onDirectoryChange);
  reportDirectory.current = onDirectoryChange;
  const reportCompletion = useRef(onCompletionContext);
  reportCompletion.current = onCompletionContext;
  const reportError = useRef(onTerminalError);
  reportError.current = onTerminalError;
  const clipboard = useRef({ copyShortcut, pasteShortcut, pasteOnRightClick, onClipboardError, visible });
  clipboard.current = { copyShortcut, pasteShortcut, pasteOnRightClick, onClipboardError, visible };

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
    const terminalSurface = surface;
    let linkMouseDown: { x: number; y: number; dragged: boolean } | null = null;
    let hoveredLink: { href: string; range: IBufferRange } | null = null;
    let dismissLinkTooltip: (() => void) | undefined;
    const term = new Terminal({
      ...terminalAppearance(), cursorBlink: true, screenReaderMode: true, rightClickSelectsWord: false,
      linkHandler: { activate: activateLink, hover: hoverLink, leave: hideLinkTooltip },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon(activateLink, { hover: hoverLink, leave: hideLinkTooltip }));
    term.open(surface);

    function trackLinkDrag(event: MouseEvent) {
      if (linkMouseDown && Math.hypot(linkMouseDown.x - event.clientX, linkMouseDown.y - event.clientY) > 4) {
        linkMouseDown.dragged = true;
      }
    }

    function activateLink(event: MouseEvent, href: string) {
      if (event.button !== 0 || !linkMouseDown || !clipboard.current.visible) return;
      trackLinkDrag(event);
      const { dragged } = linkMouseDown;
      linkMouseDown = null;
      if (!dragged && !term.hasSelection()) openLink(href);
    }

    function openLink(href: string) {
      if (stopped || !clipboard.current.visible || !isWebLink(href)) return;
      void api.openWebLink(href).catch((error: unknown) => {
        if (!stopped) reportError.current(t("Could not open the terminal link. {0}", errorText(describeError(error))));
      });
    }

    function hoverLink(event: MouseEvent, href: string, range: IBufferRange) {
      hideLinkTooltip();
      hoveredLink = isWebLink(href) ? { href, range } : null;
      if (hoveredLink && !event.buttons) dismissLinkTooltip = showTooltipAtPointer(terminalSurface, href, event);
    }

    function hideLinkTooltip() {
      dismissLinkTooltip?.();
      dismissLinkTooltip = undefined;
    }
    function linkAt(event: MouseEvent) {
      const screen = terminalSurface.querySelector(".xterm-screen")?.getBoundingClientRect();
      if (!hoveredLink || !screen?.width || !screen.height || event.clientX < screen.left || event.clientX >= screen.right ||
          event.clientY < screen.top || event.clientY >= screen.bottom) return null;
      // xterm reports one-based buffer ranges and may not repeat hover on the same cell after the menu closes.
      const column = Math.floor((event.clientX - screen.left) * term.cols / screen.width) + 1;
      const line = Math.floor((event.clientY - screen.top) * term.rows / screen.height) + term.buffer.active.viewportY + 1;
      const { start, end } = hoveredLink.range;
      return (line > start.y || (line === start.y && column >= start.x)) &&
        (line < end.y || (line === end.y && column <= end.x)) ? hoveredLink.href : null;
    }
    const fit = () => {
      if (!surface.clientWidth || !surface.clientHeight) return;
      fitAddon.fit();
      const height = surface.querySelector(".xterm-screen")?.getBoundingClientRect().height;
      if (height && term.rows) rowHeight.current = height / term.rows;
    };
    instance.current = { term, fit, paste, copy, openLink };
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
    let editable: TerminalDraft | null = null;
    let sshSearchPath: string | null = null;
    let shellEnvironment: ShellCompletionEnvironment | undefined;
    let environmentMarker = "";
    let editorSupported = false;
    const sessionHistory: string[] = [];
    let revision = 0;
    let completionTimer = 0;
    let requesting = false;
    let pending = false;
    let options: CommandSuggestion[] = [];
    let selected = -1;
    const promptToken = `Dirlume-${crypto.getRandomValues(new Uint32Array(4)).join("-")}`;
    const promptPrefix = promptToken + ":";
    const decoder = new TextDecoder();
    const internalPrefix = windows ? "$null = '" + promptToken + "'; " : ": '" + promptToken + "'; ";
    let lastCommand = 0;
    const submitted = new Map<string, { original: string; pending: number }>();
    const applicationQueue: Exclude<TerminalCommand, null>[] = [];

    function hideSuggestions() {
      revision++;
      window.clearTimeout(completionTimer);
      pending = false;
      options = [];
      selected = -1;
      setPopup(null);
      term.textarea?.removeAttribute("aria-controls");
      term.textarea?.removeAttribute("aria-activedescendant");
    }

    function renderSuggestions() {
      const screen = surface?.querySelector(".xterm-screen")?.getBoundingClientRect();
      if (!screen?.width || !options.length) return;
      const cursor = term.buffer.active;
      const row = cursor.baseY + cursor.cursorY - cursor.viewportY;
      if (row < 0 || row >= term.rows) return hideSuggestions();
      const cellHeight = screen.height / term.rows;
      const cellWidth = screen.width / term.cols;
      const y = screen.top + row * cellHeight;
      const x = screen.left + Math.min(cursor.cursorX * cellWidth, screen.width - cellWidth);
      const spaceRight = screen.right - x;
      const spaceLeft = x - screen.left + cellWidth;
      const alignLeft = spaceRight >= Math.min(168, spaceLeft);
      const horizontal = alignLeft
        ? { left: x, right: "auto", maxWidth: Math.min(320, spaceRight) }
        : { left: "auto", right: innerWidth - x - cellWidth, maxWidth: Math.min(320, spaceLeft) };
      const gap = 4;
      const down = screen.bottom - y - cellHeight - gap;
      const above = y - screen.top - gap;
      const fontSize = Number(term.options.fontSize) || 14;
      const wantedHeight = Math.min(6, options.length) * (Math.ceil(fontSize * 1.35) + 6) + 8;
      // A short terminal can place the list above its viewport without covering the active line.
      const minimumHeight = Math.ceil(fontSize * 1.35) + 14;
      const roomAbove = Math.max(down, above) < minimumHeight ? y - gap : above;
      const below = down >= wantedHeight || down >= roomAbove;
      const vertical = below
        ? { top: y + cellHeight + gap, bottom: "auto", maxHeight: Math.min(down, wantedHeight) }
        : { top: "auto", bottom: innerHeight - y + gap, maxHeight: Math.min(roomAbove, wantedHeight) };
      term.textarea?.setAttribute("aria-controls", suggestionId);
      if (selected >= 0) term.textarea?.setAttribute("aria-activedescendant", `${suggestionId}-${selected}`);
      else term.textarea?.removeAttribute("aria-activedescendant");
      setPopup({ options, selected, style: { ...horizontal, ...vertical } });
    }

    async function completeDraft() {
      if (requesting) {
        pending = true;
        return;
      }
      const current = editable;
      const directory = currentDirectory;
      if (!current?.text.trim() || !directory || !clipboard.current.visible || !term.textarea?.matches(":focus")) return;
      const requested = revision;
      requesting = true;
      const history = remote ? sessionHistory : localHistory.current;
      const prefix = windows ? current.text.toLowerCase() : current.text;
      const recent = current.caret === current.text.length ? [...new Set(history.filter((line) =>
        (windows ? line.toLowerCase() : line).startsWith(prefix)))].slice(0, 5) : [];
      const completion = remote
        ? sshSearchPath === null ? Promise.resolve(null) : api.completeSshTerminal(session.id, current.text, current.caret, directory, sshSearchPath, shellEnvironment)
        : api.completeCommand(current.text, current.caret, directory, session.refreshEnvironment, shellEnvironment);
      const batch = await completion.catch(() => null);
      requesting = false;
      if (requested === revision && clipboard.current.visible && !closed && !stopped) {
        options = commandSuggestions(current.text, recent, batch);
        renderSuggestions();
      }
      if (pending) {
        pending = false;
        void completeDraft();
      }
    }

    chooseSuggestion.current = (option) => {
      if (!editable || !options.includes(option)) return;
      const replacement = replaceTerminalRange(editable, option.index, option.length, option.text,
        term.modes.applicationCursorKeysMode, term.modes.bracketedPasteMode);
      if (replacement) {
        editable = replacement.draft;
        const trailingQuote = option.directory &&
          (windows && option.text.startsWith("'") && option.text.endsWith("'") || remote && option.text.endsWith("/'"));
        const arrow = term.modes.applicationCursorKeysMode ? "\x1bOD" : "\x1b[D";
        if (trailingQuote) editable = { ...editable, caret: editable.caret - 1 };
        send(replacement.data + (trailingQuote ? arrow : ""), false);
      }
      hideSuggestions();
      term.focus();
      if (replacement && (windows || remote) && option.directory) completionTimer = window.setTimeout(() => void completeDraft(), 160);
    };
    dismissSuggestions.current = hideSuggestions;
    term.textarea?.addEventListener("blur", hideSuggestions);

    function runQueuedCommand() {
      if (closed || stopped || (tracksPrompt && (!atPrompt || draft))) return false;
      const entry = applicationQueue.shift();
      if (!entry) return false;
      setCommandsWaiting(applicationQueue.length > 0);
      const { command, directory } = entry;
      // This command already tries to enter the requested directory and show any failure.
      if (nextDirectory === directory) nextDirectory = null;
      const prefix = tracksPrompt ? internalPrefix : "";
      const location = changeShellDirectory(directory, windows);
      const guard = windows ? `try { ${location} } catch { Write-Error -ErrorRecord $_ -ErrorAction Continue; return }; ` : `${location} && `;
      const text = prefix + guard + (tracksPrompt ? shellCommand(command) : command);
      const prior = submitted.get(text);
      if (submitted.size >= 1000 && !prior) {
        const oldest = submitted.keys().next().value;
        if (oldest !== undefined) submitted.delete(oldest);
      }
      submitted.set(text, { original: command, pending: (prior?.pending ?? 0) + 1 });
      term.scrollToBottom();
      send(text + "\r", true, (error) => rejectQueuedCommands(error, true));
      return true;
    }

    function commandFailed(error: unknown) {
      reportError.current(t("Could not submit the command. {0}", errorText(describeError(error))));
    }

    function rejectQueuedCommands(error: unknown, writeFailed = false) {
      closed = true;
      if (!writeFailed && !applicationQueue.length) return;
      applicationQueue.length = 0;
      setCommandsWaiting(false);
      commandFailed(error);
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
        if (text.trim()) {
          if (remote) {
            sessionHistory.unshift(text);
            if (sessionHistory.length > 1000) sessionHistory.pop();
          }
          record.current(text);
        }
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
          send(internalPrefix + 'eval "$DIRLUME_SHELL_INIT"; unset DIRLUME_SHELL_INIT\r');
        }
        return true;
      }
      const separator = title.indexOf(":", promptPrefix.length);
      if (separator < 0) return false;
      const path = title.slice(separator + 1);
      const previousDirectory = currentDirectory;
      const previousSearchPath = sshSearchPath;
      const previousEnvironmentMarker = environmentMarker;
      try {
        if (title.slice(promptPrefix.length, separator) === "command") {
          const fields = path.split(":");
          if (fields.length === 2) recordMarker(fields[1], fields[0]);
          else recordMarker(path);
          return true;
        }
        const [directory, sequence, encoded, editor, searchPath, unixEnvironment] = path.split(":");
        if (encoded) recordMarker(encoded, sequence);
        currentDirectory = directory ? decode(directory) : null;
        editorSupported = windows ? editor === "powershell" : editor === "bash" || editor === "zsh";
        sshSearchPath = remote && searchPath !== undefined ? decode(searchPath) : null;
        environmentMarker = (windows ? searchPath : unixEnvironment) || "";
        shellEnvironment = !environmentMarker || environmentMarker.length > 65_536 ? undefined : windows
          ? JSON.parse(decode(environmentMarker)) as ShellCompletionEnvironment
          : Object.fromEntries(decode(environmentMarker).split("\0").filter(Boolean).map((field) => {
            const separator = field.indexOf("=");
            return separator < 0 ? [field, null] : [field.slice(0, separator), field.slice(separator + 1)];
          }));
      } catch { return true; }
      setShellDirectory(currentDirectory ?? "");
      if (sshSearchPath !== previousSearchPath || environmentMarker !== previousEnvironmentMarker) {
        reportCompletion.current({ searchPath: sshSearchPath ?? undefined, environment: shellEnvironment });
      }
      // ConPTY can deliver the prompt redraw for a canceled edit after the next keystroke.
      if (atPrompt && editable?.text && editorSupported && currentDirectory === previousDirectory && sshSearchPath === previousSearchPath && environmentMarker === previousEnvironmentMarker) {
        return true;
      }
      atPrompt = true;
      draft = false;
      hideSuggestions();
      editable = editorSupported ? { text: "", caret: 0 } : null;
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
        reportCompletion.current(null);
        rejectQueuedCommands(new Error(t("This terminal session has closed.")));
        editable = null;
        hideSuggestions();
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
      if (!stopped) {
        rejectQueuedCommands(error);
        term.writeln(describeError(error));
      }
    });
    function send(data: string, observe = true, onFailure?: (error: unknown) => void) {
      // Readline can redraw its current prompt after canceling an edit without running the prompt hook.
      const canceledDraft = data === "\x03" && atPrompt && editable !== null;
      if (canceledDraft) {
        draft = false;
        editable = { text: "", caret: 0 };
        hideSuggestions();
      } else if (data.endsWith("\r") || data.endsWith("\n") || data === "\x03") {
        atPrompt = false;
        draft = false;
        editable = null;
        hideSuggestions();
      } else if (!terminalReport.test(data)) {
        draft = true;
        if (observe && atPrompt && editable) {
          hideSuggestions();
          editable = trackTerminalDraft(editable, data);
          if (editable?.text.trim()) completionTimer = window.setTimeout(() => void completeDraft(), 160);
        }
      }
      queued = queued.then(async () => {
        await opening;
        if (stopped) return;
        if (closed) throw new Error(t("This terminal session has closed."));
        await api.writeTerminal(session.id, data);
      }).catch((error: unknown) => { if (!stopped) onFailure?.(error); });
      if (canceledDraft && !runQueuedCommand()) synchronize();
    }
    enqueue.current = (entry) => {
      if (!entry) {
        send("\r");
        return;
      }
      if (closed) {
        commandFailed(new Error(t("This terminal session has closed.")));
        return;
      }
      applicationQueue.push(entry);
      if (!runQueuedCommand()) setCommandsWaiting(true);
    };
    const data = term.onData((data) => send(data));
    let pasting = Promise.resolve();
    function paste() {
      pasting = pasting.then(async () => {
        if (stopped || closed || !clipboard.current.visible) return;
        const text = await api.clipboardText();
        if (!stopped && !closed && clipboard.current.visible && text) term.paste(text);
      }).catch((error: unknown) => { if (!stopped) clipboard.current.onClipboardError(error); });
    }
    function copy(text: string) {
      if (!stopped && clipboard.current.visible && text) {
        void api.copyText(text).catch((error: unknown) => {
          if (!stopped) clipboard.current.onClipboardError(error);
        });
      }
    }
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || event.isComposing) return true;
      if (options.length && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          selected = moveSuggestion(event.key, selected, options.length);
          renderSuggestions();
        } else if (event.key === "Tab" || (event.key === "Enter" && selected >= 0)) {
          chooseSuggestion.current(options[Math.max(0, selected)]);
        } else if (event.key === "Escape") hideSuggestions();
        else return true;
        event.preventDefault();
        return false;
      }
      const command = eventShortcut(event);
      if (bindingMatches(clipboard.current.copyShortcut, command)) {
        event.preventDefault();
        if (!event.repeat) copy(term.getSelection());
        return false;
      }
      if (command === "Meta+C") {
        event.preventDefault();
        return false;
      }
      if (!bindingMatches(clipboard.current.pasteShortcut, command)) {
        if (command === "Ctrl+V") event.preventDefault();
        return true;
      }
      event.preventDefault();
      if (!event.repeat) paste();
      return false;
    });
    let handledSecondaryDown = false;
    function secondaryClick(event: MouseEvent) {
      event.preventDefault();
      event.stopPropagation();
      if (clipboard.current.pasteOnRightClick) {
        term.focus();
        paste();
      } else {
        setMenu({ x: event.clientX, y: event.clientY, selection: term.getSelection(), href: linkAt(event) });
      }
    }
    function preserveSelection(event: MouseEvent) {
      handledSecondaryDown = event.button === 2 || (macClient && event.button === 0 && event.ctrlKey);
      linkMouseDown = event.button === 0 && !handledSecondaryDown ? { x: event.clientX, y: event.clientY, dragged: false } : null;
      // Handle the gesture before xterm changes the selection, including in WebViews that suppress contextmenu.
      if (handledSecondaryDown) secondaryClick(event);
    }
    function openContextMenu(event: MouseEvent) {
      if (handledSecondaryDown) {
        handledSecondaryDown = false;
        event.preventDefault();
        event.stopPropagation();
      } else if (event.button === 2 || (macClient && event.ctrlKey)) secondaryClick(event);
    }
    surface.addEventListener("mousedown", preserveSelection, true);
    surface.addEventListener("mousemove", trackLinkDrag, true);
    surface.addEventListener("contextmenu", openContextMenu, true);
    const keys = term.onKey(({ domEvent }) => {
      // xterm can leave a WebView function-key default enabled in screen reader mode.
      if (/^F\d+$/.test(domEvent.key)) domEvent.preventDefault();
    });
    const resized = term.onResize(({ rows, cols }) => {
      hoveredLink = null;
      hideSuggestions();
      resizing = resizing.then(async () => {
        await opening;
        if (!closed && !stopped) await api.resizeTerminal(session.id, rows, cols);
      }).catch(() => {});
    });
    const scrolled = term.onScroll(() => {
      hideLinkTooltip();
      if (term.buffer.active.viewportY !== term.buffer.active.baseY) hideSuggestions();
      else renderSuggestions();
    });
    const outputChanged = term.onWriteParsed(() => { hoveredLink = null; });
    const resize = new ResizeObserver(fit);
    resize.observe(surface);
    return () => {
      stopped = true;
      hideLinkTooltip();
      hideSuggestions();
      dismissSuggestions.current = () => {};
      chooseSuggestion.current = () => {};
      instance.current = null;
      enqueue.current = null;
      moveTo.current = null;
      data.dispose();
      keys.dispose();
      resized.dispose();
      scrolled.dispose();
      outputChanged.dispose();
      term.textarea?.removeEventListener("blur", hideSuggestions);
      surface.removeEventListener("mousedown", preserveSelection, true);
      surface.removeEventListener("mousemove", trackLinkDrag, true);
      surface.removeEventListener("contextmenu", openContextMenu, true);
      titles.forEach((title) => title.dispose());
      resize.disconnect();
      output.onmessage = () => {};
      term.dispose();
      void opening.then(() => api.closeTerminal(session.id)).catch(() => {});
    };
  }, [session, rowHeight, suggestionId]);

  useEffect(() => {
    if (!visible) { dismissSuggestions.current(); setMenu(null); return; }
    if (!instance.current) return;
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
  }, [theme, scheme, fontSize]);

  useEffect(() => {
    if (popup && popup.selected >= 0) document.getElementById(`${suggestionId}-${popup.selected}`)?.scrollIntoView({ block: "nearest" });
  }, [popup, suggestionId]);

  function menuAction(action: "copy" | "paste" | "selectAll" | "openLink" | "copyLink") {
    const active = instance.current;
    if (!visible || !active || !menu) return;
    setMenu(null);
    active.term.focus();
    if (action === "copy") active.copy(menu.selection);
    else if (action === "paste") active.paste();
    else if (action === "selectAll") active.term.selectAll();
    else if (menu.href && action === "openLink") active.openLink(menu.href);
    else if (menu.href) active.copy(menu.href);
  }

  return (
    <section className="terminal-card" data-font-zoom="terminal" data-help-topic="terminal" aria-label={t("Terminal")} hidden={!visible}>
      <header onClick={(event) => { if (!(event.target as Element).closest("button")) instance.current?.term.focus(); }}>
        <h2>{t(remoteTerminal ? "SSH terminal" : "Terminal")}</h2>
        <span className="terminal-location" data-tooltip={shellDirectory}>{remoteTerminal ? session.address + " · " : ""}{shellDirectory}</span>
        {focusHint}
        <Button type="button" className="icon-button" aria-label={t("Close terminal")} onClick={onClose}><X /></Button>
      </header>
      {watchEnvironment && environmentChanged && <p className="terminal-environment-notice" role="status">
        {t("Windows environment changed. Reopen the terminal to apply the updated variables.")}
      </p>}
      {commandsWaiting && <p className="terminal-environment-notice" role="status">
        {t("Command queued. It will run when the terminal is ready.")}
      </p>}
      <div className="terminal-surface" ref={container} />
      {visible && popup && <CommandSuggestions id={suggestionId} {...popup} choose={(option) => chooseSuggestion.current(option)} />}
      {visible && menu && <FileContextMenu label="Terminal actions" x={menu.x} y={menu.y}
        onClose={() => setMenu(null)} onReturn={() => instance.current?.term.focus()}>
        <Button role="menuitem" shortcut={showShortcut(copyShortcut[0])} disabled={!menu.selection} onClick={() => menuAction("copy")}>{t("Copy")}</Button>
        <Button role="menuitem" shortcut={showShortcut(pasteShortcut[0])} onClick={() => menuAction("paste")}>{t("Paste")}</Button>
        <Button role="menuitem" onClick={() => menuAction("selectAll")}>{t("Select All")}</Button>
        {menu.href && <>
          <Button role="menuitem" onClick={() => menuAction("openLink")}>{t("Open Link")}</Button>
          <Button role="menuitem" onClick={() => menuAction("copyLink")}>{t("Copy Link Address")}</Button>
        </>}
      </FileContextMenu>}
    </section>
  );
}
