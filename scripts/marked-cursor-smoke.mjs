import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const themes = ["dark", "light", "slate", "classic-blue", "lavender", "emerald", "aurora", "midnight", "sunrise", "graphite"];
const names = ["01-first.txt", "02-second.txt", "03-third.txt", "04-last.txt"];
const background = "Current marked row background";
const outline = "Current marked row outline";
const markModifier = process.platform === "darwin" ? "Meta" : "Control";

const style = (row) => row.evaluate((item) => {
  const css = getComputedStyle(item);
  const background = css.backgroundColor === "rgba(0, 0, 0, 0)" ? getComputedStyle(item.closest(".pane")).backgroundColor : css.backgroundColor;
  return { background, outline: css.outlineColor, line: `${css.outlineWidth} ${css.outlineStyle}` };
});

function contrast(first, second) {
  const luminance = (rgb) => rgb.match(/[\d.]+/g).slice(0, 3).map((channel) => Number(channel) / 255)
    .map((channel) => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light + .05) / (dark + .05);
}

const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const layout of ["standard", "twin", "classic"]) {
    const page = await browser.newPage({ viewport: { width: 1120, height: 720 }, locale: "en-US" });
    page.setDefaultTimeout(8000);
    await page.route("http://dirlume.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    await page.addInitScript(({ layout, names }) => {
      const key = "dirlume.preferences.v1";
      if (!localStorage.getItem(key)) {
        localStorage.setItem(key, JSON.stringify({ layout, theme: "light", showTitlebarScheme: true,
          schemes: [{ id: "legacy", name: "Legacy panels", base: "light", colors: { "panel-selection": "#e1f1ef" }, fonts: {} }] }));
      }
      const home = /Windows/.test(navigator.userAgent) ? "C:\\fixture" : "/fixture";
      const entries = names.map((name) => ({ name, directory: false, hidden: false, link: false, size: 0, modified: null }));
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args) => {
          if (command === "locations") return [{ label: "Home", path: home }];
          if (command === "list_directory") return { path: args.path, parent: null, entries, omitted: 0 };
          if (command === "file_icons" || command === "installed_fonts") return [];
          return null;
        },
      };
    }, { layout, names });
    await page.goto("http://dirlume.test/");
    const left = page.locator("#left-files");
    const row = (index, side = "left") => page.locator(`#${side}-files [data-tooltip=${JSON.stringify(names[index])}]`);
    const current = (side) => page.locator(`#${side}-files .file-row.marked[data-current=true]`);
    const activeCursor = () => page.locator(".pane.active .file-row.marked[data-current=true]");
    const schemes = page.locator(".topbar-scheme");
    for (const index of names.keys()) await row(index).click({ modifiers: [markModifier] });
    await row(0, "right").click({ modifiers: [markModifier] });

    for (const theme of themes) {
      await schemes.selectOption(theme);
      await page.locator(`html[data-theme=${JSON.stringify(theme)}]`).waitFor();
      await row(0).click();
      const first = await style(row(0));
      const adjacent = await style(row(1));
      assert.equal(first.line, "2px solid", `${theme} in ${layout}`);
      assert.notEqual(first.background, adjacent.background);
      assert.ok(contrast(first.outline, adjacent.background) >= 3, `${theme} in ${layout}`);
      await left.press("ArrowDown");
      await row(1).and(current("left")).waitFor();
      assert.equal(await activeCursor().count(), 1);
      assert.deepEqual(await style(row(1)), first);
      assert.equal(await left.locator(".marked").count(), names.length);
      assert.notEqual((await style(row(0))).line, "2px solid");
    }

    await row(3).click({ modifiers: [markModifier] });
    await row(2).click();
    await left.press("ArrowDown");
    assert.equal(await activeCursor().count(), 0);
    await left.press("ArrowUp");
    await row(2).and(current("left")).waitFor();
    assert.equal(await left.locator(".marked").count(), 3);
    await left.press("Tab");
    await row(0, "right").and(activeCursor()).waitFor();
    assert.notEqual((await style(row(2))).line, "2px solid");

    if (layout === "standard") {
      const options = page.getByRole("dialog", { name: "Options", exact: true });
      const hex = (label) => options.getByRole("textbox", { name: `${label} hex`, exact: true });
      const colors = async () => {
        await page.getByRole("button", { name: "Options", exact: true }).click();
        const tree = options.getByRole("navigation", { name: "Options sections" });
        const panels = tree.getByRole("button", { name: "Panels", exact: true });
        if (!await panels.isVisible()) await tree.getByRole("button", { name: "Appearance", exact: true }).click();
        await panels.click();
      };
      const done = () => options.getByRole("button", { name: "Done", exact: true }).click();
      await schemes.selectOption("light");
      await page.locator('html[data-theme="light"]').waitFor();
      await row(0).click();
      const inherited = await style(row(0));
      await schemes.selectOption("custom:legacy");
      assert.deepEqual(await style(row(0)), inherited);
      const adjacent = await style(row(1));
      const inactive = await style(row(0, "right"));
      await colors();
      const preview = options.locator(".preview-file-current-marked");
      await hex(background).fill("#aaccdd");
      await page.waitForFunction(() => {
        const sample = document.querySelector(".preview-file-current-marked");
        return sample && getComputedStyle(sample).backgroundColor === "rgb(170, 204, 221)";
      }, null, { timeout: 8000 });
      await hex(outline).fill("#234568");
      assert.deepEqual(await stylePreview(preview), { background: "rgb(170, 204, 221)", outline: "rgb(35, 69, 104)" });
      await done();
      await page.reload();
      await row(0).and(current("left")).waitFor();
      assert.deepEqual(await style(row(0)), { background: "rgb(170, 204, 221)", outline: "rgb(35, 69, 104)", line: "2px solid" });
      assert.deepEqual(await style(row(1)), adjacent);
      assert.deepEqual(await style(row(0, "right")), inactive);
      await colors();
      await options.getByRole("button", { name: `Reset ${background.toLowerCase()}`, exact: true }).click();
      assert.deepEqual(await stylePreview(preview), { background: inherited.background, outline: "rgb(35, 69, 104)" });
      await options.getByRole("button", { name: `Reset ${outline.toLowerCase()}`, exact: true }).click();
      await done();
      assert.deepEqual(await style(row(0)), inherited);
    }
    await page.close();
  }
  console.log("Verified current marked row contrast in every theme and layout, keyboard movement, preview, and independent saved colors.");
} finally {
  await browser.close();
}

function stylePreview(preview) {
  return preview.evaluate((element) => {
    const css = getComputedStyle(element);
    return { background: css.backgroundColor, outline: css.outlineColor };
  });
}
