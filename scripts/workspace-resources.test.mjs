import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceResources } from "../src/workspaceResources.ts";

test("remote documents and comparison windows independently retain a departed connection", () => {
  const file = { name: "note", place: { kind: "ssh", id: 3 } };
  const pane = { place: null, history: [] };
  const owners = { panes: { left: pane, right: pane }, connections: { left: null, right: null }, documents: [{ file }], comparisons: [{ left: file, right: file }] };
  assert.deepEqual([...workspaceResources(owners).keys()], ["ssh:3"]);
  assert.ok(workspaceResources({ ...owners, documents: [] }).has("ssh:3"));
  assert.ok(workspaceResources({ ...owners, comparisons: [] }).has("ssh:3"));
  assert.equal(workspaceResources({ ...owners, comparisons: [], documents: [] }).size, 0);
});
