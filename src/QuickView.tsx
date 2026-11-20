import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Maximize, RotateCcw, RotateCw, ScanEye, ZoomIn, ZoomOut } from "lucide-react";
import { describeError, readPlacePreviewImage, readPlaceText, type NamedFile } from "./api";
import { Button } from "./Button";
import { errorText, t } from "./i18n";
import { isMarkdownFile } from "./markdown";
import { ReadOnlyMarkdown } from "./MarkdownPreview";
import type { Side } from "./panes";

const imageTypes: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
};

type PreviewContent = { kind: "image"; url: string } | { kind: "text"; text: string } | { kind: "error"; message: string };
type Size = { width: number; height: number };

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
  const [natural, setNatural] = useState<Size>();
  const [viewport, setViewport] = useState<Size>({ width: 1, height: 1 });
  const [turns, setTurns] = useState(0);
  const [zoom, setZoom] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const measure = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  const width = turns % 2 ? natural?.height : natural?.width;
  const height = turns % 2 ? natural?.width : natural?.height;
  const fit = width && height ? Math.min(1, Math.max(1, viewport.width - 16) / width, Math.max(1, viewport.height - 16) / height) : 1;
  const scale = zoom ?? fit;
  function changeZoom(factor: number) {
    setZoom(Math.max(Math.min(1 / 16, fit), Math.min(16, scale * factor)));
  }

  if (failed) return <p className="pane-empty" role="status">{t("Could not display this image.")}</p>;
  return <>
    <div className="quick-view-image-tools" role="group" aria-label={t("Image controls")}>
      <Button className="icon-button" aria-label={t("Zoom out")} disabled={!natural} onClick={() => changeZoom(0.8)}><ZoomOut /></Button>
      <Button className="icon-button" aria-label={t("Zoom in")} disabled={!natural} onClick={() => changeZoom(1.25)}><ZoomIn /></Button>
      <Button className="icon-button" aria-label={t("Fit to pane")} disabled={!natural} onClick={() => setZoom(null)}><Maximize /></Button>
      <span className="separator" />
      <Button className="icon-button" aria-label={t("Rotate counterclockwise")} disabled={!natural}
        onClick={() => setTurns((current) => (current + 3) % 4)}><RotateCcw /></Button>
      <Button className="icon-button" aria-label={t("Rotate clockwise")} disabled={!natural}
        onClick={() => setTurns((current) => (current + 1) % 4)}><RotateCw /></Button>
    </div>
    <div className="quick-view-image-canvas" ref={canvas} tabIndex={0}>
      <div className="quick-view-image" style={{ width: (width ?? 0) * scale, height: (height ?? 0) * scale }}>
        <img alt={name} src={url} draggable={false} style={{
          width: (natural?.width ?? 0) * scale, height: (natural?.height ?? 0) * scale,
          transform: `translate(-50%, -50%) rotate(${turns * 90}deg)`,
        }} onLoad={({ currentTarget }) => setNatural({ width: currentTarget.naturalWidth, height: currentTarget.naturalHeight })}
        onError={() => setFailed(true)} />
      </div>
    </div>
  </>;
}

function PreviewFile({ file, source, light, onFocusFiles }: {
  file: NamedFile;
  source: boolean;
  light: boolean;
  onFocusFiles: () => void;
}) {
  const [target] = useState(file);
  const [content, setContent] = useState<PreviewContent>();

  useEffect(() => {
    let disposed = false;
    let url: string | undefined;
    const extension = /\.([^.]+)$/.exec(target.name)?.[1].toLowerCase();
    const type = extension && Object.hasOwn(imageTypes, extension) ? imageTypes[extension] : undefined;
    // Delay the read slightly while the cursor moves through several files in succession.
    const timer = window.setTimeout(async () => {
      try {
        if (type) {
          const bytes = await readPlacePreviewImage(target);
          if (disposed) return;
          url = URL.createObjectURL(new Blob([bytes], { type }));
          setContent({ kind: "image", url });
        } else {
          const { text } = await readPlaceText(target);
          if (!disposed) setContent({ kind: "text", text });
        }
      } catch (failure) {
        if (disposed) return;
        const message = describeError(failure);
        setContent({ kind: "error", message: message === "The file contains binary data." ||
          message === "The file is outside the supported UTF-8 and UTF-16 text formats."
          ? t("This file type cannot be previewed.") : t("Could not read this file: {0}", errorText(message)) });
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
  if (!source && isMarkdownFile(target.name)) return <ReadOnlyMarkdown source={content.text} light={light} />;
  if (!source && /\.html?$/i.test(target.name)) return <HtmlPreview name={target.name}
    text={content.text} light={light} onFocusFiles={onFocusFiles} />;
  return <pre className="text-view" tabIndex={0}>{content.text || t("This file is empty.")}</pre>;
}

export default function QuickView({ side, file, fileKey, name, message, source, light, onFocusFiles }: {
  side: Side;
  file: NamedFile | null;
  fileKey: string;
  name?: string;
  message: string;
  source: boolean;
  light: boolean;
  onFocusFiles: () => void;
}) {
  return <section className={`pane quick-view quick-view-${side}`} aria-label={t("Quick View")}>
    <header className="pane-heading">
      <div className="pane-title">
        <ScanEye />
        <h2>{t("Quick View")}</h2>
      </div>
      {name && <span className="quick-view-name" data-tooltip={name}>{name}</span>}
    </header>
    {file ? <PreviewFile key={fileKey} file={file} source={source} light={light} onFocusFiles={onFocusFiles} /> :
      <p className="pane-empty" role="status">{message}</p>}
  </section>;
}
