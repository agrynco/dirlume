import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { openMainMenu } from "./menu-header-smoke.mjs";
import { checkResizeMarker, closeToolWindow, openOptionsWindow, settingsArchiveAction } from "./tool-window-smoke.mjs";

const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const optionsOf = (page) => page.getByRole("dialog", { name: "Options", exact: true });
const showStatusBar = (options) => options.getByRole("checkbox", { name: "Show status bar", exact: true });
const resizeMarker = (page, parent) => page.locator(`${parent} > .window-resize-marker`);

async function openStatusSetting(options) {
  const search = options.getByRole("searchbox", { name: "Search settings" });
  await search.fill("Show status bar");
  await search.press("Enter");
  await showStatusBar(options).waitFor();
}

async function checkTerminalHint(page, statusShown) {
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  const output = terminal.locator(".terminal-surface");
  const input = terminal.locator(".xterm-helper-textarea");
  const bar = statusShown ? page.locator(".statusbar") : terminal.locator("header");
  const hint = bar.getByRole("status").filter({ hasText: "File shortcuts paused. Click a file pane to use them." });
  const helpButton = button(bar, "Why are file shortcuts paused?");
  const list = page.getByRole("listbox", { name: "left files", exact: true });
  await list.focus();
  await hint.waitFor({ state: "hidden" });
  const height = (await output.boundingBox()).height;
  await input.focus();
  await hint.waitFor();
  assert.equal((await output.boundingBox()).height, height);
  assert.equal(await page.locator(".terminal-shortcut-hint").count(), 1);
  assert.equal(await hint.locator("strong").evaluate((node) => getComputedStyle(node).fontWeight), "600");
  assert.equal(await hint.getAttribute("data-tooltip"), "File shortcuts paused. Click a file pane to use them.");
  if (!statusShown) {
    const close = await button(terminal, "Close terminal").boundingBox();
    const question = await helpButton.boundingBox();
    assert.ok(question.x + question.width <= close.x + 1);
    assert.ok(Math.abs(question.y + question.height / 2 - close.y - close.height / 2) < 1);
  }
  const dialog = page.getByRole("dialog", { name: "Help", exact: true });
  await helpButton.focus();
  await hint.waitFor();
  await helpButton.press("Enter");
  await dialog.getByRole("heading", { name: "File shortcuts in the terminal", exact: true }).waitFor();
  await dialog.getByText("Configured file Copy shortcut: F5.", { exact: true }).waitFor();
  await button(dialog, "Close").click();
  await page.waitForFunction(() => document.activeElement?.matches(".xterm-helper-textarea"));
  await helpButton.click();
  await dialog.waitFor();
  await button(dialog, "Close").click();
  await page.waitForFunction(() => document.activeElement?.matches(".xterm-helper-textarea"));
  return { terminal, input };
}

export async function testNativeOptionalStatusBar(page) {
  const tool = await openOptionsWindow(page);
  const options = optionsOf(tool);
  await openStatusSetting(options);
  const checkbox = showStatusBar(options);
  assert.equal(await checkbox.isChecked(), true);
  await checkbox.uncheck();
  await closeToolWindow(tool, () => button(options, "Done").click());
  await page.locator(".statusbar").waitFor({ state: "hidden" });
  const fileGrip = resizeMarker(page, ".actionbar-row");
  await checkResizeMarker(fileGrip);
  await button(page, "Maximize window").click();
  await fileGrip.waitFor({ state: "hidden" });
  await button(page, "Restore window").click();
  await checkResizeMarker(fileGrip);
  await page.getByRole("listbox", { name: "left files", exact: true }).focus();
  const commands = await openMainMenu(page, "Commands");
  await commands.getByRole("menuitemradio", { name: "Environment variables", exact: true }).click();
  await checkResizeMarker(resizeMarker(page, ".app"));
  await button(page, "Back to files").click();
  await checkResizeMarker(fileGrip);
  await page.getByRole("listbox", { name: "left files", exact: true }).press("F12");
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  await page.waitForFunction(() => document.querySelector(".xterm-accessibility-tree")?.textContent.includes("PS "));
  await terminal.locator(".xterm-helper-textarea").pressSequentially("Write-Output 'terminal-help-continued'");
  const { input } = await checkTerminalHint(page, false);
  await input.press("Enter");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("dirlume.command-history") ?? "[]")
    .some(({ text }) => text === "Write-Output 'terminal-help-continued'"));
  if (process.env.DIRLUME_TERMINAL_HINT_CAPTURE) await terminal.locator("header").screenshot({ path: process.env.DIRLUME_TERMINAL_HINT_CAPTURE });
  await button(terminal, "Close terminal").click();
  const restored = await openOptionsWindow(page);
  const restoredOptions = optionsOf(restored);
  await openStatusSetting(restoredOptions);
  await showStatusBar(restoredOptions).check();
  await closeToolWindow(restored, () => button(restoredOptions, "Done").click());
  await checkResizeMarker(resizeMarker(page, ".statusbar"));
  await page.getByRole("listbox", { name: "left files", exact: true }).press("F12");
  await terminal.locator(".xterm-helper-textarea").waitFor({ state: "attached" });
  await checkTerminalHint(page, true);
  await button(terminal, "Close terminal").click();
  console.log("Verified optional status bar, terminal help, and preservation of a PowerShell draft in Windows WebView2.");
}

async function testStatusBar() {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    for (const [platform, userAgent] of [
      ["Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"],
      ["Ubuntu", "Mozilla/5.0 (X11; Linux x86_64)"],
      ["macOS", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"],
    ]) {
      const page = await browser.newPage({ userAgent, viewport: { width: 1040, height: 670 } });
      page.setDefaultTimeout(8000);
      await page.route("http://dirlume.test/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
      });
      await page.addInitScript(() => {
        const home = (/Windows/.test(navigator.userAgent) ? "C:\\fixture\\" : "/fixture/") + "directory-".repeat(12);
        const file = { name: "notes.txt", directory: false, hidden: false, link: false, size: 4, modified: null };
        const callbacks = new Map();
        const events = new Map();
        let next = 0;
        window.statusFixture = {
          resizeCalls: [], maximized: false, fullscreen: false,
          resizeEvent() {
            for (const { event, handler } of events.values()) {
              if (event === "tauri://resize") callbacks.get(handler)?.({ event, payload: { width: innerWidth, height: innerHeight } });
            }
          },
        };
        window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
        window.__TAURI_INTERNALS__ = {
          metadata: { currentWindow: { label: "main" } },
          transformCallback(callback) { callbacks.set(++next, callback); return next; },
          invoke: async (command, args = {}) => {
            switch (command) {
              case "locations": return [{ label: "Home", path: home }];
              case "list_directory": return { path: args.path, parent: null, entries: [file], omitted: 0 };
              case "file_icons": return args.items.map(() => null);
              case "read_text": return { text: "Note", encoding: "utf8" };
              case "copy_path": if (window.statusFixture.copyError) throw new Error("Fixture clipboard error."); return null;
              case "open_terminal": return false;
              case "read_settings_archive": return window.statusFixture.imported ?? null;
              case "write_settings_archive": window.statusFixture.exported = JSON.parse(args.contents); return true;
              case "plugin:window|is_resizable": return true;
              case "plugin:window|is_maximized": return window.statusFixture.maximized;
              case "plugin:window|is_fullscreen": return window.statusFixture.fullscreen;
              case "plugin:event|listen": events.set(++next, args); return next;
              case "plugin:event|unlisten": events.delete(args.eventId); return null;
              case "plugin:window|set_size":
              case "plugin:window|start_resize_dragging": window.statusFixture.resizeCalls.push(command); return null;
              default: return null;
            }
          },
        };
      });
      await page.goto("http://dirlume.test/");
      const status = page.locator(".statusbar");
      const workspace = page.locator(".workspace");
      const list = page.getByRole("listbox", { name: "left files", exact: true });
      const actions = page.getByRole("navigation", { name: "File actions", exact: true });
      const fileGrip = resizeMarker(page, ".actionbar-row");
      const originalHeight = (await workspace.boundingBox()).height;
      await status.waitFor();
      await button(page, "Options").click();
      const options = optionsOf(page);
      await openStatusSetting(options);
      assert.equal(await showStatusBar(options).isChecked(), true);
      await showStatusBar(options).uncheck();
      await page.evaluate(() => { window.isTauri = true; });
      await button(options, "Apply").click();
      await status.waitFor({ state: "hidden" });
      await button(options, "Done").click();
      await options.waitFor({ state: "hidden" });
      assert.equal((await workspace.boundingBox()).height - originalHeight, 28);

      await page.setViewportSize({ width: 600, height: 560 });
      await checkResizeMarker(fileGrip);
      const bounds = await fileGrip.boundingBox();
      const actionsBounds = await actions.boundingBox();
      assert.ok(actionsBounds.x + actionsBounds.width <= bounds.x + 1);
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width / 2 - 10, bounds.y + bounds.height / 2 - 10);
      await page.mouse.up();
      await page.waitForFunction((command) => window.statusFixture.resizeCalls.includes(command),
        platform === "macOS" ? "plugin:window|set_size" : "plugin:window|start_resize_dragging");
      await page.evaluate(() => { window.statusFixture.maximized = true; window.statusFixture.resizeEvent(); });
      await fileGrip.waitFor({ state: "hidden" });
      await page.evaluate(() => { window.statusFixture.maximized = false; window.statusFixture.resizeEvent(); });
      await fileGrip.waitFor();
      await page.evaluate(() => { window.statusFixture.fullscreen = true; window.statusFixture.resizeEvent(); });
      await fileGrip.waitFor({ state: "hidden" });
      await page.evaluate(() => { window.statusFixture.fullscreen = false; window.statusFixture.resizeEvent(); });
      await fileGrip.waitFor();

      const copyPath = platform === "macOS" ? "Meta+Shift+c" : "Control+Shift+c";
      await list.getByRole("option", { name: /^notes\.txt/ }).click();
      await list.press(copyPath);
      const confirmation = page.locator(".workspace-confirmation[role=status]");
      await confirmation.getByText("Path copied to the clipboard.", { exact: true }).waitFor();
      assert.ok(await list.evaluate((element) => element === document.activeElement));
      await page.evaluate(() => { window.statusFixture.copyError = true; });
      await list.press(copyPath);
      const alert = page.locator(".workspace-errors[role=alert]").filter({ hasText: "Fixture clipboard error." });
      await alert.waitFor();
      assert.ok(await list.evaluate((element) => element === document.activeElement));
      await confirmation.getByText("Path copied to the clipboard.", { exact: true }).waitFor({ state: "hidden" });
      assert.ok(await alert.isVisible());
      await button(alert, "Dismiss error").click();
      await alert.waitFor({ state: "hidden" });

      await list.press("F3");
      await checkResizeMarker(resizeMarker(page, ".document-bar-row"));
      await page.locator('.text-window[aria-label="notes.txt"]').press("F10");
      await fileGrip.waitFor();
      await list.press("F12");
      const terminal = page.getByRole("region", { name: "Terminal", exact: true });
      const hint = terminal.getByRole("status").filter({ hasText: "File shortcuts paused." });
      await hint.waitFor();
      assert.ok(await terminal.locator(".xterm-helper-textarea").evaluate((input) => input === document.activeElement));
      const { input } = await checkTerminalHint(page, false);
      await input.press(platform === "macOS" ? "Meta+o" : "Control+o");
      await terminal.locator("header").getByRole("status").filter({ hasText: "Use the Terminal button to return to files." }).waitFor()
        .catch(async (failure) => { throw new Error(await page.locator(".app").evaluate((app) =>
          JSON.stringify({ app: app.className, statusBar: app.dataset.statusBar, documentFocus: document.hasFocus(),
            focus: document.activeElement?.outerHTML.slice(0, 200), hint: app.querySelector(".terminal-shortcut-hint")?.outerHTML,
            header: app.querySelector(".terminal-card header")?.textContent })),
          { cause: failure }); });
      await page.getByRole("navigation", { name: "File actions" }).getByRole("button", { name: "Terminal", exact: true }).click();
      await list.press("F12");
      await hint.waitFor();
      await button(terminal, "Close terminal").click();
      await hint.waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Command line");
      await list.focus();
      const commands = await openMainMenu(page, "Commands");
      await commands.getByRole("menuitemradio", { name: "Environment variables", exact: true }).click();
      await checkResizeMarker(resizeMarker(page, ".app"));
      await button(page, "Back to files").click();
      await fileGrip.waitFor();

      await page.reload();
      await status.waitFor({ state: "hidden" });
      await button(page, "Options").click();
      await openStatusSetting(options);
      assert.equal(await showStatusBar(options).isChecked(), false);
      await settingsArchiveAction(options, "Export settings");
      await button(page.getByRole("dialog", { name: "Export settings", exact: true }), "Export").click();
      await page.waitForFunction(() => Boolean(window.statusFixture.exported));
      assert.equal(await page.evaluate(() => window.statusFixture.exported.groups.appearance.showStatusBar), false);
      await showStatusBar(options).check();
      await button(options, "Apply").click();
      await status.waitFor();
      await button(options, "Done").click();
      await list.press("F12");
      await terminal.locator(".xterm-helper-textarea").waitFor({ state: "attached" });
      await checkTerminalHint(page, true);
      await button(terminal, "Close terminal").click();
      await button(page, "Options").click();
      await page.evaluate(() => { window.statusFixture.imported = JSON.stringify(window.statusFixture.exported); });
      await settingsArchiveAction(options, "Import settings");
      await button(page.getByRole("dialog", { name: "Import settings", exact: true }), "Import").click();
      await status.waitFor({ state: "hidden" });
      await page.close();
      console.log(`Verified status bar placement, feedback, settings archives, and resize commands with ${platform} client settings.`);
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testStatusBar();
