import { timestampSeconds } from "./useTimestamps";

export type CommandEntry = { text: string; date: number | null };

const historyKey = "dirlume.command-history";
export const historyLimit = 1000;

export function readCommandHistory(): CommandEntry[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(historyKey) ?? "[]");
    if (!Array.isArray(stored)) return [];
    return stored.flatMap((item: unknown): CommandEntry[] => {
      if (typeof item === "string") return item.trim() ? [{ text: item, date: null }] : [];
      if (!item || typeof item !== "object" || !("text" in item) || typeof item.text !== "string" ||
        !item.text.trim()) return [];
      const date = "date" in item && typeof item.date === "number" && Number.isFinite(new Date(item.date).getTime())
        ? item.date : null;
      return [{ text: item.text, date }];
    }).slice(0, historyLimit);
  } catch { return []; }
}

export function saveCommandHistory(history: CommandEntry[]) {
  try { localStorage.setItem(historyKey, JSON.stringify(history)); } catch { /* History remains available in memory. */ }
}

// Topic matching follows the KSwitcher Files command history.
function keywords(command: string) {
  const [first = "", ...args] = command.trim().split(/\s+/);
  const tool = first.split(/[\\/]/).at(-1)?.replace(/\.exe$/, "");
  switch (tool) {
    case "ipconfig":
      if (args.includes("/flushdns")) return "network dns flush clear cache мережа очистити кеш сеть очистить кэш";
      return "network connectivity address мережа з’єднання адреса сеть подключение адрес";
    case "nslookup": case "resolve-dnsname":
      return "network dns lookup query мережа запит сеть запрос";
    case "ping": case "tracert": case "traceroute": case "test-netconnection":
    case "netstat": case "curl": case "invoke-webrequest":
      return "network connectivity address мережа з’єднання адреса сеть подключение адрес";
    case "cls": case "clear": case "clear-host":
      return "terminal clear screen очистити екран консоль очистить экран";
    case "git":
      return ["pull", "fetch", "update"].includes(args[0])
        ? "git version control repository update sync fetch pull оновити репозиторій синхронізація обновить репозиторий синхронизация"
        : "git version control repository репозиторій контроль версій репозиторий контроль версий";
    default: return "";
  }
}

export function commandHistoryGroups(history: CommandEntry[], query: string,
  dateLabel: (time: number | null) => string | null, unknownDate: string) {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const groups = [new Map<string, string[]>(), new Map<string, string[]>()];
  const seen = new Set<string>();
  for (const { text, date } of history) {
    if (seen.has(text)) continue;
    seen.add(text);
    const day = date === null ? null : new Date(date);
    const label = dateLabel(timestampSeconds(date)) ?? unknownDate;
    const dateKey = day ? [day.getFullYear(), day.getMonth() + 1, day.getDate()]
      .map((number) => String(number).padStart(2, "0")).join("-") : "";
    const command = text.toLocaleLowerCase();
    const visible = `${command} ${label.toLocaleLowerCase()} ${dateKey}`;
    const containsAll = (value: string) => words.every((word) => value.includes(word));
    const rank = containsAll(visible) ? 0 : containsAll(visible + " " + keywords(command)) ? 1 : -1;
    if (rank === -1) continue;
    const group = groups[rank];
    const entries = group.get(label) ?? [];
    entries.push(text);
    group.set(label, entries);
  }
  return groups.flatMap((group) => [...group].map(([date, commands]) => ({ date, commands })));
}
