import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { openMainMenu } from "./menu-header-smoke.mjs";

const browser = await chromium.launch({ channel: "chrome" });
const button = (scope, name) => scope.getByRole("button", { name, exact: true });
try {
  const page = await browser.newPage({ viewport: { width: 1060, height: 710 } });
  page.setDefaultTimeout(8000);
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  await page.addInitScript(() => {
    const root = /Windows/i.test(navigator.userAgent) ? "C:\\fixture" : "/fixture";
    const entries = ["service.log", "reader.md"].map((name) => ({ name, directory: false, link: false, hidden: false,
      size: 45, modified: null, readOnly: true }));
    entries.push({ name: "other", directory: true, link: false, hidden: false, size: null, modified: null, readOnly: true });
    window.bookmarkFixture = {
      "service.log": Array.from({ length: 160 }, (_, i) => "Noise " + (i + 1)).join("\n"),
      "reader.md": "# Heading\n\nBookmarks work in Source.\n\n" +
        "First copy before [linked text](https://example.invalid) and `formatted code` first copy after.\n\n" +
        Array.from({ length: 55 }, (_, i) => `Filler paragraph ${i}.\n\n`).join("") +
        "Second copy before [linked text](https://example.invalid) and `formatted code` second copy after.",
    };
    window.bookmarkWrites = 0;
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args) => {
        if (command === "locations") return [{ label: "Home", path: root }];
        if (command === "list_directory") return { path: args.path, parent: null,
          entries: args.path === root ? entries : [], omitted: 0 };
        if (command === "file_icons") return [];
        if (command === "read_text") {
          if (!Object.hasOwn(window.bookmarkFixture, args.name)) throw new Error("The fixture file was moved.");
          return { text: window.bookmarkFixture[args.name], encoding: "utf8" };
        }
        if (command === "save_text") window.bookmarkWrites++;
        return null;
      },
    };
  });
  await page.goto("http://dirlume.test/");
  const store = () => page.evaluate(() => JSON.parse(localStorage.getItem("dirlume.file-bookmarks.v1")));
  const pane = page.getByRole("listbox", { name: "left files", exact: true });
  const row = (name) => pane.locator("[data-tooltip=" + JSON.stringify(name) + "]");
  const viewer = page.locator(".text-window[data-editing=false]:visible");
  const editor = page.locator(".text-window[data-editing=true]:visible");
  const scroller = viewer.locator(".cm-scroller");
  const markers = viewer.locator(".cm-file-bookmarks .cm-line-bookmarked");
  const list = page.getByRole("dialog", { name: "File bookmarks", exact: true });
  const options = list.getByRole("listbox");
  const openSelected = async () => {
    await options.press("Enter");
    assert.ok(await list.isVisible(), "Opening a bookmark leaves the window open.");
    await button(list, "Close").click();
  };
  const bookmark = (line) => options.getByRole("option").filter({ has: page.getByText("Line " + line, { exact: true }) });
  const commands = async () => {
    const menu = await openMainMenu(page, "Commands");
    await menu.getByRole("menuitem", { name: "File bookmarks", exact: true }).click();
  };
  const show = async (name, key = "F3") => { await row(name).click(); await pane.press(key); };
  const closeViewer = () => button(viewer, "Close document").click();
  const mainFiles = () => page.getByRole("navigation", { name: "Open documents" }).getByRole("button", { name: "Files", exact: true }).click();
  const defaultModifier = await page.evaluate(() => /Macintosh/.test(navigator.userAgent) ? "Meta" : "Control");
  const addKey = defaultModifier + "+Alt+b";
  const awaitLine = async (text) => {
    const viewportHandle = await scroller.elementHandle();
    try {
      // CodeMirror can render an offscreen line before completing the bookmark scroll.
      await page.waitForFunction(({ scroller, text }) => {
        const viewport = scroller.getBoundingClientRect();
        return Array.from(scroller.querySelectorAll(".cm-line")).some((line) => {
          if (line.textContent !== text) return false;
          const { top, bottom } = line.getBoundingClientRect();
          return top >= viewport.top && bottom <= viewport.bottom;
        });
      }, { scroller: viewportHandle, text });
    } finally {
      await viewportHandle.dispose();
    }
  };
  await pane.press(defaultModifier + "+Shift+b");
  await list.getByText(/Click beside a line number/).waitFor();
  await button(list, "Close").click();

  await show("service.log");
  const gutter = viewer.locator(".cm-file-bookmarks .cm-gutterElement");
  await gutter.nth(1).click();
  await markers.first().waitFor();
  await gutter.nth(1).click();
  assert.equal((await store()).length, 1);
  assert.equal((await store())[0].line, 2);
  assert.equal(await viewer.getByText("Noise 2", { exact: true }).count(), 1);

  await scroller.evaluate((node) => {
    const height = node.querySelector(".cm-line").getBoundingClientRect().height;
    node.scrollTop = height * 68 + 3;
  });
  await viewer.getByText("Noise 70", { exact: true }).waitFor();
  const visible = await scroller.evaluate((node) => {
    const viewport = node.getBoundingClientRect();
    const first = [...node.querySelectorAll(".cm-line")].find((line) => {
      const { top, bottom } = line.getBoundingClientRect();
      return top >= viewport.top && bottom <= viewport.bottom;
    });
    return Number(first.textContent.slice(6));
  });
  await scroller.press(addKey);
  await page.waitForFunction((line) => JSON.parse(localStorage.getItem("dirlume.file-bookmarks.v1")).some((item) => item.line === line), visible);

  await button(viewer, "File bookmarks").click();
  assert.deepEqual((await options.getByRole("option").allTextContents()).map((value) => Number(value.match(/Line (\d+)$/)[1])), [2, visible]);
  await button(list, "Rename").click();
  const rename = page.getByRole("dialog", { name: "Rename bookmark", exact: true });
  await rename.getByRole("textbox", { name: "Bookmark name", exact: true }).fill("First timeout");
  await button(rename, "Save").click();
  await bookmark(2).getByText("First timeout").waitFor();
  if (process.env.DIRLUME_BOOKMARKS_SCREENSHOT) await list.screenshot({ path: process.env.DIRLUME_BOOKMARKS_SCREENSHOT });
  const title = list.getByRole("heading", { name: "File bookmarks", exact: true });
  const beforeDrag = await title.boundingBox();
  await page.mouse.move(beforeDrag.x + 24, beforeDrag.y + 8);
  await page.mouse.down();
  await page.mouse.move(beforeDrag.x - 28, beforeDrag.y + 72, { steps: 5 });
  await page.mouse.up();
  const afterDrag = await title.boundingBox();
  assert.ok(afterDrag.x < beforeDrag.x && afterDrag.y > beforeDrag.y);
  await options.press("End");
  await options.press("Enter");
  await awaitLine("Noise " + visible);
  assert.equal(await page.getByRole("navigation", { name: "Open documents" }).getByRole("button", { name: "View service.log", exact: true }).count(), 1);

  await mainFiles();
  assert.ok(await pane.isVisible() && await list.isVisible());
  await show("service.log", "F4");
  await editor.getByRole("textbox", { name: "Edit service.log", exact: true }).fill("Unsaved editor draft");
  await mainFiles();
  await commands();
  await bookmark(2).click();
  await openSelected();
  await awaitLine("Noise 2");
  await page.getByRole("navigation", { name: "Open documents" }).getByRole("button", { name: "Edit service.log", exact: true }).click();
  await editor.getByText("Unsaved editor draft", { exact: true }).waitFor();
  await button(editor, "Close document").click();
  await button(page.getByRole("dialog", { name: "Unsaved changes", exact: true }), "Discard changes").click();
  await page.getByRole("navigation", { name: "Open documents" }).getByRole("button", { name: "View service.log", exact: true }).click();
  await closeViewer();

  await show("reader.md");
  await viewer.press(defaultModifier + "+Shift+b");
  await options.getByRole("group", { name: /service\.log/ }).waitFor();
  assert.equal(await options.getByRole("group").count(), 1);
  await button(list, "Close").click();
  const markdown = viewer.locator(".markdown");
  const quote = "linked text and formatted code";
  const storedPreview = () => page.waitForFunction((quote) => {
    const bookmarks = JSON.parse(localStorage.getItem("dirlume.file-bookmarks.v1"));
    return bookmarks.filter((bookmark) => bookmark.anchor?.quote === quote).length === 1;
  }, quote);
  const selectPassage = () => markdown.evaluate(async (surface) => {
    surface.focus({ preventScroll: true });
    const paragraph = Array.from(surface.querySelectorAll("p")).find((item) => item.textContent.startsWith("Second copy before"));
    const link = paragraph.querySelector("a").firstChild;
    const code = paragraph.querySelector("code").firstChild;
    paragraph.scrollIntoView({ block: "center" });
    const range = document.createRange();
    range.setStart(link, 0);
    range.setEnd(code, code.length);
    const selection = window.getSelection();
    const selectionChanged = new Promise((resolve) => document.addEventListener("selectionchange", resolve, { once: true }));
    selection.removeAllRanges();
    selection.addRange(range);
    await selectionChanged;
    await new Promise(requestAnimationFrame);
  });
  await markdown.getByText(/Second copy before/).waitFor();
  await selectPassage();
  await page.keyboard.press(addKey);
  await storedPreview();
  await selectPassage();
  const documentNav = viewer.getByRole("menubar", { name: "Document menu" });
  await documentNav.getByRole("menuitem", { name: "Navigate", exact: true }).click();
  await viewer.getByRole("menuitem", { name: "Bookmark selection", exact: true }).click();
  await storedPreview();
  await button(viewer, "File bookmarks").click();
  assert.equal(await options.getByRole("group").count(), 2);
  const previewBookmark = options.getByRole("option").filter({ has: page.getByText("Preview", { exact: true }) });
  await previewBookmark.getByText(quote, { exact: true }).waitFor();
  await button(list, "Rename").click();
  await rename.getByRole("textbox", { name: "Bookmark name", exact: true }).fill("Second passage");
  await button(rename, "Save").click();
  await previewBookmark.getByText("Second passage", { exact: true }).waitFor();
  await button(list, "Close").click();
  await button(viewer, "Source").click();
  await viewer.locator(".cm-file-bookmarks .cm-gutterElement").nth(2).click();
  await closeViewer();
  const root = await page.locator("#left-path").getAttribute("data-path");
  const other = root + (root.includes("\\") ? "\\other" : "/other");
  await row("other").dblclick();
  await page.waitForFunction((path) => {
    const workspace = JSON.parse(localStorage.getItem("dirlume.workspace.v1"));
    return workspace?.panels.left.place?.path === path && workspace.documents.length === 0;
  }, other);
  await page.reload();
  await page.waitForFunction((path) => document.getElementById("left-path")?.dataset.path === path, other);
  await commands();
  await bookmark(3).click();
  await openSelected();
  await awaitLine("Bookmarks work in Source.");
  await markers.first().waitFor();
  await closeViewer();

  await page.evaluate(() => { window.bookmarkFixture["reader.md"] = "A paragraph inserted above.\n\n" + window.bookmarkFixture["reader.md"]; });
  await page.setViewportSize({ width: 840, height: 620 });
  await commands();
  await previewBookmark.getByText("Second passage", { exact: true }).click();
  await openSelected();
  await page.waitForFunction((quote) => {
    const surface = document.querySelector(".text-window:not([hidden]) .markdown");
    const range = [...(CSS.highlights?.get("markdown-bookmark") ?? [])][0] ?? window.getSelection()?.getRangeAt(0);
    if (!surface || !range || range.toString() !== quote) return false;
    const marker = range.startContainer.parentElement.closest("p");
    const position = range.getBoundingClientRect();
    const viewport = surface.getBoundingClientRect();
    return marker.textContent.startsWith("Second copy before") && position.top >= viewport.top && position.bottom <= viewport.bottom;
  }, quote);
  await closeViewer();
  await page.evaluate(() => { window.bookmarkFixture["reader.md"] = "# A different passage"; });
  await commands();
  await previewBookmark.getByText("Second passage", { exact: true }).click();
  await openSelected();
  await viewer.getByText("Could not locate the bookmarked passage.", { exact: true }).waitFor();
  await closeViewer();

  await page.evaluate(() => { window.bookmarkFixture["service.log"] += "\nAppended"; });
  await commands();
  await bookmark(visible).click();
  await openSelected();
  await awaitLine("Noise " + visible);
  assert.equal(await viewer.getByText(/since it was bookmarked|past the end of the file/).count(), 0);
  await closeViewer();

  await page.evaluate(() => { window.bookmarkFixture["service.log"] = "Noise 1\nUpdated second line"; });
  await commands();
  await bookmark(2).click();
  await openSelected();
  await viewer.getByText("Line 2 has changed since it was bookmarked.", { exact: true }).waitFor();
  await closeViewer();
  await commands();
  await bookmark(visible).click();
  await openSelected();
  await viewer.getByText("Bookmark line " + visible + " is past the end of the file. Showing line 2.", { exact: true }).waitFor();
  await closeViewer();

  await page.evaluate(() => { delete window.bookmarkFixture["service.log"]; });
  await commands();
  await bookmark(visible).click();
  await openSelected();
  await viewer.getByRole("alert").getByText(/The fixture file was moved/).waitFor();
  await viewer.getByRole("heading", { name: /service\.log/ }).waitFor();
  await closeViewer();
  await commands();
  await bookmark(visible).click();
  await button(list, "Remove").click();
  assert.ok((await store()).every((item) => item.line !== visible));
  assert.equal(await page.evaluate(() => window.bookmarkWrites), 0);
  await button(list, "Close").click();
  await page.reload();
  await commands();
  assert.equal(await bookmark(visible).count(), 0);
  await bookmark(2).getByText("First timeout").waitFor();
  console.log("Verified bookmarks, viewport fallback, persistence, editor draft isolation, Markdown source, changed and missing lines, and file errors.");
} finally {
  await browser.close();
}
