import assert from "node:assert/strict";
import test from "node:test";
import { replaceTerminalSnippet } from "../src/terminalDraft.ts";

const ticket = "current-prompt";
const draft = { text: "echo ;l tail", caret: 7 };
const request = (prefix, text, cursor = text.length, token = ticket) =>
  JSON.stringify([token, prefix, text, cursor]);

test("a snippet replaces the prefix at the caret and preserves the rest of the shell draft", () => {
  assert.deepEqual(replaceTerminalSnippet(draft, ticket, request(";l", "two words", 3), false, true), {
    data: "\x7f\x7f\x1b[200~two words\x1b[201~" + "\x1b[D".repeat(6),
    draft: { text: "echo two words tail", caret: 8 },
  });
});

test("a snippet request cannot edit a stale or unrelated draft or send terminal controls", () => {
  for (const invalid of [
    request(";l", "text", 4, "previous-prompt"),
    request(";x", "text"),
    request(";l", "text\r"),
    request(";l", "\x1b[201~"),
    request(";l", "text", 5),
  ]) assert.equal(replaceTerminalSnippet(draft, ticket, invalid, false, false), null);
  assert.equal(replaceTerminalSnippet({ text: "word;l", caret: 6 }, ticket, request(";l", "text"), false, false), null);
});
