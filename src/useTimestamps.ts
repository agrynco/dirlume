import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { api } from "./api";

type Style = Parameters<typeof api.formatTimestamps>[1];
type Timestamp = number | null | undefined;
const batchSize = 1024;

export function useTimestamps(values: readonly Timestamp[], style: Style = "date_time") {
  const [refresh, setRefresh] = useState(0);
  const [formatted, setFormatted] = useState<{
    style: Style; refresh: number; labels: Map<number, string | null>;
  }>({ style, refresh, labels: new Map() });
  // Keep the displayed labels steady while refreshing the system format on focus.
  const labels = formatted.style === style ? formatted.labels : undefined;
  const fresh = formatted.refresh === refresh ? labels : undefined;
  const missing = [...new Set(values.filter((value): value is number =>
    value != null && Number.isSafeInteger(value) && !fresh?.has(value)))].join(",");

  useEffect(() => {
    const update = () => setRefresh((previous) => previous + 1);
    window.addEventListener("focus", update);
    return () => window.removeEventListener("focus", update);
  }, []);

  useEffect(() => {
    if (!missing) return;
    const timestamps = missing.split(",").map(Number);
    const batches: number[][] = [];
    for (let start = 0; start < timestamps.length; start += batchSize) {
      batches.push(timestamps.slice(start, start + batchSize));
    }
    const fallback = (cached?: ReadonlyMap<number, string | null>) => {
      const formatter = new Intl.DateTimeFormat(undefined, {
        dateStyle: style !== "time" ? "short" : undefined,
        timeStyle: style !== "date" ? "short" : undefined,
      });
      return timestamps.map((time) => {
        if (cached?.has(time)) return cached.get(time) ?? null;
        const date = new Date(time * 1000);
        return Number.isFinite(date.getTime()) ? formatter.format(date) : null;
      });
    };
    let mounted = true;
    const result = isTauri()
      ? Promise.all(batches.map((batch) => api.formatTimestamps(batch, style))).then((parts) => parts.flat(), () => fallback(labels))
      : Promise.resolve(fallback());
    void result.then((next) => {
      if (!mounted) return;
      setFormatted((previous) => {
        const current = previous.refresh === refresh && previous.style === style
          ? new Map(previous.labels) : new Map<number, string | null>();
        for (const [index, time] of timestamps.entries()) current.set(time, next[index] ?? null);
        const active = new Set(values);
        for (const time of current.keys()) {
          if (current.size <= Math.max(4096, active.size)) break;
          if (active.has(time)) continue;
          current.delete(time);
        }
        return { style, refresh, labels: current };
      });
    });
    return () => { mounted = false; };
  }, [labels, missing, refresh, style]);

  return (value: Timestamp) => value == null ? null : labels?.get(value) ?? null;
}

export function timestampSeconds(milliseconds: number | null) {
  return milliseconds === null ? null : Math.floor(milliseconds / 1000);
}
