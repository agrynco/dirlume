import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const bash = 'if nginx -t; then\n    tail -n 100 /var/log/nginx/access.log |\n        grep "GET\n          /health"\nfi';
const powershell = 'Get-ChildItem -Path "C:\\logs" |\n    Select-String -Pattern "GET\n    /health"';
const unknown = 'echo --unknown "one" | second';
const long = "echo " + "unbroken".repeat(40);
const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const [platform, userAgent, theme] of [
    ["Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "light"],
    ["Ubuntu", "Mozilla/5.0 (X11; Linux x86_64)", "dark"],
  ]) {
    const windows = platform === "Windows";
    const page = await browser.newPage({ userAgent, viewport: { width: 1100, height: 680 } });
    try {
      page.setDefaultTimeout(8000);
      await page.route("http://dirlume.test/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
      });
      await page.addInitScript(({ windows, theme, bash, powershell, unknown, long }) => {
        const folder = windows ? "C:\\fixture" : "/fixture";
        const date = Date.now();
        localStorage.setItem("dirlume.preferences.v1", JSON.stringify({ theme }));
        localStorage.setItem("dirlume.command-history", JSON.stringify([
          ...(windows ? [{ text: powershell, date, source: "local" }] : []),
          { text: bash, date, source: windows ? "ssh" : "local" },
          { text: long, date, source: "local" },
          unknown,
        ]));
        window.__TAURI_INTERNALS__ = {
          transformCallback: () => 1,
          invoke: async (name, args) => {
            if (name === "locations") return [{ label: "Home", path: folder }];
            if (name === "list_directory") return { path: args.path, parent: null, omitted: 0, entries: [] };
            if (name === "file_icons" || name === "installed_fonts") return [];
            return null;
          },
        };
      }, { windows, theme, bash, powershell, unknown, long });
      await page.goto("http://dirlume.test/");
      await page.locator(`html[data-theme="${theme}"]`).waitFor();
      const field = page.getByRole("combobox", { name: "Command line", exact: true });
      await field.press("Alt+F8");
      const history = page.getByRole("dialog", { name: "Command history", exact: true });
      const search = history.getByRole("searchbox", { name: "Search commands" });
      await search.waitFor();
      assert.ok((await history.boundingBox()).width >= 640);
      const bashRow = history.getByRole("button", { name: /if nginx/ });
      const colors = (row) => row.locator("code span").evaluateAll((spans) => new Set(spans.map((span) => getComputedStyle(span).color)).size);
      assert.equal(await bashRow.locator("code").textContent(), bash);
      assert.equal(await bashRow.locator(".syntax-string").textContent(), '"GET\n          /health"');
      assert.deepEqual(await bashRow.locator(".syntax-property").allTextContents(), ["-t", "-n"]);
      assert.ok((await bashRow.locator(".syntax-keyword").allTextContents()).includes("|"));
      assert.ok(await colors(bashRow) >= 3);
      if (windows) {
        const row = history.getByRole("button", { name: /Get-ChildItem/ });
        assert.deepEqual(await row.locator(".syntax-property").allTextContents(), ["-Path", "-Pattern"]);
        assert.equal(await row.locator(".syntax-keyword").textContent(), "|");
        assert.deepEqual(await row.locator(".syntax-string").allTextContents(), ['"C:\\logs"', '"GET\n    /health"']);
        assert.ok(await colors(row) >= 3);
      }
      const fallback = history.getByRole("region", { name: "Unknown date", exact: true }).getByRole("button", { name: unknown, exact: true });
      assert.equal(await fallback.locator("code").textContent(), unknown);
      assert.equal(await fallback.locator("code span").count(), 0);
      if (process.env.DIRLUME_COMMAND_HISTORY_PREVIEW) await history.screenshot({ path: `.smoke/command-history-767-${theme}.png` });
      await page.setViewportSize({ width: 400, height: 420 });
      assert.ok((await history.boundingBox()).width <= 400);
      assert.equal(await history.locator(".dialog-body").evaluate((body) => body.scrollWidth <= body.clientWidth), true);
      await search.fill("nginx access.log");
      assert.equal(await history.locator(".command-history-group button").count(), 1);
      await bashRow.press("Enter");
      assert.equal(await field.inputValue(), bash);
      assert.equal(await field.evaluate((element) => element === document.activeElement), true);
      console.log(`Verified ${platform} command history sizing, ${theme} syntax colors, and exact multiline recall.`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
