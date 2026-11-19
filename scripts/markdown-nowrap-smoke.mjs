import { editPaneAddress } from "./pane-address-smoke.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function testMarkdownNoWrap(page, root) {
  const directory = join(root, "markdown-nowrap");
  await mkdir(directory);
  await writeFile(join(directory, "target.md"), "# Linked issue\n");
  await writeFile(join(directory, "issues.md"), [
    "# Issues",
    "",
    "| Task | Notes |",
    "| --- | --- |",
    '| <span style="white-space: nowrap">📖&nbsp;[DEMO-123](https://example.com/DEMO-123)</span> | A long description that is allowed to wrap normally even when the task column needs its full width. |',
    "| <span style='WHITE-SPACE : nowrap ;'>📖&nbsp;[DEMO-456](target.md)</span> | Another description. |",
    '| <span style="color: red; white-space: nowrap" onclick="ignored()">Other text</span> | <span style="color: red">Plain text</span> |',
    "",
    '<span style="white-space: nowrap">Outside the table</span>',
  ].join("\n"));
  const address = await editPaneAddress(page);
  const previous = await address.inputValue();
  await address.fill(directory);
  await address.press("Enter");
  await page.locator("#left-files").getByRole("option").filter({ hasText: "issues.md" }).click();
  await page.keyboard.press("F3");
  const viewer = page.getByRole("region", { name: "issues.md", exact: true });
  const preview = viewer.locator(".markdown");
  const external = viewer.getByRole("link", { name: "DEMO-123", exact: true });
  await external.waitFor();
  assert.equal(await external.getAttribute("href"), "https://example.com/DEMO-123");
  await preview.evaluate((element) => { element.style.maxWidth = "325px"; });
  const task = viewer.getByRole("cell").filter({ has: page.getByRole("link", { name: "DEMO-123", exact: true }) });
  const notes = viewer.getByRole("cell", { name: /^A long description/ });
  const widths = await task.evaluate((cell) => {
    const wrapper = cell.querySelector(".markdown-nowrap");
    const link = cell.querySelector("a");
    const range = cell.ownerDocument.createRange();
    range.selectNodeContents(link);
    return {
      whiteSpace: getComputedStyle(wrapper).whiteSpace,
      icon: wrapper.firstChild.textContent,
      linkLines: range.getClientRects().length,
      wrapperHeight: wrapper.getBoundingClientRect().height,
      linkHeight: link.getBoundingClientRect().height,
    };
  });
  assert.equal(widths.whiteSpace, "nowrap");
  assert.equal(widths.icon, "📖\u00a0");
  assert.equal(widths.linkLines, 1);
  assert.ok(Math.abs(widths.wrapperHeight - widths.linkHeight) < 2);
  assert.ok(await notes.evaluate((element) => {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    return range.getClientRects().length > 1 && getComputedStyle(element).whiteSpace === "normal";
  }));
  assert.equal(await preview.locator(".markdown-nowrap").count(), 3);
  assert.equal(await preview.locator("span[style], span[onclick]").count(), 0);
  const formatting = viewer.getByRole("button", { name: "HTML formatting" });
  assert.equal(await formatting.getAttribute("aria-pressed"), "true");
  await formatting.click();
  assert.equal(await formatting.getAttribute("aria-pressed"), "false");
  await preview.locator(".markdown-nowrap").first().waitFor({ state: "detached" });
  assert.equal(await external.evaluate((link) => getComputedStyle(link).whiteSpace), "normal");
  await formatting.click();
  assert.equal(await formatting.getAttribute("aria-pressed"), "true");
  await task.locator(".markdown-nowrap").waitFor();
  assert.equal(await external.evaluate((link) => getComputedStyle(link).whiteSpace), "nowrap");
  if (process.env.DIRLUME_MARKDOWN_SCREENSHOT) await preview.screenshot({ path: process.env.DIRLUME_MARKDOWN_SCREENSHOT });
  await viewer.getByRole("link", { name: "DEMO-456", exact: true }).click();
  await page.getByRole("heading", { name: "Linked issue", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await (await editPaneAddress(page)).fill(previous);
  await address.press("Enter");
  console.log("Verified that explicitly unwrapped Markdown table links stay on one line, adjacent notes wrap, and the formatting toggle and link navigation work.");
}
