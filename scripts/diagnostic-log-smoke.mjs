import assert from "node:assert/strict";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright-core";

const base = Date.UTC(2090, 10, 21, 19, 11, 43);
const actions = Array.from({ length: 32 }, (_, index) => ({
  timestampMs: base - (32 - index) * 900,
  operation: index < 30 ? "list_ftp" : "read_text",
}));
const sample = [
  JSON.stringify({ timestampMs: base - 86400900, operation: "check_for_update", code: "native_error", recentActions: [] }),
  JSON.stringify({ timestampMs: base - 900, operation: "native_runtime", code: "panic", recentActions: [],
    panic: { source: { path: "src-tauri/src/diagnostics.rs", line: 108 }, outcome: "unknown" } }),
  '{"timestampMs":',
  JSON.stringify({ timestampMs: base + 791, operation: "javascript", code: "javascript_error", recentActions: actions.slice(0, 3) }),
  JSON.stringify({ timestampMs: base + 627, operation: "read_text", code: "os_error", osCode: 32, recentActions: actions,
    fileRead: { surface: "viewer", reason: "sharing_violation" } }),
];

export async function appendDiagnosticFixture(file) {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, "\n" + sample.join("\n") + "\n");
}

export async function checkDiagnosticLog(viewer, file) {
  const original = await readFile(file, "utf8");
  const entries = viewer.getByRole("region", { name: "Diagnostic entries", exact: true });
  const summaries = entries.locator(".diagnostic-entry > summary");
  await summaries.first().waitFor();
  const dates = await summaries.locator("time").evaluateAll((elements) => elements.slice(0, 4).map((item) => item.dateTime));
  assert.deepEqual(dates, [base + 791, base + 627, base - 900, base - 86400900].map((ms) => new Date(ms).toISOString()));
  assert.match(await summaries.nth(0).textContent(), /43[.,]791/);
  assert.match(await summaries.nth(1).textContent(), /43[.,]627/);
  assert.match(await summaries.nth(1).textContent(), /read_text.*os_error.*OS 32/);
  assert.match(await summaries.nth(3).textContent(), /check_for_update.*native_error/);
  assert.equal(await summaries.nth(2).locator("[data-panic] > svg").count(), 1);
  assert.equal(await entries.getByText("Recent actions", { exact: true }).count(), 0);

  const read = summaries.nth(1);
  await read.focus();
  await read.press("Space");
  const openRow = entries.locator("details[open]");
  await openRow.getByText("Recent actions", { exact: true }).waitFor();
  assert.equal(await read.evaluate((element) => getComputedStyle(element).outlineWidth), "2px");
  await openRow.getByText(/sharing_violation/).waitFor();
  assert.equal(await openRow.getByRole("listitem").count(), 32);
  assert.deepEqual(await openRow.locator("li time").evaluateAll((elements) => elements.map((item) => item.dateTime)),
    actions.map(({ timestampMs }) => new Date(timestampMs).toISOString()));
  await read.press("Enter");
  await openRow.waitFor({ state: "hidden" });

  await summaries.nth(2).click();
  await openRow.getByText("No recent actions were recorded.").waitFor();
  await summaries.nth(2).click();
  await summaries.filter({ hasText: "Malformed entry" }).last().click();
  await openRow.getByText(sample[2], { exact: true }).waitFor();

  await viewer.getByRole("button", { name: "Source", exact: true }).click();
  const source = viewer.locator(".cm-scroller");
  await source.waitFor();
  // CodeMirror renders only nearby lines, and a single wrapped entry can fill the viewport.
  const scroller = await source.elementHandle();
  await viewer.page().waitForFunction(({ scroller, lastEntry }) => {
    if (Array.from(scroller.querySelectorAll(".cm-line")).some((line) => line.textContent === lastEntry)) return true;
    scroller.scrollTop = scroller.scrollHeight;
    return false;
  }, { scroller, lastEntry: sample.at(-1) });
  await scroller.dispose();
  const sourceLines = await source.evaluate(async (scroller, expected) => {
    const found = new Set();
    for (let step = 0; step < 30; step++) {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const lines = [...scroller.querySelectorAll(".cm-line")].reverse();
      for (const line of lines) {
        if (expected.includes(line.textContent)) found.add(line.textContent);
      }
      if (found.size === expected.length || scroller.scrollTop === 0) break;
      scroller.scrollTop -= Math.max(1, Math.floor(scroller.clientHeight / 2));
    }
    return [...found].reverse();
  }, sample);
  assert.deepEqual(sourceLines, sample);
  await viewer.getByRole("button", { name: "Entries", exact: true }).click();
  await entries.waitFor();
  assert.ok((await readFile(file, "utf8")).startsWith(original));
  console.log("Verified diagnostic log order, timestamps, disclosure, malformed lines, and original Source in Windows WebView2.");
}

async function testClearFromViewer() {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    for (const platform of ["Windows NT 10.0; Win64; x64", "X11; Linux x86_64", "Macintosh; Intel Mac OS X 10_15_7"]) {
      const page = await browser.newPage({ userAgent: `Mozilla/5.0 (${platform})`, viewport: { width: 1080, height: 700 } });
      page.setDefaultTimeout(8000);
      await page.route("http://dirlume.test/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
      });
      await page.addInitScript((initial) => {
        const windows = navigator.userAgent.includes("Windows");
        const home = windows ? "C:\\fixture" : "/fixture";
        const state = window.errorLogFixture = { source: initial, clears: 0, reject: false, reads: [] };
        localStorage.setItem("dirlume.preferences.v1", JSON.stringify({ showMainMenu: true }));
        window.__TAURI_INTERNALS__ = {
          transformCallback: () => 1,
          invoke: async (command, args) => {
            if (command === "locations") return [{ label: "Home", path: home }];
            if (command === "list_directory") return { path: home, parent: null, omitted: 0, entries: [{
              name: "ordinary.jsonl", directory: false, hidden: false, link: false, size: 17, modified: null,
            }] };
            if (command === "file_icons") return args.items.map(() => null);
            if (command === "error_log") return home + (windows ? "\\" : "/") + "diagnostics.jsonl";
            if (command === "read_text") return { text: args.name === "diagnostics.jsonl" ? state.source : '{"record":"ordinary"}', encoding: "utf8" };
            if (command === "watch_directory" && args.name === "diagnostics.jsonl") { state.watcher = args.changes; return null; }
            if (command === "read_bytes") {
              const bytes = Array.from(new TextEncoder().encode(state.source));
              state.reads.push(bytes.length);
              return { data: bytes, length: bytes.length };
            }
            if (command === "clear_error_log") {
              state.clears++;
              if (state.reject) throw new Error("Fixture could not clear the error log.");
              state.source = "";
            }
            return null;
          },
        };
      }, sample[0] + "\n");
      await page.goto("http://dirlume.test/");
      const button = (scope, name) => scope.getByRole("button", { name, exact: true });
      const item = (scope, name) => scope.getByRole("menuitem", { name, exact: true });
      const main = page.getByRole("menubar", { name: "Main menu", exact: true });
      await item(main, "Help").click();
      assert.equal(await item(main, "Clear error log").count(), 0);
      await item(main, "Open error log").click();
      const viewer = page.getByRole("region", { name: "diagnostics.jsonl", exact: true });
      const entry = viewer.locator(".diagnostic-entry").first();
      await entry.waitFor();
      const menu = viewer.getByRole("menubar", { name: "Document menu", exact: true });
      const dialog = page.getByRole("dialog", { name: "Clear error log", exact: true });
      const cancel = button(dialog, "Cancel");
      const clear = button(dialog, "Clear error log");
      const openClear = async (keyboard = false) => {
        if (keyboard) {
          await item(menu, "File").press("ArrowDown");
          await item(menu, "Clear error log").press("Enter");
        } else {
          await item(menu, "File").click();
          await item(menu, "Clear error log").click();
        }
        await dialog.waitFor();
        await page.waitForFunction(() => document.activeElement?.textContent === "Cancel");
      };
      await openClear(true);
      await cancel.click();
      await entry.waitFor();
      assert.equal(await page.evaluate(() => window.errorLogFixture.clears), 0);

      await page.evaluate(() => { window.errorLogFixture.reject = true; });
      await button(viewer, "Hex").click();
      await page.waitForFunction(() => window.errorLogFixture.reads.some((length) => length > 0));
      await openClear();
      await clear.click();
      await dialog.getByRole("alert").filter({ hasText: "Fixture could not clear the error log." }).waitFor();
      assert.equal(await page.evaluate(() => window.errorLogFixture.source), sample[0] + "\n");
      await page.evaluate(() => { window.errorLogFixture.reject = false; });
      await clear.click();
      await dialog.waitFor({ state: "hidden" });
      await viewer.getByText("No errors have been logged yet.", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.errorLogFixture.source), "");
      await button(viewer, "Source").click();
      await viewer.locator(".cm-content").waitFor();
      assert.equal(await viewer.locator(".cm-content").textContent(), "");
      await button(viewer, "Hex").click();
      await page.waitForFunction(() => window.errorLogFixture.reads.at(-1) === 0);
      await button(viewer, "Hex").click();
      await button(viewer, "Entries").click();
      await page.evaluate((next) => {
        window.errorLogFixture.source = next;
        window.errorLogFixture.watcher.onmessage(null);
      }, sample[1]);
      await viewer.getByText("native_runtime", { exact: true }).waitFor();
      await button(viewer, "Close document").click();

      const ordinary = page.locator('#left-files [data-tooltip="ordinary.jsonl"]');
      await ordinary.click();
      await page.locator("#left-files").press("F3");
      const file = page.getByRole("region", { name: "ordinary.jsonl", exact: true });
      await item(file.getByRole("menubar", { name: "Document menu", exact: true }), "File").click();
      assert.equal(await item(file, "Clear error log").count(), 0);
      await page.close();
    }
    console.log("Verified diagnostic-only clearing, keyboard confirmation, cancel, failure and retry, and fresh Entries, Source, and Hex on all desktop platform settings.");
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testClearFromViewer();
