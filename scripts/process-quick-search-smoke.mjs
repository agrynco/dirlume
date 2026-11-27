import { editPaneAddress } from "./pane-address-smoke.mjs";
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
      await table.locator(".process-cell-name").getByText(/^dirlume\.exe$/i).first().waitFor();
      await search.press(side === "left" ? "Escape" : "Enter");
      await search.waitFor({ state: "hidden" });
      assert.equal(await table.evaluate((element) => element === document.activeElement), true);
      if (side === "right") assert.equal(await current.getAttribute("aria-selected"), "true");
      await page.locator(".actionbar").getByRole("button", { name: "Back to files", exact: true }).click();
      await table.waitFor({ state: "detached" });
    }
  } finally {
    for (const child of children) await close(child);
  }
  console.log("Verified prefix Quick search in both process tables, duplicate process names, and restored focus.");
  await testFilePaneQuickSearch(page, root);
}

export async function testFilePaneQuickSearch(page, root) {
  const folder = join(root, "quick-search-files");
  await mkdir(folder);
  await mkdir(join(folder, "Reports"));
  for (const name of ["report.txt", "old-report.txt", "notes.txt"]) await writeFile(join(folder, name), "");

  for (const side of ["left", "right"]) {
    const pane = page.getByRole("region", { name: side + " pane", exact: true });
    const previousPath = await pane.locator(`#${side}-path`).getAttribute("data-path");
    const address = await editPaneAddress(page, side);
    await address.fill(folder);
    await address.press("Enter");
    const files = pane.getByRole("listbox", { name: side + " files", exact: true });
    const row = (name) => files.locator(`[role="option"][data-tooltip=${JSON.stringify(name)}]`);
    const current = (name) => row(name).and(files.locator('[data-current="true"]')).waitFor();
    await row("old-report.txt").click({ modifiers: ["Control"] });
    await pane.getByRole("button", { name: "Filter folder", exact: true }).click();
    const filter = pane.getByRole("textbox", { name: `Filter ${side} folder`, exact: true });
    await filter.fill("report");
    await filter.press("Enter");
    await row("notes.txt").waitFor({ state: "hidden" });
    const names = await files.locator('[role="option"][data-tooltip]').evaluateAll((rows) => rows.map((row) => row.dataset.tooltip));
    const order = [...names.filter((name) => name.toLowerCase().startsWith("rep")), "old-report.txt"];
    assert.equal(order.length, 3);

    await files.press("Alt+r");
    const query = pane.getByRole("textbox", { name: "Quick search", exact: true });
    await query.fill("REP");
    await current(order[0]);
    await query.press("ArrowDown");
    await current(order[1]);
    await query.press("ArrowDown");
    await current(order[2]);
    await query.press("ArrowUp");
    await current(order[1]);

    const count = pane.getByRole("button", { name: "3 matches", exact: true });
    if (side === "left") await count.click();
    else {
      await query.press("Tab");
      assert.equal(await count.evaluate((element) => element === document.activeElement), true);
      await count.press("Enter");
    }
    const results = page.getByRole("dialog", { name: "Quick search results", exact: true });
    await results.waitFor();
    assert.deepEqual(await results.locator("tbody tr").allTextContents(), order);
    if (side === "left") {
      await page.keyboard.press("Escape");
      await results.waitFor({ state: "hidden" });
      await query.waitFor();
      await count.click();
      await results.getByRole("button", { name: "old-report.txt", exact: true }).click();
    } else {
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
    }
    await query.waitFor({ state: "hidden" });
    await page.waitForFunction((element) => element === document.activeElement, await files.elementHandle());
    await current("old-report.txt");
    assert.equal(await filter.inputValue(), "report");
    assert.match(await row("old-report.txt").getAttribute("class"), /\bmarked\b/);

    await files.press("Alt+r");
    await query.fill("-rep");
    await current("old-report.txt");
    await pane.getByRole("button", { name: "1 match", exact: true }).waitFor();
    await query.fill("notes");
    await pane.getByRole("status").getByText("No match", { exact: true }).waitFor();
    assert.equal(await pane.locator('.quick-search button[aria-haspopup="dialog"]').count(), 0);
    await query.press("Escape");
    assert.equal(await files.evaluate((element) => element === document.activeElement), true);
    const restore = await editPaneAddress(page, side);
    await restore.fill(previousPath);
    await restore.press("Enter");
    await page.waitForFunction(({ side, previousPath }) => document.getElementById(`${side}-path`)?.dataset.path === previousPath,
      { side, previousPath });
  }
  console.log("Verified substring Quick search, ranked results, filter and mark preservation, and mouse and keyboard focus in both file panes.");
}
