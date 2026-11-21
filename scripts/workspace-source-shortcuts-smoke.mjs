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
            case "list_space_directory": return listing;
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
      await button(sources(side), view === "Processes" ? "Processes" : "FTP").click();
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
          await page.waitForFunction((popup) => popup.contains(document.activeElement), await sources(target).elementHandle());
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
    console.log(`Verified workspace sources and numbered bookmarks with ${client} bindings.`);
    await page.close();
  }
} finally {
  await browser.close();
}
