import assert from "node:assert/strict";
import { isAbsolute } from "node:path";

export async function testProcessExecutablePath(page, appPid) {
  for (const [side, shortcut] of [["left", "Alt+F1"], ["right", "Alt+F2"]]) {
    await page.keyboard.press(shortcut);
    const pane = page.getByRole("region", { name: side + " pane", exact: true });
    await pane.getByRole("button", { name: "Processes", exact: true }).click();
    const table = pane.getByRole("grid", { name: "Running processes", exact: true });
    const app = table.getByRole("row").filter({
      has: page.getByRole("gridcell", { name: String(appPid), exact: true }),
    });
    const executable = app.locator(".process-cell-executable");
    const displayed = await executable.innerText();
    assert.ok(isAbsolute(displayed));
    assert.match(displayed, /[\\/]dirlume\.exe$/i);
    assert.equal(await executable.getAttribute("title"), displayed);
    await table.locator(".process-cell-executable").getByText("—", { exact: true }).first().waitFor();
    const heading = table.getByRole("columnheader", { name: "Executable path", exact: true }).getByRole("button");
    await heading.click({ button: "right" });
    const checkbox = page.getByRole("menuitemcheckbox", { name: "Executable path", exact: true });
    await checkbox.click();
    await executable.waitFor({ state: "detached" });
    await checkbox.click();
    await page.keyboard.press("Escape");
    assert.equal(await executable.innerText(), displayed);
    await table.focus();
    await page.locator(".actionbar").getByRole("button", { name: "Back to files", exact: true }).click();
    await table.waitFor({ state: "detached" });
  }
  console.log("Verified full process executable paths, unavailable values, tooltips, and column visibility in both panes.");
}
