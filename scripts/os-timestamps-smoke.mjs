import { editPaneAddress } from "./pane-address-smoke.mjs";
import { closeToolWindow, openOptionsWindow } from "./tool-window-smoke.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function testOsTimestamps(page, root) {
  const directory = join(root, "timestamp-fixture");
  await mkdir(directory);
  const sample = new Date(2026, 10, 19, 16, 19);
  const samples = [["older.txt", new Date(2026, 1, 22, 11, 22)], ["newer.txt", sample]];
  for (const [name, date] of samples) {
    const path = join(directory, name);
    await writeFile(path, name);
    await utimes(path, date, date);
  }
  const expected = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
    $sample = Get-Date -Year 2026 -Month 11 -Day 19 -Hour 16 -Minute 19 -Second 0
    @($sample.ToShortDateString(), $sample.ToShortTimeString()) | ConvertTo-Json -Compress
  `], { windowsHide: true, encoding: "utf8" }));
  const native = (style) => page.evaluate(({ seconds, style }) =>
    window.__TAURI_INTERNALS__.invoke("format_timestamps", { timestamps: [seconds], style }),
  { seconds: sample.valueOf() / 1000, style });
  assert.deepEqual(await native("date"), [expected[0]]);
  assert.deepEqual(await native("time"), [expected[1]]);
  assert.deepEqual(await native("date_time"), [expected.join(", ")]);

  const address = await editPaneAddress(page);
  await address.fill(directory);
  await address.press("Enter");
  const pane = page.locator("#left-pane");
  const file = pane.getByRole("option").filter({ hasText: "newer.txt" });
  await file.locator(".file-date").filter({ hasText: expected[0] }).waitFor();
  await file.locator(".file-time").filter({ hasText: expected[1] }).waitFor();
  const modified = pane.getByRole("button", { name: "Date", exact: true });
  await modified.click();
  const order = () => pane.locator(".file-name").allTextContents().then((names) => names.filter((name) => name.endsWith(".txt")));
  const initial = await order();
  assert.deepEqual([...initial].sort(), ["newer.txt", "older.txt"]);
  await modified.click();
  assert.deepEqual(await order(), [...initial].reverse());
  await file.click();
  await page.keyboard.press("Control+a");
  const properties = page.getByRole("dialog", { name: "Attributes", exact: true });
  await properties.getByText(expected.join(", "), { exact: true }).first().waitFor();
  await page.keyboard.press("Escape");

  const window = await openOptionsWindow(page);
  const general = window.getByRole("dialog", { name: "Options", exact: true });
  await general.getByRole("button", { name: "General", exact: true }).click();
  await general.getByLabel("Language", { exact: true }).selectOption("uk");
  await closeToolWindow(window, () => general.getByRole("button", { name: "Done", exact: true }).click());
  await file.locator(".file-date").filter({ hasText: expected[0] }).waitFor();
  const localized = await openOptionsWindow(page, () => page.keyboard.press("Control+Alt+s"), "Налаштування");
  const localizedOptions = localized.getByRole("dialog", { name: "Налаштування", exact: true });
  await localizedOptions.locator("select").filter({ has: localized.locator('option[value="uk"]') }).selectOption("en");
  await closeToolWindow(localized, () => localizedOptions.locator(".dialog-footer button.primary").click());
  await page.getByRole("button", { name: "Options", exact: true }).waitFor();
  console.log("Verified system date and time formats in file panes and file attributes, chronological sort, and independence from the app language.");
}
