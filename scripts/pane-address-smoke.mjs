export async function editPaneAddress(page, side = "left") {
  await page.waitForFunction((side) => document.getElementById(side + "-path")?.dataset.path &&
    document.getElementById(side + "-files")?.getAttribute("aria-busy") === "false", side);
  const address = page.locator("#" + side + "-address");
  if (!await address.isVisible()) {
    await page.locator("#" + side + "-files").press("Control+l");
    await address.waitFor();
  }
  return address;
}
