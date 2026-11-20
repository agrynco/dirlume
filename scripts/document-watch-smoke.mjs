import assert from "node:assert/strict";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { editPaneAddress } from "./pane-address-smoke.mjs";

export async function testDocumentWatch(page, root) {
  const directory = join(root, "document-watch");
  await mkdir(directory);
  const name = "watch.txt";
  const file = join(directory, name);
  const replaceFile = async (text) => {
    const staged = join(directory, "replacement.tmp");
    await writeFile(staged, text);
    await rename(staged, file);
  };
  await writeFile(file, "Original file");
  const address = await editPaneAddress(page);
  const previousDirectory = await address.inputValue();
  await address.fill(directory);
  await address.press("Enter");
  const pane = page.locator("#left-files");
  await pane.locator(`[role="option"][data-tooltip=${JSON.stringify(name)}]`).click();
  await pane.press("F3");
  const viewer = page.locator(`.text-window[data-editing="false"][aria-label="${name}"]`);
  const editor = page.locator(`.text-window[data-editing="true"][aria-label="${name}"]`);
  const input = editor.locator(".cm-content");
  const changed = page.getByRole("dialog", { name: "File changed on disk", exact: true });
  const reload = changed.getByRole("button", { name: "Reload from disk", exact: true });
  const keep = changed.getByRole("button", { name: "Keep editing", exact: true });
  const warning = changed.getByText("Reloading will discard your unsaved edits.", { exact: true });

  await viewer.getByText("Original file", { exact: true }).waitFor();
  await writeFile(file, "Changed in place");
  await viewer.getByText("Changed in place", { exact: true }).waitFor();
  await viewer.press("F4");
  const hex = viewer.getByLabel("Hexadecimal contents", { exact: true });
  await hex.filter({ hasText: "Changed in place" }).waitFor();
  await replaceFile("Fresh disk data");
  await hex.filter({ hasText: "Fresh disk data" }).waitFor();
  await viewer.press("F4");
  await viewer.getByText("Fresh disk data", { exact: true }).waitFor();
  await viewer.press("F6");
  await editor.getByText("Fresh disk data", { exact: true }).waitFor();

  await input.fill("Unsaved text");
  await editor.getByText("Modified", { exact: true }).waitFor();
  await replaceFile("Replacement one");
  await warning.waitFor();
  await keep.click();
  await changed.waitFor({ state: "hidden" });
  await editor.getByText("Unsaved text", { exact: true }).waitFor();
  await input.press("End");
  await page.keyboard.insertText(" continued");
  await editor.getByText("Unsaved text continued", { exact: true }).waitFor();
  await input.press("Control+s");
  await editor.getByRole("alert").filter({ hasText: "The file changed on disk." }).waitFor();
  assert.equal(await readFile(file, "utf8"), "Replacement one");

  await writeFile(file, "Replacement two");
  await warning.waitFor();
  await reload.click();
  await editor.getByText("Replacement two", { exact: true }).waitFor();
  await editor.getByText("Modified", { exact: true }).waitFor({ state: "hidden" });
  await replaceFile("Clean editor update");
  await changed.getByText("Reload to open the version currently on disk.", { exact: true }).waitFor();
  assert.equal(await warning.count(), 0);
  await reload.click();
  await editor.getByText("Clean editor update", { exact: true }).waitFor();
  await input.fill("Dirlume saved this");
  await input.press("Control+s");
  await editor.locator(".document-modified").waitFor({ state: "hidden" });
  assert.equal(await readFile(file, "utf8"), "Dirlume saved this");
  await input.press("F6");
  await viewer.getByText("Dirlume saved this", { exact: true }).waitFor();
  await viewer.press("F6");
  await editor.waitFor();
  assert.equal(await changed.isVisible(), false, "Dirlume's own save opened an external-change prompt.");
  await editor.press("F10");
  await viewer.press("F10");
  const restored = await editPaneAddress(page);
  await restored.fill(previousDirectory);
  await restored.press("Enter");
  await page.waitForFunction((path) => document.getElementById("left-path")?.dataset.path === path &&
    document.getElementById("left-files")?.getAttribute("aria-busy") === "false", previousDirectory);
  console.log("Verified automatic text and hex refresh, both external write types, draft retention, reload, and save conflict protection.");
}
