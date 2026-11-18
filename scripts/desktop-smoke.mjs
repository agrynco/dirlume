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
await writeFile(join(src, "guide.md"), "# Getting started\n\n**Dirlume** on Windows.\n");
const debuggingPort = await port();
const child = spawn(resolve(`src-tauri/target/${profile}/dirlume.exe`), [], {
  windowsHide: true,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debuggingPort}`,
    WEBVIEW2_USER_DATA_FOLDER: join(temp, "webview"),
  },
});
let browser;
try {
  for (let attempt = 0; !browser; attempt++) {
    if (attempt === 80 || child.exitCode !== null) throw new Error("The Windows WebView did not start.");
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`, { timeout: 1000 });
    } catch {
      await setTimeout(250);
    }
  }
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent("page");
  page.setDefaultTimeout(8000);
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
  await page.getByRole("option", { name: /^notes.txt/ }).click();
  await page.keyboard.press("F5");
  await page.getByRole("listbox", { name: "right files", exact: true }).getByRole("option", { name: /^notes.txt/ }).waitFor();
  assert.equal(await readFile(join(dst, "notes.txt"), "utf8"), "Dirlume\n");

  await page.getByRole("button", { name: "Options", exact: true }).click();
  await page.getByLabel("Color scheme").selectOption("light");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  await page.getByRole("button", { name: "Change shortcut for New folder" }).click();
  await page.getByRole("textbox", { name: "New shortcut for New folder" }).press("F5");
  await page.getByText("F5 is assigned to Copy.", { exact: true }).waitFor();
  await page.getByRole("textbox", { name: "New shortcut for New folder" }).press("F10");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("listbox", { name: "right files", exact: true }).focus();
  await page.keyboard.press("F10");
  await page.getByRole("dialog", { name: "New folder" }).getByLabel("Name").fill("verified");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("option", { name: /^verified/ }).waitFor();

  await page.getByRole("option", { name: /^guide.md/ }).click();
  await page.keyboard.press("F3");
  await page.getByRole("heading", { name: "Getting started" }).waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  if (process.env.DIRLUME_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_SMOKE_SCREENSHOT });

  await withServer(async ({ invitation, bytes }) => {
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByLabel("Server invitation").fill(invitation);
    await page.getByRole("dialog").getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("option", { name: /^folder/ }).dblclick();
    await page.getByRole("option", { name: /^файл.bin/ }).click();
    await page.keyboard.press("F5");
    await page.getByRole("listbox", { name: "right files", exact: true }).getByRole("option", { name: /^файл.bin/ }).waitFor();
    assert.deepEqual(await readFile(join(dst, "файл.bin")), bytes);
  });
  console.log("Verified the native desktop, local copy, keyboard settings, theme, Markdown and remote download.");
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
