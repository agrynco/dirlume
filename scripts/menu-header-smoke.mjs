import assert from "node:assert/strict";

export function blankMenuHeaderPoint(menubar) {
  return menubar.evaluate((bar) => {
    const bounds = bar.getBoundingClientRect();
    const y = bounds.top + bounds.height / 2;
    for (let x = bounds.left + 2; x < bounds.right - 2; x += 3) {
      if (document.elementFromPoint(x, y) === bar) return { x, y };
    }
    throw new Error("The menu header has no blank area.");
  });
}

export async function testHeaderMenus(page, windows = false) {
  const bar = page.getByRole("menubar", { name: "Main menu", exact: true });
  for (const side of ["Right", "Left"]) {
    const control = bar.getByRole("menuitem", { name: side, exact: true });
    const dropdown = bar.getByRole("menu", { name: side, exact: true });
    await control.click();
    await dropdown.waitFor();
    const { x, y } = await blankMenuHeaderPoint(bar);
    await page.mouse.click(x, y);
    await dropdown.waitFor({ state: "hidden" });
    assert.equal(await page.locator("dialog[open]").count(), 0);
    await control.click();
    await dropdown.waitFor();
    await page.keyboard.press("Escape");
    await dropdown.waitFor({ state: "hidden" });
  }
  if (windows) {
    const maximize = page.getByRole("button", { name: "Maximize window", exact: true });
    const restore = page.getByRole("button", { name: "Restore window", exact: true });
    const initiallyMaximized = await restore.isVisible();
    for (const next of initiallyMaximized ? [maximize, restore] : [restore, maximize]) {
      // Exercise Tauri's native double-click handler without starting a Windows move loop on the first down event.
      await bar.dispatchEvent("mousedown", { button: 0, detail: 2, bubbles: true, cancelable: true });
      await next.waitFor();
    }
  }
  console.log("Verified that blank header clicks and Escape close both pane menus" + (windows ? " and that the Windows title bar still maximizes and restores." : "."));
}
