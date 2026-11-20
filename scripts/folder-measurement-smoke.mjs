import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

export async function testFolderMeasurement() {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    for (const layout of ["standard", "twin", "classic"]) {
      const page = await browser.newPage({ viewport: { width: 840, height: 550 } });
      page.setDefaultTimeout(8000);
      await page.route("http://dirlume.test/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
      });
      await page.addInitScript((layout) => {
        localStorage.setItem("dirlume.preferences.v1", JSON.stringify({ layout }));
        const home = "/fixture";
        const entries = [{ name: "Measured folder", directory: true }, { name: "Neighbor.txt", directory: false }]
          .map((entry) => ({ ...entry, hidden: false, link: false, size: null, modified: null }));
        window.__TAURI_INTERNALS__ = {
          transformCallback: () => 1,
          invoke: async (command, args) => {
            if (command === "locations") return [{ label: "Home", path: home }];
            if (command === "list_directory") return { path: home, parent: null, entries, omitted: 0 };
            if (command === "file_icons") return args.items.map(() => null);
            if (command === "measure_folders") {
              return new Promise((done) => {
                window.completeFolderMeasurement = () => {
                  args.output.onmessage({ name: args.names[0], bytes: 1024, incomplete: false });
                  done();
                };
              });
            }
            return null;
          },
        };
      }, layout);
      await page.goto("http://dirlume.test/");
      const pane = page.locator("#left-pane");
      assert.equal(await pane.getAttribute("data-layout"), layout);
      const folder = pane.getByRole("option", { name: /^Measured folder/ });
      const neighbor = pane.getByRole("option", { name: /^Neighbor.txt/ });
      const reading = pane.getByRole("status").filter({ hasText: "Calculating folder sizes…" });
      await folder.click();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const positions = () => Promise.all([
        pane.locator(".pane-heading").boundingBox(),
        pane.locator(".file-columns").boundingBox(),
        pane.getByRole("listbox").boundingBox(),
        folder.boundingBox(),
        neighbor.boundingBox(),
      ]);
      const before = await positions();
      await pane.getByRole("listbox").press("F3");
      await reading.waitFor();
      await pane.getByRole("button", { name: "Cancel folder size calculation" }).waitFor();
      assert.deepEqual(await positions(), before, `The ${layout} pane moved while measuring.`);
      await page.evaluate(() => window.completeFolderMeasurement());
      await folder.getByText("1 KiB", { exact: true }).waitFor();
      await reading.waitFor({ state: "hidden" });
      assert.deepEqual(await positions(), before, `The ${layout} pane moved when the result appeared.`);
      await page.close();
    }
    console.log("Verified stable folder measurement in the standard, twin, and classic pane layouts.");
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testFolderMeasurement();
