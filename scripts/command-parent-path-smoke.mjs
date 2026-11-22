import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const linux = "Mozilla/5.0 (X11; Linux x86_64)";
const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
const pane = (page, side) => page.getByRole("region", { name: `${side} pane`, exact: true });
const list = (page, side) => page.locator(`#${side}-files`);
const row = (page, side, name) => list(page, side).locator(`[role="option"][data-tooltip=${JSON.stringify(name)}]`);
const commandLine = (page) => page.getByRole("combobox", { name: "Command line", exact: true });

async function fixture(browser, userAgent, directory, parent, bindings) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 710 }, userAgent, locale: "en-US" });
  page.setDefaultTimeout(8000);
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  await page.addInitScript(({ directory, parent, bindings }) => {
    if (bindings) localStorage.setItem("dirlume.preferences.v1", JSON.stringify({ bindingDefaults: 9,
      activeShortcutScheme: "fixture", shortcutSchemes: [{ id: "fixture", name: "Fixture keys", bindings }] }));
    const entries = [{ name: "ordinary.txt", hidden: false, directory: false, link: false, size: 3, modified: null }];
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args) => {
        if (command === "locations") return [{ label: "Home", path: directory }, { label: "Downloads", path: directory }];
        if (command === "list_directory") return { path: args.path, parent, entries, omitted: 0 };
        if (command === "ssh_profiles") return [{ id: "ssh", label: "Remote fixture", host: "fixture", port: 22 }];
        if (command === "connect_ssh") return { kind: "connected", id: 2, address: "fixture", origin: "sftp://fixture",
          segments: ["Remote space", "child"], listing: { entries, omitted: 0, elevated: false } };
        if (command === "file_icons") return args.items.map(() => null);
        return null;
      },
    };
  }, { directory, parent, bindings });
  await page.goto("http://dirlume.test/");
  return page;
}

async function expectPath(page, side, name, shortcut, expected, location) {
  const command = commandLine(page);
  await command.fill("echo replace now");
  await command.evaluate((input) => input.setSelectionRange(5, 12));
  await row(page, side, name).click();
  await list(page, side).press(shortcut);
  await page.waitForFunction((expected) => {
    const command = document.querySelector('.command-bar textarea');
    return command?.value === expected && document.activeElement === command;
  }, `echo ${expected} now`);
  assert.equal(await page.locator(".command-bar > span").textContent(), location);
}

const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const [userAgent, directory, parent, inserted, shortcut] of [
    [windows, "C:\\Program Files", "C:\\", "C:\\", "Control+f"],
    [windows, "C:\\Program Files\\Common Files", "C:\\Program Files", "'C:\\Program Files'", "Control+f"],
    [linux, "/usr/bin", "/usr", "/usr", "Control+f"],
    [mac, "/usr/local/bin", "/usr/local", "/usr/local", "Meta+f"],
  ]) {
    const page = await fixture(browser, userAgent, directory, parent);
    for (const side of ["left", "right"]) await expectPath(page, side, "..", shortcut, inserted, directory);
    const ordinary = directory + (userAgent === windows ? "\\" : "/") + "ordinary.txt";
    await expectPath(page, "left", "ordinary.txt", shortcut, ordinary.includes(" ") ? `'${ordinary}'` : ordinary, directory);
    await page.close();
  }

  const page = await fixture(browser, windows, "C:\\fixture", "C:\\", { commandPath: ["Ctrl+Shift+P"] });
  const left = pane(page, "left");
  await left.getByRole("button", { name: "Locations for left pane", exact: true }).click();
  await left.getByRole("button", { name: "SSH", exact: true }).click();
  await left.getByRole("option", { name: /^Remote fixture/ }).dblclick();
  await expectPath(page, "left", "..", "Control+Shift+p", "'/Remote space'", "/Remote space/child");
  await page.close();

  const disabled = await fixture(browser, windows, "C:\\fixture", "C:\\", { commandPath: [] });
  await commandLine(disabled).fill("unchanged");
  await row(disabled, "left", "..").click();
  await list(disabled, "left").press("Control+f");
  assert.equal(await commandLine(disabled).inputValue(), "unchanged");
  console.log("Verified parent and ordinary paths, caret replacement, focus, both panes, Windows, POSIX, SSH, remapping, and disabling the shortcut.");
} finally {
  await browser.close();
}
