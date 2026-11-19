import assert from "node:assert/strict";

export async function testProcessColumns(page) {
  const pane = (side) => page.getByRole("region", { name: side + " pane", exact: true });
  const table = (side) => pane(side).getByRole("grid", { name: "Running processes", exact: true });
  const header = (side, name) => table(side).getByRole("columnheader").getByRole("button", { name, exact: true });
  const menu = page.getByRole("menu", { name: "Columns", exact: true });
  const choice = (name) => menu.getByRole("menuitemcheckbox", { name, exact: true });

  for (const [side, shortcut] of [["left", "Alt+F1"], ["right", "Alt+F2"]]) {
    await page.keyboard.press(shortcut);
    await pane(side).getByRole("button", { name: "Processes", exact: true }).click();
    await table(side).locator("tbody tr").first().waitFor();
  }
  const target = table("left").locator("tbody tr").filter({ hasText: "node.exe" }).first();
  await target.click();
  const row = target.and(table("left").locator("[data-current='true']"));
  await row.waitFor();
  await header("left", "CPU").click({ button: "right" });
  await choice("CPU").click();
  assert.equal(await choice("CPU").getAttribute("aria-checked"), "false");
  await header("left", "CPU").waitFor({ state: "detached" });
  assert.equal(await row.getByRole("gridcell").count(), 3);
  assert.equal(await header("right", "CPU").count(), 1);
  await page.keyboard.press("Escape");
  await header("left", "PID").press("Shift+F10");
  await choice("CPU").click();
  await header("left", "CPU").waitFor();
  await page.keyboard.press("Escape");
  await header("left", "CPU").click();
  assert.equal(await table("left").getByRole("columnheader").filter({ hasText: "CPU" }).getAttribute("aria-sort"), "descending");
  assert.equal(await row.getByRole("gridcell").count(), 4);
  await header("left", "Process").click({ button: "right" });
  for (const name of ["PID", "CPU", "Memory"]) await choice(name).click();
  assert.equal(await choice("Process").isDisabled(), true);
  assert.equal(await table("left").getByRole("columnheader").count(), 1);
  for (const name of ["PID", "CPU", "Memory"]) await choice(name).click();
  await page.keyboard.press("Escape");
  for (const side of ["left", "right"]) {
    await table(side).focus();
    await page.locator(".actionbar").getByRole("button", { name: "Back to files", exact: true }).click();
    await table(side).waitFor({ state: "detached" });
  }
  console.log("Verified process column visibility, independent panes, header sorting, selection, and the last-column guard.");
}
