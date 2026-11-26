import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

async function checkTerminalMenu(page, terminal, mac, { native = false, copyKey = mac ? "Meta+c" : "Control+Shift+c" } = {}) {
  const input = terminal.locator(".xterm-helper-textarea");
  const surface = terminal.locator(".terminal-surface");
  const menu = page.getByRole("menu", { name: "Terminal actions", exact: true });
  const item = (name) => menu.getByRole("menuitem", { name, exact: true });
  const isFocused = (node) => node.evaluate((element) => element === document.activeElement);
  const secondaryClick = () => surface.click(mac ? { modifiers: ["Control"] } : { button: "right" });
  const focused = () => page.waitForFunction(() => document.activeElement?.matches(".xterm-helper-textarea"));
  await terminal.locator(".xterm-rows").getByText("selection second", { exact: true }).waitFor();
  if (!native) {
    await input.press(copyKey);
    assert.deepEqual(await page.evaluate(() => window.terminalPaste.copies), []);
    await input.press("Control+c");
    await page.waitForFunction(() => window.terminalPaste.writes.includes("\x03"));
  }
  // Some desktop WebViews deliver the press without a contextmenu event.
  await surface.dispatchEvent("mousedown", { button: 2, buttons: 2, clientX: 300, clientY: 400 });
  assert.equal(await item("Copy").isDisabled(), true);
  assert.equal(await isFocused(item("Paste")), true);
  await page.keyboard.press("ArrowDown");
  assert.equal(await isFocused(item("Select All")), true);
  await page.keyboard.press("Enter");
  await menu.waitFor({ state: "hidden" });
  await focused();
  if (!native) {
    await input.press(copyKey);
    await page.waitForFunction(() => window.terminalPaste.copies.length === 1);
    const copied = await page.evaluate(() => window.terminalPaste.copies[0]);
    assert.match(copied, /^retained scrollback 1\r?\n/);
    assert.match(copied, /selection first\r?\nselection second/);
  }
  await secondaryClick();
  assert.equal(await item("Copy").isEnabled(), true);
  assert.equal(await isFocused(item("Copy")), true);
  if (native) {
    if (process.env.DIRLUME_TERMINAL_MENU_CAPTURE) await menu.screenshot({ path: process.env.DIRLUME_TERMINAL_MENU_CAPTURE });
    await page.keyboard.press("Escape");
    await focused();
    if (process.env.CI) {
      await input.press(copyKey);
      await page.waitForFunction(async () => /selection first\r?\nselection second/.test(await window.__TAURI_INTERNALS__.invoke("clipboard_text")));
    }
    return;
  }
  await page.keyboard.press("Enter");
  await menu.waitFor({ state: "hidden" });
  await focused();
  await page.waitForFunction(() => window.terminalPaste.copies.length === 2 &&
    window.terminalPaste.copies.at(-1)?.replaceAll("\r\n", "\n").includes("selection first\nselection second"));
  const writes = () => page.evaluate(() => window.terminalPaste.writes.slice());
  const baseline = await writes();
  await secondaryClick();
  await page.keyboard.press("Escape");
  await focused();
  await secondaryClick();
  await page.getByRole("listbox", { name: "left files", exact: true }).click();
  await menu.waitFor({ state: "hidden" });
  assert.deepEqual(await writes(), baseline);

  await page.evaluate(() => { window.terminalPaste.testMenuPaste = true; });
  await secondaryClick();
  await item("Paste").click();
  await focused();
  assert.deepEqual(await writes(), baseline);
  await page.evaluate(() => { window.terminalPaste.clipboardError = true; });
  await secondaryClick();
  await item("Paste").click();
  await page.locator(".statusbar").getByRole("alert").filter({ hasText: "Fixture clipboard unavailable." }).waitFor();
  assert.deepEqual(await writes(), baseline);
  await page.evaluate(() => { window.terminalPaste.clipboardError = false; window.terminalPaste.menuText = "clipboard from menu"; });
  await secondaryClick();
  await item("Paste").click();
  await page.waitForFunction(() => window.terminalPaste.writes.filter((text) => text === "clipboard from menu").length === 1);
  await page.evaluate(() => { window.terminalPaste.testMenuPaste = false; window.terminalPaste.menuText = ""; });
  assert.equal(await isFocused(input), true);
}

export async function testNativeTerminalMenu(page) {
  const list = page.getByRole("listbox", { name: "left files", exact: true });
  await page.waitForFunction(() => document.getElementById("left-path")?.dataset.path &&
    document.getElementById("left-files")?.getAttribute("aria-busy") === "false");
  await list.press("F12");
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  const input = terminal.locator(".xterm-helper-textarea");
  await page.waitForFunction(() => document.querySelector(".xterm-accessibility-tree")?.textContent.includes("PS "));
  await input.pressSequentially("Write-Output 'selection first' 'selection second'");
  await input.press("Enter");
  await checkTerminalMenu(page, terminal, false, { native: true });
  await terminal.getByRole("button", { name: "Close terminal", exact: true }).click();
}

export async function testTerminalPaste() {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const platforms = ["Windows NT 10.0; Win64; x64", "X11; Linux x86_64", "Macintosh; Intel Mac OS X 10_15_7"];
    for (const platform of platforms) {
      const page = await browser.newPage({ userAgent: `Mozilla/5.0 (${platform})`, viewport: { width: 1020, height: 680 } });
      page.setDefaultTimeout(8000);
      await page.route("http://dirlume.test/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
      });
      await page.addInitScript(() => {
        const path = "/fixture";
        const file = { name: "fixture.txt", directory: false, link: false, hidden: false, size: 7, modified: null };
        window.terminalPaste = { writes: [], copies: [], reads: 0, filePastes: 0 };
        window.__TAURI_INTERNALS__ = {
          transformCallback: () => 1,
          invoke: async (command, args) => {
            if (command === "locations") return [{ label: "Home", path }];
            if (command === "list_directory") return { path, parent: null, entries: [file], omitted: 0 };
            if (command === "file_icons") return args.items.map(() => null);
            if (command === "ftp_profiles") return [];
            if (command === "ssh_profiles") return [{ id: "ssh", label: "SSH fixture", host: "fixture", port: 22 }];
            if (command === "connect_ssh") return { kind: "connected", id: 17, address: "fixture", origin: "sftp://fixture",
              segments: ["home"], listing: { entries: [file], omitted: 0, elevated: false } };
            if (command === "open_terminal") {
              if (args.request.ssh) window.terminalPaste.remoteTerminal = true;
              const scrollback = Array.from({ length: 60 }, (_, index) => `retained scrollback ${index + 1}\r\n`).join("");
              args.output.onmessage({ event: "data", data: btoa(scrollback + "selection first\r\nselection second\r\n") });
              return false;
            }
            if (command === "copy_path") { window.terminalPaste.copies.push(args.path); return null; }
            if (command === "clipboard_text") {
              if (window.terminalPaste.clipboardError) throw new Error("Fixture clipboard unavailable.");
              if (window.terminalPaste.testMenuPaste) return window.terminalPaste.menuText ?? "";
              return "clipboard fixture " + ++window.terminalPaste.reads;
            }
            if (command === "clipboard_files") { window.terminalPaste.filePastes++; return []; }
            if (command === "write_terminal") window.terminalPaste.writes.push(args.data);
            return null;
          },
        };
      });
      await page.goto("http://dirlume.test/");
      const list = page.getByRole("listbox", { name: "left files", exact: true });
      if (!platform.startsWith("Windows")) {
        await list.press("Alt+F1");
        const sources = page.locator("#left-pane .location-popup");
        const home = sources.getByRole("button", { name: "Home", exact: true });
        assert.equal(await home.locator("kbd").count(), 0);
        await sources.getByRole("button", { name: "NetBox", exact: true }).waitFor();
        await home.click();
        await sources.waitFor({ state: "hidden" });
      }
      const terminal = page.getByRole("region", { name: "Terminal", exact: true });
      const input = terminal.locator(".xterm-helper-textarea");
      const surface = terminal.locator(".terminal-surface");
      const status = page.locator(".statusbar");
      const paneHint = status.getByRole("status").filter({ hasText: "File shortcuts paused. Click a file pane to use them." });
      const terminalOnlyHint = status.getByRole("status").filter({ hasText: "File shortcuts paused. Use the Terminal button to return to files." });
      const actions = page.getByRole("navigation", { name: "File actions", exact: true });
      const terminalButton = actions.getByRole("button", { name: "Terminal", exact: true });
      const showTerminal = async () => {
        await list.press("F12");
        await terminal.waitFor();
        await input.waitFor({ state: "attached" });
      };
      const pasted = (values) => page.waitForFunction((values) => {
        const actual = window.terminalPaste.writes.filter((data) => data.startsWith("clipboard fixture "));
        return JSON.stringify(actual) === JSON.stringify(values);
      }, values);
      await showTerminal();
      await status.getByText("Ready", { exact: true }).waitFor();
      await checkTerminalMenu(page, terminal, platform.startsWith("Macintosh"));
      const options = page.getByRole("dialog", { name: "Options", exact: true });
      const rightClick = options.getByRole("checkbox", { name: "Paste on right-click", exact: true });
      const openTerminalSettings = async () => {
        await page.getByRole("button", { name: "Options", exact: true }).click();
        await options.getByRole("button", { name: "Terminal", exact: true }).click();
      };
      await openTerminalSettings();
      assert.equal(await rightClick.isChecked(), false);
      await rightClick.check();
      await options.getByRole("button", { name: "Done", exact: true }).click();
      await input.focus();
      await paneHint.waitFor();
      assert.equal(await paneHint.getAttribute("aria-live"), "polite");
      assert.equal(await paneHint.getAttribute("tabindex"), null);
      const copyDialog = page.getByRole("dialog", { name: "Copy", exact: true });
      await input.press("F5");
      assert.equal(await copyDialog.isVisible(), false);
      await actions.getByRole("button", { name: "Copy", exact: true }).click();
      await copyDialog.getByRole("button", { name: "Cancel", exact: true }).click();
      for (const side of ["left", "right"]) {
        await input.focus();
        await paneHint.waitFor();
        await page.getByRole("listbox", { name: side + " files", exact: true })
          .getByRole("option", { name: /^fixture\.txt/ }).click();
        await paneHint.waitFor({ state: "hidden" });
        assert.equal(await terminal.isVisible(), true);
        await page.keyboard.press("F5");
        await copyDialog.getByRole("button", { name: "Cancel", exact: true }).click();
      }
      await input.press(platform.startsWith("Macintosh") ? "Meta+o" : "Control+o");
      await list.waitFor({ state: "hidden" });
      await terminalOnlyHint.waitFor();
      await terminalButton.click();
      await list.waitFor();
      await terminalOnlyHint.waitFor({ state: "hidden" });
      await showTerminal();
      await input.press("Control+v");
      await pasted(["clipboard fixture 1"]);
      await surface.click({ button: "right" });
      await pasted(["clipboard fixture 1", "clipboard fixture 2"]);
      await page.evaluate(() => { window.terminalPaste.clipboardError = true; });
      await input.press("Control+v");
      await status.getByRole("alert").filter({ hasText: "Fixture clipboard unavailable." }).waitFor();
      await paneHint.waitFor();
      await page.evaluate(() => { window.terminalPaste.clipboardError = false; });
      if (platform.startsWith("Windows")) {
        await openTerminalSettings();
        assert.equal(await rightClick.isChecked(), true);
        await rightClick.uncheck();
        await options.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
        await options.getByRole("button", { name: "Remove Ctrl+Shift+C from Copy selected terminal text", exact: true }).click();
        await options.getByRole("button", { name: "Add shortcut for Copy selected terminal text", exact: true }).click();
        await options.getByRole("textbox", { name: "New shortcut for Copy selected terminal text" }).press("Control+Shift+F9");
        await options.getByRole("button", { name: "Remove Ctrl+V from Paste text into terminal", exact: true }).click();
        await options.getByRole("button", { name: "Add shortcut for Paste text into terminal", exact: true }).click();
        await options.getByRole("textbox", { name: "New shortcut for Paste text into terminal" }).press("Control+Shift+v");
        for (const name of ["Remove F12 from Toggle terminal", "Remove Ctrl+↑ from Make the terminal taller",
          "Remove Ctrl+↓ from Make the terminal shorter", "Remove Ctrl+O from Show or hide file panels"]) {
          await options.getByRole("button", { name, exact: true }).click();
        }
        await options.getByRole("button", { name: "Add shortcut for Show or hide file panels", exact: true }).click();
        await options.getByRole("textbox", { name: "New shortcut for Show or hide file panels" }).press("Control+Alt+o");
        await options.getByRole("button", { name: "Done", exact: true }).click();
        await surface.click({ button: "right" });
        const menu = page.getByRole("menu", { name: "Terminal actions", exact: true });
        await menu.getByRole("menuitem", { name: "Select All", exact: true }).click();
        const copied = await page.evaluate(() => window.terminalPaste.copies.length);
        await input.press("Control+Shift+c");
        assert.equal(await page.evaluate(() => window.terminalPaste.copies.length), copied);
        await input.press("Control+Shift+F9");
        await page.waitForFunction((copied) => window.terminalPaste.copies.length === copied + 1, copied);
        await input.press("Control+v");
        assert.equal(await page.evaluate(() => window.terminalPaste.reads), 2);
        await input.press("Control+Shift+v");
        await pasted(["clipboard fixture 1", "clipboard fixture 2", "clipboard fixture 3"]);
        await input.press("Control+Alt+o");
        await terminalOnlyHint.waitFor();
        await terminalButton.click();
        await list.waitFor();
        await terminalOnlyHint.waitFor({ state: "hidden" });
        await terminalButton.click();
        await paneHint.waitFor();
        await terminal.getByRole("button", { name: "Close terminal", exact: true }).click();
        await paneHint.waitFor({ state: "hidden" });
        await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Command line");
        await list.press("Control+v");
        await page.waitForFunction(() => window.terminalPaste.filePastes === 1);
        await page.reload();
        await openTerminalSettings();
        assert.equal(await rightClick.isChecked(), false);
        await options.getByRole("button", { name: "Done", exact: true }).click();
      } else {
        await page.reload();
        await openTerminalSettings();
        assert.equal(await rightClick.isChecked(), true);
        await rightClick.uncheck();
        await options.getByRole("button", { name: "Done", exact: true }).click();
      }
      const right = page.getByRole("listbox", { name: "right files", exact: true });
      await right.press("Alt+F2");
      await page.locator("#right-pane .location-popup").getByRole("button", { name: "NetBox", exact: true }).click();
      await right.getByRole("option", { name: /SSH fixture/ }).dblclick();
      await right.getByRole("option", { name: /^fixture\.txt/ }).waitFor();
      await page.getByRole("button", { name: "Toggle terminal", exact: true }).click();
      await terminal.getByRole("heading", { name: "SSH terminal", exact: true }).waitFor();
      await checkTerminalMenu(page, terminal, platform.startsWith("Macintosh"), {
        copyKey: platform.startsWith("Windows") ? "Control+Shift+F9" : undefined,
      });
      assert.equal(await page.evaluate(() => window.terminalPaste.remoteTerminal), true);
      await page.close();
    }
    console.log("Verified terminal focus, context menu and direct paste in local and SSH sessions with Windows, Linux and macOS client settings.");
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testTerminalPaste();
