import { Button } from "./Button";
import { isValidElement, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Save, X } from "lucide-react";
import { diffLines } from "diff";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, describeError, placePath, readPlaceText, type NamedFile, type TextDocument } from "./api";
import { Dialog } from "./Dialog";
import { HexViewer } from "./HexViewer";
import { MermaidDiagram } from "./MermaidDiagram";
import { eventShortcut, showShortcut } from "./preferences";
import { systemTheme, type Theme } from "./appearance";

const CodeSurface = lazy(() => import("./CodeSurface"));

function normalized(text: string) {
  return text.replaceAll(/\r\n?/g, "\n");
}

export function TextWindow({ file, editing, active, theme, saveShortcut, alternateSaveShortcut, closeShortcut, cancelShortcut, hexShortcut, onDirtyChange, onSaved, onClose }: {
  file: NamedFile;
  editing: boolean;
  active: boolean;
  theme: Theme;
  saveShortcut: string;
  alternateSaveShortcut: string;
  closeShortcut: string;
  cancelShortcut: string;
  hexShortcut: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [document, setDocument] = useState<TextDocument | null>(null);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(!editing && /\.(md|markdown)$/i.test(file.name));
  const [hex, setHex] = useState(false);
  const [system, setSystem] = useState(systemTheme);
  const [readError, setReadError] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const dirty = Boolean(document && normalized(document.text) !== text);
  const isMarkdown = /\.(md|markdown)$/i.test(file.name);
  const path = placePath(file.place);
  const section = useRef<HTMLElement>(null);
  const light = (theme === "system" ? system : theme) === "light";

  useLayoutEffect(() => {
    if (active) section.current?.focus({ preventScroll: true });
  }, [active]);

  const reportDirty = useRef(onDirtyChange);
  reportDirty.current = onDirtyChange;
  useEffect(() => { reportDirty.current(dirty); }, [dirty]);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    function update() { setSystem(systemTheme()); }
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    let cancelled = false;
    readPlaceText(file).then((value) => {
      if (!cancelled) {
        setDocument(value);
        setText(normalized(value.text));
      }
    }, (error: unknown) => {
      if (cancelled) return;
      setReadError(describeError(error));
    });
    return () => { cancelled = true; };
  }, [file]);

  async function save() {
    if (!document || !dirty || saving || file.place.kind === "server") return;
    setSaving(true);
    setError("");
    const eol = document.text.includes("\r\n") ? "\r\n" : document.text.includes("\r") ? "\r" : "\n";
    const updated = text.replaceAll("\n", eol);
    try {
      if (file.place.kind === "ftp") {
        if (!document.revision) throw new Error("Reopen the FTP file before saving again.");
        const saved = await api.saveFtpText(file.place.id, [...file.place.segments, file.name], document.revision, updated);
        setDocument(saved);
      } else {
        await api.saveText(file.place.path, file.name, document.text, updated);
        setDocument({ ...document, text: updated });
      }
      onSaved();
    } catch (error) {
      setError(describeError(error));
    } finally {
      setSaving(false);
    }
  }

  function close() {
    if (saving) return;
    if (dirty) setConfirm(true);
    else onClose();
  }

  return (
    <section ref={section} hidden={!active} className="text-window" aria-label={file.name} tabIndex={-1} onKeyDownCapture={(event) => {
      if (confirm) return;
      const shortcut = eventShortcut(event);
      if (!shortcut) return;
      if (editing && (shortcut === saveShortcut || shortcut === alternateSaveShortcut)) {
        event.preventDefault();
        event.stopPropagation();
        void save();
      } else if (shortcut === closeShortcut || shortcut === cancelShortcut) {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (!editing && shortcut === hexShortcut) {
        event.preventDefault();
        event.stopPropagation();
        setHex((visible) => !visible);
      }
    }}>
      <header className="document-heading">
        <h2>{file.name}</h2>
        <Button className="icon-button" type="button" aria-label="Close document" onClick={close} disabled={saving}><X /></Button>
      </header>
      <div className="text-toolbar">
        <span title={path}>{path}</span>
        {isMarkdown && document && !hex && <Button onClick={() => setPreview(!preview)}>{preview ? "Source" : "Preview"}</Button>}
        {!editing && <Button shortcut={showShortcut(hexShortcut)} aria-pressed={hex} onClick={() => setHex(!hex)}>Hex</Button>}
      </div>
      {error && <p className="dialog-error" role="alert">{error}</p>}
      {hex ? <HexViewer file={file} /> : readError ? <p className="dialog-error" role="alert">{readError}</p> :
        !document && <div className="dialog-body">Loading…</div>}
      {document && <>
        {preview && !hex && (
          <div className="markdown">
            <Markdown remarkPlugins={[remarkGfm]} skipHtml
              components={{
                a: ({ children }) => <span className="markdown-link">{children}</span>,
                img: ({ alt }) => <span>{alt}</span>,
                pre: ({ children }) => {
                  if (isValidElement<{ className?: string; children?: ReactNode }>(children) &&
                      children.props.className === "language-mermaid" && typeof children.props.children === "string") {
                    return <MermaidDiagram source={children.props.children} light={light} />;
                  }
                  return <pre>{children}</pre>;
                },
              }}>{text}</Markdown>
          </div>
        )}
        <div className="source-surface" hidden={preview || hex}>
          <Suspense fallback={<p className="text-view" role="status">Loading text tools…</p>}>
            <CodeSurface fileName={file.name} editing={editing} locked={saving} active={active && !preview && !hex}
              value={text} onChange={setText} />
          </Suspense>
        </div>
      </>}
      <footer className="dialog-footer">
        {document && <span className="footer-message">{document.encoding.replaceAll("_", " ").toUpperCase()}{dirty ? " · Modified" : ""}</span>}
        {editing && <Button className="primary" disabled={!dirty || saving} shortcut={showShortcut(saveShortcut)} onClick={() => { void save(); }}>
          <Save /> {saving ? "Saving…" : "Save"}
        </Button>}
        <Button onClick={close} disabled={saving}>Close</Button>
      </footer>
      {confirm && <Dialog title="Unsaved changes" onClose={() => setConfirm(false)}>
        <div className="dialog-body"><p>Discard the unsaved changes to <strong>{file.name}</strong>?</p></div>
        <footer className="dialog-footer">
          <Button type="button" data-initial-focus onClick={() => setConfirm(false)}>Keep editing</Button>
          <Button type="button" className="negative" onClick={onClose}>Discard changes</Button>
        </footer>
      </Dialog>}
    </section>
  );
}

type DiffResult =
  | { rows: { kind: string; left: string; right: string; group: number | null }[]; groups: number }
  | { error: string };

function compare(left: string, right: string, whitespace: boolean): DiffResult {
  if (Math.max(left.length, right.length) > 2 * 1024 * 1024) return { error: "Choose files under 2 MiB." };
  const changes = diffLines(normalized(left), normalized(right), {
    ignoreWhitespace: !whitespace, timeout: 1500, maxEditLength: 10_000,
  });
  if (!changes) return { error: "These files contain too many differences to compare." };
  const rows: Extract<DiffResult, { rows: unknown }>["rows"] = [];
  let groups = 0;
  let removed: string[] = [];
  let added: string[] = [];
  function flush() {
    if (!removed.length && !added.length) return;
    groups++;
    for (let index = 0; index < Math.max(removed.length, added.length); index++) {
      rows.push({
        kind: index < removed.length && index < added.length ? "changed" : index < removed.length ? "removed" : "added",
        left: removed[index] ?? "", right: added[index] ?? "", group: groups,
      });
    }
    removed = [];
    added = [];
  }
  // Keep original whitespace on both sides of unchanged lines.
  const oldLines = normalized(left).split("\n");
  const newLines = normalized(right).split("\n");
  if (oldLines.length > 20_000 || newLines.length > 20_000) return { error: "Choose files shorter than 20,000 lines." };
  let leftIndex = 0;
  let rightIndex = 0;
  for (const change of changes) {
    const count = change.count ?? 0;
    if (change.added) {
      added.push(...newLines.slice(rightIndex, rightIndex + count));
      rightIndex += count;
    } else if (change.removed) {
      removed.push(...oldLines.slice(leftIndex, leftIndex + count));
      leftIndex += count;
    } else {
      flush();
      for (let index = 0; index < count; index++) {
        rows.push({ kind: "same", group: null, left: oldLines[leftIndex++] ?? "", right: newLines[rightIndex++] ?? "" });
      }
    }
  }
  flush();
  return { rows, groups };
}

export function CompareDialog({ left, right, previousShortcut, nextShortcut, onClose }: {
  left: NamedFile;
  right: NamedFile;
  previousShortcut: string;
  nextShortcut: string;
  onClose: () => void;
}) {
  const [documents, setDocuments] = useState<{ left: string; right: string } | null>(null);
  const [error, setError] = useState("");
  const [whitespace, setWhitespace] = useState(false);
  const [current, setCurrent] = useState(0);
  const output = useRef<HTMLDivElement>(null);
  const result = useMemo(() => documents && compare(documents.left, documents.right, whitespace), [documents, whitespace]);
  const computed = result && "rows" in result ? result : null;
  const groups = computed?.groups ?? 0;

  useEffect(() => {
    let cancelled = false;
    Promise.all([readPlaceText(left), readPlaceText(right)])
      .then(([left, right]) => { if (!cancelled) setDocuments({ left: left.text, right: right.text }); },
        (error: unknown) => { if (!cancelled) setError(describeError(error)); });
    return () => { cancelled = true; };
  }, [left, right]);

  function jump(offset: number) {
    if (!groups) return;
    const group = current === 0 ? offset > 0 ? 1 : groups : (current - 1 + offset + groups) % groups + 1;
    setCurrent(group);
    output.current?.querySelector(`[data-change="${group}"]`)?.scrollIntoView({ block: "center" });
  }

  const failure = error || (result && "error" in result ? result.error : "");
  return (
    <Dialog title="Compare files" wide onClose={onClose} onKeyDown={(event) => {
      const shortcut = eventShortcut(event);
      if (shortcut && (shortcut === previousShortcut || shortcut === nextShortcut)) {
        event.preventDefault();
        jump(shortcut === previousShortcut ? -1 : 1);
      }
    }}>
      <div className="comparison-toolbar">
        <Button disabled={!groups} shortcut={showShortcut(previousShortcut)} onClick={() => jump(-1)}><ArrowUp /> Previous</Button>
        <Button disabled={!groups} shortcut={showShortcut(nextShortcut)} onClick={() => jump(1)}><ArrowDown /> Next</Button>
        <span>{current ? `${current} / ${groups}` : `${groups} ${groups === 1 ? "change" : "changes"}`}</span>
        <label><input type="checkbox" checked={whitespace} onChange={(event) => {
          setWhitespace(event.target.checked); setCurrent(0);
        }} /> Show whitespace changes</label>
      </div>
      <div className="comparison-head"><span title={left.name}>{left.name}</span><span title={right.name}>{right.name}</span></div>
      {failure && <p className="dialog-error" role="alert">{failure}</p>}
      {!documents && !failure && <div className="dialog-body">Loading…</div>}
      {computed && (
        <div className="comparison" ref={output} tabIndex={0} aria-label="File differences">
          {computed.rows.map((row, index) => (
            <div key={index} className={`diff-row ${row.kind}${row.group !== null && row.group === current ? " current" : ""}`}
              data-change={row.group ?? undefined}>
              <span>{row.left || " "}</span><span>{row.right || " "}</span>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
