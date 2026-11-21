import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

export async function testFolderMeasurement() {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    for (const [layout, userAgent] of [
      ["standard", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"],
      ["twin", "Mozilla/5.0 (X11; Linux x86_64)"],
      ["classic", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"],
    ]) {
      const page = await browser.newPage({ viewport: { width: 1080, height: 550 }, userAgent });
      page.setDefaultTimeout(8000);
      await page.route("http://dirlume.test/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
      });
      await page.addInitScript((layout) => {
        const measuredField = layout === "twin" ? "bytes" : "size";
        const preferences = { layout };
        if (layout === "twin") preferences.panelModes = {
          full: {
            list: [{ field: "name", width: "0" }, { field: measuredField, width: "0" }, { field: "date", width: "0" }],
            status: [{ field: "rightName", width: "0" }],
          },
        };
        localStorage.setItem("dirlume.preferences.v1", JSON.stringify(preferences));
        const home = /Windows/.test(navigator.userAgent) ? "C:\\fixture" : "/fixture";
        const downloads = home + (/Windows/.test(navigator.userAgent) ? "\\downloads" : "/downloads");
        const entries = [{ name: "Measured folder", directory: true }, { name: "Second folder", directory: true },
          { name: "Neighbor.txt", directory: false }]
          .map((entry) => ({ ...entry, hidden: false, link: false, size: null, modified: 1795251600 }));
        window.isTauri = true;
        window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
        window.__TAURI_INTERNALS__ = {
          metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
          transformCallback: () => 1,
          invoke: async (command, args) => {
            if (command === "locations") return [{ label: "Home", path: home }, { label: "Downloads", path: downloads }];
            if (command === "list_directory") return { path: args.path, parent: null,
              entries: args.path === home ? entries : entries.map((entry) => ({ ...entry, modified: null })), omitted: 0 };
            if (command === "file_icons") return args.items.map(() => null);
            if (command === "format_timestamps") {
              if (args.style === "date") {
                await new Promise((done) => { window.completeFolderDate = done; });
                return args.timestamps.map(() => "21.11.2026");
              }
              return args.timestamps.map(() => "13:40");
            }
            if (command === "measure_folders") {
              return new Promise((done) => {
                window.completeFolderMeasurement = () => {
                  for (const name of args.names) {
                    const large = name === "Measured folder";
                    args.output.onmessage({ name, bytes: large ? Math.round(14.1 * 1024 ** 3) : 1024, incomplete: large });
                  }
                  window.completeFolderMeasurement = undefined;
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
      const second = pane.getByRole("option", { name: /^Second folder/ });
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
      const date = neighbor.locator(".file-date");
      const beforeDate = await date.textContent();
      const rightWidth = await page.locator("#right-pane .file-column.col-size").evaluate((item) => item.getBoundingClientRect().width);
      await pane.getByRole("listbox").press("F3");
      await reading.waitFor();
      await pane.getByRole("button", { name: "Cancel folder size calculation" }).waitFor();
      assert.deepEqual(await positions(), before, `The ${layout} pane moved while measuring.`);
      await page.evaluate(() => window.completeFolderMeasurement());
      const measured = layout === "twin" ? `≥ ${Math.round(14.1 * 1024 ** 3).toLocaleString("en-US")}` : "≥ 14.1 GiB";
      await folder.getByText(measured, { exact: true }).waitFor();
      await reading.waitFor({ state: "hidden" });
      assert.deepEqual(await positions(), before, `The ${layout} pane moved when the result appeared.`);
      await page.waitForFunction(() => typeof window.completeFolderDate === "function");
      await page.evaluate(() => window.completeFolderDate());
      await date.filter({ hasText: "21.11.2026" }).waitFor();
      assert.notEqual(beforeDate, await date.textContent());
      await second.click();
      await pane.getByRole("listbox").press("F3");
      await page.waitForFunction(() => typeof window.completeFolderMeasurement === "function");
      await page.evaluate(() => window.completeFolderMeasurement());
      await second.getByText(layout === "twin" ? "1,024" : "1 KiB", { exact: true }).waitFor();

      const size = folder.locator(".file-size");
      const checkFits = async () => {
        for (const [cell, heading] of [[size, ".col-size"], [date, ".col-modified"]]) {
          await cell.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          assert.ok(await cell.evaluate((item) => item.scrollWidth <= item.clientWidth), `A ${layout} cell is clipped.`);
          assert.ok(Math.abs((await pane.locator(heading).boundingBox()).width - (await cell.boundingBox()).width) <= 1);
        }
      };
      await checkFits();
      const beforeZoom = await size.evaluate((item) => parseFloat(getComputedStyle(item).fontSize));
      await size.hover();
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -100);
      await page.keyboard.up("Control");
      await page.waitForFunction((before) => parseFloat(getComputedStyle(document.querySelector("#left-files .file-size")).fontSize) > before, beforeZoom);
      await checkFits();
      assert.equal(await page.locator("#right-pane .file-column.col-size").evaluate((item) => item.getBoundingClientRect().width), rightWidth);
      await page.close();
    }
    console.log("Verified stable folder measurement, automatic grouped sizes and native dates, and independent pane widths.");
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testFolderMeasurement();
