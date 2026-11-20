import assert from "node:assert/strict";
import { link, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { editPaneAddress } from "./pane-address-smoke.mjs";
import { closeToolWindow, openOptionsWindow } from "./tool-window-smoke.mjs";

async function pressDigit(page, side, digit) {
  const ctrl = `Control${side}`;
  await page.keyboard.down(ctrl);
  await page.keyboard.press(`Digit${digit}`);
  await page.keyboard.up(ctrl);
}

export async function testPanelModes({ page, startDesktop, exitDesktop, root }) {
  const folder = join(root, "panel modes");
  await mkdir(folder);
  await mkdir(join(folder, "SAMPLE.FOLDER"));
  await writeFile(join(folder, "UPPERCASE.TXT"), "x".repeat(12345));
  await Promise.all(Array.from({ length: 80 }, (_, index) =>
    writeFile(join(folder, `item-${String(index).padStart(3, "0")}.txt`), "")));
  const list = (side) => page.locator(`#${side}-files`);
  const row = (name) => list("left").locator(`[data-tooltip="${name}"]`);
  async function waitMode(side, mode) {
    await page.locator(`#${side}-pane[data-panel-mode="${mode}"]`).waitFor();
  }

  const address = await editPaneAddress(page, "left");
  await address.fill(folder);
  await address.press("Enter");
  await row("UPPERCASE.TXT").waitFor();
  // Select an item in the first column before exercising horizontal navigation.
  await row("item-000.txt").click();
  await list("right").focus();
  const menu = page.getByRole("menubar", { name: "Main menu" });
  await menu.getByRole("menuitem", { name: "Left", exact: true }).click();
  const leftMenu = menu.getByRole("menu", { name: "Left", exact: true });
  assert.deepEqual(await leftMenu.getByRole("menuitemradio").evaluateAll((items) =>
    items.map((item) => item.querySelector(".main-menu-choice").textContent)),
  ["Brief", "Medium", "Full", "Wide", "File owners", "File links", "Alternative full"]);
  assert.equal(await leftMenu.getByRole("menuitemradio", { name: "Full", exact: true }).getAttribute("aria-checked"), "true");
  await leftMenu.getByRole("menuitemradio", { name: "Brief", exact: true }).click();
  await waitMode("left", "brief");
  await waitMode("right", "full");
  assert.equal(await list("left").locator(".file-row-group").count(), 3);
  assert.equal(await row("item-000.txt").getAttribute("data-current"), "true");
  await list("left").press("ArrowRight");
  await list("left").locator(".file-row-group:nth-child(2) [data-current=true]").waitFor();
  await list("left").press("ArrowLeft");
  await row("item-000.txt").and(list("left").locator("[data-current=true]")).waitFor();
  await list("left").press("End");
  await list("left").locator(".file-row-group:nth-child(3) [data-current=true]").waitFor();
  await list("left").press("Home");

  await list("right").focus();
  await pressDigit(page, "Left", 2);
  await waitMode("right", "medium");
  assert.equal(await list("right").locator(".file-row-group").count(), 2);
  for (const [digit, id] of [[1, "brief"], [3, "full"], [4, "wide"], [8, "owners"], [9, "links"], [0, "alternativeFull"]]) {
    await pressDigit(page, "Left", digit);
    await waitMode("right", id);
  }
  for (const digit of [5, 6, 7]) await pressDigit(page, "Left", digit);
  await waitMode("right", "alternativeFull");
  for (let digit = 0; digit < 10; digit++) {
    await pressDigit(page, "Right", digit);
    await page.getByText(`No folder shortcuts in group ${digit}.`, { exact: true }).waitFor();
    await waitMode("right", "alternativeFull");
  }
  const right = list("right");
  const ctrlEvent = (type, code, held) => right.dispatchEvent(type, { key: "Control", code, ctrlKey: held, bubbles: true });
  await ctrlEvent("keydown", "ControlLeft", true);
  await ctrlEvent("keydown", "ControlRight", true);
  await right.dispatchEvent("keydown", { key: "1", code: "Digit1", ctrlKey: true, bubbles: true });
  await waitMode("right", "alternativeFull");
  await ctrlEvent("keyup", "ControlLeft", true);
  await right.dispatchEvent("keydown", { key: "2", code: "Digit2", ctrlKey: true, bubbles: true });
  await page.getByText("No folder shortcuts in group 2.", { exact: true }).waitFor();
  await ctrlEvent("keyup", "ControlRight", false);

  await list("left").focus();
  await pressDigit(page, "Left", 8);
  await waitMode("left", "owners");
  await page.waitForFunction(() => {
    const owner = document.querySelector('#left-files [data-tooltip="UPPERCASE.TXT"] .file-owner');
    return owner && owner.textContent !== "—";
  });
  await pressDigit(page, "Left", 9);
  await waitMode("left", "links");
  const links = (name) => row(name).locator(".file-links");
  const expectLinks = (name, value) => links(name).getByText(value, { exact: true }).waitFor();
  await expectLinks("UPPERCASE.TXT", "1");
  await expectLinks("SAMPLE.FOLDER", "—");
  const alias = join(folder, "ALIAS.TXT");
  await link(join(folder, "UPPERCASE.TXT"), alias);
  await list("left").press("Control+r");
  await expectLinks("ALIAS.TXT", "2");
  await expectLinks("UPPERCASE.TXT", "2");
  await unlink(alias);
  await list("left").press("Control+r");
  await expectLinks("UPPERCASE.TXT", "1");

  await pressDigit(page, "Left", 0);
  await waitMode("left", "alternativeFull");
  await row("UPPERCASE.TXT").click();
  assert.equal(await row("UPPERCASE.TXT").locator(".file-size").innerText(), "12,345");
  await list("left").press("Insert");
  await row("UPPERCASE.TXT").locator(".panel-mode-mark svg").waitFor();
  const tool = await openOptionsWindow(page);
  const options = tool.getByRole("dialog", { name: "Options", exact: true });
  await options.getByRole("searchbox", { name: "Search settings" }).fill("alternative full");
  await options.getByRole("button", { name: "Alternative full", exact: true }).click();
  const fields = options.locator(".panel-mode-settings");
  const name = fields.getByRole("textbox", { name: "Name", exact: true });
  await name.fill("Compact details");
  const width = fields.getByRole("textbox", { name: "Column widths, field 2", exact: true });
  await width.fill("bad");
  assert.equal(await options.getByRole("button", { name: "Apply", exact: true }).isDisabled(), true);
  await width.fill("35%");
  await fields.getByRole("checkbox", { name: "Show uppercase file names in lowercase" }).check();
  await fields.getByRole("checkbox", { name: "Show folders in uppercase" }).uncheck();
  await options.getByRole("button", { name: "Apply", exact: true }).click();
  await row("UPPERCASE.TXT").getByText("uppercase.txt", { exact: true }).waitFor();
  await fields.getByRole("button", { name: "Move field 2 down", exact: true }).first().click();
  await options.getByRole("button", { name: "Reset", exact: true }).click();
  assert.equal(await name.inputValue(), "");
  await closeToolWindow(tool, () => options.getByRole("button", { name: "Cancel", exact: true }).click());
  await row("UPPERCASE.TXT").getByText("uppercase.txt", { exact: true }).waitFor();

  await exitDesktop(page);
  page = await startDesktop();
  await waitMode("left", "alternativeFull");
  await waitMode("right", "alternativeFull");
  await row("UPPERCASE.TXT").getByText("uppercase.txt", { exact: true }).waitFor();
  for (const side of ["left", "right"]) {
    await list(side).focus();
    await pressDigit(page, "Left", 3);
    await waitMode(side, "full");
  }
  console.log("Verified panel layouts, Ctrl sides, selection, metadata, and editable and persistent mode definitions.");
  return page;
}
