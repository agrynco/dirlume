import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { api, type Entry, type PanelMetadata, type PanelMetadataRequest } from "./api";

export function usePanelMetadata(listing: readonly Entry[], requests: ReadonlyMap<string, PanelMetadataRequest>) {
  const [cache, setCache] = useState<{ listing: readonly Entry[]; values: ReadonlyMap<string, PanelMetadata> }>();
  const values = cache?.listing === listing ? cache.values : undefined;
  const missing = JSON.stringify([...requests].filter(([key]) => !values?.has(key)).slice(0, 64));

  useEffect(() => {
    if (!isTauri() || missing === "[]") return;
    const batch = JSON.parse(missing) as [string, PanelMetadataRequest][];
    let current = true;
    const timer = window.setTimeout(() => {
      void api.panelMetadata(batch.map(([, request]) => request)).catch(() => []).then((results) => {
        if (!current) return;
        setCache((before) => {
          const next = before?.listing === listing ? new Map(before.values) : new Map<string, PanelMetadata>();
          for (const [index, [key]] of batch.entries()) next.set(key, results[index] ?? { owner: null, hardLinks: null });
          for (const key of next.keys()) {
            if (next.size <= 4096) break;
            next.delete(key);
          }
          return { listing, values: next };
        });
      });
    }, 60);
    return () => { current = false; window.clearTimeout(timer); };
  }, [listing, missing]);

  return values;
}
