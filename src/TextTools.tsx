import { errorText, t } from "./i18n";
import { Message } from "./Message";
import { Button } from "./Button";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowDown, ArrowUp, Save, X } from "lucide-react";
import { describeError, placePath, readPlaceText, savePlaceText, writableTextPlace, type NamedFile, type TextDocument } from "./api";
import { Dialog } from "./Dialog";
import { HexViewer } from "./HexViewer";
import { isMarkdownFile, MarkdownPreview, type MarkdownAnchor, type OpenMarkdownLink, type TaskMarker } from "./MarkdownPreview";
import { eventShortcut, showShortcut } from "./preferences";
import { systemTheme, type Theme } from "./appearance";
import { useFontZoom } from "./useFontZoom";
import { viewFontStyle, type ViewFontSizes, type ZoomViewFont } from "./viewFonts";
import { normalized } from "./textFormat";
import type { CompareRequest, DiffBlock, DiffLine, DiffResult } from "./compare.worker";
import { SplitDivider } from "./SplitDivider";

const CodeSurface = lazy(() => import("./CodeSurface"));

export function TextWindow({ file, editing, active, theme, saveShortcut, alternateSaveShortcut, closeShortcut, cancelShortcut, hexShortcut, zoomShortcut, fontSizes, onZoom, anchor, onOpenDocument, onDirtyChange, onSaved, onClose }: {
  file: NamedFile;
  editing: boolean;
  active: boolean;
  theme: Theme;
  saveShortcut: string;
  alternateSaveShortcut: string;
  closeShortcut: string;
  cancelShortcut: string;
  hexShortcut: string;
  zoomShortcut: string;
  fontSizes: ViewFontSizes;
  onZoom: ZoomViewFont;
  anchor: MarkdownAnchor | null;
  onOpenDocument: OpenMarkdownLink;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [document, setDocument] = useState<TextDocument | null>(null);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(!editing && isMarkdownFile(file.name));
  const [htmlFormatting, setHtmlFormatting] = useState(true);
  const [hex, setHex] = useState(false);
  const [system, setSystem] = useState(systemTheme);
  const [readError, setReadError] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const writing = useRef(false);
  const [confirm, setConfirm] = useState(false);
  const dirty = Boolean(document && normalized(document.text) !== text);
  const markdownSource = document && !dirty ? document.text : text;
  const isMarkdown = isMarkdownFile(file.name);
  const writable = writableTextPlace(file.place);
  const path = placePath(file.place);
  const section = useRef<HTMLElement>(null);
  const fontView = preview && !hex ? "markdown" : editing ? "editor" : "viewer";
  const fontSize = fontSizes[fontView];
  useFontZoom(section, zoomShortcut, fontView, onZoom);
  const light = (theme === "system" ? system : theme) === "light";

  useLayoutEffect(() => {
    if (active) section.current?.focus({ preventScroll: true });
  }, [active]);

  useEffect(() => {
    if (anchor && isMarkdown) {
      setPreview(true);
      setHex(false);
    }
  }, [anchor, isMarkdown]);

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

  async function write(updated: string) {
    if (!document || writing.current || !writable) return;
    writing.current = true;
    setSaving(true);
    setError("");
    try {
      const saved = await savePlaceText(file, document, updated);
      setDocument(saved);
      setText(normalized(saved.text));
      onSaved();
    } catch (error) {
      setError(describeError(error));
    } finally {
      writing.current = false;
      setSaving(false);
    }
  }

  async function save() {
    if (!document || !dirty) return;
    const eol = document.text.includes("\r\n") ? "\r\n" : document.text.includes("\r") ? "\r" : "\n";
    await write(text.replaceAll("\n", eol));
  }

  function toggleTask({ start, end }: TaskMarker, checked: boolean) {
    if (writing.current || !writable) return;
    const updated = markdownSource.slice(0, start) + (checked ? "x" : " ") + markdownSource.slice(end);
    if (editing && dirty) setText(updated);
    else void write(updated);
  }

  function close() {
    if (saving) return;
    if (dirty) setConfirm(true);
    else onClose();
  }

  return (
    <section ref={section} style={viewFontStyle(fontSize)} hidden={!active} className="text-window" data-editing={editing} aria-label={file.name} tabIndex={-1} onKeyDownCapture={(event) => {
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
        <Button className="icon-button" type="button" aria-label={t("Close document")} onClick={close} disabled={saving}><X /></Button>
      </header>
      <div className="text-toolbar">
        <span title={path}>{path}</span>
        {isMarkdown && document && !hex && <Button onClick={() => setPreview(!preview)}>{preview ? t("Source") : t("Preview")}</Button>}
        {isMarkdown && document && preview && !hex && (
          <Button type="button" aria-pressed={htmlFormatting} onClick={() => setHtmlFormatting((enabled) => !enabled)}>
            {t("HTML formatting")}
          </Button>
        )}
        {!editing && <Button shortcut={showShortcut(hexShortcut)} aria-pressed={hex} onClick={() => setHex(!hex)}>{t("Hex")}</Button>}
      </div>
      {error && <p className="dialog-error" role="alert">{errorText(error)}</p>}
      {hex ? <HexViewer file={file} /> : readError ? <p className="dialog-error" role="alert">{errorText(readError)}</p> :
        !document && <div className="dialog-body">{t("Loading…")}</div>}
      {document && <>
        {preview && !hex && (
          <MarkdownPreview file={file} source={markdownSource} active={active} anchor={anchor} light={light}
            writable={writable} saving={saving} htmlFormatting={htmlFormatting} onToggleTask={toggleTask}
            onOpenDocument={onOpenDocument} onError={setError} />
        )}
        <div className="source-surface" hidden={preview || hex}>
          <Suspense fallback={<p className="text-view" role="status">{t("Loading text tools…")}</p>}>
            <CodeSurface fileName={file.name} editing={editing} locked={saving} active={active && !preview && !hex}
              fontSize={fontSize} value={text} onChange={setText} />
          </Suspense>
        </div>
      </>}
      <footer className="dialog-footer">
        {document && <span className="footer-message">{document.encoding.replaceAll("_", " ").toUpperCase()}{dirty ? ` · ${t("Modified")}` : ""}</span>}
        {editing && <Button className="primary" disabled={!dirty || saving} shortcut={showShortcut(saveShortcut)} onClick={() => { void save(); }}>
          <Save /> {saving ? t("Saving…") : t("Save")}
        </Button>}
        <Button onClick={close} disabled={saving}>{t("Close")}</Button>
      </footer>
      {confirm && <Dialog title={t("Unsaved changes")} onClose={() => setConfirm(false)}>
        <div className="dialog-body"><p><Message text="Discard the unsaved changes to {0}?"><strong>{file.name}</strong></Message></p></div>
        <footer className="dialog-footer">
          <Button type="button" data-initial-focus onClick={() => setConfirm(false)}>{t("Keep editing")}</Button>
          <Button type="button" className="negative" onClick={onClose}>{t("Discard changes")}</Button>
        </footer>
      </Dialog>}
    </section>
  );
}

type CompareLayout = "unified" | "side-by-side";
const compareLayoutKey = "dirlume.compare-layout";
const compareConnectorsKey = "dirlume.compare-connectors";

function compareOption(key: string, fallback: string) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

function saveCompareOption(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Keep the setting for this dialog. */ }
}

function DiffText({ line }: { line: DiffLine | null }) {
  if (!line?.text) return " ";
  return line.fragments ? line.fragments.map(({ text, changed }, index) =>
    changed ? <mark key={index}>{text}</mark> : text) : line.text;
}

function ChangeConnector({ block, ratio }: { block: DiffBlock; ratio: number }) {
  const svg = useRef<SVGSVGElement>(null);
  const lastRow = block.rows.length - 1;
  const firstMissingLeft = block.rows.findIndex(({ left }) => left === null);
  const firstMissingRight = block.rows.findIndex(({ right }) => right === null);
  const leftEnd = firstMissingLeft < 0 ? lastRow : firstMissingLeft - 1;
  const rightEnd = firstMissingRight < 0 ? lastRow : firstMissingRight - 1;
  const [ends, setEnds] = useState([leftEnd < 0 ? 0 : 100, rightEnd < 0 ? 0 : 100]);

  useLayoutEffect(() => {
    const group = svg.current?.closest(".diff-block");
    const shorter = Math.min(leftEnd, rightEnd);
    if (!group || shorter < 0 || shorter === lastRow) return;
    const row = group.children[shorter];
    const measure = () => {
      const region = group.getBoundingClientRect();
      const bottom = (row.getBoundingClientRect().bottom - region.top) / region.height * 100;
      if (Number.isFinite(bottom)) setEnds(leftEnd < rightEnd ? [bottom, 100] : [100, bottom]);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    observer.observe(row);
    return () => observer.disconnect();
  }, [leftEnd, rightEnd, lastRow, ratio]);

  const [a, b] = ends;
  return <div className="diff-connector" aria-hidden="true">
    <svg ref={svg} viewBox="0 0 24 100" preserveAspectRatio="none">
      <path data-ends={ends.join(",")} className={leftEnd < 0 ? "added" : rightEnd < 0 ? "removed" : "changed"}
        d={`M0 0 H24 V${b} C14 ${b} 10 ${a} 0 ${a} Z`} />
    </svg>
  </div>;
}

function DiffRows({ block, current, split, connectors, ratio }: {
  block: DiffBlock;
  current: number;
  split: boolean;
  connectors: boolean;
  ratio: number;
}) {
  const changed = block.group !== null;
  const unified = (left: DiffLine | null, right: DiffLine | null, kind: string) =>
    <div key={`${left?.number ?? ""}:${right?.number ?? ""}`} className={`diff-row diff-unified ${kind}`}>
      <span className="diff-number">{left?.number}</span>
      <span className="diff-number">{right?.number}</span>
      <span className="diff-sign" aria-hidden="true">{kind === "added" ? "+" : kind === "removed" ? "−" : ""}</span>
      <span className="diff-text"><DiffText line={right ?? left} /></span>
    </div>;
  const half = (line: DiffLine | null, side: "left" | "right") =>
    <div className={`diff-half ${changed && line ? side === "left" ? "removed" : "added" : ""}`} data-diff-side={side}>
      <span className="diff-number">{line?.number}</span>
      <span className="diff-text"><DiffText line={line} /></span>
    </div>;
  return <div className={`diff-block${changed && block.group === current ? " current" : ""}`}
    data-change={block.group ?? undefined}>
    {split ? block.rows.map(({ left, right }) =>
      <div key={`${left?.number ?? ""}:${right?.number ?? ""}`} className="diff-row diff-split">
        {half(left, "left")}{half(right, "right")}
      </div>
    ) : changed ? <>
      {block.rows.flatMap(({ left }) => left ? unified(left, null, "removed") : [])}
      {block.rows.flatMap(({ right }) => right ? unified(null, right, "added") : [])}
    </> : block.rows.map(({ left, right }) => unified(left, right, "same"))}
    {split && changed && connectors && <ChangeConnector block={block} ratio={ratio} />}
  </div>;
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
  const [layout, setLayout] = useState<CompareLayout>(() => compareOption(compareLayoutKey, "side-by-side") === "unified"
    ? "unified" : "side-by-side");
  const [connectors, setConnectors] = useState(() => compareOption(compareConnectorsKey, "true") === "true");
  const [ratio, setRatio] = useState(50);
  const [current, setCurrent] = useState(0);
  const [comparison, setComparison] = useState<{ documents: { left: string; right: string }; whitespace: boolean; result: DiffResult } | null>(null);
  const output = useRef<HTMLDivElement>(null);
  const result = comparison?.documents === documents && comparison.whitespace === whitespace ? comparison.result : null;
  const computed = result && "blocks" in result ? result : null;
  const groups = computed?.groups ?? 0;

  useEffect(() => {
    let cancelled = false;
    setError("");
    setDocuments(null);
    setCurrent(0);
    Promise.all([readPlaceText(left), readPlaceText(right)])
      .then(([left, right]) => { if (!cancelled) setDocuments({ left: left.text, right: right.text }); },
        (error: unknown) => { if (!cancelled) setError(describeError(error)); });
    return () => { cancelled = true; };
  }, [left, right]);

  useEffect(() => {
    if (!documents) return;
    let worker: Worker;
    const finish = (result: DiffResult) => setComparison({ documents, whitespace, result });
    const failed = () => finish({ error: "Could not compare the files." });
    try {
      worker = new Worker(new URL("./compare.worker.ts", import.meta.url), { type: "module" });
    } catch {
      failed();
      return;
    }
    worker.onmessage = (event: MessageEvent<DiffResult>) => {
      finish(event.data);
      worker.terminate();
    };
    worker.onerror = () => {
      failed();
      worker.terminate();
    };
    const request: CompareRequest = { ...documents, whitespace };
    worker.postMessage(request);
    return () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };
  }, [documents, whitespace]);

  function jump(offset: number) {
    if (!groups) return;
    const group = current === 0 ? offset > 0 ? 1 : groups : (current - 1 + offset + groups) % groups + 1;
    if (group === current) output.current?.querySelector(`[data-change="${group}"]`)?.scrollIntoView({ block: "start", inline: "nearest" });
    setCurrent(group);
  }

  useLayoutEffect(() => {
    if (current) output.current?.querySelector(`[data-change="${current}"]`)?.scrollIntoView({ block: "start", inline: "nearest" });
  }, [current, layout]);

  const split = layout === "side-by-side";
  const columns = { "--comparison-columns": `minmax(0, ${ratio}fr) var(--comparison-gutter) minmax(0, ${100 - ratio}fr)` } as CSSProperties;
  const failure = error || (result && "error" in result ? result.error : "");
  return (
    <Dialog title={t("Compare files")} wide onClose={onClose} onKeyDown={(event) => {
      const shortcut = eventShortcut(event);
      if (shortcut && (shortcut === previousShortcut || shortcut === nextShortcut)) {
        event.preventDefault();
        jump(shortcut === previousShortcut ? -1 : 1);
      }
    }}>
      <div className="comparison-toolbar">
        <Button disabled={!groups} shortcut={showShortcut(previousShortcut)} onClick={() => jump(-1)}><ArrowUp /> {t("Previous")}</Button>
        <Button disabled={!groups} shortcut={showShortcut(nextShortcut)} onClick={() => jump(1)}><ArrowDown /> {t("Next")}</Button>
        <span>{current ? `${current} / ${groups}` : `${groups} ${groups === 1 ? "change" : "changes"}`}</span>
        <label className="comparison-layout">{t("Layout")}
          <select aria-label={t("Layout")} value={layout} onChange={(event) => {
            const next = event.target.value as CompareLayout;
            setLayout(next);
            saveCompareOption(compareLayoutKey, next);
          }}>
            <option value="unified">{t("Unified")}</option>
            <option value="side-by-side">{t("Side-by-side")}</option>
          </select>
        </label>
        {split && <label><input type="checkbox" checked={connectors} onChange={(event) => {
          setConnectors(event.target.checked);
          saveCompareOption(compareConnectorsKey, String(event.target.checked));
        }} /> {t("Show change connectors")}</label>}
        <label><input type="checkbox" checked={whitespace} onChange={(event) => {
          setWhitespace(event.target.checked); setCurrent(0);
        }} /> {t("Show whitespace changes")}</label>
      </div>
      {failure && <p className="dialog-error" role="alert">{errorText(failure)}</p>}
      {!documents && !failure && <div className="dialog-body">{t("Loading…")}</div>}
      {documents && !result && !failure && <div className="dialog-body" role="status">{t("Comparing…")}</div>}
      {computed && (
        <div className="comparison" data-layout={layout} style={columns} ref={output} tabIndex={0} aria-label={t("File differences")}>
          <div className={`comparison-head${split ? " comparison-head-split" : ""}`}>
            <span title={left.name}>{left.name}</span>
            {split ? <SplitDivider label={t("Comparison divider")} className="comparison-divider" value={ratio} onResize={setRatio} />
              : <span aria-hidden="true">→</span>}
            <span title={right.name}>{right.name}</span>
          </div>
          {computed.blocks.map((block, index) =>
            <DiffRows key={index} block={block} current={current} split={split} connectors={connectors} ratio={ratio} />)}
        </div>
      )}
    </Dialog>
  );
}
