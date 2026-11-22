import { editPaneAddress } from "./pane-address-smoke.mjs";
import { closeToolWindow, openOptionsWindow } from "./tool-window-smoke.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { close } from "./server-smoke.mjs";

async function holdForDeletion(path) {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$file = [IO.File]::Open($env:DIRLUME_HELD_FIXTURE, 'Open', 'Read', 'ReadWrite'); if ($file) { Write-Output LOCKED; Start-Sleep 60 }"], {
    windowsHide: true, env: { ...process.env, DIRLUME_HELD_FIXTURE: path },
  });
  try {
    await new Promise((resolve, reject) => {
      const time = setTimeout(() => reject(new Error("The fixture did not lock its file.")), 6000);
      const finish = (failure) => {
        clearTimeout(time);
        if (failure) reject(failure);
        else resolve();
      };
      let message = "";
      child.stdout.on("data", (data) => {
        message += data;
        if (message.includes("LOCKED")) finish();
      });
      child.once("error", finish);
      child.once("exit", () => finish(new Error("The fixture stopped before locking its file.")));
    });
    return child;
  } catch (error) {
    await close(child);
    throw error;
  }
}

export async function testBatchDeletion(page, root) {
  const prior = await Promise.all(["left", "right"].map((side) => page.locator(`#${side}-path`).getAttribute("data-path")));
  const navigate = async (side, path) => {
    const control = await editPaneAddress(page, side);
    await control.fill(path);
    await control.press("Enter");
    await page.waitForFunction(({ side, path }) => document.getElementById(`${side}-path`).dataset.path === path &&
      document.getElementById(`${side}-files`).getAttribute("aria-busy") === "false", { side, path });
  };
  const left = page.locator("#left-files");
  const row = (name, side = "left") => page.locator(`#${side}-files [data-tooltip=${JSON.stringify(name)}]`);
  const lock = page.getByRole("dialog", { name: "Item is in use", exact: true });
  const apply = lock.getByRole("checkbox", { name: "Apply to all remaining locked items" });

  for (const [permanent, command, title] of [[true, "Shift+Delete", "Delete permanently"], [false, "F8", "Move to Trash"]]) {
    const directory = join(root, permanent ? "permanent-batch-check" : "trash-batch-check");
    const folder = join(directory, "02-folder");
    const nested = join(folder, "nested-locked.txt");
    const sibling = join(folder, "sibling.txt");
    const before = join(directory, "01-before");
    const names = ["01-before", "02-folder", "03-locked.txt", "04-locked.txt", "06-after.txt"];
    await mkdir(folder, { recursive: true });
    await mkdir(before);
    await Promise.all([nested, sibling, ...names.filter((name) => name.endsWith(".txt")).map((name) => join(directory, name))]
      .map((path) => writeFile(path, "")));
    const holders = [];

    try {
      for (const path of [nested, join(directory, "03-locked.txt"), join(directory, "04-locked.txt")]) {
        holders.push(await holdForDeletion(path));
      }
      await navigate("right", directory);
      await navigate("left", directory);
      for (const name of names) {
        await row(name).click({ modifiers: ["Control"] });
        await row(name).and(left.locator(".marked")).waitFor();
      }
      const start = async () => {
        await left.press(command);
        await page.getByRole("dialog", { name: title, exact: true }).getByRole("button", { name: title, exact: true }).click();
      };
      await start();
      await lock.getByText(permanent ? "nested-locked.txt" : "02-folder", { exact: true }).waitFor();
      assert.equal(await apply.isChecked(), false);
      assert.equal(await lock.getByRole("alert").count(), 1);
      await assert.rejects(stat(before), { code: "ENOENT" });
      await lock.getByRole("button", { name: "Skip", exact: true }).click();
      await lock.getByText("03-locked.txt", { exact: true }).waitFor();
      assert.equal(await apply.isChecked(), false);
      await apply.check();
      await lock.getByRole("button", { name: "Skip", exact: true }).click();

      const result = page.getByRole("dialog", { name: "Deletion results", exact: true });
      await result.getByText("Free space now", { exact: true }).waitFor();
      await result.getByText(permanent ? "4 skipped" : "5 skipped", { exact: true }).waitFor();
      await result.getByText("0 failed", { exact: true }).waitFor();
      for (const side of ["left", "right"]) {
        await row("06-after.txt", side).waitFor({ state: "detached" });
        await row("02-folder", side).waitFor();
      }
      assert.ok(await stat(nested));
      if (permanent) await assert.rejects(stat(sibling), { code: "ENOENT" });
      else assert.ok(await stat(sibling));
      await result.getByRole("button", { name: "Done", exact: true }).click();

      const marked = await left.locator(".file-row.marked").evaluateAll((rows) => rows.map((item) => item.dataset.tooltip));
      for (const name of marked) {
        await row(name).click({ modifiers: ["Control"] });
      }
      await row("04-locked.txt").click();
      await start();
      await lock.getByText("04-locked.txt", { exact: true }).waitFor();
      assert.equal(await apply.isChecked(), false);
      await lock.getByRole("button", { name: "Cancel", exact: true }).click();
      const cancelled = page.getByRole("dialog", { name: "Deletion cancelled", exact: true });
      await cancelled.getByText("1 unprocessed", { exact: true }).waitFor();
      await cancelled.getByRole("button", { name: "Done", exact: true }).click();
      assert.ok(await stat(join(directory, "04-locked.txt")));

      if (permanent) {
        await row("04-locked.txt").click();
        await start();
        await apply.check();
        const inspect = lock.getByRole("button", { name: "Find locking processes", exact: true });
        const inspector = page.getByRole("dialog", { name: "Processes using these files", exact: true });
        const owner = holders.at(-1);
        const process = inspector.getByRole("option", { name: new RegExp(`PID ${owner.pid}\\)`) });
        for (const key of [null, "Enter", "Space"]) {
          if (key) await inspect.press(key);
          else await inspect.click();
          await process.waitFor();
          if (key === "Space") break;
          await inspector.getByRole("button", { name: "Close", exact: true }).click();
          await lock.waitFor();
          assert.equal(await apply.isChecked(), true);
        }
        await process.click();
        await inspector.getByRole("button", { name: "End selected", exact: true }).click();
        const confirm = page.getByRole("dialog", { name: "End processes", exact: true });
        await confirm.getByText(new RegExp(`PID ${owner.pid}\\)`)).waitFor();
        assert.equal(owner.exitCode, null);
        await confirm.getByRole("button", { name: "End process", exact: true }).click();
        await inspector.getByText("Windows found no processes using these files.").waitFor();
        await inspector.getByRole("button", { name: "Close", exact: true }).click();
        await lock.getByRole("button", { name: "Retry", exact: true }).click();
        await row("04-locked.txt").waitFor({ state: "detached" });
      }
    } finally {
      await Promise.all(holders.map(close));
    }
  }
  for (const [index, side] of ["left", "right"].entries()) {
    if (prior[index]) await navigate(side, prior[index]);
  }
  console.log("Verified native deletion and Trash skip, skip-all reset, cancellation, retained children, and both pane refreshes.");
}

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
            invoke: async (command, args) => {
              if (command === "locations") return [{ label: "Home", path }];
              if (command === "list_directory") return { path, parent: null, omitted: 0,
                entries: [{ name: "fixture.txt", directory: false, link: false, hidden: false, size: 7, modified: null }] };
              if (command === "file_icons") return [];
              if (command === "delete_selection") {
                const selection = { files: 5, folders: 2, bytes: 8 * 1024, incomplete: false, availableBefore: 64 * 1024 };
                const counts = { completed: 3, skipped: 0, failed: 0, unprocessed: 0 };
                args.onProgress.onmessage({ phase: "preparing", selection, path });
                return new Promise((resolve) => {
                  window.showDeletionProgress = ({ phase, path }) => args.onProgress.onmessage(phase === "preparing"
                    ? { phase, selection, path }
                    : { phase, selection, progress: { path, currentTotal: 5, currentProcessed: 2, counts } });
                  window.showDeletionLock = () => args.onProgress.onmessage({ phase: "locked", path: "/fixture/held.txt", token: 1 });
                  window.finishDeletionFixture = () => resolve({ selection, counts: { ...counts, unprocessed: 4 },
                    cancelled: true, availableAfter: 72 * 1024, failures: [] });
                });
              }
              if (command === "cancel_deletion") window.finishDeletionFixture();
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
        await page.setViewportSize({ width: 390, height: 680 });
        for (const [shortcut, title] of [["Shift+Delete", "Delete permanently"], ["F8", "Move to Trash"]]) {
          await list.press(shortcut);
          await page.getByRole("dialog", { name: title, exact: true }).getByRole("button", { name: title, exact: true }).click();
          const progress = page.getByRole("dialog", { name: "Deletion progress", exact: true });
          await progress.getByRole("progressbar", { name: "Preparing selection…" }).waitFor();
          const path = progress.locator(".deletion-progress-path");
          const bounds = () => progress.evaluate((dialog) => [dialog, ...dialog.querySelectorAll("progress, .dialog-footer button")]
            .map((element) => { const { x, y, width, height } = element.getBoundingClientRect(); return [x, y, width, height]; }));
          for (const phase of ["preparing", "removing"]) {
            const short = "/fixture/note.txt";
            const long = "/fixture/" + "nested/".repeat(24) + "underscored_filename".repeat(5) + ".txt";
            const update = async (value) => {
              await page.evaluate((event) => window.showDeletionProgress(event), { phase, path: value });
              await progress.getByText(value, { exact: true }).waitFor();
            };
            await update(short);
            const previous = await bounds();
            assert.equal(await path.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
            await update(long);
            assert.deepEqual(await bounds(), previous);
            assert.equal(await path.evaluate((node) => node.scrollWidth > node.clientWidth &&
              getComputedStyle(node).whiteSpace === "nowrap" && getComputedStyle(node).textOverflow === "ellipsis"), true);
            await update(short);
            assert.deepEqual(await bounds(), previous);
          }
          const overall = progress.getByRole("progressbar", { name: "Overall progress" });
          const current = progress.getByRole("progressbar", { name: "Current item progress" });
          await overall.waitFor();
          assert.deepEqual([await overall.getAttribute("value"), await overall.getAttribute("max")], ["3", "7"]);
          assert.deepEqual([await current.getAttribute("value"), await current.getAttribute("max")], ["2", "5"]);
          await progress.getByText(title === "Delete permanently" ? "Estimated space to reclaim" : "Selection size", { exact: true }).waitFor();
          if (process.env.DIRLUME_DELETE_PROGRESS_SCREENSHOT) {
            await progress.screenshot({ path: process.env.DIRLUME_DELETE_PROGRESS_SCREENSHOT, scale: "css" });
          }
          await progress.getByRole("button", { name: "Cancel deletion", exact: true }).click();
          const cancelled = page.getByRole("dialog", { name: "Deletion cancelled", exact: true });
          await cancelled.getByText("72 KiB", { exact: true }).waitFor();
          await cancelled.getByText("4 unprocessed", { exact: true }).waitFor();
          await cancelled.getByRole("button", { name: "Done", exact: true }).click();
        }
        if (platform.startsWith("Windows")) {
          await page.evaluate(() => { window.showDeletionLock = null; });
          await list.press("Shift+Delete");
          await alert.getByRole("button", { name: "Delete permanently", exact: true }).click();
          await page.waitForFunction(() => typeof window.showDeletionLock === "function");
          await page.evaluate(() => window.showDeletionLock());
          const locked = page.getByRole("dialog", { name: "Item is in use", exact: true });
          const inspect = locked.getByRole("button", { name: "Find locking processes", exact: true });
          const retry = locked.getByRole("button", { name: "Retry", exact: true });
          const appearance = (button) => button.evaluate((node) => {
            const style = getComputedStyle(node);
            return [style.borderColor, style.backgroundColor];
          });
          await page.mouse.move(0, 0);
          const style = await appearance(inspect);
          assert.deepEqual(style, await appearance(retry));
          assert.notEqual(style[0], "rgba(0, 0, 0, 0)");
          const cancel = locked.getByRole("button", { name: "Cancel", exact: true });
          await cancel.press("Shift+Tab");
          await page.keyboard.press("Shift+Tab");
          assert.equal(await inspect.evaluate((button) => button === document.activeElement &&
            parseFloat(getComputedStyle(button).outlineWidth) >= 2), true);
          await cancel.click();
          await page.getByRole("dialog", { name: "Deletion cancelled", exact: true }).getByRole("button", { name: "Done", exact: true }).click();
        }
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
