export async function editPaneAddress(page, side = "left") {
  const address = page.locator("#" + side + "-address");
  if (!await address.isVisible()) {
    await page.locator("#" + side + "-files").press("Control+l");
    await address.waitFor();
  }
  return address;
}
