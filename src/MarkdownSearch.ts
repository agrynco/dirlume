import { useLayoutEffect, useState, type RefObject } from "react";

const blocks = "p, h1, h2, h3, h4, h5, h6, li, pre, th, td, blockquote";

function findMatches(content: HTMLElement, query: string) {
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const matches: Range[] = [];
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let block: Element | null = null;
  let segments: { node: Text; start: number }[] = [];
  let text = "";
  function scanBlock() {
    let first = 0;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      while (first + 1 < segments.length && segments[first + 1].start <= start) first++;
      last = Math.max(last, first);
      while (last + 1 < segments.length && segments[last + 1].start < end) last++;
      const range = document.createRange();
      range.setStart(segments[first].node, start - segments[first].start);
      range.setEnd(segments[last].node, end - segments[last].start);
      matches.push(range);
    }
  }
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (!node.length || node.parentElement?.closest("[data-markdown-control]")) continue;
    const parent = node.parentElement?.closest(blocks) ?? content;
    if (parent !== block) {
      scanBlock();
      block = parent;
      segments = [];
      text = "";
    }
    segments.push({ node, start: text.length });
    text += node.data;
  }
  scanBlock();
  return matches;
}

export function useMarkdownSearch(content: HTMLElement | null, viewport: RefObject<HTMLDivElement | null>,
  query: string, active: boolean, source: string, htmlFormatting: boolean) {
  const [matches, setMatches] = useState<Range[]>([]);
  const [index, setIndex] = useState(0);
  useLayoutEffect(() => {
    setMatches(content && query ? findMatches(content, query) : []);
    setIndex(0);
  }, [content, query, source, htmlFormatting]);

  useLayoutEffect(() => {
    const match = matches[index];
    const scroll = viewport.current;
    if (!active || !content || !match || !scroll || !content.contains(match.startContainer)) return;
    let cleanup: () => void;
    if (typeof Highlight === "function" && CSS.highlights) {
      const highlight = new Highlight();
      for (const range of matches) highlight.add(range);
      CSS.highlights.set("markdown-match", highlight);
      CSS.highlights.set("markdown-current", new Highlight(match));
      cleanup = () => {
        CSS.highlights.delete("markdown-match");
        CSS.highlights.delete("markdown-current");
      };
    } else {
      const overlay = document.createElement("div");
      overlay.className = "markdown-match-overlay";
      overlay.setAttribute("aria-hidden", "true");
      content.append(overlay);
      const paint = () => {
        const bounds = content.getBoundingClientRect();
        const rectangles = document.createDocumentFragment();
        for (const range of matches) {
          for (const rect of range.getClientRects()) {
            const box = document.createElement("span");
            if (range === match) box.className = "current";
            Object.assign(box.style, {
              left: `${rect.left - bounds.left}px`, top: `${rect.top - bounds.top}px`,
              width: `${rect.width}px`, height: `${rect.height}px`,
            });
            rectangles.append(box);
          }
        }
        overlay.replaceChildren(rectangles);
      };
      paint();
      const resize = new ResizeObserver(paint);
      resize.observe(content);
      cleanup = () => { resize.disconnect(); overlay.remove(); };
    }
    const bounds = scroll.getBoundingClientRect();
    const result = match.getBoundingClientRect();
    if (result.top < bounds.top || result.bottom > bounds.bottom) {
      scroll.scrollTop += result.top - bounds.top - bounds.height / 2;
    }
    if (result.left < bounds.left || result.right > bounds.right) scroll.scrollLeft += result.left - bounds.left;
    return cleanup;
  }, [active, content, index, matches, viewport]);

  return {
    count: matches.length,
    current: index + 1,
    move: (delta: number) => {
      if (matches.length) setIndex((current) => (current + delta + matches.length) % matches.length);
    },
  };
}
