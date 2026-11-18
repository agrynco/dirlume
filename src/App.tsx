import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import {
  ArrowDownToLine, ArrowLeftRight, CheckSquare, Copy, Eye, EyeOff, FileDiff, FilePlus, FolderPlus, FolderTree,
  Calculator, Menu, Pencil, Search, Server, Settings2, Terminal as TerminalIcon, TextCursorInput, Trash2,
} from "lucide-react";
import { Channel, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, describeError, placePath, windowsClient, type Entry, type KSwitcherPeer, type Listing, type NamedFile, type Operation, type Place, type QuickLocation, type RemotePlace, type SizeResult } from "./api";
import { Dialog } from "./Dialog";
import { Pane } from "./Pane";
import { SearchDialog } from "./SearchDialog";
import { Settings } from "./Settings";
import { applyAppearance } from "./appearance";
import { TextDialog, CompareDialog } from "./TextTools";
import { TransferDialog, type Transfer } from "./TransferDialog";
import {
  applyListing, childPlace, emptyPane, localPath, opposite, parentPlace, readPlace, visibleEntries,
  type PaneState, type Side, type SortColumn,
} from "./panes";
import { commandNames, commands, commandScope, eventShortcut, persistPreferences, readPreferences, showShortcut, type Command } from "./preferences";

const TerminalPanel = lazy(() => import("./TerminalPanel"));

type ActionModal =
  | { kind: "mkdir" | "rename" | "newFile"; path: string; name: string }
  | { kind: "recycle" | "delete"; path: string; names: string[] };

type Modal =
  | { kind: "settings" }
  | { kind: "connect"; side: Side }
  | ({ kind: "view" | "edit" } & NamedFile)
  | { kind: "compare"; left: NamedFile; right: NamedFile }
  | { kind: "transfer"; transfer: Transfer }
  | { kind: "search"; side: Side; place: Place }
  | { kind: "menu" | "commandHistory" }
  | ActionModal;

const rowCommands = {
  firstRow: 0, lastRow: Number.POSITIVE_INFINITY, upRow: -1, downRow: 1, pageUp: -12, pageDown: 12,
};

function shellArgument(value: string) {
  return `'${value.replaceAll("'", windowsClient ? "''" : "'\\''")}'`;
}

export default function App() {
  const [panes, setPanes] = useState({ left: emptyPane, right: emptyPane });
  const [locations, setLocations] = useState<QuickLocation[]>([]);
  const [active, setActive] = useState<Side>("left");
  const [preferences, setPreferences] = useState(readPreferences);
  const scheme = preferences.schemes.find(({ id }) => id === preferences.activeScheme) ?? null;
  const theme = scheme?.base ?? preferences.theme;
  const [modal, setModal] = useState<Modal | null>(null);
  const busy = modal?.kind === "transfer";
  const [terminal, setTerminal] = useState<{ id: number; path: string } | null>(null);
  const [panelsHidden, setPanelsHidden] = useState(false);
  const [split, setSplit] = useState(50);
  const [commandLine, setCommandLine] = useState("");
  const [pendingCommands, setPendingCommands] = useState<string[]>([]);
  const commandInput = useRef<HTMLInputElement>(null);
  const [historyItems, setHistoryItems] = useState<string[]>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem("dirlume.command-history") ?? "[]");
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 1000) : [];
    } catch { return []; }
  });
  const historyIndex = useRef(-1);
  const selectionAnchor = useRef<{ left: string | null; right: string | null }>({ left: null, right: null });
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "Ready" });
  const request = useRef({ left: 0, right: 0 });
  const nextSession = useRef(0);
  const watchId = useRef(0);
  const measureId = useRef(0);
  const scans = useRef<{ left: number | null; right: number | null }>({ left: null, right: null });
  const latest = useRef(panes);
  latest.current = panes;
  const connected = useRef<{ left: number | null; right: number | null }>({ left: null, right: null });
  const pane = panes[active];
  const other = panes[opposite(active)];
  const entries = useMemo(() => ({
    left: visibleEntries(panes.left, preferences.hidden),
    right: visibleEntries(panes.right, preferences.hidden),
  }), [panes, preferences.hidden]);
  const current = entries[active].find((entry) => entry.name === pane.selected) ?? entries[active][0];
  const local = pane.place?.kind === "local" ? pane.place : null;
  const canTransfer = Boolean(current && pane.place);

  const updatePane = useCallback((side: Side, updater: (pane: PaneState) => PaneState) => {
    setPanes((previous) => ({ ...previous, [side]: updater(previous[side]) }));
  }, []);

  const cancelScan = useCallback((side: Side) => {
    const previous = scans.current[side];
    if (previous === null) return;
    scans.current[side] = null;
    void api.cancelMeasurement(previous).catch(() => {});
    updatePane(side, (pane) => ({ ...pane, measuring: [] }));
  }, [updatePane]);

  const load = useCallback(async (side: Side, place: Place, action: "push" | "refresh" | number = "push", reveal?: string) => {
    if (action !== "refresh") cancelScan(side);
    const ticket = ++request.current[side];
    updatePane(side, (pane) => ({ ...pane, loading: true, error: "" }));
    try {
      const result = await readPlace(place);
      if (ticket !== request.current[side]) return;
      const found = reveal !== undefined && result.listing.entries.some((entry) => entry.name === reveal);
      if (reveal !== undefined && !found) setStatus({ text: `File no longer found: ${reveal}`, error: true });
      updatePane(side, (pane) => {
        const listing = applyListing(pane, result.place, result.listing, action);
        return found ? { ...listing, selected: reveal, filter: "", marked: [] } : listing;
      });
    } catch (error) {
      if (ticket === request.current[side]) {
        updatePane(side, (pane) => ({ ...pane, loading: false, error: describeError(error) }));
      }
    }
  }, [cancelScan, updatePane]);

  useEffect(() => {
    let cancelled = false;
    api.locations().then((locations) => {
      if (cancelled) return;
      setLocations(locations);
      const home = locations[0];
      const alternate = locations.find(({ label }) => label === "Downloads") ?? home;
      if (home && alternate) {
        void load("left", localPath(home.path));
        void load("right", localPath(alternate.path));
      }
    }).catch((error: unknown) => {
      if (!cancelled) setStatus({ text: describeError(error), error: true });
    });
    return () => { cancelled = true; };
  }, [load]);

  const leftPath = panes.left.place?.kind === "local" ? panes.left.place.path : null;
  const rightPath = panes.right.place?.kind === "local" ? panes.right.place.path : null;
  useEffect(() => {
    const locations = [["left", leftPath], ["right", rightPath]] as const;
    const stopWatching = locations.map(([side, path]) => {
      if (!path) return () => {};
      const id = ++watchId.current;
      let stopped = false;
      let timer: number | undefined;
      const changes = new Channel<null>();
      const refreshWatchedFolder = () => {
        const current = latest.current[side];
        if (stopped || current.place?.kind !== "local" || current.place.path !== path) return;
        if (current.loading) timer = window.setTimeout(refreshWatchedFolder, 150);
        else void load(side, current.place, "refresh");
      };
      changes.onmessage = () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(refreshWatchedFolder, 150);
      };
      const started = api.watchDirectory(id, path, changes);
      void started.catch(() => {});
      return () => {
        stopped = true;
        changes.onmessage = () => {};
        window.clearTimeout(timer);
        void started.then(() => api.unwatchDirectory(id)).catch(() => {});
      };
    });
    return () => stopWatching.forEach((stop) => stop());
  }, [leftPath, rightPath, load]);

  useEffect(() => {
    persistPreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    localStorage.setItem("dirlume.command-history", JSON.stringify(historyItems));
  }, [historyItems]);

  useLayoutEffect(() => {
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => applyAppearance(theme, scheme);
    apply();
    system.addEventListener("change", apply);
    return () => system.removeEventListener("change", apply);
  }, [theme, scheme]);

  useEffect(() => {
    if (isTauri()) {
      const nativeTheme = theme === "system" ? null : theme === "slate" ? "dark" : theme;
      void getCurrentWindow().setTheme(nativeTheme).catch(() => {});
    }
  }, [theme]);

  function focus(side: Side) {
    setActive(side);
    document.getElementById(`${side}-files`)?.focus();
  }

  function routeRemote(side: Side, place: RemotePlace, listing: Listing) {
    cancelScan(side);
    ++request.current[side];
    const previous = connected.current[side];
    if (previous !== null) void api.disconnect(previous).catch(() => {});
    connected.current[side] = place.kind === "server" ? place.id : null;
    setActive(side);
    updatePane(side, (pane) => {
      const history = pane.history.slice(0, pane.position + 1).filter((location) => location.kind === "local");
      return applyListing({ ...pane, history, position: history.length - 1 }, place, listing, "push");
    });
  }

  function open(side: Side, entry: Entry) {
    const place = panes[side].place;
    if (!place || panes[side].loading) return;
    if (entry.directory) {
      void load(side, childPlace(place, entry.name));
    } else if (place.kind === "local") {
      void api.operate(place.path, { kind: "open", name: entry.name }).catch((error: unknown) =>
        setStatus({ text: describeError(error), error: true }));
    } else {
      setStatus({ text: "Copy the remote file to a local folder to open it." });
    }
  }

  function parent(side: Side) {
    const place = panes[side].place;
    const target = place && parentPlace(place);
    if (target) void load(side, target);
  }

  function history(side: Side, offset: number) {
    const pane = panes[side];
    const position = pane.position + offset;
    const place = pane.history[position];
    if (place) void load(side, place, position);
  }

  function refresh(side: Side) {
    const { place, loading } = latest.current[side];
    if (place && !loading) void load(side, place, "refresh");
  }

  function sort(side: Side, column: SortColumn) {
    updatePane(side, (pane) => ({
      ...pane, sort: { column, asc: column !== pane.sort.column || !pane.sort.asc },
    }));
  }

  async function batch(items: string[], action: (name: string) => Promise<void>) {
    for (const [index, name] of items.entries()) {
      try {
        await action(name);
      } catch (error) {
        throw new Error(`${name} · ${describeError(error)}${index > 0 ? ` (${index} of ${items.length} completed)` : ""}`);
      }
    }
  }

  function transfer(kind: "copy" | "move") {
    const source = pane.place;
    const target = other.place;
    if (!source || !current || pane.loading) {
      setStatus({ text: "Select a file or folder in the active pane." });
      return;
    }
    const marks = entries[active].filter(({ name }) => pane.marked.includes(name));
    const items = marks.length ? marks : [current];
    if (source.kind !== "local" && kind === "move") return;
    if (source.kind !== "local" && items.some((entry) => entry.link || (source.kind === "kswitcher" && entry.directory))) {
      setStatus({ text: source.kind === "kswitcher" ? "Choose regular remote files to download." : "Choose remote files or folders without links.", error: true });
      return;
    }
    setModal({ kind: "transfer", transfer: { kind, source, items, target: target?.kind === "local" ? target.path : "" } });
  }

  function selectRow(side: Side, entry: Entry, range: boolean, mark: boolean) {
    const names = entries[side].map(({ name }) => name);
    const index = names.indexOf(entry.name);
    const anchor = names.indexOf(selectionAnchor.current[side] ?? panes[side].selected ?? entry.name);
    if (!range) selectionAnchor.current[side] = entry.name;
    const start = anchor < 0 ? index : anchor;
    const group = range ? names.slice(Math.min(index, start), Math.max(index, start) + 1) : [];
    updatePane(side, (pane) => ({
      ...pane, selected: entry.name,
      marked: range ? [...new Set([...pane.marked, ...group])] : mark
        ? pane.marked.includes(entry.name) ? pane.marked.filter((name) => name !== entry.name) : [...pane.marked, entry.name]
        : pane.marked,
    }));
  }

  function resizeSplit(value: number) {
    setSplit(Math.max(20, Math.min(80, value)));
  }

  function openTerminal() {
    if (!local) {
      setStatus({ text: "Choose a local folder to open a terminal.", error: true });
      return false;
    }
    if (!terminal) setTerminal({ id: ++nextSession.current, path: local.path });
    return true;
  }

  function closeTerminal() {
    setTerminal(null);
    setPendingCommands([]);
    setPanelsHidden(false);
    commandInput.current?.focus();
  }

  function toggleTerminal() {
    if (terminal) closeTerminal();
    else openTerminal();
  }

  function submitCommand(event: FormEvent) {
    event.preventDefault();
    if (!commandLine.trim()) {
      if (panelsHidden && terminal) setPendingCommands((commands) => [...commands, "\r"]);
      else if (current) open(active, current);
      return;
    }
    if (!local || !openTerminal()) return;
    const path = shellArgument(local.path);
    const prefix = windowsClient ? `Set-Location -LiteralPath ${path} -ErrorAction Stop; ` : `cd -- ${path} && `;
    setPendingCommands((commands) => [...commands, `${prefix}${commandLine}\r`]);
    setHistoryItems((items) => [commandLine, ...items].slice(0, 1000));
    historyIndex.current = -1;
    setCommandLine("");
  }

  function insertCommand(value: string) {
    const input = commandInput.current;
    if (!input) return;
    const start = input.selectionStart ?? commandLine.length;
    const end = input.selectionEnd ?? start;
    const quoted = /^[\p{Letter}\p{Number}_.:/\\-]+$/u.test(value) ? value : shellArgument(value);
    setCommandLine(commandLine.slice(0, start) + quoted + commandLine.slice(end));
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + quoted.length, start + quoted.length);
    });
  }

  function fileFor(side: Side): NamedFile | null {
    const place = panes[side].place;
    const entry = entries[side].find((entry) => entry.name === panes[side].selected) ?? entries[side][0];
    return place && place.kind !== "kswitcher" && entry && !entry.directory && !entry.link
      ? { place, name: entry.name } : null;
  }

  const markedFolders = entries[active].filter((entry) => entry.directory && !entry.link && pane.marked.includes(entry.name));
  const measureEntries = markedFolders.length ? markedFolders : current?.directory && !current.link ? [current] : [];

  function measure() {
    if (!local || pane.loading || !measureEntries.length) return;
    cancelScan(active);
    const id = ++measureId.current;
    scans.current[active] = id;
    const names = measureEntries.map(({ name }) => name);
    updatePane(active, (pane) => ({ ...pane, measuring: names }));
    const output = new Channel<SizeResult>();
    output.onmessage = (result) => {
      if (scans.current[active] !== id) return;
      updatePane(active, (pane) => ({
        ...pane, sizes: new Map(pane.sizes).set(result.name, result),
        measuring: pane.measuring.filter((name) => name !== result.name),
      }));
    };
    void api.measureFolders(id, local.path, names, output).catch((error: unknown) => {
      if (scans.current[active] === id) setStatus({ text: describeError(error), error: true });
    }).finally(() => {
      output.onmessage = () => {};
      if (scans.current[active] === id) {
        scans.current[active] = null;
        updatePane(active, (pane) => ({ ...pane, measuring: [] }));
      }
    });
  }

  function perform(command: Command) {
    if (command in rowCommands) {
      const items = entries[active];
      if (!items.length) return;
      const offset = rowCommands[command as keyof typeof rowCommands];
      const index = Math.max(0, items.findIndex(({ name }) => name === pane.selected));
      const next = Math.max(0, Math.min(items.length - 1, offset === 0 ? 0 : index + offset));
      updatePane(active, (pane) => ({ ...pane, selected: items[next].name }));
      return;
    }
    switch (command) {
      case "switchPane":
        if (panelsHidden) break;
        if (document.activeElement === commandInput.current) setActive(opposite(active));
        else focus(opposite(active));
        break;
      case "swap": {
        if (panes.left.loading || panes.right.loading || busy) break;
        cancelScan("left");
        cancelScan("right");
        setPanes((current) => ({ left: current.right, right: current.left }));
        connected.current = { left: connected.current.right, right: connected.current.left };
        selectionAnchor.current = { left: selectionAnchor.current.right, right: selectionAnchor.current.left };
        focus(opposite(active));
        break;
      }
      case "address": {
        const input = document.getElementById(`${active}-address`) as HTMLInputElement | null;
        input?.focus();
        input?.select();
        break;
      }
      case "open": if (current) open(active, current); break;
      case "parent": parent(active); break;
      case "back": history(active, -1); break;
      case "forward": history(active, 1); break;
      case "refreshAlternate":
      case "refresh": refresh(active); break;
      case "filter": document.getElementById(`${active}-pane`)?.dispatchEvent(new Event("dirlume-filter")); break;
      case "hidden": setPreferences({ ...preferences, hidden: !preferences.hidden }); break;
      case "settings": setModal({ kind: "settings" }); break;
      case "menu": setModal({ kind: "menu" }); break;
      case "close": void getCurrentWindow().close().catch((error: unknown) => setStatus({ text: describeError(error), error: true })); break;
      case "leftLocations":
      case "rightLocations": {
        if (panelsHidden) setPanelsHidden(false);
        const side = command === "leftLocations" ? "left" : "right";
        setActive(side);
        requestAnimationFrame(() => document.getElementById(`${side}-pane`)?.dispatchEvent(new Event("dirlume-locations")));
        break;
      }
      case "shrinkLeft": resizeSplit(split - 1); break;
      case "growLeft": resizeSplit(split + 1); break;
      case "terminal":
        if (panelsHidden) setPanelsHidden(false);
        else if (terminal || openTerminal()) setPanelsHidden(true);
        requestAnimationFrame(() => commandInput.current?.focus());
        break;
      case "commandPath":
      case "commandName":
        if (local && current) insertCommand(command === "commandPath" ? placePath(childPlace(local, current.name)) : current.name);
        break;
      case "previousCommand": {
        const previous = historyItems[historyIndex.current + 1];
        if (previous !== undefined) {
          historyIndex.current++;
          setCommandLine(previous);
          requestAnimationFrame(() => commandInput.current?.focus());
        }
        break;
      }
      case "commandHistory": setModal({ kind: "commandHistory" }); break;
      case "connect": setModal({ kind: "connect", side: active }); break;
      case "mark": {
        if (current) {
          selectRow(active, current, false, true);
          const index = entries[active].findIndex(({ name }) => name === current.name);
          const following = entries[active][index + 1];
          if (following) updatePane(active, (pane) => ({ ...pane, selected: following.name }));
        }
        break;
      }
      case "copy": if (!busy) transfer("copy"); break;
      case "move": if (!busy) transfer("move"); break;
      case "search":
        if (pane.place && !pane.loading) setModal({ kind: "search", side: active, place: pane.place });
        break;
      case "rename":
      case "newFile":
      case "mkdir":
        if (local && !busy && !pane.loading && (command !== "rename" || current)) {
          setModal({ kind: command, path: local.path, name: command === "rename" ? current.name : "" });
        }
        break;
      case "delete":
      case "recycle":
        if (local && current && !busy && !pane.loading) {
          const names = entries[active].filter(({ name }) => pane.marked.includes(name)).map(({ name }) => name);
          setModal({ kind: command, path: local.path, names: names.length ? names : [current.name] });
        }
        break;
      case "cancelMeasure":
        if (commandLine) { setCommandLine(""); historyIndex.current = -1; }
        else cancelScan(active);
        break;
      case "view":
      case "edit": {
        if (command === "view" && measureEntries.length) {
          measure();
          break;
        }
        const file = fileFor(active);
        if (file && (command === "view" || file.place.kind === "local")) setModal({ kind: command, ...file });
        break;
      }
      case "compare": {
        const place = pane.place?.kind !== "kswitcher" ? pane.place : null;
        const marked = place ? entries[active].filter((entry) => !entry.directory && !entry.link && pane.marked.includes(entry.name)) : [];
        const left = place && marked.length === 2 ? { place, name: marked[0].name } : fileFor("left");
        const right = place && marked.length === 2 ? { place, name: marked[1].name } : fileFor("right");
        if (left && right) setModal({ kind: "compare", left, right });
        else setStatus({ text: "Choose a text file in each pane to compare.", error: true });
        break;
      }
    }
  }

  function keyDown(event: KeyboardEvent) {
    if (modal || event.defaultPrevented || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    const shortcut = eventShortcut(event);
    const command = shortcut && commandNames.find((command) => commandScope(command) === "main" && preferences.shortcuts[command] === shortcut);
    if (!command) return;
    if (target.closest(".terminal-card")) return;
    const inCommandLine = target === commandInput.current;
    const onFiles = target.closest(".file-list");
    const inField = target.closest("input, select, textarea, [contenteditable]");
    const fileNavigation = command in rowCommands || command === "open";
    const fileKey = /^F\d{1,2}$/.test(event.key);
    if (inField && !fileKey && command !== "terminal" &&
        (!inCommandLine || (fileNavigation && (commandLine || panelsHidden)))) return;
    if ((fileNavigation || command === "switchPane" || command === "mark") && !onFiles && !inCommandLine) return;
    if (panelsHidden && (fileNavigation || ["mark", "copy", "move", "recycle", "delete"].includes(command))) return;
    event.preventDefault();
    perform(command);
  }

  function keyLabel(command: Command) {
    return showShortcut(preferences.shortcuts[command]);
  }

  return (
    <div className={`app${terminal ? " has-terminal" : ""}${panelsHidden ? " panels-hidden" : ""}`} onKeyDown={keyDown}>
      <header className="topbar">
        <div className="brand"><span className="brand-icon"><FolderTree /></span><h1>Dirlume</h1></div>
        <div className="top-actions">
          <button className="toolbar-button" title={keyLabel("connect")} onClick={() => perform("connect")}><Server /> Connect</button>
          <button className="icon-button" aria-label="Find files" title={keyLabel("search")} disabled={!pane.place || pane.loading}
            onClick={() => perform("search")}><Search /></button>
          <span className="separator" />
          <button className="icon-button" aria-label="Swap panes" title={keyLabel("swap")} onClick={() => perform("swap")}><ArrowLeftRight /></button>
          <button className="icon-button" aria-label="Show hidden files" aria-pressed={preferences.hidden}
            title={keyLabel("hidden")} onClick={() => perform("hidden")}>{preferences.hidden ? <Eye /> : <EyeOff />}</button>
          <button className="icon-button" aria-label="Toggle terminal" aria-pressed={terminal !== null}
            onClick={toggleTerminal}><TerminalIcon /></button>
          <button className="icon-button" aria-label="Commands" title={keyLabel("menu")} onClick={() => perform("menu")}><Menu /></button>
          <button className="icon-button" aria-label="Options" title={keyLabel("settings")} onClick={() => perform("settings")}><Settings2 /></button>
        </div>
      </header>
      <main className="workspace" hidden={panelsHidden}
        style={{ "--left-pane-width": `${split}fr`, "--right-pane-width": `${100 - split}fr` } as CSSProperties}>
        {(["left", "right"] as const).map((side) => (
          <Pane key={side} side={side} active={active === side} pane={panes[side]} entries={entries[side]} locations={locations}
            activate={() => setActive(side)} onRow={(entry, range, mark) => selectRow(side, entry, range, mark)}
            onOpen={(entry) => open(side, entry)} onPath={(path) => { void load(side, localPath(path)); }}
            onHistory={(offset) => history(side, offset)} onParent={() => parent(side)} onRefresh={() => refresh(side)}
            onFilter={(filter) => updatePane(side, (pane) => ({ ...pane, filter }))} onSort={(column) => sort(side, column)}
            onRemote={() => setModal({ kind: "connect", side })} />
        ))}
        <div className="pane-divider" role="separator" aria-label="Pane divider" aria-orientation="vertical"
          aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(split)} tabIndex={0}
          onDoubleClick={() => resizeSplit(50)}
          onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
            if (bounds) resizeSplit((event.clientX - bounds.left) / bounds.width * 100);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              resizeSplit(split + (event.key === "ArrowLeft" ? -1 : 1));
            }
          }} />
      </main>
      {terminal && (
        <Suspense fallback={<div className="terminal-card pane-empty">Opening terminal…</div>}>
          <TerminalPanel key={terminal.id} session={terminal} theme={theme} scheme={scheme} shortcut={preferences.shortcuts.terminal}
            pendingCommands={pendingCommands} onCommandsQueued={(count) => setPendingCommands((commands) => commands.slice(count))}
            onShortcut={() => perform("terminal")} onClose={closeTerminal} />
        </Suspense>
      )}
      <form className="command-bar" onSubmit={submitCommand}>
        <button type="button" className="toolbar-button" aria-pressed={terminal !== null} onClick={toggleTerminal}>
          <TerminalIcon /> Terminal
        </button>
        <span title={pane.place ? placePath(pane.place) : undefined}>{pane.place ? placePath(pane.place) : ""}</span>
        <input ref={commandInput} aria-label="Command line" type="text" value={commandLine} autoFocus autoComplete="off"
          spellCheck={false} placeholder="Enter a command" onChange={(event) => { historyIndex.current = -1; setCommandLine(event.target.value); }} />
      </form>
      <nav className="actionbar" aria-label="File actions">
        {([
          { command: "view", label: measureEntries.length ? "Measure" : "View", Icon: measureEntries.length ? Calculator : Eye,
            disabled: !fileFor(active) && (!local || !measureEntries.length) },
          { command: "edit", label: "Edit", Icon: Pencil, disabled: !local || !current || current.directory },
          { command: "copy", label: local ? "Copy" : "Download", Icon: local ? Copy : ArrowDownToLine, disabled: !canTransfer || busy },
          { command: "move", label: "Move", Icon: ArrowLeftRight, disabled: !local || !canTransfer || busy },
          { command: "rename", label: "Rename", Icon: TextCursorInput, disabled: !local || !current || busy },
          { command: "newFile", label: "New file", Icon: FilePlus, disabled: !local || busy },
          { command: "mkdir", label: "New folder", Icon: FolderPlus, disabled: !local || busy },
          { command: "recycle", label: "Trash", Icon: Trash2, disabled: !local || !current || busy },
          { command: "compare", label: "Compare", Icon: FileDiff, disabled: !pane.place || pane.place.kind === "kswitcher" },
          { command: "mark", label: "Mark", Icon: CheckSquare, disabled: !current },
        ] as const).map(({ command, label, Icon, disabled }) => (
          <button key={command} disabled={disabled} onClick={() => perform(command)} title={keyLabel(command)}>
            <Icon /><span>{label}</span>{keyLabel(command) && <kbd>{keyLabel(command)}</kbd>}
          </button>
        ))}
      </nav>
      <footer className={`statusbar${status.error ? " danger" : ""}`}>
        <span role={status.error ? "alert" : "status"} title={status.text}>
          {status.text}
        </span>
        <span>{pane.place && pane.place.kind !== "local" ? pane.place.address : "Local file system"}</span>
      </footer>
      {modal?.kind === "settings" && <Settings preferences={preferences} onChange={setPreferences} onClose={() => setModal(null)} />}
      {modal?.kind === "transfer" && (
        <TransferDialog transfer={modal.transfer} onClose={() => setModal(null)}
          onFinished={() => { refresh("left"); refresh("right"); }} />
      )}
      {modal?.kind === "search" && (
        <SearchDialog root={modal.place} showHidden={preferences.hidden} onClose={() => setModal(null)}
          onReveal={(directory, name) => {
            const { side } = modal;
            setModal(null);
            setPanelsHidden(false);
            setActive(side);
            void load(side, directory, "push", name);
            requestAnimationFrame(() => document.getElementById(`${side}-files`)?.focus());
          }} />
      )}
      {modal?.kind === "menu" && (
        <Dialog title="Commands" onClose={() => setModal(null)}>
          <div className="dialog-body command-menu">
            {(["view", "edit", "newFile", "copy", "move", "mkdir", "search", "recycle", "delete", "compare", "settings", "commandHistory"] as const)
              .map((command) => <button key={command} type="button" onClick={() => { setModal(null); perform(command); }}>
                {commands[command].label}<kbd>{keyLabel(command)}</kbd>
              </button>)}
          </div>
        </Dialog>
      )}
      {modal?.kind === "commandHistory" && <CommandHistory commands={historyItems} onClose={() => setModal(null)}
        onChoose={(line) => { setCommandLine(line); setModal(null); requestAnimationFrame(() => commandInput.current?.focus()); }} />}
      {modal?.kind === "connect" && (
        <ConnectDialog provider={preferences.provider} directory={preferences.kswitcher} onOptions={() => setModal({ kind: "settings" })}
          onConnect={(place, listing) => { routeRemote(modal.side, place, listing); setModal(null); }}
          onClose={() => setModal(null)} />
      )}
      {(modal?.kind === "view" || modal?.kind === "edit") && (
        <TextDialog file={modal} editing={modal.kind === "edit"} saveShortcut={preferences.shortcuts.saveText}
          alternateSaveShortcut={preferences.shortcuts.saveTextAlternate} closeShortcut={preferences.shortcuts.closeText}
          onSaved={() => { refresh("left"); refresh("right"); }} onClose={() => setModal(null)} />
      )}
      {modal?.kind === "compare" && <CompareDialog left={modal.left} right={modal.right}
        previousShortcut={preferences.shortcuts.previousChange} nextShortcut={preferences.shortcuts.nextChange} onClose={() => setModal(null)} />}
      {(modal?.kind === "mkdir" || modal?.kind === "rename" || modal?.kind === "newFile" || modal?.kind === "recycle" || modal?.kind === "delete") && (
        <FileDialog modal={modal} onClose={() => setModal(null)} onSubmit={async (operation) => {
          if ("names" in modal) {
            try {
              await batch(modal.names, (name) => api.operate(modal.path, { kind: modal.kind, name }));
            } finally {
              refresh("left");
              refresh("right");
            }
          } else if (operation) {
            await api.operate(modal.path, operation);
            refresh("left");
            refresh("right");
            if (modal.kind === "newFile") {
              setModal({ kind: "edit", place: { kind: "local", path: modal.path, parent: null }, name: operation.name });
              return;
            }
          }
          setModal(null);
        }} />
      )}
    </div>
  );
}

function CommandHistory({ commands, onChoose, onClose }: {
  commands: string[];
  onChoose: (command: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const matches = [...new Set(commands)].filter((command) => command.toLowerCase().includes(query.toLowerCase()));
  return (
    <Dialog title="Command history" onClose={onClose}>
      <div className="dialog-body command-menu">
        <label className="field">Search commands
          <input data-initial-focus type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        {matches.length ? matches.map((command) => <button key={command} title={command} onClick={() => onChoose(command)}>{command}</button>) :
          <p>No commands found.</p>}
      </div>
    </Dialog>
  );
}

function FileDialog({ modal, onClose, onSubmit }: {
  modal: ActionModal;
  onClose: () => void;
  onSubmit: (operation?: Operation) => Promise<void>;
}) {
  const [name, setName] = useState(modal.kind === "rename" ? modal.name : "");
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState(false);
  const titles = { mkdir: "New folder", newFile: "New file", rename: "Rename", recycle: "Move to Trash", delete: "Delete permanently" };
  const title = titles[modal.kind];
  const removing = "names" in modal;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (waiting) return;
    setWaiting(true);
    setError("");
    try {
      await onSubmit(modal.kind === "mkdir" ? { kind: "create_folder", name } :
        modal.kind === "newFile" ? { kind: "create_file", name } :
        modal.kind === "rename" ? { kind: "rename", name: modal.name, new_name: name } : undefined);
    } catch (error) {
      setError(describeError(error));
    } finally {
      setWaiting(false);
    }
  }

  return (
    <Dialog title={title} onClose={() => { if (!waiting) onClose(); }}>
      <form className="dialog-form" onSubmit={(event) => { void submit(event); }}>
        <div className="dialog-body">
          {removing
            ? <p className={modal.kind === "delete" ? "delete-warning" : undefined}>{modal.kind === "delete" ? "Permanently delete " : "Move "}
              {modal.names.length === 1 ? <strong>{modal.names[0]}</strong> : `${modal.names.length} items`}
              {modal.kind === "delete" ? "?" : " to Trash?"}</p>
            : <label className="field">Name
              <input data-initial-focus value={name} type="text" required onChange={(event) => setName(event.target.value)}
                onFocus={(event) => { if (modal.kind === "rename") event.currentTarget.select(); }} />
            </label>}
          {error && <p className="dialog-error" role="alert">{error}</p>}
        </div>
        <div className="dialog-footer">
          <button type="button" data-initial-focus={removing ? true : undefined} onClick={onClose} disabled={waiting}>Cancel</button>
          <button type="submit" className={removing ? "negative" : "primary"}
            disabled={waiting || (!removing && (!name || name === modal.name && modal.kind === "rename"))}>
            {waiting ? "Working…" : modal.kind === "mkdir" || modal.kind === "newFile" ? "Create" : title}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ConnectDialog({ provider, directory, onConnect, onOptions, onClose }: {
  provider: "server" | "kswitcher";
  directory: string;
  onConnect: (place: RemotePlace, listing: Listing) => void;
  onOptions: () => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState("");
  const [bridge, setBridge] = useState<boolean | null>(null);
  const [peers, setPeers] = useState<KSwitcherPeer[]>([]);

  useEffect(() => {
    if (provider !== "kswitcher" || !directory) return;
    let current = true;
    api.hasKSwitcherBridge(directory).then(async (available) => {
      if (!current) return;
      setBridge(available);
      if (available) {
        const peers = await api.kswitcherPeers(directory);
        if (current) {
          setPeers(peers);
          setValue(peers[0]?.id ?? "");
        }
      }
    }).catch((error: unknown) => { if (current) setError(describeError(error)); });
    return () => { current = false; };
  }, [provider, directory]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (waiting) return;
    setWaiting(true);
    setError("");
    try {
      if (provider === "kswitcher") {
        if (bridge) {
          const peer = peers.find((peer) => peer.id === value);
          if (!peer) return;
          const listing = await api.listKSwitcher(directory, peer.id, "");
          onConnect({ kind: "kswitcher", directory, peer: peer.id, address: peer.name, path: "", parent: listing.parent }, listing);
        } else {
          await api.openKSwitcher(directory);
          onClose();
        }
      } else {
        const { id, address, listing } = await api.connect(value);
        onConnect({ kind: "server", id, address, segments: [] }, listing);
      }
    } catch (error) {
      setError(describeError(error));
    } finally {
      setWaiting(false);
    }
  }

  return (
    <Dialog title={provider === "server" ? "Connect to Dirlume server" : "Connect through KSwitcher"}
      onClose={() => { if (!waiting) onClose(); }}>
      <form className="dialog-form" onSubmit={(event) => { void submit(event); }}>
        <div className="dialog-body">
          {provider === "server" ? (
            <label className="field">Server invitation
              <input data-initial-focus type="password" autoComplete="off" spellCheck={false} required
                placeholder="Paste the invitation from the remote machine" value={value}
                onChange={(event) => setValue(event.target.value)} />
            </label>
          ) : bridge === true && peers.length ? (
            <label className="field">Paired machine
              <select data-initial-focus value={value} onChange={(event) => setValue(event.target.value)}>
                {peers.map((peer) => <option key={peer.id} value={peer.id}>{peer.name}</option>)}
              </select>
            </label>
          ) : bridge === true ? (
            <p>Run KSwitcher on both computers and enable file browsing for the paired machine.</p>
          ) : bridge === false ? (
            <p>Open KSwitcher Files and select a paired machine from its source menu.</p>
          ) : (
            <p>{directory ? "Looking for the KSwitcher bridge…" : "Choose the KSwitcher installation folder in Options."}</p>
          )}
          {error && <p className="dialog-error" role="alert">{error}</p>}
        </div>
        <div className="dialog-footer">
          <button type="button" onClick={onOptions} disabled={waiting}>Connection options</button>
          <button type="submit" className="primary" disabled={waiting || (provider === "kswitcher" && bridge === null) || (bridge !== false && !value.trim())}>
            {waiting ? "Connecting…" : bridge === false ? "Open KSwitcher Files" : "Connect"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
