import assert from "node:assert/strict";
import { closeToolWindow, openOptionsWindow } from "./tool-window-smoke.mjs";

export async function testSystemTheme(page) {
  const tool = await openOptionsWindow(page);
  const options = tool.getByRole("dialog", { name: "Options", exact: true });
  await options.getByRole("searchbox", { name: "Search settings" }).fill("");
  const windowPage = options.getByRole("button", { name: "Window", exact: true });
  if (!await windowPage.isVisible()) await options.getByRole("button", { name: "Appearance", exact: true }).click();
  await windowPage.click();
  const scheme = options.getByRole("combobox", { name: "Color scheme", exact: true });
  const apply = options.getByRole("button", { name: "Apply", exact: true });
  const keepFonts = options.getByRole("checkbox", { name: "Keep current fonts", exact: true });
  const preview = options.locator(".preview-frame");
  const typography = (element) => element.evaluate((root) => {
    const style = getComputedStyle(root);
    return ["--panel-font", "--panel-size", "--viewer-font", "--viewer-size"]
      .map((property) => style.getPropertyValue(property).trim());
  });
  await scheme.selectOption("light");
  const lightFonts = await typography(preview);
  await keepFonts.check();
  await scheme.selectOption("lavender");
  assert.deepEqual(await typography(preview), lightFonts);
  await apply.click();
  await page.locator('html[data-theme="lavender"]').waitFor();
  await tool.locator('html[data-theme="lavender"]').waitFor();
  assert.deepEqual(await typography(page.locator("html")), lightFonts);
  assert.deepEqual(await typography(tool.locator("html")), lightFonts);
  await keepFonts.uncheck();
  assert.notDeepEqual(await typography(preview), lightFonts);
  await apply.click();
  await options.getByRole("combobox", { name: "Favorite light scheme", exact: true }).selectOption("light");
  await options.getByRole("combobox", { name: "Favorite dark scheme", exact: true }).selectOption("dark");
  if (await apply.isEnabled()) await apply.click();
  const nativeTheme = () => tool.evaluate(() => {
    const { invoke, metadata } = window.__TAURI_INTERNALS__;
    return invoke("plugin:window|theme", { label: metadata.currentWindow.label });
  });
  const originalNativeTheme = await nativeTheme();
  for (const system of ["light", "dark"]) {
    const custom = system === "light" ? "dark" : "light";
    await Promise.all([page.emulateMedia({ colorScheme: system }), tool.emulateMedia({ colorScheme: system })]);
    await scheme.selectOption(custom);
    if (await apply.isEnabled()) await apply.click();
    await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, custom);
    assert.equal(await nativeTheme(), originalNativeTheme, "Applying a Dirlume theme must preserve the Windows tool window's system mode.");
    await scheme.selectOption("system");
    await options.locator(`.preview-frame[data-theme="${system}"]`).waitFor();
    assert.equal(await page.locator("html").getAttribute("data-theme"), custom);
    await apply.click();
    await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, system);
    assert.equal(await scheme.inputValue(), "system");
  }
  await page.emulateMedia({ colorScheme: null });
  await closeToolWindow(tool, () => options.getByRole("button", { name: "Done", exact: true }).click());
  console.log("Verified font retention in the Windows main and tool windows and System theme preview in light and dark modes.");
}
