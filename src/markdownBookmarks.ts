import type { MarkdownAnchor } from "./fileBookmarks";

const contextLength = 64;
const blocks = "p,h1,h2,h3,h4,h5,h6,li,pre,th,td,blockquote";
const excluded = "button,[hidden],[aria-hidden=true],[data-markdown-control],[role=alert],[role=status]";
type Run = { node: Text; from: number; to: number; start: number; end: number };

function indexText(content: HTMLElement) {
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  const runs: Run[] = [];
  const parts: string[] = [];
  let length = 0;
  let block: Element | null = null;
  let spaced = true;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const parent = node.parentElement;
    if (!parent || parent.closest(excluded)) continue;
    const nextBlock = parent.closest(blocks) ?? content;
    if (block && block !== nextBlock && !spaced) { parts.push(" "); length++; spaced = true; }
    block = nextBlock;
    for (const match of node.data.matchAll(/\s+|\S+/g)) {
      const from = match.index;
      const value = match[0];
      const space = /^\s/.test(value);
      if (space && spaced) continue;
      const part = space ? " " : value;
      runs.push({ node, from, to: from + value.length, start: length, end: length + part.length });
      parts.push(part);
      length += part.length;
      spaced = space;
    }
  }
  return { text: parts.join(""), runs };
}

export function markdownSelection(content: HTMLElement | null) {
  const selection = window.getSelection();
  if (!content || !selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  return content.contains(range.startContainer) && content.contains(range.endContainer) && range.toString().trim() ? range : null;
}

export function captureMarkdownAnchor(content: HTMLElement, range: Range): MarkdownAnchor | null {
  if (!content.contains(range.startContainer) || !content.contains(range.endContainer)) return null;
  const { text, runs } = indexText(content);
  let start = -1;
  let end = 0;
  for (const run of runs) {
    if (!range.intersectsNode(run.node)) continue;
    const from = Math.max(run.from, range.startContainer === run.node ? range.startOffset : 0);
    const to = Math.min(run.to, range.endContainer === run.node ? range.endOffset : run.to);
    if (to <= from) continue;
    if (start < 0) start = run.start + Math.min(run.end - run.start - 1, from - run.from);
    end = run.start + Math.min(run.end - run.start, to - run.from);
  }
  if (start < 0) return null;
  const raw = text.slice(start, end);
  const quote = raw.trim();
  if (!quote) return null;
  start += raw.length - raw.trimStart().length;
  end = start + quote.length;
  return { quote, before: text.slice(Math.max(0, start - contextLength), start),
    after: text.slice(end, end + contextLength), offset: start };
}

function contextScore(text: string, start: number, anchor: MarkdownAnchor) {
  const end = start + anchor.quote.length;
  let left = 0;
  let right = 0;
  while (left < anchor.before.length && start > left && anchor.before.at(-1 - left) === text[start - 1 - left]) left++;
  while (right < anchor.after.length && anchor.after[right] === text[end + right]) right++;
  return left + right;
}

export function locateMarkdownAnchor(content: HTMLElement, anchor: MarkdownAnchor): Range | null {
  const { text, runs } = indexText(content);
  let best = -1;
  let score = -1;
  let tied = false;
  for (let start = text.indexOf(anchor.quote); start >= 0; start = text.indexOf(anchor.quote, start + 1)) {
    const current = contextScore(text, start, anchor);
    if (current > score) { best = start; score = current; tied = false; }
    else if (current === score) tied = true;
  }
  if (best < 0 || tied) return null;
  const end = best + anchor.quote.length;
  const first = runs.find((run) => run.start <= best && run.end > best);
  const last = runs.find((run) => run.start < end && run.end >= end);
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, first.from + best - first.start);
  range.setEnd(last.node, end === last.end ? last.to : last.from + end - last.start);
  return range;
}
