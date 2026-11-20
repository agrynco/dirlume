import { editPaneAddress } from "./pane-address-smoke.mjs";
import { closeToolWindow, openOptionsWindow } from "./tool-window-smoke.mjs";
import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

async function dialogColors(dialog, action) {
  return dialog.evaluate((dialog, action) => {
    const style = (part) => getComputedStyle(part);
    const button = [...dialog.querySelectorAll(".dialog-footer button")].find((button) => button.textContent.trim() === action);
    const root = style(dialog);
    return {
      frame: root.backgroundColor,
      border: root.borderColor,
      header: style(dialog.querySelector(".dialog-heading")).backgroundColor,
      footer: style(dialog.querySelector(".dialog-footer")).backgroundColor,
      cancel: style([...dialog.querySelectorAll(".dialog-footer button")].find((button) => button.textContent.trim() === "Cancel")).backgroundColor,
      action: style(button).backgroundColor,
      label: style(button).color,
      actionToken: root.getPropertyValue("--danger-action").trim(),
      backgroundToken: root.getPropertyValue("--dialog-bg").trim(),
    };
  }, action);
}

function contrast(left, right) {
  const luminance = (rgb) => rgb.match(/\d+/g).slice(0, 3).map((value) => {
    const channel = Number(value) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  const [light, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (light + .05) / (dark + .05);
}

async function verifyAlert(dialog) {
  const colors = await dialogColors(dialog, "Delete permanently");
  assert.equal(colors.actionToken, "#a32337");
  assert.equal(colors.action, "rgb(163, 35, 55)");
  assert.notEqual(colors.frame, colors.action);
  assert.notEqual(colors.header, colors.action);
  assert.notEqual(colors.footer, colors.action);
  assert.notEqual(colors.cancel, colors.action);
  assert.ok(contrast(colors.action, colors.label) >= 4.5);
  return colors;
}

export async function testAlertDialogStyles() {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    for (const platform of ["Windows NT 10.0; Win64; x64", "X11; Linux x86_64", "Macintosh; Intel Mac OS X 10_15_7"]) {
      for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ userAgent: `Mozilla/5.0 (${platform})` });
        page.setDefaultTimeout(8000);
        await page.route("http://dirlume.test/**", (route) => {
          const path = new URL(route.request().url()).pathname;
          return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
        });
        await page.addInitScript((theme) => {
          const path = "/fixture";
          localStorage.setItem("dirlume.preferences.v1", JSON.stringify({ theme }));
          window.__TAURI_INTERNALS__ = {
            transformCallback: () => 1,
            invoke: async (command) => {
              if (command === "locations") return [{ label: "Home", path }];
              if (command === "list_directory") return { path, parent: null, omitted: 0,
                entries: [{ name: "fixture.txt", directory: false, link: false, hidden: false, size: 7, modified: null }] };
              if (command === "file_icons") return [];
              return null;
            },
          };
        }, theme);
        await page.goto("http://dirlume.test/");
        const list = page.getByRole("listbox", { name: "left files", exact: true });
        await list.getByRole("option", { name: /^fixture\.txt/ }).click();
        await list.press("F5");
        const copy = page.getByRole("dialog", { name: "Copy", exact: true });
        await copy.waitFor();
        const ordinary = await dialogColors(copy, "Copy");
        await copy.getByRole("button", { name: "Cancel", exact: true }).click();

        await list.press("Shift+Delete");
        const alert = page.getByRole("dialog", { name: "Delete permanently", exact: true });
        await alert.waitFor();
        assert.equal(await alert.getByRole("button", { name: "Cancel", exact: true })
          .evaluate((cancel) => document.activeElement === cancel), true);
        const confirmation = await verifyAlert(alert);
        for (const part of ["frame", "border", "header", "footer", "cancel"]) assert.equal(confirmation[part], ordinary[part]);
        assert.notEqual(confirmation.action, ordinary.action);
        await page.keyboard.press("Tab");
        assert.equal(await alert.getByRole("button", { name: "Delete permanently", exact: true }).evaluate((button) => {
          const style = getComputedStyle(button);
          return button === document.activeElement && style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2;
        }), true);
        await page.keyboard.press("Escape");
        await alert.waitFor({ state: "hidden" });
        await page.close();
      }
    }
    console.log("Verified matching dialog surfaces, red confirmation contrast, and keyboard focus in light and dark themes.");
  } finally {
    await browser.close();
  }
}

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
    await page.mouse.move(0, 0);
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
  const cancel = standard.getByRole("button", { name: "Cancel", exact: true });
  const tooltip = page.getByRole("tooltip");
  await cancel.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
  assert.equal(await tooltip.isVisible(), false, "Initial keyboard focus must not trigger a tooltip.");
  await cancel.hover();
  await cancel.evaluate(() => new Promise((resolve) => setTimeout(resolve, 525)));
  assert.equal(await tooltip.isVisible(), false, "The visible Cancel label needs no tooltip.");
  await page.mouse.move(0, 0);
  await tooltip.waitFor({ state: "hidden" });
  await verifyAlert(standard);
  await standard.getByText("Permanently delete projects?", { exact: true }).waitFor();
  await standard.getByText("This action cannot be undone.", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await standard.waitFor({ state: "hidden" });
  assert.ok((await stat(join(folder, "projects"))).isDirectory());
  for (const label of ["Cancel", "Close dialog"]) {
    const confirmation = await open("projects", "Delete permanently", "Cancel");
    await confirmation.getByRole("button", { name: label, exact: true }).click();
    await confirmation.waitFor({ state: "hidden" });
    assert.ok((await stat(join(folder, "projects"))).isDirectory());
  }

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

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testAlertDialogStyles();
