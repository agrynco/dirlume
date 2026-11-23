import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { openMainMenu } from "./menu-header-smoke.mjs";

const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const [client, userAgent] of [
    ["Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"],
    ["Ubuntu", "Mozilla/5.0 (X11; Linux x86_64)"],
    ["macOS", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"],
  ]) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, userAgent });
    page.setDefaultTimeout(5000);
    await page.route("http://dirlume.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    const windows = client === "Windows";
    const home = windows ? "C:\\fixture" : "/fixture";
    const bookmark = home + (windows ? "\\bookmarked" : "/bookmarked");
    const downloads = home + (windows ? "\\downloads" : "/downloads");
    await page.addInitScript(({ home, bookmark, downloads }) => {
      localStorage.removeItem("dirlume.workspace.v1");
      const groups = Array.from({ length: 10 }, () => []);
      groups[8] = [{ title: "Bookmark", path: bookmark }];
      groups[9] = [...groups[8], { title: "Downloads folder", path: downloads }];
      localStorage.setItem("dirlume.folder-shortcuts.v1", JSON.stringify(groups));
      const file = { name: "note.txt", directory: false, link: false, hidden: false, size: 4, modified: null };
      const listing = { entries: [file], omitted: 0 };
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args = {}) => {
          switch (command) {
            case "locations": return [{ label: "Home", path: home }, { label: "Downloads", path: downloads }];
            case "list_directory": return { path: args.path, parent: null, ...listing };
            case "list_processes": return [];
            case "read_text": return { text: "Test", encoding: "utf8" };
            case "scan_local_space":
              args.output.onmessage({ kind: "start", strategy: "walk" });
              args.output.onmessage({ kind: "batch", changes: [
                { parent: 0, name: file.name, directory: false, size: file.size, allocated: 8, shared: false },
                { closed: 0, partial: false, error: null },
              ] });
              args.output.onmessage({ kind: "finished" });
              return;
            case "git_repository": return { root: home, name: "Fixture", headRef: null, head: null, branches: [] };
            case "git_history": return { commits: [], nextOffset: null };
            case "ftp_profiles": return [{ id: "ftp", label: "FTP fixture", host: "fixture", port: 21 }];
            case "ssh_profiles": return [];
            case "connect_ftp": return { id: 1, address: "fixture", origin: "ftp://fixture", segments: ["nested"], listing };
            case "list_ftp": return listing;
            case "file_icons": return args.items.map(() => null);
            default: return null;
          }
        },
      };
    }, { home, bookmark, downloads });

    const button = (scope, name) => scope.getByRole("button", { name, exact: true });
    const files = (side) => page.locator(`#${side}-files`);
    const pane = (side) => page.getByRole("region", { name: `${side} pane`, exact: true });
    const sources = (side) => page.getByRole("group", { name: `${side === "left" ? "Left" : "Right"} pane sources`, exact: true });
    const opposite = (side) => side === "left" ? "right" : "left";
    const sourceKey = (side) => side === "left" ? "Alt+F1" : "Alt+F2";
    const initialPath = (side) => side === "left" ? home : downloads;
    const folderPicker = page.getByRole("dialog", { name: "Folder shortcuts", exact: true });
    async function pressBookmark(digit) {
      await page.keyboard.down("ControlRight");
      try { await page.keyboard.press(`Digit${digit}`); }
      finally { await page.keyboard.up("ControlRight"); }
    }
    async function waitForPath(side, path) {
      await page.waitForFunction(({ side, path }) => document.getElementById(`${side}-path`)?.dataset.path === path &&
        document.getElementById(`${side}-files`)?.getAttribute("aria-busy") === "false", { side, path });
    }
    async function enter(view, side) {
      await page.goto("http://dirlume.test/");
      await waitForPath(side, initialPath(side));
      await files(side).getByRole("option", { name: /^note\.txt/ }).click();
      if (view === "Local files") return files(side);
      if (view === "Search results") {
        await button(page, "Find files").click();
        const search = page.getByRole("dialog", { name: "Find files", exact: true });
        await button(search, "Search").click();
        await button(search, "Show in panel").click();
        await pane(side).getByRole("heading", { name: view, exact: true }).waitFor();
        return files(side);
      }
      if (view === "Environment variables") {
        const commands = await openMainMenu(page, "Commands");
        await commands.getByRole("menuitemradio", { name: view, exact: true }).click();
        return button(page.locator(`.environment-${side}`), "Back to files");
      }
      if (view === "Git View") {
        await button(page, view).click();
        return page.getByRole("searchbox", { name: "Filter branches", exact: true });
      }
      if (view === "Space Analyzer") {
        await button(pane(side), "Analyze space").click();
        return button(page.locator(`.space-analyzer-${side}`), "Treemap");
      }
      if (view === "Quick View") {
        await files(opposite(side)).getByRole("option", { name: /^note\.txt/ }).click();
        await button(page, view).click();
        return page.locator(`.quick-view-${side} .text-view`);
      }
      await page.keyboard.press(sourceKey(side));
      if (view === "Processes") {
        assert.equal(await button(sources(side), "Processes").locator("kbd").textContent(), "0");
        await page.keyboard.press("Digit0");
        await pane(side).getByRole("grid", { name: "Running processes", exact: true }).waitFor();
      } else {
        await button(sources(side), "FTP").click();
      }
      if (view === "Remote files") await files(side).getByRole("option", { name: /^FTP fixture/ }).dblclick();
      return files(side);
    }

    for (const side of ["left", "right"]) {
      for (const view of ["Local files", "Remote files", "Connections", "Search results", "Processes",
        "Quick View", "Space Analyzer", "Environment variables", "Git View"]) {
        const origin = await enter(view, side);
        await origin.focus();
        for (const target of [side, opposite(side)]) {
          await page.keyboard.press(sourceKey(target));
          await sources(target).waitFor();
          const heading = target === "left" ? "Left pane sources" : "Right pane sources";
          await page.waitForFunction((label) => [...document.querySelectorAll(".location-popup")].some((menu) =>
            menu.getAttribute("aria-label") === label && menu.contains(document.activeElement)), heading).catch(async (error) => {
            const focused = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
            throw new Error(`${client} ${side} ${view} to ${target} sources left focus on ${focused}`, { cause: error });
          });
          await page.keyboard.press("Escape");
          await sources(target).waitFor({ state: "hidden" });
          await page.waitForFunction((node) => node === document.activeElement, await origin.elementHandle());
        }
        await pressBookmark(0);
        await page.getByText("No folder shortcuts in group 0.", { exact: true }).waitFor();
        await pressBookmark(9);
        await folderPicker.getByRole("option", { name: /^Downloads folder/ }).waitFor();
        await page.keyboard.press("Escape");
        await folderPicker.waitFor({ state: "hidden" });
        await origin.focus();
        await pressBookmark(8);
        await waitForPath(side, bookmark);
        assert.equal(await page.locator(`#${opposite(side)}-path`).getAttribute("data-path"), initialPath(opposite(side)));
      }
      const preview = await enter("Quick View", side);
      await preview.focus();
      await page.keyboard.press(sourceKey(side));
      await button(sources(side), side === "left" ? "Downloads" : "Home").click();
      await waitForPath(side, initialPath(opposite(side)));
      await page.locator(`.quick-view-${side}`).waitFor({ state: "hidden" });
      assert.equal(await page.locator(`#${opposite(side)}-path`).getAttribute("data-path"), initialPath(opposite(side)));
    }
    for (const { saved, expected, version } of [
      { saved: ["1"], expected: "0", version: 9 },
      { saved: "1", expected: "0", version: 9 },
      { saved: ["6"], expected: "6", version: 9 },
      { saved: [], expected: "", version: 9 },
      { saved: ["1"], expected: "1", version: 10 },
    ]) {
      await page.evaluate(({ saved, version }) => {
        localStorage.setItem("dirlume.preferences.v1", JSON.stringify({ bindingDefaults: version, activeShortcutScheme: "fixture",
          shortcutSchemes: [{ id: "fixture", name: "Fixture", bindings: { processSources: saved, imageFit: ["0"] } }] }));
      }, { saved, version });
      await enter("Local files", "left");
      await page.keyboard.press(sourceKey("left"));
      const processes = button(sources("left"), "Processes").locator("kbd");
      if (expected) {
        assert.equal(await processes.textContent(), expected);
        await page.keyboard.press(`Digit${expected}`);
        await pane("left").getByRole("grid", { name: "Running processes", exact: true }).waitFor();
      } else {
        assert.equal(await processes.count(), 0);
        await page.keyboard.press("Digit0");
        assert.equal(await sources("left").isVisible(), true);
      }
    }
    const localized = {
      Windows: { language: "en", title: "Folder shortcuts", up: "Move up", down: "Move down" },
      Ubuntu: { language: "uk", title: "Закладки папок", up: "Перемістити вгору", down: "Перемістити вниз" },
      macOS: { language: "ru", title: "Закладки папок", up: "Переместить вверх", down: "Переместить вниз" },
    }[client];
    for (const theme of ["light", "dark"]) {
      await page.evaluate(({ language, theme }) => {
        localStorage.setItem("dirlume.preferences.v1", JSON.stringify({
          language, theme, bindingDefaults: 8, activeShortcutScheme: "fixture",
          shortcutSchemes: [{ id: "fixture", name: "Fixture", bindings: { pickerFolderUp: ["Ctrl+Shift+ArrowUp"], pickerFolderDown: [] } }],
        }));
      }, { language: localized.language, theme });
      await page.setViewportSize({ width: theme === "dark" ? 330 : 1100, height: 680 });
      await page.reload();
      await page.locator(`html[lang=${localized.language}][data-theme=${theme}]`).waitFor();
      await waitForPath("left", home);
      await files("left").focus();
      await pressBookmark(9);
      const picker = page.getByRole("dialog", { name: localized.title, exact: true });
      const list = picker.getByRole("listbox");
      await list.waitFor();
      const strip = picker.locator(".dialog-action-strip");
      await picker.evaluate((element) => { element.style.setProperty("--dialog-size", "20px"); });
      assert.ok(await strip.evaluate((element) => {
        const actions = [...element.querySelectorAll("button")];
        const boxes = actions.map((action) => action.getBoundingClientRect());
        return actions.length === 5 && element.scrollWidth === element.clientWidth &&
          boxes.every(({ top, width, height }) => top === boxes[0].top && width === 32 && height === 32) &&
          actions.every((action) => action.getAttribute("aria-label") && action.textContent === "");
      }));
      const up = button(picker, localized.up);
      const down = button(picker, localized.down);
      assert.ok(await up.isDisabled());
      assert.ok(await down.isEnabled());
      await list.press("End");
      assert.ok(await down.isDisabled());
      assert.equal(await down.getAttribute("data-tooltip"), localized.down);
      await list.press("Control+ArrowUp");
      assert.match(await list.getByRole("option", { selected: true }).innerText(), /^Downloads folder/);
      await list.press("Tab");
      const add = strip.getByRole("button").first();
      assert.ok(await add.evaluate((element) => document.activeElement === element && getComputedStyle(element).outlineWidth === "2px"));
      await up.press("Control+Shift+ArrowUp");
      assert.match(await list.getByRole("option").first().innerText(), /^Downloads folder/);
      assert.equal(await up.isDisabled(), true);
      assert.match(await up.getAttribute("data-tooltip"), /↑/);
    }
    console.log(`Verified workspace sources and numbered bookmarks with ${client} bindings.`);
    console.log(`Verified one-row bookmark controls, localized labels, focus and remapped shortcuts with ${client} settings.`);
    await page.close();
  }
} finally {
  await browser.close();
}
