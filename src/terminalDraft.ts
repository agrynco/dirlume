export type TerminalDraft = { text: string; caret: number };

const controls = /\p{Cc}/u;

export function trackTerminalDraft(draft: TerminalDraft, input: string): TerminalDraft | null {
  const { text, caret } = draft;
  const before = text.slice(0, caret);
  const after = text.slice(caret);
  const previous = Array.from(before).at(-1)?.length ?? 0;
  const next = Array.from(after)[0]?.length ?? 0;
  switch (input) {
    case "\x7f":
    case "\b": return { text: before.slice(0, caret - previous) + after, caret: caret - previous };
    case "\x1b[3~": return { text: before + after.slice(next), caret };
    case "\x1b[D":
    case "\x1bOD": return { text, caret: caret - previous };
    case "\x1b[C":
    case "\x1bOC": return { text, caret: caret + next };
    case "\x1b[H":
    case "\x1bOH": return { text, caret: 0 };
    case "\x1b[F":
    case "\x1bOF": return { text, caret: text.length };
    default: {
      const insert = input.startsWith("\x1b[200~") && input.endsWith("\x1b[201~") ? input.slice(6, -6) : input;
      if (controls.test(insert) || text.length + insert.length > 8192) return null;
      return { text: before + insert + after, caret: caret + insert.length };
    }
  }
}

export function replaceTerminalRange(draft: TerminalDraft, index: number, length: number, text: string, applicationCursor: boolean, bracketed: boolean) {
  const end = index + length;
  if (!text || controls.test(text) || index < 0 || length < 0 || end > draft.text.length ||
      draft.text.length - length + text.length > 8192) return null;
  const distance = Array.from(draft.text.slice(Math.min(draft.caret, end), Math.max(draft.caret, end))).length;
  const move = end < draft.caret ? "D" : "C";
  const erase = "\x7f".repeat(Array.from(draft.text.slice(index, end)).length);
  return {
    data: ((applicationCursor ? "\x1bO" : "\x1b[") + move).repeat(distance) + erase +
      (bracketed ? "\x1b[200~" + text + "\x1b[201~" : text),
    draft: { text: draft.text.slice(0, index) + text + draft.text.slice(end), caret: index + text.length },
  };
}
