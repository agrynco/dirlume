import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { editPaneAddress } from "./pane-address-smoke.mjs";
import { closeToolWindow, openOptionsWindow } from "./tool-window-smoke.mjs";

export async function testDocumentReturn(page, root) {
  const directory = join(root, "document-return");
  await mkdir(directory);
  await writeFile(join(directory, "unrelated.txt"), "An unrelated open document.");
  await writeFile(join(directory, "origin.md"), "[Open target](target.md)");
  await writeFile(join(directory, "target.md"), "# Target document");
  const previousPaths = {};
  for (const side of ["left", "right"]) {
    const address = await editPaneAddress(page, side);
    previousPaths[side] = await address.inputValue();
    await address.fill(directory);
    await address.press("Enter");
  }

  const tabs = page.getByRole("navigation", { name: "Open documents", exact: true });
  const selectTab = (label) => tabs.getByRole("button", { name: label, exact: true }).click();
  const row = (side, name) => page.locator(`#${side}-files [role="option"][data-tooltip="${name}"]`);
  const textWindow = (name, editing = false) => page.locator(`.text-window[data-editing="${editing}"][aria-label="${name}"]`);
  const show = async (side, name) => {
    await row(side, name).click();
    await page.locator(`#${side}-files`).press("F3");
    await textWindow(name).waitFor();
  };
  const verifyFiles = async (side, name) => {
    await page.waitForFunction((side) => document.activeElement?.id === side + "-files", side);
    if (name) assert.equal(await row(side, name).getAttribute("aria-selected"), "true");
  };
  const close = (window) => window.getByRole("button", { name: "Close document", exact: true }).click();
  const switchMode = async (window, title) => {
    const menu = window.getByRole("menubar", { name: "Document menu" });
    await menu.getByRole("menuitem", { name: "File", exact: true }).click();
    await menu.getByRole("menuitem", { name: title, exact: true }).click();
  };
  const target = textWindow("target.md");
  const editor = textWindow("target.md", true);
  const origin = textWindow("origin.md");

  await show("left", "unrelated.txt");
  await selectTab("Files");
  await show("left", "target.md");
  await target.press("Escape");
  await verifyFiles("left", "target.md");
  await show("left", "target.md");
  await selectTab("Files");
  await show("right", "target.md");
  await target.press("Escape");
  await verifyFiles("right", "target.md");

  await show("right", "target.md");
  await switchMode(target, "Open in Editor");
  await editor.locator(".cm-content").fill("Unsaved text");
  await editor.press("Escape");
  const unsaved = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
  await unsaved.getByRole("button", { name: "Keep editing", exact: true }).click();
  assert.ok(await editor.isVisible());
  await editor.press("Escape");
  await unsaved.getByRole("button", { name: "Discard changes", exact: true }).click();
  await verifyFiles("right", "target.md");

  await show("right", "target.md");
  await switchMode(target, "Open in Editor");
  await switchMode(editor, "Open in Viewer");
  const menu = target.getByRole("menubar", { name: "Document menu", exact: true });
  await menu.getByRole("menuitem", { name: "File", exact: true }).click();
  await menu.getByRole("menuitem", { name: "Close", exact: true }).click();
  await verifyFiles("right", "target.md");
  await selectTab("Edit target.md");
  await close(editor);
  await verifyFiles("right", "target.md");

  await show("left", "origin.md");
  const link = origin.getByRole("link", { name: "Open target", exact: true });
  await link.click({ modifiers: ["Control"] });
  await target.waitFor();
  await close(target);
  await origin.waitFor();
  assert.ok(await origin.evaluate((element) => element === document.activeElement));
  await link.click({ modifiers: ["Control"] });
  await target.waitFor();
  await selectTab("View origin.md");
  await close(origin);
  await verifyFiles("left", "origin.md");
  await selectTab("View target.md");
  await close(target);
  await verifyFiles("left");
  await selectTab("View unrelated.txt");
  await close(textWindow("unrelated.txt"));

  for (const side of ["left", "right"]) {
    const address = await editPaneAddress(page, side);
    await address.fill(previousPaths[side]);
    await address.press("Enter");
  }
  console.log("Verified document close destinations for both panes, mode switching, prompt cancellation, and Markdown tabs.");
}

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
  const verifyCopyPath = async (surface, method) => {
    const heading = surface.locator(".document-heading");
    const path = heading.locator("h2");
    const copy = heading.getByRole("button", { name: "Copy file path", exact: true });
    assert.equal(await path.textContent(), file);
    assert.equal(await path.getAttribute("data-tooltip"), file);
    assert.ok(await copy.evaluate((button) => {
      const group = button.parentElement.getBoundingClientRect();
      const path = button.previousElementSibling.getBoundingClientRect();
      const copy = button.getBoundingClientRect();
      return Math.abs(copy.right - group.right) <= 1 && Math.abs(copy.left - path.right - 4) <= 1;
    }), "The path and copy button sit together at the right edge of their header space.");
    if (method === "keyboard") await copy.press("Enter");
    else await copy.click();
    await page.waitForFunction(async (expected) =>
      await window.__TAURI_INTERNALS__.invoke("clipboard_text") === expected, file);
  };
  await viewer.getByText("Saved text", { exact: true }).waitFor();
  await verifyCopyPath(viewer, "keyboard");
  await viewer.press("F6");
  await source.fill("Still a draft");
  await verifyCopyPath(editor, "mouse");
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
  await page.getByRole("navigation", { name: "Open documents", exact: true }).getByRole("button", { name: `View ${name}`, exact: true }).click();
  await verifyViewerShortcutHint("");
  await viewer.press("Control+Shift+F6");
  assert.equal(await viewer.isVisible(), true);
  await editBinding(async (options) => {
    await options.getByRole("button", { name: `Add shortcut for ${label}`, exact: true }).click();
    await options.getByRole("textbox", { name: `New shortcut for ${label}`, exact: true }).press("F6");
  });
  await verifyViewerShortcutHint("F6");
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
  await testDocumentReturn(page, root);
}
