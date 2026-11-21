import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { closeToolWindow, openOptionsWindow } from "./tool-window-smoke.mjs";

export async function testViewerReadingArea(page, source) {
  const plain = "reader.txt";
  const code = "reader.rs";
  const markdown = "reader.md";
  const short = "reader-short.txt";
  const cells = Array(12).fill('<span style="white-space: nowrap">Long Column Heading</span>').join(" | ");
  const rule = Array(12).fill("---").join(" | ");
  await Promise.all([
    writeFile(join(source, plain), "A plain line for testing the reading area.\n".repeat(250)),
    writeFile(join(source, code), "fn reading_area() {}\n".repeat(250)),
    writeFile(join(source, markdown), `# Reading area fixture\n\n| ${cells} |\n| ${rule} |\n\n` + "Test paragraph.\n\n".repeat(250)),
    writeFile(join(source, short), "A short document.\n"),
  ]);
  const button = (parent, name) => parent.getByRole("button", { name, exact: true });
  const viewer = (name) => page.getByRole("region", { name, exact: true });
  async function open(name) {
    const row = page.locator(`#left-files [role="option"][data-tooltip="${name}"]`);
    await row.click();
    await page.keyboard.press("F3");
    await viewer(name).waitFor();
    return viewer(name);
  }
  const close = (document) => button(document, "Close document").click();
  const plainViewer = await open(plain);
  const tool = await openOptionsWindow(page, () => button(plainViewer, "Viewer options").click());
  const options = tool.getByRole("dialog", { name: "Options", exact: true });
  const search = options.getByRole("searchbox", { name: "Search settings" });
  await search.fill("Outside reading area background");
  await search.press("Enter");
  const outside = options.getByLabel("Outside reading area background hex", { exact: true });
  await outside.fill("#a7437d");
  const sharedWidth = options.getByRole("spinbutton", { name: "Max width (px)", exact: true });
  await sharedWidth.fill("420");
  const apply = () => button(options, "Apply").click();
  await apply();
  const readingWidths = options.getByRole("combobox", { name: "Markdown reading width" });
  assert.equal(await readingWidths.inputValue(), "inherit");
  await search.fill("Markdown reading width");
  await search.press("Enter");
  await readingWidths.selectOption("custom");
  await options.getByRole("spinbutton", { name: "Markdown max width (px)" }).fill("530");
  await closeToolWindow(tool, () => button(options, "Done").click());

  const sourceScroll = ".cm-scroller";
  async function checkScroll(document, selector, width) {
    const viewport = document.locator(selector);
    await viewport.waitFor();
    await page.waitForFunction((selector) => {
      const view = window.document.querySelector(".text-window:not([hidden]) " + selector);
      return view && view.scrollHeight > view.clientHeight + 100;
    }, selector);
    const bounds = await viewport.evaluate((view) => {
      const rect = view.getBoundingClientRect();
      const window = view.closest(".text-window").getBoundingClientRect();
      const style = getComputedStyle(view);
      return {
        right: window.right - rect.right, outside: style.backgroundColor, backgroundSize: style.backgroundSize,
        column: view.querySelector(".markdown-content")?.getBoundingClientRect().width,
      };
    });
    assert.ok(bounds.right <= 2, `${selector} must scroll at the right edge of Viewer.`);
    assert.equal(bounds.outside, "rgb(167, 67, 125)");
    assert.ok(bounds.backgroundSize.includes(`${width}px`), JSON.stringify(bounds));
    if (bounds.column !== undefined) assert.equal(bounds.column, width);
    const scrollTop = () => viewport.evaluate((view) => view.scrollTop);
    await viewport.focus();
    await page.keyboard.press("PageDown");
    await page.waitForFunction((selector) => window.document.querySelector(".text-window:not([hidden]) " + selector)?.scrollTop > 0, selector);
    const box = await viewport.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const previous = await scrollTop();
    await page.mouse.wheel(0, 180);
    await page.waitForFunction(({ selector, previous }) =>
      window.document.querySelector(".text-window:not([hidden]) " + selector)?.scrollTop > previous, { selector, previous });
    const gutter = await viewport.evaluate((view) => (view.offsetWidth - view.clientWidth) / 2);
    if (gutter > 2) {
      await viewport.evaluate((view) => view.scrollTo(0, 0));
      const x = box.x + box.width - gutter / 2;
      await page.mouse.move(x, box.y + 8);
      await page.mouse.down();
      await page.mouse.move(x, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      assert.ok(await scrollTop() > 0, `${selector} should scroll when its scrollbar is dragged.`);
    }
    return viewport;
  }

  await checkScroll(plainViewer, sourceScroll, 420);
  await button(plainViewer.locator(".text-toolbar").first(), "Hex").click();
  const hex = await checkScroll(plainViewer, ".hex-view", 420);
  assert.ok(await hex.evaluate((view) => view.scrollWidth > view.clientWidth && (view.scrollLeft = view.scrollWidth) > 0));
  await close(plainViewer);
  const codeViewer = await open(code);
  await checkScroll(codeViewer, sourceScroll, 420);
  await codeViewer.locator(".syntax-keyword").first().waitFor();
  await close(codeViewer);
  const markdownViewer = await open(markdown);
  const rendered = await checkScroll(markdownViewer, ".markdown", 530);
  assert.ok(await rendered.evaluate((view) => view.scrollWidth > view.clientWidth));
  await button(markdownViewer, "Source").click();
  await checkScroll(markdownViewer, sourceScroll, 420);
  await button(markdownViewer, "Preview").click();
  const reopened = await openOptionsWindow(page, () => button(markdownViewer, "Viewer options").click());
  const restored = reopened.getByRole("dialog", { name: "Options", exact: true });
  const mode = restored.getByRole("combobox", { name: "Markdown reading width" });
  await mode.selectOption("inherit");
  await button(restored, "Apply").click();
  await rendered.evaluate((view) => {
    if (view.querySelector(".markdown-content").getBoundingClientRect().width !== 420) {
      throw new Error("Markdown must inherit the shared reading width after Apply.");
    }
  });
  await mode.selectOption("full");
  await closeToolWindow(reopened, () => button(restored, "Done").click());
  assert.equal(await rendered.evaluate((view) => getComputedStyle(view).backgroundImage), "none");
  await close(markdownViewer);
  const shortViewer = await open(short);
  const scroll = shortViewer.locator(sourceScroll);
  assert.ok(await scroll.evaluate((view) => view.scrollHeight <= view.clientHeight &&
    getComputedStyle(view).backgroundColor === "rgb(167, 67, 125)"));
  const resetTool = await openOptionsWindow(page, () => button(shortViewer, "Viewer options").click());
  const reset = resetTool.getByRole("dialog", { name: "Options", exact: true });
  await button(reset, "Reset outside reading area background").click();
  await closeToolWindow(resetTool, () => button(reset, "Done").click());
  assert.equal(await scroll.evaluate((view) => getComputedStyle(view).backgroundColor), "rgba(0, 0, 0, 0)");
  await close(shortViewer);
  console.log("Verified edge scrollbars, reading widths, and the outside background in all Viewer modes.");
}

export async function testMarkdown(page, source, wheelFont) {
  const catalogue = join(source, "catalogue.md");
  const docs = join(source, "notes folder");
  await mkdir(docs);
  const original = "\uFEFF# Catalogue 📚\r\n\r\n" +
    "- [ ] Main task\r\n  - [X] Nested task\n\n" +
    "~~~markdown\r\n- [ ] Literal example\r\n~~~\r\n\r\n" +
    "```mermaid\nflowchart LR\n  A --> B\n```\n\n" +
    "[Linked notes][notes]\r\n\r\n[notes]: notes%20folder/child.md#target-section\r\n";
  await writeFile(catalogue, original);
  await writeFile(join(docs, "child.md"), [
    "# Linked notes", "", ...Array.from({ length: 50 }, (_, i) => "Paragraph " + i + ".\n"),
    "## Target section", "", "[Return to catalogue](../catalogue.md#catalogue-)", "",
    "[Same document](#linked-notes)", "", "[Next document](last.md)", "",
  ].join("\n"));
  await writeFile(join(docs, "last.md"), "# Last document\n");

  const row = page.getByRole("listbox", { name: "left files", exact: true })
    .getByRole("option", { name: /^catalogue\.md/ });
  const catalogueViewer = page.getByRole("region", { name: "catalogue.md", exact: true });
  const childViewer = page.getByRole("region", { name: "child.md", exact: true });
  const lastViewer = page.getByRole("region", { name: "last.md", exact: true });
  const toolbarButton = (viewer, name) => viewer.locator(".text-toolbar").getByRole("button", { name, exact: true });
  const task = (name, checked) => catalogueViewer.getByRole("checkbox", { name, exact: true, checked });

  async function openCatalogue() {
    await row.click();
    await page.keyboard.press("F3");
    await catalogueViewer.getByRole("heading", { name: "Catalogue 📚", exact: true }).waitFor();
  }

  await openCatalogue();
  assert.equal(await catalogueViewer.locator(".document-heading h2").innerText(), catalogue);
  assert.ok(await toolbarButton(catalogueViewer, "Back").isDisabled());
  assert.ok(await toolbarButton(catalogueViewer, "Forward").isDisabled());
  const diagram = catalogueViewer.getByRole("img", { name: "Mermaid diagram" });
  await diagram.waitFor();
  assert.ok(await diagram.evaluate((image) =>
    image.width <= Number(image.getAttribute("width")) && image.width <= 960 &&
    image.height <= Math.min(640, innerHeight * 0.7) + 1), "A diagram should fit the reader without upscaling.");
  assert.equal(await catalogueViewer.getByRole("checkbox").count(), 2);
  await task("Main task", false).click();
  await task("Main task", true).waitFor();
  await task("Nested task", true).click();
  await task("Nested task", false).waitFor();
  const updated = original.replace("[ ] Main task", "[x] Main task").replace("[X] Nested task", "[ ] Nested task");
  assert.equal(await readFile(catalogue, "utf8"), updated);

  await page.keyboard.press("Escape");
  await catalogueViewer.waitFor({ state: "hidden" });
  await openCatalogue();
  await task("Main task", true).waitFor();
  await task("Nested task", false).waitFor();

  const surface = ".text-window:not([hidden]) .markdown";
  const fontSize = () => page.locator(surface).evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  const initialSize = await fontSize();
  await wheelFont(surface, -120);
  const enlargedSize = await fontSize();
  assert.ok(enlargedSize > initialSize);
  const tabs = page.getByRole("navigation", { name: "Open documents" });
  await catalogueViewer.getByRole("link", { name: "Linked notes", exact: true }).click({ modifiers: ["Control"] });
  await childViewer.getByRole("heading", { name: "Target section", exact: true }).waitFor();
  assert.equal(await fontSize(), enlargedSize);
  assert.equal(await tabs.getByRole("button", { name: "View catalogue.md", exact: true }).count(), 1);
  await childViewer.getByRole("button", { name: "Close document", exact: true }).click();
  await catalogueViewer.waitFor();

  await catalogueViewer.getByRole("link", { name: "Linked notes", exact: true }).click();
  await childViewer.getByRole("heading", { name: "Target section", exact: true }).waitFor();
  assert.equal(await fontSize(), enlargedSize);
  assert.equal(await tabs.getByRole("button", { name: "View catalogue.md", exact: true }).count(), 0);
  await page.waitForFunction(() => document.querySelector(".text-window:not([hidden]) .markdown")?.scrollTop > 100);
  const childOffset = await page.locator(surface).evaluate((element) => element.scrollTop);
  await childViewer.getByRole("link", { name: "Next document", exact: true }).evaluate((link) => link.click());
  await lastViewer.getByRole("heading", { name: "Last document", exact: true }).waitFor();
  await toolbarButton(lastViewer, "Back").click();
  await childViewer.getByRole("heading", { name: "Target section", exact: true }).waitFor();
  assert.equal(await page.locator(surface).evaluate((element) => element.scrollTop), childOffset);
  await toolbarButton(childViewer, "Back").click();
  await toolbarButton(catalogueViewer, "Forward").click();
  await toolbarButton(childViewer, "Forward").click();
  await toolbarButton(lastViewer, "Back").click();
  await toolbarButton(childViewer, "Search").click();
  const search = childViewer.getByRole("searchbox", { name: "Search rendered Markdown" });
  await search.fill("paragraph");
  await childViewer.getByText("1 of 50", { exact: true }).waitFor();
  await search.press("Enter");
  await childViewer.getByText("2 of 50", { exact: true }).waitFor();
  await search.press("Shift+Enter");
  await childViewer.getByText("1 of 50", { exact: true }).waitFor();
  await search.press("Escape");
  await childViewer.getByRole("link", { name: "Same document", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".text-window:not([hidden]) .markdown")?.scrollTop < 100);
  assert.ok(await toolbarButton(childViewer, "Forward").isDisabled());
  await childViewer.getByRole("link", { name: "Return to catalogue", exact: true }).click();
  await catalogueViewer.waitFor();
  assert.equal(await page.getByRole("button", { name: "View catalogue.md", exact: true }).count(), 1);

  const external = updated + "\r\nExternal changes.\r\n";
  await writeFile(catalogue, external);
  await catalogueViewer.locator(".markdown").getByText("External changes.", { exact: true }).waitFor();
  await task("Main task", true).waitFor();
  assert.equal(await readFile(catalogue, "utf8"), external);
  await catalogueViewer.getByRole("button", { name: "Close document", exact: true }).click();
  await testTaskSource(page, source);
  console.log("Verified Markdown link navigation and Ctrl-click tabs, shared preview zoom, heading anchors, task persistence, and external reloads.");
  return enlargedSize;
}

async function testTaskSource(page, source) {
  const files = page.getByRole("listbox", { name: "left files", exact: true });

  for (const dirty of [false, true]) {
    const name = dirty ? "dirty-task.md" : "clean-task.md";
    const path = join(source, name);
    const original = "# Tasks\r\n\r\n- [ ] Preserve this state\r\n";
    const toggled = original.replace("[ ]", "[x]");
    await writeFile(path, original);
    await files.locator(`[role="option"][data-tooltip=${JSON.stringify(name)}]`).click();
    await page.keyboard.press("F4");
    const window = page.getByRole("region", { name, exact: true });
    const editor = window.getByLabel(`Edit ${name}`, { exact: true });
    await editor.waitFor();
    if (dirty) {
      await editor.press("Control+Home");
      await page.keyboard.insertText("Before preview.\n\n");
      await editor.getByText("Before preview.", { exact: true }).waitFor();
    }
    await window.getByRole("button", { name: "Preview", exact: true }).click();
    const checkbox = window.getByRole("checkbox", { name: "Preserve this state", exact: true });
    await checkbox.click();
    await window.getByRole("checkbox", { name: "Preserve this state", exact: true, checked: true }).waitFor();
    assert.equal(await readFile(path, "utf8"), dirty ? original : toggled);
    await window.getByRole("button", { name: "Source", exact: true }).click();
    await editor.getByText(/\[x\] Preserve this state/).waitFor();
    await editor.press("Control+End");
    await page.keyboard.insertText("After preview.");
    await editor.press("F2");
    await window.locator(".document-modified").waitFor({ state: "hidden" });
    assert.equal(await readFile(path, "utf8"), (dirty ? "Before preview.\r\n\r\n" : "") + toggled + "After preview.");
    await window.getByRole("button", { name: "Close document", exact: true }).click();
  }
  console.log("Verified Markdown task changes survive returning to the clean and dirty source editor.");
}
