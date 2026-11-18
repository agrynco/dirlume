import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright-core";
import { close, fixture, port, withServer } from "./server-smoke.mjs";

if (process.platform !== "win32") throw new Error("This smoke test uses Windows WebView2.");
const profile = process.env.DIRLUME_BUILD_PROFILE ?? "release";
const temp = await fixture("desktop-");
const src = join(temp, "from");
const dst = join(temp, "to");
await mkdir(src);
await mkdir(dst);
await writeFile(join(src, "notes.txt"), "Dirlume\n");
await writeFile(join(src, "second.txt"), "Second file\n");
await writeFile(join(src, "guide.md"), "# Getting started\n\n**Dirlume** on Windows.\n");
await mkdir(join(src, "measured"));
await writeFile(join(src, "measured", "data.bin"), Buffer.alloc(12));
const debuggingPort = await port();
const child = spawn(resolve(`src-tauri/target/${profile}/dirlume.exe`), [], {
  windowsHide: true,
  env: {
    ...process.env,
    ...(process.env.DIRLUME_INTERNAL_CDP === "1"
      ? { DIRLUME_CDP_PORT: String(debuggingPort) }
      : { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${debuggingPort}` }),
    WEBVIEW2_USER_DATA_FOLDER: join(temp, "webview"),
  },
});
let browser;
let startupError = "";
let startupOutput = "";
child.on("error", (error) => { startupError = error.message; });
child.stderr.on("data", (chunk) => { startupOutput = (startupOutput + chunk).slice(-2500); });
try {
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
  async function finishTransfer(action, expectedCount = 1) {
    const setup = page.getByRole("dialog", { name: action === "Move" ? "Rename or move" : action, exact: true });
    await setup.waitFor();
    assert.equal(await setup.getByLabel("Destination").inputValue(), dst);
    await setup.getByRole("button", { name: action, exact: true }).click();
    const result = page.getByRole("dialog", { name: "Transfer complete", exact: true });
    await result.getByText(`${expectedCount} completed.`, { exact: true }).waitFor();
    const progress = result.getByRole("progressbar", { name: "Overall transfer progress" });
    assert.equal(await progress.getAttribute("value"), String(expectedCount));
    await result.getByRole("button", { name: "Done" }).click();
  }
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent("page");
  page.setDefaultTimeout(8000);
  const pageErrors = [];
  page.on("pageerror", (error) => { pageErrors.push(error.message); });
  await page.getByRole("heading", { name: "Dirlume" }).waitFor();
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
    } catch (error) {
      throw new Error(`Could not navigate the ${side} pane: ${await page.getByRole("alert").allTextContents()}`, { cause: error });
    }
  }
  await navigate("left", src);
  await navigate("right", dst);
  await page.getByRole("option", { name: /^measured/ }).click();
  await page.keyboard.press("F3");
  await page.getByRole("option", { name: /^measured/ }).getByText("12 B", { exact: true }).waitFor();
  await page.getByRole("option", { name: /^notes.txt/ }).click();
  await page.keyboard.press("Insert");
  await page.keyboard.press("Insert");
  await page.getByRole("textbox", { name: "Command line" }).press("F5");
  await finishTransfer("Copy", 2);
  await page.getByRole("listbox", { name: "right files", exact: true }).getByRole("option", { name: /^notes.txt/ }).waitFor();
  assert.equal(await readFile(join(dst, "notes.txt"), "utf8"), "Dirlume\n");
  assert.equal(await readFile(join(dst, "second.txt"), "utf8"), "Second file\n");
  const left = page.getByRole("listbox", { name: "left files", exact: true });
  await left.getByRole("option", { name: /^notes.txt/ }).click({ modifiers: ["Control"] });
  await left.getByRole("option", { name: /^second.txt/ }).click({ modifiers: ["Control"] });
  await writeFile(join(dst, "notes.txt"), "Previous version\n");
  await left.getByRole("option", { name: /^notes.txt/ }).click();
  await page.keyboard.press("F5");
  await page.getByRole("dialog", { name: "Copy", exact: true }).getByRole("button", { name: "Copy" }).click();
  const conflict = page.getByRole("dialog", { name: "File already exists" });
  await conflict.waitFor();
  assert.equal(await readFile(join(dst, "notes.txt"), "utf8"), "Previous version\n");
  await conflict.getByRole("button", { name: "Overwrite" }).click();
  await page.getByRole("dialog", { name: "Transfer complete" }).getByRole("button", { name: "Done" }).click();
  assert.equal(await readFile(join(dst, "notes.txt"), "utf8"), "Dirlume\n");
  await writeFile(join(src, "outside-change.txt"), "watch me");
  await page.getByRole("option", { name: /^outside-change.txt/ }).waitFor();

  await page.getByRole("button", { name: "Options", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByLabel("Color scheme").selectOption("light");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.getByRole("button", { name: "New scheme", exact: true }).click();
  await page.getByLabel("Scheme name").fill("Blueprint");
  await page.getByRole("button", { name: "Window", exact: true }).click();
  await page.getByLabel("Window background hex").fill("#eef3fe");
  await page.getByRole("button", { name: "Panels", exact: true }).click();
  await page.getByLabel("Panel background hex").fill("#ecf9f5");
  await page.getByRole("button", { name: "Dialogs", exact: true }).click();
  await page.getByLabel("Dialog background hex").fill("#f5f9fe");
  await page.getByRole("button", { name: "Fonts", exact: true }).click();
  await page.getByLabel("File panels font family").fill("Arial");
  await page.getByLabel("File panels font size").fill("17");
  assert.equal(await page.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor), "rgb(238, 243, 254)");
  assert.equal(await page.locator("#left-pane").evaluate((pane) => getComputedStyle(pane).backgroundColor), "rgb(236, 249, 245)");
  assert.equal(await page.locator("#left-pane").evaluate((pane) => getComputedStyle(pane).fontSize), "17px");
  assert.equal(await page.getByRole("dialog", { name: "Options" }).evaluate((dialog) => getComputedStyle(dialog).backgroundColor), "rgb(245, 249, 254)");
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
  await page.waitForFunction(() => Array.from(document.querySelectorAll("dialog button")).some((button) =>
    button.textContent?.trim() === "Close" && !button.disabled));
  await page.keyboard.press("F10");
  await page.getByRole("dialog", { name: "draft.md" }).waitFor({ state: "hidden" });
  assert.equal(await readFile(join(src, "draft.md"), "utf8"), "# Draft");
  await left.getByRole("option", { name: /^draft.md/ }).click();
  await page.keyboard.press("F6");
  await finishTransfer("Move");
  await assert.rejects(readFile(join(src, "draft.md")), { code: "ENOENT" });
  const draft = page.getByRole("listbox", { name: "right files" }).getByRole("option", { name: /^draft.md/ });
  await draft.click();
  await page.keyboard.press("F8");
  await page.getByRole("dialog", { name: "Move to Trash" }).getByRole("button", { name: "Cancel" }).click();
  await page.keyboard.press("Shift+Delete");
  const deleteDialog = page.getByRole("dialog", { name: "Delete permanently" });
  assert.equal(await deleteDialog.getByRole("button", { name: "Cancel" }).evaluate((button) => document.activeElement === button), true);
  await deleteDialog.getByRole("button", { name: "Delete permanently" }).click();
  await draft.waitFor({ state: "detached" });

  await page.getByRole("option", { name: /^guide.md/ }).click();
  await page.keyboard.press("F3");
  await page.getByRole("heading", { name: "Getting started" }).waitFor();
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
    await remote.getByRole("option", { name: /^folder/ }).dblclick();
    await remote.getByRole("option", { name: /^remote.md/ }).click();
    await page.keyboard.press("F3");
    await page.getByRole("heading", { name: "Remote Markdown" }).waitFor();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("option", { name: /^файл.bin/ }).click();
    await page.keyboard.press("F5");
    await finishTransfer("Download");
    await page.getByRole("listbox", { name: "right files", exact: true }).getByRole("option", { name: /^файл.bin/ }).waitFor();
    assert.deepEqual(await readFile(join(dst, "файл.bin")), bytes);
  });
  await page.reload();
  await page.getByRole("button", { name: "Options", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  assert.equal(await page.getByLabel("Scheme name").inputValue(), "Blueprint");
  console.log("Verified copy progress, multiple selection, move, file creation, editing, deletion, appearance persistence, keyboard shortcuts, the command line, and remote transfers.");
} finally {
  await browser?.close();
  await close(child);
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
