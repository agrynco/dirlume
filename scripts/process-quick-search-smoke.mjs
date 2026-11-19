import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { close } from "./server-smoke.mjs";

export async function testProcessQuickSearch(page, root) {
  const children = Array.from({ length: 2 }, () => spawn("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60"], { windowsHide: true }));
  const pane = (side) => page.getByRole("region", { name: side + " pane", exact: true });
  try {
    for (const [side, shortcut] of [["left", "Alt+F1"], ["right", "Alt+F2"]]) {
      await pane(side).getByRole("listbox", { name: side + " files", exact: true }).press(shortcut);
      await pane(side).getByRole("button", { name: "Processes", exact: true }).click();
      const table = pane(side).getByRole("grid", { name: "Running processes", exact: true });
      for (const child of children) await table.getByRole("gridcell", { name: String(child.pid), exact: true }).waitFor();
      const search = pane(side).getByRole("textbox", { name: "Quick search", exact: true });
      assert.equal(await pane(side).getByRole("searchbox").count(), 0);
      await table.focus();
      await page.keyboard.press("Alt+p");
      assert.equal((await search.inputValue()).toLowerCase(), "p");
      await search.fill("POWERSHELL.EXE");
      const current = table.locator('tr[data-current="true"]');
      await current.locator(".process-cell-name").getByText("powershell.exe", { exact: true }).waitFor();
      const first = await current.getAttribute("id");
      await search.press("ArrowDown");
      await current.locator(".process-cell-name").getByText("powershell.exe", { exact: true }).waitFor();
      assert.notEqual(await current.getAttribute("id"), first);
      await table.locator(".process-cell-name").getByText("dirlume.exe", { exact: true }).first().waitFor();
      await search.press(side === "left" ? "Escape" : "Enter");
      await search.waitFor({ state: "hidden" });
      assert.equal(await table.evaluate((element) => element === document.activeElement), true);
      if (side === "right") assert.equal(await current.getAttribute("aria-selected"), "true");
      await page.locator(".actionbar").getByRole("button", { name: "Back to files", exact: true }).click();
      await table.waitFor({ state: "detached" });
    }

    const folder = join(root, "quick-search-files");
    await mkdir(folder);
    await writeFile(join(folder, "sample-name.txt"), "");
    const address = page.getByLabel("left path", { exact: true });
    await address.fill(folder);
    await address.press("Enter");
    const files = pane("left").getByRole("listbox", { name: "left files", exact: true });
    await files.getByRole("option").filter({ hasText: "sample-name.txt" }).waitFor();
    await files.focus();
    await page.keyboard.press("Alt+s");
    const query = pane("left").getByRole("textbox", { name: "Quick search", exact: true });
    assert.equal((await query.inputValue()).toLowerCase(), "s");
    await query.fill("sample-");
    await files.locator("[data-current='true']").getByText("sample-name.txt", { exact: true }).waitFor();
    await query.press("Escape");
    assert.equal(await files.evaluate((element) => element === document.activeElement), true);
  } finally {
    for (const child of children) await close(child);
  }
  console.log("Verified prefix Quick search in both process tables, duplicate process names, restored focus, and file pane search.");
}
