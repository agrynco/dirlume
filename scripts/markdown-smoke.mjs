import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function testMarkdown(page, source, wheelFont) {
  const catalogue = join(source, "catalogue.md");
  const docs = join(source, "notes folder");
  await mkdir(docs);
  const original = "\uFEFF# Catalogue 📚\r\n\r\n" +
    "- [ ] Main task\r\n  - [X] Nested task\n\n" +
    "~~~markdown\r\n- [ ] Literal example\r\n~~~\r\n\r\n" +
    "[Linked notes][notes]\r\n\r\n[notes]: notes%20folder/child.md#target-section\r\n";
  await writeFile(catalogue, original);
  await writeFile(join(docs, "child.md"), [
    "# Linked notes", "", ...Array.from({ length: 50 }, (_, i) => "Paragraph " + i + ".\n"),
    "## Target section", "", "[Return to catalogue](../catalogue.md#catalogue-)", "",
    "[Same document](#linked-notes)", "",
  ].join("\n"));

  const row = page.getByRole("listbox", { name: "left files", exact: true })
    .getByRole("option", { name: /^catalogue\.md/ });
  const catalogueViewer = page.getByRole("region", { name: "catalogue.md", exact: true });
  const childViewer = page.getByRole("region", { name: "child.md", exact: true });
  const task = (name, checked) => catalogueViewer.getByRole("checkbox", { name, exact: true, checked });

  async function openCatalogue() {
    await row.click();
    await page.keyboard.press("F3");
    await catalogueViewer.getByRole("heading", { name: "Catalogue 📚", exact: true }).waitFor();
  }

  await openCatalogue();
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
  await childViewer.getByRole("link", { name: "Same document", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".text-window:not([hidden]) .markdown")?.scrollTop < 100);
  await childViewer.getByRole("link", { name: "Return to catalogue", exact: true }).click();
  await catalogueViewer.waitFor();
  assert.equal(await page.getByRole("button", { name: "View catalogue.md", exact: true }).count(), 1);

  const external = updated + "\r\nExternal changes.\r\n";
  await writeFile(catalogue, external);
  await task("Main task", true).click();
  await catalogueViewer.getByRole("alert").filter({ hasText: "The file changed on disk." }).waitFor();
  await task("Main task", true).waitFor();
  assert.equal(await readFile(catalogue, "utf8"), external);
  await catalogueViewer.getByRole("button", { name: "Close document", exact: true }).click();
  console.log("Verified Markdown link navigation and Ctrl-click tabs, shared preview zoom, heading anchors, task persistence, and external edit protection.");
  return enlargedSize;
}
