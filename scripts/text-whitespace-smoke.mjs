import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const original = "a\tlet value = 1;  \t\n" + "\tIndented line  \n".repeat(100);
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, colorScheme: "light" });
  page.setDefaultTimeout(8000);
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  await page.addInitScript((original) => {
    const path = /Windows/.test(navigator.userAgent) ? "C:\\fixture" : "/fixture";
    const files = { "sample.rs": original, "guide.md": "# Guide\n\na\tline  \n", "large.txt": "" };
    const pages = ["a\tpage one  \n", "a\tpage two  \n"];
    const entries = Object.entries(files).map(([name, text]) => ({
      name, directory: false, link: false, hidden: false, size: text.length, modified: null,
    }));
    if (!localStorage.getItem("dirlume.preferences.v1")) {
      localStorage.setItem("dirlume.preferences.v1", JSON.stringify({ theme: "system" }));
    }
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => { window.copiedText = text; } } });
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args) => {
        if (command === "locations") return [{ label: "Home", path }];
        if (command === "list_directory") return { path, parent: null, entries, omitted: 0 };
        if (command === "file_icons") return args.items.map(() => null);
        if (command === "read_text") return { text: files[args.name], encoding: "utf8" };
        if (command === "save_text") {
          window.savedText = files[args.name] = args.text;
          return null;
        }
        if (command === "open_local_text_pages" && args.name === "large.txt") {
          return { id: 71, encoding: "utf8", length: 9 * 1024 * 1024, pageCount: pages.length };
        }
        if (command === "read_text_page") return { text: pages[args.index],
          original: { start: args.index * 131072, end: (args.index + 1) * 131072 } };
        if (command === "read_bytes") return { length: 10, data: Array(10).fill(65) };
        if (command === "installed_fonts") return [];
        if (command === "copy_path") window.copiedText = args.path;
        return null;
      },
    };
  }, original);
  await page.goto("http://dirlume.test/");
  const pane = page.locator("#left-files");
  const document = page.locator(".text-window:not([hidden])");
  const content = document.locator(".cm-content");
  const scroller = document.locator(".cm-scroller");
  const button = (scope, name) => scope.getByRole("button", { name, exact: true });
  const menu = document.getByRole("menubar", { name: "Document menu" });
  const action = async (group, item, checkable = false) => {
    await menu.getByRole("menuitem", { name: group, exact: true }).press("ArrowDown");
    return menu.getByRole("menu", { name: group, exact: true })
      .getByRole(checkable ? "menuitemcheckbox" : "menuitem", { name: item, exact: true });
  };
  const toggle = async (before) => {
    const checkbox = await action("Display", "Show whitespace", true);
    assert.equal(await checkbox.getAttribute("aria-checked"), String(before));
    await checkbox.press("Enter");
  };
  const openFile = async (name, key = "F3") => {
    await pane.locator(`.file-row[data-tooltip="${name}"]`).click();
    await pane.press(key);
  };
  const closeFile = () => button(document, "Close document").click();
  async function setTabWidth(mode, before, after) {
    await button(document, mode + " options").click();
    const settings = page.getByRole("dialog", { name: "Options", exact: true });
    const field = settings.getByRole("spinbutton", { name: "Tab width", exact: true });
    assert.equal(await field.inputValue(), String(before));
    await field.fill(String(after));
    await button(settings, "Done").click();
  }
  async function checkTabStop(columns) {
    await page.waitForFunction((columns) => {
      const line = window.document.querySelector(".text-window:not([hidden]) .cm-line");
      if (!line || !line.textContent.startsWith("a\t")) return false;
      const walker = window.document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      const rect = (index) => {
        walker.currentNode = line;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (index >= node.length) { index -= node.length; continue; }
          const range = window.document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          return range.getBoundingClientRect();
        }
        return null;
      };
      const first = rect(0);
      const afterTab = rect(2);
      return first?.width > 0 && Math.abs((afterTab?.left - first.left) / first.width - columns) < 0.2;
    }, columns);
  }
  const waitMarkers = () => content.locator(".cm-highlightTab").first().waitFor();
  const markerColor = () => content.locator(".cm-highlightTab").first().evaluate((node) => getComputedStyle(node).backgroundImage);
  const waitScrollPosition = async (position) => {
    const element = await scroller.elementHandle();
    await page.waitForFunction(({ element, position }) => Math.abs(element.scrollTop - position) <= 1, { element, position });
  };

  await openFile("sample.rs");
  await checkTabStop(4);
  assert.equal(await content.locator(".cm-highlightTab, .cm-highlightSpace").count(), 0);
  await toggle(false);
  await waitMarkers();
  await checkTabStop(4);
  const firstLine = content.locator(".cm-line").first();
  assert.equal(await firstLine.locator(".cm-highlightTab").count(), 2);
  assert.ok(await firstLine.locator(".cm-highlightSpace").count() >= 2);
  await content.locator(".syntax-keyword").getByText("let", { exact: true }).waitFor();
  const light = await markerColor();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction((light) =>
    getComputedStyle(window.document.querySelector(".cm-highlightTab")).backgroundImage !== light, light);
  await setTabWidth("Viewer", 4, 2);
  await checkTabStop(2);

  await scroller.press("F6");
  await content.locator("xpath=self::*[@contenteditable='true']").waitFor();
  await checkTabStop(2);
  assert.equal(await document.locator(".document-modified").count(), 0);
  await setTabWidth("Editor", 2, 8);
  await checkTabStop(8);
  await content.press("Home");
  await page.keyboard.insertText("Unsaved ");
  await document.getByText("Modified", { exact: true }).waitFor();
  await content.press("Shift+ArrowLeft");
  await content.press("Shift+ArrowLeft");
  // Let the selection update finish, then scroll as a reader would with the caret left behind.
  await scroller.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await scroller.hover({ position: { x: 300, y: 150 } });
  await page.mouse.wheel(0, 260);
  await page.waitForFunction((element) => element.scrollTop > 100, await scroller.elementHandle());
  const top = await scroller.evaluate((node) => node.scrollTop);
  await toggle(true);
  await content.locator(".cm-highlightTab").first().waitFor({ state: "detached" });
  await waitScrollPosition(top);
  await setTabWidth("Editor", 8, 4);
  await page.waitForFunction(() => getComputedStyle(window.document.querySelector(".text-window:not([hidden]) .cm-content")).tabSize === "4");
  await waitScrollPosition(top);
  await (await action("Edit", "Copy")).press("Enter");
  assert.equal(await page.evaluate(() => window.copiedText), "d ");
  await setTabWidth("Editor", 4, 8);
  await (await action("Edit", "Undo")).press("Enter");
  await document.getByText("Modified", { exact: true }).waitFor({ state: "detached" });
  await checkTabStop(8);
  await toggle(false);
  await waitMarkers();
  await content.press("End");
  await page.keyboard.insertText("updated");
  await (await action("File", "Save")).press("Enter");
  assert.equal(await page.evaluate(() => window.savedText), original.replace("\n", "updated\n"));
  await closeFile();
  if (await page.locator(".text-window:not([hidden])").count()) await closeFile();

  await openFile("guide.md");
  await document.locator(".markdown").waitFor();
  assert.equal(await menu.getByRole("menuitem", { name: "Display", exact: true }).count(), 0);
  await button(document, "Source").click();
  await waitMarkers();
  await closeFile();

  await openFile("large.txt");
  await checkTabStop(8);
  await waitMarkers();
  await button(document, "Next page").click();
  await content.getByText("page two", { exact: false }).first().waitFor();
  await checkTabStop(8);
  await waitMarkers();
  await button(document, "Hex").click();
  assert.equal(await menu.getByRole("menuitem", { name: "Display", exact: true }).count(), 0);
  await closeFile();

  await page.reload();
  await openFile("sample.rs");
  await checkTabStop(8);
  await waitMarkers();
  console.log("Verified shared tab stops, whitespace markers, unchanged text and edits, and persistence in source and paged documents.");
} finally {
  await browser.close();
}
