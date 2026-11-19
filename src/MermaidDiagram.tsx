import { errorText, t } from "./i18n";
import { useEffect, useState } from "react";
import { reportFrontendError } from "./diagnostics";
import type { Palette } from "./appearance";

let nextDiagram = 0;
let renderQueue = Promise.resolve();

export function MermaidDiagram({ source, light, colors }: { source: string; light: boolean; colors?: Palette }) {
  const [result, setResult] = useState<{ image: string; width?: number; height?: number } | { error: string } | null>(null);
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

  if (!result) return <p role="status">{t("Rendering diagram…")}</p>;
  if ("error" in result) return <pre className="diagram-error" role="alert">{errorText(result.error)}</pre>;
  return <img className="mermaid-diagram" alt={t("Mermaid diagram")} src={result.image}
    width={result.width} height={result.height} />;
}
