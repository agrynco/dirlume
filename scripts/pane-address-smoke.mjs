export async function editPaneAddress(page, side = "left") {
  await page.waitForFunction((side) => document.getElementById(side + "-path")?.dataset.path &&
    document.getElementById(side + "-files")?.getAttribute("aria-busy") === "false", side);
  const address = page.locator("#" + side + "-address");
  if (!await address.isVisible()) {
    if (!await page.evaluate(() => document.hasFocus())) {
      await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|set_focus", { label: "main" }));
    }
    await page.locator("#" + side + "-files").focus();
    await page.waitForFunction((side) => document.activeElement?.id === side + "-files" &&
      document.getElementById(side + "-pane")?.classList.contains("active"), side);
    await page.keyboard.press("Control+l");
    await address.waitFor();
  }
  return address;
}
