import { Channel } from "@tauri-apps/api/core";
import {
  api, connectFtpLocation, isFileServer, placePath, readPlaceText, savePlaceText, textEncodingLabels, windowsClient,
  type Entry, type FileLocation, type Listing, type NamedFile, type Place, type RemotePlace, type TextDocument, type TextEncoding, type TransferEvent,
} from "./api";
import { baseThemes, builtInThemes, colorLabels, isHexColor, maxSchemeNameLength, type Palette } from "./appearance";
import { sameFolderShortcut, shortcutFromPlace, type FolderShortcuts } from "./folderShortcuts";
import { filesystemPlace, readPlace, type PaneState, type Side } from "./panes";
import type { Preferences } from "./preferences";
import { findFiles } from "./SearchDialog";
import { itemSource, nextTransferId } from "./TransferDialog";
import { invalidateDirectories, rememberedDirectory } from "./netboxDirectories";

export type McpAction = { id: string; tool: string; arguments: Record<string, unknown> };
export type McpApproval = { id: string; action: "permanent" | "trash" | "terminate"; targets: string[] };

export interface McpContext {
  active: Side;
  panes: Record<Side, PaneState>;
  preferences: Preferences;
  shortcuts: FolderShortcuts;
  load: (side: Side, place: Place) => Promise<boolean>;
  remote: (side: Side, place: RemotePlace, listing: Listing) => void;
  selection: (side: Side, names: string[]) => void;
  refresh: (side: Side) => void;
  setPreferences: (preferences: Preferences) => Promise<void>;
  setShortcuts: (shortcuts: FolderShortcuts) => void;
}

const allowedColors = new Set(Object.keys(colorLabels));
export type McpRevisions = Map<string, { file: NamedFile; contents: TextDocument }>;

function sameFile(a: NamedFile, b: NamedFile) {
  return a.name === b.name && a.place.kind === b.place.kind && placePath(a.place) === placePath(b.place) &&
    (a.place.kind === "local" || "id" in b.place && a.place.id === b.place.id);
}

function textFile(place: FileLocation, entry: Entry): NamedFile {
  if (place.kind === "kswitcher" || place.kind === "smbRoot" || entry.directory || entry.link) throw new Error("Choose a regular text file.");
  return { place, name: entry.name };
}

async function transfer(place: FileLocation, items: Entry[], destination: Place, moving: boolean) {
  if (place.kind === "smbRoot" || !items.length || (moving && (place.kind !== "local" || destination.kind !== "local")) ||
      (destination.kind !== "local" && (destination.kind !== "ftp" || place.kind !== "local"))) {
    throw new Error("This transfer is unavailable for the selected sources.");
  }
  const id = nextTransferId();
  const events = new Channel<TransferEvent>();
  events.onmessage = (event) => {
    if (event.kind === "conflict") void api.resolveTransfer(id, "skip", false).catch(() => {});
  };
  const results = [];
  await api.beginTransfer(id);
  try {
    for (const item of items) {
      const outcome = await api.transfer(id, {
        source: itemSource(place, item), destination: placePath(destination),
        ftpDestination: destination.kind === "ftp" ? destination.id : undefined,
        moving, policy: "skip", askReadOnly: false, multiple: true,
      }, events);
      results.push({ name: item.name, ...outcome });
    }
  } finally {
    await api.finishTransfer(id);
    events.onmessage = () => {};
  }
  return results;
}

export async function executeMcp({ tool, arguments: args }: McpAction, context: McpContext, revisions: McpRevisions) {
  const side = args.side === "right" ? "right" : "left";
  const pane = context.panes[side];
  const name = typeof args.name === "string" ? args.name : "";
  const names = Array.isArray(args.names) ? args.names as string[] : [];
  const string = (key: string) => {
    const value = args[key];
    if (typeof value !== "string") throw new Error("A text argument is required.");
    return value;
  };
  const requirePlace = () => {
    if (!pane.place || pane.place.kind === "connections") throw new Error("Open a source in the selected pane.");
    return pane.place;
  };
  const entries = async (place: Place) => (await readPlace(place)).listing.entries;
  const lookup = (items: Entry[], name: string) => {
    const entry = items.find((entry) => entry.name === name && name !== "..");
    if (!entry) throw new Error("The named item is not in the selected folder.");
    return entry;
  };
  const directoryChanged = () => {
    context.refresh("left");
    context.refresh("right");
    return { ok: true };
  };
  switch (tool) {
    case "workspace":
      return { active: context.active, panes: Object.fromEntries(Object.entries(context.panes).map(([side, state]) =>
        [side, { source: state.place?.kind ?? null, path: state.place ? placePath(state.place) : null,
          selected: state.selected, marked: state.marked }])) };
    case "navigate_pane": {
      const current = pane.place;
      const path = string("path");
      const place = !current || current.kind === "local" || current.kind === "smbRoot" || current.kind === "connections" ? filesystemPlace(path) :
        current.kind === "kswitcher" ? { ...current, path } :
          path.startsWith("/") ? { ...current, segments: path.split("/").filter(Boolean) } : null;
      if (!place || !await context.load(side, place)) throw new Error("The pane could not open the path.");
      return { path: placePath(place) };
    }
    case "select_items": {
      const visible = await entries(requirePlace());
      names.forEach((name) => lookup(visible, name));
      context.selection(side, [...new Set(names)]);
      return { selected: names };
    }
    case "list_directory": {
      const place = requirePlace();
      return { path: placePath(place), ...(await readPlace(place)).listing };
    }
    case "search_files": {
      const root = requirePlace();
      const mask = string("mask");
      if (!mask.trim() || mask.length > 512) throw new Error("Enter a file mask up to 512 characters.");
      const cancel = new AbortController();
      const limit = Math.max(1, Math.min(1000, Number(args.limit ?? 100)));
      const matches: { path: string; entry: Entry }[] = [];
      const timer = window.setTimeout(() => cancel.abort(), 20_000);
      try {
        const omitted = await findFiles({ root, mask, showHidden: context.preferences.hidden }, cancel.signal, (batch) => {
          for (const match of batch.slice(0, limit - matches.length)) matches.push({ path: match.relativePath, entry: match.entry });
          if (matches.length >= limit) cancel.abort();
        });
        return { matches, incomplete: omitted > 0 || cancel.signal.aborted };
      } finally { window.clearTimeout(timer); }
    }
    case "item_properties": {
      const place = requirePlace();
      const entry = lookup(await entries(place), name);
      return { entry, attributes: place.kind === "local" ? await api.fileAttributes(place.path, name) : null };
    }
    case "read_text": {
      const place = requirePlace();
      const file = textFile(place, lookup(await entries(place), name));
      const contents = await readPlaceText(file, undefined, "mcp");
      if (revisions.size >= 8) revisions.delete(revisions.keys().next().value!);
      const revision = crypto.randomUUID();
      revisions.set(revision, { file, contents });
      return { text: contents.text, encoding: contents.encoding, revision };
    }
    case "save_text": {
      const revision = string("revision");
      const previous = revisions.get(revision);
      const place = requirePlace();
      const file = textFile(place, lookup(await entries(place), name));
      if (!previous || !sameFile(file, previous.file)) throw new Error("Read the current file before saving it.");
      await savePlaceText(file, previous.contents, string("text"));
      if (isFileServer(file.place)) invalidateDirectories({ kind: file.place.kind, id: file.place.profileId });
      revisions.delete(revision);
      return directoryChanged();
    }
    case "create_entry": {
      const place = requirePlace();
      if (place.kind !== "local") throw new Error("Open a local folder to create an item.");
      const encoding = args.encoding ?? "utf8";
      if (typeof encoding !== "string" || !Object.hasOwn(textEncodingLabels, encoding)) throw new Error("Choose a supported text encoding.");
      await api.operate(place.path, args.kind === "folder" ? { kind: "create_folder", name } :
        { kind: "create_file", name, encoding: encoding as TextEncoding });
      return directoryChanged();
    }
    case "rename_item": {
      const place = requirePlace();
      const replacement = string("newName");
      if (place.kind === "local") await api.operate(place.path, { kind: "rename", name, new_name: replacement });
      else if (place.kind === "ftp") {
        await api.renameFtp(place.id, [...place.segments, name], replacement);
        invalidateDirectories({ kind: place.kind, id: place.profileId });
      }
      else throw new Error("This source does not support rename.");
      return directoryChanged();
    }
    case "transfer_items": {
      const source = requirePlace();
      const destination = context.panes[args.destination === "right" ? "right" : "left"].place;
      if (!destination) throw new Error("Open the destination pane.");
      const available = await entries(source);
      try { return await transfer(source, [...new Set(names)].map((name) => lookup(available, name)), destination, args.operation === "move"); }
      finally {
        if (isFileServer(destination)) invalidateDirectories({ kind: destination.kind, id: destination.profileId });
        directoryChanged();
      }
    }
    case "list_ftp_profiles":
      return (await api.ftpProfiles()).map(({ id, label }) => ({ id, label }));
    case "connect_ftp_profile": {
      const id = string("profileId");
      const profile = (await api.ftpProfiles()).find((item) => item.id === id);
      const remembered = profile && rememberedDirectory({ ...profile, kind: "ftp" });
      const { place, listing, unavailableFolders } = await connectFtpLocation(id, undefined, remembered);
      context.remote(side, place, listing);
      return { path: placePath(place), ...(unavailableFolders?.length ? { unavailableFolders } : {}) };
    }
    case "connect_dirlume_server": {
      const { listing, ...location } = await api.connect(string("invitation"));
      const place: RemotePlace = { kind: "server", segments: [], ...location };
      context.remote(side, place, listing);
      return { path: placePath(place) };
    }
    case "list_folder_shortcuts": return context.shortcuts;
    case "bookmark_folder": {
      const group = Number(args.group);
      const bookmark = shortcutFromPlace(pane.place);
      if (!bookmark || !Number.isInteger(group) || group < 0 || group > 9) throw new Error("Choose a local or paired folder and a group from 0 to 9.");
      const existing = context.shortcuts[group];
      if (!existing.some((item) => sameFolderShortcut(item, bookmark))) {
        context.setShortcuts(context.shortcuts.map((items, index) => index === group ? [...items, bookmark] : items));
      }
      return bookmark;
    }
    case "list_appearance_schemes": return { builtIn: builtInThemes, custom: context.preferences.schemes };
    case "create_color_scheme": {
      const base = baseThemes.find((theme) => theme === args.base);
      const title = name.trim();
      const colors = args.colors as Record<string, unknown>;
      if (!base || !title || title.length > maxSchemeNameLength) throw new Error("Choose a scheme name and a base theme.");
      if (Object.values(builtInThemes).some((label) => label.toLocaleLowerCase() === title.toLocaleLowerCase()) ||
          context.preferences.schemes.some(({ name }) => name.toLocaleLowerCase() === title.toLocaleLowerCase())) {
        throw new Error("A color scheme with this name already exists.");
      }
      for (const [key, color] of Object.entries(colors)) {
        if (!allowedColors.has(key) || typeof color !== "string" || !isHexColor(color)) throw new Error("Use valid color keys and six-digit hex colors.");
      }
      const scheme = { id: crypto.randomUUID(), name: title, base, colors: colors as Palette, fonts: {} };
      await context.setPreferences({ ...context.preferences, schemes: [...context.preferences.schemes, scheme] });
      return scheme;
    }
    case "list_processes": return api.listProcesses();
    case "find_locking_processes":
      if (!windowsClient) throw new Error("Locking process inspection is available on Windows.");
      return api.lockingProcesses(args.paths as string[]);
    default: throw new Error("Unknown Dirlume tool.");
  }
}
