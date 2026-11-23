import { api, uncParts, type ConnectionSource, type Entry, type SavedConnection } from "./api";
import { t } from "./i18n";

type SmbProfile = Extract<SavedConnection, { kind: "smb" }>;
type RemoteProfile = Extract<SavedConnection, { kind: "server" | "kswitcher" }>;
const smbKey = "dirlume.smb-locations";
const remoteKey = "dirlume.remote-connections";

function connectionId() {
  return Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16).padStart(8, "0")).join("");
}

function readItems(key: string): unknown[] {
  try {
    const items: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(items) ? items : [];
  } catch { return []; }
}

export function readSmbLocations(): SmbProfile[] {
  return readItems(smbKey).flatMap((value) => {
    if (typeof value === "string") return [{ kind: "smb" as const, id: "legacy:" + value, label: value, path: value }];
    const item = value as Partial<SmbProfile> | null;
    return item?.kind === "smb" && typeof item.id === "string" && typeof item.label === "string" && typeof item.path === "string"
      ? [item as SmbProfile] : [];
  });
}

export function readRemoteProfiles(): RemoteProfile[] {
  return readItems(remoteKey).filter((value): value is RemoteProfile => {
    const item = value as Partial<RemoteProfile> | null;
    return typeof item?.id === "string" && typeof item.label === "string" &&
      (item.kind === "server" ? typeof item.credential === "string" : item.kind === "kswitcher" && typeof item.peer === "string");
  });
}

export function saveSmbLocation(label: string, path: string, existing?: SmbProfile) {
  const input = path.trim().replace(/^smb:\/\//i, "").replaceAll("/", "\\");
  const unc = input.startsWith("\\\\") ? input : "\\\\" + input;
  const parts = uncParts(unc);
  if (!parts.length || parts.some((part) => part === "." || part === ".." || /[:*?"<>|\x00-\x1f]/.test(part))) {
    throw new Error(t("Enter a valid SMB server or share."));
  }
  const profile: SmbProfile = { kind: "smb", id: existing?.id ?? connectionId(), label, path: "\\\\" + parts.join("\\") };
  localStorage.setItem(smbKey, JSON.stringify([...readSmbLocations().filter(({ id }) => id !== profile.id), profile]));
  return profile.id;
}

export async function saveRemoteConnection(label: string, provider: "server" | "kswitcher", value: string,
  existing?: RemoteProfile, lan = existing?.kind === "server" && existing.lan === true) {
  const id = existing?.id ?? connectionId();
  const previous = existing?.kind === "server" ? existing.credential : undefined;
  const replacement = provider === "server" && value ? await api.saveServerInvitation(value) : undefined;
  try {
    let profile: RemoteProfile;
    if (provider === "kswitcher") {
      if (!value) throw new Error(t("Choose a paired machine."));
      profile = { kind: provider, id, label, peer: value };
    } else {
      const credential = replacement ?? previous;
      if (!credential) throw new Error(t("Enter a valid Dirlume server invitation."));
      profile = { kind: provider, id, label, credential, ...(lan ? { lan } : {}) };
    }
    localStorage.setItem(remoteKey, JSON.stringify([...readRemoteProfiles().filter((item) => item.id !== id), profile]));
  } catch (error) {
    if (replacement) void api.removeServerInvitation(replacement).catch(() => {});
    throw error;
  }
  if (previous && (replacement || provider === "kswitcher")) void api.removeServerInvitation(previous).catch(() => {});
  return id;
}

export async function removeSavedConnection(profile: SavedConnection) {
  if (profile.kind === "ftp") await api.removeFtpProfile(profile.id);
  else if (profile.kind === "ssh") await api.removeSshProfile(profile.id);
  else if (profile.kind === "smb") {
    localStorage.setItem(smbKey, JSON.stringify(readSmbLocations().filter(({ id }) => id !== profile.id)));
  } else {
    localStorage.setItem(remoteKey, JSON.stringify(readRemoteProfiles().filter(({ id }) => id !== profile.id)));
    if (profile.kind === "server") void api.removeServerInvitation(profile.credential).catch(() => {});
  }
}

export async function connectionEntries(source: ConnectionSource): Promise<Entry[]> {
  let profiles: SavedConnection[];
  switch (source) {
    case "ftp": {
      const [ftp, ssh] = await Promise.all([api.ftpProfiles(), api.sshProfiles()]);
      profiles = [...ftp.map((item) => ({ ...item, kind: "ftp" as const })), ...ssh.map((item) => ({ ...item, kind: "ssh" as const }))];
      break;
    }
    case "ssh":
      profiles = (await api.sshProfiles()).map((item) => ({ ...item, kind: "ssh" }));
      break;
    case "smb":
      profiles = readSmbLocations();
      break;
    case "remote":
      profiles = readRemoteProfiles();
      break;
  }
  // Pane selection and row identity use names. Preserve both rows when saved labels collide.
  const taken = new Set([".."]);
  return profiles.map((connection) => {
    const { label } = connection;
    let name = label;
    for (let number = 2; taken.has(name); number++) name = `${label} (${number})`;
    taken.add(name);
    return { name, directory: true, hidden: false, link: false, size: null, modified: null, connection };
  });
}
