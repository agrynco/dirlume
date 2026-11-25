import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { openMainMenu } from "./menu-header-smoke.mjs";

const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ locale: "en-US" });
  page.setDefaultTimeout(8000);
  const message = "Could not check for updates. Try again later.";
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  await page.addInitScript((message) => {
    const home = /Windows/.test(navigator.userAgent) ? "C:\\fixture" : "/fixture";
    localStorage.setItem("dirlume.preferences.v1", JSON.stringify({ showStatusBar: true }));
    window.isTauri = true;
    window.triggers = [];
    window.checkedDiagnostics = [];
    window.openedLinks = [];
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      invoke: async (command, args) => {
        if (command === "locations") return [{ label: "Home", path: home }];
        if (command === "list_directory") return { path: args.path, parent: null, entries: [], omitted: 0 };
        if (command === "installed_release") return { showOnStartup: false };
        if (command === "report_diagnostic") window.checkedDiagnostics.push(args);
        if (command === "open_web_link") window.openedLinks.push(args.href);
        if (command === "check_for_update") {
          window.triggers.push(args.trigger);
          if (window.triggers.length === 3) return null;
          throw { message, updateCause: { stage: "release_api", reason: "timeout", httpStatus: null } };
        }
        return null;
      },
    };
  }, message);
  await page.goto("http://dirlume.test/");
  await page.waitForFunction(() => window.triggers.length === 1);
  const status = page.locator(".statusbar");
  await status.waitFor();
  assert.equal(await status.getByRole("alert").count(), 0);

  const checkManually = async () => {
    const menu = await openMainMenu(page, "Commands");
    await menu.getByRole("menuitem", { name: "Check for updates", exact: true }).click();
  };
  await checkManually();
  await status.getByRole("alert").filter({ hasText: message }).waitFor();
  await checkManually();
  const dialog = page.getByRole("dialog", { name: "Check for updates", exact: true });
  await dialog.getByText("Dirlume is up to date.").waitFor();
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  assert.ok(await close.evaluate((button) => button === document.activeElement));
  const donate = dialog.getByRole("button", { name: "Donate via monobank", exact: true });
  await page.keyboard.press("Shift+Tab");
  assert.ok(await donate.evaluate((button) => button === document.activeElement));
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.openedLinks.length === 1);
  assert.deepEqual(await page.evaluate(() => window.openedLinks), ["https://send.monobank.ua/jar/6ZninEa3R4"]);
  assert.ok(await dialog.isVisible());

  const checks = await page.evaluate(() => ({ triggers: window.triggers, diagnostics: window.checkedDiagnostics }));
  assert.deepEqual(checks.triggers, ["automatic", "manual", "manual"]);
  assert.ok(!checks.diagnostics.some(({ operation }) => operation === "check_for_update" || operation === "desktop_action"));
  console.log("Verified quiet startup checks, manual update status, the donation button, and native diagnostic deduplication.");
} finally {
  await browser.close();
}
