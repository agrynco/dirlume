import { diffChars, diffLines } from "diff";
import { normalized } from "./textFormat";

export interface CompareRequest {
  left: string;
  right: string;
  whitespace: boolean;
}

export type DiffFragment = { text: string; changed: boolean };
export type DiffLine = { number: number; text: string; fragments?: DiffFragment[] };
export type DiffRow = { left: DiffLine | null; right: DiffLine | null };
export type DiffBlock = { group: number | null; rows: DiffRow[] };
export type DiffResult = { blocks: DiffBlock[]; groups: number } | { error: string };

function highlight(left: DiffLine, right: DiffLine, deadline: number) {
  const remaining = deadline - performance.now();
  const parts = remaining > 0 && Math.max(left.text.length, right.text.length) <= 8192
    ? diffChars(left.text, right.text, { timeout: Math.min(12, remaining), maxEditLength: 512 })
    : undefined;
  if (parts) {
    left.fragments = parts.filter((part) => !part.added).map(({ value, removed }) => ({ text: value, changed: !!removed }));
    right.fragments = parts.filter((part) => !part.removed).map(({ value, added }) => ({ text: value, changed: !!added }));
    return;
  }
  // Keep common context visible even when a character diff would exceed the worker budget.
  const old = Array.from(left.text);
  const next = Array.from(right.text);
  const length = Math.min(old.length, next.length);
  let start = 0;
  let end = 0;
  while (start < length && old[start] === next[start]) start++;
  while (end < length - start && old[old.length - end - 1] === next[next.length - end - 1]) end++;
  for (const [line, glyphs] of [[left, old], [right, next]] as const) {
    line.fragments = [
      { text: glyphs.slice(0, start).join(""), changed: false },
      { text: glyphs.slice(start, glyphs.length - end).join(""), changed: true },
      { text: glyphs.slice(glyphs.length - end).join(""), changed: false },
    ].filter(({ text }) => text.length > 0);
  }
}

function compare(left: string, right: string, whitespace: boolean): DiffResult {
  if (Math.max(left.length, right.length) > 2 * 1024 * 1024) return { error: "Choose files under 2 MiB." };
  const oldText = normalized(left);
  const newText = normalized(right);
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  if (oldLines.length > 20_000 || newLines.length > 20_000) return { error: "Choose files shorter than 20,000 lines." };
  const changes = diffLines(oldText, newText, {
    ignoreWhitespace: !whitespace, timeout: 1500, maxEditLength: 10_000,
  });
  if (!changes) return { error: "These files contain too many differences to compare." };
  const deadline = performance.now() + 300;
  const blocks: DiffBlock[] = [];
  let groups = 0;
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  function flush() {
    if (!removed.length && !added.length) return;
    const rows: DiffRow[] = [];
    for (let index = 0; index < Math.max(removed.length, added.length); index++) {
      const left = removed[index] ?? null;
      const right = added[index] ?? null;
      if (left && right) highlight(left, right, deadline);
      rows.push({ left, right });
    }
    blocks.push({ group: ++groups, rows });
    removed = [];
    added = [];
  }
  // Keep original whitespace on both sides of unchanged lines.
  let leftIndex = 0;
  let rightIndex = 0;
  for (const change of changes) {
    const count = change.count ?? 0;
    if (change.added) {
      for (let index = 0; index < count; index++) {
        added.push({ text: newLines[rightIndex] ?? "", number: ++rightIndex });
      }
    } else if (change.removed) {
      for (let index = 0; index < count; index++) {
        removed.push({ text: oldLines[leftIndex] ?? "", number: ++leftIndex });
      }
    } else {
      flush();
      const rows: DiffRow[] = [];
      for (let index = 0; index < count; index++) {
        rows.push({
          left: { text: oldLines[leftIndex] ?? "", number: ++leftIndex },
          right: { text: newLines[rightIndex] ?? "", number: ++rightIndex },
        });
      }
      blocks.push({ group: null, rows });
    }
  }
  flush();
  return { blocks, groups };
}

self.onmessage = ({ data }: MessageEvent<CompareRequest>) => {
  self.postMessage(compare(data.left, data.right, data.whitespace));
};
