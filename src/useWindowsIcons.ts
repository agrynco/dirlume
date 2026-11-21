import { useEffect, useRef, useState } from "react";
import { windowsClient } from "./api";

export function useWindowsIcons<T>(
  requests: ReadonlyMap<string, T>,
  load: (items: T[]) => Promise<(string | null)[]>,
) {
  const [icons, setIcons] = useState(new Map<string, string | null>());
  const failedAt = useRef(new Map<string, number>());
  const [retry, setRetry] = useState(0);
  const pending = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!windowsClient || pending.current) return;
    const stale = Array.from(icons.keys()).filter((key) => !requests.has(key));
    if (stale.length) {
      const next = new Map(icons);
      for (const key of stale) { next.delete(key); failedAt.current.delete(key); }
      setIcons(next);
      return;
    }
    const now = Date.now();
    const missing = Array.from(requests).filter(([key]) => !icons.has(key) || (icons.get(key) === null && now - (failedAt.current.get(key) ?? 0) >= 60_000)).slice(0, 64);
    if (!missing.length) {
      if (!failedAt.current.size) return;
      const timer = window.setTimeout(() => setRetry((value) => value + 1), 60_000);
      return () => window.clearTimeout(timer);
    }
    pending.current = true;
    void load(missing.map(([, item]) => item)).catch(() => []).then((images) => {
      pending.current = false;
      if (!mounted.current) return;
      setIcons((previous) => {
        const next = new Map(previous);
        for (const [index, [key]] of missing.entries()) {
          next.set(key, images[index] ?? null);
          if (images[index]) failedAt.current.delete(key);
          else failedAt.current.set(key, Date.now());
        }
        return next;
      });
    });
  }, [requests, icons, load, retry]);

  return icons;
}

export function fileIconKey(directory: string, name: string, size: number | null, modified: number | null) {
  const extension = name.match(/\.([^.]*)$/)?.[1]?.toLowerCase();
  if (!extension) return "";
  return /^(exe|dll|ico|lnk|com|msi|cpl|ani|cur|scr)$/.test(extension)
    ? `${directory}|${name}|${size}|${modified}` : extension;
}
