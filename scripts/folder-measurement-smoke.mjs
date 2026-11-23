import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

export async function testFolderMeasurement() {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    for (const [layout, userAgent, width = "0"] of [
      ["standard", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"],
      ["twin", "Mozilla/5.0 (X11; Linux x86_64)"],
      ["classic", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"],
      ["standard", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "6"],
      ["twin", "Mozilla/5.0 (X11; Linux x86_64)", "5%"],
    ]) {
      const page = await browser.newPage({ viewport: { width: 1080, height: 550 }, userAgent });
      page.setDefaultTimeout(8000);
      await page.route("http://dirlume.test/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
      });
      await page.addInitScript(({ layout, width }) => {
        const measuredField = layout === "twin" ? "bytes" : "size";
        const preferences = { layout };
        if (layout === "twin" || width !== "0") preferences.panelModes = {
          full: {
            list: [{ field: "name", width: "0" }, { field: measuredField, width }, { field: "date", width: "0" }],
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
                const remaining = [...args.names];
                window.completeFolderMeasurement = (only) => {
                  for (const name of only ? [only] : [...remaining]) {
                    const index = remaining.indexOf(name);
                    if (index < 0) continue;
                    remaining.splice(index, 1);
                    const large = name === "Measured folder";
                    const gibibytes = width === "6" ? 17.6 : 14.1;
                    args.output.onmessage({ name, bytes: large ? Math.round(gibibytes * 1024 ** 3) : 1024, incomplete: large && width !== "6" });
                  }
                  if (!remaining.length) {
                    window.completeFolderMeasurement = undefined;
                    done();
                  }
                };
                window.lateFolderMeasurement = () => args.output.onmessage({ name: "Second folder", bytes: 99123, incomplete: false });
              });
            }
            if (command === "cancel_measurement") { window.completeFolderMeasurement(); return null; }
            if (command === "scan_local_space") {
              args.output.onmessage({ kind: "start", strategy: "walk" });
              const size = Math.round(14.1 * 1024 ** 3);
              args.output.onmessage({ kind: "batch", changes: [
                { parent: 0, name: "fixture.bin", directory: false, size, allocated: size, shared: false },
                { closed: 0, partial: true, error: null },
              ] });
              args.output.onmessage({ kind: "finished" });
            }
            return null;
          },
        };
      }, { layout, width });
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
      const size = folder.locator(".file-size");
      const sizeBefore = (await size.boundingBox()).width;
      const date = neighbor.locator(".file-date");
      const beforeDate = await date.textContent();
      const rightWidth = await page.locator("#right-pane .file-column.col-size").evaluate((item) => item.getBoundingClientRect().width);
      await pane.getByRole("listbox").press("F3");
      await reading.waitFor();
      await pane.getByRole("button", { name: "Cancel folder size calculation" }).waitFor();
      assert.deepEqual(await positions(), before, `The ${layout} pane moved while measuring.`);
      assert.equal((await size.boundingBox()).width, sizeBefore, "Size changed before F3 returned a result.");
      await page.evaluate(() => window.completeFolderMeasurement());
      const measured = layout === "twin" ? `≥ ${Math.round(14.1 * 1024 ** 3).toLocaleString("en-US")}` :
        width === "6" ? "17.6 GiB" : "≥ 14.1 GiB";
      await folder.getByText(measured, { exact: true }).waitFor();
      await size.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.ok(await size.evaluate((item) => item.scrollWidth <= item.clientWidth), `The F3 result is clipped with width ${width}.`);
      if (width !== "0") assert.ok((await size.boundingBox()).width > sizeBefore, "F3 did not expand the saved Size width.");
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

      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await folder.click({ modifiers: [modifier] });
      await second.click({ modifiers: [modifier] });
      await pane.getByRole("listbox").press("F3");
      await reading.waitFor();
      await page.evaluate(() => window.completeFolderMeasurement("Measured folder"));
      await folder.getByText(measured, { exact: true }).waitFor();
      await second.locator('[aria-label="Measuring folder"]').waitFor();
      await pane.getByRole("listbox").press("Escape");
      await reading.waitFor({ state: "hidden" });
      await page.evaluate(() => window.lateFolderMeasurement());
      await second.getByText(layout === "twin" ? "1,024" : "1 KiB", { exact: true }).waitFor();
      assert.equal(await folder.getByText(measured, { exact: true }).count(), 1);

      await folder.dblclick();
      await page.waitForFunction(() => document.querySelector("#left-path")?.dataset.path.endsWith("Measured folder") &&
        document.querySelector("#left-files")?.getAttribute("aria-busy") === "false");
      await pane.getByRole("button", { name: "Analyze space", exact: true }).click();
      const analyzer = page.getByRole("region", { name: "Space Analyzer", exact: true });
      await analyzer.getByRole("combobox", { name: "Size metric" }).selectOption("logical");
      await analyzer.locator(".space-tree-row").filter({ has: page.getByText("Measured folder", { exact: true }) })
        .getByText("14.1 GiB", { exact: true }).waitFor();
      await analyzer.getByRole("status").getByText("Partial results", { exact: true }).waitFor();
      await page.close();
    }
    console.log("Verified stable folder measurement, post-F3 resizing for saved widths, native dates, and independent pane widths.");
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testFolderMeasurement();
