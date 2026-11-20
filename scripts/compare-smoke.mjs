import { editPaneAddress } from "./pane-address-smoke.mjs";
import { closeToolWindow, openToolWindow } from "./tool-window-smoke.mjs";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function testCompareWorker(page, sameLeft, sameRight) {
  for (const [directory, prefix] of [[sameLeft, "before"], [sameRight, "after"]]) {
    await writeFile(join(directory, "large-diff.txt"),
      Array.from({ length: 5500 }, (_, index) => `${prefix} ${index}\n`).join(""));
    await writeFile(join(directory, "line-limit.txt"), "line\n".repeat(20_001));
    await writeFile(join(directory, "spaces.txt"), prefix === "before" ? " alpha\nbeta\n" : "alpha\nbeta\n");
  }

  let window, dialog, busy, whitespace, tooDifferent;
  for (const [side, path] of [["left", sameLeft], ["right", sameRight]]) {
    const address = await editPaneAddress(page, side);
    await address.fill(path);
    await address.press("Enter");
    await page.locator(`#${side}-files`).getByRole("option", { name: /^large-diff.txt/ }).waitFor();
  }

  async function compare(name) {
    for (const side of ["left", "right"]) {
      await page.locator(`#${side}-files`).locator(`[role="option"][data-tooltip=${JSON.stringify(name)}]`).click();
    }
    window = await openToolWindow(page, () => page.keyboard.press("Shift+F11"), "Compare files");
    dialog = window.getByRole("dialog", { name: "Compare files", exact: true });
    busy = dialog.getByRole("status").filter({ hasText: "Comparing…" });
    whitespace = dialog.getByRole("checkbox", { name: "Show whitespace changes" });
    tooDifferent = dialog.getByRole("alert").filter({ hasText: "These files contain too many differences to compare." });
  }

  await compare("large-diff.txt");
  await busy.waitFor();
  await whitespace.check();
  await busy.waitFor();
  assert.equal(await tooDifferent.count(), 0, "Changing settings while the worker is busy must respond immediately.");
  await closeToolWindow(window);

  await compare("large-diff.txt");
  await tooDifferent.waitFor();
  await closeToolWindow(window);
  await compare("line-limit.txt");
  await dialog.getByRole("alert").filter({ hasText: "Choose files shorter than 20,000 lines." }).waitFor();
  await closeToolWindow(window);

  await compare("spaces.txt");
  const next = dialog.getByRole("button", { name: "Next", exact: true });
  await dialog.getByLabel("File differences").waitFor();
  await dialog.getByText("0 changes", { exact: true }).waitFor();
  assert.equal(await next.isEnabled(), false);
  await whitespace.check();
  await dialog.getByText("1 change", { exact: true }).waitFor();
  assert.equal(await next.isEnabled(), true);
  await next.click();
  await dialog.getByText("1 / 1", { exact: true }).waitFor();
  await closeToolWindow(window);
  console.log("Verified comparison responsiveness, stale-result cleanup, limits, and whitespace navigation.");
}
