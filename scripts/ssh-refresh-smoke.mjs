import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import { editPaneAddress } from "./pane-address-smoke.mjs";

const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const pane = (page, side) => page.getByRole("region", { name: `${side} pane`, exact: true });
const list = (page, side) => page.locator(`#${side}-files`);
const row = (page, side, name) => list(page, side).locator(`[data-tooltip=${JSON.stringify(name)}]`);

async function useSftpFixture(page, python) {
  const child = spawn(python, ["-u", "scripts/sftp-refresh-fixture.py"], { windowsHide: true });
  page.once("close", () => child.kill());
  const messages = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let failure = "";
  child.on("error", (error) => { failure = error.message; });
  child.stderr.on("data", (chunk) => { failure += chunk; });
  async function readReply() {
    const { value, done } = await messages.next();
    assert.ok(!done, `The loopback SFTP fixture exited. ${failure}`);
    const reply = JSON.parse(value);
    if (reply.error) throw new Error(reply.error);
    return reply;
  }
  assert.equal((await readReply()).ready, true);
  let previous = Promise.resolve();
  await page.exposeFunction("sftpFixture", (command, path) => {
    const request = previous.then(async () => {
      child.stdin.write(JSON.stringify([command, path]) + "\n");
      return (await readReply()).result;
    });
    previous = request.catch(() => {});
    return request;
  });
}

async function fixture(browser, refresh) {
  const page = await browser.newPage({ viewport: { width: 1080, height: 710 }, locale: "en-US" });
  if (process.env.DIRLUME_SFTP_TEST_PYTHON) await useSftpFixture(page, process.env.DIRLUME_SFTP_TEST_PYTHON);
  page.setDefaultTimeout(8000);
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  await page.addInitScript((refresh) => {
    if (refresh) localStorage.setItem("dirlume.preferences.v1", JSON.stringify({ bindingDefaults: 9,
      activeShortcutScheme: "fixture", shortcutSchemes: [{ id: "fixture", name: "Fixture keys", bindings: { refresh } }] }));
    const root = /Windows/.test(navigator.userAgent) ? "C:\\fixture" : "/fixture";
    const entry = (name) => ({ name, directory: false, link: false, hidden: false, size: 4, modified: null });
    const remote = { "/destination": [entry("remote.txt")], "/elsewhere": [] };
    const state = window.sshFixture = {
      root, local: [entry("upload.txt"), entry("rollback.txt"), entry("another.txt")], remote,
      requests: [], hold: false, fail: false, transfer: "complete",
    };
    const entriesFor = async (path) => window.sftpFixture
      ? (await window.sftpFixture("list", path)).map(entry) : remote[path].slice();
    state.write = async (path, name) => {
      if (window.sftpFixture) await window.sftpFixture("write", `${path}/${name}`);
      remote[path].push(entry(name));
    };
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args) => {
        if (command === "locations") return [{ label: "Home", path: root }];
        if (command === "list_directory") {
          state.requests.push(["local", args.path]);
          return { path: args.path, parent: null, entries: state.local, omitted: 0 };
        }
        if (command === "file_icons") return args.items.map(() => null);
        if (command === "ssh_profiles") return [{ id: "ssh", label: "Remote fixture", host: "fixture", port: 22 }];
        if (command === "connect_ssh") return { kind: "connected", id: 37, address: "Remote fixture", origin: "sftp://fixture",
          segments: ["destination"], listing: { entries: await entriesFor("/destination"), omitted: 0, elevated: false } };
        if (command === "list_ssh") {
          const path = "/" + args.segments.join("/");
          if (args.reuseSudo) state.requests.push(["ssh", args.id, path]);
          if (state.fail) throw new Error("SSH fixture could not list the directory.");
          const listing = { entries: await entriesFor(path), omitted: 0, elevated: false };
          if (state.hold) {
            state.hold = false;
            await new Promise((resolve) => { state.release = resolve; });
          }
          return listing;
        }
        if (command === "transfer_item") {
          if (args.request.sshDestination !== 37) throw new Error("The upload used the wrong SSH connection.");
          const { destination, source } = args.request;
          if (state.transfer === "skip") return { kind: "skipped" };
          if (state.transfer === "cancel") {
            await state.write(destination, "committed-before-cancel.txt");
            await new Promise((resolve) => { state.cancelTransfer = resolve; });
            throw new Error("The upload was canceled.");
          }
          if (state.transfer === "fail") {
            await state.write(destination, "already-committed.txt");
            throw new Error("The remaining upload failed.");
          }
          await state.write(destination, source.name);
          return { kind: "completed" };
        }
        if (command === "cancel_transfer") { state.cancelTransfer(); return null; }
        return null;
      },
    };
  }, refresh ?? null);
  await page.goto("http://dirlume.test/");
  return page;
}

async function connect(page, side) {
  const panel = pane(page, side);
  await button(panel, `Locations for ${side} pane`).click();
  await button(panel, "SSH").click();
  await list(page, side).getByRole("option", { name: /^Remote fixture/ }).dblclick();
  await row(page, side, "remote.txt").waitFor();
}

async function upload(page, side, name, destination = "/destination") {
  await row(page, side, name).click();
  await list(page, side).press("F5");
  const copy = page.getByRole("dialog", { name: "Copy", exact: true });
  const field = copy.getByLabel("Destination", { exact: true });
  assert.equal(await field.inputValue(), "/destination");
  if (destination !== "/destination") await field.fill(destination);
  await button(copy, "Copy").click();
  await copy.waitFor({ state: "hidden" });
}

const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const sshSide of ["left", "right"]) {
    const localSide = sshSide === "left" ? "right" : "left";
    const page = await fixture(browser);
    const refreshKey = await page.evaluate(() => /Macintosh/.test(navigator.userAgent) ? "Meta+r" : "Control+r");
    await connect(page, sshSide);
    await page.evaluate(() => { window.sshFixture.hold = true; });
    await list(page, sshSide).press(refreshKey);
    await page.waitForFunction(() => typeof window.sshFixture.release === "function");
    await upload(page, localSide, "upload.txt");
    await page.getByText("Transfer complete", { exact: true }).waitFor();
    await page.evaluate(() => {
      window.sshFixture.requests = [];
      window.sshFixture.release();
    });
    await page.waitForFunction(() => window.sshFixture.requests.length > 0);
    await row(page, sshSide, "upload.txt").waitFor();
    assert.deepEqual(await page.evaluate(() => window.sshFixture.requests), [["ssh", 37, "/destination"]]);

    await upload(page, localSide, "another.txt", "/elsewhere");
    assert.equal(await page.locator(`#${sshSide}-path`).getAttribute("data-path"), "/destination");
    assert.equal(await row(page, sshSide, "another.txt").count(), 0);
    assert.equal(await page.evaluate(() => window.sshFixture.remote["/elsewhere"][0].name), "another.txt");

    await page.evaluate(() => { window.sshFixture.transfer = "fail"; });
    await upload(page, localSide, "rollback.txt");
    const stopped = page.getByRole("dialog", { name: "Transfer stopped", exact: true });
    await stopped.getByRole("alert").filter({ hasText: "The remaining upload failed." }).waitFor();
    await button(stopped, "Cancel").click();
    await row(page, sshSide, "already-committed.txt").waitFor();
    assert.equal(await row(page, sshSide, "rollback.txt").count(), 0);

    await page.evaluate(() => { window.sshFixture.transfer = "skip"; });
    await upload(page, localSide, "rollback.txt");
    const skipped = page.getByRole("dialog", { name: "Transfer complete", exact: true });
    await skipped.getByText("0 completed, 1 skipped.", { exact: true }).waitFor();
    await button(skipped, "Done").click();
    assert.equal(await row(page, sshSide, "rollback.txt").count(), 0);

    await page.evaluate(() => { window.sshFixture.transfer = "cancel"; });
    await upload(page, localSide, "rollback.txt");
    await page.waitForFunction(() => typeof window.sshFixture.cancelTransfer === "function");
    await button(page.getByRole("dialog", { name: "Copying…", exact: true }), "Cancel").click();
    const canceled = page.getByRole("dialog", { name: "Transfer canceled", exact: true });
    await canceled.getByText("0 completed.", { exact: true }).waitFor();
    await button(canceled, "Done").click();
    await row(page, sshSide, "committed-before-cancel.txt").waitFor();
    assert.equal(await row(page, sshSide, "rollback.txt").count(), 0);

    await page.evaluate(async () => {
      const state = window.sshFixture;
      state.requests = [];
      await state.write("/destination", "external.txt");
    });
    await list(page, sshSide).press(refreshKey);
    await row(page, sshSide, "external.txt").waitFor();
    assert.deepEqual(await page.evaluate(() => window.sshFixture.requests), [["ssh", 37, "/destination"]]);
    await page.evaluate(() => {
      const state = window.sshFixture;
      state.requests = [];
      state.local.push({ ...state.local[0], name: "local-external.txt" });
    });
    await list(page, localSide).press(refreshKey);
    await row(page, localSide, "local-external.txt").waitFor();
    assert.deepEqual(await page.evaluate(() => window.sshFixture.requests), [["local", await page.evaluate(() => window.sshFixture.root)]]);

    await page.evaluate(() => { window.sshFixture.fail = true; });
    await button(pane(page, sshSide), "Refresh folder").click();
    await pane(page, sshSide).getByRole("alert").filter({ hasText: "SSH fixture could not list the directory." }).waitFor();
    assert.equal(await page.locator(`#${sshSide}-path`).getAttribute("data-path"), "/destination");
    assert.equal(await row(page, sshSide, "upload.txt").count(), 1);

    const address = await editPaneAddress(page, sshSide);
    await address.fill("/elsewhere");
    await page.evaluate(() => Object.assign(window.sshFixture, { fail: false, transfer: "complete", hold: true, release: null }));
    await address.press("Enter");
    await page.waitForFunction(() => typeof window.sshFixture.release === "function");
    await upload(page, localSide, "rollback.txt");
    await page.getByText("Transfer complete", { exact: true }).waitFor();
    await page.evaluate(() => {
      window.sshFixture.requests = [];
      window.sshFixture.release();
    });
    await page.waitForFunction((side) => document.getElementById(`${side}-path`)?.dataset.path === "/elsewhere" &&
      document.getElementById(`${side}-files`)?.getAttribute("aria-busy") === "false" &&
      window.sshFixture.requests.some(([kind, id, path]) => kind === "ssh" && id === 37 && path === "/elsewhere"), sshSide);
    assert.equal(await row(page, sshSide, "rollback.txt").count(), 0);
    await page.close();
  }

  for (const refresh of [["Ctrl+Shift+R"], []]) {
    const page = await fixture(browser, refresh);
    await connect(page, "right");
    const modifier = await page.evaluate(() => /Macintosh/.test(navigator.userAgent) ? "Meta" : "Control");
    await page.evaluate(() => { window.sshFixture.requests = []; });
    await list(page, "right").press(`${modifier}+r`);
    assert.deepEqual(await page.evaluate(() => window.sshFixture.requests), []);
    if (refresh.length) {
      await list(page, "right").press(`${modifier}+Shift+r`);
      await page.waitForFunction(() => window.sshFixture.requests.some(([kind, id, path]) => kind === "ssh" && id === 37 && path === "/destination"));
    }
    await page.close();
  }
  console.log("Verified SSH uploads during listing and navigation, failures, skips, cancellation, pane refresh, and custom or disabled bindings.");
  if (process.env.DIRLUME_SFTP_TEST_PYTHON) console.log("Listings and writes used a live loopback SFTP connection.");
} finally {
  await browser.close();
}
