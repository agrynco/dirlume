import { timestampSeconds } from "./useTimestamps";

export type CommandEntry = { text: string; date: number | null; source?: "local" | "ssh" };

// Match complete quoted values before options and operators, including across lines.
const posixTokens = /\\[\s\S]|(?<comment>(?<!\S)#[^\r\n]*)|(?<string>\$'(?:\\[\s\S]|[^'\\])*(?:'|$)|'[^']*(?:'|$)|"(?:\\[\s\S]|[^"\\])*(?:"|$))|(?<option>(?<!\S)--?[A-Za-z][\w-]*)|(?<operator>\|[|&]?|&&|>>?|<<-?|[;&<>])/g;
const powerShellTokens = /`[\s\S]|(?<comment><#[\s\S]*?(?:#>|$)|(?<!\S)#[^\r\n]*)|(?<string>@(?:"[\s\S]*?(?:\r?\n"@|$)|'[\s\S]*?(?:\r?\n'@|$))|'(?:''|[^'])*(?:'|$)|"(?:`[\s\S]|""|[^"`])*(?:"|$))|(?<option>(?<!\S)--?[A-Za-z][\w-]*)|(?<operator>\|\|?|&&|>>?|[;&])/g;

export function commandHistoryParts(entry: CommandEntry, windows: boolean) {
  if (!entry.source) return [{ start: 0, text: entry.text }];
  const tokens = entry.source === "local" && windows ? powerShellTokens : posixTokens;
  const parts: { start: number; text: string; className?: string }[] = [];
  let start = 0;
  for (const match of entry.text.matchAll(tokens)) {
    const classes = match.groups!;
    const className = classes.string ? "syntax-string" : classes.option ? "syntax-property" :
      classes.operator ? "syntax-keyword" : classes.comment ? "syntax-comment" : undefined;
    if (!className) continue;
    if (match.index > start) parts.push({ start, text: entry.text.slice(start, match.index) });
    parts.push({ start: match.index, text: match[0], className });
    start = match.index + match[0].length;
  }
  if (start < entry.text.length) parts.push({ start, text: entry.text.slice(start) });
  return parts;
}

const historyKey = "dirlume.command-history";
export const historyLimit = 1000;

export function readCommandHistory(): CommandEntry[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(historyKey) ?? "[]");
    if (!Array.isArray(stored)) return [];
    return stored.flatMap((item: unknown): CommandEntry[] => {
      if (typeof item === "string") return item.trim() ? [{ text: item, date: null }] : [];
      if (!item || typeof item !== "object") return [];
      const text = "text" in item ? item.text : "command" in item ? item.command : undefined;
      if (typeof text !== "string" || !text.trim()) return [];
      const storedDate = "date" in item ? item.date : "time" in item ? item.time : null;
      const date = typeof storedDate === "number" && Number.isFinite(new Date(storedDate).getTime()) ? storedDate : null;
      const source = "source" in item && (item.source === "local" || item.source === "ssh") ? item.source : undefined;
      return [{ text, date, source }];
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
      if (args.includes("/release") || args.includes("/renew")) return "network DHCP address lease";
      return "network connectivity address мережа з’єднання адреса сеть подключение адрес";
    case "clear-dnsclientcache": return "network dns flush clear cache";
    case "resolvectl": return args.includes("flush-caches") ? "network dns flush clear cache" : "network dns";
    case "dhclient": return "network DHCP address lease";
    case "cd": case "chdir": case "set-location": case "pushd": case "popd":
      return "change working directory folder navigation";
    case "ls": case "dir": case "get-childitem": return "list files folders directory";
    case "nslookup": case "resolve-dnsname":
      return "network dns lookup query мережа запит сеть запрос";
    case "ping": case "tracert": case "traceroute": case "test-netconnection":
    case "netstat": case "curl": case "invoke-webrequest":
      return "network connectivity address мережа з’єднання адреса сеть подключение адрес";
    case "cls": case "clear": case "clear-host":
      return "terminal clear screen очистити екран консоль очистить экран";
    case "git":
      if (["checkout", "switch", "branch"].includes(args[0])) return "repository branch version control";
      return ["pull", "fetch", "update"].includes(args[0])
        ? "git version control repository update sync fetch pull оновити репозиторій синхронізація обновить репозиторий синхронизация"
        : "git version control repository репозиторій контроль версій репозиторий контроль версий";
    default: return "";
  }
}

export function commandHistoryGroups(history: CommandEntry[], query: string,
  dateLabel: (time: number | null) => string | null, unknownDate: string) {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const groups = [new Map<string, CommandEntry[]>(), new Map<string, CommandEntry[]>()];
  const seen = new Set<string>();
  for (const entry of history) {
    const { text, date } = entry;
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
    entries.push(entry);
    group.set(label, entries);
  }
  return groups.flatMap((group) => [...group].map(([date, commands]) => ({ date, commands })));
}
