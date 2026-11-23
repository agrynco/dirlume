import { useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Maximize, Pencil, X, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "./Button";
import { documentPath, type NamedFile } from "./api";
import { errorText, t } from "./i18n";
import { HexViewer } from "./HexViewer";
import { canEditImage, ImageViewport, useImageSource, useImageViewport } from "./ImageViewport";
import { bindingMatches, eventShortcut, showShortcuts, type Bindings, type Command } from "./preferences";

export function ImageDocument({ file, active, shortcuts, previous, next, revision, onNavigate, onClose, onEdit }: {
  file: NamedFile;
  active: boolean;
  shortcuts: Bindings;
  previous?: NamedFile;
  next?: NamedFile;
  revision: number;
  onNavigate: (image: NamedFile) => void;
  onClose: () => void;
  onEdit: () => void;
}) {
  const section = useRef<HTMLElement>(null);
  const content = useImageSource(file, revision);
  const view = useImageViewport(shortcuts.zoomFont);
  const [hex, setHex] = useState(false);
  const canZoom = Boolean(view.natural && !view.failed && !hex);
  const path = documentPath(file);
  const editable = canEditImage(file);

  useLayoutEffect(() => {
    if (active) section.current?.focus({ preventScroll: true });
  }, [active]);

  const actions: { command: Command; run: () => void; disabled?: boolean }[] = [
    { command: "imagePrevious", run: () => { if (previous) onNavigate(previous); }, disabled: !previous },
    { command: "imageNext", run: () => { if (next) onNavigate(next); }, disabled: !next },
    { command: "imageZoomOut", run: () => view.zoomBy(0.8), disabled: !canZoom },
    { command: "imageZoomIn", run: () => view.zoomBy(1.25), disabled: !canZoom },
    { command: "imageActualSize", run: view.actualSize, disabled: !canZoom },
    { command: "imageFit", run: view.fitToWindow, disabled: !canZoom },
    { command: "viewAsHex", run: () => setHex((value) => !value) },
    { command: "switchDocumentMode", run: onEdit, disabled: !editable },
    { command: "closeText", run: onClose },
    { command: "cancelText", run: onClose },
  ];
  const key = (command: Command) => showShortcuts(shortcuts[command]);
  const shortcut = (command: Command) => shortcuts[command].join(" ") || undefined;

  return <section ref={section} hidden={!active} className="text-window image-document" data-font-zoom="none" aria-label={file.name} tabIndex={-1}
    data-help-topic="viewer" onKeyDownCapture={(event) => {
      const pressed = eventShortcut(event);
      const target = event.target as HTMLElement;
      if (event.nativeEvent.isComposing || target.closest("input, textarea, select, dialog[open]")) return;
      const action = actions.find(({ command }) => bindingMatches(shortcuts[command], pressed));
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (!action.disabled && !event.repeat) action.run();
    }}>
    <header className="document-heading">
      <div className="document-status">
        {view.natural && !view.failed && <>
          <span>{t("{0} × {1} px", view.width, view.height)}</span>
          {!hex && <span role="status">{Math.round(view.scale * 100)}%</span>}
        </>}
      </div>
      <Button className="icon-button" aria-label={t("Close document")} shortcut={key("closeText")} onClick={onClose}><X /></Button>
      <h2 data-tooltip={path}>{file.name}</h2>
    </header>
    <div className="text-toolbar image-document-toolbar">
      <div className="image-controls" role="group" aria-label={t("Image navigation")}>
        <Button aria-label={t("Previous image")} aria-keyshortcuts={shortcut("imagePrevious")} shortcut={key("imagePrevious")}
          disabled={!previous} onClick={() => { if (previous) onNavigate(previous); }}><ArrowLeft />{t("Previous image")}</Button>
        <Button aria-label={t("Next image")} aria-keyshortcuts={shortcut("imageNext")} shortcut={key("imageNext")}
          disabled={!next} onClick={() => { if (next) onNavigate(next); }}>{t("Next image")}<ArrowRight /></Button>
      </div>
      <div className="image-controls" role="group" aria-label={t("Image controls")}>
        <Button className="icon-button" aria-label={t("Zoom out")} shortcut={key("imageZoomOut")}
          disabled={!canZoom} onClick={() => view.zoomBy(0.8)}><ZoomOut /></Button>
        <Button className="icon-button" aria-label={t("Zoom in")} shortcut={key("imageZoomIn")}
          disabled={!canZoom} onClick={() => view.zoomBy(1.25)}><ZoomIn /></Button>
        <Button aria-label={t("Actual size")} shortcut={key("imageActualSize")} disabled={!canZoom} onClick={view.actualSize}>100%</Button>
        <Button shortcut={key("imageFit")} disabled={!canZoom} onClick={view.fitToWindow}><Maximize />{t("Fit")}</Button>
      </div>
      <Button shortcut={key("viewAsHex")} aria-pressed={hex} onClick={() => setHex((value) => !value)}>{t("Hex")}</Button>
      {editable ? <Button shortcut={key("switchDocumentMode")} onClick={onEdit}><Pencil />{t("Open in Editor")}</Button> :
        <span className="image-view-only">{t("View only")}</span>}
    </div>
    {hex && <HexViewer file={file} revision={revision} />}
    {!hex && content && "error" in content && <p className="dialog-error" role="alert">{errorText(content.error)}</p>}
    {!hex && view.failed && <p className="dialog-error" role="alert">{t("Could not display this image.")}</p>}
    {!hex && !content && <p className="text-view" role="status">{t("Loading preview…")}</p>}
    <ImageViewport name={file.name} view={view} url={content && "url" in content ? content.url : undefined}
      hidden={hex || view.failed || !content || "error" in content} />
  </section>;
}
