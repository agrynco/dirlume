export type CommandHistoryEntry = { command: string; time: number | null };

export const commandHistoryKey = "dirlume.command-history";
const limit = 1000;

export function readCommandHistory(saved: string | null): CommandHistoryEntry[] {
  try {
    const value: unknown = JSON.parse(saved ?? "[]");
    if (!Array.isArray(value)) return [];
    const entries: CommandHistoryEntry[] = [];
    for (const item of value) {
      if (typeof item === "string" && item.trim()) entries.push({ command: item, time: null });
      else if (item && typeof item.command === "string" && item.command.trim()) {
        const time = typeof item.time === "number" && Number.isFinite(new Date(item.time).getTime()) ? item.time : null;
        entries.push({ command: item.command, time });
      }
      if (entries.length === limit) break;
    }
    return entries;
  } catch {
    return [];
  }
}

export function recordCommand(entries: CommandHistoryEntry[], command: string, time = Date.now()) {
  return command.trim() ? [{ command, time }, ...entries].slice(0, limit) : entries;
}

const topics: [RegExp, string][] = [
  [/^(?:ipconfig(?:\.exe)?\s+.*\/flushdns\b|clear-dnsclientcache\b|resolvectl\s+flush-caches\b)/im, "DNS cache network"],
  [/^(?:ipconfig(?:\.exe)?\s+.*\/(?:release|renew)\b|dhclient\b)/im, "network DHCP address lease"],
  [/^git(?:\.exe)?\s+(?:pull|push|fetch)\b/im, "repository sync version control"],
  [/^git(?:\.exe)?\s+(?:checkout|switch|branch)\b/im, "repository branch version control"],
  [/^(?:cls|clear|clear-host)(?:\s|$)/im, "clear screen terminal"],
  [/^(?:cd|chdir|set-location|pushd|popd)(?:\s|$)/im, "change working directory folder navigation"],
  [/^(?:ls|dir|get-childitem)(?:\s|$)/im, "list files folders directory"],
];

export function groupCommandHistory(entries: CommandHistoryEntry[], query: string, locale: string, unknown: string) {
  const words = query.toLocaleLowerCase(locale).trim().split(/\s+/).filter(Boolean);
  const formatter = new Intl.DateTimeFormat(locale, { dateStyle: "long" });
  const seen = new Set<string>();
  const matches: { command: string; date: string; direct: boolean }[] = [];
  for (const { command, time } of entries) {
    if (seen.has(command)) continue;
    seen.add(command);
    const date = time === null ? unknown : formatter.format(time);
    const text = (command + " " + date).toLocaleLowerCase(locale);
    const direct = words.every((word) => text.includes(word));
    if (!direct) {
      const keywords = topics.filter(([pattern]) => pattern.test(command.trimStart())).map(([, tags]) => tags).join(" ").toLowerCase();
      if (!words.every((word) => text.includes(word) || keywords.includes(word))) continue;
    }
    matches.push({ command, date, direct });
  }
  matches.sort((left, right) => Number(right.direct) - Number(left.direct));
  const groups = new Map<string, string[]>();
  for (const { command, date } of matches) {
    const group = groups.get(date);
    if (group) group.push(command);
    else groups.set(date, [command]);
  }
  return [...groups];
}
