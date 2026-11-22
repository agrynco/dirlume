import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function checkResizeMarker(marker) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await marker.waitFor();
    const aligned = await marker.evaluate((element) => {
      if (!element.parentElement) return null;
      const corner = element.getBoundingClientRect();
      const surface = element.parentElement.getBoundingClientRect();
      return element.tabIndex < 0 && element.getAttribute("aria-hidden") === "true" &&
        Math.abs(surface.right - corner.right) <= 2 && Math.abs(surface.bottom - corner.bottom) <= 2;
    });
    if (aligned === null) continue;
    assert.equal(aligned, true, "The decorative resize marker must be flush with its surface and outside the tab sequence.");
    return;
  }
  assert.fail("The resize marker detached before its geometry could be verified.");
}

export async function openToolWindow(main, trigger, title) {
  const [tool] = await Promise.all([main.context().waitForEvent("page", { timeout: 20000 }), trigger()]);
  tool.setDefaultTimeout(8000);
  await tool.getByRole("dialog", { name: title, exact: true }).waitFor();
  await tool.waitForFunction(() => {
    const tauri = window.__TAURI_INTERNALS__;
    return tauri.invoke("plugin:window|is_visible", { label: tauri.metadata.currentWindow.label });
  });
  await checkResizeMarker(tool.locator(".dialog-window > .window-resize-marker"));
  return tool;
}

export function openOptionsWindow(main, trigger = () => main.getByRole("button", { name: "Options", exact: true }).click(), title = "Options") {
  return openToolWindow(main, trigger, title);
}

export async function settingsArchiveAction(options, name) {
  const trigger = options.getByRole("button", { name: "Settings archive", exact: true });
  await trigger.press("ArrowDown");
  await options.getByRole("menu", { name: "Settings archive", exact: true }).getByRole("menuitem", { name, exact: true }).click();
}

export async function showComparisonOptions(dialog) {
  const trigger = dialog.getByRole("button", { name: "Options", exact: true });
  if (await trigger.getAttribute("aria-expanded") === "false") await trigger.click();
  return trigger;
}

export async function hideComparisonOptions(dialog) {
  const trigger = dialog.getByRole("button", { name: "Options", exact: true });
  if (await trigger.getAttribute("aria-expanded") === "true") await trigger.press("Escape");
}

export async function closeToolWindow(tool, trigger = () => tool.keyboard.press("Escape")) {
  const closed = tool.waitForEvent("close", { timeout: 8000 });
  await Promise.all([closed, trigger().catch(async (error) => {
    if (!String(error).includes("Target page, context or browser has been closed")) throw error;
    // Escape can destroy the Options WebView before Playwright sends its key-up.
    await closed;
    if (!tool.context().pages().some((page) => !page.isClosed())) throw error;
  })]);
}

export async function keepSuggestedColorSchemeName(page) {
  const naming = page.getByRole("dialog", { name: "Name color scheme", exact: true });
  const visible = await naming.isVisible().catch((error) => {
    if (page.isClosed()) return false;
    throw error;
  });
  if (visible) await naming.getByRole("button", { name: "Save scheme", exact: true }).click();
}

export async function testMarkdownOptionsDismissal(page, source) {
  const name = "options-reader.md";
  await writeFile(join(source, name), "# Options dismissal fixture\n\nOriginal Markdown document.\n");
  await page.locator(`#left-files [role="option"][data-tooltip="${name}"]`).click();
  await page.keyboard.press("F3");
  const viewer = page.getByRole("region", { name, exact: true });
  await viewer.getByRole("heading", { name: "Options dismissal fixture", exact: true }).waitFor();
  const button = (scope, label) => scope.getByRole("button", { name: label, exact: true });
  const width = (tool) => tool.getByRole("spinbutton", { name: "Max width (px)", exact: true });
  const open = () => openOptionsWindow(page, () => button(viewer, "Viewer options").click());
  const nativeClose = async (tool) => {
    await tool.evaluate(() => {
      const tauri = window.__TAURI_INTERNALS__;
      return tauri.invoke("plugin:window|close", { label: tauri.metadata.currentWindow.label });
    }).catch((error) => { if (!tool.isClosed()) throw error; });
  };
  const dismiss = async (tool, action) => {
    await closeToolWindow(tool, () => action === "native" ? nativeClose(tool) : button(tool, action).click());
    await page.waitForFunction(() => document.hasFocus());
    await button(viewer, "Search").click();
    const search = viewer.getByRole("searchbox", { name: "Search rendered Markdown" });
    await search.fill("Original");
    await viewer.getByText("1 of 1", { exact: true }).waitFor();
    await search.press("Escape");
  };
  const savedWidth = () => page.evaluate(() =>
    JSON.parse(localStorage.getItem("dirlume.preferences.v1")).viewerContentWidth);
  const setup = await open();
  await width(setup).fill("1600");
  await dismiss(setup, "Done");

  for (const action of ["Done", "Cancel", "native"]) {
    const clean = await open();
    assert.equal(await width(clean).inputValue(), "1600");
    assert.ok(await button(clean, "Apply").isDisabled());
    await dismiss(clean, action);
  }
  for (const action of ["Cancel", "native", "Done"]) {
    const changed = await open();
    await width(changed).fill("1400");
    await dismiss(changed, action);
    assert.equal(await savedWidth(), action === "Done" ? 1400 : 1600);
  }
  for (const [index, action] of ["Cancel", "native", "Done"].entries()) {
    const applied = await open();
    await width(applied).fill(String(1500 + index));
    await button(applied, "Apply").click();
    await width(applied).fill("1650");
    await dismiss(applied, action);
    assert.equal(await savedWidth(), action === "Done" ? 1650 : 1500 + index);
  }
  for (const action of ["Cancel", "native"]) {
    const invalid = await open();
    const search = invalid.getByRole("searchbox", { name: "Search settings" });
    await search.fill("Sort groups");
    await search.press("Enter");
    await button(invalid, "Add sort group").click();
    await invalid.getByText("Enter a filename mask.", { exact: true }).waitFor();
    assert.ok(await button(invalid, "Done").isDisabled());
    await dismiss(invalid, action);
  }

  const failSaves = (tool) => tool.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "dirlume.preferences.v1" && document.documentElement.hasAttribute("data-test-fail-save")) {
        throw new DOMException("The test settings storage is full.", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
    document.documentElement.setAttribute("data-test-fail-save", "");
  });
  for (const [save, action] of [["Done", "Cancel"], ["Apply", "native"], ["Done", "Done"]]) {
    const unavailable = await open();
    assert.equal(await width(unavailable).inputValue(), "1650");
    await width(unavailable).fill("1300");
    await failSaves(unavailable);
    await button(unavailable, save).click();
    await unavailable.getByRole("alert").filter({ hasText: "Could not save settings." }).waitFor();
    assert.equal(await width(unavailable).inputValue(), "1300");
    assert.equal(await savedWidth(), 1650);
    if (action === "Done") await unavailable.evaluate(() => document.documentElement.removeAttribute("data-test-fail-save"));
    await dismiss(unavailable, action);
    assert.equal(await savedWidth(), action === "Done" ? 1300 : 1650);
  }
  await button(viewer, "Close document").click();
  await viewer.waitFor({ state: "hidden" });
  const files = page.getByRole("listbox", { name: "left files", exact: true });
  if (!await files.isVisible()) {
    const tabs = page.getByRole("navigation", { name: "Open documents", exact: true });
    await button(tabs, "Files").click();
  }
  await files.waitFor();
  console.log("Verified clean, edited, applied, invalid, and failed Options dismissal from rendered Markdown on Windows.");
}
