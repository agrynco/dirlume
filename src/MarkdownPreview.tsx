import { t } from "./i18n";
import { createContext, isValidElement, useContext, useId, useLayoutEffect, useRef, type ComponentProps, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import { toString } from "mdast-util-to-string";
import type { Parent, PhrasingContent, Root } from "mdast";
import { visit } from "unist-util-visit";
import { api, describeError, type NamedFile } from "./api";
import { isMarkdownFile } from "./markdown";
import { MermaidDiagram } from "./MermaidDiagram";
import type { Palette } from "./appearance";

export type MarkdownAnchor = { fragment: string };
export type OpenMarkdownLink = (file: NamedFile, newTab: boolean, anchor?: MarkdownAnchor) => void;
export type TaskMarker = { start: number; end: number };
type Task = TaskMarker & { label: string };
const TaskContext = createContext<Task | null>(null);
const PreviewContext = createContext<{
  writable: boolean;
  saving: boolean;
  light: boolean;
  colors?: Palette;
  onToggleTask: (marker: TaskMarker, checked: boolean) => void;
  followLink: (href: string, newTab: boolean) => void;
} | null>(null);
const documentOrigin = "https://markdown.dirlume.invalid";
const scheme = /^[a-z][a-z\d+.-]*:/i;

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
      if (task && !preview?.saving) preview?.onToggleTask(task, event.target.checked);
    }} />;
}

function isWebLink(href: string) {
  return /^https?:\/\//i.test(href) || href.startsWith("//");
}

function PreviewLink({ href, children, ...props }: ComponentProps<"a">) {
  const preview = useContext(PreviewContext);
  if (!href || (scheme.test(href) && !isWebLink(href))) return <span>{children}</span>;
  return <a {...props} className="markdown-link" href={href} onAuxClick={(event) => event.preventDefault()}
    onClick={(event) => {
      event.preventDefault();
      preview?.followLink(href, event.ctrlKey || event.metaKey);
    }}>{children}</a>;
}

function PreviewCode({ children }: ComponentProps<"pre">) {
  const preview = useContext(PreviewContext);
  if (isValidElement<{ className?: string; children?: ReactNode }>(children) &&
      children.props.className === "language-mermaid" && typeof children.props.children === "string") {
    return <MermaidDiagram source={children.props.children} light={preview?.light ?? false} colors={preview?.colors} />;
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

async function resolveFileLink({ place }: NamedFile, destination: string): Promise<NamedFile> {
  if (place.kind === "local") {
    const decodedPath = decodeURIComponent(destination);
    if (/^[/\\]{2}/.test(decodedPath)) throw new Error("Use a path relative to this document.");
    const { directory, name } = await api.resolveTextLink(place.path, decodedPath);
    return { place: { kind: "local", path: directory, parent: null }, name };
  }
  const basePath = place.segments.map(encodeURIComponent).join("/");
  const url = new URL(destination, documentOrigin + "/" + (basePath ? basePath + "/" : ""));
  if (url.origin !== documentOrigin) throw new Error("Use a file path on this source.");
  const segments = url.pathname.slice(1).split("/").map(decodeURIComponent);
  const name = segments.pop();
  if (!name) throw new Error("Link to a file.");
  return { place: { ...place, segments }, name };
}

export function MarkdownPreview({ file, source, active, anchor, light, colors, writable, saving, htmlFormatting, onToggleTask, onOpenDocument, onError }: {
  file: NamedFile;
  source: string;
  active: boolean;
  anchor: MarkdownAnchor | null;
  light: boolean;
  colors?: Palette;
  writable: boolean;
  saving: boolean;
  htmlFormatting: boolean;
  onToggleTask: (marker: TaskMarker, checked: boolean) => void;
  onOpenDocument: OpenMarkdownLink;
  onError: (message: string) => void;
}) {
  const preview = useRef<HTMLDivElement>(null);
  const handledAnchor = useRef<MarkdownAnchor | null>(null);
  const prefix = "dirlume-markdown-" + useId() + "-";

  function scrollToFragment(fragment: string) {
    if (!fragment) {
      preview.current?.scrollTo({ top: 0 });
      return;
    }
    const headings = preview.current?.querySelectorAll<HTMLElement>("[id]");
    const target = Array.from(headings ?? []).find((element) => element.id === prefix + fragment || element.id === fragment);
    target?.scrollIntoView({ block: "start" });
  }

  useLayoutEffect(() => {
    if (active && anchor && anchor !== handledAnchor.current) {
      handledAnchor.current = anchor;
      scrollToFragment(anchor.fragment);
    }
  }, [active, anchor, prefix]);

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
        if (fragment !== undefined) scrollToFragment(fragment);
        return;
      }
      const linked = await resolveFileLink(file, destination);
      if (!preview.current) return;
      const markdown = isMarkdownFile(linked.name);
      const target = markdown || fragment !== undefined ? { fragment: fragment ?? "" } : undefined;
      onOpenDocument(linked, newTab || !markdown || saving, target);
    } catch (error) {
      onError(describeError(error));
    }
  }

  return (
    <div ref={preview} className="markdown">
      <PreviewContext.Provider value={{ writable, saving, light, colors, onToggleTask, followLink }}>
        <Markdown remarkPlugins={htmlFormatting ? [remarkGfm, remarkTaskMarkers, remarkTableNoWrap] : [remarkGfm, remarkTaskMarkers]} rehypePlugins={[[rehypeSlug, { prefix }]]}
          skipHtml components={components}>{source}</Markdown>
      </PreviewContext.Provider>
    </div>
  );
}
