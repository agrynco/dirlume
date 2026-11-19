import { editPaneAddress } from "./pane-address-smoke.mjs";
import { closeToolWindow, openOptionsWindow } from "./tool-window-smoke.mjs";
import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function testPermanentDelete(page, root) {
  const folder = join(root, "delete-dialog-fixture");
  const longName = "Дуже-довга-назва-проєкту-".repeat(5) + "fixture.txt";
  await mkdir(join(folder, "projects"), { recursive: true });
  await writeFile(join(folder, longName), "Temporary verification file");
  const path = await editPaneAddress(page);
  await path.fill(folder);
  await path.press("Enter");
  const row = (name) => page.locator("#left-files").getByRole("option").and(page.locator("[data-tooltip=" + JSON.stringify(name) + "]"));

  async function open(name, title, cancelLabel) {
    await row(name).click();
    await page.keyboard.press("Shift+Delete");
    const dialog = page.getByRole("dialog", { name: title, exact: true });
    const cancel = dialog.getByRole("button", { name: cancelLabel, exact: true });
    await cancel.waitFor();
    assert.equal(await cancel.evaluate((button) => button === document.activeElement), true);
    assert.equal(await dialog.locator(".permanent-delete-message strong").innerText(), name);
    assert.equal(await dialog.locator(".permanent-delete-message > svg").count(), 1);
    assert.equal(await dialog.evaluate((dialog) => {
      const copy = dialog.querySelector(".permanent-delete-message > div");
      const footer = dialog.querySelector(".dialog-footer");
      return copy.scrollWidth <= copy.clientWidth && footer.scrollWidth <= footer.clientWidth;
    }), true);
    return dialog;
  }

  for (const key of ["F8", "Delete"]) {
    await row("projects").click();
    await page.keyboard.press(key);
    const trash = page.getByRole("dialog", { name: "Move to Trash", exact: true });
    await trash.getByText("Move projects to Trash?", { exact: true }).waitFor();
    assert.equal(await trash.locator(".trash-confirmation > svg").count(), 1);
    assert.equal(await trash.getByRole("button", { name: "Move to Trash" }).evaluate((button) =>
      button.matches(".negative, .primary")), false);
    await page.keyboard.press("Escape");
    await trash.waitFor({ state: "hidden" });
  }
  const standard = await open("projects", "Delete permanently", "Cancel");
  assert.equal(await standard.evaluate((dialog) => getComputedStyle(dialog).backgroundColor), "rgb(128, 0, 0)");
  await standard.getByText("Permanently delete projects?", { exact: true }).waitFor();
  await standard.getByText("This action cannot be undone.", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await standard.waitFor({ state: "hidden" });
  assert.ok((await stat(join(folder, "projects"))).isDirectory());

  const window = await openOptionsWindow(page);
  const options = window.getByRole("dialog", { name: "Options", exact: true });
  await options.getByRole("button", { name: "General", exact: true }).click();
  await options.getByLabel("Language", { exact: true }).selectOption("uk");
  await closeToolWindow(window, () => options.getByRole("button", { name: "Done", exact: true }).click());
  const translated = await open(longName, "Видалити остаточно", "Скасувати");
  await translated.getByText("Цю дію неможливо скасувати.", { exact: true }).waitFor();
  if (process.env.DIRLUME_DELETE_SCREENSHOT) await translated.screenshot({ path: process.env.DIRLUME_DELETE_SCREENSHOT, scale: "css" });
  await translated.getByRole("button", { name: "Видалити остаточно", exact: true }).click();
  await row(longName).waitFor({ state: "detached" });
  await assert.rejects(stat(join(folder, longName)), { code: "ENOENT" });
  const localized = await openOptionsWindow(page, () => page.getByRole("button", { name: "Налаштування", exact: true }).click(), "Налаштування");
  const settings = localized.getByRole("dialog", { name: "Налаштування", exact: true });
  await settings.getByLabel("Мова", { exact: true }).selectOption("en");
  await closeToolWindow(localized, () => settings.getByRole("button", { name: "Готово", exact: true }).click());
  console.log("Verified permanent delete dialog layout, translated long filenames, keyboard cancellation, and confirmed deletion.");
}
