import { editPaneAddress } from "./pane-address-smoke.mjs";
import assert from "node:assert/strict";
import { mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { openMainMenu } from "./menu-header-smoke.mjs";
import { closeToolWindow, openOptionsWindow } from "./tool-window-smoke.mjs";

export async function testFolderShortcuts({ page, startDesktop, exitDesktop, src, dst }) {
  const dialog = () => page.getByRole("dialog", { name: "Folder shortcuts", exact: true });
  const list = (side) => page.getByRole("listbox", { name: `${side} files`, exact: true });
  const picker = (group) => dialog().getByRole("listbox", { name: `Folder shortcuts in group ${group}`, exact: true });
  const title = () => dialog().getByRole("textbox", { name: "Title (optional)", exact: true });
  const path = () => dialog().getByLabel("Path", { exact: true });
  const confirm = () => dialog().getByRole("button", { name: "Save", exact: true }).click();
  const size = (locator) => locator.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  const opened = (side, target) => page.getByRole("region", { name: `${side} pane`, exact: true })
    .getByRole("heading", { name: basename(target), exact: true }).waitFor({ state: "attached" });

  async function navigate(side, target) {
    const address = await editPaneAddress(page, side);
    await address.fill(target);
    await address.press("Enter");
    await opened(side, target);
  }

  async function openGroups() {
    const menu = await openMainMenu(page, "Commands");
    await menu.getByRole("menuitem", { name: "Folder shortcuts", exact: true }).click();
  }

  async function openGroup(side, digit) {
    await list(side).focus();
    await page.keyboard.down("ControlRight");
    await page.keyboard.press(`Digit${digit}`);
    await page.keyboard.up("ControlRight");
  }

  async function wheel(group, modifier) {
    await picker(group).hover();
    await page.keyboard.down(modifier);
    try {
      await page.mouse.wheel(0, -120);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    } finally {
      await page.keyboard.up(modifier);
    }
  }

  async function setZoomBinding(binding) {
    const tool = await openOptionsWindow(page);
    const options = tool.getByRole("dialog", { name: "Options", exact: true });
    await options.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
    await options.getByLabel("Change shortcut for Font zoom with mouse wheel", { exact: true }).selectOption(binding);
    await closeToolWindow(tool, () => options.getByRole("button", { name: "Done", exact: true }).click());
  }

  const edited = join(dst, "bookmark-edited");
  await mkdir(edited);
  await navigate("left", src);
  await navigate("right", dst);
  await openGroup("left", 0);
  await page.getByText("No folder shortcuts in group 0.", { exact: true }).waitFor();
  await openGroups();
  await dialog().getByText("No folder shortcuts saved.", { exact: true }).waitFor();
  await page.keyboard.press("Escape");

  await list("left").getByRole("option", { name: /^notes.txt/ }).click();
  await list("left").press("Control+Shift+F8");
  assert.equal(await path().inputValue(), src);
  await path().fill("relative-path");
  await confirm();
  await dialog().getByText("Enter an absolute folder path on the original computer.", { exact: true }).waitFor();
  await dialog().getByRole("button", { name: "Cancel", exact: true }).click();
  await openGroup("left", 8);
  await page.getByText("No folder shortcuts in group 8.", { exact: true }).waitFor();

  await list("left").press("Control+Shift+F8");
  await title().fill("Source folder");
  await confirm();
  await page.getByText("Folder shortcut saved in group 8.", { exact: true }).waitFor();

  await list("right").focus();
  await page.locator("#right-pane.active").waitFor();
  await openGroup("right", 8);
  await opened("right", src);
  await list("right").locator('[data-current="true"][data-tooltip=".."]').waitFor();
  assert.equal(await dialog().count(), 0);
  assert.equal(await page.locator("#left-path").getAttribute("data-path"), src);
  await navigate("right", dst);

  await list("left").focus();
  for (const key of ["*", "8"]) {
    await list("left").dispatchEvent("keydown", { key, code: "Digit8", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    await dialog().getByText("Group 8", { exact: true }).waitFor();
    await path().fill(src.toUpperCase() + "\\.");
    await confirm();
    await dialog().getByText("This folder is already assigned to this group.", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await dialog().waitFor({ state: "hidden" });
  }

  await list("right").focus();
  await openGroups();
  await dialog().getByRole("button", { name: /^Group 8/ }).click();
  await picker(8).getByRole("option", { name: /^Source folder/ }).waitFor();
  await picker(8).press("Insert");
  assert.equal(await path().inputValue(), dst);
  await title().fill("Destination folder");
  await confirm();
  await picker(8).getByRole("option", { name: /^Destination folder/, selected: true }).waitFor();
  await picker(8).press("F4");
  await title().fill("Edited folder");
  await path().fill(edited);
  await confirm();
  await picker(8).getByRole("option", { name: /^Edited folder/, selected: true }).waitFor();
  await picker(8).press("Control+ArrowUp");
  assert.match(await picker(8).getByRole("option").first().innerText(), /^Edited folder/);
  await picker(8).press("Control+ArrowDown");
  assert.match(await picker(8).getByRole("option").first().innerText(), /^Source folder/);
  await picker(8).press("Control+ArrowUp");
  const dialogFont = await size(dialog());
  const paneFont = await size(page.locator("#right-pane"));
  const selection = await picker(8).getAttribute("aria-activedescendant");
  await wheel(8, "Control");
  assert.equal(await size(dialog()), dialogFont + 1);
  assert.equal(await size(page.locator("#right-pane")), paneFont);
  assert.equal(await picker(8).getAttribute("aria-activedescendant"), selection);
  assert.equal(await picker(8).evaluate((node) => node === document.activeElement), true);
  await page.mouse.click(5, 5);
  await dialog().waitFor({ state: "hidden" });
  assert.equal(await list("right").evaluate((element) => element === document.activeElement), true);

  await list("left").press("Control+Shift+Digit0");
  await dialog().getByText("Group 0", { exact: true }).waitFor();
  await confirm();
  await openGroups();
  assert.deepEqual(await dialog().locator(".command-menu button span:first-child").allTextContents(), ["Group 0", "Group 8"]);
  await dialog().getByRole("button", { name: /^Group 0/ }).click();
  await picker(0).getByRole("option").dblclick();
  await dialog().waitFor({ state: "hidden" });

  await exitDesktop(page);
  page = await startDesktop();
  await openGroup("right", 8);
  assert.equal(await size(dialog()), dialogFont + 1);
  assert.match(await picker(8).getByRole("option").first().innerText(), /^Edited folder/);
  assert.match(await picker(8).getByRole("option").last().innerText(), /^Source folder/);
  if (process.env.DIRLUME_BOOKMARKS_SCREENSHOT) {
    await page.screenshot({ path: process.env.DIRLUME_BOOKMARKS_SCREENSHOT, scale: "css" });
  }
  await page.evaluate(() => {
    const save = Storage.prototype.setItem;
    window.restoreBookmarkStorage = () => { Storage.prototype.setItem = save; };
    Storage.prototype.setItem = function (key, value) {
      if (key === "dirlume.folder-shortcuts.v1") throw new DOMException("Test storage is full", "QuotaExceededError");
      save.call(this, key, value);
    };
  });
  try {
    await picker(8).press("Delete");
    await dialog().getByText("Could not save folder shortcuts.", { exact: true }).waitFor();
    assert.equal(await picker(8).getByRole("option").count(), 2);
  } finally {
    await page.evaluate(() => { window.restoreBookmarkStorage(); delete window.restoreBookmarkStorage; });
  }
  await picker(8).press("Enter");
  await opened("right", edited);
  assert.equal(await page.locator("#left-path").getAttribute("data-path"), src);
  await setZoomBinding("Alt+Wheel");
  await openGroup("right", 8);
  await wheel(8, "Control");
  assert.equal(await size(dialog()), dialogFont + 1);
  await wheel(8, "Alt");
  assert.equal(await size(dialog()), dialogFont + 2);
  await picker(8).press("Escape");
  await setZoomBinding("");
  await openGroup("right", 8);
  await wheel(8, "Alt");
  assert.equal(await size(dialog()), dialogFont + 2);
  await picker(8).press("Escape");
  const tool = await openOptionsWindow(page);
  const options = tool.getByRole("dialog", { name: "Options", exact: true });
  await options.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  await options.getByLabel("Change shortcut for Font zoom with mouse wheel", { exact: true }).selectOption("Ctrl+Wheel");
  await options.getByRole("button", { name: "View font sizes", exact: true }).click();
  const dialogSize = options.getByRole("spinbutton", { name: "File pane dialogs font size", exact: true });
  assert.equal(await dialogSize.inputValue(), String(dialogFont + 2));
  await dialogSize.fill("");
  await closeToolWindow(tool, () => options.getByRole("button", { name: "Done", exact: true }).click());
  await openGroup("right", 8);
  assert.equal(await size(dialog()), dialogFont);
  await picker(8).press("Delete");
  assert.equal(await picker(8).getByRole("option").count(), 1);
  assert.equal((await stat(edited)).isDirectory(), true);
  await picker(8).press("Delete");
  await dialog().waitFor({ state: "hidden" });
  await openGroup("right", 8);
  await page.getByText("No folder shortcuts in group 8.", { exact: true }).waitFor();
  assert.equal((await stat(src)).isDirectory(), true);
  console.log("Verified numbered folder shortcuts, both panes, duplicate checks, picker actions, and restart persistence.");
  return page;
}
