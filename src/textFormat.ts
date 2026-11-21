import { diffArrays } from "diff";

export function normalized(text: string) {
  return text.replaceAll(/\r\n?/g, "\n");
}

export function restoreLineEndings(original: string, edited: string) {
  const endings = original.match(/\r\n|\r|\n/g) ?? [];
  const fallback = endings[0] ?? "\n";
  if (endings.every((ending) => ending === fallback)) return edited.replaceAll("\n", fallback);
  const lines = edited.split("\n");
  const sourceLines = normalized(original).split("\n");
  const changes = diffArrays(sourceLines, lines, { maxEditLength: 1024 });
  const restored: string[] = [];
  if (changes) {
    let source = 0;
    let removed: string[] = [];
    for (const change of changes) {
      if (change.removed) {
        removed = endings.slice(source, source + change.count);
        source += change.count;
      } else {
        for (let index = 0; index < change.count; index++) {
          restored.push(change.added ? removed[index] ?? endings[source - 1] ?? fallback : endings[source++] ?? fallback);
        }
        removed = [];
      }
    }
  } else {
    // For extensively rewritten files, align surviving lines in order with bounded memory.
    const occurrences = new Map<string, number[]>();
    for (let i = sourceLines.length - 1; i >= 0; i--) {
      const indices = occurrences.get(sourceLines[i]);
      if (indices) indices.push(i); else occurrences.set(sourceLines[i], [i]);
    }
    let last = -1;
    for (const line of lines) {
      const indices = occurrences.get(line);
      while (indices?.length && indices[indices.length - 1] <= last) indices.pop();
      const match = indices?.pop();
      if (match !== undefined) last = match;
      restored.push(endings[last] ?? fallback);
    }
  }
  return lines.map((line, i) => i + 1 === lines.length ? line : line + (restored[i] ?? endings[i] ?? fallback)).join("");
}
