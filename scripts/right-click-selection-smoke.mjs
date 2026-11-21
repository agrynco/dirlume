import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const names = ["01-first.txt", "02-second.txt", "03-third.txt", "04-folder", "05-last.txt"];
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 720 }, locale: "en-US",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36" });
  page.setDefaultTimeout(8000);
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  await page.addInitScript((names) => {
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args) => {
        if (command === "locations") return [{ label: "Home", path: "/fixture" }];
        if (command === "list_directory") return { path: args.path, parent: "/",
          entries: names.map((name) => ({ name, directory: name === "04-folder", hidden: false, link: false,
            size: 0, modified: null })), omitted: 0 };
        if (command === "file_icons" || command === "installed_fonts") return [];
        return null;
      },
    };
  }, names);
  await page.goto("http://dirlume.test/");
  const files = (side = "left") => page.locator(`#${side}-files`);
  const row = (name, side) => files(side).locator(`[data-tooltip=${JSON.stringify(name)}]`);
  const menu = page.getByRole("menu", { name: "File actions", exact: true });
  const spinner = page.getByRole("status", { name: "Release to open the context menu" });
  const marked = (side) => files(side).locator(".file-row.marked").evaluateAll((items) =>
    items.map((item) => item.dataset.tooltip).sort());
  const click = (name, side) => row(name, side).click({ button: "right" });
  const moveTo = async (target) => {
    const bounds = await target.boundingBox();
    assert.ok(bounds);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  };
  const press = () => page.mouse.down({ button: "right" });
  const release = () => page.mouse.up({ button: "right" });
  const dismiss = async () => { await page.keyboard.press("Escape"); await menu.waitFor({ state: "hidden" }); };
  const [first, second, third, folder, last] = names;

  await click(first);
  await menu.waitFor();
  await dismiss();
  assert.deepEqual(await marked(), []);
  await page.getByRole("button", { name: "Options", exact: true }).click();
  const options = page.getByRole("dialog", { name: "Options", exact: true });
  const sections = options.getByRole("navigation", { name: "Options sections" });
  await sections.getByRole("button", { name: "Main File Panels", exact: true }).click();
  const enabled = options.getByRole("checkbox", { name: "Right-click selection", exact: true });
  assert.equal(await enabled.isChecked(), false);
  await enabled.check();
  await options.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await click(last);
  await click(last, "right");
  await click("..");
  assert.deepEqual(await marked(), [last]);
  assert.deepEqual(await marked("right"), [last]);
  assert.equal(await menu.count(), 0);
  await click(last, "right");
  assert.deepEqual(await marked("right"), []);

  await moveTo(row(first));
  await press();
  await moveTo(row(third));
  await moveTo(row(second));
  await page.waitForTimeout(550);
  assert.equal(await spinner.count(), 0);
  assert.equal(await menu.count(), 0);
  await release();
  assert.deepEqual(await marked(), [first, second, third, last]);

  await moveTo(row(third));
  await press();
  await moveTo(row(first));
  await moveTo(row(third));
  await release();
  assert.deepEqual(await marked(), [last]);
  await moveTo(row(folder));
  await press();
  await spinner.waitFor();
  assert.equal(await menu.count(), 0);
  await release();
  await menu.waitFor();
  assert.equal(await spinner.count(), 0);
  assert.deepEqual(await marked(), [last]);
  await dismiss();
  await moveTo(row(last));
  await press();
  await spinner.waitFor();
  await release();
  await menu.waitFor();
  assert.deepEqual(await marked(), [last]);
  await dismiss();

  const bounds = await files().boundingBox();
  assert.ok(bounds);
  await page.mouse.move(bounds.x + 32, bounds.y + bounds.height - 15);
  await press();
  await spinner.waitFor();
  await release();
  await menu.waitFor();
  assert.deepEqual(await marked(), [last]);
  await dismiss();
  await row(first).click();
  await files().press("Insert");
  assert.deepEqual(await marked(), [first]);
  console.log("Verified opt-in right-click selection, skipped rows, drag direction, hold feedback, and menus.");
} finally {
  await browser.close();
}
