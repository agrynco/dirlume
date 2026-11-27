import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const folders = { left: "C:\\fixture\\left", right: "D:\\fixture\\right" };
const dark = {
  theme: "dark", layout: "twin", activeScheme: "current", showTitlebarScheme: true,
  schemes: [{ id: "current", name: "Current scheme", base: "dark", colors: { "panel-bg": "#141e2b" }, fonts: {} }],
  viewFontSizes: { left: 21, right: 22 },
};
const stale = { theme: "light", layout: "classic", viewFontSizes: { left: 12 } };
const files = (page, side) => page.locator(`#${side}-files`);
const blocked = (page, side) => files(page, side).locator('.file-row[data-tooltip="Protected folder"]');

async function openWindow(browser, { administrator = false, workspace = null, portable = false, missing = false, settings, shared, label = "main" } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 710 }, locale: "en-US",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
  page.setDefaultTimeout(8000);
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  if (shared) {
    await page.exposeFunction("readSharedSettings", () => shared.file);
    await page.exposeFunction("writeSharedSettings", (preferences, onlyIfMissing) => {
      if (!shared.writable) return false;
      if (onlyIfMissing && shared.file) return null;
      shared.file = preferences;
      shared.writes++;
      return true;
    });
  }
  await page.addInitScript(({ administrator, workspace, portable, missing, folders, dark, stale, settings, shared, label }) => {
    window.isTauri = true;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.elevationRequests = [];
    window.renames = [];
    window.acceptUac = false;
    window.portableWrites = 0;
    const normal = (name) => ({ kind: "local", path: folders[name], parent: null });
    localStorage.setItem("dirlume.preferences.v1", JSON.stringify(settings ?? (administrator ? stale : dark)));
    localStorage.setItem("dirlume.workspace.v1", JSON.stringify({
      panels: { left: { place: normal("left") }, right: { place: normal("right") } },
      active: "left", split: 58, documents: [], activeDocument: null,
    }));
    const entry = (name) => ({ name, directory: true, hidden: false, link: false, size: null, modified: null });
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label }, currentWebview: { label } },
      transformCallback: () => 1,
      invoke: async (command, args) => {
        if (command === "windows_startup") return { administrator, handoff: workspace !== null, workspace, workspaceUnavailable: false };
        if (command === "read_windows_settings" && (shared || portable)) {
          const preferences = shared ? await window.readSharedSettings() : workspace?.preferences ?? (administrator ? stale : dark);
          return { preferences, settingsError: null, updateError: null };
        }
        if (command === "save_windows_preferences") {
          if (!shared) { window.portableWrites++; return true; }
          const saved = await window.writeSharedSettings(args.preferences, args.onlyIfMissing);
          if (saved === false) throw new Error("Could not save dirlume-settings.json beside Dirlume.exe.");
          return saved === true;
        }
        if (command === "plugin:window|set_title") window.nativeTitle = args.value;
        if (command === "locations") return [{ label: "Home", path: "C:\\default" }, { label: "Downloads", path: "C:\\default\\downloads" }];
        if (command === "list_directory") return { path: args.path, parent: null, omitted: 0,
          entries: [...(!missing ? [entry("Protected folder")] : []), entry("Another folder")] };
        if (command === "space_mount") return { path: args.path, share: false };
        if (command === "scan_local_space") {
          window.scanned = args.root;
          args.output.onmessage({ kind: "start", strategy: "walk" });
          args.output.onmessage({ kind: "batch", changes: [{ closed: 0, error: null, partial: false }] });
          args.output.onmessage({ kind: "finished" });
        }
        if (command === "transfer_item") {
          window.renames.push(args.request);
          throw new Error("Access is denied. (os error 5)");
        }
        if (command === "open_elevated") {
          window.elevationRequests.push(args.workspace);
          return window.acceptUac;
        }
        if (command === "file_icons") return args.items.map(() => null);
        return null;
      },
    };
  }, { administrator, workspace, portable, missing, folders, dark, stale, settings, shared: !!shared, label });
  await page.goto("http://dirlume.test/");
  return page;
}

async function checkSharedSettings(browser, portable) {
  const shared = { file: null, writable: true, writes: 0 };
  const legacy = { theme: "lavender", layout: "twin", showTitlebarScheme: true, activeShortcutScheme: "fixture",
    shortcutSchemes: [{ id: "fixture", name: "Fixture keys", bindings: { newFile: ["Ctrl+Alt+J"] } }] };
  const directBeforeMigration = await openWindow(browser, { administrator: true, portable, shared });
  await directBeforeMigration.locator(".administrator-label").waitFor();
  assert.equal(shared.file, null);
  assert.equal(shared.writes, 0);
  await directBeforeMigration.close();

  const normal = await openWindow(browser, { portable, shared, settings: legacy });
  await normal.locator('html[data-theme="lavender"]').waitFor();
  assert.equal(shared.file.theme, "lavender");
  assert.equal(shared.file.layout, "twin");
  assert.deepEqual(shared.file.shortcutSchemes[0].bindings.newFile, ["Ctrl+Alt+J"]);
  assert.equal(shared.writes, 1);

  const administrator = await openWindow(browser, { administrator: true, portable, shared });
  await administrator.locator('html[data-theme="lavender"]').waitFor();
  assert.equal(shared.writes, 1);
  await administrator.locator(".topbar-scheme").selectOption("slate");
  await administrator.waitForFunction(() => JSON.parse(localStorage.getItem("dirlume.preferences.v1")).theme === "slate");
  assert.equal(shared.file.theme, "slate");

  const next = await openWindow(browser, { portable, shared, settings: legacy });
  await next.locator('html[data-theme="slate"]').waitFor();
  shared.writable = false;
  const optionsWindow = await openWindow(browser, { portable, shared, label: "options" });
  const options = optionsWindow.getByRole("dialog", { name: "Options", exact: true });
  await options.getByRole("button", { name: "Appearance", exact: true }).click();
  await options.getByRole("combobox", { name: "Color scheme", exact: true }).selectOption("sunrise");
  await options.getByRole("button", { name: "Done", exact: true }).click();
  await options.getByRole("alert").filter({ hasText: "Could not save dirlume-settings.json" }).waitFor();
  assert.equal(shared.file.theme, "slate");
  assert.equal(await next.locator("html").getAttribute("data-theme"), "slate");
  assert.equal(await optionsWindow.evaluate(() => JSON.parse(localStorage.getItem("dirlume.preferences.v1")).theme), "slate");

  shared.writable = true;
  await options.getByRole("button", { name: "Apply", exact: true }).click();
  await optionsWindow.waitForFunction(() => JSON.parse(localStorage.getItem("dirlume.preferences.v1")).theme === "sunrise");
  assert.equal(shared.file.theme, "sunrise");
  const reopened = await openWindow(browser, { administrator: true, portable, shared });
  await reopened.locator('html[data-theme="sunrise"]').waitFor();
  const handoff = await openWindow(browser, { administrator: true, portable, shared,
    workspace: { side: "left", directory: folders.left, split: 50, preferences: stale } });
  await handoff.locator('html[data-theme="sunrise"]').waitFor();
  assert.equal(shared.file.theme, "sunrise");
  await Promise.all([normal.close(), administrator.close(), next.close(), optionsWindow.close(), reopened.close(), handoff.close()]);

  const protectedFolder = { file: null, writable: false, writes: 0 };
  const oldProfile = await openWindow(browser, { portable, shared: protectedFolder, settings: legacy });
  await oldProfile.locator('html[data-theme="lavender"]').waitFor();
  assert.equal(protectedFolder.file, null);
  protectedFolder.writable = true;
  const upgradeHandoff = await openWindow(browser, { administrator: true, portable, shared: protectedFolder,
    workspace: { side: "left", directory: folders.left, split: 50, preferences: legacy } });
  await upgradeHandoff.locator('html[data-theme="lavender"]').waitFor();
  assert.equal(protectedFolder.file.theme, "lavender");
  await Promise.all([oldProfile.close(), upgradeHandoff.close()]);
}

function contrast(first, second) {
  const luminance = (color) => color.match(/[\d.]+/g).slice(0, 3).map((value) => Number(value) / 255)
    .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const values = [luminance(first), luminance(second)];
  return (Math.max(...values) + .05) / (Math.min(...values) + .05);
}

async function checkBadge(browser) {
  const custom = { id: "badge-match", name: "Matching badge", base: "light",
    colors: { surface: "#7f2332", raised: "#7f2332", line: "#7f2332" }, fonts: {} };
  const themes = ["light", "dark", "slate", "classic-blue", "lavender", "emerald", "aurora", "midnight", "sunrise", "graphite", "custom:badge-match"];
  for (const [language, label] of [["en", "Administrator"], ["uk", "Адміністратор"], ["ru", "Администратор"]]) {
    const page = await openWindow(browser, { administrator: true, settings: {
      language, theme: "light", showTitlebarScheme: true, schemes: [custom],
    } });
    await page.setViewportSize({ width: 760, height: 460 });
    const badge = page.locator(".administrator-label");
    await badge.getByText(label, { exact: true }).waitFor();
    const scheme = page.locator(".topbar-scheme");
    for (const theme of themes) {
      await scheme.selectOption(theme);
      const expected = theme.startsWith("custom:") ? custom.base : theme;
      await page.locator(`html[data-theme="${expected}"]`).waitFor();
      const style = await badge.evaluate((element) => {
        const css = getComputedStyle(element);
        const topbar = element.closest(".topbar");
        const bounds = element.getBoundingClientRect();
        const menu = topbar.querySelector(".main-menu-strip").getBoundingClientRect();
        const controls = topbar.querySelector(".window-controls").getBoundingClientRect();
        return {
          text: css.color,
          fill: css.backgroundColor,
          innerEdge: css.borderTopColor,
          outerEdge: css.boxShadow.match(/rgba?\([^)]+\)/)?.[0],
          background: getComputedStyle(topbar).backgroundColor,
          fits: element.scrollWidth <= element.clientWidth && bounds.right <= menu.left && menu.right <= controls.left &&
            controls.right <= innerWidth && bounds.bottom <= topbar.getBoundingClientRect().bottom,
        };
      });
      assert.ok(contrast(style.text, style.fill) >= 7, `${language}/${theme} text contrast`);
      assert.ok([style.fill, style.innerEdge, style.outerEdge].some((color) => contrast(color, style.background) >= 3),
        `${language}/${theme} edge contrast`);
      assert.ok(style.fits, `${language}/${theme} badge fits`);
      if (theme === "custom:badge-match") assert.equal(style.background, style.fill);
    }
    await page.close();
  }
}

async function denyRename(page, side) {
  await blocked(page, side).click();
  await files(page, side).press("F6");
  const setup = page.getByRole("dialog", { name: "Rename or move", exact: true });
  await setup.getByRole("combobox", { name: "Destination" }).fill(`${folders[side]}\\Renamed folder`);
  await setup.getByRole("button", { name: "Move", exact: true }).click();
  const raise = page.getByRole("button", { name: "Open as administrator", exact: true });
  await raise.waitFor();
  return raise;
}

const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const [side, portable] of [["left", false], ["right", true]]) {
    const other = side === "left" ? "right" : "left";
    const source = await openWindow(browser, { portable });
    await source.getByRole("heading", { name: "Dirlume", exact: true }).waitFor();
    assert.equal(await source.locator(".administrator-label").count(), 0);
    if (!portable) {
      await source.locator(`#${other}-pane`).getByRole("button", { name: "Analyze space", exact: true }).click();
      await source.locator(`.space-analyzer-${other}`).getByRole("button", { name: "Rescan" }).waitFor();
    }
    const raise = await denyRename(source, side);
    await raise.click();
    await source.waitForFunction(() => window.elevationRequests.length === 1);
    assert.equal(await blocked(source, side).getAttribute("data-current"), "true");
    assert.equal(await source.locator("html").getAttribute("data-theme"), "dark");
    assert.equal(await source.evaluate(() => window.renames.length), 1);

    await source.evaluate(() => { window.acceptUac = true; });
    await raise.click();
    await source.waitForFunction(() => window.elevationRequests.length === 2);
    const first = await source.evaluate(() => window.elevationRequests.at(-1));
    assert.equal(first.side, side);
    assert.equal(first.directory, folders[side]);
    assert.equal(first.selected, "Protected folder");
    assert.equal(first.otherFolder, folders[other]);
    assert.equal(first.otherAnalyzer, portable ? undefined : folders[other]);
    assert.equal(first.split, 58);
    const launched = await openWindow(browser, { administrator: true, workspace: first, portable });
    await launched.locator(".administrator-label").getByText("Administrator", { exact: true }).waitFor();
    await launched.getByRole("heading", { name: "Dirlume (Administrator)", exact: true }).waitFor();
    await launched.waitForFunction((side) => document.activeElement?.id === `${side}-files`, side);
    await launched.waitForFunction(() => window.nativeTitle === "Dirlume (Administrator)");
    assert.equal(await blocked(launched, side).getAttribute("data-current"), "true");
    assert.equal(await launched.locator(".app").getAttribute("data-layout"), "twin");
    assert.equal(await launched.locator(`#${side}-pane`).evaluate((pane) => pane.style.getPropertyValue("--view-font-size")), `${dark.viewFontSizes[side]}px`);
    assert.equal(await launched.locator("html").evaluate((root) => root.style.getPropertyValue("--panel-bg")), "#141e2b");
    if (portable) {
      await files(launched, other).waitFor();
      assert.equal(await launched.evaluate(() => window.portableWrites), 0);
    } else {
      await launched.waitForFunction((path) => window.scanned === path, folders[other]);
    }
    assert.equal(await launched.evaluate(() => window.renames.length), 0);
    await launched.setViewportSize({ width: 780, height: 560 });
    assert.equal(await launched.locator(".administrator-label").isVisible(), true);

    await source.keyboard.press("Escape");
    await source.getByRole("dialog").waitFor({ state: "hidden" });
    await source.locator(".topbar-scheme").selectOption("slate");
    await denyRename(source, side).then((action) => action.click());
    await source.waitForFunction(() => window.elevationRequests.length === 3);
    const changed = await source.evaluate(() => window.elevationRequests.at(-1));
    const reopened = await openWindow(browser, { administrator: true, workspace: changed, portable, missing: true });
    await reopened.locator('html[data-theme="slate"]').waitFor();
    await reopened.getByText("Item no longer found: Protected folder", { exact: true }).waitFor();
    await reopened.waitForFunction((side) => document.activeElement?.id === `${side}-files`, side);
    await Promise.all([source.close(), launched.close(), reopened.close()]);
  }

  const direct = await openWindow(browser, { administrator: true });
  await direct.getByRole("heading", { name: "Dirlume (Administrator)", exact: true }).waitFor();
  for (const portable of [false, true]) await checkSharedSettings(browser, portable);
  console.log("Verified settings migration, both launch modes, denied writes, and successful retry for installed and Portable fixtures.");
  await checkBadge(browser);
  console.log("Verified Administrator badge contrast in every built-in scheme and a matching custom scheme at minimum width in all three languages.");
  console.log("Verified administrator workspace handoff, original window after UAC cancellation, both panes, and missing selection.");
} finally {
  await browser.close();
}
