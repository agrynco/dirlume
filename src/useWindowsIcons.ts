import { useEffect, useRef, useState } from "react";
import { windowsClient } from "./api";

export function useWindowsIcons<T>(
  requests: ReadonlyMap<string, T>,
  load: (items: T[]) => Promise<(string | null)[]>,
) {
  const [icons, setIcons] = useState(new Map<string, string | null>());
  const pending = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!windowsClient || pending.current) return;
    const missing = Array.from(requests).filter(([key]) => !icons.has(key)).slice(0, 64);
    if (!missing.length) return;
    pending.current = true;
    void load(missing.map(([, item]) => item)).catch(() => []).then((images) => {
      pending.current = false;
      if (!mounted.current) return;
      setIcons((previous) => {
        const next = new Map(previous);
        for (const [index, [key]] of missing.entries()) next.set(key, images[index] ?? null);
        return next;
      });
    });
  }, [requests, icons, load]);

  return icons;
}

export function fileIconKey(directory: string, name: string, size: number | null, modified: number | null) {
  const extension = name.match(/\.([^.]*)$/)?.[1]?.toLowerCase();
  if (!extension) return "";
  return /^(exe|dll|ico|lnk|com|msi|cpl|ani|cur|scr)$/.test(extension)
    ? `${directory}|${name}|${size}|${modified}` : extension;
}
