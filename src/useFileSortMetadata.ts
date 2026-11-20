import { useCallback, useEffect, useMemo, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { api, windowsClient, type Entry, type PanelMetadata, type PanelMetadataRequest, type SortMetadataField } from "./api";
import { defaultSortCriteria, sortMode, type SortMode, type SortSettings } from "./fileSort";
import type { PaneState } from "./panes";

const nativeFields = ["created", "accessed", "changed", "allocated", "streamCount", "streamSize"] as const;
const optionalFields = new Set<SortMode>([...nativeFields, "owner", "hardLinks", "description"]);
const emptyMetadata = new Map<string, PanelMetadata>();
const emptyDescriptions = new Map<string, string>();

export function parseDescriptions(text: string, insensitive: boolean) {
  const results = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const record = /^(?:"([^"]+)"|(\S+))\s+(.+)$/.exec(line.trim());
    if (!record) continue;
    const name = record[1] ?? record[2];
    const description = record[3].split("\u0004", 1)[0].trim();
    if (description) results.set(insensitive ? name.toLocaleLowerCase() : name, description);
  }
  return results;
}

export function useFileSortMetadata(pane: PaneState, settings: SortSettings, showMenu: boolean) {
  const mode = sortMode(pane.sort.column);
  const criteria = settings.criteria[mode] ?? defaultSortCriteria(mode);
  const selectedFields = [mode, ...criteria.map(({ mode }) => mode)].filter((field) => optionalFields.has(field));
  const fields = selectedFields.join(",");
  const place = pane.place;
  const local = place?.kind === "local" ? place.path : null;
  const search = pane.search;
  const listing = pane.entries;
  const paths = useMemo(() => search ? [...search.matches.values()].map(({ directory, entry, relativePath }) => ({
    local: directory.kind === "local" ? directory.path : null,
    entry, name: relativePath,
  })) : listing.map((entry) => ({ local, entry, name: entry.name })), [local, listing, search]);

  const streamNeeded = windowsClient && !!local && (showMenu || selectedFields.some((field) => field === "streamCount" || field === "streamSize"));
  const [streamSupport, setStreamSupport] = useState<{ local: string; supported: boolean }>();
  useEffect(() => {
    if (!streamNeeded || !local || streamSupport?.local === local || !isTauri()) return;
    let current = true;
    void api.streamSortSupported(local).catch(() => false).then((supported) => {
      if (current) setStreamSupport({ local, supported });
    });
    return () => { current = false; };
  }, [streamNeeded, local, streamSupport?.local]);
  const supportsStreams = streamSupport?.local === local && streamSupport?.supported === true;
  const canSort = useCallback((field: SortMode) => {
    if (!optionalFields.has(field)) return true;
    if (field === "streamSize" || field === "streamCount") return supportsStreams;
    if (local) return true;
    return paths.some(({ local, entry }) => local || remoteSortValue(entry, field) != null);
  }, [local, paths, supportsStreams]);

  const [stored, setStored] = useState<{
    paths: typeof paths; key: string; metadata: Map<string, PanelMetadata>; descriptions: Map<string, string>;
  }>();
  const key = fields + ":" + Number(supportsStreams);
  useEffect(() => {
    if (!fields || !isTauri()) return;
    const selected = new Set(fields.split(","));
    const owner = selected.has("owner");
    const links = selected.has("hardLinks");
    const sortFields: SortMetadataField[] = nativeFields.filter((field) => selected.has(field) &&
      (supportsStreams || (field !== "streamCount" && field !== "streamSize")));
    const requests = paths.flatMap(({ local, entry, name }) => {
      if (!local || (!owner && !links && !sortFields.length)) return [];
      const item: PanelMetadataRequest = {
        directory: local, name: entry.name, owner: owner && entry.owner == null,
        links: links && !entry.directory && !entry.link && entry.hardLinks == null, sortFields,
      };
      return item.owner || item.links || sortFields.length ? [{ name, item }] : [];
    });
    let current = true;
    async function load() {
      const descriptions = new Map<string, string>();
      if (selected.has("description")) {
        const directories = new Map<string, { name: string; entry: Entry }[]>();
        for (const { local, name, entry } of paths) {
          if (!local) continue;
          const items = directories.get(local) ?? [];
          items.push({ name, entry });
          directories.set(local, items);
        }
        for (const [directory, items] of directories) {
          if (!current) return;
          const known = items.find(({ entry }) => entry.name.toLowerCase() === "descript.ion" && !entry.directory && !entry.link);
          const file = known?.entry.name ?? (search ? "descript.ion" : null);
          if (!file) continue;
          const text = await api.readText(directory, file).then((file) => file.text, () => "");
          const names = parseDescriptions(text, windowsClient);
          for (const { name, entry } of items) {
            const description = names.get(windowsClient ? entry.name.toLocaleLowerCase() : entry.name);
            if (description) descriptions.set(name, description);
          }
        }
      }

      const metadata = new Map<string, PanelMetadata>();
      for (let offset = 0; offset < requests.length && current; offset += 64) {
        const batch = requests.slice(offset, offset + 64);
        const results = await api.panelMetadata(batch.map(({ item }) => item)).catch(() => []);
        for (const [index, result] of results.entries()) metadata.set(batch[index].name, result);
      }
      if (current) setStored({ paths, key, metadata, descriptions });
    }
    void load();
    return () => { current = false; };
  }, [key, fields, paths, search, supportsStreams]);

  const fresh = stored?.paths === paths && stored.key === key;
  return {
    canSort,
    metadata: fresh ? stored.metadata : emptyMetadata,
    descriptions: fresh ? stored.descriptions : emptyDescriptions,
    pending: !!fields && !fresh && paths.some(({ local }) => local),
  };
}

function remoteSortValue(entry: Entry, field: SortMode) {
  if (field === "description" || field === "owner" || field === "hardLinks" || field === "created" ||
      field === "accessed" || field === "changed" || field === "allocated") return entry[field];
}
