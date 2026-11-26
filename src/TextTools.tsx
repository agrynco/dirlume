import { countText, errorText, locale, t } from "./i18n";
import { Message } from "./Message";
import { Button } from "./Button";
import { lazy, Suspense, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bookmark, Search, Settings2, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import { api, describeError, documentPath, isPermissionError, readPlaceText, savePlaceText, textEncodingLabels, watchDirectory, writableTextPlace, type NamedFile, type TextDocument } from "./api";
import { Dialog } from "./Dialog";
import { DialogDisclosure, DialogIconButton } from "./DialogActions";
import { DiagnosticLog } from "./DiagnosticLog";
import { SudoDialog } from "./SudoDialog";
import { HexViewer } from "./HexViewer";
import { isMarkdownFile, type MarkdownPosition } from "./markdown";
import type { TaskMarker } from "./MarkdownPreview";
import { useMarkdownSearch } from "./MarkdownSearch";
import { MainMenu, type MenuAction, type MenuGroup } from "./MainMenu";
import type { SourceActions, SourceStatus } from "./CodeSurface";
import { bookmarkKey, bookmarkPath, lineFingerprint, type BookmarkJump, type BookmarkResult, type FileBookmark } from "./fileBookmarks";
import { captureMarkdownAnchor, locateMarkdownAnchor, markdownSelection } from "./markdownBookmarks";
import { bindingMatches, eventShortcut, showShortcut, type Bindings, type Command } from "./preferences";
import { isLightTheme, type BaseTheme, type Palette } from "./appearance";
import { viewFontStyle, type ViewFontSizes } from "./viewFonts";
import { normalized, preferredLineEnding, restoreLineEndings } from "./textFormat";
import type { CompareRequest, DiffBlock, DiffLine, DiffResult } from "./compare.worker";
import { SplitDivider } from "./SplitDivider";
import { PathField } from "./PathField";

const CodeSurface = lazy(() => import("./CodeSurface"));
const SyntaxPicker = lazy(() => import("./SyntaxPicker"));
const MarkdownPreview = lazy(() => import("./MarkdownPreview").then(({ MarkdownPreview }) => ({ default: MarkdownPreview })));

function sameDiskContents(previous: TextDocument | null, next: TextDocument) {
  return previous?.text === next.text && previous.encoding === next.encoding && previous.revision === next.revision;
}

export function TextWindow({ file, editing, active, theme, shortcuts, fontSizes, viewerContentWidth, viewerMarkdownContentWidth, mermaidScale, colors, diagnosticLog,
  onOptions, onSwitchMode, position, canGoBack, canGoForward, onNavigate, onOpenDocument, onDirtyChange, onSaved, onClose,
  fileBookmarks, bookmarkJump, onBookmark, onFileBookmarks }: {
  file: NamedFile;
  editing: boolean;
  active: boolean;
  theme: BaseTheme;
  shortcuts: Bindings;
  fontSizes: ViewFontSizes;
  viewerContentWidth?: number;
  viewerMarkdownContentWidth?: number | "full";
  mermaidScale?: number;
  colors?: Palette;
  diagnosticLog?: boolean;
  onOptions: () => void;
  onSwitchMode: () => void;
  position?: MarkdownPosition;
  canGoBack: boolean;
  canGoForward: boolean;
  onNavigate: (direction: "back" | "forward", scrollTop: number) => void;
  onOpenDocument: (file: NamedFile, newTab: boolean, position: MarkdownPosition | undefined, scrollTop: number) => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
  onClose: () => void;
  fileBookmarks: readonly FileBookmark[];
  bookmarkJump?: BookmarkJump;
  onBookmark: (bookmark: FileBookmark) => void;
  onFileBookmarks: (path: string) => void;
}) {
  const [document, setDocument] = useState<TextDocument | null>(null);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(!editing && (!bookmarkJump || "anchor" in bookmarkJump) && isMarkdownFile(file.name));
  const [htmlFormatting, setHtmlFormatting] = useState(true);
  const [hex, setHex] = useState(false);
  const [diagnosticSource, setDiagnosticSource] = useState(false);
  const [syntax, setSyntax] = useState("auto");
  const [syntaxInfo, setSyntaxInfo] = useState<{ detected: string | undefined; unavailable: boolean }>();
  const [choosingSyntax, setChoosingSyntax] = useState(false);
  const syntaxButton = useRef<HTMLButtonElement>(null);
  const syntaxOpener = useRef<HTMLElement | null>(null);
  const [sourceStatus, setSourceStatus] = useState<SourceStatus>({ line: 1, column: 1, canUndo: false, canRedo: false });
  const [bookmarkResult, setBookmarkResult] = useState<BookmarkResult>();
  const [missingAnchor, setMissingAnchor] = useState<number>();
  const [hasBookmarkSelection, setHasBookmarkSelection] = useState(false);
  const menuSelection = useRef<Range | null>(null);
  const [hexSize, setHexSize] = useState<number>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [readError, setReadError] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [sudoAction, setSudoAction] = useState<"read" | "save" | null>(null);
  const [deniedWrite, setDeniedWrite] = useState<string | null>(null);
  const diskBusy = useRef(false);
  const diskOperation = useRef(0);
  const lastDiskContents = useRef<TextDocument | null>(null);
  const [externalChange, setExternalChange] = useState(false);
  const [reloadingDisk, setReloadingDisk] = useState(false);
  const [reloadError, setReloadError] = useState("");
  const [sourceRevision, setSourceRevision] = useState(0);
  const [hexRevision, setHexRevision] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const dirty = Boolean(document && normalized(document.text) !== text);
  const markdownSource = document && !dirty ? document.text : text;
  const isMarkdown = isMarkdownFile(file.name);
  const writable = writableTextPlace(file.place);
  const path = documentPath(file);
  const section = useRef<HTMLElement>(null);
  const sourceActions = useRef<SourceActions>(null);
  const markdownScroll = useRef<HTMLDivElement>(null);
  const [markdownContent, setMarkdownContent] = useState<HTMLDivElement | null>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const markdownVisible = Boolean(document && preview && !hex);
  const markdownViewer = markdownVisible && !editing;
  const contentWidth = markdownViewer ? viewerMarkdownContentWidth ?? viewerContentWidth : viewerContentWidth;
  const diagnosticVisible = Boolean(document && diagnosticLog && !diagnosticSource && !hex);
  const sourceVisible = Boolean(document && !preview && !hex && !diagnosticVisible);
  const localBookmarkPath = !editing && !diagnosticLog && !hex ? bookmarkPath(file) : null;
  const bookmarkLines = useMemo(() => localBookmarkPath ? new Set(fileBookmarks.flatMap((item) =>
    "line" in item && bookmarkKey(item.path) === bookmarkKey(localBookmarkPath) ? [item.line] : [])) : undefined, [fileBookmarks, localBookmarkPath]);
  const search = useMarkdownSearch(markdownContent, markdownScroll, searchOpen ? searchQuery.trim() : "",
    active && markdownViewer, markdownSource, htmlFormatting);
  const byteSize = useMemo(() => {
    if (!document) return undefined;
    const { encoding, text } = document;
    return encoding.startsWith("utf16") ? text.length * 2 + 2 :
      new TextEncoder().encode(text).length + (encoding === "utf8_bom" ? 3 : 0);
  }, [document]);
  const fileSize = hex ? hexSize ?? byteSize : byteSize;
  const fontView = hex ? "hex" : preview ? "markdown" : editing ? "editor" : "viewer";
  const fontSize = fontSizes[fontView];
  const light = isLightTheme(theme);

  useLayoutEffect(() => {
    if (active) section.current?.focus({ preventScroll: true });
  }, [active]);

  useEffect(() => {
    if (position && isMarkdown) {
      setPreview(true);
      setHex(false);
    }
  }, [position, isMarkdown]);

  useEffect(() => {
    if (!bookmarkJump) return;
    setPreview("anchor" in bookmarkJump);
    setHex(false);
  }, [bookmarkJump]);

  useEffect(() => {
    if (!active || !markdownViewer || !localBookmarkPath || !markdownContent) {
      menuSelection.current = null;
      setHasBookmarkSelection(false);
      return;
    }
    const update = () => setHasBookmarkSelection(Boolean(markdownSelection(markdownContent) ||
      (window.getSelection()?.isCollapsed && menuSelection.current)));
    window.document.addEventListener("selectionchange", update);
    update();
    return () => window.document.removeEventListener("selectionchange", update);
  }, [active, markdownViewer, localBookmarkPath, markdownContent]);

  useLayoutEffect(() => {
    const viewport = markdownScroll.current;
    if (!active || !markdownViewer || !markdownContent || !viewport || !bookmarkJump || !("anchor" in bookmarkJump)) return;
    const range = locateMarkdownAnchor(markdownContent, bookmarkJump.anchor);
    setMissingAnchor(range ? undefined : bookmarkJump.request);
    if (!range) return;
    const bounds = range.getClientRects()[0];
    if (bounds) viewport.scrollTop += bounds.top - viewport.getBoundingClientRect().top - viewport.clientHeight / 3;
    if (typeof Highlight === "function" && CSS.highlights) {
      CSS.highlights.set("markdown-bookmark", new Highlight(range));
      return () => { CSS.highlights.delete("markdown-bookmark"); };
    }
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return () => { if (selection?.rangeCount && selection.getRangeAt(0) === range) selection.removeRange(range); };
  }, [active, markdownViewer, markdownContent, markdownSource, htmlFormatting, bookmarkJump]);

  useLayoutEffect(() => {
    if (active && markdownViewer && searchOpen) searchField.current?.focus();
  }, [active, markdownViewer, searchOpen]);

  const reportDirty = useRef(onDirtyChange);
  reportDirty.current = onDirtyChange;
  useEffect(() => { reportDirty.current(dirty); }, [dirty]);

  function replaceDocument(value: TextDocument) {
    lastDiskContents.current = value;
    setExternalChange(false);
    setDocument(value);
    setText(normalized(value.text));
    setReadError("");
    setError("");
  }

  const observeDisk = useEffectEvent((value: TextDocument) => {
    setReadError("");
    if (sameDiskContents(lastDiskContents.current, value)) return;
    if (!editing || !document) replaceDocument(value);
    else {
      lastDiskContents.current = value;
      setExternalChange(!sameDiskContents(document, value));
    }
  });

  useEffect(() => {
    let stopped = false;
    let reading = false;
    let timer: number | undefined;
    let fallback: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), 150);
    };
    async function refresh() {
      if (stopped) return;
      if (reading || diskBusy.current) { schedule(); return; }
      const operation = diskOperation.current;
      reading = true;
      try {
        const value = await readPlaceText(file, undefined, editing ? "editor" : "viewer");
        if (!stopped && operation === diskOperation.current) observeDisk(value);
      } catch (error) {
        if (!stopped && operation === diskOperation.current) {
          if (!editing) {
            lastDiskContents.current = null;
            setDocument(null);
          }
          setReadError(describeError(error));
        }
      } finally {
        reading = false;
        if (!stopped && operation !== diskOperation.current) schedule();
        else if (!stopped && !editing && file.place.kind === "local") setHexRevision((revision) => revision + 1);
      }
    }
    const watch = file.place.kind === "local" ? watchDirectory(file.place.path, schedule, file.name) : undefined;
    if (watch) {
      void watch.ready.then(refresh, () => {
        if (stopped) return;
        fallback = window.setInterval(schedule, 2000);
        void refresh();
      });
    } else void refresh();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.clearInterval(fallback);
      watch?.stop();
    };
  }, [file, editing]);

  function keepEditing() {
    if (diskBusy.current) return;
    setExternalChange(false);
    setReloadError("");
  }

  async function reloadFromDisk() {
    if (diskBusy.current) return;
    diskBusy.current = true;
    diskOperation.current++;
    setReloadingDisk(true);
    setReloadError("");
    try {
      replaceDocument(await readPlaceText(file, undefined, editing ? "editor" : "viewer"));
      setSourceRevision((revision) => revision + 1);
      setSourceStatus({ line: 1, column: 1, canUndo: false, canRedo: false });
    } catch (error) {
      setReloadError(describeError(error));
    } finally {
      diskBusy.current = false;
      setReloadingDisk(false);
    }
  }

  async function write(updated: string, sudoPassword?: string) {
    if (!document || diskBusy.current || !writable) return;
    diskBusy.current = true;
    diskOperation.current++;
    setSaving(true);
    setError("");
    if (sudoPassword === undefined) setDeniedWrite(null);
    try {
      const saved = await savePlaceText(file, document, updated, sudoPassword);
      replaceDocument(saved);
      setDeniedWrite(null);
      onSaved();
    } catch (error) {
      const message = describeError(error);
      setError(message);
      if (sudoPassword !== undefined) throw error;
      if (file.place.kind === "ssh" && isPermissionError(message)) setDeniedWrite(updated);
    } finally {
      diskBusy.current = false;
      setSaving(false);
    }
  }

  async function save(sudoPassword?: string) {
    if (!document || !dirty) return;
    await write(restoreLineEndings(document.text, text, preferredLineEnding(file)), sudoPassword);
  }

  function toggleTask({ start, end }: TaskMarker, checked: boolean) {
    if (diskBusy.current || !writable) return;
    const updated = markdownSource.slice(0, start) + (checked ? "x" : " ") + markdownSource.slice(end);
    if (editing && dirty) setText(updated);
    else void write(updated);
  }

  function close() {
    if (saving) return;
    if (dirty) setConfirm(true);
    else onClose();
  }

  function find() {
    setSearchOpen(true);
    searchField.current?.focus();
    searchField.current?.select();
  }

  function closeSearch() {
    setSearchOpen(false);
    markdownScroll.current?.focus({ preventScroll: true });
  }

  function copySelection() {
    const selection = window.getSelection();
    const selectionText = sourceVisible ? sourceActions.current?.selection() : "";
    const content = selectionText ||
      (selection?.anchorNode && section.current?.contains(selection.anchorNode) ? selection.toString() : "");
    if (content) {
      const copy = isTauri() ? api.copyText(content) : navigator.clipboard.writeText(content);
      void copy.catch((failure: unknown) => setError(describeError(failure)));
    }
  }

  function selectAllText() {
    if (sourceVisible) {
      sourceActions.current?.selectAll();
    } else {
      const contents = markdownContent ?? section.current?.querySelector(".diagnostic-log:not([hidden]), .hex-view");
      if (contents) window.getSelection()?.selectAllChildren(contents);
    }
  }

  type Action = MenuAction & { command?: Command };
  const key = (command: Command) => showShortcut(shortcuts[command][0]);
  const action = (label: string, command: Command, run: () => void, disabled = false): Action =>
    ({ label, command, run, disabled, shortcut: key(command) });
  const saveAction = action("Save", "saveText", () => void save(), !dirty || !writable || saving);
  const closeAction = action("Close", "closeText", close, saving);
  closeAction.shortcut ||= key("cancelText");
  const navigate = (direction: "back" | "forward") => onNavigate(direction, markdownScroll.current?.scrollTop ?? 0);
  const back = action("Back", "documentBack", () => navigate("back"), !canGoBack);
  const forward = action("Forward", "documentForward", () => navigate("forward"), !canGoForward);
  const searchAction = action("Search", "documentSearch", find);
  const hexAction = action("Hex", "viewAsHex", () => setHex(!hex));
  const bookmarkAction = action("Bookmark line", "bookmarkLine", () => {
    const line = sourceActions.current?.bookmarkLine();
    if (line && localBookmarkPath) onBookmark({ path: localBookmarkPath, line: line.line, fingerprint: lineFingerprint(line.text) });
  });
  const bookmarkSelection = action("Bookmark selection", "bookmarkLine", () => {
    if (!markdownContent || !localBookmarkPath) return;
    const range = markdownSelection(markdownContent) ?? (window.getSelection()?.isCollapsed ? menuSelection.current : null);
    menuSelection.current = null;
    if (!range) return;
    const anchor = captureMarkdownAnchor(markdownContent, range);
    if (anchor) onBookmark({ path: localBookmarkPath, anchor });
    setHasBookmarkSelection(Boolean(markdownSelection(markdownContent)));
  }, !hasBookmarkSelection);
  const bookmarksAction = action("File bookmarks", "fileBookmarks", () => {
    if (localBookmarkPath) onFileBookmarks(localBookmarkPath);
  });
  const switchMode = action(editing ? "Open in Viewer" : "Open in Editor", "switchDocumentMode", onSwitchMode,
    saving || sudoAction !== null || (!editing && (!writable || !document)));
  const fileActions = [...(editing ? [saveAction] : []), switchMode, closeAction];
  const selectionActions = [
    ...(editing && sourceVisible ? [
      action("Undo", "documentUndo", () => sourceActions.current?.undo(), saving || !sourceStatus.canUndo),
      action("Redo", "documentRedo", () => sourceActions.current?.redo(), saving || !sourceStatus.canRedo),
    ] : []),
    action("Copy", "documentCopy", copySelection),
    action("Select all", "documentSelectAll", selectAllText),
  ];
  const navigationActions = [...(markdownViewer ? [back, forward, searchAction] : sourceVisible ? [
    action("Go to start", "documentStart", () => sourceActions.current?.goToStart()),
    action("Go to end", "documentEnd", () => sourceActions.current?.goToEnd()),
  ] : []), ...(localBookmarkPath && document ? [
    ...(markdownViewer ? [bookmarkSelection] : sourceVisible ? [bookmarkAction] : []), bookmarksAction,
  ] : [])];
  const menuGroups: MenuGroup[] = [
    { label: "File", items: fileActions },
    { label: editing ? "Edit" : "Selection", items: selectionActions },
    ...(navigationActions.length || !editing ? [
      { label: "Navigate", items: [...navigationActions, ...(!editing && !markdownViewer ? [hexAction] : [])] },
    ] : []),
    ...(sourceVisible ? [{ label: "Syntax", items: [
      { label: "Automatic", run: () => setSyntax("auto") },
      { label: "Plain text", run: () => setSyntax("plain") },
      { label: "Choose syntax…", run: () => openSyntax(section.current?.querySelector<HTMLElement>(
        '[data-menu-group="' + menuGroups.findIndex(({ label }) => label === "Syntax") + '"]') ?? null) },
    ] }] : []),
  ];
  function openSyntax(opener: HTMLElement | null) {
    syntaxOpener.current = opener;
    setChoosingSyntax(true);
  }
  function closeSyntax() {
    setChoosingSyntax(false);
    requestAnimationFrame(() => {
      const opener = syntaxOpener.current;
      (opener?.isConnected ? opener : syntaxButton.current)?.focus();
    });
  }

  return (
    <section ref={section} style={{ ...viewFontStyle(fontSize),
      "--viewer-content-width": typeof contentWidth === "number" ? `${contentWidth}px` : undefined,
    } as CSSProperties}
      hidden={!active} className="text-window" data-text-surface={fontView} data-font-zoom={fontView}
      data-help-topic={editing ? "editor" : "viewer"} data-editing={editing}
      data-limited-width={typeof contentWidth === "number" || undefined}
      aria-label={file.name} tabIndex={-1} onPointerDownCapture={(event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!markdownViewer || target?.closest("[role=menu]")) return;
      menuSelection.current = target?.closest(".document-menu") ? markdownSelection(markdownContent)?.cloneRange() ?? null : null;
    }} onKeyDownCapture={(event) => {
      if (confirm) return;
      const shortcut = eventShortcut(event);
      if (!shortcut) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[role=menubar], dialog[open]")) return;
      const cancel = bindingMatches(shortcuts.cancelText, shortcut);
      if (cancel && target?.hasAttribute("data-history-open")) return;
      const action = [
        ...fileActions, ...navigationActions, ...(!editing ? [hexAction] : []),
        ...(!target?.closest("input, select, textarea") ? selectionActions : []),
      ].find(({ command }) => command && bindingMatches(shortcuts[command], shortcut));
      if (!cancel && !action) return;
      event.preventDefault();
      event.stopPropagation();
      if (cancel) (searchOpen && markdownViewer ? closeSearch : close)();
      else if (action && !action.disabled && !(action === switchMode && event.repeat)) action.run();
    }}>
      <header className="document-heading">
        <div className="document-menu">
          <MainMenu key={sourceVisible ? "source" : markdownViewer ? "markdown" : "other"}
            groups={menuGroups} label="Document menu" />
          <Button type="button" aria-label={t(editing ? "Editor options" : "Viewer options")} onClick={onOptions}>
            <Settings2 aria-hidden="true" /> {t("Options")}
          </Button>
        </div>
        <div className="document-status">
          <span>{t(editing ? "Edit" : "View")}</span>
          {document && <span className="document-encoding">{textEncodingLabels[document.encoding]}</span>}
          {sourceVisible && <div className="syntax-toolbar">
            <Button ref={syntaxButton} aria-label={t("Syntax")} aria-haspopup="dialog" onClick={(event) => openSyntax(event.currentTarget)}>
              {syntax === "auto" ? t("Automatic ({0})", syntaxInfo?.detected ?? t("Plain text")) :
                syntax === "plain" ? t("Plain text") : syntax}
            </Button>
            {syntaxInfo?.unavailable && <span role="status">{t("Syntax unavailable.")}</span>}
          </div>}
          {fileSize !== undefined && <span>{t("{0} bytes", fileSize.toLocaleString(locale()))}</span>}
          {sourceVisible && <span>{t("Ln {0}, Col {1}", sourceStatus.line, sourceStatus.column)}</span>}
          {(saving || dirty) && <span className="document-modified">{t(saving ? "Saving…" : "Modified")}</span>}
        </div>
        <Button className="icon-button" type="button" aria-label={t("Close document")} shortcut={closeAction.shortcut}
          onClick={close} disabled={saving}><X /></Button>
        <h2 data-tooltip={path}>{path}</h2>
      </header>
      <div className="text-toolbar">
        {markdownViewer && <>
          <Button type="button" shortcut={back.shortcut} disabled={back.disabled} onClick={back.run}>
            <ArrowLeft aria-hidden="true" /> {t(back.label)}
          </Button>
          <Button type="button" shortcut={forward.shortcut} disabled={forward.disabled} onClick={forward.run}>
            <ArrowRight aria-hidden="true" /> {t(forward.label)}
          </Button>
          <Button type="button" shortcut={searchAction.shortcut} aria-expanded={searchOpen} onClick={searchAction.run}>
            <Search aria-hidden="true" /> {t(searchAction.label)}
          </Button>
        </>}
        {isMarkdown && document && !hex && <Button onClick={() => setPreview(!preview)}>{preview ? t("Source") : t("Preview")}</Button>}
        {diagnosticLog && document && !hex && <div className="diagnostic-view-controls" role="group" aria-label={t("Error log view")}>
          <Button type="button" aria-pressed={!diagnosticSource} onClick={() => setDiagnosticSource(false)}>{t("Entries")}</Button>
          <Button type="button" aria-pressed={diagnosticSource} onClick={() => setDiagnosticSource(true)}>{t("Source")}</Button>
        </div>}
        {isMarkdown && document && preview && !hex && (
          <Button type="button" aria-pressed={htmlFormatting} onClick={() => setHtmlFormatting((enabled) => !enabled)}>
            {t("HTML formatting")}
          </Button>
        )}
        {!editing && <Button shortcut={hexAction.shortcut} aria-pressed={hex} onClick={hexAction.run}>{t(hexAction.label)}</Button>}
        {localBookmarkPath && document && <Button type="button" shortcut={bookmarksAction.shortcut} onClick={bookmarksAction.run}>
          <Bookmark aria-hidden="true" /> {t(bookmarksAction.label)}
        </Button>}
      </div>
      {markdownViewer && searchOpen && <form className="markdown-search" onSubmit={(event) => { event.preventDefault(); search.move(1); }}>
        <input ref={searchField} type="search" aria-label={t("Search rendered Markdown")} placeholder={t("Search rendered Markdown")}
          value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.shiftKey) { event.preventDefault(); search.move(-1); }
          }} />
        <span role="status">{searchQuery.trim() && (search.count ? t("{0} of {1}", search.current, search.count) : t("No match"))}</span>
        <Button type="button" className="icon-button" aria-label={t("Previous match")} disabled={!search.count}
          onClick={() => search.move(-1)}><ArrowUp aria-hidden="true" /></Button>
        <Button type="submit" className="icon-button" aria-label={t("Next match")} disabled={!search.count}><ArrowDown aria-hidden="true" /></Button>
        <Button type="button" className="icon-button" aria-label={t("Close search")} onClick={closeSearch}><X aria-hidden="true" /></Button>
      </form>}
      {(error || (readError && !hex)) && <div className="pane-error">
        <span role="alert">{errorText(error || readError)}</span>
        {file.place.kind === "ssh" && !saving && (deniedWrite !== null && (!editing || dirty)
          ? <Button type="button" onClick={() => setSudoAction("save")}>{t("Save with sudo…")}</Button>
          : !error && isPermissionError(readError) &&
            <Button type="button" onClick={() => setSudoAction("read")}>{t("Open with sudo…")}</Button>)}
      </div>}
      {sourceVisible && bookmarkResult && bookmarkResult.request === bookmarkJump?.request &&
        (bookmarkResult.changed || bookmarkResult.requested !== bookmarkResult.shown) &&
        <p role="status" className="bookmark-position-status">{bookmarkResult.changed ?
          t("Line {0} has changed since it was bookmarked.", bookmarkResult.requested) :
          t("Bookmark line {0} is past the end of the file. Showing line {1}.", bookmarkResult.requested, bookmarkResult.shown)}</p>}
      {markdownViewer && missingAnchor !== undefined && missingAnchor === bookmarkJump?.request &&
        <p role="status" className="bookmark-position-status">{t("Could not locate the bookmarked passage.")}</p>}
      {hex ? <HexViewer file={file} revision={hexRevision} onSize={setHexSize} /> :
        !document && !readError && <div className="dialog-body">{t("Loading…")}</div>}
      {document && <>
        {preview && !hex && (
          <Suspense fallback={<p className="text-view" role="status">{t("Loading text tools…")}</p>}>
          <MarkdownPreview file={file} source={markdownSource} active={active} position={position} light={light} colors={colors}
            scroll={markdownScroll} onContent={setMarkdownContent} fontSize={fontSizes.markdown} mermaidScale={mermaidScale}
            writable={writable} saving={saving} htmlFormatting={htmlFormatting} onToggleTask={toggleTask}
            onOpenDocument={(target, newTab, next) => onOpenDocument(target, newTab, next, markdownScroll.current?.scrollTop ?? 0)} onError={setError} />
          </Suspense>
        )}
        {diagnosticVisible && <DiagnosticLog source={document.text} />}
        <div className="source-surface" hidden={!sourceVisible}>
          <Suspense fallback={<p className="text-view" role="status">{t("Loading text tools…")}</p>}>
            <CodeSurface key={sourceRevision} file={file} editing={editing} locked={saving} active={active && sourceVisible}
              fontSize={fontSize} readingWidth={editing ? undefined : viewerContentWidth} value={text} onChange={setText}
              bookmarkLines={bookmarkLines} bookmarkJump={bookmarkJump && "line" in bookmarkJump ? bookmarkJump : undefined} onBookmarkResult={setBookmarkResult}
              onBookmarkLine={localBookmarkPath ? (line, lineText) =>
                onBookmark({ path: localBookmarkPath, line, fingerprint: lineFingerprint(lineText) }) : undefined}
              ref={sourceActions} onSourceStatus={setSourceStatus} syntaxOverride={syntax} onSyntaxInfo={setSyntaxInfo} />
          </Suspense>
        </div>
      </>}
      {editing && <footer className="document-shortcuts" aria-label={t("Document shortcuts")}>
        {fileActions.map((hint) => hint.shortcut && <Button type="button" key={hint.label} disabled={hint.disabled}
          shortcut={hint.shortcut} tooltip={t(hint.label)} onClick={hint.run}><kbd>{hint.shortcut}</kbd> {t(hint.label)}</Button>)}
      </footer>}
      {choosingSyntax && sourceVisible && <Suspense>
        <SyntaxPicker syntax={syntax} editing={editing} onSelect={(choice) => { setSyntax(choice); closeSyntax(); }} onClose={closeSyntax} />
      </Suspense>}
      {sudoAction && file.place.kind === "ssh" && <SudoDialog operation={sudoAction} address={file.place.address}
        path={path} onClose={() => setSudoAction(null)}
        onConfirm={async (password) => {
          if (sudoAction === "read") {
            replaceDocument(await readPlaceText(file, password, editing ? "editor" : "viewer"));
          } else if (editing) await save(password);
          else if (deniedWrite !== null) await write(deniedWrite, password);
        }} />}
      {confirm && <Dialog title={t("Unsaved changes")} tone="warning" onClose={() => setConfirm(false)}>
        <div className="dialog-body"><p><Message text="Discard the unsaved changes to {0}?"><strong>{file.name}</strong></Message></p></div>
        <footer className="dialog-footer">
          <Button type="button" data-initial-focus onClick={() => setConfirm(false)}>{t("Keep editing")}</Button>
          <Button type="button" className="alert-confirm" onClick={onClose}>{t("Discard changes")}</Button>
        </footer>
      </Dialog>}
      {active && externalChange && !confirm && !saving && <Dialog title={t("File changed on disk")} tone="warning" onClose={keepEditing}
        footer={<>
          <Button type="button" data-initial-focus disabled={reloadingDisk} onClick={keepEditing}>{t("Keep editing")}</Button>
          <Button type="button" className="alert-confirm" disabled={reloadingDisk} onClick={() => void reloadFromDisk()}>{t("Reload from disk")}</Button>
        </>}>
        <div className="dialog-body">
          <p><Message text="{0} was changed outside Dirlume."><strong>{file.name}</strong></Message></p>
          <p>{t(dirty ? "Reloading will discard your unsaved edits." : "Reload to open the version currently on disk.")}</p>
          {reloadError && <p className="dialog-error" role="alert">{errorText(reloadError)}</p>}
        </div>
      </Dialog>}
    </section>
  );
}

type CompareLayout = "unified" | "side-by-side";
const compareLayoutKey = "dirlume.compare-layout";
const compareConnectorsKey = "dirlume.compare-connectors";
const compareCollapseKey = "dirlume.compare-collapse";
const compareSides = ["left", "right"] as const;
type CompareSide = typeof compareSides[number];

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

export function CompareDialog({ left, right, previousShortcut, nextShortcut, swapShortcut, onClose, onDirtyChange, standalone = false }: {
  left: NamedFile;
  right: NamedFile;
  previousShortcut: readonly string[];
  nextShortcut: readonly string[];
  swapShortcut: readonly string[];
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  standalone?: boolean;
}) {
  const [documents, setDocuments] = useState<Record<CompareSide, string> | null>(null);
  const [originals, setOriginals] = useState<Record<CompareSide, TextDocument> | null>(null);
  const [error, setError] = useState("");
  const [whitespace, setWhitespace] = useState(false);
  const [layout, setLayout] = useState<CompareLayout>(() => compareOption(compareLayoutKey, "side-by-side") === "unified"
    ? "unified" : "side-by-side");
  const [swapped, setSwapped] = useState(false);
  const [initialEditor, setInitialEditor] = useState<CompareSide>("left");
  const [connectors, setConnectors] = useState(() => compareOption(compareConnectorsKey, "true") === "true");
  const [collapse, setCollapse] = useState(() => compareOption(compareCollapseKey, "false") === "true");
  const [expanded, setExpanded] = useState<number[]>([]);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [destinations, setDestinations] = useState<Record<CompareSide, string | null>>({ left: null, right: null });
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const writing = useRef(false);
  const [ratio, setRatio] = useState(50);
  const [current, setCurrent] = useState(0);
  const [comparison, setComparison] = useState<{ documents: { left: string; right: string }; whitespace: boolean; result: DiffResult } | null>(null);
  const output = useRef<HTMLDivElement>(null);
  const result = comparison?.documents === documents && comparison.whitespace === whitespace ? comparison.result : null;
  const computed = result && "blocks" in result ? result : null;
  const groups = computed?.groups ?? 0;
  const files = { left, right };
  const order = swapped ? ["right", "left"] as const : compareSides;
  const [leftFile, rightFile] = order;
  const dirty = order.filter((side) => originals && documents && normalized(originals[side].text) !== documents[side]);
  const displayedBlocks = useMemo(() => swapped ? computed?.blocks.map((block) => ({
    ...block, rows: block.rows.map(({ left, right }) => ({ left: right, right: left })),
  })) : computed?.blocks, [computed, swapped]);
  const hasChanges = dirty.length > 0;
  const reportDirty = useRef(onDirtyChange);
  reportDirty.current = onDirtyChange;
  useEffect(() => { reportDirty.current?.(hasChanges); }, [hasChanges]);

  useEffect(() => {
    let cancelled = false;
    setError("");
    setDocuments(null);
    setOriginals(null);
    setCurrent(0);
    Promise.all([readPlaceText(left, undefined, "compare"), readPlaceText(right, undefined, "compare")])
      .then(([left, right]) => {
        if (cancelled) return;
        setOriginals({ left, right });
        setDocuments({ left: normalized(left.text), right: normalized(right.text) });
        setDestinations({
          left: writableTextPlace(files.left.place) ? null : "",
          right: writableTextPlace(files.right.place) ? null : "",
        });
      },
        (error: unknown) => { if (!cancelled) setError(describeError(error)); });
    return () => { cancelled = true; };
  }, [left, right]);

  function requestClose() {
    if (writing.current) return;
    if (dirty.length) { setSaveError(""); setConfirm(true); }
    else onClose();
  }

  const closeRequest = useRef(requestClose);
  closeRequest.current = requestClose;
  useEffect(() => {
    if (!standalone) return;
    const listener = getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      closeRequest.current();
    });
    return () => { void listener.then((unlisten) => unlisten()).catch(() => {}); };
  }, [standalone]);

  async function saveAndClose() {
    if (!documents || !originals || writing.current) return;
    writing.current = true;
    setSaving(true);
    setSaveError("");
    try {
      for (const side of dirty) {
        const original = originals[side];
        const text = restoreLineEndings(original.text, documents[side], preferredLineEnding(files[side]));
        const destination = destinations[side];
        let saved: TextDocument;
        if (destination === null) saved = await savePlaceText(files[side], original, text);
        else {
          await api.saveTextAs(destination.trim(), original.encoding, text);
          saved = { ...original, text };
        }
        setOriginals((previous) => previous && { ...previous, [side]: saved });
      }
      onClose();
    } catch (failure) {
      setSaveError(describeError(failure));
    } finally {
      writing.current = false;
      setSaving(false);
    }
  }

  const activeGroup = computed?.blocks.find(({ group }) => group === (current || 1));
  function merge(source: CompareSide, destination: CompareSide) {
    if (!documents || !activeGroup?.ranges) return;
    const sourceRange = activeGroup.ranges[source];
    const destinationRange = activeGroup.ranges[destination];
    const sourceLines = documents[source].match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const destinationLines = documents[destination].match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const contents = sourceLines.slice(sourceRange.start, sourceRange.start + sourceRange.length);
    destinationLines.splice(destinationRange.start, destinationRange.length, ...contents);
    setDocuments({ ...documents, [destination]: destinationLines.join("") });
    setCurrent(0);
  }

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
  const applyActions = [
    { label: t("Apply to left"), disabled: !activeGroup?.ranges, run: () => merge(rightFile, leftFile) },
    { label: t("Apply to right"), disabled: !activeGroup?.ranges, run: () => merge(leftFile, rightFile) },
  ];
  return <>
    <Dialog title={t("Compare files")} helpTopic="compare" fontZoom="compare" wide standalone={standalone} onClose={requestClose}
      onKeyDownCapture={(event) => {
        if (!split || saving || confirm || event.nativeEvent.isComposing || !bindingMatches(swapShortcut, eventShortcut(event))) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        const focused = document.activeElement;
        setSwapped((current) => !current);
        if (focused instanceof HTMLElement && focused.closest(".comparison-editors")) {
          requestAnimationFrame(() => { if (focused.isConnected) focused.focus({ preventScroll: true }); });
        }
      }}
      onKeyDown={(event) => {
        const shortcut = eventShortcut(event);
        const previous = bindingMatches(previousShortcut, shortcut);
        if (previous || bindingMatches(nextShortcut, shortcut)) {
          event.preventDefault();
          jump(previous ? -1 : 1);
        }
      }}>
      <div className="comparison-toolbar">
        <div className="dialog-action-group">
          <DialogIconButton label={t("Previous")} disabled={!groups} shortcut={showShortcut(previousShortcut[0])}
            onClick={() => jump(-1)}><ArrowUp /></DialogIconButton>
          <DialogIconButton label={t("Next")} disabled={!groups} shortcut={showShortcut(nextShortcut[0])}
            onClick={() => jump(1)}><ArrowDown /></DialogIconButton>
          <span>{current ? t("{0} / {1}", current, groups) : countText(groups, "change")}</span>
        </div>
        <div className="comparison-apply-inline dialog-actions">
          <Button type="button" disabled={applyActions[0].disabled} onClick={applyActions[0].run}><ArrowLeft aria-hidden="true" /> {applyActions[0].label}</Button>
          <Button type="button" disabled={applyActions[1].disabled} onClick={applyActions[1].run}>{applyActions[1].label} <ArrowRight aria-hidden="true" /></Button>
        </div>
        <DialogDisclosure className="comparison-apply-menu" label={t("Apply")} actions={applyActions} />
        <DialogDisclosure className="comparison-options" label={t("Options")}>
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
          <label className="field-checkbox"><input type="checkbox" checked={editing} disabled={!documents} onChange={(event) => {
            setInitialEditor(leftFile);
            setEditing(event.target.checked);
          }} /><span>{t("Edit files")}</span></label>
          {split && <label className="field-checkbox"><input type="checkbox" checked={connectors} onChange={(event) => {
            setConnectors(event.target.checked);
            saveCompareOption(compareConnectorsKey, String(event.target.checked));
          }} /><span>{t("Show change connectors")}</span></label>}
          <label className="field-checkbox"><input type="checkbox" checked={whitespace} onChange={(event) => {
            setWhitespace(event.target.checked); setCurrent(0);
          }} /><span>{t("Show whitespace changes")}</span></label>
          <label className="field-checkbox"><input type="checkbox" checked={collapse} onChange={(event) => {
            setCollapse(event.target.checked); setExpanded([]); saveCompareOption(compareCollapseKey, String(event.target.checked));
          }} /><span>{t("Collapse unchanged sections")}</span></label>
        </DialogDisclosure>
      </div>
      {failure && <p className="dialog-error" role="alert">{errorText(failure)}</p>}
      {!documents && !failure && <div className="dialog-body">{t("Loading…")}</div>}
      {documents && !result && !failure && <div className="dialog-body" role="status">{t("Comparing…")}</div>}
      {documents && <div className="comparison-editors" hidden={!editing}>
        {order.map((side) => <section key={side} className="comparison-editor text-window" data-editing="true"
          aria-label={t(side === leftFile ? "Left file" : "Right file")}>
          <div className="comparison-editor-name" data-tooltip={documentPath(files[side])}>{files[side].name}{dirty.includes(side) ? " *" : ""}</div>
          <Suspense fallback={<div className="dialog-body">{t("Loading editor…")}</div>}>
            <CodeSurface file={files[side]} editing locked={saving} active={editing && side === initialEditor}
              value={documents[side]} onChange={(text) => {
                setDocuments((previous) => previous && { ...previous, [side]: text });
                setCurrent(0);
              }} />
          </Suspense>
        </section>)}
      </div>}
      {computed && !editing && (
        <div className="comparison" data-layout={layout} style={columns} ref={output} tabIndex={0} aria-label={t("File differences")}>
          <div className={`comparison-head${split ? " comparison-head-split" : ""}`}>
            <span data-tooltip={files[leftFile].name}>{files[leftFile].name}</span>
            {split ? <SplitDivider label={t("Comparison divider")} className="comparison-divider" value={ratio} onResize={setRatio} />
              : <span aria-hidden="true">→</span>}
            <span data-tooltip={files[rightFile].name}>{files[rightFile].name}</span>
          </div>
          {displayedBlocks?.map((block, index) => collapse && block.group === null && block.rows.length > 6 && !expanded.includes(index)
            ? <Button key={index} type="button" className="diff-unchanged" onClick={() => setExpanded((items) => [...items, index])}>
              {t("Show {0} unchanged lines", block.rows.length)}
            </Button>
            : <DiffRows key={`${index}:${swapped}`} block={block} current={current} split={split} connectors={connectors} ratio={ratio} />)}
        </div>
      )}
    </Dialog>
    {confirm && <Dialog title={t("Unsaved changes")} tone="warning" onClose={() => { if (!saving) setConfirm(false); }}>
      <div className="dialog-body transfer-body">
        {dirty.map((side) => <fieldset className="comparison-save" key={side} disabled={saving}>
          <legend>{t(side === leftFile ? "Left file" : "Right file")} · {files[side].name}</legend>
          <label className="field">{t("Save changes")}
            <select value={destinations[side] === null ? "original" : "copy"}
              onChange={(event) => setDestinations({ ...destinations, [side]: event.target.value === "original" ? null : "" })}>
              <option value="original" disabled={!writableTextPlace(files[side].place)}>{t("Overwrite original")}</option>
              <option value="copy">{t("Save as")}</option>
            </select>
          </label>
          {destinations[side] !== null && <PathField id={`compare-save-${side}`} label={t("Save as")} value={destinations[side]}
            onChange={(path) => setDestinations({ ...destinations, [side]: path })}
            browse="save" browsePath={files[side].name} includeFiles />}
        </fieldset>)}
        {saveError && <p role="alert" className="dialog-error">{errorText(saveError)}</p>}
      </div>
      <footer className="dialog-footer">
        <Button type="button" data-initial-focus disabled={saving} onClick={() => setConfirm(false)}>{t("Keep editing")}</Button>
        <Button type="button" className="alert-confirm" disabled={saving} onClick={onClose}>{t("Discard changes")}</Button>
        <Button type="button" className="primary" disabled={saving || dirty.some((side) => destinations[side]?.trim() === "")}
          onClick={() => { void saveAndClose(); }}>{t(saving ? "Saving…" : "Save and close")}</Button>
      </footer>
    </Dialog>}
  </>;
}
