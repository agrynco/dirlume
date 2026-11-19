import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function testCompareWorker(page, sameLeft, sameRight) {
  for (const [directory, prefix] of [[sameLeft, "before"], [sameRight, "after"]]) {
    await writeFile(join(directory, "large-diff.txt"),
      Array.from({ length: 4000 }, (_, index) => `${prefix} ${index}\n`).join(""));
    await writeFile(join(directory, "line-limit.txt"), "line\n".repeat(20_001));
    await writeFile(join(directory, "spaces.txt"), prefix === "before" ? " alpha\nbeta\n" : "alpha\nbeta\n");
  }

  const dialog = page.getByRole("dialog", { name: "Compare files", exact: true });
  const busy = dialog.getByRole("status").filter({ hasText: "Comparing…" });
  const whitespace = dialog.getByRole("checkbox", { name: "Show whitespace changes" });
  const close = dialog.getByRole("button", { name: "Close dialog", exact: true });
  for (const [side, path] of [["left", sameLeft], ["right", sameRight]]) {
    const address = page.getByLabel(`${side} path`, { exact: true });
    await address.fill(path);
    await address.press("Enter");
    await page.locator(`#${side}-files`).getByRole("option", { name: /^large-diff.txt/ }).waitFor();
  }

  async function compare(name) {
    for (const side of ["left", "right"]) {
      await page.locator(`#${side}-files`).getByRole("option").filter({ hasText: name }).click();
    }
    await page.keyboard.press("Shift+F11");
    await dialog.waitFor();
  }

  const tooDifferent = dialog.getByRole("alert").filter({ hasText: "These files contain too many differences to compare." });
  await compare("large-diff.txt");
  await busy.waitFor();
  await whitespace.check();
  await busy.waitFor();
  assert.equal(await tooDifferent.count(), 0, "Changing settings while the worker is busy must respond immediately.");
  await close.click();
  await dialog.waitFor({ state: "hidden" });

  await compare("large-diff.txt");
  await tooDifferent.waitFor();
  await close.click();
  await compare("line-limit.txt");
  await dialog.getByRole("alert").filter({ hasText: "Choose files shorter than 20,000 lines." }).waitFor();
  await close.click();

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
  await close.click();
  console.log("Verified comparison responsiveness, stale-result cleanup, limits, and whitespace navigation.");
}
