import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { openMainMenu } from "./menu-header-smoke.mjs";

const platforms = ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Mozilla/5.0 (X11; Linux x86_64)", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"];
const markModifier = process.platform === "darwin" ? "Meta" : "Control";
const pane = (page, side) => page.getByRole("region", { name: `${side} pane`, exact: true });
const grid = (page, side) => pane(page, side).getByRole("grid", { name: "Running processes", exact: true });
const row = (page, side, pid) => grid(page, side).getByRole("row").filter({
  has: page.getByRole("gridcell", { name: String(pid), exact: true }),
});
const menu = (page) => page.getByRole("menu", { name: "Process actions", exact: true });
const item = (page, name) => menu(page).getByRole("menuitem", { name, exact: true });
const button = (scope, name) => scope.getByRole("button", { name, exact: true });

async function fixture(browser, userAgent, shortcuts) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 660 }, userAgent, locale: "en-US" });
  page.setDefaultTimeout(8000);
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  const windows = userAgent === platforms[0];
  const directory = windows ? "C:\\Program Files\\Fixture" : "/opt/Fixture App";
  const executable = directory + (windows ? "\\" : "/") + "worker.exe";
  await page.addInitScript(({ windows, directory, executable, shortcuts }) => {
    const home = windows ? "C:\\fixture" : "/fixture";
    const entry = (name) => ({ name, directory: false, hidden: false, link: false, size: 5, modified: null });
    const process = (pid, cpu, canTerminate, path) => ({ pid, started: 10, name: "worker", cpu, memory: 4096, canTerminate, executable: path });
    if (shortcuts) localStorage.setItem("dirlume.preferences.v1", JSON.stringify({ bindingDefaults: 9, activeShortcutScheme: "fixture",
      shortcutSchemes: [{ id: "fixture", name: "Fixture keys", bindings: { processContextMenu: shortcuts } }] }));
    const separator = windows ? "\\" : "/";
    const short = windows ? "C:\\a.exe" : "/a.exe";
    const long = directory + separator + "nested-directory".repeat(6) + separator + "long-example.exe";
    window.fixtureProcesses = [process(9101, 8, true, short), process(9102, 6, true, long),
      process(9103, 4, true, executable), process(9104, 2, false, null)];
    window.clipboardWrites = [];
    window.terminationRequests = [];
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args) => {
        if (command === "locations") return [{ label: "Home", path: home }, { label: "Downloads", path: home }];
        if (command === "list_directory") {
          const path = args.path.replace(/[\\/]$/, "");
          if (path === directory && window.denyExecutable) throw new Error("Fixture access denied");
          return { path, parent: null, omitted: 0, entries: path === directory
            ? window.missingExecutable ? [] : [entry("worker.exe")] : [entry("locked.txt")] };
        }
        if (command === "list_processes") return structuredClone(window.fixtureProcesses);
        if (command === "locking_processes") return { processes: structuredClone(window.fixtureProcesses), incomplete: false };
        if (command === "file_icons") return args.items.map(() => null);
        if (command === "process_icons") return args.ids.map(() => null);
        if (command === "copy_path") {
          if (window.denyClipboard) throw new Error("Fixture clipboard refused");
          window.clipboardWrites.push(args.path);
        }
        if (command === "terminate_processes") {
          window.terminationRequests.push(args.ids);
          return ["The process no longer matches the selected entry."];
        }
        return null;
      },
    };
  }, { windows, directory, executable, shortcuts });
  await page.goto("http://dirlume.test/");
  return { page, executable };
}

async function openProcesses(page, side) {
  const section = pane(page, side);
  await button(section, `Locations for ${side} pane`).click();
  await button(section, "Processes").click();
  await row(page, side, 9101).waitFor();
}

async function checkExecutableAlignment(page, side) {
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 1440, height: viewport.height });
  const table = grid(page, side);
  const column = table.locator(".process-col-executable");
  const grip = column.getByRole("separator", { name: "Resize Executable path column", exact: true });
  const widths = () => column.evaluate((header) => header.getBoundingClientRect().width);
  const check = () => table.evaluate((grid) => {
    const cells = [...grid.querySelectorAll(".process-cell-executable")];
    const insets = cells.map((cell) => {
      const text = document.createRange();
      text.selectNodeContents(cell);
      return Math.round(text.getBoundingClientRect().left - cell.getBoundingClientRect().left);
    });
    const numeric = grid.querySelectorAll(".process-col-pid, .process-col-cpu, .process-col-memory, .process-cell-pid, .process-cell-cpu, .process-cell-memory");
    return {
      header: getComputedStyle(grid.querySelector(".process-col-executable")).textAlign,
      insets,
      clipped: cells.map((cell) => cell.scrollWidth > cell.clientWidth),
      overflow: getComputedStyle(cells[1]).textOverflow,
      numericAligned: numeric.length > 0 && [...numeric].every((cell) => getComputedStyle(cell).textAlign === "right"),
    };
  });
  const initial = await widths();
  for (const resize of [false, true]) {
    if (resize) {
      await grip.press("ArrowLeft");
      assert.ok(await widths() < initial);
    }
    const { header, insets, clipped, overflow, numericAligned } = await check();
    assert.equal(header, "left");
    assert.deepEqual(insets, Array(4).fill(insets[0]));
    assert.deepEqual(clipped.slice(0, 2), [false, true]);
    assert.equal(overflow, "ellipsis");
    assert.equal(numericAligned, true);
  }
  const clipped = row(page, side, 9102).locator(".process-cell-executable");
  await clipped.hover();
  const tooltip = page.getByRole("tooltip");
  await tooltip.waitFor();
  assert.equal(await tooltip.textContent(), await clipped.textContent());
  await page.mouse.move(2, 2);
  await tooltip.waitFor({ state: "hidden" });
  await grip.dispatchEvent("dblclick");
  await page.setViewportSize(viewport);
}

const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const [index, userAgent] of platforms.entries()) {
    const { page, executable } = await fixture(browser, userAgent);
    const side = index === 1 ? "right" : "left";
    const other = side === "left" ? "right" : "left";
    await openProcesses(page, side);
    const table = grid(page, side);
    await checkExecutableAlignment(page, side);
    const target = row(page, side, 9103);
    await row(page, side, 9101).click();
    await row(page, side, 9102).click({ modifiers: [markModifier] });
    const marked = table.locator('tbody tr[aria-selected="true"]');
    await target.getByRole("gridcell", { name: "9103", exact: true }).click({ button: "right" });
    await menu(page).getByText("PID 9103", { exact: true }).waitFor();
    assert.equal(await marked.count(), 2);
    assert.equal(await target.getAttribute("aria-selected"), "false");
    const end = item(page, "End process…");
    await end.click();
    const confirm = page.getByRole("dialog", { name: "End processes", exact: true });
    assert.deepEqual(await confirm.getByRole("listitem").allTextContents(), ["worker (PID 9103)"]);
    await page.waitForFunction(() => document.activeElement?.textContent === "Cancel");
    await button(confirm, "Cancel").click();
    assert.equal(await marked.count(), 2);
    assert.deepEqual(await page.evaluate(() => window.terminationRequests), []);

    await page.waitForFunction((side) => document.activeElement?.id === `${side}-files`, side);
    await table.press("Shift+F10");
    await item(page, "Properties").waitFor();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    assert.deepEqual(await page.evaluate(() => window.clipboardWrites), ["9103"]);
    const executableHeader = button(table.getByRole("columnheader"), "Executable path");
    await executableHeader.click({ button: "right" });
    const columns = page.getByRole("menu", { name: "Columns", exact: true });
    await columns.getByRole("menuitemcheckbox", { name: "Executable path", exact: true }).click();
    await page.keyboard.press("Escape");
    await target.click({ button: "right" });
    await item(page, "Copy executable path").click();
    assert.deepEqual(await page.evaluate(() => window.clipboardWrites), ["9103", executable]);

    await target.click({ button: "right" });
    await item(page, "Show in other pane").click();
    await pane(page, other).getByRole("option", { name: /^worker\.exe/, selected: true }).waitFor();
    await table.waitFor();
    await row(page, side, 9104).click({ button: "right" });
    assert.equal(await item(page, "Show in other pane").isDisabled(), true);
    assert.equal(await item(page, "Copy executable path").isDisabled(), true);
    assert.equal(await end.isDisabled(), true);
    await item(page, "Copy PID").click();
    assert.equal(await page.evaluate(() => window.clipboardWrites.at(-1)), "9104");
    await page.close();
  }

  const { page } = await fixture(browser, platforms[0], ["Ctrl+Shift+P"]);
  const side = "left";
  const table = grid(page, side);
  const target = row(page, side, 9103);
  await openProcesses(page, side);
  await button(table.getByRole("columnheader"), "CPU").click();
  await target.click();
  await table.press("Control+Shift+p");
  await menu(page).getByText("PID 9103", { exact: true }).waitFor();
  await page.evaluate(() => { window.fixtureProcesses[2].cpu = 15; });
  await table.locator("tbody tr").first().getByRole("gridcell", { name: "9103", exact: true }).waitFor();
  await menu(page).getByText("PID 9103", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.id === "left-files");
  await table.press("Control+Shift+p");
  await page.evaluate(() => { window.denyClipboard = true; });
  await item(page, "Copy PID").click();
  await page.getByText(/Fixture clipboard refused/).waitFor();
  await target.click({ button: "right" });
  await page.evaluate(() => { window.missingExecutable = true; });
  await item(page, "Show in other pane").click();
  await page.getByText(/no longer found: worker\.exe/i).waitFor();
  await target.click({ button: "right" });
  await page.evaluate(() => { window.denyExecutable = true; });
  await item(page, "Show in other pane").click();
  await page.getByText("Could not open the selected location.", { exact: true }).waitFor();

  await target.click({ button: "right" });
  await item(page, "End process…").click();
  const confirm = page.getByRole("dialog", { name: "End processes", exact: true });
  await page.evaluate(() => { window.fixtureProcesses[2].started = 11; });
  await button(confirm, "End process").click();
  await confirm.getByText("The process no longer matches the selected entry.", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.terminationRequests), [[{ pid: 9103, started: 10 }]]);
  await button(confirm, "Cancel").click();
  await row(page, side, 9103).locator(".process-cell-pid").click({ button: "right" });
  await item(page, "Properties").waitFor();
  await page.evaluate(() => { window.fixtureProcesses = []; });
  await menu(page).waitFor({ state: "hidden" });
  const empty = table.locator("..");
  assert.equal(await empty.evaluate((element) => element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))), false);
  assert.equal(await menu(page).count(), 0);
  await page.close();

  const { page: lock } = await fixture(browser, platforms[0], []);
  const lockedItem = pane(lock, "left").getByRole("option", { name: /^locked\.txt/ });
  await lockedItem.click();
  const files = await openMainMenu(lock, "Files");
  await files.getByRole("menuitem", { name: "Find locking processes", exact: true }).click();
  const lockGrid = grid(lock, "right");
  const owner = row(lock, "right", 9101);
  await owner.click();
  await lockGrid.press("Shift+F10");
  assert.equal(await menu(lock).count(), 0);
  await owner.click({ button: "right" });
  await item(lock, "Properties").waitFor();
  assert.equal(await item(lock, "Show in other pane").count(), 0);
  await item(lock, "Copy PID").click();
  assert.equal(await lock.evaluate(() => window.clipboardWrites.at(-1)), "9101");
  assert.equal(await lockedItem.getAttribute("data-current"), "true");
  console.log("Verified process row menus on Windows, Ubuntu, and macOS, independent marks, PID identity across refresh, paths, and locking results.");
} finally {
  await browser.close();
}
