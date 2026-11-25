import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Maximize, RotateCcw, RotateCw, ScanEye, ZoomIn, ZoomOut } from "lucide-react";
import { describeError, readPlaceBytes, readPlacePreviewImage, readPlacePreviewText, type BytePage, type NamedFile } from "./api";
import { BinaryPreview, looksBinary } from "./BinaryPreview";
import { ImageViewport, imageType, useImageViewport } from "./ImageViewport";
import { Button } from "./Button";
import { errorText, t } from "./i18n";
import { isMarkdownFile } from "./markdown";
import { ReadOnlyMarkdown } from "./MarkdownPreview";
import type { Side } from "./panes";
import type { Bindings } from "./preferences";

type PreviewContent = { kind: "image"; url: string } | { kind: "text"; text: string } |
  { kind: "binary"; page: BytePage } | { kind: "error"; message: string };

function renderedHtml(source: string, light: boolean) {
  const template = document.createElement("template");
  template.innerHTML = source;
  // Parse inertly so embedded content cannot load before the frame's policy is in effect.
  for (const element of template.content.querySelectorAll("script, base, link, meta, iframe, frame, object, embed, portal")) element.remove();
  for (const link of template.content.querySelectorAll("a, area")) {
    link.removeAttribute("href");
    link.removeAttribute("xlink:href");
  }
  for (const element of template.content.querySelectorAll("[autofocus]")) element.removeAttribute("autofocus");
  return `<!doctype html><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">
    <style>:root{color-scheme:${light ? "light" : "dark"}}body{font:1rem/1.5 system-ui;overflow-wrap:anywhere;margin:1rem}img{max-width:100%;height:auto}</style>
    ${template.innerHTML}`;
}

function HtmlPreview({ name, text, light, onFocusFiles }: {
  name: string;
  text: string;
  light: boolean;
  onFocusFiles: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const contents = useMemo(() => renderedHtml(text, light), [text, light]);
  const focusFiles = useEffectEvent(onFocusFiles);

  useEffect(() => {
    let pending = 0;
    function keepFileShortcuts() {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        if (document.hasFocus() && document.activeElement === frame.current) focusFiles();
      });
    }
    window.addEventListener("blur", keepFileShortcuts);
    return () => {
      window.removeEventListener("blur", keepFileShortcuts);
      cancelAnimationFrame(pending);
    };
  }, []);

  return <iframe ref={frame} className="quick-view-html" title={name} tabIndex={-1} sandbox="" srcDoc={contents} />;
}

function ImagePreview({ name, url }: { name: string; url: string }) {
  const view = useImageViewport();
  if (view.failed) return <p className="pane-empty" role="status">{t("Could not display this image.")}</p>;
  return <>
    <div className="quick-view-image-tools" role="group" aria-label={t("Image controls")}>
      <Button className="icon-button" aria-label={t("Zoom out")} disabled={!view.natural} onClick={() => view.zoomBy(0.8)}><ZoomOut /></Button>
      <Button className="icon-button" aria-label={t("Zoom in")} disabled={!view.natural} onClick={() => view.zoomBy(1.25)}><ZoomIn /></Button>
      <Button className="icon-button" aria-label={t("Fit to pane")} disabled={!view.natural} onClick={view.fitToWindow}><Maximize /></Button>
      <span className="separator" />
      <Button className="icon-button" aria-label={t("Rotate counterclockwise")} disabled={!view.natural} onClick={() => view.rotate(-1)}><RotateCcw /></Button>
      <Button className="icon-button" aria-label={t("Rotate clockwise")} disabled={!view.natural} onClick={() => view.rotate(1)}><RotateCw /></Button>
    </div>
    <ImageViewport name={name} url={url} view={view} />
  </>;
}

function PreviewFile({ file, source, light, markdownSize, shortcuts, onFocusFiles }: {
  file: NamedFile;
  source: boolean;
  light: boolean;
  markdownSize?: number;
  shortcuts: Bindings;
  onFocusFiles: () => void;
}) {
  const [target] = useState(file);
  const [content, setContent] = useState<PreviewContent>();

  useEffect(() => {
    let disposed = false;
    let url: string | undefined;
    const type = imageType(target.name);
    // Delay the read slightly while the cursor moves through several files in succession.
    const timer = window.setTimeout(async () => {
      try {
        if (type) {
          const bytes = await readPlacePreviewImage(target);
          if (disposed) return;
          url = URL.createObjectURL(new Blob([bytes], { type }));
          setContent({ kind: "image", url });
        } else {
          const preview = await readPlacePreviewText(target);
          if (!disposed) setContent("page" in preview ? { kind: "binary", page: preview.page } : { kind: "text", text: preview.text });
        }
      } catch (failure) {
        if (disposed) return;
        let message = describeError(failure);
        const undecodable = message === "The file contains binary data." ||
          message === "The file is outside the supported UTF-8 and UTF-16 text formats.";
        if (!type && target.place.kind !== "local" && (undecodable || message === "Text files can be at most 8 MiB.")) {
          try {
            const page = await readPlaceBytes(target, 0);
            if (disposed) return;
            if (!page.length) { setContent({ kind: "text", text: "" }); return; }
            if (undecodable || looksBinary(page)) { setContent({ kind: "binary", page }); return; }
          } catch (readError) {
            message = describeError(readError);
          }
        }
        if (!disposed) setContent({ kind: "error", message: t("Could not read this file: {0}", errorText(message)) });
      }
    }, 80);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
    };
  }, [target]);

  if (!content) return <p className="pane-empty" role="status">{t("Loading preview…")}</p>;
  if (content.kind === "error") return <p className="pane-empty" role="status">{content.message}</p>;
  if (content.kind === "image") return <ImagePreview name={target.name} url={content.url} />;
  if (content.kind === "binary") return <BinaryPreview file={target} initial={content.page} />;
  if (!source && isMarkdownFile(target.name)) return <ReadOnlyMarkdown source={content.text} light={light}
    fontSize={markdownSize} shortcuts={shortcuts} />;
  if (!source && /\.html?$/i.test(target.name)) return <HtmlPreview name={target.name}
    text={content.text} light={light} onFocusFiles={onFocusFiles} />;
  return <pre className="text-view" tabIndex={0}>{content.text || t("This file is empty.")}</pre>;
}

export default function QuickView({ side, file, fileKey, name, message, source, light, markdownSize, shortcuts, onFocusFiles,
  onPrevious, onNext, previousShortcut, nextShortcut }: {
  side: Side;
  file: NamedFile | null;
  fileKey: string;
  name?: string;
  message: string;
  source: boolean;
  light: boolean;
  markdownSize?: number;
  shortcuts: Bindings;
  onFocusFiles: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  previousShortcut: string;
  nextShortcut: string;
}) {
  return <section className={`pane quick-view quick-view-${side}`} aria-label={t("Quick View")} data-pane-side={side} data-help-topic="quickView" tabIndex={-1}>
    <header className="pane-heading">
      <div className="pane-title">
        <ScanEye />
        <h2>{t("Quick View")}</h2>
      </div>
      {name && <span className="quick-view-name" data-tooltip={name}>{name}</span>}
      <div className="quick-view-navigation">
        <Button className="icon-button" aria-label={t("Previous File")} shortcut={previousShortcut}
          disabled={!onPrevious} onClick={onPrevious}><ArrowLeft /></Button>
        <Button className="icon-button" aria-label={t("Next File")} shortcut={nextShortcut}
          disabled={!onNext} onClick={onNext}><ArrowRight /></Button>
      </div>
    </header>
    {file ? <PreviewFile key={fileKey} file={file} source={source} light={light} markdownSize={markdownSize}
      shortcuts={shortcuts} onFocusFiles={onFocusFiles} /> :
      <p className="pane-empty" role="status">{message}</p>}
  </section>;
}
