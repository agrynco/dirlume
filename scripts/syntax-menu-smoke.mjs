import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

export async function testSyntaxMenu() {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 880, height: 550 } });
    page.setDefaultTimeout(8000);
    await page.route("http://dirlume.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    await page.addInitScript(() => {
      const path = "/fixture";
      const entry = { name: "source.txt", directory: false, link: false, hidden: false, size: 30, modified: null };
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args) => {
          if (command === "locations") return [{ label: "Home", path }];
          if (command === "list_directory") return { path, parent: null, entries: [entry], omitted: 0 };
          if (command === "file_icons") return args.items.map(() => null);
          if (command === "read_text") return { text: "fn main() { let ready = true; }", encoding: "utf8" };
          return null;
        },
      };
    });
    await page.goto("http://dirlume.test/");
    const list = page.getByRole("listbox", { name: "left files", exact: true });
    const file = list.getByRole("option", { name: /^source.txt/ });
    const document = page.getByRole("region", { name: "source.txt", exact: true });
    const bar = document.getByRole("menubar", { name: "Document menu", exact: true });
    const syntax = bar.getByRole("menuitem", { name: "Syntax", exact: true });
    const choose = bar.getByRole("menuitem", { name: "Choose syntax…", exact: true });
    const menu = bar.getByRole("menu", { name: "Choose syntax…", exact: true });
    const selector = document.getByRole("combobox", { name: "Syntax", exact: true });
    const tokens = document.locator(".syntax-keyword").filter({ hasText: /^fn$/ });

    await file.click();
    await list.press("F4");
    await selector.waitFor();
    await syntax.click();
    await choose.click();
    assert.deepEqual(await menu.getByRole("menuitem").allTextContents(),
      await selector.locator("option").evaluateAll((options) => options.slice(2).map((option) => option.value)));
    await menu.getByRole("menuitem", { name: "Rust", exact: true }).click();
    await tokens.waitFor();
    assert.equal(await selector.inputValue(), "Rust");
    await syntax.click();
    await bar.getByRole("menuitem", { name: "Plain text", exact: true }).click();
    assert.equal(await selector.inputValue(), "plain");
    await tokens.waitFor({ state: "hidden" });
    await document.getByRole("button", { name: "Close document", exact: true }).click();

    await file.click();
    await list.press("F3");
    await selector.waitFor();
    await syntax.click();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowRight");
    await menu.waitFor();
    await page.keyboard.press("ArrowLeft");
    await menu.waitFor({ state: "hidden" });
    assert.equal(await choose.evaluate((item) => item === item.ownerDocument.activeElement), true);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("End");
    const lastLanguage = await menu.getByRole("menuitem").last().textContent();
    await page.keyboard.press("Enter");
    await menu.waitFor({ state: "hidden" });
    assert.equal(await selector.inputValue(), lastLanguage);
    await syntax.click();
    await bar.getByRole("menuitem", { name: "Automatic", exact: true }).click();
    assert.equal(await selector.inputValue(), "auto");
    console.log("Verified syntax submenu selection with mouse and keyboard in the editor and viewer.");
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testSyntaxMenu();
