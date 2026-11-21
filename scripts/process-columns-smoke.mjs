import assert from "node:assert/strict";

export async function testProcessColumns(page) {
  const pane = (side) => page.getByRole("region", { name: side + " pane", exact: true });
  const table = (side) => pane(side).getByRole("grid", { name: "Running processes", exact: true });
  const header = (side, name) => table(side).getByRole("columnheader").getByRole("button", { name, exact: true });
  const menu = page.getByRole("menu", { name: "Columns", exact: true });
  const choice = (name) => menu.getByRole("menuitemcheckbox", { name, exact: true });
  const resize = (side, name) => table(side).getByRole("separator", { name: `Resize ${name} column`, exact: true });
  const width = (side, name) => resize(side, name).evaluate((handle) => handle.parentElement.getBoundingClientRect().width);

  for (const [side, shortcut] of [["left", "Alt+F1"], ["right", "Alt+F2"]]) {
    await pane(side).getByRole("listbox", { name: side + " files", exact: true }).press(shortcut);
    await pane(side).getByRole("button", { name: "Processes", exact: true }).click();
    await table(side).locator("tbody tr").first().waitFor();
  }
  const target = table("left").locator("tbody tr").filter({
    has: page.getByRole("gridcell", { name: String(process.pid), exact: true }),
  });
  const originalColumns = await table("left").getByRole("columnheader").count();
  const optionalColumns = (await table("left").getByRole("columnheader").getByRole("button").allTextContents())
    .filter((name) => name !== "Process");
  await target.click();
  const row = target.and(table("left").locator("[data-current='true']"));
  await row.waitFor();
  await header("left", "CPU").click({ button: "right" });
  await choice("CPU").click();
  assert.equal(await choice("CPU").getAttribute("aria-checked"), "false");
  await header("left", "CPU").waitFor({ state: "detached" });
  assert.equal(await row.getByRole("gridcell").count(), originalColumns - 1);
  assert.equal(await header("right", "CPU").count(), 1);
  await page.keyboard.press("Escape");
  await header("left", "PID").press("Shift+F10");
  await choice("CPU").click();
  await header("left", "CPU").waitFor();
  await page.keyboard.press("Escape");
  await header("left", "CPU").click();
  assert.equal(await table("left").getByRole("columnheader").filter({ hasText: "CPU" }).getAttribute("aria-sort"), "descending");
  assert.equal(await row.getByRole("gridcell").count(), originalColumns);
  await header("left", "Process").click({ button: "right" });
  for (const name of optionalColumns) await choice(name).click();
  assert.equal(await choice("Process").isDisabled(), true);
  assert.equal(await table("left").getByRole("columnheader").count(), 1);
  for (const name of optionalColumns) await choice(name).click();
  await page.keyboard.press("Escape");
  const customized = new Map();
  for (const name of ["PID", "Memory"]) {
    const handle = resize("left", name);
    await handle.scrollIntoViewIfNeeded();
    const start = await width("left", name);
    const bounds = await handle.boundingBox();
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 165, y, { steps: 5 });
    await page.mouse.up();
    const actual = await width("left", name);
    assert.ok(actual > start + 100, `${name} width should grow from ${start}, got ${actual}`);
    assert.equal(await width("right", name), start);
    customized.set(name, actual);
  }
  assert.equal(await table("left").evaluate((element) => {
    const container = element.parentElement;
    return container.scrollWidth > container.clientWidth;
  }), true);
  await header("left", "Memory").click({ button: "right" });
  await choice("Memory").click();
  await choice("Memory").click();
  await page.keyboard.press("Escape");
  assert.equal(await width("left", "Memory"), customized.get("Memory"));
  await table("left").focus();
  await page.locator(".actionbar").getByRole("button", { name: "Back to files", exact: true }).click();
  await table("left").waitFor({ state: "detached" });
  await pane("left").getByRole("listbox", { name: "left files", exact: true }).press("Alt+F1");
  await pane("left").getByRole("button", { name: "Processes", exact: true }).click();
  for (const [name, value] of customized) {
    assert.equal(await width("left", name), value);
    await resize("left", name).dblclick();
    assert.equal(await width("left", name), await width("right", name));
  }
  const backToFiles = page.locator(".actionbar").getByRole("button", { name: "Back to files", exact: true });
  await table("right").focus();
  await backToFiles.click();
  await table("right").waitFor({ state: "detached" });
  await target.click();
  await table("left").press("Control+u");
  await table("right").locator("[data-current='true']").getByRole("gridcell", { name: String(process.pid), exact: true }).waitFor();
  await pane("left").getByRole("listbox", { name: "left files", exact: true }).waitFor();
  await table("right").press("Control+u");
  await row.waitFor();
  await backToFiles.click();
  await table("left").waitFor({ state: "detached" });
  console.log("Verified process column visibility, independent panes, header sorting, selection, and the last-column guard.");
}
