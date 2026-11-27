import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { editPaneAddress } from "./pane-address-smoke.mjs";

const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const dialog = (page, name) => page.getByRole("dialog", { name, exact: true });

async function fixture(browser, remote = false, { platform = "Windows NT 10.0; Win64; x64", language, mockClock = true } = {}) {
  const page = await browser.newPage({ userAgent: `Mozilla/5.0 (${platform})`, locale: "en-US" });
  page.setDefaultTimeout(15_000);
  if (mockClock) await page.clock.install();
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  const windows = platform.startsWith("Windows");
  const home = windows ? "C:\\source" : "/source";
  const target = windows ? "D:\\target" : "/target";
  await page.addInitScript(({ home, language }) => {
    if (language) localStorage.setItem("dirlume.preferences.v1", JSON.stringify({ language }));
    const entries = ["a.bin", "b.bin", "c.bin"].map((name) =>
      ({ name, directory: false, link: false, hidden: false, size: 600_000, modified: null }));
    entries.push({ ...entries[0], name: "folder", directory: true, size: null });
    window.transferFixture = {
      requests: [], decisions: [], current: null,
      progress(bytes, total = 600_000) {
        const { output, request } = this.current;
        output.onmessage({ kind: "progress", file: request.source.name, path: request.source.name, bytes, total });
      },
      conflict(readOnly = false) {
        this.current.output.onmessage({ kind: "conflict", conflict: {
          path: "b.bin", directory: false, readOnly, confirmReadOnly: readOnly, replaceable: true,
          allowRemember: true, existing: { size: 1, modified: null, directory: false },
        } });
      },
    };
    const state = window.transferFixture;
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (name, args) => {
        switch (name) {
          case "locations": return [{ label: "Home", path: home }];
          case "list_directory": return { path: args.path, entries: args.path === home ? entries : [], parent: null, omitted: 0 };
          case "file_icons": return args.items.map(() => null);
          case "ftp_profiles": return [];
          case "ssh_profiles": return [{ id: "fixture", label: "Fixture", host: "fixture.example", port: 22 }];
          case "connect_ssh":
            return { kind: "connected", id: 12, address: "Fixture", origin: "sftp://fixture.example",
              segments: ["incoming"], listing: { entries: [], omitted: 0, elevated: false } };
          case "list_ssh": return { entries: [], omitted: 0, elevated: false };
          case "transfer_item":
            state.requests.push(args.request);
            return new Promise((resolve, reject) => { state.current = { ...args, resolve, reject }; });
          case "resolve_transfer":
            state.decisions.push(args);
            state.current.resolve({ kind: args.decision === "skip" ? "skipped" : "completed" });
            return null;
          case "cancel_transfer":
            state.current.reject(new Error("Transfer canceled."));
            return null;
          default: return null;
        }
      },
    };
  }, { home, language });
  await page.goto("http://dirlume.test/");
  const right = page.getByRole("region", { name: "right pane", exact: true });
  if (remote) {
    await button(right, "Locations for right pane").press("Enter");
    await button(right, "NetBox").press("Enter");
    await right.getByRole("option", { name: /^Fixture/ }).dispatchEvent("dblclick", { button: 0 });
  } else {
    const address = await editPaneAddress(page, "right");
    await address.fill(target);
    await address.press("Enter");
  }
  await page.waitForFunction((path) => document.getElementById("right-path")?.dataset.path === path, remote ? "/incoming" : target);
  return page;
}

async function start(page, names, move = false, policy = "ask") {
  const source = page.locator('#left-files[aria-busy="false"]');
  await page.locator("dialog[open]").waitFor({ state: "hidden" });
  const row = (name) => source.locator(`[role="option"][data-tooltip=${JSON.stringify(name)}]`);
  // Use selection events so the estimate test does not depend on how the
  // runner schedules animation frames after Playwright installs a clock.
  await row(names[0]).dispatchEvent("click", { button: 0 });
  if (names.length > 1) for (const name of names) await row(name).dispatchEvent("click", { button: 0, ctrlKey: true });
  await source.press(move ? "F6" : "F5");
  const setup = dialog(page, move ? "Rename or move" : "Copy");
  if (policy !== "ask") {
    const choice = setup.getByRole("combobox", { name: "Existing files", exact: true });
    await choice.selectOption({ label: "Overwrite all" });
    assert.equal(await choice.inputValue(), policy);
    assert.equal(await setup.getByRole("checkbox", { name: "Also ask about read-only files" }).isDisabled(), true);
  }
  await button(setup, move ? "Move" : "Copy").press("Enter");
  await waitForSource(page, names[0]);
  return dialog(page, move ? "Moving…" : "Copying…");
}

function waitForSource(page, name, retry = false) {
  return page.waitForFunction(({ name, retry }) => {
    const request = window.transferFixture.current?.request;
    return request?.source.name === name && request.retry === retry;
  }, { name, retry });
}

function report(page, bytes, total = 600_000) {
  return page.evaluate(([size, total]) => window.transferFixture.progress(size, total), [bytes, total]);
}

function complete(page) {
  return page.evaluate(() => window.transferFixture.current.resolve({ kind: "completed" }));
}

async function verifyCopyCheckboxes(browser) {
  for (const [platform, language, width] of [["Windows NT 10.0; Win64; x64", "en", 720], ["X11; Linux x86_64", "uk", 325]]) {
    const page = await fixture(browser, false, { platform, language, mockClock: false });
    try {
      const files = page.locator("#left-files");
      await files.locator('[data-tooltip="a.bin"]').click();
      await files.press("F5");
      const options = page.locator("dialog[open] .transfer-options");
      const inputs = options.getByRole("checkbox");
      await inputs.first().waitFor();
      await page.setViewportSize({ width, height: 680 });
      const positions = await inputs.evaluateAll((checkboxes) => checkboxes.map((input) => {
        const checkbox = input.getBoundingClientRect();
        const text = input.nextElementSibling;
        const label = text.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(text);
        return {
          x: checkbox.x, gap: label.x - checkbox.right,
          centerOffset: checkbox.y + checkbox.height / 2 - label.y - label.height / 2,
          lines: range.getClientRects().length, checked: input.checked,
        };
      }));
      assert.deepEqual(positions.map(({ checked }) => checked), [true, false, false, false, false]);
      assert.ok(positions.every(({ x, gap }) => x === positions[0].x && gap === 8));
      assert.ok(positions.every(({ centerOffset }) => Math.abs(centerOffset) <= 0.5), "Each checkbox must align with its full label.");
      if (language === "uk") assert.ok(positions.some(({ lines }) => lines > 1), "The narrow translated label did not wrap.");
      for (const [index, { checked }] of positions.entries()) {
        const input = inputs.nth(index);
        await input.locator("..").locator("span").click();
        assert.equal(await input.isChecked(), !checked);
        await input.press("Space");
        assert.equal(await input.isChecked(), checked);
      }
    } finally { await page.close(); }
  }
}

const browser = await chromium.launch({ channel: "chrome" });
try {
  await verifyCopyCheckboxes(browser);
  console.log("Verified aligned Copy checkboxes, translated wrapping, and label and keyboard activation.");
  const overwritePage = await fixture(browser, false, { mockClock: false });
  await start(overwritePage, ["a.bin"], false, "overwrite");
  assert.equal(await overwritePage.evaluate(() => window.transferFixture.current.request.policy), "overwrite");
  await complete(overwritePage);
  await dialog(overwritePage, "Copying…").waitFor({ state: "hidden" });
  await start(overwritePage, ["b.bin"]);
  assert.equal(await overwritePage.evaluate(() => window.transferFixture.current.request.policy), "ask");
  await overwritePage.evaluate(() => window.transferFixture.conflict(true));
  const readOnly = dialog(overwritePage, "File already exists");
  const rememberReadOnly = readOnly.getByRole("checkbox", { name: "Remember choice for read-only files", exact: true });
  await rememberReadOnly.waitFor();
  assert.equal(await rememberReadOnly.isChecked(), false);
  await button(readOnly, "Overwrite all").click();
  await dialog(overwritePage, "Copying…").waitFor({ state: "hidden" });
  assert.equal(await overwritePage.evaluate(() => window.transferFixture.decisions[0].decision), "overwrite_all");
  await overwritePage.close();
  const copyPage = await fixture(browser);
  const copy = await start(copyPage, ["a.bin", "b.bin", "c.bin"]);
  const estimate = copy.locator(".transfer-estimate");
  await copyPage.clock.runFor(2_000);
  await report(copyPage, 100_000);
  await copyPage.clock.runFor(2_000);
  await report(copyPage, 200_000);
  assert.equal(await estimate.count(), 0);
  await copyPage.clock.runFor(1_200);
  await estimate.getByText(/About \d+ seconds remaining/).waitFor();
  assert.ok(Number((await estimate.innerText()).match(/\d+/)[0]) > 20);
  await copyPage.clock.runFor(5_000);
  await estimate.getByText("Estimating time remaining…", { exact: true }).waitFor();
  await report(copyPage, 470_000);
  await copyPage.clock.runFor(2_000);
  await estimate.getByText(/About \d+ seconds remaining/).waitFor();
  await report(copyPage, 600_000);
  await complete(copyPage);
  await waitForSource(copyPage, "b.bin");
  await copyPage.evaluate(() => window.transferFixture.conflict());
  const conflict = dialog(copyPage, "File already exists");
  await conflict.waitFor();
  assert.equal(await estimate.count(), 0);
  await copyPage.clock.fastForward(60_000);
  await button(conflict, "Skip").press("Enter");
  await waitForSource(copyPage, "c.bin");
  await report(copyPage, 400_000);
  await copyPage.clock.runFor(2_000);
  await estimate.getByText(/About \d+ seconds remaining/).waitFor();
  assert.ok(Number((await estimate.innerText()).match(/\d+/)[0]) < 10);
  await button(copy, "Cancel").press("Enter");
  await dialog(copyPage, "Transfer canceled").waitFor();
  assert.equal(await copyPage.locator(".transfer-estimate").count(), 0);
  await copyPage.close();

  const destinationsPage = await fixture(browser);
  const files = destinationsPage.locator("#left-files");
  await files.locator('[data-tooltip="a.bin"]').dispatchEvent("click", { button: 0 });
  await files.press("F5");
  const setup = dialog(destinationsPage, "Copy");
  await setup.getByLabel("Process multiple destinations", { exact: true }).press("Space");
  await setup.getByLabel("Destination 2", { exact: true }).fill("D:\\another");
  await button(setup, "Copy").press("Enter");
  await waitForSource(destinationsPage, "a.bin");
  await destinationsPage.clock.runFor(4_000);
  await report(destinationsPage, 300_000);
  await destinationsPage.clock.runFor(1_200);
  const destinationEta = dialog(destinationsPage, "Copying…").locator(".transfer-estimate");
  await destinationEta.getByText(/About \d+ seconds remaining/).waitFor();
  assert.ok(Number((await destinationEta.innerText()).match(/\d+/)[0]) >= 14);
  await complete(destinationsPage);
  await destinationsPage.waitForFunction(() => window.transferFixture.requests.length === 2);
  assert.deepEqual(await destinationsPage.evaluate(() => window.transferFixture.requests.map(({ destination }) => destination)),
    ["D:\\target", "D:\\another"]);
  await complete(destinationsPage);
  await dialog(destinationsPage, "Copying…").waitFor({ state: "hidden" });
  await destinationsPage.close();

  const movePage = await fixture(browser);
  await start(movePage, ["a.bin", "b.bin"], true);
  await complete(movePage);
  await waitForSource(movePage, "b.bin");
  await movePage.evaluate(() => window.transferFixture.current.reject(new Error("Fixture failed.")));
  await button(dialog(movePage, "Transfer stopped"), "Retry").press("Enter");
  await waitForSource(movePage, "b.bin", true);
  const moveEta = dialog(movePage, "Moving…").locator(".transfer-estimate");
  assert.equal(await moveEta.count(), 0);
  await movePage.clock.runFor(4_000);
  await report(movePage, 300_000);
  await movePage.clock.runFor(1_200);
  await moveEta.getByText(/About [56] seconds remaining/).waitFor();
  assert.deepEqual(await movePage.evaluate(() => window.transferFixture.requests.map(({ moving, destination }) =>
    [moving, destination])), [[true, "D:\\target"], [true, "D:\\target"], [true, "D:\\target"]]);
  await complete(movePage);
  await dialog(movePage, "Moving…").waitFor({ state: "hidden" });
  assert.equal(await movePage.locator(".transfer-estimate").count(), 0);
  await movePage.close();

  const remotePage = await fixture(browser, true);
  const upload = await start(remotePage, ["folder"]);
  await remotePage.clock.runFor(4_000);
  await report(remotePage, 300_000);
  await remotePage.clock.runFor(1_200);
  await upload.getByText("Estimating time remaining…", { exact: true }).waitFor();
  await complete(remotePage);
  await upload.waitFor({ state: "hidden" });
  await start(remotePage, ["a.bin"]);
  await remotePage.clock.runFor(4_000);
  await report(remotePage, 300_000);
  await remotePage.clock.runFor(1_200);
  await upload.getByText(/About [56] seconds remaining/).waitFor();
  await complete(remotePage);
  await upload.waitFor({ state: "hidden" });
  await start(remotePage, ["b.bin"]);
  assert.equal(await upload.locator(".transfer-estimate").count(), 0);
  await complete(remotePage);
  await upload.waitFor({ state: "hidden" });
  assert.equal(await remotePage.locator(".transfer-estimate").count(), 0);
  await remotePage.close();
  console.log("Verified delayed, byte-based, stalled, conflict-paused, and retried transfer estimates in rendered Copy and Move dialogs.");
} finally {
  await browser.close();
}
