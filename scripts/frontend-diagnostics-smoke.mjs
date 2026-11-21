import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { SourceMap } from "node:module";
import { join, relative, resolve } from "node:path";
import { chromium } from "playwright-core";
import { build } from "vite";
import { fixture } from "./server-smoke.mjs";

const root = await fixture("frontend-diagnostics-");
const entry = `import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { installDiagnosticListeners, reportReactError } from "../../src/diagnostics.ts";

installDiagnosticListeners();
function firstSite() {
  const failure = new TypeError("private-window-message C:/Users/fixture/document.txt");
  window.propagatedFailure = failure;
  throw failure;
}
function secondSite() {
  return Promise.reject(new TypeError("private-rejection-message document content"));
}
function BrokenView() {
  throw new TypeError("private-react-message");
}
const root = createRoot(document.querySelector("#root"), { onUncaughtError: reportReactError });
window.runFixture = {
  window: () => queueMicrotask(firstSite),
  rejection: () => { void secondSite(); },
  react: () => root.render(createElement(BrokenView)),
  propagated: () => { void Promise.reject(window.propagatedFailure); },
  external: () => window.dispatchEvent(new ErrorEvent("error", {
    filename: "https://private-host/assets/index-12345678.js?token=private-query", lineno: 1, colno: 1,
  })),
  nonError: () => { void Promise.reject("private-non-error-message"); },
};
`;
let browser;
try {
  await writeFile(join(root, "index.html"), '<div id="root"></div><script type="module" src="/fixture.ts"></script>');
  await writeFile(join(root, "fixture.ts"), entry);
  await build({ root, configFile: false, logLevel: "error", build: { sourcemap: "hidden" } });
  browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  await page.addInitScript(() => {
    window.isTauri = true;
    window.records = [];
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        if (command === "report_diagnostic") window.records.push(args);
      },
    };
  });
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: join(root, "dist", path === "/" ? "index.html" : path) });
  });
  await page.goto("http://dirlume.test/");
  await page.waitForFunction(() => window.runFixture);
  for (const [index, name] of ["window", "rejection", "react"].entries()) {
    await page.evaluate((name) => { window.runFixture[name](); }, name);
    await page.waitForFunction((count) => window.records.length >= count, index + 1);
  }
  await page.evaluate(() => {
    window.runFixture.propagated();
    window.runFixture.external();
    window.runFixture.nonError();
  });
  await page.waitForFunction(() => window.records.some(({ code }) => code === "unhandled_rejection"));
  const records = await page.evaluate(() => window.records);
  assert.equal(records.length, 5, "A propagated Error produces one record.");
  assert.deepEqual(records.map(({ frontend }) => frontend.origin), [
    "window_error", "unhandled_rejection", "react", "window_error", "unhandled_rejection",
  ]);
  for (const [index, marker] of ["private-window-message", "private-rejection-message", "private-react-message"].entries()) {
    const { code, frontend: { source } } = records[index];
    assert.equal(code, "type_error");
    assert.match(source.asset, /^index-[\w-]{8}\.js$/);
    const map = new SourceMap(JSON.parse(await readFile(join(root, "dist", "assets", `${source.asset}.map`), "utf8")));
    const original = map.findOrigin(source.line, source.column);
    assert.match(original.fileName, /fixture\.ts$/);
    assert.equal(original.lineNumber, entry.split("\n").findIndex((line) => line.includes(marker)) + 1);
  }
  assert.ok(records.slice(3).every(({ frontend }) => frontend.source === null));
  assert.doesNotMatch(JSON.stringify(records), /private-|https?:|[\\/]|document content/);
  console.log("Packaged JavaScript origins, source maps, and diagnostic privacy verified.");
} finally {
  await browser?.close();
  if (/^frontend-diagnostics-[\w-]+$/.test(relative(resolve(".smoke"), root))) {
    await rm(root, { recursive: true, force: true });
  }
}
