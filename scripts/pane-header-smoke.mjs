import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

export async function testFolderNavigationHeader() {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    for (const layout of ["standard", "twin", "classic"]) {
      for (const side of ["left", "right"]) {
        const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
        page.setDefaultTimeout(8000);
        await page.route("http://dirlume.test/**", (route) => {
          const path = new URL(route.request().url()).pathname;
          return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
        });
        await page.addInitScript((layout) => {
          localStorage.setItem("dirlume.preferences.v1", JSON.stringify({ layout }));
          const windows = /Windows/i.test(navigator.userAgent);
          const home = windows ? "C:\\fixture" : "/fixture";
          const folder = home + (windows ? "\\" : "/") + "Subfolder";
          const homeEntries = [{ name: "Subfolder", directory: true, hidden: false, link: false, size: null, modified: null }];
          const folderEntries = Array.from({ length: 120 }, (_, index) =>
            ({ name: `file-${index}.txt`, directory: false, hidden: false, link: false, size: index, modified: null }));
          const pendingListing = new Promise((complete) => { window.showFolderContents = complete; });
          const pendingSpace = new Promise((complete) => { window.showFolderSpace = complete; });
          window.__TAURI_INTERNALS__ = {
            transformCallback: () => 1,
            invoke: async (command, args) => {
              if (command === "locations") return [{ label: "Home", path: home }];
              if (command === "list_directory") {
                if (args.path === folder) {
                  await pendingListing;
                  return { path: folder, parent: home, entries: folderEntries, omitted: 0 };
                }
                return { path: home, parent: null, entries: homeEntries, omitted: 0 };
              }
              if (command === "disk_space") {
                if (args.path === folder) await pendingSpace;
                return { available: args.path === folder ? 1024 : 2048, total: 4096 };
              }
              if (command === "file_icons") return args.items.map(() => null);
              return null;
            },
          };
        }, layout);
        await page.goto("http://dirlume.test/");
        const pane = page.locator(`#${side}-pane`);
        const columns = pane.locator(".file-columns");
        const list = pane.locator(".file-list");
        const capacity = (label) => pane.getByRole("button", { name: "Analyze space", exact: true })
          .filter({ has: page.getByText(label, { exact: true }) });
        const bounds = () => columns.evaluate((header) => {
          const { x, y, width, height } = header.getBoundingClientRect();
          return { x, y, width, height, nameEdge: header.querySelector(".col-name").getBoundingClientRect().right };
        });
        await list.locator('[data-tooltip="Subfolder"]').click();
        if (layout === "twin") {
          const control = capacity("2 KiB free of 4 KiB");
          await control.waitFor();
          assert.equal(await control.getAttribute("data-tooltip"), "Open Space Analyzer to scan the current folder.");
        }
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const before = await bounds();
        await list.press("Enter");
        await pane.getByRole("button", { name: "Cancel folder navigation", exact: true }).waitFor();
        assert.deepEqual(await bounds(), before, `The ${layout} ${side} column header moved during navigation.`);

        await page.evaluate(() => window.showFolderContents());
        await list.locator('[data-tooltip="file-0.txt"]').waitFor();
        assert.deepEqual(await bounds(), before, `The ${layout} ${side} column header moved when the list changed.`);
        await page.evaluate(() => window.showFolderSpace());
        if (layout === "twin") await capacity("1 KiB free of 4 KiB").waitFor();
        assert.deepEqual(await bounds(), before, `The ${layout} ${side} column header moved when free space arrived.`);
        await page.close();
      }
    }
    console.log("Verified stable column headings during Enter navigation in both panes and all three layouts.");
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testFolderNavigationHeader();
