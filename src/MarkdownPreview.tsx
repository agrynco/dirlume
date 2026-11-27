import { t } from "./i18n";
import { createContext, isValidElement, useContext, useId, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import { toString } from "mdast-util-to-string";
import type { Parent, PhrasingContent, Root } from "mdast";
import type { Root as HtmlRoot } from "hast";
import { visit } from "unist-util-visit";
import { api, describeError, type NamedFile } from "./api";
import { isMarkdownFile, type MarkdownPosition, type OpenMarkdownLink } from "./markdown";
import { MermaidDiagram } from "./MermaidDiagram";
import type { Palette } from "./appearance";
import { viewFontStyle } from "./viewFonts";

export type TaskMarker = { start: number; end: number };
type Task = TaskMarker & { label: string };
const TaskContext = createContext<Task | null>(null);
const PreviewContext = createContext<{
  writable: boolean;
  saving: boolean;
  light: boolean;
  colors?: Palette;
  diagramScale: number;
  mermaidScale?: number;
  onToggleTask?: (marker: TaskMarker, checked: boolean) => void;
  followLink?: (href: string, newTab: boolean) => void;
} | null>(null);
const documentOrigin = "https://markdown.dirlume.invalid";
const scheme = /^[a-z][a-z\d+.-]*:/i;

function readDiagramScale(fontSize: number | undefined) {
  if (fontSize === undefined) return 1;
  const base = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--markdown-size"));
  return base > 0 ? fontSize / base : 1;
}

function useDiagramScale(fontSize: number | undefined, light: boolean, colors?: Palette) {
  const [scale, setScale] = useState(() => readDiagramScale(fontSize));
  useLayoutEffect(() => {
    setScale(readDiagramScale(fontSize));
  }, [fontSize, light, colors]);
  return scale;
}

interface TableNoWrap extends Parent {
  type: "tableNoWrap";
  children: PhrasingContent[];
}

declare module "mdast" {
  interface RootContentMap {
    tableNoWrap: TableNoWrap;
  }
  interface PhrasingContentMap {
    tableNoWrap: TableNoWrap;
  }
}

const openingSpan = /^<span(?=\s|>)/i;
const closingSpan = /^<\/span\s*>$/i;
const htmlAttribute = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+)))?/g;

function hasNoWrapStyle(tag: string) {
  for (const [, name, doubleQuoted, singleQuoted, unquoted] of tag.matchAll(htmlAttribute)) {
    if (name.toLowerCase() !== "style") continue;
    const style = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
    const whiteSpace = style.split(";").reverse().find((rule) => /^\s*white-space\s*:/i.test(rule));
    return whiteSpace !== undefined && /^\s*white-space\s*:\s*nowrap\s*$/i.test(whiteSpace);
  }
  return false;
}

function remarkTableNoWrap() {
  return (tree: Root) => visit(tree, "tableCell", (cell) => {
    const open: { index: number; noWrap: boolean }[] = [];
    const parsed: PhrasingContent[] = [];
    for (const child of cell.children) {
      if (child.type === "html") {
        if (openingSpan.test(child.value)) {
          open.push({ index: parsed.length, noWrap: hasNoWrapStyle(child.value) });
        } else if (closingSpan.test(child.value)) {
          const span = open.pop();
          if (span?.noWrap) {
            const [, ...children] = parsed.splice(span.index);
            // Render a fixed span without passing any source HTML attributes to the browser.
            parsed.push({ type: "tableNoWrap", children, data: { hName: "span", hProperties: { className: ["markdown-nowrap"] } } });
            continue;
          }
        }
      }
      parsed.push(child);
    }
    cell.children = parsed;
  });
}

function remarkTaskMarkers() {
  return (tree: Root, file: { toString(): string }) => {
    const source = file.toString();
    visit(tree, "listItem", (item) => {
      if (typeof item.checked !== "boolean") return;
      const start = item.position?.start.offset;
      const end = item.children[0]?.position?.start.offset;
      if (start === undefined || end === undefined) return;
      // GFM's first child starts after the checkbox. Only look between the list marker and that child.
      const marker = /\[[ xX\t\r\n>]+\]/.exec(source.slice(start, end));
      if (!marker) return;
      item.data ??= {};
      item.data.hProperties = {
        ...item.data.hProperties,
        dataTaskStart: start + marker.index + 1,
        dataTaskEnd: start + marker.index + marker[0].length - 1,
        dataTaskLabel: toString(item.children[0]).trim(),
      };
    });
  };
}

function rehypeTaskRows() {
  return (tree: HtmlRoot) => visit(tree, "element", (item) => {
    if (item.tagName !== "li" || !Array.isArray(item.properties.className) ||
        !item.properties.className.includes("task-list-item")) return;
    const head = item.children.find((child) => child.type !== "text");
    const content = head?.type === "element" && head.tagName === "p" ? head.children : item.children;
    const marker = content.findIndex((child) => child.type === "element" &&
      child.tagName === "input" && child.properties.type === "checkbox");
    if (marker === -1) return;
    const rest = content.slice(marker + 1);
    const nextBlock = rest.findIndex((child) => child.type === "element" &&
      /^(blockquote|div|h[1-6]|hr|ol|p|pre|table|ul)$/.test(child.tagName));
    const label = nextBlock === -1 ? rest : rest.slice(0, nextBlock);
    content.splice(marker, label.length + 1, {
      type: "element", tagName: "span", properties: { className: ["field-checkbox"] },
      children: [content[marker], { type: "element", tagName: "span", properties: {}, children: label }],
    });
  });
}

function taskFromProperties(properties: Record<string, unknown> | undefined): Task | null {
  const start = properties?.dataTaskStart;
  const end = properties?.dataTaskEnd;
  const label = properties?.dataTaskLabel;
  if (typeof start !== "number" || typeof end !== "number" || typeof label !== "string") return null;
  return { start, end, label };
}

function TaskCheckbox({ type, checked }: ComponentProps<"input">) {
  const task = useContext(TaskContext);
  const preview = useContext(PreviewContext);
  if (type !== "checkbox") return null;
  return <input type="checkbox" checked={Boolean(checked)} disabled={!task || !preview?.writable}
    aria-disabled={preview?.saving || undefined} onClick={(event) => { if (preview?.saving) event.preventDefault(); }}
    aria-label={task?.label || t("Markdown task")} onChange={(event) => {
      if (task && !preview?.saving) preview?.onToggleTask?.(task, event.target.checked);
    }} />;
}

function isWebLink(href: string) {
  return /^https?:\/\//i.test(href) || href.startsWith("//");
}

function PreviewLink({ href, children, ...props }: ComponentProps<"a">) {
  const preview = useContext(PreviewContext);
  const followLink = preview?.followLink;
  if (!followLink || !href || (scheme.test(href) && !isWebLink(href))) return <span>{children}</span>;
  return <a {...props} className="markdown-link" href={href} onAuxClick={(event) => event.preventDefault()}
    onClick={(event) => {
      event.preventDefault();
      followLink(href, event.ctrlKey || event.metaKey);
    }}>{children}</a>;
}

function PreviewCode({ children }: ComponentProps<"pre">) {
  const preview = useContext(PreviewContext);
  if (preview && isValidElement<{ className?: string; children?: ReactNode }>(children) &&
      children.props.className === "language-mermaid" && typeof children.props.children === "string") {
    return <MermaidDiagram key={children.props.children} source={children.props.children} light={preview.light} colors={preview.colors}
      sharedScale={preview.diagramScale} preferredScale={preview.mermaidScale} />;
  }
  return <pre>{children}</pre>;
}

const components: Components = {
  a: ({ node: _node, ...props }) => <PreviewLink {...props} />,
  img: ({ alt }) => <span>{alt}</span>,
  li: ({ node, children, ...props }) => (
    <li {...props}><TaskContext.Provider value={taskFromProperties(node?.properties)}>{children}</TaskContext.Provider></li>
  ),
  input: TaskCheckbox,
  pre: PreviewCode,
};

function MarkdownContent({ source, prefix, htmlFormatting = false }: {
  source: string;
  prefix: string;
  htmlFormatting?: boolean;
}) {
  return <Markdown remarkPlugins={htmlFormatting ? [remarkGfm, remarkTaskMarkers, remarkTableNoWrap] : [remarkGfm, remarkTaskMarkers]}
    rehypePlugins={[rehypeTaskRows, [rehypeSlug, { prefix }]]} skipHtml components={components}>{source}</Markdown>;
}

export function ReadOnlyMarkdown({ source, light, fontSize, mermaidScale }: {
  source: string; light: boolean; fontSize?: number; mermaidScale?: number;
}) {
  const diagramScale = useDiagramScale(fontSize, light);
  return <div className="markdown" tabIndex={0} data-font-zoom="markdown" style={viewFontStyle(fontSize)}>
    <div className="markdown-content">
      <PreviewContext.Provider value={{ writable: false, saving: false, light, diagramScale, mermaidScale }}>
        <MarkdownContent source={source} prefix="dirlume-quick-view-" />
      </PreviewContext.Provider>
    </div>
  </div>;
}

async function resolveFileLink({ place }: NamedFile, destination: string): Promise<NamedFile> {
  if (place.kind === "local") {
    const decodedPath = decodeURIComponent(destination);
    if (/^[/\\]{2}/.test(decodedPath)) throw new Error("Use a path relative to this document.");
    const { directory, name } = await api.resolveTextLink(place.path, decodedPath);
    return { place: { kind: "local", path: directory, parent: null }, name };
  }
  if (place.kind === "kswitcher") {
    const folders = place.path.split(/[\\/]/).filter(Boolean);
    const base = folders.map(encodeURIComponent).join("/");
    const url = new URL(destination, documentOrigin + "/" + base + "/");
    const parts = url.pathname.slice(1).split("/").map(decodeURIComponent);
    const name = parts.pop();
    if (url.origin !== documentOrigin || parts[0] !== folders[0] || !name || [...parts, name].some((part) => /[\\/]/.test(part))) {
      throw new Error("Use a file path on this source.");
    }
    return { place: { ...place, path: parts.join("\\") + (parts.length === 1 ? "\\" : "") }, name };
  }
  const basePath = place.segments.map(encodeURIComponent).join("/");
  const url = new URL(destination, documentOrigin + "/" + (basePath ? basePath + "/" : ""));
  if (url.origin !== documentOrigin) throw new Error("Use a file path on this source.");
  const segments = url.pathname.slice(1).split("/").map(decodeURIComponent);
  const name = segments.pop();
  if (!name) throw new Error("Link to a file.");
  return { place: { ...place, segments }, name };
}

export function MarkdownPreview({ file, source, active, position, scroll, onContent, light, colors, writable, saving, htmlFormatting,
  fontSize, mermaidScale, onToggleTask, onOpenDocument, onError }: {
  file: NamedFile;
  source: string;
  active: boolean;
  position?: MarkdownPosition;
  scroll: RefObject<HTMLDivElement | null>;
  onContent: (element: HTMLDivElement | null) => void;
  light: boolean;
  colors?: Palette;
  fontSize?: number;
  mermaidScale?: number;
  writable: boolean;
  saving: boolean;
  htmlFormatting: boolean;
  onToggleTask: (marker: TaskMarker, checked: boolean) => void;
  onOpenDocument: OpenMarkdownLink;
  onError: (message: string) => void;
}) {
  const handledPosition = useRef<MarkdownPosition | undefined>(undefined);
  const prefix = "dirlume-markdown-" + useId() + "-";
  const diagramScale = useDiagramScale(fontSize, light, colors);

  function scrollToFragment(fragment: string) {
    if (!fragment) {
      scroll.current?.scrollTo({ top: 0 });
      return;
    }
    const headings = scroll.current?.querySelectorAll<HTMLElement>("[id]");
    const target = Array.from(headings ?? []).find((element) => element.id === prefix + fragment || element.id === fragment);
    if (target && scroll.current) {
      scroll.current.scrollTop += target.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top;
    }
  }

  useLayoutEffect(() => {
    if (active && position && position !== handledPosition.current) {
      handledPosition.current = position;
      if ("fragment" in position) scrollToFragment(position.fragment);
      else scroll.current?.scrollTo({ top: position.scrollTop });
    }
  }, [active, position, prefix, scroll]);

  async function followLink(href: string, newTab: boolean) {
    onError("");
    try {
      if (isWebLink(href)) {
        await api.openWebLink(href.startsWith("//") ? "https:" + href : href);
        return;
      }
      const hash = href.indexOf("#");
      const fragment = hash < 0 ? undefined : decodeURIComponent(href.slice(hash + 1));
      const destination = (hash < 0 ? href : href.slice(0, hash)).split("?")[0];
      if (!destination) {
        if (fragment !== undefined) onOpenDocument(file, false, { fragment });
        return;
      }
      const linked = await resolveFileLink(file, destination);
      if (!scroll.current) return;
      const markdown = isMarkdownFile(linked.name);
      const target = markdown || fragment !== undefined ? { fragment: fragment ?? "" } : undefined;
      onOpenDocument(linked, newTab || !markdown || saving, target);
    } catch (error) {
      onError(describeError(error));
    }
  }

  return (
    <div ref={scroll} className="markdown" tabIndex={0}>
      <div className="markdown-content" ref={onContent}>
        <PreviewContext.Provider value={{ writable, saving, light, colors, diagramScale, mermaidScale, onToggleTask, followLink }}>
          <MarkdownContent source={source} prefix={prefix} htmlFormatting={htmlFormatting} />
        </PreviewContext.Provider>
      </div>
    </div>
  );
}
