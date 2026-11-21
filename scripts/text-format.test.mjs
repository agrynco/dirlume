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
