import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { editPaneAddress } from "./pane-address-smoke.mjs";

const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const dialog = (page, name) => page.getByRole("dialog", { name, exact: true });

async function fixture(browser, remote = false) {
  const page = await browser.newPage({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", locale: "en-US" });
  page.setDefaultTimeout(15_000);
  await page.clock.install();
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  await page.addInitScript(() => {
    const home = "C:\\source";
    const entries = ["a.bin", "b.bin", "c.bin"].map((name) =>
      ({ name, directory: false, link: false, hidden: false, size: 600_000, modified: null }));
    entries.push({ ...entries[0], name: "folder", directory: true, size: null });
    window.transferFixture = {
      requests: [], current: null,
      progress(bytes, total = 600_000) {
        const { output, request } = this.current;
        output.onmessage({ kind: "progress", file: request.source.name, path: request.source.name, bytes, total });
      },
      conflict() {
        this.current.output.onmessage({ kind: "conflict", conflict: {
          path: "b.bin", directory: false, readOnly: false, replaceable: true,
          allowRemember: false, existing: { size: 1, modified: null, directory: false },
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
          case "ssh_profiles": return [{ id: "fixture", label: "Fixture", host: "fixture.example", port: 22 }];
          case "connect_ssh":
            return { kind: "connected", id: 12, address: "Fixture", origin: "sftp://fixture.example",
              segments: ["incoming"], listing: { entries: [], omitted: 0, elevated: false } };
          case "list_ssh": return { entries: [], omitted: 0, elevated: false };
          case "transfer_item":
            state.requests.push(args.request);
            return new Promise((resolve, reject) => { state.current = { ...args, resolve, reject }; });
          case "resolve_transfer":
            state.current.resolve({ kind: "skipped" });
            return null;
          case "cancel_transfer":
            state.current.reject(new Error("Transfer canceled."));
            return null;
          default: return null;
        }
      },
    };
  });
  await page.goto("http://dirlume.test/");
  const right = page.getByRole("region", { name: "right pane", exact: true });
  if (remote) {
    await button(right, "Locations for right pane").press("Enter");
    await button(right, "SSH").press("Enter");
    await right.getByRole("option", { name: /^Fixture/ }).dispatchEvent("dblclick", { button: 0 });
  } else {
    const address = await editPaneAddress(page, "right");
    await address.fill("D:\\target");
    await address.press("Enter");
  }
  await page.waitForFunction((path) => document.getElementById("right-path")?.dataset.path === path, remote ? "/incoming" : "D:\\target");
  return page;
}

async function start(page, names, move = false) {
  const source = page.locator("#left-files");
  const row = (name) => source.locator(`[role="option"][data-tooltip=${JSON.stringify(name)}]`);
  // Use selection events so the estimate test does not depend on how the
  // runner schedules animation frames after Playwright installs a clock.
  await row(names[0]).dispatchEvent("click", { button: 0 });
  if (names.length > 1) for (const name of names) await row(name).dispatchEvent("click", { button: 0, ctrlKey: true });
  await source.press(move ? "F6" : "F5");
  const setup = dialog(page, move ? "Rename or move" : "Copy");
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

const browser = await chromium.launch({ channel: "chrome" });
try {
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
