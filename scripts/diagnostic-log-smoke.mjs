import assert from "node:assert/strict";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

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
