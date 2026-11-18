import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright-core";
import { close, fixture, port, withServer } from "./server-smoke.mjs";
import { testFtp } from "./ftp-smoke.mjs";

if (process.platform !== "win32") throw new Error("This smoke test uses Windows WebView2.");
const profile = process.env.DIRLUME_BUILD_PROFILE ?? "release";
const temp = await fixture("desktop-");
const src = join(temp, "from");
const dst = join(temp, "to");
await mkdir(src);
await mkdir(dst);
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
      ...(process.env.DIRLUME_INTERNAL_CDP === "1"
        ? { DIRLUME_CDP_PORT: String(debuggingPort) }
        : { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${debuggingPort}` }),
      WEBVIEW2_USER_DATA_FOLDER: join(temp, "webview"),
      DIRLUME_FTP_TEST_CONFIG: join(temp, "ftp-config"),
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
    assert.equal(await setup.getByLabel("Destination").inputValue(), destination);
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
  assert.equal(await page.getByRole("button", { name: "Find files" }).getAttribute("title"), "Find files (Alt+F7)");
  assert.equal(await page.getByRole("region", { name: "right pane" }).getByRole("button", { name: "Refresh folder" }).getAttribute("title"), "Refresh folder");
  assert.deepEqual(await page.locator("button:visible").evaluateAll((buttons) =>
    buttons.filter((button) => !button.title.trim()).map((button) => button.textContent)), []);
  await page.waitForFunction(() => ["left", "right"].every((side) =>
    document.getElementById(`${side}-address`)?.value &&
    document.getElementById(`${side}-files`)?.getAttribute("aria-busy") === "false"));
  async function navigate(side, path) {
    const input = page.getByRole("textbox", { name: `${side} path`, exact: true });
    await input.fill(path);
    await input.press("Enter");
    try {
      await page.getByRole("region", { name: `${side} pane`, exact: true })
        .getByRole("heading", { name: path.split(/[\\/]/).at(-1), exact: true }).waitFor();
      await page.waitForFunction((side) => document.getElementById(`${side}-files`)?.getAttribute("aria-busy") === "false", side);
    } catch (error) {
      throw new Error(`Could not navigate the ${side} pane: ${await page.getByRole("alert").allTextContents()}`, { cause: error });
    }
  }
  await navigate("left", src);
  await navigate("right", dst);
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
  await Promise.all(Array.from({ length: 1005 }, (_, index) => writeFile(join(bulk, `file-${index}.tmp`), "")));
  await navigate("left", bulk);
  await left.focus();
  await page.keyboard.press("Alt+F7");
  await mask.fill("*.tmp");
  await mask.press("Enter");
  await search.getByText(/1005 matches/).waitFor();
  await search.getByRole("button", { name: "Show in panel", exact: true }).click();
  await leftPane.getByText("1005 matches", { exact: true }).waitFor();
  await left.focus();
  await page.keyboard.press("ArrowRight");
  await left.getByRole("option", { name: /^file-1004.tmp/, selected: true }).waitFor();
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
  await page.getByRole("option", { name: /^notes.txt/ }).click();
  await page.keyboard.press("Insert");
  await left.getByRole("option", { name: /^second.txt/ }).click({ modifiers: ["Control"] });
  await page.getByRole("textbox", { name: "Command line" }).press("F5");
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

  const leftAddress = page.getByRole("textbox", { name: "left path", exact: true });
  await leftAddress.press("Alt+Control+S");
  const optionsDialog = page.getByRole("dialog", { name: "Options", exact: true });
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

  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  const panelsSection = optionsDialog.getByRole("button", { name: "Panels", exact: true });
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
  const searchSettings = page.getByRole("searchbox", { name: "Search settings", exact: true });
  await searchSettings.fill("office documents");
  await searchSettings.press("Enter");
  await page.getByRole("heading", { name: "File types", exact: true }).waitFor();
  await page.getByLabel("Source code hex").fill("#7c2144");
  const exampleSource = page.getByRole("region", { name: "Settings preview" }).getByText("main.rs", { exact: true });
  assert.equal(await foreground(exampleSource), "rgb(124, 33, 68)");
  assert.notEqual(await foreground(sourceName), "rgb(124, 33, 68)");
  await searchSettings.fill("");
  await page.getByRole("button", { name: "Fonts", exact: true }).click();
  await page.getByRole("button", { name: "Browse installed fonts for file panels", exact: true }).click();
  const fontPicker = page.getByRole("dialog", { name: "Installed fonts", exact: true });
  await fontPicker.getByRole("searchbox", { name: "Search fonts" }).press("Escape");
  await fontPicker.waitFor({ state: "hidden" });
  await optionsDialog.waitFor();
  assert.equal(await page.getByRole("button", { name: "Fonts", exact: true }).getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "Browse installed fonts for file panels", exact: true }).click();
  await fontPicker.getByRole("searchbox", { name: "Search fonts" }).fill("Arial");
  const family = fontPicker.getByRole("listbox", { name: "Font families" });
  await family.getByRole("option", { name: "Arial", exact: true }).waitFor();
  await family.selectOption("Arial");
  await fontPicker.getByRole("button", { name: "Use font", exact: true }).click();
  assert.equal(await page.getByLabel("File panels font family").inputValue(), "Arial");
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
  await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  await page.getByRole("button", { name: "Change shortcut for New folder" }).click();
  await page.getByRole("textbox", { name: "New shortcut for New folder" }).press("F5");
  await page.getByText("F5 is assigned to Copy.", { exact: true }).waitFor();
  await page.getByRole("textbox", { name: "New shortcut for New folder" }).press("F12");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("listbox", { name: "right files", exact: true }).focus();
  await page.keyboard.press("F12");
  await page.getByRole("dialog", { name: "New folder" }).getByLabel("Name").fill("verified");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("option", { name: /^verified/ }).waitFor();

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

  await page.getByRole("option", { name: /^guide.md/ }).click();
  await page.keyboard.press("F3");
  await page.getByRole("heading", { name: "Getting started" }).waitFor();
  const diagram = page.getByRole("img", { name: "Mermaid diagram" });
  await diagram.waitFor();
  assert.ok(await diagram.evaluate((image) => image.complete && image.naturalWidth > 0));
  if (process.env.DIRLUME_DOCUMENT_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_DOCUMENT_SCREENSHOT, scale: "css" });
  await page.keyboard.press("Control+Tab");
  await left.getByRole("option", { name: /^sample.rs/ }).click();
  await page.keyboard.press("F4");
  const sourceEditor = page.getByRole("textbox", { name: "Edit sample.rs" });
  await sourceEditor.locator(".syntax-keyword").first().waitFor();
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
  await page.getByRole("button", { name: "Close", exact: true }).click();
  if (process.env.DIRLUME_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_SMOKE_SCREENSHOT, scale: "css" });

  const commandLine = page.getByRole("textbox", { name: "Command line" });
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
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
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
  assert.equal(await page.getByRole("textbox", { name: "left path" }).inputValue(), src);
  assert.equal(await page.getByRole("textbox", { name: "right path" }).inputValue(), dst);
  await left.getByRole("option", { name: /^guide.md/, selected: true }).waitFor();
  await page.getByRole("button", { name: "Options", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  assert.equal(await page.getByLabel("Scheme name").inputValue(), "Blueprint");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  if (process.env.DIRLUME_FTP_PYTHON) {
    await page.getByRole("button", { name: "View guide.md" }).click();
    await page.keyboard.press("Escape");
    await testFtp(page, temp, src, dst, join(temp, "ftp-config"), async () => {
      await exitDesktop(page);
      page = await startDesktop();
      return page;
    });
  }
  await exitDesktop(page);
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
