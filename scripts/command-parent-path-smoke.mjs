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
      { name: "Звіт дня.txt", hidden: false, directory: false, link: false, size: 3, modified: null },
      { name: "subfolder", hidden: false, directory: true, link: false, size: null, modified: null },
      { name: "archive.zip", hidden: false, directory: false, link: false, size: 3, modified: null },
    ];
    window.fixtureOpens = [];
    window.fileOpenFixture = { delay: false, pending: new Map(), shellWrites: [] };
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args) => {
        if (command === "locations") return [{ label: "Home", path: directory }, { label: "Downloads", path: directory }];
        if (command === "list_directory") return { path: args.path, parent: args.path === directory ? parent : null, entries, omitted: 0 };
        if (command === "ftp_profiles") return [];
        if (command === "ssh_profiles") return [{ id: "ssh", label: "Remote fixture", host: "fixture", port: 22 }];
        if (command === "connect_ssh") return { kind: "connected", id: 2, address: "fixture", origin: "sftp://fixture",
          segments: ["Remote space", "child"], listing: { entries, omitted: 0, elevated: false } };
        if (command === "list_ssh") return { entries, omitted: 0, elevated: false };
        if (command === "operate") {
          window.fixtureOpens.push(args);
          if (window.fileOpenFixture.delay && args.operation.kind === "open") return new Promise((resolve, reject) =>
            window.fileOpenFixture.pending.set(args.operation.name, (error) => error ? reject(error) : resolve()));
          return null;
        }
        if (command === "open_terminal") throw "Shell is unavailable in the fixture.";
        if (command === "write_terminal") window.fileOpenFixture.shellWrites.push(args);
        if (command === "open_archive") return { id: 3, path: args.path, parent: directory, writable: false, canAdd: false,
          listing: { entries: [], omitted: 0 } };
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

async function expectSystemOpen(page, side, name, key, directory, operation) {
  const before = await page.evaluate(() => window.fixtureOpens.length);
  const path = page.locator(`#${side}-path`);
  const location = await path.getAttribute("data-path");
  await row(page, side, name).click();
  await list(page, side).press(key);
  await page.waitForFunction((before) => window.fixtureOpens.length === before + 1, before);
  assert.deepEqual(await page.evaluate(() => window.fixtureOpens.at(-1)), { directory, operation });
  assert.equal(await path.getAttribute("data-path"), location);
}

async function checkOpenFeedback(page, directory, parent, separator) {
  const name = "Звіт дня.txt";
  const target = directory + separator + name;
  const left = pane(page, "left");
  const right = pane(page, "right");
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  const toggleTerminal = page.getByRole("button", { name: "Toggle terminal", exact: true });
  if (await toggleTerminal.getAttribute("aria-pressed") === "true") await toggleTerminal.click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => { window.fileOpenFixture.delay = true; });
  const before = await page.evaluate(() => window.fixtureOpens.length);
  await row(page, "left", name).click();
  await list(page, "left").press("Enter");
  const pending = left.getByRole("status").getByText(`Opening ${name}…`, { exact: true });
  await pending.waitFor();
  assert.equal(await list(page, "left").evaluate((element) => element === document.activeElement), true);
  assert.equal(await left.locator(".pane-file-open .spin").evaluate((node) => getComputedStyle(node).animationName), "none");
  await row(page, "left", name).dblclick();
  await row(page, "right", "ordinary.txt").dblclick();
  await right.getByRole("status").getByText("Opening ordinary.txt…", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.fixtureOpens.length), before + 2);
  await openParent(page, "left", parent);
  await page.waitForTimeout(2_100);
  await pending.waitFor();

  await toggleTerminal.click();
  await terminal.getByRole("button", { name: "File opens", exact: true }).click();
  const history = terminal.getByRole("region", { name: "File opens", exact: true });
  const record = history.getByRole("row").filter({ hasText: target });
  await record.getByText("Opening…", { exact: true }).waitFor();
  assert.ok(await record.locator("time").getAttribute("datetime"));
  await page.evaluate((name) => window.fileOpenFixture.pending.get(name)(), name);
  const received = left.getByRole("status").filter({ hasText: "Open request sent to the system" }).getByText(name, { exact: true });
  await received.waitFor();
  await record.getByText("Open request sent to the system", { exact: true }).waitFor();
  await page.evaluate(() => window.fileOpenFixture.pending.get("ordinary.txt")("No application is associated with this file."));
  await right.getByRole("alert").filter({ hasText: "Could not open ordinary.txt. No application is associated with this file." }).waitFor();
  await history.getByText("Open request failed. No application is associated with this file.", { exact: true }).waitFor();
  await received.waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => window.fileOpenFixture.shellWrites), []);
  await page.reload();
  await toggleTerminal.click();
  await terminal.getByRole("button", { name: "File opens", exact: true }).click();
  await history.getByText("No file opens in this session.", { exact: true }).waitFor();
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
    for (const side of ["left", "right"]) {
      await expectSystemOpen(page, side, "..", "Shift+Enter", directory, { kind: "open_directory" });
      await expectSystemOpen(page, side, "subfolder", "Shift+Enter", directory + separator + "subfolder", { kind: "open_directory" });
    }
    for (const key of ["Enter", "Shift+Enter"]) {
      await expectSystemOpen(page, "left", "ordinary.txt", key, directory, { kind: "open", name: "ordinary.txt" });
      await row(page, "left", "archive.zip").click();
      await list(page, "left").press(key);
      await page.waitForFunction((path) => document.getElementById("left-path")?.dataset.path === path,
        directory + separator + "archive.zip!/");
      await pane(page, "left").getByRole("button", { name: "Back", exact: true }).click();
      await row(page, "left", "archive.zip").waitFor();
    }
    await openParent(page, "right", parent);
    await commandLine(page).fill("echo draft");
    const before = await page.evaluate(() => window.fixtureOpens.length);
    await commandLine(page).press("Shift+Enter");
    assert.equal(await commandLine(page).inputValue(), "");
    assert.equal(await page.evaluate(() => window.fixtureOpens.length), before);
    await checkOpenFeedback(page, directory, parent, separator);
    await page.close();
  }

  const page = await fixture(browser, windows, "C:\\fixture", "C:\\", {
    commandPath: ["Ctrl+Shift+P"], openInSystem: ["Ctrl+Shift+F9"], open: ["Ctrl+Alt+F9"],
  });
  await expectSystemOpen(page, "left", "subfolder", "Control+Shift+F9", "C:\\fixture\\subfolder", { kind: "open_directory" });
  await list(page, "left").press("Shift+Enter");
  assert.equal(await page.evaluate(() => window.fixtureOpens.length), 1);
  const left = pane(page, "left");
  await left.getByRole("button", { name: "Locations for left pane", exact: true }).click();
  await left.getByRole("button", { name: "NetBox", exact: true }).click();
  await left.getByRole("option", { name: /^Remote fixture/ }).dblclick();
  await expectPath(page, "left", "..", "Control+Shift+p", "'/Remote space/child'", "/Remote space/child");
  await row(page, "left", "subfolder").click();
  await list(page, "left").press("Control+Shift+F9");
  assert.equal(await page.evaluate(() => window.fixtureOpens.length), 1);
  assert.equal(await page.locator("#left-path").getAttribute("data-path"), "/Remote space/child");
  await row(page, "left", "..").click();
  await list(page, "left").press("Control+Alt+F9");
  await page.waitForFunction(() => document.getElementById("left-path")?.dataset.path === "/Remote space");
  await page.reload();
  await expectSystemOpen(page, "right", "ordinary.txt", "Control+Alt+F9", "C:\\fixture", { kind: "open", name: "ordinary.txt" });
  await page.close();

  const disabled = await fixture(browser, windows, "C:\\fixture", "C:\\", { commandPath: [], openInSystem: [], open: [] });
  await commandLine(disabled).fill("unchanged");
  await row(disabled, "left", "..").click();
  await list(disabled, "left").press("Control+f");
  assert.equal(await commandLine(disabled).inputValue(), "unchanged");
  await list(disabled, "left").press("Shift+Enter");
  assert.equal(await disabled.evaluate(() => window.fixtureOpens.length), 0);
  await row(disabled, "left", "ordinary.txt").click();
  await list(disabled, "left").press("Enter");
  assert.equal(await disabled.evaluate(() => window.fixtureOpens.length), 0);
  await row(disabled, "left", "ordinary.txt").dblclick();
  await disabled.waitForFunction(() => window.fixtureOpens.length === 1);
  console.log("Verified the current path from the parent row, ordinary paths, Enter navigation, selection replacement, focus, and configurable shortcuts.");
  console.log("Verified system opener destinations in both panes, archive handling, command-line submission, and shortcut scope.");
  console.log("Verified pending and failed opens, cross-pane deduplication, retained paths, reduced motion, and session-only Terminal history with an unavailable shell.");
} finally {
  await browser.close();
}
