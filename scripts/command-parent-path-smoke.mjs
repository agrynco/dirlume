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
    const entries = [
      { name: "ordinary.txt", hidden: false, directory: false, link: false, size: 3, modified: null },
      { name: "subfolder", hidden: false, directory: true, link: false, size: null, modified: null },
    ];
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args) => {
        if (command === "locations") return [{ label: "Home", path: directory }, { label: "Downloads", path: directory }];
        if (command === "list_directory") return { path: args.path, parent: args.path === directory ? parent : null, entries, omitted: 0 };
        if (command === "ssh_profiles") return [{ id: "ssh", label: "Remote fixture", host: "fixture", port: 22 }];
        if (command === "connect_ssh") return { kind: "connected", id: 2, address: "fixture", origin: "sftp://fixture",
          segments: ["Remote space", "child"], listing: { entries, omitted: 0, elevated: false } };
        if (command === "list_ssh") return { entries, omitted: 0, elevated: false };
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
  const files = list(page, side);
  const selected = row(page, side, name);
  await page.waitForFunction(({ side, location }) => document.getElementById(`${side}-path`)?.dataset.path === location &&
    document.getElementById(`${side}-files`)?.getAttribute("aria-busy") === "false", { side, location });
  await selected.click();
  await command.fill("echo replace now");
  await command.evaluate((input) => input.setSelectionRange(5, 12));
  await files.focus();
  await page.waitForFunction((side) => document.activeElement?.id === `${side}-files` &&
    document.getElementById(`${side}-pane`)?.classList.contains("active"), side);
  await files.press(shortcut);
  await page.waitForFunction((expected) => {
    const command = document.querySelector('.command-bar textarea');
    return command?.value === expected && document.activeElement === command;
  }, `echo ${expected} now`).catch(async (error) => {
    const value = await command.inputValue();
    const focus = await page.evaluate(() => document.activeElement?.id || document.activeElement?.getAttribute("aria-label"));
    throw new Error(`${side} ${location}, ${shortcut}: expected ${expected}, got ${value}, focus ${focus}.`, { cause: error });
  });
  assert.deepEqual(await command.evaluate((input) => [input.selectionStart, input.selectionEnd]),
    [5 + expected.length, 5 + expected.length]);
  assert.equal(await page.locator(".command-bar > span").textContent(), location);
}

async function openParent(page, side, parent) {
  await row(page, side, "..").click();
  await list(page, side).press("Enter");
  await page.waitForFunction(({ side, parent }) => document.getElementById(`${side}-path`)?.dataset.path === parent &&
    document.getElementById(`${side}-files`)?.getAttribute("aria-busy") === "false", { side, parent });
}

const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const [userAgent, directory, parent, inserted, shortcut] of [
    [windows, "C:\\Example\\Parent\\Current", "C:\\Example\\Parent", "C:\\Example\\Parent\\Current", "Control+f"],
    [windows, "C:\\Program Files\\Common Files", "C:\\Program Files", "'C:\\Program Files\\Common Files'", "Control+f"],
    [linux, "/usr/bin", "/usr", "/usr/bin", "Control+f"],
    [mac, "/usr/local/bin", "/usr/local", "/usr/local/bin", "Meta+f"],
  ]) {
    const page = await fixture(browser, userAgent, directory, parent);
    const quote = (path) => path.includes(" ") ? `'${path}'` : path;
    const separator = userAgent === windows ? "\\" : "/";
    for (const side of ["left", "right"]) await expectPath(page, side, "..", shortcut, inserted, directory);
    await expectPath(page, "left", "ordinary.txt", shortcut, quote(directory + separator + "ordinary.txt"), directory);
    await expectPath(page, "right", "subfolder", shortcut, quote(directory + separator + "subfolder"), directory);
    await openParent(page, "right", parent);
    await page.close();
  }

  const page = await fixture(browser, windows, "C:\\fixture", "C:\\", { commandPath: ["Ctrl+Shift+P"] });
  const left = pane(page, "left");
  await left.getByRole("button", { name: "Locations for left pane", exact: true }).click();
  await left.getByRole("button", { name: "SSH", exact: true }).click();
  await left.getByRole("option", { name: /^Remote fixture/ }).dblclick();
  await expectPath(page, "left", "..", "Control+Shift+p", "'/Remote space/child'", "/Remote space/child");
  await openParent(page, "left", "/Remote space");
  await page.close();

  const disabled = await fixture(browser, windows, "C:\\fixture", "C:\\", { commandPath: [] });
  await commandLine(disabled).fill("unchanged");
  await row(disabled, "left", "..").click();
  await list(disabled, "left").press("Control+f");
  assert.equal(await commandLine(disabled).inputValue(), "unchanged");
  console.log("Verified the current path from the parent row, ordinary paths, Enter navigation, selection replacement, focus, and configurable shortcuts.");
} finally {
  await browser.close();
}
