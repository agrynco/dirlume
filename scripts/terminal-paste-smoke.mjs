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
        window.terminalPaste = { writes: [], reads: 0, filePastes: 0 };
        window.__TAURI_INTERNALS__ = {
          transformCallback: () => 1,
          invoke: async (command, args) => {
            if (command === "locations") return [{ label: "Home", path }];
            if (command === "list_directory") return { path, parent: null, entries: [], omitted: 0 };
            if (command === "open_terminal") return false;
            if (command === "clipboard_text") return "clipboard fixture " + ++window.terminalPaste.reads;
            if (command === "clipboard_files") { window.terminalPaste.filePastes++; return []; }
            if (command === "write_terminal") window.terminalPaste.writes.push(args.data);
            return null;
          },
        };
      });
      await page.goto("http://dirlume.test/");
      const list = page.getByRole("listbox", { name: "left files", exact: true });
      const terminal = page.getByRole("region", { name: "Terminal", exact: true });
      const input = terminal.locator(".xterm-helper-textarea");
      const surface = terminal.locator(".terminal-surface");
      const showTerminal = async () => {
        await list.press("F12");
        await input.waitFor({ state: "attached" });
      };
      const pasted = (values) => page.waitForFunction((values) => {
        const actual = window.terminalPaste.writes.filter((data) => data.startsWith("clipboard fixture "));
        return JSON.stringify(actual) === JSON.stringify(values);
      }, values);
      await showTerminal();
      await input.press("Control+v");
      await pasted(["clipboard fixture 1"]);
      await surface.click({ button: "right" });
      await pasted(["clipboard fixture 1", "clipboard fixture 2"]);
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
        await options.getByRole("button", { name: "Done", exact: true }).click();
        await surface.click({ button: "right" });
        await input.press("Control+v");
        assert.equal(await page.evaluate(() => window.terminalPaste.reads), 2);
        await input.press("Control+Shift+v");
        await pasted(["clipboard fixture 1", "clipboard fixture 2", "clipboard fixture 3"]);
        await terminal.getByRole("button", { name: "Close terminal", exact: true }).click();
        await list.press("Control+v");
        await page.waitForFunction(() => window.terminalPaste.filePastes === 1);
        await page.reload();
        await openOptions();
        await options.getByRole("button", { name: "Terminal", exact: true }).click();
        assert.equal(await rightClick.isChecked(), false);
      }
      await page.close();
    }
    console.log("Verified the terminal keyboard and mouse paste paths with Windows, Linux, and macOS client settings.");
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testTerminalPaste();
