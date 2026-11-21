import assert from "node:assert/strict";
import { link, mkdir, rename, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { editPaneAddress } from "./pane-address-smoke.mjs";
import { closeToolWindow, openOptionsWindow } from "./tool-window-smoke.mjs";
import { openMainMenu } from "./menu-header-smoke.mjs";

const modes = [
  "name", "baseName", "extension", "modified", "size", "unsorted", "created", "accessed", "changed",
  "description", "owner", "allocated", "hardLinks", "streamCount", "streamSize",
];

export async function testFileSort({ page, root, startDesktop, exitDesktop }) {
  const folder = join(root, "file-sort");
  await mkdir(folder);
  await mkdir(join(folder, "z-directory"));
  await writeFile(join(folder, "zeta.txt"), "z");
  await writeFile(join(folder, "alpha-2.md"), "apple");
  await writeFile(join(folder, "alpha-10.txt"), "alpha");
  await writeFile(join(folder, "alpha-2.zz"), "");
  await writeFile(join(folder, "a spaced.txt"), "a".repeat(32));
  await writeFile(join(folder, "descript.ion"), '"a spaced.txt" Zebra\nalpha-2.md Apple\nalpha-2.zz Banana\n');
  await link(join(folder, "alpha-2.md"), join(folder, "hard.md"));
  const previous = new Date("2001-01-01T00:00:00Z");
  await utimes(join(folder, "zeta.txt"), previous, previous);
  await rename(join(folder, "zeta.txt"), join(folder, "zeta-new.txt"));
  const left = () => page.locator("#left-files");
  const active = () => page.getByRole("dialog", { name: "Sort by", exact: true });
  const name = (id) => active().locator(`[data-sort-mode="${id}"]`);
  const names = () => left().locator(".file-row").evaluateAll((rows) => rows.map((row) => row.dataset.tooltip));
  const select = (id) => name(id).click();
  const address = await editPaneAddress(page, "left");
  await address.fill(folder);
  await address.press("Enter");
  const row = (label) => left().locator(`[data-tooltip="${label}"]`);
  await row("alpha-2.md").waitFor();
  async function openSort(side = "Left") {
    const menu = await openMainMenu(page, side);
    await menu.getByRole("menuitem", { name: "Sort modes", exact: true }).click();
    await active().waitFor();
  }
  async function closeSort() {
    await page.keyboard.press("Escape");
    await active().waitFor({ state: "hidden" });
  }
  async function expectStart(expected) {
    await page.waitForFunction((expected) => {
      const displayed = [...document.querySelectorAll("#left-files .file-row")].map((row) => row.dataset.tooltip);
      return expected.every((name, index) => displayed[index] === name);
    }, expected);
  }
  const currentSort = () => active().locator("[data-sort-mode][aria-checked=true]").getAttribute("aria-label");
  await openSort("Right");
  const originalRightSort = await currentSort();
  await closeSort();
  await left().focus();
  await left().press("Control+F12");
  await active().waitFor();
  assert.deepEqual(await active().locator("[data-sort-mode]").evaluateAll((rows) => rows.map((row) => row.dataset.sortMode)), modes);
  assert.equal(await active().getByRole("checkbox", { name: "Show directories first", exact: true }).getAttribute("aria-checked"), "true");
  for (const id of ["extension", "size", "modified", "unsorted"]) assert.equal(await name(id).getAttribute("aria-disabled"), null);
  await select("extension");
  await expectStart(["..", "z-directory", "descript.ion", "alpha-2.md", "hard.md"]);
  await left().press("Control+F4");
  await expectStart(["..", "z-directory", "alpha-2.zz"]);
  await openSort();
  await name("extension").press("+");
  await expectStart(["..", "z-directory", "descript.ion", "alpha-2.md", "hard.md"]);
  await name("extension").press("*");
  await expectStart(["..", "z-directory", "alpha-2.zz"]);
  await closeSort();
  await left().evaluate((pane) => { if (document.activeElement !== pane) throw new Error("File pane did not regain focus"); });

  await openSort();
  await select("baseName");
  const byBaseName = await names();
  assert.ok(byBaseName.indexOf("alpha-2.md") < byBaseName.indexOf("alpha-2.zz"));
  await openSort();
  await name("baseName").press("F4");
  const tie = page.getByRole("dialog", { name: "Tie-breakers for Name only" });
  await tie.getByRole("combobox", { name: "Direction for criterion 1" }).selectOption("desc");
  await tie.getByRole("button", { name: "Apply", exact: true }).click();
  await active().waitFor();
  await closeSort();
  const reverseTie = await names();
  assert.ok(reverseTie.indexOf("alpha-2.zz") < reverseTie.indexOf("alpha-2.md"));
  await openSort();
  await name("baseName").press("F4");
  await tie.getByRole("button", { name: "Reset", exact: true }).click();
  await tie.getByRole("button", { name: "Apply", exact: true }).click();
  await closeSort();

  await openSort();
  await select("description");
  await expectStart(["..", "z-directory", "alpha-2.md", "alpha-2.zz", "a spaced.txt"]);
  await openSort();
  await select("hardLinks");
  await expectStart(["..", "z-directory", "alpha-2.md", "hard.md"]);
  await openSort();
  await select("size");
  await expectStart(["..", "z-directory", "descript.ion", "a spaced.txt"]);

  if (process.platform === "win32") {
    await openSort();
    await page.waitForFunction(() => document.querySelector('[data-sort-mode="streamCount"]')?.getAttribute("aria-disabled") !== "true");
    await writeFile(join(folder, "alpha-2.zz") + ":dirlume-fixture", "x".repeat(150));
    await select("streamCount");
    await expectStart(["..", "z-directory", "alpha-2.zz"]);
    await openSort();
    await select("streamSize");
    await expectStart(["..", "z-directory", "alpha-2.zz"]);
    await openSort();
    await select("changed");
    await expectStart(["..", "z-directory", "alpha-2.zz"]);
    await openSort();
    await select("modified");
    await page.waitForFunction(() => [...document.querySelectorAll("#left-files .file-row")].at(-1)?.dataset.tooltip === "zeta-new.txt");
  }

  const optionsPage = await openOptionsWindow(page);
  const options = optionsPage.getByRole("dialog", { name: "Options", exact: true });
  await options.getByRole("searchbox", { name: "Search settings" }).fill("sort groups");
  await options.getByRole("button", { name: "Sort groups", exact: true }).click();
  await options.getByRole("button", { name: "Add sort group", exact: true }).click();
  await options.getByRole("textbox", { name: "Filename mask 1" }).fill("*.zz");
  await options.getByRole("button", { name: "Add sort group", exact: true }).click();
  await options.getByRole("textbox", { name: "Filename mask 2" }).fill("*.md");
  await options.getByRole("combobox", { name: "Position for group 2" }).selectOption("after");
  await closeToolWindow(optionsPage, () => options.getByRole("button", { name: "Done", exact: true }).click());
  await openSort();
  await active().getByRole("checkbox", { name: "Use sort groups", exact: true }).click();
  await active().getByRole("checkbox", { name: "Show directories first", exact: true }).click();
  await select("name");
  await expectStart(["..", "alpha-2.zz"]);
  await left().press("Control+F3");
  await expectStart(["..", "alpha-2.zz"]);
  await row("a spaced.txt").click({ modifiers: ["Control"] });
  await left().press("Shift+F12");
  await expectStart(["..", "a spaced.txt", "alpha-2.zz"]);
  await openSort("Right");
  assert.equal(await currentSort(), originalRightSort);
  await closeSort();
  if (startDesktop && exitDesktop) {
    await exitDesktop(page);
    page = await startDesktop();
    await expectStart(["..", "a spaced.txt", "alpha-2.zz"]);
    await openSort();
    assert.equal(await active().getByRole("checkbox", { name: "Use sort groups", exact: true }).getAttribute("aria-checked"), "true");
    assert.equal(await active().getByRole("checkbox", { name: "Show directories first", exact: true }).getAttribute("aria-checked"), "false");
    await closeSort();
  }
  console.log("Verified sort menu, priorities, configured tie-breakers, metadata and NTFS streams, and independent panes.");
  return page;
}
