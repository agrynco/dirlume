import assert from "node:assert/strict";
import { isAbsolute } from "node:path";

export async function testProcessExecutablePath(page, appPid) {
  for (const [side, shortcut] of [["left", "Alt+F1"], ["right", "Alt+F2"]]) {
    const pane = page.getByRole("region", { name: side + " pane", exact: true });
    await pane.getByRole("listbox", { name: side + " files", exact: true }).press(shortcut);
    await pane.getByRole("button", { name: "Processes", exact: true }).click();
    const table = pane.getByRole("grid", { name: "Running processes", exact: true });
    const app = table.getByRole("row").filter({
      has: page.getByRole("gridcell", { name: String(appPid), exact: true }),
    });
    const executable = app.locator(".process-cell-executable");
    const displayed = await executable.innerText();
    assert.ok(isAbsolute(displayed));
    assert.match(displayed, /[\\/]dirlume\.exe$/i);
    assert.equal(await executable.getAttribute("data-tooltip"), displayed);
    await table.locator(".process-cell-executable").getByText("—", { exact: true }).first().waitFor();
    const column = table.getByRole("columnheader").filter({ has: page.getByRole("button", { name: "Executable path", exact: true }) });
    const heading = column.getByRole("button", { name: "Executable path", exact: true });
    const grip = column.getByRole("separator", { name: "Resize Executable path column" });
    const clipped = () => executable.evaluate((cell) => cell.scrollWidth > cell.clientWidth + 1);
    for (let i = 0; i < 20 && !await clipped(); i++) await grip.press("ArrowLeft");
    assert.ok(await clipped(), "The executable path must be clipped for the hover check.");
    const tooltip = page.getByRole("tooltip");
    await executable.dispatchEvent("pointerover", { pointerType: "mouse" });
    await tooltip.waitFor();
    assert.equal(await tooltip.textContent(), displayed);
    await executable.dispatchEvent("pointerout", { pointerType: "mouse" });
    await tooltip.waitFor({ state: "hidden" });
    for (let i = 0; i < 150 && await clipped(); i++) await grip.press("ArrowRight");
    assert.equal(await clipped(), false, "The wider column must fit the complete executable path.");
    await executable.dispatchEvent("pointerover", { pointerType: "mouse" });
    await executable.evaluate(() => new Promise((resolve) => setTimeout(resolve, 525)));
    assert.equal(await tooltip.isVisible(), false);
    await executable.dispatchEvent("pointerout", { pointerType: "mouse" });
    await grip.dispatchEvent("dblclick");
    await heading.click();
    assert.equal(await column.getAttribute("aria-sort"), "ascending");
    await heading.click();
    assert.equal(await column.getAttribute("aria-sort"), "descending");
    await heading.click({ button: "right" });
    const checkbox = page.getByRole("menuitemcheckbox", { name: "Executable path", exact: true });
    await checkbox.click();
    await executable.waitFor({ state: "detached" });
    const actions = page.getByRole("menu", { name: "Process actions", exact: true });
    await page.keyboard.press("Escape");
    await app.getByRole("gridcell", { name: String(appPid), exact: true }).click({ button: "right" });
    await actions.getByText(`PID ${appPid}`, { exact: true }).waitFor();
    assert.equal(await actions.getByRole("menuitem", { name: "End process…", exact: true }).isDisabled(), true);
    await actions.getByRole("menuitem", { name: "Properties", exact: true }).click();
    const properties = page.getByRole("dialog", { name: "Process properties", exact: true });
    await properties.getByText(displayed, { exact: true }).waitFor();
    await properties.getByRole("button", { name: "Close", exact: true }).click();
    await table.press("Shift+F10");
    await actions.waitFor();
    await page.keyboard.press("Escape");
    await page.waitForFunction((side) => document.activeElement?.id === `${side}-files`, side);
    await table.getByRole("button", { name: "Process", exact: true }).click({ button: "right" });
    await checkbox.click();
    await page.keyboard.press("Escape");
    assert.equal(await executable.innerText(), displayed);
    await table.focus();
    await page.locator(".actionbar").getByRole("button", { name: "Back to files", exact: true }).click();
    await table.waitFor({ state: "detached" });
  }
  console.log("Verified full process executable paths, unavailable values, tooltips, and column visibility in both panes.");
}
