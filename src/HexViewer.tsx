import { HistoryField } from "./HistoryField";
import { errorText, locale, t } from "./i18n";
import { Button } from "./Button";
import { SudoDialog } from "./SudoDialog";
import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { describeError, fileBytePageSize, readPlaceBytes, type BytePage, type NamedFile } from "./api";

const bytesPerRow = 16;
const maximumScrollHeight = 8_000_000;
const hex = (value: number, length = 2) => value.toString(16).toUpperCase().padStart(length, "0");
const columns = Array.from({ length: bytesPerRow }, (_, index) => hex(index)).join(" ");

export function HexViewer({ file, revision, onSize }: { file: NamedFile; revision: number; onSize?: (size: number) => void }) {
  const [address, setAddress] = useState("");
  const [length, setLength] = useState<number | null>(null);
  const [pages, setPages] = useState(() => new Map<number, BytePage>());
  const [initialError, setInitialError] = useState("");
  const [rangeError, setRangeError] = useState("");
  const [deniedPage, setDeniedPage] = useState<number | null>(null);
  const [sudo, setSudo] = useState(false);
  const [position, setPosition] = useState<{ physical: number; logical?: number }>({ physical: 0 });
  const [dimensions, setDimensions] = useState({ rowHeight: 0, height: 0 });
  const controls = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const sample = useRef<HTMLDivElement>(null);
  const queue = useMemo(() => ({ pending: Promise.resolve() }), [file, revision]);
  const addressValue = /^(?:0x[\da-f]+|\d+)$/i.test(address.trim()) ? Number(address.trim()) : NaN;
  const { rowHeight, height } = dimensions;
  const totalRows = Math.ceil((length ?? 0) / bytesPerRow) + 1;
  const contentHeight = totalRows * rowHeight;
  // Map the scroll thumb onto the full file without exceeding the webview's layout height.
  const scrollHeight = Math.min(contentHeight, maximumScrollHeight);
  const scrollRange = Math.max(0, scrollHeight - height);
  const logicalRange = Math.max(0, contentHeight - height);
  const scrollTop = Math.min(position.physical, scrollRange);
  const logicalTop = Math.min(position.logical ?? (scrollRange ? scrollTop / scrollRange * logicalRange : 0), logicalRange);
  const compressed = contentHeight > scrollHeight;
  const firstRow = rowHeight ? Math.floor(logicalTop / rowHeight) : 0;
  const lastRow = rowHeight ? Math.min(totalRows - 1, firstRow + Math.ceil(height / rowHeight)) : 0;
  const offset = Math.max(0, firstRow - 1) * bytesPerRow;
  const firstPage = Math.floor(offset / fileBytePageSize) * fileBytePageSize;
  const lastPage = Math.floor(Math.max(0, (lastRow - 1) * bytesPerRow) / fileBytePageSize) * fileBytePageSize;

  useEffect(() => {
    let canceled = false;
    setLength(null);
    setPages(new Map());
    setInitialError("");
    setDeniedPage(null);
    setSudo(false);
    void readPlaceBytes(file, 0).then(
      (result) => {
        if (canceled) return;
        setPages(new Map([[0, result]]));
        setLength(result.length);
        onSize?.(result.length);
      },
      (failure: unknown) => {
        if (canceled) return;
        const reason = describeError(failure);
        if (file.place.kind === "ssh" && reason === "SSH permission denied.") setDeniedPage(0);
        setInitialError(reason);
      },
    );
    return () => { canceled = true; };
  }, [file, onSize, revision]);

  useLayoutEffect(() => {
    const element = viewport.current;
    const probe = sample.current;
    if (!element || !probe) return;
    const measure = () => {
      const rowHeight = probe.getBoundingClientRect().height;
      if (rowHeight) setDimensions({ rowHeight, height: element.clientHeight });
      const physical = element.scrollTop;
      setPosition((current) => physical === current.physical ? current : { physical });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(probe);
    measure();
    return () => observer.disconnect();
  }, [length]);

  useEffect(() => {
    setRangeError("");
    if (!length || !rowHeight) return;
    const missing: number[] = [];
    for (let start = firstPage; start <= lastPage; start += fileBytePageSize) {
      if (!pages.has(start)) missing.push(start);
    }
    if (!missing.length) return;
    let current = true;
    // Wait for any previous reads and skip ranges the user already scrolled past.
    queue.pending = queue.pending.then(async () => {
      if (!current) return;
      try {
        const results = await Promise.allSettled(missing.map(async (start) => [start, await readPlaceBytes(file, start)] as const));
        if (!current) return;
        const next = new Map(pages);
        let failure = "";
        for (const [index, result] of results.entries()) {
          if (result.status === "rejected") {
            const reason = describeError(result.reason);
            if (file.place.kind === "ssh" && reason === "SSH permission denied.") setDeniedPage(missing[index]);
            failure ||= reason;
            continue;
          }
          const [start, page] = result.value;
          if (page.length !== length || page.data.length !== Math.min(fileBytePageSize, length - start)) {
            failure ||= t("The file changed on disk.");
          } else next.set(start, page);
        }
        if (failure) {
          setRangeError(failure);
          return;
        }
        for (const start of next.keys()) {
          if (start < firstPage - 2 * fileBytePageSize || start > lastPage + 2 * fileBytePageSize) next.delete(start);
        }
        setPages(next);
      } catch (failure: unknown) {
        if (current) setRangeError(describeError(failure));
      }
    });
    return () => { current = false; };
  }, [file, queue, length, rowHeight, firstPage, lastPage, pages]);

  useLayoutEffect(() => {
    if (document.activeElement === document.body && !controls.current?.closest("[hidden]")) {
      controls.current?.focus({ preventScroll: true });
    }
  }, [length]);

  function moveTo(top: number) {
    const element = viewport.current;
    if (!element) return;
    const logical = Math.max(0, Math.min(top, logicalRange));
    element.scrollTop = logicalRange ? logical / logicalRange * scrollRange : 0;
    setPosition({ physical: element.scrollTop, logical });
  }

  const wheel = useEffectEvent((event: WheelEvent) => {
    if (!compressed || event.defaultPrevented || !event.deltaY || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? rowHeight : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? height : 1;
    moveTo(logicalTop + event.deltaY * unit);
  });
  useEffect(() => {
    const element = viewport.current;
    const listener = (event: WheelEvent) => wheel(event);
    element?.addEventListener("wheel", listener, { passive: false });
    return () => element?.removeEventListener("wheel", listener);
  }, [length]);

  function jumpTo(byte: number) {
    moveTo(byte > 0 ? (Math.floor(byte / bytesPerRow) + 1) * rowHeight : 0);
  }

  function goTo(event: FormEvent) {
    event.preventDefault();
    if (!Number.isSafeInteger(addressValue) || length === null || addressValue >= length) return;
    jumpTo(addressValue);
  }

  function line(row: number) {
    if (row === 0) return `${t("Offset").padEnd(12)}  ${columns}  ASCII`;
    const start = (row - 1) * bytesPerRow;
    const pageStart = Math.floor(start / fileBytePageSize) * fileBytePageSize;
    const bytes = pages.get(pageStart)?.data.slice(start - pageStart, start - pageStart + bytesPerRow);
    if (!bytes) return `${hex(start, 12)}  …`;
    const ascii = bytes.map((byte) => byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : "·").join("");
    return `${hex(start, 12)}  ${bytes.map((byte) => hex(byte)).join(" ").padEnd(columns.length)}  ${ascii}`;
  }
  return (
    <>
      <div ref={controls} tabIndex={-1} className="text-toolbar hex-toolbar">
        <Button onClick={() => jumpTo(Math.max(0, offset - fileBytePageSize))} disabled={!scrollTop}>{t("Previous page")}</Button>
        <Button onClick={() => jumpTo(offset + fileBytePageSize)}
          disabled={!length || scrollTop >= scrollRange || offset + fileBytePageSize >= length}>{t("Next page")}</Button>
        <form onSubmit={goTo}>
          <HistoryField historyKey="hex-offset" aria-label={t("Byte offset")} placeholder="0x0000" value={address} onValueChange={setAddress} />
          <Button type="submit" disabled={!Number.isSafeInteger(addressValue) || length === null || addressValue >= length}>{t("Go to offset")}</Button>
        </form>
        {length !== null && <span>{t("{0} bytes", length.toLocaleString(locale()))}</span>}
      </div>
      {deniedPage !== null && (initialError || rangeError) && <Button onClick={() => setSudo(true)}>{t("Open with sudo…")}</Button>}
      {initialError ? <p role="alert" className="dialog-error">{errorText(initialError)}</p> :
        length === null ? <p role="status" className="text-view">{t("Reading bytes…")}</p> :
        !length ? <p role="status" className="text-view">{t("This file is empty.")}</p> :
          <div ref={viewport} className="text-view hex-view" tabIndex={0} aria-label={t("Hexadecimal contents")}
            onScroll={(event) => {
              const physical = event.currentTarget.scrollTop;
              setPosition((current) => physical === current.physical ? current : { physical });
            }} onKeyDown={(event) => {
              if (!compressed || event.altKey || event.metaKey || event.shiftKey) return;
              const next = {
                ArrowUp: logicalTop - rowHeight, ArrowDown: logicalTop + rowHeight,
                PageUp: logicalTop - height, PageDown: logicalTop + height, Home: 0, End: logicalRange,
              }[event.key];
              if (next === undefined) return;
              event.preventDefault();
              moveTo(next);
            }}>
            <div className="hex-track" style={{ height: scrollHeight }}>
              <div ref={sample} className="hex-measure" aria-hidden="true">{"0".repeat(79)}</div>
              <div className="hex-lines" style={{ top: scrollTop - (logicalTop % (rowHeight || 1)) }}>
                {Array.from({ length: lastRow - firstRow + 1 }, (_, index) => {
                  const row = firstRow + index;
                  return <div key={row} data-byte-offset={row ? (row - 1) * bytesPerRow : undefined}>{line(row)}</div>;
                })}
              </div>
              {rangeError && <p role="alert" className="hex-read-error" style={{ top: scrollTop }}>{errorText(rangeError)}</p>}
            </div>
          </div>}
      {sudo && file.place.kind === "ssh" && deniedPage !== null && <SudoDialog operation="read" address={file.place.address}
        path={"/" + [...file.place.segments, file.name].join("/")} onClose={() => setSudo(false)}
        onConfirm={async (password) => {
          const result = await readPlaceBytes(file, deniedPage, password);
          if (length !== null && length !== result.length) throw new Error(t("The file changed on disk."));
          setLength(result.length);
          setPages((current) => new Map(current).set(deniedPage, result));
          setDeniedPage(null);
          setInitialError("");
          setRangeError("");
          onSize?.(result.length);
        }} />}
    </>
  );
}
