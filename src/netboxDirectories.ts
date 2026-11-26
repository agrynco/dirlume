import type { DirectoryPreferences, FileServerPlace, FtpProfile, Listing, SshProfile } from "./api";

type ProfileRef = { kind: "ftp" | "ssh"; id: string };
type SavedProfile = ProfileRef & (FtpProfile | SshProfile);
type ProfileRecord<T> = { profile: string; origin: string; value: T };
type CachedDirectory = { segments: string[]; listing: Listing };
type CacheEntry = ProfileRecord<CachedDirectory> & { path: string };

const rememberedKey = "dirlume.netbox.last-directory.v1";
const cacheKey = "dirlume.netbox.directory-cache.v1";
const cached = new Map<string, CacheEntry>();
const cacheRevisions = new Map<string, number>();
const settingsRevisions = new Map<string, number>();
const sessionRevisions = new WeakMap<DirectoryPreferences, number>();
const maximumDirectories = 32;
const maximumEntries = 1024;

export const defaultDirectoryPreferences: DirectoryPreferences = {
  startingFolder: "", rememberLast: false, cacheListings: false, cacheChanges: false, persistentCache: false, resolveLinks: false,
};

function readRecords<T>(key: string): T[] {
  try {
    const records: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(records) ? records : [];
  } catch { return []; }
}

function writeRecords(key: string, records: unknown[]) {
  try { localStorage.setItem(key, JSON.stringify(records)); }
  catch { /* The in-memory listing cache remains available if storage is full. */ }
}

const profileKey = (kind: FileServerPlace["kind"], id: string) => kind + ":" + id;
const locationKey = (entry: Pick<CacheEntry, "profile" | "origin" | "path">) => JSON.stringify([entry.profile, entry.origin, entry.path]);
const scope = (place: FileServerPlace) => ({
  profile: profileKey(place.kind, place.profileId), origin: place.origin, path: JSON.stringify(place.segments),
});

export function registerDirectorySession(place: FileServerPlace) {
  if (place.directories) sessionRevisions.set(place.directories, settingsRevisions.get(scope(place).profile) ?? 0);
}

function currentSettings(place: FileServerPlace) {
  const settings = place.directories;
  if (settings && (sessionRevisions.get(settings) ?? 0) === (settingsRevisions.get(scope(place).profile) ?? 0)) return settings;
}

export function directoryCacheRevision(place: FileServerPlace) {
  return cacheRevisions.get(scope(place).profile) ?? 0;
}

function endpoint(profile: SavedProfile) {
  const host = profile.host.includes(":") ? `[${profile.host}]` : profile.host;
  const defaultPort = profile.kind === "ftp" ? 21 : 22;
  const protocol = profile.kind === "ftp" ? "ftp" : "sftp";
  return `${protocol}://${host}${profile.port === defaultPort ? "" : ":" + profile.port}`;
}

export function rememberedDirectory(profile: SavedProfile) {
  if (!profile.directories?.rememberLast) return;
  const id = profileKey(profile.kind, profile.id);
  const origin = endpoint(profile);
  const segments = readRecords<ProfileRecord<string[]>>(rememberedKey).find((record) =>
    record?.profile === id && record.origin === origin)?.value;
  if (Array.isArray(segments) && segments.every((part) => typeof part === "string")) return segments;
}

export function rememberDirectory(place: FileServerPlace) {
  if (!currentSettings(place)?.rememberLast) return;
  const { profile, origin } = scope(place);
  const records = readRecords<ProfileRecord<string[]>>(rememberedKey).filter((entry) => entry?.profile !== profile);
  writeRecords(rememberedKey, [...records, { profile, origin, value: place.segments }]);
}

export function readCachedDirectory(place: FileServerPlace): CachedDirectory | undefined {
  const settings = currentSettings(place);
  if (!settings) return;
  const ref = scope(place);
  const entry = cached.get(locationKey(ref)) ?? (settings.persistentCache
    ? readRecords<CacheEntry>(cacheKey).find((entry) =>
      entry?.profile === ref.profile && entry.origin === ref.origin && entry.path === ref.path) : undefined);
  if (entry && Array.isArray(entry.value?.segments) && Array.isArray(entry.value?.listing?.entries)) return entry.value;
}

export function cacheDirectory(requested: FileServerPlace, actual: FileServerPlace, listing: Listing, revision = directoryCacheRevision(actual)) {
  const settings = currentSettings(actual);
  if (!(settings?.cacheListings || settings?.cacheChanges) || revision !== directoryCacheRevision(actual) || listing.entries.length > maximumEntries) return;
  const value = { segments: actual.segments, listing };
  const entries = [{ ...scope(actual), value }];
  if (settings.cacheChanges && JSON.stringify(actual.segments) !== JSON.stringify(requested.segments)) {
    entries.push({ ...scope(requested), value });
  }
  for (const entry of entries) {
    const key = locationKey(entry);
    cached.delete(key);
    cached.set(key, entry);
  }
  while (cached.size > maximumDirectories) {
    const oldest = cached.keys().next().value;
    if (oldest === undefined) break;
    cached.delete(oldest);
  }
  if (!settings.persistentCache) return;
  const previous = readRecords<CacheEntry>(cacheKey).filter((entry) =>
    entry && !entries.some((updated) => locationKey(updated) === locationKey(entry)));
  writeRecords(cacheKey, [...previous, ...entries].slice(-maximumDirectories));
}

export function invalidateDirectories(ref: ProfileRef, configurationChanged = false) {
  const id = profileKey(ref.kind, ref.id);
  cacheRevisions.set(id, (cacheRevisions.get(id) ?? 0) + 1);
  for (const [key, entry] of cached) if (entry.profile === id) cached.delete(key);
  const entries = readRecords<CacheEntry>(cacheKey).filter((entry) => entry && entry.profile !== id);
  writeRecords(cacheKey, entries);
  if (configurationChanged) {
    settingsRevisions.set(id, (settingsRevisions.get(id) ?? 0) + 1);
  }
}

export function forgetDirectoryProfile(ref: ProfileRef) {
  invalidateDirectories(ref, true);
  const id = profileKey(ref.kind, ref.id);
  const locations = readRecords<ProfileRecord<string[]>>(rememberedKey).filter((entry) => entry && entry.profile !== id);
  writeRecords(rememberedKey, locations);
}
