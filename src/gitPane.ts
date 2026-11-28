import { useEffect, useState } from "react";
import { api, smbHost, watchDirectory, type Entry, type GitPaneSource, type GitPaneStatus, type GitWorkingChange, type Place } from "./api";
import { t } from "./i18n";

function gitSource(place: Place | null): GitPaneSource | null {
  if (place?.kind === "local" && !smbHost(place) && !place.smb) return { kind: "local", directory: place.path };
  if (place?.kind === "ssh") return { kind: "ssh", id: place.id, segments: place.segments };
  return null;
}

export type GitPaneListing = {
  source: GitPaneSource;
  status: GitPaneStatus;
  files: ReadonlyMap<string, GitWorkingChange[]>;
  folders: ReadonlySet<string>;
};

export function useGitPane(place: Place | null, pending: boolean, entries: readonly Entry[], revision: number) {
  const key = JSON.stringify(gitSource(place));
  const [result, setResult] = useState<{ key: string; listing?: GitPaneListing; unavailable?: string }>();
  const [metadataRevision, setMetadataRevision] = useState(0);
  const metadata = result?.key === key ? result.listing?.status.metadata : null;
  useEffect(() => {
    if (!metadata) return;
    const watch = watchDirectory(metadata, () => setMetadataRevision((value) => value + 1));
    void watch.ready.catch(() => {});
    return watch.stop;
  }, [metadata]);
  useEffect(() => {
    const source = JSON.parse(key) as GitPaneSource | null;
    if (!source || pending) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void api.gitPaneStatus(source).then((status) => {
        if (!current || !status) return;
        const files = new Map<string, GitWorkingChange[]>();
        const folders = new Set<string>();
        for (const change of status.changes) {
          const atPath = files.get(change.path);
          if (atPath) atPath.push(change);
          else files.set(change.path, [change]);
          for (const path of [change.path, change.previousPath]) {
            if (!path) continue;
            for (let end = path.indexOf("/"); end >= 0; end = path.indexOf("/", end + 1)) folders.add(path.slice(0, end));
          }
        }
        setResult({ key, listing: { source, status, files, folders } });
      }, (failure: unknown) => {
        if (!current) return;
        const error = String(failure);
        setResult({ key, unavailable: error === "notRepository" ? undefined : error });
      });
    }, 100);
    return () => { current = false; window.clearTimeout(timer); };
  }, [key, pending, entries, revision, metadataRevision]);
  return result?.key === key ? result : undefined;
}

export function gitPanePath(listing: GitPaneListing, entry: Entry) {
  return listing.status.prefix + (entry.tree?.segments.join("/") ?? entry.name);
}

const groupNames = { staged: "Staged", unstaged: "Unstaged", untracked: "Untracked" } as const;
const changeNames: Readonly<Record<string, string>> = { A: "Added", M: "Modified", R: "Renamed", D: "Deleted", C: "Copied", T: "Type changed", U: "Conflict" };

export function gitChangeLabel({ group, status }: GitWorkingChange) {
  const state = changeNames[status];
  return state ? t("{0}: {1}", t(groupNames[group]), t(state)) : t(groupNames[group]);
}

export type GitPaneAction = "diff" | "compare" | "history";
