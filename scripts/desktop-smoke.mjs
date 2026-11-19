import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright-core";
import { close, fixture, port, withServer } from "./server-smoke.mjs";
import { testFtp } from "./ftp-smoke.mjs";
import { testMarkdown } from "./markdown-smoke.mjs";
import { testNewFileEncoding } from "./new-file-encoding-smoke.mjs";
import { testTerminalEnvironment } from "./terminal-environment-smoke.mjs";
import { testFolderShortcuts } from "./folder-shortcuts-smoke.mjs";
import { testCommandCompletion } from "./command-completion-smoke.mjs";
import { testCompareWorker } from "./compare-smoke.mjs";
import { testNewFolder } from "./new-folder-smoke.mjs";
import { testShortcutFields } from "./shortcut-field-smoke.mjs";
import { testArchives } from "./archive-smoke.mjs";

if (process.platform !== "win32") throw new Error("This smoke test uses Windows WebView2.");
const profile = process.env.DIRLUME_BUILD_PROFILE ?? "release";
const temp = await fixture("desktop-");
const src = join(temp, "from");
const dst = join(temp, "to");
const diagnostics = join(temp, "diagnostics");
const diagnosticsFile = join(diagnostics, "diagnostics.jsonl");
const attributes = join(temp, "attributes");
await mkdir(src);
await mkdir(dst);
await writeFile(join(src, ".hidden-file"), "Hidden file");
await mkdir(join(dst, ".hidden-folder"));
await mkdir(attributes);
await mkdir(join(attributes, ".metadata"));
await mkdir(join(attributes, "system-folder"));
await writeFile(join(attributes, "hidden.rs"), "Hidden source file");
await writeFile(join(attributes, "system-hidden.dll"), "System and hidden file");
await writeFile(join(attributes, "ordinary.sys"), "File without the System attribute");
for (const [name, flags] of [["hidden.rs", ["+H"]], ["system-folder", ["+S"]], ["system-hidden.dll", ["+S", "+H"]]]) {
  execFileSync("attrib.exe", [...flags, join(attributes, name)], { windowsHide: true });
}
await writeFile(join(src, "notes.txt"), "Dirlume\n");
await writeFile(join(src, "second.txt"), "Second file\n");
await writeFile(join(src, "guide.md"), "# Getting started\n\n**Dirlume** on Windows.\n\n```mermaid\nflowchart LR\n  A[Files] --> B[Preview]\n```\n");
await writeFile(join(src, "sample.rs"), "fn main() { let ready = true; }\n");
await writeFile(join(src, "control.bin"), Buffer.from([0xef, 0xbb, 0xbf, 0x41, 0, 9, 13, 10, 255]));
await copyFile(join(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), join(src, "sample-app.exe"));
await writeFile(join(src, "drag-file.txt"), "Dragged file");
await mkdir(join(src, "drag-folder"));
await writeFile(join(src, "drag-folder", "child.txt"), "Dragged folder");
await mkdir(join(src, "measured"));
await writeFile(join(src, "measured", "data.bin"), Buffer.alloc(12));
await mkdir(join(src, "overlap"));
await mkdir(join(dst, "overlap"));
await writeFile(join(src, "overlap", "data.bin"), Buffer.alloc(12));
await writeFile(join(src, "overlap", "other.bin"), Buffer.alloc(13, 7));
await writeFile(join(dst, "overlap", "data.bin"), Buffer.alloc(2, 1));
await writeFile(join(dst, "overlap", "other.bin"), Buffer.alloc(2, 2));
if (process.env.DIRLUME_CROSS_VOLUME_TEST_ROOT) {
  await writeFile(join(src, "volume.txt"), "Cross-volume move");
  await mkdir(join(src, "merge"));
  await writeFile(join(src, "merge", "update.txt"), "New contents");
}
let child;
let browser;
let otherVolume;
let lockedBy;

async function startDesktop() {
  const debuggingPort = await port();
  child = spawn(resolve(`src-tauri/target/${profile}/dirlume.exe`), [], {
    windowsHide: true,
    env: {
      ...process.env,
      DIRLUME_TEST_PROCESS_ONLY: "launcher-value",
      ...(process.env.DIRLUME_INTERNAL_CDP === "1"
        ? { DIRLUME_CDP_PORT: String(debuggingPort) }
        : { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${debuggingPort}` }),
      WEBVIEW2_USER_DATA_FOLDER: join(temp, "webview"),
      DIRLUME_FTP_TEST_CONFIG: join(temp, "ftp-config"),
      DIRLUME_TEST_DIAGNOSTICS_DIR: diagnostics,
    },
  });
  let startupError = "";
  let startupOutput = "";
  child.on("error", (error) => { startupError = error.message; });
  child.stderr.on("data", (chunk) => { startupOutput = (startupOutput + chunk).slice(-2500); });
  for (let attempt = 0; !browser; attempt++) {
    if (attempt === 100 || startupError || child.exitCode !== null) {
      throw new Error(`The Windows WebView did not start. PID ${child.pid}, exit code ${child.exitCode}. ${startupError} ${startupOutput}`);
    }
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`, { timeout: 1000 });
    } catch {
      await setTimeout(250);
    }
  }
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent("page", { timeout: 8000 });
  page.setDefaultTimeout(8000);
  return page;
}

async function exitDesktop(page) {
  const exit = new Promise((complete) => child.once("exit", complete));
  const closeKey = page.keyboard.press("F10").catch((error) => {
    if (!page.isClosed()) throw error;
  });
  const status = await Promise.race([exit, setTimeout(8000, "timeout", { ref: false })]);
  await closeKey;
  assert.equal(status, 0, "Dirlume should exit after closing a workspace with no unsaved changes.");
  await browser?.close().catch(() => {});
  browser = undefined;
}

try {
  let page = await startDesktop();
  async function startTransfer(action, destination = dst) {
    const setup = page.getByRole("dialog", { name: action === "Move" ? "Rename or move" : action, exact: true });
    await setup.waitFor();
    assert.equal(await setup.getByLabel("Destination", { exact: true }).inputValue(), destination);
    await setup.getByRole("button", { name: action, exact: true }).click();
  }
  async function finishTransfer(action, expectedCount = 1, destination = dst) {
    await startTransfer(action, destination);
    const result = page.getByRole("dialog", { name: "Transfer complete", exact: true });
    await result.getByText(`${expectedCount} completed.`, { exact: true }).waitFor();
    const progress = result.getByRole("progressbar", { name: "Overall transfer progress" });
    assert.equal(await progress.getAttribute("value"), String(expectedCount));
    await result.getByRole("button", { name: "Done" }).click();
  }
  const pageErrors = [];
  page.on("pageerror", (error) => { pageErrors.push(error.message); });
  await page.getByRole("heading", { name: "Dirlume" }).waitFor();
  const bundledFamily = "GoMono Nerd Font Mono";
  const defaultFonts = await page.evaluate(async (family) => {
    const styles = ["400", "700", "italic 400", "italic 700"];
    const loaded = await Promise.all(styles.map((style) => document.fonts.load(`${style} 18px "${family}"`, "Dirlume Україна")));
    const root = getComputedStyle(document.documentElement);
    const groups = ["ui", "panel", "dialog", "viewer", "editor", "terminal"];
    return {
      faces: loaded.map((faces) => faces.length > 0 && faces.every((face) => face.status === "loaded")),
      families: groups.map((group) => root.getPropertyValue(`--${group}-font`).startsWith(`"${family}"`)),
      sizes: groups.map((group) => root.getPropertyValue(`--${group}-size`)),
    };
  }, bundledFamily);
  assert.deepEqual(defaultFonts.faces, [true, true, true, true]);
  assert.ok(defaultFonts.families.every(Boolean));
  assert.deepEqual(defaultFonts.sizes, Array(6).fill("18px"));
  assert.equal(await page.getByRole("button", { name: "Find files" }).getAttribute("title"), "Find files (Alt+F7)");
  assert.equal(await page.getByRole("region", { name: "right pane" }).getByRole("button", { name: "Refresh folder" }).getAttribute("title"), "Refresh folder");
  assert.deepEqual(await page.locator("button:visible").evaluateAll((buttons) =>
    buttons.filter((button) => !button.title.trim()).map((button) => button.textContent)), []);
  await page.waitForFunction(() => ["left", "right"].every((side) =>
    document.getElementById(`${side}-address`)?.value &&
    document.getElementById(`${side}-files`)?.getAttribute("aria-busy") === "false"));
  async function navigate(side, path) {
    const input = page.getByLabel(`${side} path`, { exact: true });
    await input.fill(path);
    await input.press("Enter");
    try {
      await page.getByRole("region", { name: `${side} pane`, exact: true })
        .getByRole("heading", { name: path.split(/[\\/]/).filter(Boolean).at(-1), exact: true }).waitFor();
      await page.waitForFunction((side) => document.getElementById(`${side}-files`)?.getAttribute("aria-busy") === "false", side);
    } catch (error) {
      throw new Error(`Could not navigate the ${side} pane: ${await page.getByRole("alert").allTextContents()}`, { cause: error });
    }
  }
  let diagnosticsBeforeRestart;
  if (process.env.DIRLUME_INTERNAL_CDP === "1") {
    const secret = "dirlume-private-fixture-data";
    await page.evaluate(async (path) => {
      for (let action = 0; action < 34; action++) {
        await window.__TAURI_INTERNALS__.invoke("list_directory", { path });
      }
    }, src);
    const address = page.getByLabel("left path", { exact: true });
    await address.fill(join(src, secret));
    await address.press("Enter");
    await page.locator("#left-pane").getByRole("alert").waitFor();
    await page.evaluate((secret) => {
      const error = new TypeError(secret);
      window.dispatchEvent(new ErrorEvent("error", { error, message: secret }));
      window.dispatchEvent(new ErrorEvent("error", { error, message: secret }));
    }, secret);
    for (let attempt = 0; attempt < 50; attempt++) {
      diagnosticsBeforeRestart = await readFile(diagnosticsFile, "utf8").catch(() => "");
      if (diagnosticsBeforeRestart.includes('"code":"type_error"') &&
          diagnosticsBeforeRestart.includes('"operation":"list_directory","code":')) break;
      await setTimeout(100);
    }
    const records = diagnosticsBeforeRestart.trim().split("\n").map((line) => JSON.parse(line));
    const nativeErrors = records.filter(({ operation }) => operation === "list_directory");
    assert.equal(nativeErrors.length, 1, "The IPC failure and UI error use one log entry.");
    assert.equal(nativeErrors[0].recentActions.length, 32);
    assert.ok(nativeErrors[0].recentActions.every(({ operation }) => operation === "list_directory"));
    assert.equal(records.filter(({ code }) => code === "type_error").length, 1);
    assert.ok(!diagnosticsBeforeRestart.includes(secret), "Diagnostic records contain safe codes and operation names only.");
  }
  const fontSize = (selector) => page.locator(selector).evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  async function wheelFont(selector, deltaY, modifier = "Control") {
    await page.locator(selector).hover();
    if (modifier) await page.keyboard.down(modifier);
    try {
      await page.mouse.wheel(0, deltaY);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    } finally {
      if (modifier) await page.keyboard.up(modifier);
    }
  }
  await navigate("left", src);
  await navigate("right", dst);
  if (process.env.DIRLUME_BUNDLED_FONT_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_BUNDLED_FONT_SCREENSHOT, scale: "css" });
  const leftList = page.getByRole("listbox", { name: "left files", exact: true });
  const rightList = page.getByRole("listbox", { name: "right files", exact: true });
  const parentRow = '[role="option"][title=".."]';
  const emptyFolder = join(temp, "empty");
  await mkdir(emptyFolder);
  for (const [side, list] of [["left", leftList], ["right", rightList]]) {
    const pane = page.getByRole("region", { name: `${side} pane`, exact: true });
    const other = page.getByLabel(`${side === "left" ? "right" : "left"} path`, { exact: true });
    const otherPath = await other.inputValue();
    const up = pane.getByRole("button", { name: "Parent folder", exact: true });
    await navigate(side, emptyFolder);
    await list.locator(parentRow).waitFor();
    assert.equal(await list.getByRole("option").count(), 1);
    await up.click();
    await pane.getByRole("heading", { name: parse(temp).base, exact: true }).waitFor();
    const column = pane.getByRole("button", { name: /^Name/ });
    await column.click();
    await pane.getByRole("button", { name: "Filter folder", exact: true }).click();
    await pane.getByRole("textbox", { name: `Filter ${side} folder`, exact: true }).fill("no match");
    assert.equal(await list.getByRole("option").count(), 1);
    assert.equal(await list.getByRole("option").first().getAttribute("title"), "..");
    await pane.getByRole("button", { name: "Close filter", exact: true }).click();
    assert.equal(await list.getByRole("option").first().getAttribute("title"), "..");
    await column.click();
    await navigate(side, emptyFolder);
    await list.press("ArrowLeft");
    assert.equal(await list.locator(parentRow).getAttribute("data-current"), "true");
    assert.equal(await list.locator(parentRow).getAttribute("draggable"), "false");
    assert.equal(await page.getByRole("button", { name: /^Copy F5$/ }).isEnabled(), false);
    await list.press("Enter");
    await pane.getByRole("heading", { name: parse(temp).base, exact: true }).waitFor();
    assert.equal(await other.inputValue(), otherPath);
    await navigate(side, parse(temp).root);
    assert.equal(await list.locator(parentRow).count(), 0);
    assert.equal(await up.isEnabled(), false);
    await navigate(side, side === "left" ? src : dst);
  }
  const hiddenFile = leftList.getByRole("option", { name: /^\.hidden-file/ });
  const hiddenFolder = rightList.getByRole("option", { name: /^\.hidden-folder/ });
  const hiddenToggle = page.getByRole("button", { name: "Show hidden files", exact: true });
  const optionsButton = page.getByRole("button", { name: "Options", exact: true });
  const options = page.getByRole("dialog", { name: "Options", exact: true });
  const ukrainianCtrlH = { key: "р", code: "KeyH", ctrlKey: true, bubbles: true };
  await hiddenFile.waitFor({ state: "detached" });
  await hiddenFolder.waitFor({ state: "detached" });
  await leftList.press("Control+h");
  await hiddenFile.waitFor();
  await hiddenFolder.waitFor();
  assert.equal(await hiddenToggle.getAttribute("aria-pressed"), "true");
  await optionsButton.click();
  await options.getByRole("button", { name: "General", exact: true }).click();
  const productVersion = JSON.parse(await readFile("package.json", "utf8")).version;
  const buildNumber = process.env.DIRLUME_BUILD_NUMBER;
  await options.getByText(buildNumber ? `${productVersion}+${buildNumber}` : productVersion, { exact: true }).waitFor();
  await options.getByRole("button", { name: "Main File Panels", exact: true }).click();
  assert.equal(await options.getByRole("checkbox", { name: "Show hidden files" }).isChecked(), true);
  await options.getByRole("button", { name: "Done" }).click();
  await rightList.focus();
  await rightList.dispatchEvent("keydown", ukrainianCtrlH);
  await hiddenFile.waitFor({ state: "detached" });
  await hiddenFolder.waitFor({ state: "detached" });
  assert.equal(await hiddenToggle.getAttribute("aria-pressed"), "false");

  await optionsButton.click();
  assert.equal(await options.getByRole("checkbox", { name: "Show hidden files" }).isChecked(), false);
  const shortcuts = options.getByRole("button", { name: "Keyboard shortcuts", exact: true });
  await shortcuts.click();
  await options.getByRole("button", { name: "Clear shortcut for Show or hide hidden files" }).click();
  await options.getByRole("button", { name: "Done" }).click();
  await rightList.focus();
  await rightList.dispatchEvent("keydown", ukrainianCtrlH);
  await rightList.press("Control+h");
  assert.equal(await hiddenToggle.getAttribute("aria-pressed"), "false");

  await optionsButton.click();
  await options.getByRole("button", { name: "Change shortcut for Show or hide hidden files" }).click();
  await options.getByRole("textbox", { name: "New shortcut for Show or hide hidden files" }).press("Control+Shift+h");
  await options.getByRole("button", { name: "Done" }).click();
  await leftList.press("Control+Shift+h");
  await hiddenFile.waitFor();
  await hiddenFolder.waitFor();
  await leftList.press("Control+Shift+h");
  await hiddenFile.waitFor({ state: "detached" });
  await optionsButton.click();
  await options.getByRole("button", { name: "Restore defaults" }).click();
  await options.getByRole("button", { name: "General", exact: true }).click();
  await options.getByRole("button", { name: "Done" }).click();

  const leftFont = await fontSize("#left-pane");
  const rightFont = await fontSize("#right-pane");
  const activePane = await page.locator(".pane.active").getAttribute("id");
  await wheelFont("#left-files", -120);
  assert.ok(await fontSize("#left-pane") > leftFont, "Ctrl+Wheel should enlarge the hovered pane's font.");
  assert.equal(await fontSize("#right-pane"), rightFont);
  assert.equal(await page.locator(".pane.active").getAttribute("id"), activePane);
  await wheelFont("#left-files", 120);
  await wheelFont("#right-files", -120);
  assert.equal(await fontSize("#left-pane"), leftFont);
  assert.ok(await fontSize("#right-pane") > rightFont);
  await wheelFont("#right-files", 120);
  await wheelFont("#right-files", -120, "");
  assert.equal(await fontSize("#right-pane"), rightFont, "Unmodified wheel input should leave font size alone.");
  const leftAddress = page.getByLabel("left path", { exact: true });
  const leftSuggestions = page.getByRole("listbox", { name: "left path suggestions", exact: true });
  await leftAddress.fill(join(src, "me"));
  await leftSuggestions.getByRole("option", { name: "measured", exact: true }).waitFor();
  if (process.env.DIRLUME_ADDRESS_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_ADDRESS_SCREENSHOT, scale: "css" });
  await leftAddress.press("Tab");
  assert.equal(await leftAddress.inputValue(), join(src, "measured") + "\\");
  await leftAddress.press("Enter");
  const filePane = page.getByRole("region", { name: "left pane", exact: true });
  await filePane.getByRole("heading", { name: "measured", exact: true }).waitFor();
  await leftAddress.fill(join(src, "ov"));
  await leftSuggestions.getByRole("option", { name: "overlap", exact: true }).click();
  await filePane.getByRole("heading", { name: "overlap", exact: true }).waitFor();
  await leftAddress.fill(join(src, "me"));
  await leftSuggestions.getByRole("option", { name: "measured", exact: true }).waitFor();
  await leftAddress.press("ArrowDown");
  await leftSuggestions.getByRole("option", { name: "measured", selected: true }).waitFor();
  await leftAddress.press("Enter");
  await filePane.getByRole("heading", { name: "measured", exact: true }).waitFor();
  await navigate("left", src);
  const copySetup = page.getByRole("dialog", { name: "Copy", exact: true });
  const destination = copySetup.getByRole("combobox", { name: "Destination", exact: true });
  const destinationSuggestions = copySetup.getByRole("listbox", { name: "Destination suggestions", exact: true });
  await filePane.getByRole("option", { name: /^notes\.txt/ }).click();
  await page.keyboard.press("F5");
  await copySetup.getByRole("button", { name: "Choose a file destination", exact: true }).waitFor();
  await destination.fill(join(temp, "t"));
  await destinationSuggestions.getByRole("option", { name: "to", exact: true }).waitFor();
  await destination.press("Tab");
  assert.equal(await destination.inputValue(), dst + "\\");
  await destinationSuggestions.getByRole("option", { name: "overlap", exact: true }).waitFor();
  await destination.press("Escape");
  assert.equal(await destinationSuggestions.count(), 0);
  assert.equal(await copySetup.isVisible(), true);
  await destination.fill(join(src, "sec"));
  await destinationSuggestions.getByRole("option", { name: "second.txt", exact: true }).click();
  assert.equal(await destination.inputValue(), join(src, "second.txt"));
  await copySetup.getByRole("button", { name: "Cancel", exact: true }).click();
  await filePane.getByRole("option", { name: /^measured/ }).click();
  await page.keyboard.press("F5");
  await copySetup.getByRole("button", { name: "Browse for a folder", exact: true }).waitFor();
  await copySetup.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("listbox", { name: "left files", exact: true }).focus();
  await page.keyboard.press("Alt+F7");
  const search = page.getByRole("dialog", { name: "Find files", exact: true });
  const mask = search.getByRole("textbox", { name: "File mask", exact: true });
  await mask.fill("*.missing");
  await mask.press("Enter");
  await search.getByText("No matching files.", { exact: true }).waitFor();
  await mask.fill("DATA.B?N");
  await search.getByRole("button", { name: "Search", exact: true }).click();
  await search.getByText("2 matches.", { exact: true }).waitFor();
  const matches = search.getByRole("listbox", { name: "Search results", exact: true });
  await matches.getByRole("option", { name: "overlap/data.bin", exact: true }).waitFor();
  await matches.selectOption("measured/data.bin");
  if (process.env.DIRLUME_SEARCH_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_SEARCH_SCREENSHOT, scale: "css" });
  await search.getByRole("button", { name: "Show in panel", exact: true }).click();
  const leftPane = page.getByRole("region", { name: "left pane", exact: true });
  const left = leftPane.getByRole("listbox", { name: "left files", exact: true });
  const right = page.getByRole("listbox", { name: "right files", exact: true });
  await leftPane.getByRole("heading", { name: "Search results", exact: true }).waitFor();
  assert.equal(await left.locator(parentRow).count(), 0);
  await left.getByRole("option", { name: /measured\/data\.bin/, selected: true }).waitFor();
  await left.getByRole("option", { name: /overlap\/data\.bin/ }).waitFor();
  await page.keyboard.press("F5");
  await finishTransfer("Copy");
  assert.deepEqual(await readFile(join(dst, "data.bin")), Buffer.alloc(12));
  await leftPane.getByRole("button", { name: "Go to selected file", exact: true }).click();
  await page.getByRole("heading", { name: "measured", exact: true }).waitFor();
  await page.getByRole("option", { name: /^data.bin/, selected: true }).waitFor();
  const bulk = join(temp, "bulk");
  await mkdir(bulk);
  for (let start = 0; start < 10_000; start += 100) {
    await Promise.all(Array.from({ length: 100 }, (_, offset) => {
      const index = start + offset;
      const name = index < 1005 ? `file-${index}.tmp` : `unmatched-${index}.dat`;
      return writeFile(join(bulk, name), "");
    }));
  }
  const openBulk = performance.now();
  await navigate("left", bulk);
  await left.getByRole("option", { name: /^file-0.tmp/ }).waitFor();
  const mountedRows = await left.getByRole("option").count();
  assert.ok(mountedRows < 100, `Mounted ${mountedRows} rows for 10,000 entries.`);
  await left.focus();
  await left.press("ArrowRight");
  const tail = left.getByRole("option", { name: /^unmatched-9999.dat/, selected: true });
  await tail.waitFor();
  assert.equal(await tail.getAttribute("aria-posinset"), "10001");
  assert.equal(await left.getAttribute("aria-activedescendant"), await tail.getAttribute("id"));
  await left.evaluate((list) => { list.scrollTop = list.scrollHeight / 2; });
  await left.getByRole("option", { name: /^unmatched-5000.dat/ }).waitFor();
  assert.ok(await left.getByRole("option").count() < 100);
  assert.equal(await left.getAttribute("aria-activedescendant"), await tail.getAttribute("id"));
  await left.press("ArrowLeft");
  await left.getByRole("option", { name: /^\.\./, selected: true }).waitFor();
  console.log(`Mounted ${mountedRows} rows for 10,000 files in ${Math.round(performance.now() - openBulk)} ms including keyboard jumps and scrolling.`);
  await page.keyboard.press("Alt+F7");
  await mask.fill("*.tmp");
  await mask.press("Enter");
  await search.getByText(/1,005 matches/).waitFor();
  await search.getByRole("button", { name: "Show in panel", exact: true }).click();
  await leftPane.getByText("1,005 matches", { exact: true }).waitFor();
  await left.focus();
  await page.keyboard.press("ArrowRight");
  await left.getByRole("option", { name: /^file-1004.tmp/, selected: true }).waitFor();
  await page.keyboard.press("Shift+ArrowUp");
  await left.getByRole("option", { name: /^file-1003.tmp/, selected: true }).waitFor();
  assert.equal(await left.getByRole("option", { selected: true }).count(), 2);
  await page.keyboard.press("Shift+ArrowDown");
  await left.getByRole("option", { name: /^file-1004.tmp/, selected: true }).waitFor();
  assert.equal(await left.getByRole("option", { selected: true }).count(), 1);
  assert.ok(await left.getByRole("option").count() < 100);
  await leftPane.getByRole("button", { name: "Close search results" }).click();
  await leftPane.getByRole("heading", { name: "bulk" }).waitFor();
  await navigate("left", src);
  await left.getByRole("option", { name: /^sample-app\.exe/ }).locator(".native-file-icon").waitFor();
  await left.getByRole("option", { name: /^notes.txt/ }).click({ modifiers: ["Control"] });
  await left.getByRole("option", { name: /^second.txt/ }).click({ modifiers: ["Control"] });
  assert.equal(await left.getByRole("option", { selected: true }).count(), 2);
  const guideRow = left.getByRole("option", { name: /^guide.md/ });
  await guideRow.click();
  assert.equal(await guideRow.getAttribute("aria-selected"), "true");
  assert.equal(await left.getByRole("option", { selected: true }).count(), 1);
  const orderedRows = await left.locator(".file-row").evaluateAll((rows) => rows.map((row) => row.title));
  const guideIndex = orderedRows.indexOf("guide.md");
  const nextAfterGuide = orderedRows[guideIndex + 1];
  const markedRows = () => left.locator(".file-row.marked").evaluateAll((rows) => rows.map((row) => row.title));
  assert.ok(guideIndex > 1 && guideIndex + 2 < orderedRows.length);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  assert.deepEqual(await markedRows(), orderedRows.slice(guideIndex, guideIndex + 3));
  await page.keyboard.press("Shift+ArrowUp");
  assert.deepEqual(await markedRows(), ["guide.md", nextAfterGuide]);
  await page.keyboard.press("Shift+ArrowUp");
  assert.deepEqual(await markedRows(), ["guide.md"]);
  await page.keyboard.press("Shift+ArrowUp");
  assert.deepEqual(await markedRows(), orderedRows.slice(guideIndex - 1, guideIndex + 1));

  const distantRow = left.getByRole("option", { name: /^second.txt/ });
  await distantRow.click();
  await distantRow.click({ modifiers: ["Control"] });
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  assert.deepEqual(await markedRows(), [...orderedRows.slice(1, 3), "second.txt"]);
  await page.keyboard.press("Shift+ArrowUp");
  assert.deepEqual(await markedRows(), [orderedRows[1], "second.txt"]);

  await guideRow.click();
  await left.locator(".file-row").nth(guideIndex + 1).click({ modifiers: ["Control"] });
  await guideRow.click({ modifiers: ["Control"] });
  assert.deepEqual(await markedRows(), ["guide.md", nextAfterGuide]);
  await page.keyboard.press("Shift+ArrowDown");
  assert.deepEqual(await markedRows(), []);
  await page.keyboard.press("Shift+ArrowUp");
  assert.deepEqual(await markedRows(), [nextAfterGuide]);
  await guideRow.click();
  const dragFile = left.getByRole("option", { name: /^drag-file.txt/ });
  await dragFile.click({ modifiers: ["Control"] });
  await left.getByRole("option", { name: /^drag-folder/ }).click({ modifiers: ["Control"] });
  await dragFile.dragTo(right);
  const dragDialog = page.getByRole("dialog", { name: "Copy", exact: true });
  await dragDialog.getByText("2 selected items", { exact: true }).waitFor();
  await dragDialog.getByLabel("Move instead of copying").check();
  await finishTransfer("Move", 2);
  assert.equal(await readFile(join(dst, "drag-file.txt"), "utf8"), "Dragged file");
  assert.equal(await readFile(join(dst, "drag-folder", "child.txt"), "utf8"), "Dragged folder");
  await assert.rejects(readFile(join(src, "drag-file.txt")), { code: "ENOENT" });
  await page.getByRole("option", { name: /^measured/ }).click();
  await page.keyboard.press("F3");
  await page.getByRole("option", { name: /^measured/ }).getByText("12 B", { exact: true }).waitFor();
  const sizeFixture = join(temp, "size-refresh");
  const measuredPath = join(sizeFixture, "measured-item");
  await mkdir(measuredPath, { recursive: true });
  const measuredData = join(measuredPath, "initial.txt");
  await writeFile(measuredData, Buffer.alloc(2048));
  await writeFile(join(sizeFixture, "other.txt"), Buffer.alloc(16));
  await navigate("left", sizeFixture);
  const measuredItem = left.getByRole("option", { name: /^measured-item/ });
  await measuredItem.click();
  await page.keyboard.press("F3");
  await measuredItem.getByText("2 KiB", { exact: true }).waitFor();
  await writeFile(measuredData, Buffer.alloc(64));
  const refreshSizeFixture = leftPane.getByRole("button", { name: "Refresh folder", exact: true });
  await refreshSizeFixture.click();
  await measuredItem.getByText("2 KiB", { exact: true }).waitFor({ state: "hidden" });
  await measuredItem.click();
  await page.keyboard.press("F3");
  await measuredItem.getByText("64 B", { exact: true }).waitFor();
  await rm(measuredData);
  await rmdir(measuredPath);
  await writeFile(measuredPath, "x");
  await refreshSizeFixture.click();
  await measuredItem.getByText("1 B", { exact: true }).waitFor();
  const sizeSort = leftPane.getByRole("button", { name: /^Size\b/ });
  await sizeSort.click();
  assert.deepEqual(await left.getByRole("option").evaluateAll((rows) => rows.map((row) => row.title)),
    ["..", "measured-item", "other.txt"]);
  await leftPane.getByRole("button", { name: /^Name\b/ }).click();
  await navigate("left", src);
  await page.getByRole("option", { name: /^notes.txt/ }).click();
  await page.keyboard.press("Insert");
  await left.getByRole("option", { name: /^second.txt/ }).click({ modifiers: ["Control"] });
  await page.getByRole("combobox", { name: "Command line" }).press("F5");
  await finishTransfer("Copy", 2);
  await page.getByRole("listbox", { name: "right files", exact: true }).getByRole("option", { name: /^notes.txt/ }).waitFor();
  assert.equal(await readFile(join(dst, "notes.txt"), "utf8"), "Dirlume\n");
  assert.equal(await readFile(join(dst, "second.txt"), "utf8"), "Second file\n");
  await left.getByRole("option", { name: /^notes.txt/ }).click({ modifiers: ["Control"] });
  await left.getByRole("option", { name: /^second.txt/ }).click({ modifiers: ["Control"] });
  await writeFile(join(dst, "notes.txt"), "Previous version\n");
  await left.getByRole("option", { name: /^notes.txt/ }).click();
  await page.keyboard.press("F5");
  await startTransfer("Copy");
  const conflict = page.getByRole("dialog", { name: "File already exists" });
  await conflict.waitFor();
  assert.equal(await readFile(join(dst, "notes.txt"), "utf8"), "Previous version\n");
  await conflict.getByRole("button", { name: "Overwrite" }).click();
  await page.getByRole("dialog", { name: "Transfer complete" }).getByRole("button", { name: "Done" }).click();
  assert.equal(await readFile(join(dst, "notes.txt"), "utf8"), "Dirlume\n");
  const folderConflict = page.getByRole("dialog", { name: "Folder already exists" });
  await navigate("left", src);
  await left.getByRole("option", { name: /^overlap/ }).click();
  await page.keyboard.press("F5");
  await startTransfer("Copy");
  await folderConflict.getByRole("button", { name: "Merge", exact: true }).click();
  await conflict.getByText("Incoming", { exact: true }).waitFor();
  await conflict.getByText("2 B", { exact: true }).waitFor();
  assert.equal(await conflict.getByRole("button", { name: "Skip", exact: true }).evaluate((button) => document.activeElement === button), true);
  if (process.env.DIRLUME_CONFLICT_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_CONFLICT_SCREENSHOT, scale: "css" });
  await conflict.getByLabel("Remember choice").check();
  await conflict.getByRole("button", { name: "Overwrite", exact: true }).click();
  await page.getByRole("dialog", { name: "Transfer complete" }).getByRole("button", { name: "Done" }).click();
  assert.deepEqual(await readFile(join(dst, "overlap", "data.bin")), Buffer.alloc(12));
  assert.deepEqual(await readFile(join(dst, "overlap", "other.bin")), Buffer.alloc(13, 7));
  await writeFile(join(src, "outside-change.txt"), "watch me");
  await writeFile(join(dst, "outside-right.txt"), "watch both panes");
  await left.getByRole("option", { name: /^outside-change.txt/ }).waitFor();
  await right.getByRole("option", { name: /^outside-right.txt/ }).waitFor();

  await guideRow.click({ modifiers: ["Control"] });
  await page.keyboard.press("Alt+S");
  const quick = leftPane.getByRole("textbox", { name: "Quick search", exact: true });
  assert.equal((await quick.inputValue()).toLowerCase(), "s");
  await quick.fill("sec");
  const secondRow = left.getByRole("option", { name: /^second.txt/ });
  await page.waitForFunction(() => document.querySelector("#left-files [data-current=true]")?.getAttribute("title") === "second.txt");
  if (process.env.DIRLUME_QUICK_SEARCH_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_QUICK_SEARCH_SCREENSHOT, scale: "css" });
  await quick.fill("nosuchfile");
  await leftPane.getByText("No match", { exact: true }).waitFor();
  await quick.press("Escape");
  await quick.waitFor({ state: "hidden" });
  assert.equal(await secondRow.getAttribute("data-current"), "true");
  assert.match(await guideRow.getAttribute("class"), /marked/);
  await secondRow.click();

  await leftAddress.press("Alt+Control+S");
  const optionsDialog = page.getByRole("dialog", { name: "Options", exact: true });
  const optionsContent = optionsDialog.locator(".settings-page-body");
  const searchSettings = optionsDialog.getByRole("searchbox", { name: "Search settings", exact: true });
  await optionsDialog.getByRole("button", { name: "General", exact: true }).click();
  const provider = optionsDialog.getByLabel("Remote connection");
  await provider.selectOption("kswitcher");
  const bridgePath = optionsDialog.getByRole("combobox", { name: "KSwitcher installation folder", exact: true });
  await optionsDialog.getByRole("button", { name: "Browse for a folder", exact: true }).waitFor();
  await bridgePath.fill(join(src, "me"));
  await optionsDialog.getByRole("listbox", { name: "KSwitcher installation folder suggestions", exact: true })
    .getByRole("option", { name: "measured", exact: true }).click();
  assert.equal(await bridgePath.inputValue(), join(src, "measured"));
  await provider.selectOption("server");
  const sizeBefore = await optionsDialog.boundingBox();
  const grip = await optionsDialog.getByRole("button", { name: "Resize Options" }).boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 55, grip.y + grip.height / 2 - 40, { steps: 5 });
  await page.mouse.up();
  const shrunkSize = await optionsDialog.boundingBox();
  assert.ok(shrunkSize.width < sizeBefore.width - 40);
  assert.ok(shrunkSize.height < sizeBefore.height - 30);
  for (const [edge, dx, dy] of [["e", 28, 0], ["n", 0, -20]]) {
    const handle = await optionsDialog.locator('[data-resize-edge="' + edge + '"]').boundingBox();
    const x = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("data-resize-edge"), { x, y }), edge);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 5 });
    await page.mouse.up();
  }
  const sizeAfter = await optionsDialog.boundingBox();
  assert.ok(sizeAfter.width > shrunkSize.width + 40, "Dragging the right edge should increase the Options width.");
  assert.ok(sizeAfter.height > shrunkSize.height + 30, "Dragging the top edge should increase the Options height from " +
    shrunkSize.height + " to " + sizeAfter.height + ".");
  await page.keyboard.press("Escape");
  await optionsDialog.waitFor({ state: "hidden" });
  await leftAddress.dispatchEvent("keydown", { key: "і", code: "KeyS", ctrlKey: true, altKey: true });
  assert.deepEqual(await optionsDialog.boundingBox(), sizeAfter);
  const resizeGrip = optionsDialog.getByRole("button", { name: "Resize Options" });
  await resizeGrip.press("ArrowRight");
  assert.ok((await optionsDialog.boundingBox()).width >= sizeAfter.width + 15);

  await optionsDialog.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  const zoomBinding = optionsDialog.getByLabel("Change shortcut for Font zoom with mouse wheel", { exact: true });
  assert.equal(await zoomBinding.inputValue(), "Ctrl+Wheel");
  await zoomBinding.selectOption("Alt+Wheel");
  await searchSettings.fill("keyboard shortcuts");
  const shortcutScroll = await optionsContent.evaluate((content) => { content.scrollTop = 180; return content.scrollTop; });
  assert.ok(shortcutScroll > 0);
  await optionsDialog.getByRole("button", { name: "Done", exact: true }).click();
  await wheelFont("#left-files", -120);
  assert.equal(await fontSize("#left-pane"), leftFont);
  await wheelFont("#left-files", -120, "Alt");
  assert.ok(await fontSize("#left-pane") > leftFont);
  await wheelFont("#left-files", 120, "Alt");
  await leftAddress.press("Alt+Control+S");
  assert.equal(await optionsDialog.getByRole("button", { name: "Keyboard shortcuts", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await searchSettings.inputValue(), "keyboard shortcuts");
  assert.equal(await optionsContent.evaluate((content) => content.scrollTop), shortcutScroll);
  await searchSettings.fill("");
  await zoomBinding.selectOption("Ctrl+Wheel");
  await optionsDialog.getByRole("button", { name: "View font sizes", exact: true }).click();
  for (const [side, size] of [["Left", leftFont], ["Right", rightFont]]) {
    const field = optionsDialog.getByRole("spinbutton", { name: `${side} file pane font size` });
    assert.equal(await field.inputValue(), String(size));
    await field.fill("");
  }
  await optionsDialog.getByRole("button", { name: "Apply", exact: true }).click();

  const panelsSection = optionsDialog.getByRole("button", { name: "Panels", exact: true });
  await panelsSection.click();
  await panelsSection.press("Tab");
  await page.keyboard.press("Shift+Tab");
  if (process.env.DIRLUME_SETTINGS_FOCUS_SCREENSHOT) {
    await page.screenshot({ path: process.env.DIRLUME_SETTINGS_FOCUS_SCREENSHOT, scale: "css" });
  }
  const settingsFocus = await panelsSection.evaluate((button) => {
    const tree = button.closest(".settings-tree");
    const bounds = button.getBoundingClientRect();
    const clip = tree.getBoundingClientRect();
    const style = getComputedStyle(button);
    const outside = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
    const left = clip.left + tree.clientLeft;
    const top = clip.top + tree.clientTop;
    return {
      visible: button.matches(":focus-visible") && style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0,
      fits: bounds.left - outside >= left && bounds.right + outside <= left + tree.clientWidth &&
        bounds.top - outside >= top && bounds.bottom + outside <= top + tree.clientHeight,
    };
  });
  assert.deepEqual(settingsFocus, { visible: true, fits: true }, "The Options tree should show the full keyboard focus outline.");
  await page.getByLabel("Color scheme").selectOption("light");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByRole("dialog", { name: "Options", exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.getByRole("button", { name: "Window", exact: true }).click();
  assert.notEqual(await page.getByLabel("Toolbar and status bar hex").inputValue(), "#000000");
  const swatch = optionsDialog.getByRole("button", { name: "Window background color", exact: true });
  const picker = page.getByRole("dialog", { name: "Window background color", exact: true });
  await swatch.click();
  const spectrum = picker.getByRole("group", { name: /^Saturation and brightness/ });
  await spectrum.click({ position: { x: 120, y: 45 } });
  const hex = picker.getByLabel("HEX", { exact: true });
  const shade = await hex.inputValue();
  await picker.getByRole("slider", { name: "Hue" }).press("End");
  assert.notEqual(await hex.inputValue(), shade);
  await hex.fill("#112233");
  const previewColor = () => optionsDialog.locator(".preview-frame")
    .evaluate((element) => getComputedStyle(element).getPropertyValue("--canvas").trim());
  assert.equal(await previewColor(), "#112233");
  if (process.env.DIRLUME_COLOR_PICKER_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_COLOR_PICKER_SCREENSHOT, scale: "css" });
  await hex.press("Escape");
  await picker.waitFor({ state: "hidden" });
  await optionsDialog.waitFor();
  assert.equal(await page.getByLabel("Color scheme").inputValue(), "light");
  await swatch.click();
  const initialColor = await hex.inputValue();
  await spectrum.click({ position: { x: 120, y: 45 } });
  const chosenColor = await hex.inputValue();
  assert.notEqual(chosenColor, initialColor);
  await picker.getByRole("button", { name: "Use color", exact: true }).click();
  assert.equal(await page.getByLabel("Window background hex").inputValue(), chosenColor);
  await page.getByLabel("Window background hex").fill("#eef3fe");
  await page.getByLabel("Scheme name").fill("Blueprint");
  assert.equal(await page.getByLabel("Window background hex").inputValue(), "#eef3fe");
  await page.getByRole("button", { name: "Panels", exact: true }).click();
  await page.getByLabel("Panel background hex").fill("#ecf9f5");
  await page.getByRole("button", { name: "Dialogs", exact: true }).click();
  await page.getByLabel("Dialog background hex").fill("#f5f9fe");
  const sourceName = left.getByRole("option", { name: /^sample\.rs/ }).locator(".file-name");
  const textName = left.getByRole("option", { name: /^guide\.md/ }).locator(".file-name");
  const foreground = (element) => element.evaluate((name) => getComputedStyle(name).color);
  assert.notEqual(await foreground(sourceName), await foreground(textName));
  await searchSettings.fill("office documents");
  await searchSettings.press("Enter");
  await page.getByRole("heading", { name: "File types", exact: true }).waitFor();
  await page.getByLabel("Source code hex").fill("#7c2144");
  const exampleSource = page.getByRole("region", { name: "Settings preview" }).getByText("main.rs", { exact: true });
  assert.equal(await foreground(exampleSource), "rgb(124, 33, 68)");
  assert.notEqual(await foreground(sourceName), "rgb(124, 33, 68)");
  const attributeColors = { hidden: "rgb(65, 83, 109)", system: "rgb(115, 18, 76)" };
  const preview = optionsDialog.getByRole("region", { name: "Settings preview" });
  await optionsDialog.getByLabel("Hidden files and folders hex", { exact: true }).fill("#41536d");
  await optionsDialog.getByLabel("System files and folders hex", { exact: true }).fill("#73124c");
  assert.equal(await foreground(preview.getByText(".env", { exact: true })), attributeColors.hidden);
  assert.equal(await foreground(preview.getByText("System Volume Information", { exact: true })), attributeColors.system);
  await searchSettings.fill("");
  await page.getByRole("button", { name: "Fonts", exact: true }).click();
  const panelFont = optionsDialog.getByRole("combobox", { name: "File panels font family", exact: true });
  const panelSuggestions = optionsDialog.getByRole("listbox", { name: "File panels font suggestions", exact: true });
  await optionsDialog.getByRole("button", { name: "Browse installed fonts for file panels", exact: true }).click();
  await panelSuggestions.getByRole("option").first().waitFor();
  await panelFont.press("Escape");
  await panelSuggestions.waitFor({ state: "hidden" });
  await optionsDialog.waitFor();
  assert.equal(await page.getByRole("button", { name: "Fonts", exact: true }).getAttribute("aria-pressed"), "true");
  await panelFont.fill("GoMono Nerd");
  await panelSuggestions.getByRole("option", { name: bundledFamily, exact: true }).click();
  assert.equal(await panelFont.inputValue(), bundledFamily);
  await optionsDialog.getByLabel("File panels font size").fill("20");
  await optionsDialog.getByRole("button", { name: "Reset file panels font", exact: true }).click();
  assert.equal(await panelFont.inputValue(), "");
  assert.equal(await optionsDialog.locator(".preview-frame").evaluate((element) =>
    getComputedStyle(element).getPropertyValue("--panel-size")), "18px");
  await panelFont.fill("aRiAl");
  const arial = panelSuggestions.getByRole("option", { name: "Arial", exact: true });
  await arial.waitFor();
  assert.equal(await page.getByRole("dialog").count(), 1, "Font suggestions should appear inside Options.");
  assert.ok((await panelSuggestions.getByRole("option").allTextContents()).every((family) => /arial/i.test(family)));
  await panelFont.press("ArrowDown");
  assert.equal(await arial.getAttribute("aria-selected"), "true");
  await panelFont.press("Enter");
  assert.equal(await panelFont.inputValue(), "Arial");
  await panelSuggestions.waitFor({ state: "hidden" });
  await page.getByLabel("File panels font size").fill("17");
  assert.notEqual(await page.locator("#left-pane").evaluate((pane) => getComputedStyle(pane).fontSize), "17px");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByRole("button", { name: "Apply", exact: true }).isDisabled().then((disabled) => assert.equal(disabled, true));
  assert.equal(await page.getByRole("button", { name: "Fonts", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor), "rgb(238, 243, 254)");
  assert.equal(await page.locator("#left-pane").evaluate((pane) => getComputedStyle(pane).backgroundColor), "rgb(236, 249, 245)");
  assert.equal(await page.locator("#left-pane").evaluate((pane) => getComputedStyle(pane).fontSize), "17px");
  assert.equal(await page.getByRole("dialog", { name: "Options" }).evaluate((dialog) => getComputedStyle(dialog).backgroundColor), "rgb(245, 249, 254)");
  assert.equal(await foreground(sourceName), "rgb(124, 33, 68)");
  assert.notEqual(await foreground(textName), "rgb(124, 33, 68)");
  if (process.env.DIRLUME_APPEARANCE_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_APPEARANCE_SCREENSHOT, scale: "css" });
  const fontScroll = await optionsContent.evaluate((content) => { content.scrollTop = 120; return content.scrollTop; });
  assert.ok(fontScroll > 0);
  await page.getByLabel("File panels font size").fill("19");
  await optionsContent.evaluate((content, position) => { content.scrollTop = position; }, fontScroll);
  for (const closeWith of ["button", "Escape"]) {
    if (closeWith === "button") await optionsDialog.getByRole("button", { name: "Close dialog", exact: true }).click();
    else await page.keyboard.press("Escape");
    await optionsDialog.waitFor({ state: "hidden" });
    await leftAddress.press("Alt+Control+S");
    assert.equal(await optionsDialog.getByRole("button", { name: "Fonts", exact: true }).getAttribute("aria-pressed"), "true");
    assert.equal(await optionsContent.evaluate((content) => content.scrollTop), fontScroll);
    assert.equal(await page.getByLabel("File panels font size").inputValue(), "17");
  }
  await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  await page.getByRole("button", { name: "Change shortcut for New folder" }).click();
  await page.getByRole("textbox", { name: "New shortcut for New folder" }).press("F5");
  await page.getByText("F5 is assigned to Copy.", { exact: true }).waitFor();
  await page.getByRole("textbox", { name: "New shortcut for New folder" }).press("F12");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await navigate("left", attributes);
  const attributeRow = (name) => left.locator(`.file-row[title="${name}"]`);
  const attributeName = (name) => attributeRow(name).locator(".file-name");
  assert.equal(await attributeRow("hidden.rs").count(), 0);
  assert.equal(await attributeRow("system-hidden.dll").count(), 0);
  assert.equal(await foreground(attributeName("system-folder")), attributeColors.system);
  assert.notEqual(await foreground(attributeName("ordinary.sys")), attributeColors.system);
  await left.press("Control+h");
  assert.equal(await foreground(attributeName(".metadata")), attributeColors.hidden);
  assert.equal(await foreground(attributeName("hidden.rs")), attributeColors.hidden);
  assert.equal(await foreground(attributeName("system-hidden.dll")), attributeColors.system);
  await attributeRow("system-hidden.dll").click();
  assert.equal(await foreground(attributeName("system-hidden.dll")), attributeColors.system);
  await attributeRow("system-hidden.dll").click({ modifiers: ["Control"] });
  assert.match(await attributeRow("system-hidden.dll").getAttribute("class"), /marked/);
  assert.equal(await foreground(attributeName("system-hidden.dll")), attributeColors.system);
  if (process.env.DIRLUME_ATTRIBUTES_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_ATTRIBUTES_SCREENSHOT, scale: "css" });
  await left.press("Control+h");
  const properties = page.getByRole("dialog", { name: "Attributes", exact: true });
  const flag = (name) => properties.getByRole("checkbox", { name, exact: true });
  const applyAttributes = () => properties.getByRole("button", { name: "Apply", exact: true }).click();
  const cancelAttributes = () => properties.getByRole("button", { name: "Cancel", exact: true }).click();
  await leftAddress.press("Control+a");
  assert.equal(await leftAddress.evaluate((field) => field.selectionEnd - field.selectionStart), attributes.length);
  assert.equal(await properties.count(), 0);
  await attributeRow("ordinary.sys").click();
  await left.press("Control+a");
  await properties.getByText("ordinary.sys", { exact: true }).waitFor();
  await flag("System attribute").waitFor();
  assert.equal(await flag("System attribute").isChecked(), false);
  assert.equal(await flag("Compressed").isDisabled(), true);
  assert.equal(await flag("Encrypted").isDisabled(), true);
  assert.ok(await properties.getByText("Owner", { exact: true }).isVisible());
  await flag("System attribute").check();
  await cancelAttributes();
  assert.notEqual(await foreground(attributeName("ordinary.sys")), attributeColors.system);
  await left.press("Control+a");
  await flag("System attribute").check();
  await flag("Read-only").check();
  await applyAttributes();
  await properties.getByText("Attributes saved.", { exact: true }).waitFor();
  assert.equal(await flag("Read-only").isChecked(), true);
  await page.waitForFunction((expected) =>
    getComputedStyle(document.querySelector('#left-files [title="ordinary.sys"] .file-name')).color === expected, attributeColors.system);
  await flag("Read-only").uncheck();
  await flag("System attribute").uncheck();
  await applyAttributes();
  await properties.getByText("Attributes saved.", { exact: true }).waitFor();
  await cancelAttributes();
  await navigate("right", attributes);
  const rightSystemFolder = right.locator('.file-row[title="system-folder"]');
  await rightSystemFolder.click();
  await right.press("Control+a");
  await properties.getByText("system-folder", { exact: true }).waitFor();
  await flag("Hidden").check();
  assert.equal(await flag("Read-only").isDisabled(), true);
  await applyAttributes();
  await properties.getByText("Attributes saved.", { exact: true }).waitFor();
  await rightSystemFolder.waitFor({ state: "detached" });
  await flag("Hidden").uncheck();
  await applyAttributes();
  await properties.getByText("Attributes saved.", { exact: true }).waitFor();
  await cancelAttributes();
  await rightSystemFolder.waitFor();
  await navigate("right", dst);
  console.log("Verified file and folder attributes, cancel, pane refresh, and text selection.");
  await navigate("left", src);
  await page.getByRole("listbox", { name: "right files", exact: true }).focus();
  await page.keyboard.press("F12");
  await page.getByRole("dialog", { name: "New folder" }).getByLabel("Name", { exact: true }).fill("verified");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("option", { name: /^verified/ }).waitFor();

  const encodedFiles = join(temp, "encodings");
  await mkdir(encodedFiles);
  await navigate("left", encodedFiles);
  await testNewFileEncoding(page, encodedFiles);
  await navigate("left", src);
  await left.focus();
  await page.keyboard.press("Shift+F4");
  await page.getByRole("dialog", { name: "New file" }).getByLabel("Name").fill("draft.md");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("textbox", { name: "Edit draft.md" }).fill("# Draft");
  await page.keyboard.press("F2");
  const editor = page.getByRole("region", { name: "draft.md", exact: true });
  await editor.getByRole("button", { name: "Save", exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector(".text-window:not([hidden]) .footer-message")?.textContent === "UTF8");
  await page.keyboard.press("F10");
  await editor.waitFor({ state: "hidden" });
  assert.equal(await readFile(join(src, "draft.md"), "utf8"), "# Draft");
  await left.getByRole("option", { name: /^draft.md/ }).click();
  await page.keyboard.press("F6");
  await finishTransfer("Move");
  await assert.rejects(readFile(join(src, "draft.md")), { code: "ENOENT" });
  const draft = page.getByRole("listbox", { name: "right files" }).getByRole("option", { name: /^draft.md/ });
  await draft.click();
  await page.keyboard.press("F8");
  const trashDialog = page.getByRole("dialog", { name: "Move to Trash" });
  await trashDialog.getByRole("button", { name: "Cancel" }).click();
  await trashDialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.getElementById("right-files")?.getAttribute("aria-busy") === "false");
  await draft.click();
  await page.keyboard.press("Shift+Delete");
  const deleteDialog = page.getByRole("dialog", { name: "Delete permanently" });
  assert.equal(await deleteDialog.getByRole("button", { name: "Cancel" }).evaluate((button) => document.activeElement === button), true);
  await deleteDialog.getByRole("button", { name: "Delete permanently" }).click();
  await draft.waitFor({ state: "detached" });

  const lockedPath = join(src, "locked-by-process.txt");
  await writeFile(lockedPath, "Temporary test file.");
  lockedBy = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `$file = [IO.File]::Open('${lockedPath.replaceAll("'", "''")}', 'Open', 'Read', 'None'); Write-Output LOCKED; Start-Sleep 60`],
  { windowsHide: true });
  await new Promise((complete, reject) => {
    lockedBy.once("error", reject);
    lockedBy.once("exit", () => reject(new Error("The test process exited before locking the file.")));
    lockedBy.stdout.on("data", (chunk) => { if (chunk.toString().includes("LOCKED")) complete(); });
  });
  await left.focus();
  await page.keyboard.press("Alt+F1");
  await leftPane.getByRole("button", { name: "Processes", exact: true }).click();
  const taskList = leftPane.getByRole("grid", { name: "Running processes" });
  const pidHeader = taskList.getByRole("columnheader", { name: "PID" });
  await pidHeader.getByRole("button").click();
  assert.equal(await pidHeader.getAttribute("aria-sort"), "ascending");
  const pids = await taskList.locator("tbody tr td:nth-child(2)").allTextContents();
  assert.deepEqual(pids.map(Number), pids.map(Number).sort((a, b) => a - b));
  await pidHeader.getByRole("button").click();
  assert.equal(await pidHeader.getAttribute("aria-sort"), "descending");
  await leftPane.getByRole("searchbox", { name: "Find process" }).fill(String(lockedBy.pid));
  const task = taskList.getByRole("row").filter({ has: page.getByRole("gridcell", { name: String(lockedBy.pid), exact: true }) });
  await task.locator(".process-icon").waitFor();
  await task.click();
  await page.keyboard.press("F8");
  const endProcesses = page.getByRole("dialog", { name: "End processes", exact: true });
  await endProcesses.getByText(new RegExp(`PID ${lockedBy.pid}\\)`)).waitFor();
  await endProcesses.getByRole("button", { name: "Cancel", exact: true }).click();
  if (process.env.DIRLUME_PROCESSES_SCREENSHOT) {
    await leftPane.getByRole("searchbox", { name: "Find process" }).fill("");
    await page.screenshot({ path: process.env.DIRLUME_PROCESSES_SCREENSHOT, scale: "css" });
  }
  await leftPane.getByRole("button", { name: "Close processes" }).click();
  await left.getByRole("option", { name: /^locked-by-process.txt/ }).click();
  await page.keyboard.press("Shift+Delete");
  await deleteDialog.getByRole("button", { name: "Delete permanently", exact: true }).click();
  await deleteDialog.getByRole("button", { name: "Find locking processes", exact: true }).click();
  const lockDialog = page.getByRole("dialog", { name: "Processes using these files", exact: true });
  await lockDialog.getByRole("option", { name: new RegExp(`PID ${lockedBy.pid}\\)`) }).waitFor();
  await lockDialog.getByRole("button", { name: "Select all", exact: true }).click();
  await lockDialog.getByRole("button", { name: "End selected", exact: true }).click();
  await endProcesses.getByRole("button", { name: "End process", exact: true }).click();
  await lockDialog.getByText("Windows found no processes using these files.").waitFor();
  await lockDialog.getByRole("button", { name: "Close", exact: true }).click();
  await deleteDialog.getByRole("button", { name: "Delete permanently", exact: true }).click();
  await left.getByRole("option", { name: /^locked-by-process.txt/ }).waitFor({ state: "detached" });

  if (process.env.DIRLUME_CROSS_VOLUME_TEST_ROOT) {
    const root = resolve(process.env.DIRLUME_CROSS_VOLUME_TEST_ROOT);
    assert.notEqual(root.slice(0, 2).toLowerCase(), src.slice(0, 2).toLowerCase());
    otherVolume = await mkdtemp(join(root, "dirlume-f6-"));
    assert.equal(dirname(otherVolume), root);
    await navigate("right", otherVolume);
    await navigate("left", src);
    await left.getByRole("option", { name: /^volume.txt/ }).click();
    await page.keyboard.press("F6");
    await finishTransfer("Move", 1, otherVolume);
    await assert.rejects(readFile(join(src, "volume.txt")), { code: "ENOENT" });
    assert.equal(await readFile(join(otherVolume, "volume.txt"), "utf8"), "Cross-volume move");

    await mkdir(join(otherVolume, "merge"));
    await writeFile(join(otherVolume, "merge", "update.txt"), "Old contents");
    await writeFile(join(otherVolume, "merge", "keep.txt"), "Destination-only file");
    await navigate("left", src);
    const mergeRow = left.getByRole("option", { name: /^merge/ });
    await mergeRow.click();
    await page.keyboard.press("F6");
    await startTransfer("Move", otherVolume);
    await folderConflict.getByRole("button", { name: "Merge", exact: true }).click();
    await conflict.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("dialog", { name: "Transfer canceled" }).getByRole("button", { name: "Done" }).click();
    assert.equal(await readFile(join(src, "merge", "update.txt"), "utf8"), "New contents");
    assert.equal(await readFile(join(otherVolume, "merge", "update.txt"), "utf8"), "Old contents");
    await mergeRow.click();
    await page.keyboard.press("F6");
    await startTransfer("Move", otherVolume);
    await folderConflict.getByRole("button", { name: "Merge", exact: true }).click();
    await conflict.getByRole("button", { name: "Overwrite", exact: true }).click();
    const completed = page.getByRole("dialog", { name: "Transfer complete" });
    await completed.getByText("1 completed.", { exact: true }).waitFor();
    await completed.getByRole("button", { name: "Done" }).click();
    await assert.rejects(readFile(join(src, "merge", "update.txt")), { code: "ENOENT" });
    assert.equal(await readFile(join(otherVolume, "merge", "update.txt"), "utf8"), "New contents");
    assert.equal(await readFile(join(otherVolume, "merge", "keep.txt"), "utf8"), "Destination-only file");
    await navigate("right", dst);
    console.log("Verified F6 between Windows volumes, including cancellation and a folder merge.");
  }

  const linkedMarkdownFont = await testMarkdown(page, src, wheelFont);
  await page.getByRole("option", { name: /^guide.md/ }).click();
  await page.keyboard.press("F3");
  await page.getByRole("heading", { name: "Getting started" }).waitFor();
  const diagram = page.getByRole("img", { name: "Mermaid diagram" });
  await diagram.waitFor();
  assert.ok(await diagram.evaluate((image) => image.complete && image.naturalWidth > 0));
  const markdownSurface = ".text-window:not([hidden]) .markdown";
  assert.equal(await fontSize(markdownSurface), linkedMarkdownFont, "Unrelated Markdown files should open with the same saved preview size.");
  await page.keyboard.press("Control+Alt+S");
  await optionsDialog.getByRole("button", { name: "Fonts", exact: true }).click();
  const textFontFamily = optionsDialog.getByLabel("Editor, viewer, and terminal font family");
  const textFontSize = optionsDialog.getByLabel("Editor, viewer, and terminal font size");
  const markdownFamily = () => page.locator(markdownSurface).evaluate((surface) => getComputedStyle(surface).fontFamily);
  await textFontFamily.fill("ari");
  await optionsDialog.getByRole("listbox", { name: "Editor, viewer, and terminal font suggestions", exact: true })
    .getByRole("option", { name: "Arial", exact: true }).click();
  assert.equal(await textFontFamily.inputValue(), "Arial");
  await textFontSize.fill("18");
  await optionsDialog.getByRole("button", { name: "Apply", exact: true }).click();
  assert.equal(await fontSize(markdownSurface), 18, "Apply should update an open Markdown preview with saved wheel zoom.");
  assert.match(await markdownFamily(), /^Arial,/);
  await textFontFamily.fill("Georgia");
  await textFontSize.fill("16");
  await optionsDialog.getByRole("button", { name: "Done", exact: true }).click();
  assert.match(await markdownFamily(), /^Georgia,/);
  assert.equal(await fontSize(markdownSurface), 16, "Done should update the open Markdown preview without reopening the file.");
  await page.keyboard.press("Control+Alt+S");
  await optionsDialog.getByRole("button", { name: "Reset editor, viewer, and terminal font", exact: true }).click();
  await optionsDialog.getByRole("button", { name: "Done", exact: true }).click();
  const markdownFont = await fontSize(markdownSurface);
  await wheelFont(markdownSurface, -120);
  const enlargedMarkdown = await fontSize(markdownSurface);
  assert.ok(enlargedMarkdown > markdownFont, "Ctrl+Wheel should enlarge Markdown preview text.");
  if (process.env.DIRLUME_DOCUMENT_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_DOCUMENT_SCREENSHOT, scale: "css" });
  await page.keyboard.press("Control+Tab");
  await left.getByRole("option", { name: /^sample.rs/ }).click();
  await page.keyboard.press("F4");
  const sourceEditor = page.getByRole("textbox", { name: "Edit sample.rs" });
  await sourceEditor.locator(".syntax-keyword").first().waitFor();
  const codeSurface = ".text-window:not([hidden]) .cm-scroller";
  const sourceFont = await fontSize(codeSurface);
  await wheelFont(codeSurface, 120);
  assert.ok(await fontSize(codeSurface) < sourceFont, "Ctrl+Wheel should shrink the editor's font.");
  await sourceEditor.fill("fn main() { let retained = true; }");
  await sourceEditor.press("Control+Alt+S");
  await optionsDialog.waitFor();
  await page.keyboard.press("Escape");
  await optionsDialog.waitFor({ state: "hidden" });
  assert.match(await sourceEditor.innerText(), /retained/);
  await page.keyboard.press("Escape");
  const unsaved = page.getByRole("dialog", { name: "Unsaved changes" });
  await unsaved.getByText(/Discard the unsaved changes/).waitFor();
  await unsaved.getByRole("button", { name: "Keep editing" }).click();
  await page.getByRole("navigation", { name: "Open documents" }).getByRole("button", { name: "Files", exact: true }).click();
  await page.keyboard.press("F10");
  await unsaved.getByRole("button", { name: "Keep working", exact: true }).click();
  await page.keyboard.press("Control+Shift+Tab");
  assert.match(await sourceEditor.innerText(), /retained/);
  await page.keyboard.press("Control+Shift+Tab");
  await diagram.waitFor();
  assert.equal(await fontSize(markdownSurface), enlargedMarkdown, "Editor zoom should leave the Markdown preview size alone.");
  await page.keyboard.press("Control+Tab");
  assert.match(await sourceEditor.innerText(), /retained/);
  await page.keyboard.press("F2");
  await page.waitForFunction(() => document.querySelector(".text-window:not([hidden]) .footer-message")?.textContent === "UTF8");
  await page.keyboard.press("Escape");
  await diagram.waitFor();
  await page.keyboard.press("Escape");
  await left.getByRole("option", { name: /^control.bin/ }).click();
  await page.keyboard.press("F3");
  const raw = page.getByLabel("Hexadecimal contents");
  await page.getByRole("alert").getByText(/binary data|utf-8/i).waitFor();
  await raw.waitFor({ state: "hidden" });
  await page.keyboard.press("F4");
  await raw.waitFor();
  assert.match(await raw.innerText(), /EF BB BF 41 00 09 0D 0A FF/);
  const hexSurface = ".text-window:not([hidden]) .hex-view";
  const hexFont = await fontSize(hexSurface);
  await wheelFont(hexSurface, -120);
  const viewerFont = await fontSize(hexSurface);
  assert.ok(viewerFont > hexFont, "Ctrl+Wheel should enlarge the hexadecimal viewer's font.");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await left.getByRole("option", { name: /^sample.rs/ }).click();
  await page.keyboard.press("F3");
  await page.getByText("fn", { exact: true }).first().waitFor();
  assert.equal(await fontSize(codeSurface), viewerFont, "Text and hex should share the viewer setting.");
  await page.keyboard.press("Escape");
  if (process.env.DIRLUME_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_SMOKE_SCREENSHOT, scale: "css" });

  const commandLine = page.getByRole("combobox", { name: "Command line" });
  await commandLine.press("Control+ArrowRight");
  assert.equal(await page.getByRole("separator", { name: "Pane divider" }).getAttribute("aria-valuenow"), "51");
  await commandLine.press("Control+o");
  await left.waitFor({ state: "hidden" });
  await commandLine.press("Control+o");
  await left.waitFor();
  await commandLine.fill("Write-Output ('dirlume-' + 'command-bar-ok')");
  await commandLine.press("Enter");
  await page.waitForFunction(() => document.querySelector(".xterm-accessibility-tree")?.textContent?.includes("dirlume-command-bar-ok"));
  await commandLine.press("Control+e");
  assert.match(await commandLine.inputValue(), /command-bar-ok/);
  await commandLine.fill("");
  const terminalToggle = page.locator(".command-bar").getByRole("button", { name: "Terminal", exact: true });
  await terminalToggle.click();
  await page.getByRole("region", { name: "Terminal" }).waitFor({ state: "hidden" });
  await terminalToggle.click();

  const input = page.locator(".xterm-helper-textarea");
  await input.focus();
  const terminalText = () => page.locator(".terminal-card").innerText();
  await page.waitForFunction(() => document.querySelector(".xterm-accessibility-tree")?.textContent?.includes("PS "));
  await input.pressSequentially("if ((Get-Location).Path.EndsWith('from')) { Write-Output ('dirlume-' + 'terminal-ok') }");
  await input.press("Enter");
  try {
    await page.waitForFunction(() => document.querySelector(".xterm-accessibility-tree")?.textContent?.includes("dirlume-terminal-ok"));
  } catch (error) {
    throw new Error(`No terminal result. ${await terminalText()} ${pageErrors.join(", ")}`, { cause: error });
  }
  const waitForTerminalText = (text) => page.waitForFunction((text) =>
    document.querySelector(".xterm-accessibility-tree")?.textContent?.includes(text), text);
  const waitForDirectory = (path) => page.waitForFunction((path) =>
    document.querySelector(".terminal-card header span")?.textContent?.toLowerCase() === path.toLowerCase(), path);
  const subfolder = join(src, "terminal ' [folder]");
  await mkdir(subfolder);
  await navigate("left", subfolder);
  await waitForDirectory(subfolder);
  assert.ok(await input.count(), "Changing folders should keep the terminal open.");
  await input.pressSequentially("$dirlumeTestSession = 42");
  await input.press("Enter");
  await input.pressSequentially("Write-Output ('dirlume-' + 'busy'); Start-Sleep -Seconds 2; Write-Output ('from:' + (Get-Location).Path)");
  await input.press("Enter");
  await waitForTerminalText("dirlume-busy");
  await right.focus();
  await waitForTerminalText("from:" + subfolder);
  await waitForDirectory(dst);
  await input.pressSequentially("Write-Output ('dirlume-session=' + $dirlumeTestSession)");
  await input.press("Enter");
  await waitForTerminalText("dirlume-session=42");
  await input.pressSequentially("Write-Output ('dirlume-' + 'draft')");
  await navigate("left", subfolder);
  await waitForDirectory(dst);
  await input.press("Enter");
  await waitForTerminalText("dirlume-draft");
  await waitForDirectory(subfolder);
  await input.press("Alt+F8");
  const commandHistory = page.getByRole("dialog", { name: "Command history", exact: true });
  await commandHistory.getByRole("button", { name: /command-bar-ok/ }).click();
  assert.match(await commandLine.inputValue(), /command-bar-ok/);
  await commandLine.fill("");
  await navigate("left", src);
  await waitForDirectory(src);
  await input.pressSequentially('[Console]::WriteLine(("$([char]27)[93m" + "dirlume-" + "yellow-probe" + "$([char]27)[0m"))');
  await input.press("Enter");
  async function assertTerminalContrast(previousColor = "") {
    const result = await page.waitForFunction((previousColor) => {
      const span = Array.from(document.querySelectorAll(".xterm-rows span"))
        .find((span) => span.textContent === "dirlume-yellow-probe");
      if (!span) return null;
      const text = getComputedStyle(span).color;
      const background = getComputedStyle(span.closest(".terminal-card")).backgroundColor;
      if (!text || !background || text === previousColor) return null;
      function luminance(color) {
        const [red, green, blue] = color.match(/[\d.]+/g).map((value) => {
          const channel = Number(value) / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return red * 0.2126 + green * 0.7152 + blue * 0.0722;
      }
      const fg = luminance(text);
      const bg = luminance(background);
      return { text, contrast: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) };
    }, previousColor);
    const style = await result.jsonValue();
    assert.ok(style.contrast >= 4.5, `Terminal output contrast was ${style.contrast}`);
    return style.text;
  }
  const lightYellow = await assertTerminalContrast();
  if (process.env.DIRLUME_TERMINAL_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_TERMINAL_SCREENSHOT, scale: "css" });
  await page.getByRole("button", { name: "Options", exact: true }).click();
  await page.getByRole("button", { name: "Text tools", exact: true }).click();
  const textBackground = page.getByLabel("Editor, viewer, and terminal background hex");
  await textBackground.fill("#101924");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await assertTerminalContrast(lightYellow);
  if (process.env.DIRLUME_DARK_TERMINAL_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_DARK_TERMINAL_SCREENSHOT, scale: "css" });
  await page.getByRole("button", { name: "Close terminal" }).click();

  await withServer(async ({ invitation, bytes }) => {
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByLabel("Server invitation").fill(invitation);
    await page.getByRole("dialog").getByRole("button", { name: "Connect", exact: true }).click();
    const remote = page.getByRole("listbox", { name: "left files", exact: true });
    const local = page.getByRole("listbox", { name: "right files", exact: true });
    await remote.getByRole("option", { name: /^folder/ }).click();
    await remote.press("Control+a");
    await properties.getByText("folder", { exact: true }).waitFor();
    assert.equal(await properties.getByRole("button", { name: "Apply", exact: true }).isDisabled(), true);
    assert.equal(await flag("Hidden").isDisabled(), true);
    await cancelAttributes();
    await page.keyboard.press("F5");
    await finishTransfer("Download");
    await local.getByRole("option", { name: /^folder/ }).waitFor();
    assert.deepEqual(await readFile(join(dst, "folder", "файл.bin")), bytes);
    await remote.focus();
    await page.getByRole("button", { name: "Find files", exact: true }).click();
    await mask.fill("*.md");
    await search.getByRole("button", { name: "Search", exact: true }).click();
    await matches.getByRole("option", { name: "folder/remote.md", exact: true }).waitFor();
    await search.getByRole("button", { name: "Go to file", exact: true }).click();
    await remote.getByRole("option", { name: /^remote.md/ }).click();
    await page.keyboard.press("F3");
    await page.getByRole("heading", { name: "Remote Markdown" }).waitFor();
    await page.keyboard.press("F4");
    await raw.waitFor();
    assert.match(await raw.innerText(), /23 20 52 65 6D 6F 74 65/);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("option", { name: /^файл.bin/ }).click();
    await page.keyboard.press("F5");
    await finishTransfer("Download");
    await page.getByRole("listbox", { name: "right files", exact: true }).getByRole("option", { name: /^файл.bin/ }).waitFor();
    assert.deepEqual(await readFile(join(dst, "файл.bin")), bytes);
    const back = leftPane.getByRole("button", { name: "Back", exact: true });
    await back.click();
    await page.waitForFunction(() => document.getElementById("left-address")?.value === "/");
    await back.click();
    await leftPane.getByRole("heading", { name: "from", exact: true }).waitFor();
  });
  await left.getByRole("option", { name: /^guide.md/ }).click({ modifiers: ["Control"] });
  await page.keyboard.press("F3");
  await diagram.waitFor();
  await page.reload();
  await diagram.waitFor();
  assert.equal(await page.getByRole("navigation", { name: "Open documents" }).getByRole("button", { name: "View guide.md" }).getAttribute("aria-pressed"), "true");
  await page.keyboard.press("Control+Tab");
  await wheelFont("#right-files", -120);
  const enlargedRight = await fontSize("#right-pane");
  const columnWidth = (side, column) => page.locator(`#${side}-pane .col-${column}`).evaluate((element) => element.getBoundingClientRect().width);
  const columnHandle = (side, name) => page.getByRole("region", { name: `${side} pane`, exact: true })
    .getByRole("separator", { name: `Resize ${name} column`, exact: true });
  async function dragColumn(side, name, delta) {
    const bounds = await columnHandle(side, name).boundingBox();
    assert.ok(bounds);
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + delta, y, { steps: 5 });
    await page.mouse.up();
  }
  const leftName = await columnWidth("left", "name");
  const leftSize = await columnWidth("left", "size");
  const rightSize = await columnWidth("right", "size");
  const rightModified = await columnWidth("right", "modified");
  await dragColumn("left", "Name", 56);
  assert.ok(Math.abs(await columnWidth("left", "name") - leftName - 56) <= 1);
  await dragColumn("left", "Size", 32);
  assert.equal(await columnWidth("left", "size"), leftSize + 32);
  assert.equal(await columnWidth("right", "size"), rightSize);
  await page.locator("#left-files").evaluate((list) => { list.scrollLeft = 60; });
  await page.waitForFunction(() => {
    const header = document.querySelector("#left-pane .file-columns");
    const list = document.getElementById("left-files");
    return list.scrollLeft > 0 && header.scrollLeft === list.scrollLeft &&
      Math.abs(header.querySelector(".col-size").getBoundingClientRect().left -
        list.querySelector(".file-size").getBoundingClientRect().left) <= 1;
  });
  await dragColumn("right", "Modified", -28);
  assert.equal(await columnWidth("right", "modified"), rightModified - 28);
  await columnHandle("right", "Modified").dblclick();
  assert.equal(await columnWidth("right", "modified"), rightModified);
  await dragColumn("right", "Modified", -28);
  const columnMenu = () => page.getByRole("menu", { name: "Columns", exact: true });
  const rightHeader = () => page.locator("#right-pane .file-columns");
  await rightHeader().getByRole("button", { name: "Modified", exact: true }).click({ button: "right" });
  assert.equal(await columnMenu().getByRole("menuitemcheckbox", { name: "Name", exact: true, checked: true }).isDisabled(), true);
  const modifiedPosition = await rightHeader().locator(".col-modified").evaluate((column) => column.getBoundingClientRect().left);
  await columnMenu().getByRole("menuitemcheckbox", { name: "Size", exact: true, checked: true }).click();
  await rightHeader().getByRole("button", { name: "Size", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await page.locator("#right-files .file-size:visible").count(), 0);
  assert.equal(await columnWidth("right", "modified"), rightModified - 28);
  const newModifiedPosition = await rightHeader().locator(".col-modified").evaluate((column) => column.getBoundingClientRect().left);
  assert.ok(Math.abs(newModifiedPosition - (modifiedPosition - rightSize)) <= 1);
  assert.equal(await columnWidth("left", "size"), leftSize + 32);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await columnMenu().getByRole("menuitemcheckbox", { name: "Modified", exact: true, checked: false }).waitFor();
  await rightHeader().getByRole("button", { name: "Modified", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await page.locator("#right-files .file-date:visible").count(), 0);
  await columnMenu().getByRole("menuitemcheckbox", { name: "Size", exact: true, checked: false }).click();
  assert.equal(await columnWidth("right", "size"), rightSize);
  await page.keyboard.press("Escape");
  await columnMenu().waitFor({ state: "hidden" });
  assert.equal(await rightHeader().getByRole("button", { name: "Name", exact: true }).evaluate((button) => button === document.activeElement), true);
  await exitDesktop(page);
  page = await startDesktop();
  if (diagnosticsBeforeRestart !== undefined) {
    assert.ok((await readFile(diagnosticsFile, "utf8")).startsWith(diagnosticsBeforeRestart));
    console.log("Verified diagnostic log context, redaction, deduplication, and persistence after restart.");
  }
  await page.getByRole("button", { name: "View guide.md" }).click();
  await page.getByRole("img", { name: "Mermaid diagram" }).waitFor();
  assert.equal(await fontSize(markdownSurface), enlargedMarkdown, "Restarting should restore the Markdown font size.");
  await page.keyboard.press("Control+Tab");
  assert.equal(await fontSize("#right-pane"), enlargedRight, "Restarting should restore the individual pane font size.");
  assert.ok(Math.abs(await columnWidth("left", "name") - leftName - 56) <= 1);
  assert.equal(await columnWidth("left", "size"), leftSize + 32);
  assert.equal(await columnWidth("right", "size"), rightSize);
  await rightHeader().getByRole("button", { name: "Modified", exact: true }).waitFor({ state: "hidden" });
  await rightHeader().getByRole("button", { name: "Name", exact: true }).press("Shift+F10");
  await columnMenu().getByRole("menuitemcheckbox", { name: "Modified", exact: true, checked: false }).click();
  await page.keyboard.press("Escape");
  await columnMenu().waitFor({ state: "hidden" });
  assert.equal(await columnWidth("right", "modified"), rightModified - 28);
  assert.equal(await page.getByLabel("left path").inputValue(), src);
  assert.equal(await page.getByLabel("right path").inputValue(), dst);
  await page.getByRole("listbox", { name: "left files", exact: true }).getByRole("option", { name: /^guide.md/, selected: true }).waitFor();
  await page.getByRole("button", { name: "Options", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Text tools", exact: true }).getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "View font sizes", exact: true }).click();
  assert.equal(await page.getByRole("spinbutton", { name: "Markdown preview font size" }).inputValue(), String(enlargedMarkdown));
  assert.equal(await page.getByRole("spinbutton", { name: "Text and hex viewer font size" }).inputValue(), String(viewerFont));
  await page.getByRole("button", { name: "Window", exact: true }).click();
  assert.equal(await page.getByLabel("Scheme name").inputValue(), "Blueprint");
  assert.equal(await page.locator("html").evaluate((element) => element.style.getPropertyValue("--file-hidden")), "#41536d");
  assert.equal(await page.locator("html").evaluate((element) => element.style.getPropertyValue("--file-system")), "#73124c");
  await page.getByRole("button", { name: "Done", exact: true }).click();

  await page.getByRole("button", { name: "Options", exact: true }).click();
  const englishOptions = page.getByRole("dialog", { name: "Options", exact: true });
  await englishOptions.getByRole("button", { name: "General", exact: true }).click();
  await englishOptions.getByLabel("Language", { exact: true }).selectOption("uk");
  await englishOptions.getByRole("button", { name: "Apply", exact: true }).click();
  const ukrainianOptions = page.getByRole("dialog", { name: "Налаштування", exact: true });
  assert.equal(await ukrainianOptions.getByLabel("Мова", { exact: true }).inputValue(), "uk");
  assert.equal(await page.locator("html").getAttribute("lang"), "uk");
  const ukrainianSearch = ukrainianOptions.getByRole("searchbox", { name: "Пошук налаштувань", exact: true });
  await ukrainianSearch.fill("Шрифти");
  await ukrainianSearch.press("F1");
  const ukrainianHelp = page.getByRole("dialog", { name: "Довідка", exact: true });
  await ukrainianHelp.getByRole("heading", { name: "Загальні", exact: true }).waitFor();
  const ukrainianTopics = ukrainianHelp.getByRole("navigation", { name: "Зміст" }).getByRole("link");
  const topicLinks = await ukrainianTopics.evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  await ukrainianHelp.getByRole("link", { name: "Термінал", exact: true }).click();
  assert.match(await ukrainianHelp.locator("#help-terminal p").innerText(), /інтерактивну оболонку/);
  await page.keyboard.press("Escape");
  assert.equal(await ukrainianSearch.inputValue(), "Шрифти");
  assert.equal(await ukrainianSearch.evaluate((field) => field === document.activeElement), true);
  await ukrainianSearch.press("Enter");
  await ukrainianOptions.getByRole("heading", { name: "Шрифти", exact: true }).waitFor();
  await ukrainianSearch.fill("");
  await ukrainianOptions.getByRole("button", { name: "Готово", exact: true }).click();
  await page.getByRole("button", { name: "Знайти файли", exact: true }).click();
  const ukrainianFind = page.getByRole("dialog", { name: "Знайти файли", exact: true });
  await ukrainianFind.getByLabel("Маска файлів", { exact: true }).waitFor();
  await ukrainianFind.getByRole("button", { name: "Закрити", exact: true }).click();
  await exitDesktop(page);
  page = await startDesktop();
  await page.getByRole("button", { name: "Знайти файли", exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "uk");
  assert.equal(await page.locator("#left-pane .col-name button").innerText(), "Назва");
  await rightHeader().getByRole("button", { name: "Назва", exact: true }).click({ button: "right" });
  const ukrainianColumns = page.getByRole("menu", { name: "Колонки", exact: true });
  await ukrainianColumns.getByRole("menuitemcheckbox", { name: "Розмір", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await ukrainianColumns.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Налаштування", exact: true }).click();
  const reopenedOptions = page.getByRole("dialog", { name: "Налаштування", exact: true });
  await reopenedOptions.getByRole("button", { name: "Загальні", exact: true }).click();
  await reopenedOptions.getByLabel("Мова", { exact: true }).selectOption("ru");
  await reopenedOptions.getByRole("button", { name: "Готово", exact: true }).click();
  assert.equal(await page.locator("html").getAttribute("lang"), "ru");
  assert.equal(await page.locator("#left-pane .col-name button").innerText(), "Имя");
  await page.locator("#left-pane .file-list").press("F1");
  const russianHelp = page.getByRole("dialog", { name: "Справка", exact: true });
  await russianHelp.getByRole("heading", { name: "Основные файловые панели", exact: true }).waitFor();
  assert.deepEqual(await russianHelp.getByRole("navigation", { name: "Оглавление" }).getByRole("link")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href"))), topicLinks);
  assert.match(await russianHelp.locator("#help-files p").innerText(), /Введите путь/i);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Найти файлы", exact: true }).click();
  const russianFind = page.getByRole("dialog", { name: "Найти файлы", exact: true });
  await russianFind.getByLabel("Маска файлов", { exact: true }).waitFor();
  await russianFind.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  const russianOptions = page.getByRole("dialog", { name: "Настройки", exact: true });
  assert.equal(await russianOptions.getByLabel("Язык", { exact: true }).inputValue(), "ru");
  await russianOptions.getByLabel("Язык", { exact: true }).selectOption("en");
  await russianOptions.getByRole("button", { name: "Готово", exact: true }).click();
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  await page.getByRole("button", { name: "Options", exact: true }).waitFor();
  console.log("Verified English, Ukrainian and Russian interface switching and language restoration after restart.");

  if (process.env.DIRLUME_FTP_PYTHON) {
    await page.getByRole("button", { name: "View guide.md" }).click();
    await page.keyboard.press("Escape");
    await testFtp(page, temp, src, dst, join(temp, "ftp-config"), async () => {
      await exitDesktop(page);
      page = await startDesktop();
      return page;
    });
  }
  await page.getByRole("button", { name: "Options", exact: true }).click();
  const featureDialog = page.getByRole("dialog", { name: "Options", exact: true });
  const featureSearch = featureDialog.getByRole("searchbox", { name: "Search settings" });
  await featureSearch.fill("show hidden files");
  await featureSearch.press("Enter");
  await featureDialog.getByRole("heading", { name: "Main File Panels", exact: true }).waitFor();
  await featureDialog.getByRole("checkbox", { name: "Show hidden files" }).waitFor();
  await featureDialog.getByLabel("Panel background hex", { exact: true }).waitFor();
  await featureDialog.getByRole("spinbutton", { name: "Left file pane font size" }).waitFor();
  const featureFonts = [["Viewer", "Consolas", "21"], ["Editor", "Courier New", "19"], ["Terminal", "Arial", "17"]];
  for (const [name, family, size] of featureFonts) {
    await featureSearch.fill(`${name} font size`);
    await featureSearch.press("Enter");
    await featureDialog.getByRole("heading", { name, exact: true }).waitFor();
    await featureDialog.getByRole("combobox", { name: `${name} font family`, exact: true }).fill(family);
    await featureDialog.getByRole("spinbutton", { name: `${name} font size`, exact: true }).fill(size);
  }
  await featureSearch.fill("");
  await featureDialog.getByRole("button", { name: "Done", exact: true }).click();
  await exitDesktop(page);
  page = await startDesktop();
  await page.getByRole("button", { name: "Options", exact: true }).waitFor();
  const featureValues = await page.locator("html").evaluate((root) => {
    const style = getComputedStyle(root);
    return ["viewer", "editor", "terminal"].map((view) => [style.getPropertyValue(`--${view}-font`), style.getPropertyValue(`--${view}-size`)]);
  });
  assert.deepEqual(featureValues.map(([, size]) => size), featureFonts.map(([, , size]) => `${size}px`));
  featureFonts.forEach(([, family], index) => assert.ok(featureValues[index][0].replaceAll("\\", "").startsWith(family)));
  const sampleForFonts = page.getByRole("option", { name: /^sample\.rs/ }).first();
  const sampleSurface = page.getByRole("region", { name: "sample.rs", exact: true }).locator(".code-surface");
  for (const [shortcut, expected] of [["F3", "21px"], ["F4", "19px"]]) {
    await sampleForFonts.click();
    await page.keyboard.press(shortcut);
    assert.equal(await sampleSurface.evaluate((surface) => getComputedStyle(surface).fontSize), expected);
    await page.keyboard.press("F1");
    await page.getByRole("dialog", { name: "Help", exact: true })
      .getByRole("heading", { name: shortcut === "F3" ? "Viewer" : "Editor", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await sampleSurface.waitFor();
    await page.keyboard.press("Escape");
  }
  assert.equal(await page.getByRole("combobox", { name: "Command line" }).evaluate((input) => getComputedStyle(input).fontSize), "17px");
  console.log("Verified feature settings search, independent font overrides, and persistence after restart.");
  const help = page.getByRole("dialog", { name: "Help", exact: true });
  await page.context().setOffline(true);
  try {
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press("F1");
    const contents = help.getByRole("navigation", { name: "Table of contents" });
    await contents.waitFor();
    const links = contents.getByRole("link");
    assert.equal(topicLinks.length, 19);
    assert.deepEqual(await links.evaluateAll((items) => items.map((link) => link.getAttribute("href"))), topicLinks);
    if (process.env.DIRLUME_HELP_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_HELP_SCREENSHOT, scale: "css" });
    for (const href of topicLinks) {
      const link = contents.locator(`a[href="${href}"]`);
      await link.click();
      assert.equal(await help.locator(`${href} h3`).innerText(), await link.innerText());
      assert.match(await help.locator(`${href} p`).innerText(), /\S/);
    }
    await page.keyboard.press("Escape");
  } finally {
    await page.context().setOffline(false);
  }

  const terminalButton = page.locator(".command-bar").getByRole("button", { name: "Terminal", exact: true });
  if (await terminalButton.getAttribute("aria-pressed") === "false") await terminalButton.click();
  const terminalInput = page.locator(".xterm-helper-textarea");
  await terminalInput.press("F1");
  await help.getByRole("heading", { name: "Terminal", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await terminalInput.evaluate((field) => field === document.activeElement), true);

  await page.getByRole("button", { name: "Options", exact: true }).click();
  const shortcutOptions = page.getByRole("dialog", { name: "Options", exact: true });
  const shortcutSearch = shortcutOptions.getByRole("searchbox", { name: "Search settings" });
  await shortcutSearch.fill("help");
  await shortcutOptions.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  const binding = shortcutOptions.getByRole("button", { name: "Change shortcut for Help", exact: true });
  await binding.click();
  const captureHelp = shortcutOptions.getByRole("textbox", { name: "New shortcut for Help", exact: true });
  await captureHelp.press("F4");
  await shortcutOptions.getByText("F4 is assigned to Edit text.", { exact: true }).waitFor();
  await captureHelp.press("Control+Shift+F1");
  await shortcutOptions.getByRole("button", { name: "Apply", exact: true }).click();
  assert.equal(await binding.innerText(), "Ctrl+Shift+F1");
  // Verify Dirlume no longer handles F1 without invoking the WebView's native help accelerator.
  await shortcutSearch.dispatchEvent("keydown", { key: "F1", code: "F1", bubbles: true });
  assert.equal(await help.count(), 0);
  await shortcutSearch.press("Control+Shift+F1");
  await help.waitFor();
  await page.keyboard.press("Escape");
  await shortcutOptions.getByRole("button", { name: "Clear shortcut for Help", exact: true }).click();
  await shortcutOptions.getByRole("button", { name: "Done", exact: true }).click();
  await page.keyboard.press("Control+Shift+F1");
  assert.equal(await help.count(), 0);
  console.log("Verified offline Help, all topics in three languages, focus restoration, and rebinding or disabling F1.");
  const menubar = page.getByRole("menubar", { name: "Main menu" });
  const group = (name) => menubar.getByRole("menuitem", { name, exact: true });
  const menu = (name) => menubar.getByRole("menu", { name, exact: true });
  const fileList = page.getByRole("listbox", { name: "left files", exact: true });
  assert.deepEqual(await menubar.getByRole("menuitem").allTextContents(), ["Left", "Files", "Commands", "Options", "Right", "Help"]);
  await fileList.focus();
  await page.keyboard.press("F9");
  await menu("Left").waitFor();
  await page.keyboard.press("ArrowLeft");
  const helpItems = menu("Help").getByRole("menuitem");
  assert.deepEqual(await helpItems.locator("span").allTextContents(), ["Help", "About"]);
  await page.keyboard.press("Enter");
  await help.getByRole("navigation", { name: "Table of contents" }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await fileList.evaluate((list) => document.activeElement === list), true);
  await group("Help").click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const about = page.getByRole("dialog", { name: "About", exact: true });
  await about.getByText("Dirlume", { exact: true }).waitFor();
  await about.getByText(buildNumber ? `${productVersion}+${buildNumber}` : productVersion, { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await group("Files").click();
  const attributesAction = menu("Files").getByRole("menuitem", { name: "File attributes", exact: true });
  assert.match(await attributesAction.getAttribute("title"), /Ctrl\+A/);
  if (process.env.DIRLUME_MENU_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_MENU_SCREENSHOT, scale: "css" });
  await page.keyboard.press("Escape");
  await menu("Files").waitFor({ state: "hidden" });
  await group("Commands").click();
  const updateAction = menu("Commands").getByRole("menuitem", { name: "Check for updates", exact: true });
  if (!process.env.DIRLUME_UPDATER_PUBLIC_KEY) {
    await updateAction.click();
    await page.getByRole("alert").filter({ hasText: /^Updates are unavailable in this build\.$/ }).waitFor();
  } else {
    await updateAction.waitFor();
    await page.keyboard.press("Escape");
  }
  async function openAppearance() {
    await page.getByRole("button", { name: "Options", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Options", exact: true });
    await settings.getByRole("searchbox", { name: "Search settings" }).fill("");
    await settings.getByRole("button", { name: "Appearance", exact: true }).click();
    return settings;
  }
  const themeRoot = () => page.locator("html[data-theme=classic-blue]");
  const appearance = await openAppearance();
  await appearance.getByLabel("Color scheme", { exact: true }).selectOption("classic-blue");
  await appearance.locator(".preview-frame[data-theme=classic-blue]").waitFor();
  assert.equal(await themeRoot().count(), 0);
  await appearance.getByRole("button", { name: "Apply", exact: true }).click();
  await themeRoot().waitFor();
  const pairs = await themeRoot().evaluate((root) => {
    const style = getComputedStyle(root);
    const value = (name) => style.getPropertyValue(`--${name}`).trim();
    const files = ["panel-ink", "panel-muted", "file-source", "file-text", "file-document", "file-image", "file-media",
      "file-archive", "file-config", "file-executable", "file-hidden", "file-system"];
    return [
      ...files.flatMap((color) => ["panel-bg", "panel-selection", "panel-inactive-selection"].map((background) =>
        [value(color), value(background)])),
      [value("dialog-ink"), value("dialog-bg")], [value("text-ink"), value("text-bg")], [value("ink"), value("surface")],
    ];
  });
  const luminance = (hex) => [1, 3, 5].map((offset) => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  for (const [foreground, background] of pairs) {
    const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    assert.ok((light + 0.05) / (dark + 0.05) >= 4.5, `${foreground} on ${background} must be readable`);
  }
  await appearance.getByRole("button", { name: "Done", exact: true }).click();
  await navigate("left", attributes);
  const showHidden = page.getByRole("button", { name: "Show hidden files", exact: true });
  if (await showHidden.getAttribute("aria-pressed") === "false") await showHidden.click();
  const attributeList = page.getByRole("listbox", { name: "left files", exact: true });
  for (const name of [/^hidden\.rs/, /^system-hidden\.dll/]) {
    const row = attributeList.getByRole("option", { name });
    const color = () => row.locator(".file-name").evaluate((element) => getComputedStyle(element).color);
    const originalColor = await color();
    await row.click();
    assert.equal(await color(), originalColor);
    await row.click({ modifiers: ["Control"] });
    assert.equal(await color(), originalColor);
  }
  if (process.env.DIRLUME_CLASSIC_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_CLASSIC_SCREENSHOT, scale: "css" });
  await exitDesktop(page);
  page = await startDesktop();
  await themeRoot().waitFor();
  const customAppearance = await openAppearance();
  await customAppearance.getByRole("button", { name: "New scheme", exact: true }).click();
  assert.equal(await customAppearance.getByLabel("Base theme", { exact: true }).inputValue(), "classic-blue");
  await customAppearance.getByLabel("Scheme name", { exact: true }).fill("Classic blue custom");
  await customAppearance.getByLabel("Panel background hex", { exact: true }).fill("#142560");
  await customAppearance.getByRole("button", { name: "Done", exact: true }).click();
  await exitDesktop(page);
  page = await startDesktop();
  await themeRoot().waitFor();
  assert.equal(await themeRoot().evaluate((root) => getComputedStyle(root).getPropertyValue("--panel-bg").trim()), "#142560");
  console.log("Verified Classic blue contrast, file colors in selected rows, preview, and custom and built-in theme persistence.");
  page = await testFolderShortcuts({ page, startDesktop, exitDesktop, src, dst });
  if (process.env.CI || process.env.DIRLUME_VERIFY_WINDOWS_ENVIRONMENT === "1") await testTerminalEnvironment(page);
  await testCompareWorker(page, src, dst);
  await testCommandCompletion(page, temp);
  page = await testNewFolder({ page, startDesktop, exitDesktop, root: temp });
  await testShortcutFields(page);
  if (process.env.DIRLUME_VERIFY_ARCHIVES === "1") await testArchives(page, temp);
  await exitDesktop(page);
  console.log("Verified the main menu, keyboard navigation, focus restoration, Help, About, and update action.");
  console.log("Verified copy progress, multiple selection, move, file creation, editing, deletion, appearance persistence, keyboard shortcuts, the command line, and remote transfers.");
} finally {
  if (lockedBy) await close(lockedBy);
  await browser?.close().catch(() => {});
  if (child) await close(child);
  if (otherVolume) await rm(otherVolume, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
      break;
    } catch (error) {
      if (attempt === 4) throw error;
      await setTimeout(400);
    }
  }
}
