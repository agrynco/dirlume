import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const themes = ["dark", "light", "classic-blue", "lavender", "emerald", "midnight", "sunrise"];
const names = ["01-first.txt", "02-second.fixture", "03-third.txt", "04-last.txt"];
const background = "Current marked row background";
const outline = "Current marked row outline";
const markModifier = process.platform === "darwin" ? "Meta" : "Control";

const style = (row) => row.evaluate((item) => {
  const css = getComputedStyle(item);
  const background = css.backgroundColor === "rgba(0, 0, 0, 0)" ? getComputedStyle(item.closest(".pane")).backgroundColor : css.backgroundColor;
  return { background, outline: css.outlineColor, line: `${css.outlineWidth} ${css.outlineStyle}` };
});

async function verifySelectedNames(list) {
  const colors = await list.locator(".file-row:is(.marked, [data-current=true]) .file-name-text").evaluateAll((names) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--panel-selected-ink)";
    names[0].append(probe);
    const selection = getComputedStyle(probe).color;
    probe.remove();
    return names.map((name) => ({
      name: name.textContent,
      actual: getComputedStyle(name).color,
      selection,
      opacity: getComputedStyle(name.closest(".file-name")).opacity,
    }));
  });
  assert.ok(colors.length > 0);
  for (const { name, actual, selection, opacity } of colors) {
    assert.equal(actual, selection, name);
    assert.equal(opacity, "1", name);
  }
}

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
    const platform = process.env.DIRLUME_TEST_PLATFORM;
    const page = await browser.newPage({ viewport: { width: 1120, height: 720 }, locale: "en-US",
      userAgent: platform && `Mozilla/5.0 (${platform})` });
    page.setDefaultTimeout(8000);
    await page.route("http://dirlume.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    await page.addInitScript(({ layout, names }) => {
      const key = "dirlume.preferences.v1";
      if (!localStorage.getItem(key)) {
        localStorage.setItem(key, JSON.stringify({ layout, theme: "light", hidden: true, showTitlebarScheme: true,
          schemes: [
            { id: "legacy", name: "Legacy panels", base: "light", colors: { "panel-selection": "#e1f1ef" }, fonts: {} },
            { id: "file-colors", name: "File colors", base: "light", colors: { "panel-selected-ink": "#292941" }, fonts: {},
              fileTypes: [{ id: "fixture", name: "Fixture files", extensions: ["fixture"], color: "#a22da4" }] },
          ] }));
      }
      const home = /Windows/.test(navigator.userAgent) ? "C:\\fixture" : "/fixture";
      const entries = [...names, "sample-folder"].map((name, index) =>
        ({ name, directory: name === "sample-folder", hidden: index === 2 || index === 3,
          system: index === 3, link: false, size: 0, modified: null }));
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
    const itemIcon = (item) => item.locator(".file-name > :is(svg.lucide-file, svg.folder-icon)");
    const cellWeights = (item) => item.locator(".file-name, .file-size, .file-date, .file-time")
      .evaluateAll((cells) => cells.map((cell) => getComputedStyle(cell).fontWeight));
    for (const side of ["left", "right"]) {
      const scope = page.locator(`#${side}-files`);
      for (const item of [row(0, side), scope.locator('[data-tooltip="sample-folder"]')]) {
        await item.click();
        const icon = itemIcon(item);
        await icon.waitFor();
        const initial = await icon.boundingBox();
        const weights = await cellWeights(item);
        for (const isMarked of [true, false]) {
          await item.click();
          await scope.press("Insert");
          assert.equal(await item.evaluate((element) => element.classList.contains("marked")), isMarked);
          assert.deepEqual(await icon.boundingBox(), initial, `${layout}, ${side}, ${await item.getAttribute("data-tooltip")}`);
          assert.deepEqual(await cellWeights(item), weights);
        }
      }
    }
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
      await verifySelectedNames(left);
      await verifySelectedNames(page.locator("#right-files"));
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
    const right = page.locator("#right-files");
    await schemes.selectOption("custom:file-colors");
    await row(0, "right").click();
    await right.press("ArrowDown");
    await row(1, "right").and(right.locator("[data-current=true]")).waitFor();
    await verifySelectedNames(left);
    await verifySelectedNames(right);
    await right.press("ArrowUp");
    assert.equal(await row(1, "right").locator(".file-name-text").evaluate((name) => getComputedStyle(name).color), "rgb(162, 45, 164)");
    await schemes.selectOption("system");
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      await page.locator(`html[data-theme=${JSON.stringify(colorScheme)}]`).waitFor();
      await verifySelectedNames(left);
      await verifySelectedNames(right);
    }
    await schemes.selectOption("light");
    await row(1, "right").click({ modifiers: [markModifier] });
    assert.equal(await right.locator(".marked").count(), 2);
    await row(2).click();
    const command = page.getByRole("combobox", { name: "Command line", exact: true });
    await command.fill("echo");
    await command.press("Space");
    assert.equal(await command.inputValue(), "echo ");
    assert.equal(await left.locator(".marked").count(), 3);
    await command.fill("");
    await left.press("Space");
    assert.equal(await left.locator(".marked").count(), 0);
    assert.equal(await right.locator(".marked").count(), 2);
    assert.equal(await row(2).getAttribute("data-current"), "true");
    await left.press("Space");
    assert.equal(await row(2).getAttribute("data-current"), "true");

    if (layout === "standard") {
      const options = page.getByRole("dialog", { name: "Options", exact: true });
      async function shortcuts() {
        await page.getByRole("button", { name: "Options", exact: true }).click();
        await options.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
      }
      const done = () => options.getByRole("button", { name: "Done", exact: true }).click();
      await shortcuts();
      await options.getByRole("button", { name: "Change Space for Clear marks", exact: true }).click();
      await options.getByRole("textbox", { name: "New shortcut to replace Space for Clear marks", exact: true }).press("Escape");
      const conflict = page.getByRole("dialog", { name: "Shortcut conflict", exact: true });
      await conflict.getByRole("button", { name: "Reassign shortcut", exact: true }).click();
      await done();
      await right.press("Escape");
      assert.equal(await right.locator(".marked").count(), 0);
      assert.equal(await row(1, "right").getAttribute("data-current"), "true");
      await shortcuts();
      await options.getByRole("button", { name: "Remove Escape from Clear marks", exact: true }).click();
      await done();
      await row(2, "right").click({ modifiers: [markModifier] });
      await right.press("Escape");
      assert.equal(await right.locator(".marked").count(), 1);

      await page.evaluate(() => {
        const key = "dirlume.preferences.v1";
        const preferences = JSON.parse(localStorage.getItem(key));
        preferences.activeShortcutScheme = "legacy-space";
        preferences.shortcutSchemes.push({ id: "legacy-space", name: "Legacy Space", bindings: { mark: ["Space"] } });
        localStorage.setItem(key, JSON.stringify(preferences));
      });
      await page.reload();
      await shortcuts();
      await options.getByRole("button", { name: "Change Space for Mark or unmark item", exact: true }).waitFor();
      await options.getByRole("button", { name: "Add shortcut for Clear marks", exact: true }).click();
      await options.getByRole("textbox", { name: "New shortcut for Clear marks", exact: true }).press("Space");
      await conflict.getByRole("button", { name: "Reassign shortcut", exact: true }).click();
      await done();
      await row(2, "right").click();
      await right.press("Space");
      assert.equal(await right.locator(".marked").count(), 0);
    }
    await page.close();
  }
  console.log("Verified current marked row contrast in every theme and layout, keyboard movement, preview, and independent saved colors.");
  console.log("Verified file and folder icon positions, active-pane mark clearing, text input, Escape conflicts, and disabling Clear marks.");
} finally {
  await browser.close();
}

function stylePreview(preview) {
  return preview.evaluate((element) => {
    const css = getComputedStyle(element);
    return { background: css.backgroundColor, outline: css.outlineColor };
  });
}
