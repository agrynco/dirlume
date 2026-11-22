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

async function openWindow(browser, { administrator = false, workspace = null, portable = false, missing = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 710 }, locale: "en-US",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
  page.setDefaultTimeout(8000);
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  await page.addInitScript(({ administrator, workspace, portable, missing, folders, dark, stale }) => {
    window.isTauri = true;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.elevationRequests = [];
    window.renames = [];
    window.acceptUac = false;
    window.portableWrites = 0;
    const normal = (name) => ({ kind: "local", path: folders[name], parent: null });
    localStorage.setItem("dirlume.preferences.v1", JSON.stringify(administrator ? stale : dark));
    localStorage.setItem("dirlume.workspace.v1", JSON.stringify({
      panels: { left: { place: normal("left") }, right: { place: normal("right") } },
      active: "left", split: 58, documents: [], activeDocument: null,
    }));
    const entry = (name) => ({ name, directory: true, hidden: false, link: false, size: null, modified: null });
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      invoke: async (command, args) => {
        if (command === "windows_startup") return { administrator, handoff: workspace !== null, workspace, workspaceUnavailable: false };
        if (command === "read_portable_state" && portable) return { preferences: administrator ? stale : dark, settingsError: null, updateError: null };
        if (command === "save_portable_preferences") window.portableWrites++;
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
  }, { administrator, workspace, portable, missing, folders, dark, stale });
  await page.goto("http://dirlume.test/");
  return page;
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
  console.log("Verified administrator workspace handoff, original window after UAC cancellation, both panes, missing selection, and isolated Portable settings.");
} finally {
  await browser.close();
}
