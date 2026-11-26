import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreLineEndings } from "../src/textFormat.ts";

test("both editor save paths preserve mixed endings across edits, insertions and deletions", () => {
  const original = "a\r\nb\rc\nd";
  assert.equal(restoreLineEndings(original, "a\nB\nc\nd"), "a\r\nB\rc\nd");
  assert.equal(restoreLineEndings(original, "a\nx\nb\nc\nd"), "a\r\nx\r\nb\rc\nd");
  assert.equal(restoreLineEndings(original, "a\nc\nd"), "a\r\nc\nd");
  assert.equal(restoreLineEndings("a\r\nb\n", "a\nb"), "a\r\nb");
});

test("a profile fallback applies only when the original contains no line endings", () => {
  assert.equal(restoreLineEndings("a", "a\nb\n", "\r\n"), "a\r\nb\r\n");
  assert.equal(restoreLineEndings("a\nb", "a\nB\n", "\r\n"), "a\nB\n");
  assert.equal(restoreLineEndings("a\r\nb", "a\nB\n", "\n"), "a\r\nB\r\n");
});
