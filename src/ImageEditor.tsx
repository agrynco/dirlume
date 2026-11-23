import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { Crop as CropIcon, Eye, Maximize, Redo2, RotateCcw, RotateCw, Save, Undo2, X, ZoomIn, ZoomOut } from "lucide-react";
import { api, documentPath, describeError, windowsClient } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { CropOverlay, CropToolbar, cropRatio, defaultCropRatio } from "./ImageCropControls";
import { ImageViewport, imageType, useImageViewport } from "./ImageViewport";
import { applyImageCrop, cropSize, imageMatrix, imageSize, type Crop, type ImageTransform } from "./imageCrop";
import { errorText, t } from "./i18n";
import { PathField } from "./PathField";
import { bindingMatches, eventShortcut, showShortcuts, type Bindings, type Command } from "./preferences";

export type ImageEditorHandle = { confirmClose: () => Promise<boolean> };
type ImageSource = Awaited<ReturnType<typeof api.openImageEdit>> & { url: string };
type Action = { command: Command; run: () => void; disabled?: boolean };

export function ImageEditor({ ref, directory, name, active, shortcuts, revision, onSwitch, onClose, onDirty, onSaved }: {
  ref: Ref<ImageEditorHandle>; directory: string; name: string; active: boolean; shortcuts: Bindings; revision: number;
  onSwitch: () => void; onClose: () => void; onDirty: (dirty: boolean) => void; onSaved: (replaced: boolean) => void;
}) {
  const section = useRef<HTMLElement>(null);
  const closeRequest = useRef<((confirmed: boolean) => void) | null>(null);
  const destinationId = useId();
  const view = useImageViewport(shortcuts.zoomFont);
  const [source, setSource] = useState<ImageSource>();
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [history, setHistory] = useState<ImageTransform[]>([]);
  const [index, setIndex] = useState(0);
  const [saved, setSaved] = useState<ImageTransform>();
  const [crop, setCrop] = useState<Crop>();
  const [ratio, setRatio] = useState(defaultCropRatio);
  const [dialog, setDialog] = useState<"discard" | "copy" | "replace">();
  const [destination, setDestination] = useState("");
  const [saving, setSaving] = useState(false);
  const current = history[index];
  const size = current ? imageSize(current) : undefined;
  const dirty = Boolean(current && saved && current !== saved);
  const path = documentPath({ place: { kind: "local", path: directory, parent: null }, name });

  useEffect(() => {
    let live = true;
    let url: string | undefined;
    let id: string | undefined;
    const release = (id: string) => { void api.closeImageEdit(id).catch(() => {}); };
    setSource(undefined);
    setError("");
    setCrop(undefined);
    setHistory([]);
    setSaved(undefined);
    void api.openImageEdit(directory, name).then(async (image) => {
      if (!live) { release(image.id); return; }
      id = image.id;
      const bytes = await api.readImageEdit(id);
      if (!live) return;
      url = URL.createObjectURL(new Blob([bytes], { type: imageType(name) }));
      const original = { x: 0, y: 0, width: image.width, height: image.height, turns: 0 };
      setHistory([original]);
      setIndex(0);
      setSaved(original);
      setSource({ ...image, url });
    }).catch((failure: unknown) => { if (live) setError(describeError(failure)); });
    return () => { live = false; if (id) release(id); if (url) URL.revokeObjectURL(url); };
  }, [directory, name, revision]);

  useLayoutEffect(() => { view.setNatural(size); }, [size?.width, size?.height]);
  useLayoutEffect(() => { if (active) section.current?.focus({ preventScroll: true }); }, [active]);
  useLayoutEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => { closeRequest.current?.(false); }, []);

  useImperativeHandle(ref, () => ({
    confirmClose() {
      if (saving || closeRequest.current) return Promise.resolve(false);
      if (!dirty) return Promise.resolve(true);
      setDialog("discard");
      return new Promise<boolean>((resolve) => { closeRequest.current = resolve; });
    },
  }), [dirty, saving]);

  function addEdit(next: ImageTransform) {
    setHistory([...history.slice(0, index + 1), next]);
    setIndex(index + 1);
  }

  function beginCrop() {
    if (!size || !source) return;
    const initial = cropSize(size.width * 0.8, size.height * 0.8, size, cropRatio(ratio, source));
    setCrop({ ...initial, x: Math.floor((size.width - initial.width) / 2), y: Math.floor((size.height - initial.height) / 2) });
  }

  function applyCrop() {
    if (!crop || !current) return;
    const next = applyImageCrop(current, crop);
    if (next.x !== current.x || next.y !== current.y || next.width !== current.width || next.height !== current.height) addEdit(next);
    setCrop(undefined);
  }

  function finishDialog(confirmed: boolean) {
    setDialog(undefined);
    setSaveError("");
    const resolve = closeRequest.current;
    closeRequest.current = null;
    resolve?.(confirmed);
  }

  function openCopy() {
    const dot = name.lastIndexOf(".");
    const separator = windowsClient ? "\\" : "/";
    setDestination(directory.replace(/[\\/]$/, "") + separator + name.slice(0, dot) + "-edited" + name.slice(dot));
    setSaveError("");
    setDialog("copy");
  }

  async function save(replace: boolean) {
    if (!source || !current || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      await api.saveImageEdit(source.id, replace ? null : destination.trim(), current);
      setSaved(current);
      finishDialog(true);
      onSaved(replace);
    } catch (failure) {
      setSaveError(describeError(failure));
    } finally {
      setSaving(false);
    }
  }

  const canEdit = Boolean(source && current && !error && !saving);
  const actions: Action[] = [
    { command: "imageRotateLeft", run: () => addEdit({ ...current, turns: (current.turns + 3) % 4 }), disabled: !canEdit || !!crop },
    { command: "imageRotateRight", run: () => addEdit({ ...current, turns: (current.turns + 1) % 4 }), disabled: !canEdit || !!crop },
    { command: "imageCrop", run: beginCrop, disabled: !canEdit || !!crop },
    { command: "imageApplyCrop", run: applyCrop, disabled: !crop },
    { command: "imageCancelCrop", run: () => setCrop(undefined), disabled: !crop },
    { command: "imageUndo", run: () => setIndex(index - 1), disabled: !index || !!crop || saving },
    { command: "imageRedo", run: () => setIndex(index + 1), disabled: index >= history.length - 1 || !!crop || saving },
    { command: "imageSaveCopy", run: openCopy, disabled: !canEdit || !!crop },
    { command: "imageReplace", run: () => { setSaveError(""); setDialog("replace"); }, disabled: !source?.canReplace || !dirty || !!crop || saving },
    { command: "imageZoomOut", run: () => view.zoomBy(0.8), disabled: !canEdit },
    { command: "imageZoomIn", run: () => view.zoomBy(1.25), disabled: !canEdit },
    { command: "imageFit", run: view.fitToWindow, disabled: !canEdit },
    { command: "imageActualSize", run: view.actualSize, disabled: !canEdit },
    { command: "switchDocumentMode", run: onSwitch, disabled: saving },
    { command: "closeText", run: onClose, disabled: saving },
    { command: "cancelText", run: () => { if (crop) setCrop(undefined); else onClose(); }, disabled: saving },
  ];
  const shortcut = (command: Command) => showShortcuts(shortcuts[command]);
  const button = (command: Command) => {
    const { run, disabled } = actions.find((action) => action.command === command)!;
    return { onClick: run, disabled, shortcut: shortcut(command) };
  };
  const cancelDialog = () => { if (!saving) finishDialog(false); };

  return <>
    <section ref={section} hidden={!active} className="text-window image-document image-editor" data-font-zoom="none" aria-label={name} tabIndex={-1}
      data-help-topic="editor" onKeyDownCapture={(event) => {
        const target = event.target as HTMLElement;
        if (event.nativeEvent.isComposing || target.closest("input, select, dialog[open]") ||
          (event.key === "Enter" || event.key === " ") && target.closest("button") &&
          !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) return;
        const pressed = eventShortcut(event);
        const action = actions.find(({ command, disabled }) => !disabled && bindingMatches(shortcuts[command], pressed));
        if (!action) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) action.run();
      }}>
      <header className="document-heading">
        <h2 data-tooltip={path}>{name}</h2>
        <div className="document-status">
          {dirty && <span className="document-modified">{t("Unsaved changes")}</span>}
          {size && <><span>{t("{0} × {1} px", size.width, size.height)}</span><span role="status">{Math.round(view.scale * 100)}%</span></>}
        </div>
        <Button className="icon-button" aria-label={t("Close document")} {...button("closeText")}><X /></Button>
      </header>
      <div className="text-toolbar image-editor-toolbar">
        <div className="image-controls" role="group" aria-label={t("Edit image")}>
          <Button className="icon-button" aria-label={t("Rotate left")} {...button("imageRotateLeft")}><RotateCcw /></Button>
          <Button className="icon-button" aria-label={t("Rotate right")} {...button("imageRotateRight")}><RotateCw /></Button>
          <Button aria-pressed={!!crop} {...button("imageCrop")}><CropIcon />{t("Crop")}</Button>
          <Button className="icon-button" aria-label={t("Undo")} {...button("imageUndo")}><Undo2 /></Button>
          <Button className="icon-button" aria-label={t("Redo")} {...button("imageRedo")}><Redo2 /></Button>
        </div>
        <div className="image-controls" role="group" aria-label={t("Image controls")}>
          <Button className="icon-button" aria-label={t("Zoom out")} {...button("imageZoomOut")}><ZoomOut /></Button>
          <Button className="icon-button" aria-label={t("Zoom in")} {...button("imageZoomIn")}><ZoomIn /></Button>
          <Button aria-label={t("Actual size")} {...button("imageActualSize")}>100%</Button>
          <Button {...button("imageFit")}><Maximize />{t("Fit")}</Button>
        </div>
        <Button {...button("switchDocumentMode")}><Eye />{t("Open in Viewer")}</Button>
        <div className="image-controls image-save-actions">
          <Button {...button("imageReplace")}>{t("Replace original")}</Button>
          <Button className="primary" {...button("imageSaveCopy")}><Save />{t("Save a copy")}</Button>
        </div>
      </div>
      {crop && size && source && <CropToolbar crop={crop} ratio={ratio} image={size} original={source} onCrop={setCrop} onRatio={setRatio}
        onApply={applyCrop} onCancel={() => setCrop(undefined)} applyKey={shortcut("imageApplyCrop")}
        cancelKey={shortcut("imageCancelCrop") || shortcut("cancelText")} />}
      {error && <p className="dialog-error" role="alert">{errorText(error)}</p>}
      {!error && !source && <p className="text-view" role="status">{t("Loading preview…")}</p>}
      <ImageViewport name={name} view={view} hidden={!source || !!error}>
        {source && current && <div className="image-edit-pixels">
          <img alt={name} src={source.url} draggable={false} style={{ width: source.width, height: source.height,
            transform: imageMatrix(current, view.scale) }} onError={() => setError("Could not display this image.")} />
        </div>}
        {crop && source && size && <CropOverlay crop={crop} image={size} ratio={cropRatio(ratio, source)} scale={view.scale} onChange={setCrop} />}
      </ImageViewport>
    </section>
    {dialog && createPortal(<Dialog title={t(dialog === "discard" ? "Unsaved changes" : dialog === "replace" ? "Replace original" : "Save a copy")}
      tone={dialog === "copy" ? undefined : "warning"} onClose={cancelDialog}
      footer={<>
        <Button disabled={saving} data-initial-focus={dialog !== "copy" || undefined} onClick={cancelDialog}>{t("Cancel")}</Button>
        {dialog === "discard" && <Button onClick={() => finishDialog(true)}>{t("Discard")}</Button>}
        {dialog === "replace" && <Button onClick={openCopy} disabled={saving}>{t("Save a copy")}</Button>}
        <Button className={dialog === "replace" ? "alert-confirm" : "primary"} form={dialog === "copy" ? destinationId + "-form" : undefined}
          type={dialog === "copy" ? "submit" : "button"} disabled={saving || dialog === "copy" && !destination.trim()}
          onClick={dialog === "discard" ? openCopy : dialog === "replace" ? () => void save(true) : undefined}>
          {t(saving ? "Saving…" : dialog === "replace" ? "Replace original" : "Save a copy")}</Button>
      </>}>
      <div className="dialog-body image-save-body">
        {dialog === "discard" && <p>{t("Save the changes to {0} before closing?", name)}</p>}
        {dialog === "replace" && <p>{t("Replace {0}? The image will keep its format, but camera and color profile metadata may be lost.", name)}</p>}
        {dialog === "copy" && <form id={destinationId + "-form"} onSubmit={(event) => { event.preventDefault(); void save(false); }}>
          <label htmlFor={destinationId}>{t("File destination")}</label>
          <PathField id={destinationId} label={t("File destination")} historyKey="image-copy" value={destination} required
            browse="save" initialFocus selectOnFocus readOnly={saving} onChange={setDestination} />
        </form>}
        {saveError && <p className="dialog-error" role="alert">{errorText(saveError)}</p>}
      </div>
    </Dialog>, document.body)}
  </>;
}
