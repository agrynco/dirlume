import assert from "node:assert/strict";
import { link, mkdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { editPaneAddress } from "./pane-address-smoke.mjs";
import { closeToolWindow, openOptionsWindow } from "./tool-window-smoke.mjs";
import { openMainMenu } from "./menu-header-smoke.mjs";

async function pressDigit(page, side, digit) {
  const ctrl = `Control${side}`;
  await page.keyboard.down(ctrl);
  await page.keyboard.press(`Digit${digit}`);
  await page.keyboard.up(ctrl);
}

const fileName = (index) => `item-${String(index).padStart(3, "0")}.txt`;
const fileNames = Array.from({ length: 220 }, (_, index) => fileName(index));

async function checkGroupedPages(page, side, columns, names) {
  const list = page.locator(`#${side}-files`);
  const cursor = list.locator(".file-row[data-current=true]");
  const rows = (column) => list.locator(`.file-row-group:nth-child(${column}) .file-row`);
  const press = (key) => list.press(key);
  const expectAt = async (index, visual) => {
    const selected = cursor.and(list.locator(`[aria-posinset="${index + 1}"]`));
    await selected.waitFor();
    assert.equal(await selected.getAttribute("data-tooltip"), names[index]);
    const box = await selected.boundingBox();
    if (visual) assert.deepEqual([box.x, box.y], [visual.x, visual.y]);
    const viewport = await list.boundingBox();
    assert.ok(box.y >= viewport.y && box.y + box.height <= viewport.y + viewport.height + 0.01);
    return box;
  };

  await press("Home");
  await expectAt(0);
  const perColumn = await rows(1).count();
  const capacity = perColumn * columns;
  assert.ok(perColumn > 2 && capacity * 2 < names.length);
  for (let column = 1; column <= columns; column++) {
    const last = perColumn * column - 1;
    await rows(column).last().click();
    const before = await expectAt(last);
    await press("ArrowDown");
    const after = await expectAt(last + 1);
    assert.ok(after.y < before.y);
    assert.ok(column < columns ? after.x > before.x : after.x < before.x);
    await press("ArrowUp");
    await expectAt(last, before);
  }
  await press("Home");
  const initial = await expectAt(0);
  await press("ArrowLeft");
  await expectAt(0, initial);
  const offset = perColumn + 2;
  await rows(2).nth(2).click();
  const coordinate = await expectAt(offset);
  for (const [next, previous] of [["ArrowRight", "ArrowLeft"], ["PageDown", "PageUp"]]) {
    await press(next);
    await expectAt(capacity + offset, coordinate);
    await press(previous);
    await expectAt(offset, coordinate);
  }
  await press("End");
  await expectAt(names.length - 1);
  await press("ArrowRight");
  await press("ArrowDown");
  await expectAt(names.length - 1);
  const lastCount = names.length % capacity;
  if (lastCount) {
    await press("PageUp");
    const lastFullPage = names.length - lastCount - capacity;
    await rows(columns).last().click();
    await expectAt(lastFullPage + capacity - 1);
    await press("PageDown");
    await expectAt(names.length - 1);
  }
  await press("Home");
  for (let index = 0; index < names.length; index++) {
    assert.equal(await cursor.getAttribute("data-tooltip"), names[index]);
    await press("ArrowDown");
  }
  for (let index = names.length - 1; index >= 0; index--) {
    assert.equal(await cursor.getAttribute("data-tooltip"), names[index]);
    await press("ArrowUp");
  }
  assert.equal(await cursor.getAttribute("data-tooltip"), names[0]);
  assert.equal(await list.evaluate((element) => element.scrollTop), 0);
}

export async function testPanelModes({ page, startDesktop, exitDesktop, root }) {
  const folder = join(root, "panel modes");
  const pagingFolder = join(root, "panel pages");
  await mkdir(folder);
  await mkdir(pagingFolder);
  await mkdir(join(folder, "SAMPLE.FOLDER"));
  await writeFile(join(folder, "UPPERCASE.TXT"), "x".repeat(12345));
  await Promise.all(["report.txt", "archive.tar.gz", "LICENSE", ".gitignore"].map((name) => writeFile(join(folder, name), "")));
  await Promise.all(fileNames.slice(0, 80).map((name) => writeFile(join(folder, name), "")));
  await Promise.all(fileNames.map((name) => writeFile(join(pagingFolder, name), "")));
  const list = (side) => page.locator(`#${side}-files`);
  const row = (name) => list("left").locator(`[data-tooltip="${name}"]`);
  const visibleName = (name) => row(name).locator(".file-name-text");
  const nameParts = (name) => visibleName(name).locator(":scope > span").allTextContents();
  async function waitMode(side, mode) {
    await page.locator(`#${side}-pane[data-panel-mode="${mode}"]`).waitFor();
  }

  const address = await editPaneAddress(page, "left");
  await address.fill(folder);
  await address.press("Enter");
  await row("UPPERCASE.TXT").waitFor();
  assert.deepEqual(await nameParts("report.txt"), ["report", "txt"]);
  assert.deepEqual(await nameParts("archive.tar.gz"), ["archive.tar", "gz"]);
  for (const name of ["LICENSE", "SAMPLE.FOLDER"]) {
    assert.equal(await visibleName(name).textContent(), name);
    assert.deepEqual(await nameParts(name), []);
  }
  const showHidden = page.getByRole("button", { name: "Show hidden files", exact: true });
  const hiddenWasOff = await showHidden.getAttribute("aria-pressed") === "false";
  if (hiddenWasOff) await showHidden.click();
  assert.equal(await visibleName(".gitignore").textContent(), ".gitignore");
  assert.deepEqual(await nameParts(".gitignore"), []);
  if (hiddenWasOff) await showHidden.click();
  await row("report.txt").click();
  await list("left").press("Control+Shift+c");
  await page.waitForFunction(async (expected) =>
    await window.__TAURI_INTERNALS__.invoke("clipboard_text") === expected, join(folder, "report.txt"));
  await list("left").press("F2");
  const rename = row("report.txt").getByRole("textbox", { name: "New name for report.txt", exact: true });
  assert.equal(await rename.inputValue(), "report.txt");
  await rename.press("Escape");
  await rename.waitFor({ state: "hidden" });
  // Select an item in the first column before exercising horizontal navigation.
  await row("item-000.txt").click();
  await list("right").focus();
  const leftMenu = await openMainMenu(page, "Left");
  assert.deepEqual(await leftMenu.getByRole("menuitemradio").evaluateAll((items) =>
    items.slice(0, 7).map((item) => item.querySelector(".main-menu-choice").textContent)),
  ["Brief", "Medium", "Full", "Wide", "File owners", "File links", "Alternative full"]);
  await leftMenu.getByRole("menuitemradio", { name: "Space Analyzer", exact: true }).waitFor();
  assert.equal(await leftMenu.getByRole("menuitemradio", { name: "Full", exact: true }).getAttribute("aria-checked"), "true");
  await leftMenu.getByRole("menuitemradio", { name: "Brief", exact: true }).click();
  await waitMode("left", "brief");
  await waitMode("right", "full");
  assert.equal(await list("left").locator(".file-row-group").count(), 3);
  assert.equal(await row("item-000.txt").getAttribute("data-current"), "true");
  const openFolder = async (side, destination) => {
    const field = await editPaneAddress(page, side);
    await field.fill(destination);
    await field.press("Enter");
    await page.waitForFunction(({ side, destination }) =>
      document.getElementById(side + "-path").dataset.path === destination &&
      document.getElementById(side + "-files").getAttribute("aria-busy") === "false", { side, destination });
  };
  const expected = ["..", ...fileNames];
  await openFolder("left", pagingFolder);
  await checkGroupedPages(page, "left", 3, expected);
  await openFolder("left", folder);

  await openFolder("right", pagingFolder);
  await list("right").locator('[data-tooltip="item-000.txt"]').waitFor();
  await list("right").focus();
  await pressDigit(page, "Left", 2);
  await waitMode("right", "medium");
  assert.equal(await list("right").locator(".file-row-group").count(), 2);
  await checkGroupedPages(page, "right", 2, expected);
  for (const [digit, id] of [[1, "brief"], [3, "full"], [4, "wide"], [8, "owners"], [9, "links"], [0, "alternativeFull"]]) {
    await pressDigit(page, "Left", digit);
    await waitMode("right", id);
  }
  for (const digit of [5, 6, 7]) await pressDigit(page, "Left", digit);
  await waitMode("right", "alternativeFull");
  for (let digit = 0; digit < 10; digit++) {
    await pressDigit(page, "Right", digit);
    await page.getByText(`No folder shortcuts in group ${digit}.`, { exact: true }).waitFor();
    await waitMode("right", "alternativeFull");
  }
  const right = list("right");
  const ctrlEvent = (type, code, held) => right.dispatchEvent(type, { key: "Control", code, ctrlKey: held, bubbles: true });
  await ctrlEvent("keydown", "ControlLeft", true);
  await ctrlEvent("keydown", "ControlRight", true);
  await right.dispatchEvent("keydown", { key: "1", code: "Digit1", ctrlKey: true, bubbles: true });
  await waitMode("right", "alternativeFull");
  await ctrlEvent("keyup", "ControlLeft", true);
  await right.dispatchEvent("keydown", { key: "2", code: "Digit2", ctrlKey: true, bubbles: true });
  await page.getByText("No folder shortcuts in group 2.", { exact: true }).waitFor();
  await ctrlEvent("keyup", "ControlRight", false);

  await list("left").focus();
  await pressDigit(page, "Left", 8);
  await waitMode("left", "owners");
  await page.waitForFunction(() => {
    const owner = document.querySelector('#left-files [data-tooltip="UPPERCASE.TXT"] .file-owner');
    return owner && owner.textContent !== "—";
  });
  await pressDigit(page, "Left", 9);
  await waitMode("left", "links");
  const links = (name) => row(name).locator(".file-links");
  const expectLinks = (name, value) => links(name).getByText(value, { exact: true }).waitFor();
  await expectLinks("UPPERCASE.TXT", "1");
  await expectLinks("SAMPLE.FOLDER", "—");
  const alias = join(folder, "ALIAS.TXT");
  await link(join(folder, "UPPERCASE.TXT"), alias);
  await list("left").press("Control+r");
  await expectLinks("ALIAS.TXT", "2");
  await expectLinks("UPPERCASE.TXT", "2");
  await unlink(alias);
  await list("left").press("Control+r");
  await expectLinks("UPPERCASE.TXT", "1");

  await pressDigit(page, "Left", 0);
  await waitMode("left", "alternativeFull");
  await row("UPPERCASE.TXT").click();
  assert.equal(await row("UPPERCASE.TXT").locator(".file-size").innerText(), "12,345");
  await list("left").press("Insert");
  await row("UPPERCASE.TXT").locator(".panel-mode-mark svg").waitFor();
  const tool = await openOptionsWindow(page);
  const options = tool.getByRole("dialog", { name: "Options", exact: true });
  await options.getByRole("searchbox", { name: "Search settings" }).fill("alternative full");
  await options.getByRole("button", { name: "Alternative full", exact: true }).click();
  const fields = options.locator(".panel-mode-settings");
  const name = fields.getByRole("textbox", { name: "Name", exact: true });
  await name.fill("Compact details");
  const width = fields.getByRole("textbox", { name: "Column widths, field 2", exact: true });
  await width.fill("bad");
  assert.equal(await options.getByRole("button", { name: "Apply", exact: true }).isDisabled(), true);
  await width.fill("35%");
  await fields.getByRole("checkbox", { name: "Show uppercase file names in lowercase" }).check();
  await fields.getByRole("checkbox", { name: "Show folders in uppercase" }).uncheck();
  await fields.getByRole("checkbox", { name: "Align file extensions" }).uncheck();
  await fields.getByRole("checkbox", { name: "Align folder extensions" }).check();
  await options.getByRole("button", { name: "Apply", exact: true }).click();
  await row("UPPERCASE.TXT").getByText("uppercase.txt", { exact: true }).waitFor();
  assert.equal(await visibleName("report.txt").textContent(), "report.txt");
  assert.deepEqual(await nameParts("report.txt"), []);
  assert.deepEqual(await nameParts("SAMPLE.FOLDER"), ["SAMPLE", ".FOLDER"]);
  await fields.getByRole("button", { name: "Move field 2 down", exact: true }).first().click();
  await options.getByRole("button", { name: "Reset", exact: true }).click();
  assert.equal(await name.inputValue(), "");
  await closeToolWindow(tool, () => options.getByRole("button", { name: "Cancel", exact: true }).click());
  await row("UPPERCASE.TXT").getByText("uppercase.txt", { exact: true }).waitFor();

  await exitDesktop(page);
  page = await startDesktop();
  await waitMode("left", "alternativeFull");
  await waitMode("right", "alternativeFull");
  await row("UPPERCASE.TXT").getByText("uppercase.txt", { exact: true }).waitFor();
  for (const side of ["left", "right"]) {
    await list(side).focus();
    await pressDigit(page, "Left", 3);
    await waitMode(side, "full");
  }
  console.log("Verified panel layouts, Ctrl sides, selection, metadata, and editable and persistent mode definitions.");
  return page;
}

export async function testBrowserPanelPages(userAgent) {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({ userAgent, viewport: { width: 1120, height: 720 } });
    page.setDefaultTimeout(8000);
    await page.route("http://dirlume.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    await page.addInitScript((files) => {
      const base = /Windows/i.test(navigator.userAgent) ? "C:\\" : "/";
      const panel = (name) => ({ place: { kind: "local", path: base + name, parent: base } });
      localStorage.setItem("dirlume.workspace.v1", JSON.stringify({
        panels: { left: panel("left"), right: panel("right") }, active: "left", split: 50, documents: [],
      }));
      localStorage.setItem("dirlume.preferences.v1", JSON.stringify({
        bindingDefaults: 7, activeShortcutScheme: "test", shortcutSchemes: [
          { id: "test", name: "Existing shortcuts", bindings: { firstRow: ["ArrowLeft", "Home"], lastRow: ["ArrowRight", "End"] } },
        ],
      }));
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args) => {
          if (command === "locations") return [{ label: "Home", path: base + "left" }];
          if (command === "list_directory") return { path: args.path, parent: base, omitted: 0,
            entries: files.map((name) => ({ name, directory: false, link: false, size: 1, modified: null })) };
          if (command === "read_text") return { text: args.name, encoding: "utf8" };
          if (command === "file_icons") return [];
          return null;
        },
      };
    }, fileNames);
    await page.goto("http://dirlume.test/");
    const list = (side) => page.locator(`#${side}-files`);
    for (const [side, mode, columns] of [["left", "Brief", 3], ["right", "Medium", 2]]) {
      await list(side).locator('[data-tooltip="item-000.txt"]').waitFor();
      const menu = await openMainMenu(page, side === "left" ? "Left" : "Right");
      await menu.getByRole("menuitemradio", { name: mode, exact: true }).click();
      await page.locator("#" + side + "-files[data-paged] .file-row").first().waitFor();
      await checkGroupedPages(page, side, columns, ["..", ...fileNames]);
    }
    const right = list("right");
    const firstColumn = right.locator(".file-row-group:first-child .file-row");
    const oldCount = await firstColumn.count();
    await page.setViewportSize({ width: 1020, height: 560 });
    await page.waitForFunction((old) => document.querySelectorAll("#right-files .file-row-group:first-child .file-row").length < old, oldCount);
    const pageSize = 2 * await firstColumn.count();
    await right.press("Home");
    await right.press("ArrowDown");
    await right.press("Control+q");
    await page.locator(".quick-view-left").getByText("item-000.txt", { exact: true }).last().waitFor();
    await right.press("PageDown");
    await page.locator(".quick-view-left").getByText(fileName(pageSize), { exact: true }).last().waitFor();
    await right.press("Control+q");

    await page.getByRole("button", { name: "Options", exact: true }).click();
    const options = page.getByRole("dialog", { name: "Options", exact: true });
    const button = (name) => options.getByRole("button", { name, exact: true });
    await button("Keyboard shortcuts").click();
    await button("Change → for Next page or last item").click();
    await options.getByRole("textbox", { name: "New shortcut to replace → for Next page or last item", exact: true }).press("Alt+ArrowDown");
    await button("Remove PageDown from Next page").click();
    await button("Done").click();
    await right.press("Home");
    await right.press("ArrowRight");
    await right.press("PageDown");
    assert.equal(await right.locator("[data-current=true]").getAttribute("data-tooltip"), "..");
    await right.press("Alt+ArrowDown");
    assert.equal(await right.locator("[data-current=true]").getAttribute("data-tooltip"), fileName(pageSize - 1));
    console.log("Verified deterministic column and page navigation, resizing, Quick View and shortcut changes.");
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testBrowserPanelPages();
