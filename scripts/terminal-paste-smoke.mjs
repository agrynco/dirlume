import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

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
        window.terminalPaste = { writes: [], reads: 0, filePastes: 0 };
        window.__TAURI_INTERNALS__ = {
          transformCallback: () => 1,
          invoke: async (command, args) => {
            if (command === "locations") return [{ label: "Home", path }];
            if (command === "list_directory") return { path, parent: null, entries: [file], omitted: 0 };
            if (command === "file_icons") return args.items.map(() => null);
            if (command === "open_terminal") return false;
            if (command === "clipboard_text") {
              if (window.terminalPaste.clipboardError) throw new Error("Fixture clipboard unavailable.");
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
        await sources.getByRole("button", { name: "SSH", exact: true }).waitFor();
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
      await paneHint.waitFor();
      assert.equal(await paneHint.getAttribute("aria-live"), "polite");
      assert.equal(await paneHint.getAttribute("tabindex"), null);
      await status.getByText("Ready", { exact: true }).waitFor();
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
        const options = page.getByRole("dialog", { name: "Options", exact: true });
        const openOptions = () => page.getByRole("button", { name: "Options", exact: true }).click();
        await openOptions();
        await options.getByRole("button", { name: "Terminal", exact: true }).click();
        const rightClick = options.getByRole("checkbox", { name: "Paste on right-click", exact: true });
        assert.equal(await rightClick.isChecked(), true);
        await rightClick.uncheck();
        await options.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
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
        await openOptions();
        await options.getByRole("button", { name: "Terminal", exact: true }).click();
        assert.equal(await rightClick.isChecked(), false);
      }
      await page.close();
    }
    console.log("Verified terminal focus hints, shortcut routing, and clipboard paste with Windows, Linux, and macOS client settings.");
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testTerminalPaste();
