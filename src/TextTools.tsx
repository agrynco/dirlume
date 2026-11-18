import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Save } from "lucide-react";
import { diffLines } from "diff";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, describeError, placePath, readPlaceText, type NamedFile, type TextDocument } from "./api";
import { Dialog } from "./Dialog";
import { eventShortcut, showShortcut } from "./preferences";

function normalized(text: string) {
  return text.replaceAll(/\r\n?/g, "\n");
}

export function TextDialog({ file, editing, saveShortcut, onSaved, onClose }: {
  file: NamedFile;
  editing: boolean;
  saveShortcut: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [document, setDocument] = useState<TextDocument | null>(null);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(!editing && /\.(md|markdown)$/i.test(file.name));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const dirty = Boolean(document && normalized(document.text) !== text);
  const isMarkdown = /\.(md|markdown)$/i.test(file.name);
  const path = placePath(file.place);

  useEffect(() => {
    let cancelled = false;
    readPlaceText(file).then((value) => {
      if (!cancelled) {
        setDocument(value);
        setText(normalized(value.text));
      }
    }, (error: unknown) => {
      if (!cancelled) setError(describeError(error));
    });
    return () => { cancelled = true; };
  }, [file]);

  async function save() {
    if (!document || !dirty || saving || file.place.kind !== "local") return;
    setSaving(true);
    setError("");
    const eol = document.text.includes("\r\n") ? "\r\n" : document.text.includes("\r") ? "\r" : "\n";
    const updated = text.replaceAll("\n", eol);
    try {
      await api.saveText(file.place.path, file.name, document.text, updated);
      setDocument({ ...document, text: updated });
      onSaved();
    } catch (error) {
      setError(describeError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={file.name} wide onClose={() => {
      if (saving) return;
      if (dirty) setConfirm(true);
      else onClose();
    }} onKeyDown={(event) => {
      if (editing && saveShortcut && eventShortcut(event) === saveShortcut) {
        event.preventDefault();
        void save();
      }
    }}>
      <div className="text-toolbar">
        <span title={path}>{path}</span>
        {isMarkdown && <button onClick={() => setPreview(!preview)}>{preview ? "Source" : "Preview"}</button>}
      </div>
      {error && <p className="dialog-error" role="alert">{error}</p>}
      {!document && !error && <div className="dialog-body">Loading…</div>}
      {document && (
        preview ? (
          <div className="markdown">
            <Markdown remarkPlugins={[remarkGfm]} skipHtml
              components={{
                a: ({ children }) => <span className="markdown-link">{children}</span>,
                img: ({ alt }) => <span>{alt}</span>,
              }}>{text}</Markdown>
          </div>
        ) : editing ? (
          <textarea className="text-editor" aria-label={`Edit ${file.name}`} value={text} spellCheck={false}
            readOnly={saving} onChange={(event) => setText(event.target.value)} />
        ) : <pre className="text-view">{text}</pre>
      )}
      <footer className="dialog-footer">
        {confirm ? (
          <>
            <span className="footer-message">Discard unsaved changes?</span>
            <button onClick={() => setConfirm(false)}>Keep editing</button>
            <button className="negative" onClick={onClose}>Discard changes</button>
          </>
        ) : (
          <>
            {document && <span className="footer-message">{document.encoding.replaceAll("_", " ").toUpperCase()}{dirty ? " · Modified" : ""}</span>}
            {editing && <button className="primary" disabled={!dirty || saving} title={showShortcut(saveShortcut)} onClick={() => { void save(); }}>
              <Save /> {saving ? "Saving…" : "Save"}
            </button>}
            <button onClick={() => { if (dirty) setConfirm(true); else onClose(); }} disabled={saving}>Close</button>
          </>
        )}
      </footer>
    </Dialog>
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
        <button disabled={!groups} title={showShortcut(previousShortcut)} onClick={() => jump(-1)}><ArrowUp /> Previous</button>
        <button disabled={!groups} title={showShortcut(nextShortcut)} onClick={() => jump(1)}><ArrowDown /> Next</button>
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
