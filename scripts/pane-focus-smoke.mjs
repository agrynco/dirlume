import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { openMainMenu } from "./menu-header-smoke.mjs";

const sides = ["left", "right"];
const systemDate = "Thursday, 19 November 2026";
const changedDate = "19.11.2026";
const row = (page, side, name) => page.locator(`#${side}-files [data-tooltip="${name}"]`);

const snapshot = (page, side) => page.locator(`#${side}-pane`).evaluate((pane) => {
  const list = pane.querySelector(".file-list");
  const bounds = (node) => {
    const { x, y, width, height } = node.getBoundingClientRect();
    return { x, y, width, height };
  };
  return {
    columns: [...pane.querySelectorAll(".file-column")].map(bounds),
    list: bounds(list),
    scroll: list.scrollTop,
    current: list.querySelector('[data-current="true"]')?.dataset.tooltip,
    marks: [...list.querySelectorAll('[aria-selected="true"]')].map((node) => node.dataset.tooltip),
    date: list.querySelector(".file-date")?.textContent,
    time: list.querySelector(".file-time")?.textContent,
  };
});

const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const platform of ["Windows NT 10.0; Win64; x64", "X11; Linux x86_64", "Macintosh; Intel Mac OS X 10_15_7"]) {
    const page = await browser.newPage({ userAgent: `Mozilla/5.0 (${platform})`, viewport: { width: 1120, height: 610 }, locale: "en-US" });
    page.setDefaultTimeout(8000);
    await page.route("http://dirlume.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    await page.addInitScript(({ sides, systemDate }) => {
      const directory = (side) => /Windows/.test(navigator.userAgent) ? `C:\\fixture\\${side}` : `/fixture/${side}`;
      const panels = Object.fromEntries(sides.map((side) => [side, { place: { kind: "local", path: directory(side) } }]));
      localStorage.setItem("dirlume.workspace.v1", JSON.stringify({ panels, active: "left", split: 50, documents: [] }));
      localStorage.setItem("dirlume.preferences.v1", JSON.stringify({
        panelModes: { wide: { status: [{ field: "rightName", width: "0" }] } },
      }));
      const fixture = window.focusFixture = {
        pending: [], hold: false, date: systemDate, watches: {}, lists: { left: 0, right: 0 }, extra: {},
      };
      const file = (name) => ({ name, directory: false, hidden: false, link: false, size: 1234, modified: 1795105140 });
      const entries = Array.from({ length: 90 }, (_, index) => file(`file-${String(index).padStart(3, "0")}.txt`));
      window.isTauri = true;
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => 1,
        invoke: async (command, args) => {
          if (command === "locations") return [{ label: "Home", path: directory("left") }];
          if (command === "list_directory") {
            const side = sides.find((item) => directory(item) === args.path);
            if (!side) throw new Error(`Unexpected directory: ${args.path}`);
            fixture.lists[side]++;
            const extra = fixture.extra[side];
            return { path: args.path, parent: null, entries: extra ? [...entries, file(extra)] : entries, omitted: 0 };
          }
          if (command === "watch_directory") {
            const side = sides.find((item) => directory(item) === args.path);
            fixture.watches[side] = args.changes;
          }
          if (command === "format_timestamps") {
            if (fixture.hold) await new Promise((done) => fixture.pending.push(done));
            return args.timestamps.map(() => args.style === "date" ? fixture.date : "16:19");
          }
          if (command === "file_icons") return args.items.map(() => null);
          return null;
        },
      };
    }, { sides, systemDate });
    await page.goto("http://dirlume.test/");
    const waitDates = (text) => Promise.all(sides.map((side) =>
      page.locator(`#${side}-files .file-date`).filter({ hasText: text }).first().waitFor()));
    await waitDates(systemDate);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    for (const side of sides) {
      const list = page.locator(`#${side}-files`);
      await list.focus();
      await page.locator(`#${side}-pane.active`).waitFor();
      await list.evaluate((node) => { node.scrollTop = 840; });
      const selected = row(page, side, "file-045.txt");
      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await selected.click({ modifiers: [modifier] });
      await page.waitForFunction((side) =>
        document.querySelector(`#${side}-files [data-tooltip="file-045.txt"]`)?.getAttribute("aria-selected") === "true", side);
    }
    const both = () => Promise.all(sides.map((side) => snapshot(page, side)));
    const before = await both();
    const dateWidths = await page.locator(".file-column.col-date").evaluateAll((columns) =>
      columns.map((column) => column.getBoundingClientRect().width));
    for (const { date, scroll, current, marks } of before) {
      assert.equal(date, systemDate);
      assert.ok(scroll > 0);
      assert.equal(current, "file-045.txt");
      assert.deepEqual(marks, ["file-045.txt"]);
    }
    const focus = async () => {
      await page.evaluate(() => {
        window.focusFixture.hold = true;
        window.dispatchEvent(new Event("blur"));
        window.dispatchEvent(new Event("focus"));
      });
      await page.waitForFunction(() => window.focusFixture.pending.length >= 4);
    };
    const release = (date) => page.evaluate((date) => {
      const fixture = window.focusFixture;
      fixture.date = date;
      fixture.hold = false;
      for (const done of fixture.pending.splice(0)) done();
    }, date);
    const counts = () => page.evaluate(() => window.focusFixture.lists);
    const initialCounts = await counts();
    for (const date of [systemDate, systemDate, changedDate]) {
      await focus();
      assert.deepEqual(await both(), before, `Focus changed the file panes before timestamp formatting finished on ${platform}.`);
      if (date === changedDate) {
        const target = row(page, "right", "file-048.txt");
        await target.click();
        assert.equal(await target.getAttribute("data-current"), "true");
      }
      await release(date);
      await waitDates(date);
      if (date === systemDate) assert.deepEqual(await both(), before);
      assert.deepEqual(await counts(), initialCounts);
    }
    await page.waitForFunction((widths) =>
      [...document.querySelectorAll(".file-column.col-date")].every((column, index) =>
        column.getBoundingClientRect().width < widths[index]), dateWidths);
    const rightBefore = await snapshot(page, "right");
    await page.evaluate(() => {
      const fixture = window.focusFixture;
      window.dispatchEvent(new Event("blur"));
      fixture.extra.left = "file-044-added.txt";
      fixture.watches.left.onmessage(null);
    });
    await row(page, "left", "file-044-added.txt").waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    assert.deepEqual(await snapshot(page, "right"), rightBefore);
    assert.deepEqual(await counts(), { left: initialCounts.left + 1, right: initialCounts.right });
    await page.evaluate(() => { window.focusFixture.extra.left = "file-044-renamed.txt"; });
    await page.locator("#left-pane").getByRole("button", { name: "Refresh folder", exact: true }).click();
    await row(page, "left", "file-044-renamed.txt").waitFor();
    assert.deepEqual(await snapshot(page, "right"), rightBefore);

    for (const [side, label] of [["left", "Left"], ["right", "Right"]]) {
      const menu = await openMainMenu(page, label);
      await menu.getByRole("menuitemradio", { name: "Wide", exact: true }).click();
      assert.equal(await page.locator(`#${side}-pane .file-date, #${side}-pane .file-time`).count(), 0);
    }
    const wide = await both();
    await page.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
      return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    });
    assert.deepEqual(await both(), wide);
    await page.close();
  }
  console.log("Verified steady columns, scroll, selection, and marks on focus, updated system date formats, and independent watched and manual refreshes.");
} finally {
  await browser.close();
}
