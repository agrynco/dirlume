import {
  api, isFileServer, isWritableServerPlace, placeAddress, placePath, smbHost, windowsClient,
  type ArchivePlace, type FilePlace, type FileServerPlace,
  type KSwitcherPlace, type WritableServerPlace,
} from "./api";
import { t } from "./i18n";
import { parentPath } from "./panes";

export type MoveDestination = {
  path: string;
  remote?: FileServerPlace;
  server?: WritableServerPlace;
  archive?: ArchivePlace;
  kswitcher?: KSwitcherPlace;
  googleDrive?: { profile: string; parent: string };
  broker?: boolean;
};

function connectionPrefix(place: FilePlace) {
  if (place.kind === "googleDrive") return `${place.email || place.address}:/`;
  if (isFileServer(place)) return place.origin.replace(/\/+$/, "") + "/";
  if (place.kind === "server") return place.origin.replace(/\/+$/, "") + "/" + place.share + "/";
  if (place.kind === "kswitcher") return "kswitcher://" + encodeURIComponent(place.peer) + "/";
  if (place.kind === "archive") return place.path + "!/";
  if (place.smb) return placeAddress({ ...place, path: place.smb.root }).replace(/\/+$/, "") + "/";
}

export function movePath(place: FilePlace) {
  const prefix = connectionPrefix(place);
  if (place.kind === "googleDrive") return prefix + placePath(place);
  if (place.kind === "kswitcher") return prefix + place.path.split(/[\\/]/).filter(Boolean).join("/");
  if (place.kind === "archive" || place.kind === "server" || isFileServer(place)) {
    return prefix + place.segments.join("/");
  }
  return placeAddress(place);
}

export function isLocalMovePath(path: string) {
  return !path.includes("!/") && (windowsClient ? /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(path) : path.startsWith("/"));
}

function routePlace(place: FilePlace, source: FilePlace): MoveDestination {
  const path = placePath(place);
  if (place.kind === "googleDrive") {
    return { path: movePath(place), googleDrive: { profile: place.id, parent: place.folders.at(-1)?.id ?? "root" } };
  }
  if (place.kind === "archive") {
    if (!place.canAdd) throw new Error(t("Choose a writable ZIP or 7z archive."));
    return { path, archive: place };
  }
  if (isFileServer(place)) return { path, remote: place };
  if (place.kind === "server") {
    if (!isWritableServerPlace(place)) throw new Error(t("This source is read-only."));
    return { path, server: place };
  }
  if (place.kind === "kswitcher") {
    if (!place.capabilities?.write) throw new Error(t("Grant the required file permission in Trusted clients."));
    return { path, kswitcher: place, broker: source.kind === "local" || source.kind === "kswitcher" };
  }
  if (source.kind === "googleDrive" && smbHost(place)) {
    throw new Error(t("Choose a local folder or a Google Drive folder in the other pane."));
  }
  return { path, broker: source.kind === "kswitcher" && !!source.capabilities?.delete };
}

async function driveFolder(path: string, account: string, segments: string[]): Promise<MoveDestination> {
  const profiles = (await api.googleDriveProfiles()).filter((profile) =>
    profile.email.toLowerCase() === account.toLowerCase());
  if (profiles.length !== 1) throw new Error(t("Choose a connected Google Drive account. {0}", account));
  if (profiles[0].signInNeeded) throw new Error(t("Sign in to this Google Drive account again."));
  const profile = profiles[0].id;
  let parent = "root";
  for (const segment of segments) {
    const folders = (await api.listGoogleDrive(profile, parent)).filter((item) => item.directory && item.name === segment);
    if (folders.length !== 1) throw new Error(t("Choose a unique Google Drive folder. {0}", segment));
    parent = folders[0].id;
  }
  return { path, googleDrive: { profile, parent } };
}

function connectedPlace(path: string, places: readonly FilePlace[]): FilePlace | undefined {
  const matches = new Map<string, FilePlace>();
  let matchLength = 0;
  for (const place of places) {
    if (place.kind === "googleDrive" || place.kind === "local" && !place.smb) continue;
    const prefix = connectionPrefix(place);
    if (!prefix || !(path === prefix.slice(0, -1) || path.startsWith(prefix))) continue;
    if (prefix.length < matchLength) continue;
    if (prefix.length > matchLength) {
      matches.clear();
      matchLength = prefix.length;
    }
    const segments = path.slice(prefix.length).split("/").filter(Boolean);
    if (segments.some((part) => part === "." || part === ".." || /[\\/]/.test(part))) {
      throw new Error(t("Choose a supported destination path."));
    }
    if (place.kind === "kswitcher") matches.set(`kswitcher:${place.directory}:${place.peer}`, {
      ...place, path: segments.length === 1 && /^[a-z]:$/i.test(segments[0])
        ? segments[0] + "\\" : segments.join("\\") || place.path,
    });
    if (place.kind === "local" && place.smb) {
      matches.set("smb:" + place.smb.root, { ...place, path: [place.smb.root.replace(/\/$/, ""), ...segments].join("/") });
    }
    if (place.kind === "archive" || place.kind === "server" || isFileServer(place)) {
      matches.set(`${place.kind}:${place.id}`, { ...place, segments });
    }
  }
  if (matches.size > 1) throw new Error(t("More than one connection matches the destination path."));
  return matches.values().next().value;
}

export async function resolveMoveDestination(
  input: string, initial: FilePlace | undefined, places: readonly FilePlace[], source: FilePlace, multiple: boolean,
): Promise<MoveDestination> {
  const path = input;
  if (initial && input === movePath(initial)) return routePlace(initial, source);

  const drive = /^([^:/]+):\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (drive && !/^[a-z]$/i.test(drive[1]) && [t("My Drive"), "My Drive"].includes(drive[2])) {
    return driveFolder(path, drive[1], drive[3]?.split("/").filter(Boolean) ?? []);
  }

  const remote = connectedPlace(path, places);
  if (remote) return routePlace(remote, source);

  if (!isLocalMovePath(path)) throw new Error(t("Choose a supported destination path."));
  try {
    await api.listLocal(path);
  } catch (error) {
    const parent = parentPath(path, windowsClient);
    if (multiple || !parent || /[\\/]$/.test(path)) throw error;
    await api.listLocal(parent);
  }
  return { path, broker: source.kind === "kswitcher" && !!source.capabilities?.delete };
}
