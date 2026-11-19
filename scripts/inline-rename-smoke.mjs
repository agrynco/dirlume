import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function testInlineRename(page, root) {
  const left = join(root, "rename-left");
  const right = join(root, "rename-right");
  await mkdir(join(left, "SQL2025"), { recursive: true });
  await mkdir(right);
  await writeFile(join(right, "note.txt"), "Preserved contents.");
  await writeFile(join(right, "existing.txt"), "Existing contents.");
  for (const [side, path] of [["left", left], ["right", right]]) {
    const address = page.getByLabel(`${side} path`, { exact: true });
    await address.fill(path);
    await address.press("Enter");
    await page.getByRole("heading", { name: `rename-${side}`, exact: true }).waitFor({ state: "attached" });
  }
  const pane = (side) => page.locator(`#${side}-files`);
  const row = (side, name) => pane(side).getByRole("option").and(page.locator("[data-tooltip=" + JSON.stringify(name) + "]"));

  async function edit(side, name) {
    const item = row(side, name);
    await item.click();
    await page.keyboard.press("F2");
    const field = item.getByRole("textbox", { name: "New name for " + name, exact: true });
    await field.waitFor();
    assert.equal(await field.inputValue(), name);
    assert.equal(await field.evaluate((element) => element === document.activeElement), true);
    return field;
  }

  let field = await edit("left", "SQL2025");
  await field.fill("SQL2026");
  await field.press("Escape");
  await field.waitFor({ state: "hidden" });
  assert.ok((await stat(join(left, "SQL2025"))).isDirectory());
  await page.waitForFunction(() => document.activeElement?.id === "left-files");
  field = await edit("left", "SQL2025");
  await field.fill("SQL2026");
  await field.press("Enter");
  await row("left", "SQL2026").and(pane("left").locator("[data-current='true']")).waitFor();
  assert.ok((await stat(join(left, "SQL2026"))).isDirectory());

  field = await edit("right", "note.txt");
  await field.fill("existing.txt");
  await field.press("Enter");
  await row("right", "note.txt").getByRole("alert").waitFor();
  assert.equal(await field.inputValue(), "existing.txt");
  assert.equal(await readFile(join(right, "existing.txt"), "utf8"), "Existing contents.");
  await field.fill("renamed.txt");
  await field.press("Enter");
  await row("right", "renamed.txt").and(pane("right").locator("[data-current='true']")).waitFor();
  assert.equal(await readFile(join(right, "renamed.txt"), "utf8"), "Preserved contents.");
  assert.equal(await row("right", "note.txt").count(), 0);
  console.log("Verified F2 inline rename in both panes, Escape cancellation, and editable name after a conflict.");
}
