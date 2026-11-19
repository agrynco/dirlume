import { diffLines } from "diff";
import { normalized } from "./textFormat";

export interface CompareRequest {
  left: string;
  right: string;
  whitespace: boolean;
}

export type DiffResult =
  | { rows: { kind: string; left: string; right: string; group: number | null }[]; groups: number }
  | { error: string };

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
  const rows: Extract<DiffResult, { rows: unknown }>["rows"] = [];
  let groups = 0;
  let removed: string[] = [];
  let added: string[] = [];
  function flush() {
    if (!removed.length && !added.length) return;
    groups++;
    for (let index = 0; index < Math.max(removed.length, added.length); index++) {
      rows.push({
        kind: index < removed.length && index < added.length ? "changed" : index < removed.length ? "removed" : "added",
        left: removed[index] ?? "", right: added[index] ?? "", group: groups,
      });
    }
    removed = [];
    added = [];
  }
  // Keep original whitespace on both sides of unchanged lines.
  let leftIndex = 0;
  let rightIndex = 0;
  for (const change of changes) {
    const count = change.count ?? 0;
    if (change.added) {
      added.push(...newLines.slice(rightIndex, rightIndex + count));
      rightIndex += count;
    } else if (change.removed) {
      removed.push(...oldLines.slice(leftIndex, leftIndex + count));
      leftIndex += count;
    } else {
      flush();
      for (let index = 0; index < count; index++) {
        rows.push({ kind: "same", group: null, left: oldLines[leftIndex++] ?? "", right: newLines[rightIndex++] ?? "" });
      }
    }
  }
  flush();
  return { rows, groups };
}

self.onmessage = ({ data }: MessageEvent<CompareRequest>) => {
  self.postMessage(compare(data.left, data.right, data.whitespace));
};
