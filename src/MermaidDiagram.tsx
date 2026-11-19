import { errorText, t } from "./i18n";
import { useEffect, useState } from "react";
import { reportFrontendError } from "./diagnostics";

let nextDiagram = 0;

export function MermaidDiagram({ source, light }: { source: string; light: boolean }) {
  const [result, setResult] = useState<{ image: string } | { error: string } | null>(null);
  useEffect(() => {
    let canceled = false;
    async function render() {
      setResult(null);
      try {
        const { default: mermaid } = await import("mermaid");
        if (canceled) return;
        mermaid.initialize({
          startOnLoad: false, securityLevel: "strict", htmlLabels: false, suppressErrorRendering: true,
          theme: light ? "neutral" : "dark",
        });
        const { svg } = await mermaid.render(`dirlume-diagram-${++nextDiagram}`, source);
        if (!canceled) setResult({ image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
      } catch (failure) {
        reportFrontendError("render_mermaid", failure);
        if (!canceled) setResult({ error: failure instanceof Error ? failure.message : "Invalid Mermaid diagram." });
      }
    }
    void render();
    return () => { canceled = true; };
  }, [source, light]);

  if (!result) return <p role="status">{t("Rendering diagram…")}</p>;
  if ("error" in result) return <pre className="diagram-error" role="alert">{errorText(result.error)}</pre>;
  return <img className="mermaid-diagram" alt={t("Mermaid diagram")} src={result.image} />;
}
