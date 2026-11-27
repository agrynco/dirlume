import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Copy, X } from "lucide-react";
import { api, describeError, documentPath, isPermissionError, textEncodingLabels, writableTextPlace, type NamedFile, type TextPage, type TextPages } from "./api";
import { Button } from "./Button";
import CodeSurface from "./CodeSurface";
import { Dialog } from "./Dialog";
import { HexViewer } from "./HexViewer";
import { errorText, locale, t } from "./i18n";
import { Message } from "./Message";
import { SudoDialog } from "./SudoDialog";
import { bindingMatches, eventShortcut, showShortcut, type Bindings } from "./preferences";
import { normalized, preferredLineEnding, restoreLineEndings } from "./textFormat";
import { viewFontStyle } from "./viewFonts";

export function PagedTextWindow({ initial, file, active, editing, shortcuts, fontSize,
  onOptions, onCopyPath, onSwitchMode, onDirtyChange, onSaved, onClose }: {
  initial: TextPages;
  file: NamedFile;
  active: boolean;
  editing: boolean;
  shortcuts: Bindings;
  fontSize?: number;
  onOptions: () => void;
  onCopyPath: (path: string) => void;
  onSwitchMode: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [info, setInfo] = useState(initial);
  const [index, setIndex] = useState(0);
  const [jump, setJump] = useState("1");
  const [page, setPage] = useState<TextPage>();
  const [text, setText] = useState("");
  const [dirtyPages, setDirtyPages] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [hex, setHex] = useState(false);
  const [sudo, setSudo] = useState(false);
  const section = useRef<HTMLElement>(null);
  const processing = useRef(false);
  const path = documentPath(file);
  const dirtyPage = page !== undefined && normalized(page.text) !== text;
  const dirty = dirtyPages || dirtyPage;
  const writable = writableTextPlace(file.place);
  const fontView = hex ? "hex" : editing ? "editor" : "viewer";
  const last = info.pageCount - 1;

  const reportDirty = useRef(onDirtyChange);
  reportDirty.current = onDirtyChange;
  useEffect(() => { reportDirty.current(dirty); }, [dirty]);
  useLayoutEffect(() => {
    if (active) section.current?.focus({ preventScroll: true });
  }, [active]);

  useEffect(() => {
    let stopped = false;
    void api.readTextPage(initial.id, 0).then((opened) => {
      if (stopped) return;
      setPage(opened);
      setText(normalized(opened.text));
    }).catch((failure: unknown) => {
      if (!stopped) setError(describeError(failure));
    }).finally(() => {
      if (!stopped) setBusy(false);
    });
    return () => { stopped = true; };
  }, [initial.id]);

  async function rememberCurrentEdit() {
    if (!editing || !page || !dirtyPage) return;
    const updated = restoreLineEndings(page.text, text, preferredLineEnding(file));
    setDirtyPages(await api.editTextPage(info.id, index, updated));
  }

  async function showPage(destination: number) {
    const next = await api.readTextPage(info.id, destination);
    setPage(next);
    setText(normalized(next.text));
    setIndex(destination);
    setJump(String(destination + 1));
  }

  async function perform(operation: () => Promise<void>, reportInDialog = false) {
    if (busy || processing.current) return;
    processing.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (failure) {
      if (reportInDialog) throw failure;
      setError(describeError(failure));
    } finally {
      processing.current = false;
      setBusy(false);
    }
  }

  function goTo(destination: number) {
    if (!Number.isInteger(destination) || destination < 0 || destination > last) return;
    void perform(async () => {
      await rememberCurrentEdit();
      await showPage(destination);
    });
  }

  async function save(sudoPassword?: string) {
    if (!editing || !writable || !dirty) return;
    await perform(async () => {
      await rememberCurrentEdit();
      const saved = await api.saveTextPages(info.id, sudoPassword);
      setInfo(saved);
      setDirtyPages(false);
      setPage(undefined);
      setText("");
      onSaved();
      await showPage(Math.min(index, saved.pageCount - 1));
    }, sudoPassword !== undefined);
  }

  function close() {
    if (busy) return;
    if (dirty) setConfirm(true);
    else onClose();
  }

  function switchMode() {
    if (!busy && writable) onSwitchMode();
  }

  return <section ref={section} hidden={!active} style={viewFontStyle(fontSize)}
    className="text-window" aria-label={file.name} tabIndex={-1}
    data-editing={editing} data-text-surface={fontView} data-font-zoom={fontView} data-help-topic={editing ? "editor" : "viewer"}
    onKeyDownCapture={(event) => {
      if (confirm || sudo) return;
      const shortcut = eventShortcut(event);
      if (!shortcut) return;
      const handler = bindingMatches(shortcuts.saveText, shortcut) ? () => void save() :
        bindingMatches(shortcuts.cancelText, shortcut) || bindingMatches(shortcuts.closeText, shortcut) ? close :
        bindingMatches(shortcuts.switchDocumentMode, shortcut) ? switchMode :
        !hex && bindingMatches(shortcuts.documentStart, shortcut) ? () => goTo(0) :
        !hex && bindingMatches(shortcuts.documentEnd, shortcut) ? () => goTo(last) : undefined;
      if (!handler) return;
      event.preventDefault();
      event.stopPropagation();
      handler();
    }}>
    <header className="document-heading text-document-heading">
      <div className="document-menu">
        <Button type="button" onClick={onOptions}>{t("Options")}</Button>
      </div>
      <div className="document-path">
        <h2 data-tooltip={path}>{path}</h2>
        <Button type="button" className="icon-button" aria-label={t("Copy file path")} onClick={() => onCopyPath(path)}>
          <Copy aria-hidden="true" />
        </Button>
      </div>
      <div className="document-status">
        <span>{textEncodingLabels[info.encoding]}</span>
        <span>{t("{0} bytes", info.length.toLocaleString(locale()))}</span>
        {(busy || dirty) && <span className="document-modified" role="status">{t(busy ? "Working…" : "Modified")}</span>}
      </div>
      <Button type="button" className="icon-button" aria-label={t("Close document")} onClick={close} disabled={busy}>
        <X aria-hidden="true" />
      </Button>
    </header>
    <div className="text-toolbar">
      <Button type="button" onClick={switchMode} disabled={busy || !writable}>
        {t(editing ? "Open in Viewer" : "Open in Editor")}
      </Button>
      {editing ? <Button type="button" shortcut={showShortcut(shortcuts.saveText[0])} onClick={() => void save()} disabled={busy || !writable || !dirty}>{t("Save")}</Button> :
        <Button type="button" aria-pressed={hex} onClick={() => setHex(!hex)}>{t("Hex")}</Button>}
      {!hex && <form className="text-page-controls" onSubmit={(event) => { event.preventDefault(); goTo(Number(jump) - 1); }}>
        <Button type="button" className="icon-button" aria-label={t("Go to start")} onClick={() => goTo(0)} disabled={busy || index === 0}>
          <ChevronsLeft aria-hidden="true" />
        </Button>
        <Button type="button" className="icon-button" aria-label={t("Previous page")} onClick={() => goTo(index - 1)} disabled={busy || index === 0}>
          <ChevronLeft aria-hidden="true" />
        </Button>
        <input type="number" aria-label={t("Page")} min={1} max={info.pageCount} required value={jump} disabled={busy}
          onChange={(event) => setJump(event.target.value)} />
        <span>{t("{0} of {1}", index + 1, info.pageCount)}</span>
        <Button type="button" className="icon-button" aria-label={t("Next page")} onClick={() => goTo(index + 1)} disabled={busy || index === last}>
          <ChevronRight aria-hidden="true" />
        </Button>
        <Button type="button" className="icon-button" aria-label={t("Go to end")} onClick={() => goTo(last)} disabled={busy || index === last}>
          <ChevronsRight aria-hidden="true" />
        </Button>
      </form>}
    </div>
    {error && <div className="pane-error"><span role="alert">{errorText(error)}</span>
      {file.place.kind === "ssh" && editing && dirty && isPermissionError(error) &&
        <Button type="button" onClick={() => setSudo(true)}>{t("Save with sudo…")}</Button>}
    </div>}
    {hex ? <HexViewer file={file} revision={0} /> :
      page && <div className="source-surface">
        <CodeSurface key={index} file={file} editing={editing} locked={busy || editing && !writable} active={active}
          fontSize={fontSize} value={text} onChange={setText} />
      </div>}
    {confirm && <Dialog title={t("Unsaved changes")} tone="warning" onClose={() => setConfirm(false)}>
      <div className="dialog-body"><p><Message text="Discard the unsaved changes to {0}?"><strong>{file.name}</strong></Message></p></div>
      <footer className="dialog-footer">
        <Button type="button" data-initial-focus onClick={() => setConfirm(false)}>{t("Keep editing")}</Button>
        <Button type="button" className="alert-confirm" onClick={onClose}>{t("Discard changes")}</Button>
      </footer>
    </Dialog>}
    {sudo && file.place.kind === "ssh" && <SudoDialog operation="save" address={file.place.address} path={path}
      onClose={() => setSudo(false)} onConfirm={save} />}
  </section>;
}
