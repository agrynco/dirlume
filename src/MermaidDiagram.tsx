import { errorText, t } from "./i18n";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ExternalLink, Maximize, MoveHorizontal, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { ImageViewport, useImageViewport } from "./ImageViewport";
import { describeError } from "./api";
import { reportFrontendError } from "./diagnostics";
import { openDiagramWindow, type DiagramWindowData, type RenderedDiagram } from "./diagramWindow";
import type { Palette } from "./appearance";
import { bindingMatches, eventShortcut, showShortcuts, type Bindings } from "./preferences";

let nextDiagram = 0;
let renderQueue = Promise.resolve();

const zoomStep = 1.25;
const maxInlineSteps = 6;

export function DiagramViewer({ diagram, shortcuts, onClose }: { diagram: DiagramWindowData; shortcuts: Bindings; onClose: () => void }) {
  const view = useImageViewport(shortcuts.zoomFont, diagram.scale);
  const naturalSize = diagram.width && diagram.height ? { width: diagram.width, height: diagram.height } : undefined;
  const canZoom = Boolean(view.natural && !view.failed);
  const actions = {
    imageZoomOut: () => view.zoomBy(1 / zoomStep),
    imageZoomIn: () => view.zoomBy(zoomStep),
    imageFit: view.fitToWindow,
  };
  const controls = [
    { command: "imageZoomOut", label: "Zoom out", Icon: ZoomOut },
    { command: "imageZoomIn", label: "Zoom in", Icon: ZoomIn },
    { command: "imageFit", label: "Fit", Icon: Maximize },
  ] as const;
  return <Dialog title={t("Mermaid diagram")} onClose={onClose} standalone helpTopic="viewer" fontZoom="none"
    onKeyDown={(event) => {
      const shortcut = eventShortcut(event);
      if (!canZoom || event.repeat || event.nativeEvent.isComposing) return;
      const action = controls.find(({ command }) => bindingMatches(shortcuts[command], shortcut));
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      actions[action.command]();
    }}>
    <div className="text-toolbar diagram-toolbar">
      {controls.map(({ command, label, Icon }) => <Button key={command} type="button"
        aria-keyshortcuts={shortcuts[command].join(" ") || undefined} shortcut={showShortcuts(shortcuts[command])}
        disabled={!canZoom} onClick={actions[command]}><Icon aria-hidden="true" />{t(label)}</Button>)}
      {canZoom && <span role="status">{Math.round(view.scale * 100)}%</span>}
      <Button type="button" className="icon-button diagram-close" aria-label={t("Close")} onClick={onClose}>
        <X aria-hidden="true" />
      </Button>
    </div>
    {view.failed && <p className="dialog-error" role="alert">{t("Could not display this image.")}</p>}
    <ImageViewport name={t("Mermaid diagram")} url={diagram.image} view={view} naturalSize={naturalSize} hidden={view.failed} />
  </Dialog>;
}

export function MermaidDiagram({ source, light, colors, scale, fitByDefault }: {
  source: string; light: boolean; colors?: Palette; scale: number; fitByDefault: boolean;
}) {
  const [result, setResult] = useState<RenderedDiagram | { error: string } | null>(null);
  const [adjustment, setAdjustment] = useState(0);
  const [fitAtScale, setFitAtScale] = useState<number>();
  const [windowError, setWindowError] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; offset: number } | null>(null);
  const scrollId = useId();
  const [horizontal, setHorizontal] = useState({ width: 0, offset: 0, maximum: 0 });
  const background = colors?.["mermaid-node-bg"];
  const text = colors?.["mermaid-node-ink"];
  const border = colors?.["mermaid-node-border"];
  useEffect(() => {
    let canceled = false;
    setResult(null);
    async function render() {
      if (canceled) return;
      try {
        const { default: mermaid } = await import("mermaid");
        if (canceled) return;
        const customized = background || text || border;
        mermaid.initialize({
          startOnLoad: false, securityLevel: "strict", htmlLabels: false, suppressErrorRendering: true,
          theme: customized ? "base" : light ? "neutral" : "dark",
          themeVariables: customized ? {
            darkMode: !light,
            primaryColor: background ?? (light ? "#eeeeee" : "#1f2020"),
            primaryTextColor: text ?? (light ? "#111111" : "#e0dfdf"),
            primaryBorderColor: border ?? (light ? "#d5d5d5" : "#cccccc"),
            lineColor: light ? "#666666" : "#cccccc",
            textColor: light ? "#333333" : "#cccccc",
          } : undefined,
        });
        const { svg } = await mermaid.render(`dirlume-diagram-${++nextDiagram}`, source);
        if (canceled) return;
        const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
        const [, , width, height] = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number) ?? [];
        setResult({
          image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
          width: Number.isFinite(width) && width > 0 ? width : undefined,
          height: Number.isFinite(height) && height > 0 ? height : undefined,
        });
      } catch (failure) {
        reportFrontendError("render_mermaid", failure);
        if (!canceled) setResult({ error: failure instanceof Error ? failure.message : "Invalid Mermaid diagram." });
      }
    }
    renderQueue = renderQueue.then(render);
    return () => { canceled = true; };
  }, [source, light, background, text, border]);

  async function openViewer(opener: HTMLButtonElement, diagram: DiagramWindowData) {
    setWindowError("");
    opener.focus({ preventScroll: true });
    try {
      await openDiagramWindow(diagram);
      const focused = document.activeElement;
      if (opener.getClientRects().length && (focused === document.body || focused?.closest(".mermaid-tools"))) {
        opener.focus({ preventScroll: true });
      }
    } catch (error) {
      reportFrontendError("open_diagram_window", error);
      if (opener.isConnected) setWindowError(describeError(error));
    }
  }
  const diagram = result && "image" in result ? result : null;
  useLayoutEffect(() => {
    const viewport = scroll.current;
    const image = viewport?.querySelector("img");
    if (!viewport || !image) return;
    const measure = () => {
      const width = viewport.clientWidth;
      const maximum = Math.max(0, viewport.scrollWidth - width);
      const offset = Math.max(0, Math.min(maximum, Math.round(viewport.scrollLeft)));
      setHorizontal((current) => current.width === width && current.offset === offset && current.maximum === maximum
        ? current : { width, offset, maximum });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(image);
    viewport.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", measure);
    };
  }, [diagram]);
  const widthScale = diagram?.width && horizontal.width ? Math.min(1, horizontal.width / diagram.width) : 1;
  const initialScale = fitAtScale !== undefined ? widthScale * scale / fitAtScale : scale * (fitByDefault ? widthScale : 1);
  const inlineScale = initialScale * zoomStep ** adjustment;
  return <>
    {!result && <p role="status">{t("Rendering diagram…")}</p>}
    {result && "error" in result && <pre className="diagram-error" role="alert">{errorText(result.error)}</pre>}
    {diagram && <figure className="mermaid-figure">
      <figcaption data-markdown-control className="mermaid-tools">
        <Button type="button" className="icon-button" aria-label={t("Zoom out")} disabled={adjustment <= -maxInlineSteps}
          onClick={() => setAdjustment((current) => Math.max(-maxInlineSteps, current - 1))}><ZoomOut aria-hidden="true" /></Button>
        <Button type="button" className="icon-button" aria-label={t("Zoom in")} disabled={adjustment >= maxInlineSteps}
          onClick={() => setAdjustment((current) => Math.min(maxInlineSteps, current + 1))}><ZoomIn aria-hidden="true" /></Button>
        <Button type="button" className="icon-button" aria-label={t("Reset diagram zoom")} disabled={!adjustment && fitAtScale === undefined}
          onClick={() => { setAdjustment(0); setFitAtScale(undefined); }}><RotateCcw aria-hidden="true" /></Button>
        <Button type="button" aria-label={t("Fit horizontally")} disabled={!diagram.width || !horizontal.width}
          onClick={() => { setFitAtScale(scale); setAdjustment(0); }}>
          <MoveHorizontal aria-hidden="true" />{t("Fit horizontally")}
        </Button>
        <Button type="button" onClick={(event) => void openViewer(event.currentTarget, { ...diagram, scale: inlineScale })}>
          <ExternalLink aria-hidden="true" />{t("Open in new window")}
        </Button>
      </figcaption>
      {windowError && <p className="diagram-error" role="alert">{errorText(windowError)}</p>}
      {horizontal.maximum > 0 && <label className="mermaid-pan">
        <span>{t("Horizontal scroll")}</span>
        <input type="range" dir="ltr" min={0} max={horizontal.maximum} value={horizontal.offset} aria-controls={scrollId}
          onChange={(event) => {
            const viewport = scroll.current;
            if (!viewport) return;
            viewport.scrollLeft = event.currentTarget.valueAsNumber;
            setHorizontal((current) => ({ ...current, offset: Math.round(viewport.scrollLeft) }));
          }} />
      </label>}
      <div ref={scroll} id={scrollId} dir="ltr" className="mermaid-scroll" tabIndex={0} role="group"
        aria-label={t("Mermaid diagram")} data-pannable={horizontal.maximum > 0 || undefined}>
        <img className="mermaid-diagram" alt={t("Mermaid diagram")} src={diagram.image}
          width={diagram.width} height={diagram.height} style={{ width: diagram.width && diagram.width * inlineScale }} draggable={false}
          onPointerDown={(event) => {
            const viewport = scroll.current;
            if (event.pointerType !== "mouse" || event.button !== 0 || !viewport || viewport.scrollWidth <= viewport.clientWidth) return;
            event.preventDefault();
            drag.current = { id: event.pointerId, x: event.clientX, offset: viewport.scrollLeft };
            event.currentTarget.setPointerCapture(event.pointerId);
            event.currentTarget.dataset.panning = "";
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            if (start?.id === event.pointerId && event.currentTarget.hasPointerCapture(event.pointerId) && scroll.current) {
              scroll.current.scrollLeft = start.offset + start.x - event.clientX;
            }
          }}
          onLostPointerCapture={(event) => {
            if (drag.current?.id !== event.pointerId) return;
            drag.current = null;
            delete event.currentTarget.dataset.panning;
          }}
          onLoad={({ currentTarget: image }) => {
            if ((diagram.width && diagram.height) || !image.naturalWidth || !image.naturalHeight) return;
            setResult((current) => current === diagram ? { ...diagram, width: image.naturalWidth, height: image.naturalHeight } : current);
          }} />
      </div>
    </figure>}
  </>;
}
