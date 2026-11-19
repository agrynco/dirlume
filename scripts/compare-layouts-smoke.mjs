import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function testCompareLayouts(page, root) {
  const left = join(root, "compare-original");
  const right = join(root, "compare-revised");
  await mkdir(left);
  await mkdir(right);
  const context = Array.from({ length: 55 }, (_, index) => `unchanged context ${index + 1}`).join("\n");
  const longLine = "wrapped original content ".repeat(32);
  const original = ["First", "switch = 100;", longLine, "Keep A", "Remove only", "Keep B", context, "Last"].join("\n");
  const revised = ["First", "switch = 999;", "Keep A", "Keep B", "Insert only", context, "Last"].join("\n");
  await writeFile(join(left, "original.txt"), original);
  await writeFile(join(left, "identical.txt"), original);
  await writeFile(join(right, "revised.txt"), revised);
  for (const [side, path] of [["left", left], ["right", right]]) {
    const address = page.getByLabel(`${side} path`, { exact: true });
    await address.fill(path);
    await address.press("Enter");
  }
  const row = (side, name) => page.locator(`#${side}-files`).getByRole("option").filter({ hasText: name });
  await row("left", "original.txt").click();
  await row("right", "revised.txt").click();

  const dialog = page.getByRole("dialog", { name: "Compare files", exact: true });
  const layout = dialog.getByLabel("Layout", { exact: true });
  const whitespace = dialog.getByLabel("Show whitespace changes", { exact: true });
  const connectors = dialog.getByLabel("Show change connectors", { exact: true });
  const list = dialog.getByLabel("File differences", { exact: true });
  const active = list.locator(".diff-block.current");

  await page.keyboard.press("Shift+F11");
  await list.waitFor();
  await layout.selectOption("side-by-side");
  await connectors.check();
  await whitespace.check();
  await list.locator('[data-change="3"]').waitFor();
  assert.equal(await list.locator(".diff-connector path").count(), 3);
  assert.equal(await list.locator(".diff-connector path.added").getAttribute("data-ends"), "0,100");
  assert.equal(await list.locator(".diff-connector path.removed").getAttribute("data-ends"), "100,0");
  assert.deepEqual(await list.locator('[data-change="1"] mark').allTextContents(), ["100", "999"]);
  await list.press("F8");
  assert.equal(await active.getAttribute("data-change"), "1");

  async function assertAlignment() {
    const block = list.locator('[data-change="1"]');
    await block.evaluate((node) => {
      const first = node.querySelector(".diff-row");
      const left = first.querySelector('[data-diff-side="left"]').getBoundingClientRect();
      const right = first.querySelector('[data-diff-side="right"]').getBoundingClientRect();
      const region = node.getBoundingClientRect();
      const path = node.querySelector("svg path");
      const ribbon = path.ownerSVGElement.getBoundingClientRect();
      const ends = path.dataset.ends.split(",").map(Number);
      const close = (first, second) => Math.abs(first - second) < 1;
      if (!close(left.top, right.top) || !close(left.bottom, right.bottom) || !close(left.right, ribbon.left) ||
          !close(right.left, ribbon.right) || !close(ribbon.height, region.height) ||
          !close(ribbon.top + ribbon.height * ends[1] / 100, right.bottom) || ends[0] !== 100) {
        throw new Error("The change ribbon is misaligned with its corresponding text rows.");
      }
    });
  }
  await assertAlignment();
  const divider = dialog.getByRole("separator", { name: "Comparison divider", exact: true });
  const before = await divider.boundingBox();
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x - 65, before.y + before.height / 2, { steps: 6 });
  await page.mouse.up();
  assert.ok(Number(await divider.getAttribute("aria-valuenow")) < 50);
  await assertAlignment();
  for (const width of ["620px", "1000px"]) {
    await dialog.evaluate((node, width) => {
      node.style.width = width;
      node.style.setProperty("--mono-size", width === "620px" ? "24px" : "16px");
    }, width);
    await list.evaluate((node) => new Promise((resolve) => {
      node.scrollTop = 35;
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    await assertAlignment();
  }
  await connectors.uncheck();
  assert.equal(await list.locator(".diff-connector").count(), 0);
  await connectors.check();

  await layout.selectOption("unified");
  assert.equal(await active.getAttribute("data-change"), "1");
  assert.equal(await whitespace.isChecked(), true);
  const first = list.locator(".diff-unified.same").filter({ hasText: "First" });
  assert.equal(await first.count(), 1);
  assert.deepEqual(await first.locator(".diff-number").allTextContents(), ["1", "1"]);
  assert.deepEqual(await active.locator(".diff-text").allTextContents(), ["switch = 100;", longLine, "switch = 999;"]);
  await list.press("F8");
  assert.equal(await active.getAttribute("data-change"), "2");
  await list.press("F7");
  assert.equal(await active.getAttribute("data-change"), "1");
  await layout.selectOption("side-by-side");
  assert.equal(await active.getAttribute("data-change"), "1");
  if (process.env.DIRLUME_COMPARE_SCREENSHOT) await dialog.screenshot({ path: process.env.DIRLUME_COMPARE_SCREENSHOT });
  await layout.selectOption("unified");
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();

  await row("left", "original.txt").click();
  await row("left", "original.txt").click({ modifiers: ["Control"] });
  await row("left", "identical.txt").click({ modifiers: ["Control"] });
  await page.keyboard.press("Shift+F11");
  await list.waitFor();
  assert.equal(await layout.inputValue(), "unified");
  assert.equal(await list.locator("[data-change]").count(), 0);
  assert.equal(await dialog.getByRole("button", { name: "Next", exact: true }).isEnabled(), false);
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  console.log("Verified both comparison layouts, original line numbers, intraline marks, ribbons, resizing, scrolling, and navigation.");
}
