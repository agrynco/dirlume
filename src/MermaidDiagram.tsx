import { errorText, t } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Expand, Maximize, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { ImageViewport, useImageViewport } from "./ImageViewport";
import { reportFrontendError } from "./diagnostics";
import type { Palette } from "./appearance";
import { bindingMatches, eventShortcut, showShortcuts, type Bindings } from "./preferences";

let nextDiagram = 0;
let renderQueue = Promise.resolve();

type Diagram = { image: string; width?: number; height?: number };

function DiagramViewer({ diagram, shortcuts, onClose }: { diagram: Diagram; shortcuts: Bindings; onClose: () => void }) {
  const view = useImageViewport(shortcuts.zoomFont);
  const naturalSize = diagram.width && diagram.height ? { width: diagram.width, height: diagram.height } : undefined;
  const canZoom = Boolean(view.natural && !view.failed);
  const actions = {
    imageZoomOut: () => view.zoomBy(0.8),
    imageZoomIn: () => view.zoomBy(1.25),
    imageFit: view.fitToWindow,
  };
  const controls = [
    { command: "imageZoomOut", label: "Zoom out", Icon: ZoomOut },
    { command: "imageZoomIn", label: "Zoom in", Icon: ZoomIn },
    { command: "imageFit", label: "Fit", Icon: Maximize },
  ] as const;
  return <Dialog title={t("Mermaid diagram")} onClose={onClose} resizeKey="mermaid-diagram" helpTopic="viewer" fontZoom="none"
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
    </div>
    {view.failed && <p className="dialog-error" role="alert">{t("Could not display this image.")}</p>}
    <ImageViewport name={t("Mermaid diagram")} url={diagram.image} view={view} naturalSize={naturalSize} hidden={view.failed} />
  </Dialog>;
}

export function MermaidDiagram({ source, light, colors, scale = 1, shortcuts }: {
  source: string; light: boolean; colors?: Palette; scale?: number; shortcuts: Bindings;
}) {
  const [result, setResult] = useState<Diagram | { error: string } | null>(null);
  const [viewer, setViewer] = useState<Diagram | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const position = useRef<{ surface: HTMLElement; left: number; top: number }>(null);
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
          width: Number.isFinite(width) && width > 0 ? Math.ceil(width) : undefined,
          height: Number.isFinite(height) && height > 0 ? Math.ceil(height) : undefined,
        });
      } catch (failure) {
        reportFrontendError("render_mermaid", failure);
        if (!canceled) setResult({ error: failure instanceof Error ? failure.message : "Invalid Mermaid diagram." });
      }
    }
    renderQueue = renderQueue.then(render);
    return () => { canceled = true; };
  }, [source, light, background, text, border]);

  function closeViewer() {
    setViewer(null);
    requestAnimationFrame(() => {
      opener.current?.focus({ preventScroll: true });
      const old = position.current;
      old?.surface.scrollTo({ left: old.left, top: old.top });
    });
  }
  const diagram = result && "image" in result ? result : null;
  const ratio = diagram?.width && diagram.height ? diagram.width / diagram.height : null;
  const width = ratio ? `calc(min(${diagram?.width}px, 100%, 960px, ${70 * ratio}vh, ${640 * ratio}px) * ${scale})` : undefined;
  return <>
    {!result && <p role="status">{t("Rendering diagram…")}</p>}
    {result && "error" in result && <pre className="diagram-error" role="alert">{errorText(result.error)}</pre>}
    {diagram && <figure className="mermaid-figure">
      <figcaption data-markdown-control><Button ref={opener} type="button" aria-haspopup="dialog" onClick={(event) => {
        const surface = event.currentTarget.closest<HTMLElement>(".markdown");
        position.current = surface ? { surface, left: surface.scrollLeft, top: surface.scrollTop } : null;
        event.currentTarget.focus({ preventScroll: true });
        setViewer(diagram);
      }}><Expand aria-hidden="true" />{t("Open diagram")}</Button></figcaption>
      <div className="mermaid-scroll" tabIndex={0} role="group" aria-label={t("Mermaid diagram")}>
        <img className="mermaid-diagram" alt={t("Mermaid diagram")} src={diagram.image}
          width={diagram.width} height={diagram.height} style={width ? { width, maxWidth: "none", maxHeight: "none" } : undefined} />
      </div>
    </figure>}
    {viewer && createPortal(<DiagramViewer diagram={viewer} shortcuts={shortcuts} onClose={closeViewer} />, document.body)}
  </>;
}
