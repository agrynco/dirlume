import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  ArrowDownToLine, ArrowLeftRight, Copy, Eye, EyeOff, FileDiff, FolderPlus, FolderTree,
  LoaderCircle, Pencil, Server, Settings2, Trash2,
} from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, describeError, type Entry, type KSwitcherPeer, type Listing, type Operation, type Place, type QuickLocation, type RemotePlace } from "./api";
import { Dialog } from "./Dialog";
import { Pane } from "./Pane";
import { Settings } from "./Settings";
import { TextDialog, CompareDialog } from "./TextTools";
import {
  applyListing, childPlace, emptyPane, localPath, opposite, parentPlace, readPlace, visibleEntries,
  type PaneState, type Side, type SortColumn,
} from "./panes";
import { commandNames, eventShortcut, persistPreferences, readPreferences, showShortcut, type Command } from "./preferences";

type ActionModal =
  | { kind: "mkdir" | "rename"; path: string; name: string }
  | { kind: "recycle"; path: string; names: string[] };

type Modal =
  | { kind: "settings" }
  | { kind: "connect"; side: Side }
  | { kind: "view" | "edit"; path: string; name: string }
  | { kind: "compare"; left: NamedFile; right: NamedFile }
  | ActionModal;

export interface NamedFile {
  path: string;
  name: string;
}

const rowCommands = {
  firstRow: 0, lastRow: Number.POSITIVE_INFINITY, upRow: -1, downRow: 1, pageUp: -12, pageDown: 12,
};

export default function App() {
  const [panes, setPanes] = useState({ left: emptyPane, right: emptyPane });
  const [locations, setLocations] = useState<QuickLocation[]>([]);
  const [active, setActive] = useState<Side>("left");
  const [preferences, setPreferences] = useState(readPreferences);
  const [modal, setModal] = useState<Modal | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "Ready" });
  const request = useRef({ left: 0, right: 0 });
  const running = useRef(false);
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
  const canTransfer = Boolean(current && other.place?.kind === "local");

  const updatePane = useCallback((side: Side, updater: (pane: PaneState) => PaneState) => {
    setPanes((previous) => ({ ...previous, [side]: updater(previous[side]) }));
  }, []);

  const load = useCallback(async (side: Side, place: Place, action: "push" | "refresh" | number = "push") => {
    const ticket = ++request.current[side];
    updatePane(side, (pane) => ({ ...pane, loading: true, error: "" }));
    try {
      const result = await readPlace(place);
      if (ticket === request.current[side]) updatePane(side, (pane) => applyListing(pane, result.place, result.listing, action));
    } catch (error) {
      if (ticket === request.current[side]) {
        updatePane(side, (pane) => ({ ...pane, loading: false, error: describeError(error) }));
      }
    }
  }, [updatePane]);

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

  useEffect(() => {
    persistPreferences(preferences);
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const theme = preferences.theme === "system" ? system.matches ? "dark" : "light" : preferences.theme;
      document.documentElement.dataset.theme = theme;
    };
    apply();
    system.addEventListener("change", apply);
    return () => system.removeEventListener("change", apply);
  }, [preferences]);

  useEffect(() => {
    if (isTauri()) {
      const theme = preferences.theme === "system" ? null : preferences.theme === "slate" ? "dark" : preferences.theme;
      void getCurrentWindow().setTheme(theme).catch(() => {});
    }
  }, [preferences.theme]);

  function focus(side: Side) {
    setActive(side);
    document.getElementById(`${side}-files`)?.focus();
  }

  function routeRemote(side: Side, place: RemotePlace, listing: Listing) {
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

  async function run(label: string, task: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setStatus({ text: label });
    try {
      await task();
      setStatus({ text: "Completed" });
      refresh("left");
      refresh("right");
    } catch (error) {
      setStatus({ text: describeError(error), error: true });
      refresh("left");
      refresh("right");
    } finally {
      running.current = false;
      setBusy(false);
    }
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
    if (!source || target?.kind !== "local" || !current || pane.loading || other.loading) return;
    const marks = entries[active].filter(({ name }) => pane.marked.includes(name));
    const items = marks.length ? marks : [current];
    if (source.kind !== "local" && kind === "move") return;
    if (source.kind !== "local" && items.some((entry) => entry.directory || entry.link)) {
      setStatus({ text: "Choose regular remote files to download.", error: true });
      return;
    }
    void run(kind === "copy" ? "Copying…" : "Moving…", () => batch(items.map((item) => item.name), (name) => {
      if (source.kind === "local") return api.operate(source.path, { kind, name, target: target.path });
      if (source.kind === "server") return api.download(source.id, [...source.segments, name], target.path);
      const file = childPlace(source, name) as typeof source;
      return api.downloadKSwitcher(source.directory, source.peer, file.path, name, target.path);
    }));
  }

  function fileFor(side: Side): NamedFile | null {
    const place = panes[side].place;
    const entry = entries[side].find((entry) => entry.name === panes[side].selected) ?? entries[side][0];
    return place?.kind === "local" && entry && !entry.directory ? { path: place.path, name: entry.name } : null;
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
      case "switchPane": focus(opposite(active)); break;
      case "swap": {
        if (panes.left.loading || panes.right.loading || busy) break;
        setPanes({ left: panes.right, right: panes.left });
        connected.current = { left: connected.current.right, right: connected.current.left };
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
      case "refresh": refresh(active); break;
      case "filter": document.getElementById(`${active}-pane`)?.dispatchEvent(new Event("dirlume-filter")); break;
      case "hidden": setPreferences({ ...preferences, hidden: !preferences.hidden }); break;
      case "settings": setModal({ kind: "settings" }); break;
      case "connect": setModal({ kind: "connect", side: active }); break;
      case "mark": {
        if (current) updatePane(active, (pane) => ({
          ...pane, selected: current.name,
          marked: pane.marked.includes(current.name) ? pane.marked.filter((name) => name !== current.name) : [...pane.marked, current.name],
        }));
        break;
      }
      case "copy": if (!busy) transfer("copy"); break;
      case "move": if (!busy) transfer("move"); break;
      case "rename":
      case "mkdir":
        if (local && !busy && !pane.loading && (command === "mkdir" || current)) {
          setModal({ kind: command, path: local.path, name: command === "rename" ? current.name : "" });
        }
        break;
      case "recycle":
        if (local && current && !busy && !pane.loading) {
          const names = entries[active].filter(({ name }) => pane.marked.includes(name)).map(({ name }) => name);
          setModal({ kind: "recycle", path: local.path, names: names.length ? names : [current.name] });
        }
        break;
      case "view":
      case "edit": {
        const file = fileFor(active);
        if (file) setModal({ kind: command, ...file });
        break;
      }
      case "compare": {
        const marked = local ? entries[active].filter((entry) => !entry.directory && pane.marked.includes(entry.name)) : [];
        const left = local && marked.length === 2 ? { path: local.path, name: marked[0].name } : fileFor("left");
        const right = local && marked.length === 2 ? { path: local.path, name: marked[1].name } : fileFor("right");
        if (left && right) setModal({ kind: "compare", left, right });
        else setStatus({ text: "Choose a local text file in each pane to compare.", error: true });
        break;
      }
    }
  }

  function keyDown(event: KeyboardEvent) {
    if (modal || event.defaultPrevented || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, select, textarea, [contenteditable]")) return;
    const shortcut = eventShortcut(event);
    const command = shortcut && commandNames.find((command) => preferences.shortcuts[command] === shortcut);
    if (!command || command === "saveText") return;
    if ((command in rowCommands || command === "switchPane" || command === "mark" || command === "open") &&
        !target.closest(".file-list")) return;
    event.preventDefault();
    perform(command);
  }

  function keyLabel(command: Command) {
    return showShortcut(preferences.shortcuts[command]);
  }

  return (
    <div className="app" onKeyDown={keyDown}>
      <header className="topbar">
        <div className="brand"><span className="brand-icon"><FolderTree /></span><h1>Dirlume</h1></div>
        <div className="top-actions">
          <button className="toolbar-button" title={keyLabel("connect")} onClick={() => perform("connect")}><Server /> Connect</button>
          <span className="separator" />
          <button className="icon-button" aria-label="Swap panes" title={keyLabel("swap")} onClick={() => perform("swap")}><ArrowLeftRight /></button>
          <button className="icon-button" aria-label="Show hidden files" aria-pressed={preferences.hidden}
            title={keyLabel("hidden")} onClick={() => perform("hidden")}>{preferences.hidden ? <Eye /> : <EyeOff />}</button>
          <button className="icon-button" aria-label="Options" title={keyLabel("settings")} onClick={() => perform("settings")}><Settings2 /></button>
        </div>
      </header>
      <main className="workspace">
        {(["left", "right"] as const).map((side) => (
          <Pane key={side} side={side} active={active === side} pane={panes[side]} entries={entries[side]} locations={locations}
            activate={() => setActive(side)} onRow={(entry) => updatePane(side, (pane) => ({ ...pane, selected: entry.name }))}
            onOpen={(entry) => open(side, entry)} onPath={(path) => { void load(side, localPath(path)); }}
            onHistory={(offset) => history(side, offset)} onParent={() => parent(side)} onRefresh={() => refresh(side)}
            onFilter={(filter) => updatePane(side, (pane) => ({ ...pane, filter }))} onSort={(column) => sort(side, column)}
            onRemote={() => setModal({ kind: "connect", side })} />
        ))}
      </main>
      <nav className="actionbar" aria-label="File actions">
        {([
          { command: "view", label: "View", Icon: Eye, disabled: !local || !current || current.directory },
          { command: "edit", label: "Edit", Icon: Pencil, disabled: !local || !current || current.directory },
          { command: "copy", label: local ? "Copy" : "Download", Icon: local ? Copy : ArrowDownToLine, disabled: !canTransfer || busy },
          { command: "move", label: "Move", Icon: ArrowLeftRight, disabled: !local || !canTransfer || busy },
          { command: "mkdir", label: "New folder", Icon: FolderPlus, disabled: !local || busy },
          { command: "recycle", label: "Trash", Icon: Trash2, disabled: !local || !current || busy },
          { command: "compare", label: "Compare", Icon: FileDiff, disabled: !local },
        ] as const).map(({ command, label, Icon, disabled }) => (
          <button key={command} disabled={disabled} onClick={() => perform(command)} title={keyLabel(command)}>
            <Icon /><span>{label}</span>{keyLabel(command) && <kbd>{keyLabel(command)}</kbd>}
          </button>
        ))}
      </nav>
      <footer className={`statusbar${status.error ? " danger" : ""}`}>
        <span role={status.error ? "alert" : "status"} title={status.text}>
          {busy && <LoaderCircle className="spin" />} {status.text}
        </span>
        <span>{pane.place && pane.place.kind !== "local" ? pane.place.address : "Local file system"}</span>
      </footer>
      {modal?.kind === "settings" && <Settings preferences={preferences} onChange={setPreferences} onClose={() => setModal(null)} />}
      {modal?.kind === "connect" && (
        <ConnectDialog provider={preferences.provider} directory={preferences.kswitcher} onOptions={() => setModal({ kind: "settings" })}
          onConnect={(place, listing) => { routeRemote(modal.side, place, listing); setModal(null); }}
          onClose={() => setModal(null)} />
      )}
      {(modal?.kind === "view" || modal?.kind === "edit") && (
        <TextDialog file={modal} editing={modal.kind === "edit"} saveShortcut={preferences.shortcuts.saveText}
          onSaved={() => { refresh("left"); refresh("right"); }} onClose={() => setModal(null)} />
      )}
      {modal?.kind === "compare" && <CompareDialog left={modal.left} right={modal.right}
        previousShortcut={preferences.shortcuts.previousChange} nextShortcut={preferences.shortcuts.nextChange} onClose={() => setModal(null)} />}
      {(modal?.kind === "mkdir" || modal?.kind === "rename" || modal?.kind === "recycle") && (
        <FileDialog modal={modal} onClose={() => setModal(null)} onSubmit={async (operation) => {
          if (modal.kind === "recycle") {
            try {
              await batch(modal.names, (name) => api.operate(modal.path, { kind: "recycle", name }));
            } finally {
              refresh("left");
              refresh("right");
            }
          } else if (operation) {
            await api.operate(modal.path, operation);
            refresh("left");
            refresh("right");
          }
          setModal(null);
        }} />
      )}
    </div>
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
  const title = modal.kind === "mkdir" ? "New folder" : modal.kind === "rename" ? "Rename" : "Move to Trash";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (waiting) return;
    setWaiting(true);
    setError("");
    try {
      await onSubmit(modal.kind === "mkdir" ? { kind: "create_folder", name } :
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
          {modal.kind === "recycle"
            ? <p>Move {modal.names.length === 1 ? <strong>{modal.names[0]}</strong> : `${modal.names.length} items`} to Trash?</p>
            : <label className="field">Name
              <input data-initial-focus value={name} type="text" required onChange={(event) => setName(event.target.value)}
                onFocus={(event) => { if (modal.kind === "rename") event.currentTarget.select(); }} />
            </label>}
          {error && <p className="dialog-error" role="alert">{error}</p>}
        </div>
        <div className="dialog-footer">
          <button type="button" data-initial-focus={modal.kind === "recycle" ? true : undefined} onClick={onClose} disabled={waiting}>Cancel</button>
          <button type="submit" className={modal.kind === "recycle" ? "negative" : "primary"}
            disabled={waiting || (modal.kind !== "recycle" && (!name || name === modal.name && modal.kind === "rename"))}>
            {waiting ? "Working…" : modal.kind === "mkdir" ? "Create" : title}
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
