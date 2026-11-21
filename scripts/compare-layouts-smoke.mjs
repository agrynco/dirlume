import { editPaneAddress } from "./pane-address-smoke.mjs";
import { closeToolWindow, openOptionsWindow, openToolWindow } from "./tool-window-smoke.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openMainMenu } from "./menu-header-smoke.mjs";

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
    const address = await editPaneAddress(page, side);
    await address.fill(path);
    await address.press("Enter");
  }
  const row = (side, name) => page.locator(`#${side}-files`).locator(`[role="option"][data-tooltip=${JSON.stringify(name)}]`);
  await row("left", "original.txt").click();
  await row("right", "revised.txt").click();

  async function checkAction(trigger) {
    const comparison = await openToolWindow(page, trigger, "Compare files");
    const differences = comparison.getByLabel("File differences", { exact: true });
    await differences.getByText("switch = 100;", { exact: true }).waitFor();
    await differences.getByText("switch = 999;", { exact: true }).waitFor();
    await closeToolWindow(comparison);
  }
  const actions = page.getByRole("navigation", { name: "File actions", exact: true });
  await checkAction(() => actions.getByRole("button", { name: "Compare", exact: true }).click());
  for (const [group, label] of [["Files", "Compare"], ["Commands", "Compare files"]]) {
    const menu = await openMainMenu(page, group);
    const entry = menu.getByRole("menuitem", { name: label, exact: true });
    assert.match(await entry.getAttribute("data-tooltip"), /Shift\+F11/);
    await checkAction(() => entry.click());
  }
  await row("right", "revised.txt").focus();
  const compare = () => openToolWindow(page, () => page.keyboard.press("Shift+F11"), "Compare files");
  let window = await compare();
  const currentDialog = () => window.getByRole("dialog", { name: "Compare files", exact: true });
  let dialog = currentDialog();
  const layout = () => currentDialog().getByLabel("Layout", { exact: true });
  const whitespace = dialog.getByLabel("Show whitespace changes", { exact: true });
  const connectors = dialog.getByLabel("Show change connectors", { exact: true });
  const differences = () => currentDialog().getByLabel("File differences", { exact: true });
  let list = differences();
  const active = list.locator(".diff-block.current");

  await list.waitFor();
  await layout().press("F1");
  const help = window.getByRole("dialog", { name: "Help", exact: true });
  await help.locator('.help-contents [aria-current="location"][href="#help-compare"]').waitFor();
  await window.keyboard.press("Escape");
  await help.waitFor({ state: "hidden" });
  assert.equal(await layout().evaluate((element) => element === document.activeElement), true);
  const options = await openOptionsWindow(page);
  const settings = options.getByRole("dialog", { name: "Options", exact: true });
  await settings.getByRole("button", { name: "Pick an element", exact: true }).click();
  await window.locator(".appearance-picker").waitFor();
  await list.getByText("switch = 100;", { exact: true }).click();
  await settings.getByRole("heading", { name: "Compare files", exact: true }).waitFor();
  await settings.getByLabel("Compare files text hex", { exact: true }).waitFor();
  await closeToolWindow(options);
  await layout().selectOption("side-by-side");
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
  await window.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await window.mouse.down();
  await window.mouse.move(before.x - 65, before.y + before.height / 2, { steps: 6 });
  await window.mouse.up();
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

  await layout().selectOption("unified");
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
  const collapse = dialog.getByRole("checkbox", { name: "Collapse unchanged sections" });
  await collapse.check();
  const folded = dialog.getByRole("button", { name: /^Show \d+ unchanged lines/ });
  await folded.first().click();
  await collapse.uncheck();
  await layout().selectOption("side-by-side");
  assert.equal(await active.getAttribute("data-change"), "1");
  if (process.env.DIRLUME_COMPARE_SCREENSHOT) await dialog.screenshot({ path: process.env.DIRLUME_COMPARE_SCREENSHOT });
  await layout().selectOption("unified");
  await closeToolWindow(window);

  await row("left", "original.txt").click();
  await row("left", "original.txt").click({ modifiers: ["Control"] });
  await row("left", "identical.txt").click({ modifiers: ["Control"] });
  window = await compare();
  dialog = currentDialog();
  list = differences();
  await list.waitFor();
  assert.equal(await layout().inputValue(), "unified");
  assert.equal(await list.locator("[data-change]").count(), 0);
  assert.equal(await dialog.getByRole("button", { name: "Next", exact: true }).isEnabled(), false);
  await closeToolWindow(window);
  console.log("Verified both comparison layouts, original line numbers, intraline marks, ribbons, resizing, scrolling, and navigation.");

  await row("left", "original.txt").click();
  await row("right", "revised.txt").click();
  window = await compare();
  dialog = currentDialog();
  await dialog.getByRole("button", { name: "Apply to right", exact: true }).click();
  await dialog.getByRole("checkbox", { name: "Edit files", exact: true }).check();
  for (const [side, text] of [["Left", "left edit"], ["Right", "right edit"]]) {
    await dialog.getByRole("region", { name: `${side} file` }).locator(".cm-content").press("Control+End");
    await window.keyboard.insertText("\n" + text);
  }
  await window.keyboard.press("Escape");
  const save = window.getByRole("dialog", { name: "Unsaved changes", exact: true });
  const rightSave = save.getByRole("group", { name: /^Right file/ });
  await rightSave.getByRole("combobox", { name: "Save changes" }).selectOption("copy");
  const copy = join(root, "comparison-copy.txt");
  await rightSave.getByRole("combobox", { name: "Save as" }).fill(copy);
  await closeToolWindow(window, () => save.getByRole("button", { name: "Save and close" }).click());
  assert.equal(await readFile(join(left, "original.txt"), "utf8"), original + "\nleft edit");
  assert.equal(await readFile(join(right, "revised.txt"), "utf8"), revised);
  assert.equal(await readFile(copy, "utf8"), revised.replace("switch = 999;", "switch = 100;\n" + longLine) + "\nright edit");
  console.log("Verified applying a comparison change, editing both sides, overwriting one original, and saving the other side to a new file.");
}
