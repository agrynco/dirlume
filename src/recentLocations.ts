import { folderLabel, uncParts, windowsClient, type Place } from "./api";

const key = "dirlume.recent-locations.v1";
export const recentLocationLimit = 100;

type Description = { name: string; source: string };
export type RecentLocation = Description & (
  | { kind: "local" | "smb"; path: string }
  | { kind: "kswitcher"; path: string; peer: string }
  | { kind: "ftp" | "ssh" | "server"; segments: string[]; profileId: string }
);

export function recentLocation(place: Place): RecentLocation | null {
  const name = folderLabel(place);
  switch (place.kind) {
    case "local": {
      const [host, share] = uncParts(place.path);
      if (host && !share) return null;
      return { kind: host ? "smb" : "local", path: place.path, name, source: host ?? "" };
    }
    case "kswitcher":
      return place.path ? { kind: place.kind, path: place.path, peer: place.peer, name, source: place.address } : null;
    case "ftp":
    case "ssh":
    case "server":
      return place.profileId ? { kind: place.kind, profileId: place.profileId, segments: place.segments,
        name, source: place.address } : null;
    default: return null;
  }
}

export function recentPath(location: RecentLocation) {
  return "path" in location ? location.path : "/" + location.segments.join("/");
}

export function recentLocationKey(location: RecentLocation) {
  if ("segments" in location) return JSON.stringify([location.kind, location.profileId, location.segments]);
  const path = location.kind !== "local" || windowsClient
    ? location.path.replaceAll("/", "\\").replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/\\+$/, "").toLowerCase()
    : location.path;
  return JSON.stringify([location.kind, "peer" in location ? location.peer : "", path]);
}

function decode(item: unknown): RecentLocation | null {
  if (!item || typeof item !== "object") return null;
  const { kind, name, source, path, peer, profileId, segments } = item as Record<string, unknown>;
  if (typeof name !== "string" || typeof source !== "string") return null;
  if ((kind === "local" || kind === "smb") && typeof path === "string" && path) {
    return { kind, name, source, path };
  }
  if (kind === "kswitcher" && typeof path === "string" && path && typeof peer === "string" && peer) {
    return { kind, name, source, path, peer };
  }
  if ((kind === "ftp" || kind === "ssh" || kind === "server") && typeof profileId === "string" && profileId &&
    Array.isArray(segments) && segments.every((part) => typeof part === "string" && !part.includes("/"))) {
    return { kind, name, source, profileId, segments };
  }
  return null;
}

export function readRecentLocations(): RecentLocation[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(stored)) return [];
    const unique = new Map<string, RecentLocation>();
    for (const value of stored) {
      const item = decode(value);
      if (!item) continue;
      const identity = recentLocationKey(item);
      if (!unique.has(identity)) unique.set(identity, item);
      if (unique.size === recentLocationLimit) break;
    }
    return [...unique.values()];
  } catch { return []; }
}

export function persistRecentLocations(locations: readonly RecentLocation[]) {
  localStorage.setItem(key, JSON.stringify(locations));
}
