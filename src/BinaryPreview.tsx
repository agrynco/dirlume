import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { describeError, documentPath, fileBytePageSize, readPlaceBytes, type BytePage, type NamedFile } from "./api";
import { Button } from "./Button";
import { SudoDialog } from "./SudoDialog";
import { errorText, t } from "./i18n";

const controls = " ☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼";
const extended = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";
const maximumScrollHeight = 8_000_000;

function glyph(byte: number) {
  if (byte < 32) return controls[byte];
  if (byte === 127) return "⌂";
  return byte < 127 ? String.fromCharCode(byte) : extended[byte - 128];
}

export function looksBinary({ data }: BytePage) {
  if ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff)) return false;
  if (data.some((byte) => byte === 0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(data), { stream: true });
    return false;
  } catch {
    return true;
  }
}

export function BinaryPreview({ file, initial }: { file: NamedFile; initial: BytePage }) {
  const scroll = useRef<HTMLDivElement>(null);
  const sample = useRef<HTMLSpanElement>(null);
  const [dimensions, setDimensions] = useState({ columns: 0, rowHeight: 0, cellWidth: 0, height: 0 });
  const [offset, setOffset] = useState(0);
  const [pages, setPages] = useState(() => new Map([[0, initial]]));
  const [error, setError] = useState("");
  const [denied, setDenied] = useState<number | null>(null);
  const [sudo, setSudo] = useState<number | null>(null);

  useLayoutEffect(() => {
    const viewport = scroll.current;
    const cell = sample.current;
    if (!viewport || !cell) return;
    const measure = () => {
      const size = cell.getBoundingClientRect();
      if (!size.width || !size.height) return;
      const columns = Math.max(1, Math.floor(viewport.clientWidth / size.width));
      setDimensions({ columns, rowHeight: size.height, cellWidth: size.width, height: viewport.clientHeight });
      setOffset(viewport.scrollTop);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(cell);
    measure();
    return () => observer.disconnect();
  }, []);

  const { columns, rowHeight, cellWidth, height } = dimensions;
  const rows = columns ? Math.ceil(initial.length / columns) : 0;
  const contentHeight = rows * rowHeight;
  const scrollHeight = Math.min(contentHeight, maximumScrollHeight);
  const scrollRange = Math.max(0, scrollHeight - height);
  const logicalOffset = scrollRange ? Math.min(offset, scrollRange) / scrollRange * (contentHeight - height) : 0;
  const firstRow = rowHeight ? Math.floor(logicalOffset / rowHeight) : 0;
  const visibleRows = rowHeight ? Math.min(rows - firstRow, Math.ceil(height / rowHeight) + 1) : 0;
  const firstByte = firstRow * columns;
  const lastByte = Math.min(initial.length, firstByte + visibleRows * columns);
  const firstPage = Math.floor(firstByte / fileBytePageSize) * fileBytePageSize;
  const lastPage = Math.floor(Math.max(0, lastByte - 1) / fileBytePageSize) * fileBytePageSize;

  useEffect(() => {
    if (!columns) return;
    setError("");
    setDenied(null);
    const missing: number[] = [];
    for (let start = firstPage; start <= lastPage; start += fileBytePageSize) {
      if (!pages.has(start)) missing.push(start);
    }
    if (!missing.length) return;
    let current = true;
    void Promise.allSettled(missing.map(async (start) => [start, await readPlaceBytes(file, start)] as const)).then(
      (results) => {
        if (!current) return;
        const next = new Map(pages);
        for (const [index, result] of results.entries()) {
          if (result.status === "rejected") {
            const reason = describeError(result.reason);
            if (file.place.kind === "ssh" && reason === "SSH permission denied.") setDenied(missing[index]);
            setError(errorText(reason));
            return;
          }
          const [start, page] = result.value;
          if (page.length !== initial.length || page.data.length !== Math.min(fileBytePageSize, page.length - start)) {
            setError(t("The file changed on disk."));
            return;
          }
          next.set(start, page);
        }
        for (const start of next.keys()) {
          if (start < firstPage - 4 * fileBytePageSize || start > lastPage + 4 * fileBytePageSize) next.delete(start);
        }
        setPages(next);
      },
    );
    return () => { current = false; };
  }, [file, initial.length, columns, firstPage, lastPage, pages]);

  function characters(start: number) {
    return Array.from({ length: Math.min(columns, initial.length - start) }, (_, column) => {
      const position = start + column;
      const pageStart = Math.floor(position / fileBytePageSize) * fileBytePageSize;
      const byte = pages.get(pageStart)?.data[position - pageStart];
      return <span key={column}>{byte === undefined ? " " : glyph(byte)}</span>;
    });
  }

  return <div ref={scroll} className="binary-preview" tabIndex={0} aria-label={t("Binary contents")}
    onScroll={(event) => setOffset(event.currentTarget.scrollTop)}>
    <span ref={sample} className="binary-preview-cell" aria-hidden="true">0</span>
    <div style={{ height: scrollHeight, position: "relative" }}>
      {error ? <div className="binary-preview-error pane-empty">
        <p role="status">{t("Could not read this file: {0}", error)}</p>
        {denied !== null && <Button onClick={() => setSudo(denied)}>{t("Open with sudo…")}</Button>}
      </div> :
        !pages.has(firstPage) ? <p className="binary-preview-error pane-empty" role="status">{t("Reading bytes…")}</p> :
        <div className="binary-preview-rows" style={{ top: offset - (logicalOffset % (rowHeight || 1)) }}>
          {Array.from({ length: visibleRows }, (_, index) => {
            const start = firstByte + index * columns;
            return <div className="binary-preview-row" style={{ gridAutoColumns: cellWidth }} data-byte-offset={start} key={start}>
              {characters(start)}
            </div>;
          })}
        </div>}
    </div>
    {sudo !== null && file.place.kind === "ssh" && <SudoDialog operation="read" address={file.place.address} path={documentPath(file)}
      onClose={() => setSudo(null)} onConfirm={async (password) => {
        const result = await readPlaceBytes(file, sudo, password);
        if (result.length !== initial.length || result.data.length !== Math.min(fileBytePageSize, initial.length - sudo)) {
          throw new Error(t("The file changed on disk."));
        }
        setPages((current) => new Map(current).set(sudo, result));
      }} />}
  </div>;
}
