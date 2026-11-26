import { invoke, isTauri } from "@tauri-apps/api/core";
import { t } from "./i18n";

export type RenderedDiagram = { image: string; width?: number; height?: number };
export type DiagramWindowData = RenderedDiagram & { scale: number };

type DiagramHost = Window & {
  __dirlumeDiagram?: DiagramWindowData;
  __dirlumeDiagramRequests?: Map<string, DiagramWindowData>;
};

let nextRequest = 0;

export function readDiagramWindow(): DiagramWindowData | undefined {
  if (isTauri()) return (window as DiagramHost).__dirlumeDiagram;
  const id = new URLSearchParams(location.search).get("mermaid-window");
  if (!id) return;
  try {
    const requests = (window.opener as DiagramHost | null)?.__dirlumeDiagramRequests;
    const diagram = requests?.get(id);
    requests?.delete(id);
    return diagram;
  } catch {
    return undefined;
  }
}

export async function openDiagramWindow(diagram: DiagramWindowData) {
  if (isTauri()) {
    await invoke("open_tool_window", { title: t("Mermaid diagram"), diagram });
    return;
  }
  const host = window as DiagramHost;
  const requests = host.__dirlumeDiagramRequests ??= new Map();
  const id = String(++nextRequest);
  const url = new URL(location.href);
  url.searchParams.set("mermaid-window", id);
  requests.set(id, diagram);
  const popup = window.open(url, "_blank", "popup,width=1040,height=670");
  if (!popup) {
    requests.delete(id);
    throw new Error(t("Could not open the diagram window."));
  }
  await new Promise<void>((resolve) => {
    const timer = window.setInterval(() => {
      if (!popup.closed) return;
      window.clearInterval(timer);
      requests.delete(id);
      resolve();
    }, 150);
  });
}
