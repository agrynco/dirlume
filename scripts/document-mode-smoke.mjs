import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { editPaneAddress } from "./pane-address-smoke.mjs";
import { closeToolWindow, openOptionsWindow } from "./tool-window-smoke.mjs";

export async function testDocumentMode(page, root) {
  const directory = join(root, "document-mode");
  await mkdir(directory);
  const name = "review.txt";
  const file = join(directory, name);
  await writeFile(file, "Saved text");
  const address = await editPaneAddress(page);
  const previousDirectory = await address.inputValue();
  await address.fill(directory);
  await address.press("Enter");
  const pane = page.locator("#left-files");
  await pane.locator(`[role="option"][data-tooltip=${JSON.stringify(name)}]`).click();
  await pane.press("F3");
  const viewer = page.locator(`.text-window[data-editing="false"][aria-label="${name}"]`);
  const editor = page.locator(`.text-window[data-editing="true"][aria-label="${name}"]`);
  const source = editor.locator(".cm-content");
  await viewer.getByText("Saved text", { exact: true }).waitFor();
  await viewer.press("F6");
  await source.fill("Still a draft");
  await editor.getByText("Modified", { exact: true }).waitFor();
  await source.press("F6");
  await viewer.getByText("Saved text", { exact: true }).waitFor();
  assert.equal(await readFile(file, "utf8"), "Saved text");
  await viewer.press("F6");
  await editor.getByText("Still a draft", { exact: true }).waitFor();
  await editor.getByText("Modified", { exact: true }).waitFor();
  assert.equal(await editor.count(), 1);
  assert.equal(await viewer.count(), 1);
  await source.press("Control+s");
  await editor.locator(".document-modified").waitFor({ state: "hidden" });
  await source.press("F6");
  await viewer.getByText("Still a draft", { exact: true }).waitFor();
  assert.equal(await readFile(file, "utf8"), "Still a draft");

  const label = "Switch between Viewer and Editor";
  const verifyViewerShortcutHint = async (shortcut) => {
    const menu = viewer.getByRole("menubar", { name: "Document menu" });
    await menu.getByRole("menuitem", { name: "File", exact: true }).click();
    const hint = menu.getByRole("menuitem", { name: "Open in Editor", exact: true }).locator("kbd");
    if (shortcut) assert.equal(await hint.textContent(), shortcut);
    else assert.equal(await hint.count(), 0);
    await page.keyboard.press("Escape");
  };
  const editBinding = async (change) => {
    const tool = await openOptionsWindow(page);
    const options = tool.getByRole("dialog", { name: "Options", exact: true });
    const search = options.getByRole("searchbox", { name: "Search settings", exact: true });
    await search.fill(label);
    await search.press("Enter");
    await options.getByRole("heading", { name: "Keyboard shortcuts", exact: true }).waitFor();
    await change(options);
    await closeToolWindow(tool, () => options.getByRole("button", { name: "Done", exact: true }).click());
  };
  await editBinding(async (options) => {
    await options.getByRole("button", { name: `Change F6 for ${label}`, exact: true }).click();
    await options.getByRole("textbox", { name: `New shortcut to replace F6 for ${label}`, exact: true }).press("Control+Shift+F6");
  });
  await verifyViewerShortcutHint("Ctrl+Shift+F6");
  await viewer.press("F6");
  assert.equal(await viewer.isVisible(), true);
  await viewer.press("Control+Shift+F6");
  await editor.waitFor();
  await editBinding((options) => options.getByRole("button", { name: `Remove Ctrl+Shift+F6 from ${label}`, exact: true }).click());
  await editor.press("Control+Shift+F6");
  assert.equal(await editor.isVisible(), true);
  await editor.getByRole("button", { name: "Close document", exact: true }).click();
  await verifyViewerShortcutHint("");
  await viewer.press("Control+Shift+F6");
  assert.equal(await viewer.isVisible(), true);
  await editBinding(async (options) => {
    await options.getByRole("button", { name: `Add shortcut for ${label}`, exact: true }).click();
    await options.getByRole("textbox", { name: `New shortcut for ${label}`, exact: true }).press("F6");
  });
  await viewer.press("F10");
  await pane.press("F6");
  const rename = page.getByRole("dialog", { name: "Rename or move", exact: true });
  await rename.waitFor();
  await rename.getByRole("button", { name: "Cancel", exact: true }).click();
  const restored = await editPaneAddress(page);
  await restored.fill(previousDirectory);
  await restored.press("Enter");
  await page.waitForFunction((path) => document.getElementById("left-path")?.dataset.path === path &&
    document.getElementById("left-files")?.getAttribute("aria-busy") === "false", previousDirectory);
  console.log("Verified F6 mode switching, unsaved text, saved Viewer refresh, shortcut editing, and file-pane rename.");
}
