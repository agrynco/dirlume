import assert from "node:assert/strict";
import test from "node:test";
import { projectStatus, taskIssues } from "./sync-project-status.mjs";

const issue = { number: 193, state: "OPEN", labels: ["ready for dev"] };
const branch = "codex/issue-193-environment-variables";
const pr = { head: { ref: branch }, body: "Refs #193" };
const merged = { ...pr, state: "closed", merged_at: "2026-11-21", merge_commit_sha: "staged" };
const state = (updates = {}) => projectStatus({ issue, pulls: [], refs: [], promoted: new Set(), ...updates });

test("moves work through the project based on its issue, branch, and pull request", () => {
  assert.equal(state({ issue: { ...issue, labels: [] } }), "Backlog");
  assert.equal(state({ issue: { ...issue, labels: ["ready for dev", "needs refinement"] } }), "Backlog");
  assert.equal(state(), "Ready");
  assert.equal(state({ refs: [branch] }), "In progress");
  assert.equal(state({ refs: ["codex/issue-1930-unrelated"] }), "Ready");
  assert.equal(state({ pulls: [{ ...pr, state: "open", draft: true }] }), "In progress");
  assert.equal(state({ pulls: [{ ...pr, state: "open", draft: false }] }), "In review");
  assert.equal(state({ pulls: [merged], refs: [branch] }), "prerelease");
  assert.equal(state({ issue: { ...issue, state: "CLOSED" }, pulls: [merged] }), "Done");
});

test("does not treat leftover branches from promoted or closed work as active", () => {
  assert.equal(state({ pulls: [merged], refs: [branch], promoted: new Set(["staged"]) }), "Ready");
  assert.equal(state({ pulls: [{ ...pr, state: "closed" }], refs: [branch] }), "Ready");
  assert.equal(state({ pulls: [merged], refs: [branch + "-followup"] }), "In progress");
});

test("keeps blocked work in Backlog while branches and pull requests remain open", () => {
  const blocked = { ...issue, labels: [...issue.labels, "blocked"] };
  assert.equal(state({ issue: blocked, refs: [branch] }), "Backlog");
  assert.equal(state({ issue: blocked, pulls: [{ ...pr, state: "open", draft: true }] }), "Backlog");
  assert.equal(state({ issue: blocked, pulls: [{ ...pr, state: "open", draft: false }] }), "Backlog");
  assert.equal(state({ issue: blocked, pulls: [merged] }), "Backlog");
  assert.equal(state({ issue: { ...blocked, state: "CLOSED" } }), "Done");
});

test("uses task branching and explicit issue references", () => {
  assert.deepEqual([...taskIssues({ ...pr, body: "Refs #194\n\nSee also #10.\nRefs #193" })], [193, 194]);
  assert.deepEqual([...taskIssues({ head: { ref: "other" }, body: "Closes #193" })], []);
});
