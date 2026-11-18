import { Button } from "./Button";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { describeError, readPlaceBytes, type BytePage, type NamedFile } from "./api";

const bytesPerRow = 16;
const bytesPerPage = 1024;
const hex = (value: number, length = 2) => value.toString(16).toUpperCase().padStart(length, "0");
const columns = Array.from({ length: bytesPerRow }, (_, index) => hex(index)).join(" ");

export function HexViewer({ file }: { file: NamedFile }) {
  const [offset, setOffset] = useState(0);
  const [address, setAddress] = useState("");
  const [page, setPage] = useState<BytePage | null>(null);
  const [error, setError] = useState("");
  const controls = useRef<HTMLDivElement>(null);
  const addressValue = /^(?:0x[\da-f]+|\d+)$/i.test(address.trim()) ? Number(address.trim()) : NaN;

  useEffect(() => {
    let canceled = false;
    setPage(null);
    setError("");
    void readPlaceBytes(file, offset).then(
      (result) => { if (!canceled) setPage(result); },
      (failure: unknown) => { if (!canceled) setError(describeError(failure)); },
    );
    return () => { canceled = true; };
  }, [file, offset]);

  useLayoutEffect(() => {
    if (document.activeElement === document.body && !controls.current?.closest("[hidden]")) {
      controls.current?.focus({ preventScroll: true });
    }
  }, [page]);

  function goTo(event: FormEvent) {
    event.preventDefault();
    if (!Number.isSafeInteger(addressValue) || !page || addressValue >= page.length) return;
    setOffset(Math.floor(addressValue / bytesPerRow) * bytesPerRow);
  }

  const rows = page ? Array.from({ length: Math.ceil(page.data.length / bytesPerRow) }, (_, index) => {
    const start = index * bytesPerRow;
    const bytes = page.data.slice(start, start + bytesPerRow);
    const ascii = bytes.map((byte) => byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : "·").join("");
    return `${hex(offset + start, 12)}  ${bytes.map((byte) => hex(byte)).join(" ").padEnd(columns.length)}  ${ascii}`;
  }) : [];
  return (
    <>
      <div ref={controls} tabIndex={-1} className="text-toolbar hex-toolbar">
        <Button onClick={() => setOffset(Math.max(0, offset - bytesPerPage))} disabled={!offset}>Previous page</Button>
        <Button onClick={() => setOffset(offset + bytesPerPage)} disabled={!page || offset + bytesPerPage >= page.length}>Next page</Button>
        <form onSubmit={goTo}>
          <input aria-label="Byte offset" placeholder="0x0000" value={address} onChange={(event) => setAddress(event.target.value)} />
          <Button type="submit" disabled={!Number.isSafeInteger(addressValue) || !page || addressValue >= page.length}>Go to offset</Button>
        </form>
        {page && <span>{page.length.toLocaleString()} bytes</span>}
      </div>
      {error ? <p role="alert" className="dialog-error">{error}</p> :
        !page ? <p role="status" className="text-view">Reading bytes…</p> :
        !page.data.length ? <p role="status" className="text-view">{page.length ? "End of file." : "This file is empty."}</p> :
          <pre className="text-view hex-view" tabIndex={0} aria-label="Hexadecimal contents">{`${"Offset".padEnd(12)}  ${columns}  ASCII\n${rows.join("\n")}`}</pre>}
    </>
  );
}
