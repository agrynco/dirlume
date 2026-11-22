import { useMemo, useState } from "react";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { locale, t } from "./i18n";

type RecordFields = Record<string, unknown>;
type DiagnosticRow = { line: number; raw: string; fields: RecordFields | null; timestamp: number | null };

function object(value: unknown): RecordFields | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordFields : null;
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(new Date(value).getTime()) ? value : null;
}

function parseRows(source: string): DiagnosticRow[] {
  const rows: DiagnosticRow[] = [];
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    try {
      const fields = object(JSON.parse(raw));
      const date = timestamp(fields?.timestampMs);
      if (typeof fields?.operation === "string" && typeof fields.code === "string" && date !== null) {
        rows.push({ line: index + 1, raw, fields, timestamp: date });
        continue;
      }
    } catch {
      // A partial record stays available in the log and does not interrupt parsing.
    }
    rows.push({ line: index + 1, raw, fields: null, timestamp: null });
  }
  return rows.sort((a, b) => (b.timestamp ?? -Infinity) - (a.timestamp ?? -Infinity) || b.line - a.line);
}

function Time({ value, format }: { value: number | null; format: Intl.DateTimeFormat }) {
  if (value === null) return <span className="syntax-comment">{t("Unknown time")}</span>;
  return <time className="syntax-number" dateTime={new Date(value).toISOString()}>{format.format(value)}</time>;
}

function FieldValue({ value }: { value: unknown }) {
  if (typeof value === "number") return <code className="syntax-number">{value}</code>;
  if (typeof value === "string") return <code className="syntax-string">{value}</code>;
  if (typeof value !== "object" || value === null) return <code className="syntax-keyword">{String(value)}</code>;
  try {
    return <pre>{JSON.stringify(value, null, 2)}</pre>;
  } catch {
    return <p>{t("Open Source to inspect this value.")}</p>;
  }
}

function LogEntry({ row, format }: { row: DiagnosticRow; format: Intl.DateTimeFormat }) {
  const [expanded, setExpanded] = useState(false);
  const fields = row.fields;
  const code = fields?.code;
  const osCode = fields?.osCode;

  return <details className="diagnostic-entry" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>
      <ChevronRight className="diagnostic-chevron" aria-hidden="true" />
      {fields ? <>
        <Time value={row.timestamp} format={format} />
        <code className="diagnostic-operation syntax-property">{String(fields.operation)}</code>
        <code className="diagnostic-code syntax-keyword" data-panic={code === "panic" || undefined}>
          {code === "panic" && <TriangleAlert aria-hidden="true" />}{String(code)}
        </code>
        {typeof osCode === "number" && <code className="diagnostic-os syntax-number">{t("OS {0}", osCode)}</code>}
      </> : <>
        <span className="diagnostic-malformed syntax-invalid">{t("Malformed entry")}</span>
        <span className="syntax-comment">{t("Line {0}", row.line)}</span>
      </>}
    </summary>
    {expanded && <div className="diagnostic-details">
      {fields ? <>
        <dl>
          {Object.entries(fields).filter(([key]) => key !== "recentActions").map(([key, value]) => (
            <div key={key}>
              <dt><code className="syntax-property">{key}</code></dt>
              <dd><FieldValue value={value} /></dd>
            </div>
          ))}
        </dl>
        <RecentActions values={fields.recentActions} format={format} />
      </> : <pre>{row.raw}</pre>}
    </div>}
  </details>;
}

function RecentActions({ values, format }: { values: unknown; format: Intl.DateTimeFormat }) {
  const actions = Array.isArray(values) ? values.map((value, index) => {
    const fields = object(value);
    return { index, fields, timestamp: timestamp(fields?.timestampMs) };
  }).sort((a, b) => (a.timestamp ?? Infinity) - (b.timestamp ?? Infinity) || a.index - b.index) : [];

  return <>
    <h3>{t("Recent actions")}</h3>
    {actions.length ? <ol>
      {actions.map((item) => <li key={item.index}>
        <Time value={item.timestamp} format={format} />{" "}
        <code className="syntax-property">{typeof item.fields?.operation === "string" ? item.fields.operation : t("Unknown operation")}</code>
      </li>)}
    </ol> : <p>{t("No recent actions were recorded.")}</p>}
  </>;
}

export function DiagnosticLog({ source }: { source: string }) {
  const rows = useMemo(() => parseRows(source), [source]);
  const language = locale();
  const format = useMemo(() => new Intl.DateTimeFormat(language, {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hourCycle: "h23",
  }), [language]);

  return <div className="text-view diagnostic-log" role="region" aria-label={t("Diagnostic entries")}>
    {rows.length ? rows.map((row) => <LogEntry key={row.line} row={row} format={format} />)
      : <p>{t("No errors have been logged yet.")}</p>}
  </div>;
}
