import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const [platform, language] of [["Windows NT 10.0; Win64; x64", "en"], ["X11; Linux x86_64", "uk"]]) {
    const page = await browser.newPage({
      viewport: { width: 1940, height: 640 }, userAgent: `Mozilla/5.0 (${platform})`,
    });
    page.setDefaultTimeout(8000);
    await page.route("http://dirlume.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    await page.addInitScript(({ language }) => {
      const columns = (...items) => items.map(([field, width]) => ({ field, width }));
      const params = new URL(location.href).searchParams;
      const advanced = params.has("advanced");
      const customWidth = params.get("width");
      localStorage.setItem("dirlume.preferences.v1", JSON.stringify({
        language,
        selectedPanelModes: { left: "full", right: "wide" },
        panelModes: {
          wide: { list: columns(["name", "0"], ["size", "6"]) },
          full: advanced ? {
            list: columns(["markedName", "0"], ["size", "0"], ["bytes", "0"], ["date", "0"], ["time", "0"], ["owner", "0"], ["links", "0"]),
          } : {
            columnSizingVersion: customWidth ? 1 : undefined,
            list: columns(["name", "0"], ["size", customWidth ?? "0"], ["date", "0"], ["time", "5"]),
          },
        },
      }));
      localStorage.removeItem("dirlume.workspace.v1");
      localStorage.removeItem("dirlume.file-column-layout.left");
      const home = /Windows/.test(navigator.userAgent) ? "C:\\fixture" : "/fixture";
      const entries = Array.from({ length: 160 }, (_, index) => ({
        name: `file-${String(index).padStart(3, "0")}.txt`, directory: false, hidden: false, link: false,
        size: index === 159 ? 1012 * 1024 ** 4 : Math.round(87.9 * 1024),
        modified: 1795251600, hardLinks: 123456789,
      }));
      window.isTauri = true;
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => 1,
        invoke: async (command, args) => {
          if (command === "locations") return [{ label: "Home", path: home }];
          if (command === "list_directory") return { path: args.path, parent: null, entries, omitted: 0 };
          if (command === "file_icons") return args.items.map(() => null);
          if (command === "format_timestamps") return args.timestamps.map(() =>
            args.style === "date" ? "21.11.2026" : "11:29:56 PM");
          if (command === "panel_metadata") {
            if (!window.showOwner) await new Promise((done) => { window.completeOwner = done; });
            return args.items.map(() => ({ owner: "File system administrators", hardLinks: 123456789 }));
          }
          return null;
        },
      };
    }, { language });
    const left = page.locator("#left-pane");
    const right = page.locator("#right-pane");
    const row = (pane, index = 0) => pane.locator(`.file-row[data-tooltip="file-${String(index).padStart(3, "0")}.txt"]`);
    const size = (pane, index) => row(pane, index).locator(".file-size").first();
    const width = (locator) => locator.evaluate((element) => element.getBoundingClientRect().width);
    const assertFits = async (locator) => {
      const element = await locator.elementHandle();
      try {
        await page.waitForFunction((node) => node.scrollWidth <= node.clientWidth, element);
      } catch (error) {
        const diagnostics = await element.evaluate((node) => ({
          text: node.textContent, width: node.clientWidth, contentWidth: node.scrollWidth,
          tracks: getComputedStyle(node.closest(".file-list-grid")).gridTemplateColumns,
          font: getComputedStyle(node).font, measuredOwner: node.closest(".pane").style.getPropertyValue("--file-owner-width"),
        }));
        throw new Error(`Clipped file pane value: ${JSON.stringify(diagnostics)}`, { cause: error });
      }
    };

    await page.goto("http://dirlume.test/");
    await size(left).waitFor();
    await row(left).locator(".file-time", { hasText: "11:29:56 PM" }).waitFor();
    await assertFits(row(left).locator(".file-time"));
    await assertFits(size(left));
    await assertFits(size(right));
    const beforeScroll = await width(size(left));
    assert.equal(await row(left, 159).count(), 0, "The longest size should start outside the viewport.");
    await left.locator("#left-files").press("End");
    await assertFits(size(left, 159));
    assert.equal(await width(size(left, 159)), beforeScroll, "Scrolling to a longer size changed the column width.");
    const rightBefore = await width(size(right));

    await left.locator(".file-columns").click({ button: "right" });
    const menu = page.getByRole("menu");
    await menu.getByRole("menuitemcheckbox", { name: language === "uk" ? "Дата" : "Date", exact: true }).click();
    await left.locator(".file-columns").click({ button: "right" });
    await menu.getByRole("menuitemcheckbox", { name: language === "uk" ? "Час" : "Time", exact: true }).click();
    await left.getByRole("button", { name: language === "uk" ? "Дерево" : "Tree", exact: true }).click();
    await left.locator("#left-files").press("Home");
    await assertFits(size(left));
    const before = await width(size(left));
    await size(left).hover();
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -100);
    await page.keyboard.up("Control");
    await page.waitForFunction(({ element, before }) => element.getBoundingClientRect().width > before,
      { element: await size(left).elementHandle(), before });
    await assertFits(size(left));
    assert.equal(await width(size(right)), rightBefore);
    assert.ok(Math.abs(await width(left.locator(".col-size")) - await width(size(left))) <= 1);

    for (const widthSetting of ["2", "3%"]) {
      await page.goto(`http://dirlume.test/?width=${encodeURIComponent(widthSetting)}`);
      await size(left).waitFor();
      await assertFits(size(left));
      const beforeNarrow = await width(size(left));
      await page.setViewportSize({ width: 520, height: 640 });
      await left.locator("#left-files").press("End");
      await assertFits(size(left, 159));
      await assertFits(left.locator(".col-size button span"));
      assert.ok(await width(size(left, 159)) <= beforeNarrow + 1);
      assert.ok(Math.abs(await width(left.locator(".col-size")) - await width(size(left, 159))) <= 1);
      await page.setViewportSize({ width: 1940, height: 640 });
    }

    await page.goto("http://dirlume.test/?advanced");
    const owner = row(left).locator(".file-owner");
    await owner.waitFor();
    const ownerBefore = await width(owner);
    await page.waitForFunction(() => window.completeOwner);
    await page.evaluate(() => { window.showOwner = true; window.completeOwner(); });
    await row(left).getByText("File system administrators", { exact: true }).waitFor();
    await assertFits(owner);
    assert.ok(await width(owner) > ownerBefore, "The Owner column did not grow when metadata arrived.");
    for (const field of [".file-name-text", ".file-date", ".file-time", ".file-links", ".file-size:nth-child(3)"]) {
      await assertFits(row(left).locator(field));
    }
    await page.close();
  }
  console.log("Verified automatic widths in List and Tree, legacy defaults, custom widths, later metadata, and pane independence.");
} finally {
  await browser.close();
}
