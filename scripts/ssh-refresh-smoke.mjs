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
      requests: [], listings: [], closedTerminals: [], connectAttempts: [], hold: false, fail: false, transfer: "complete",
    };
    const entriesFor = async (path) => window.sftpFixture
      ? (await window.sftpFixture("list", path)).map(entry) : remote[path].slice();
    state.write = async (path, name) => {
      if (window.sftpFixture) await window.sftpFixture("write", `${path}/${name}`);
      remote[path].push(entry(name));
    };
    state.remove = async (path, name) => {
      if (window.sftpFixture) await window.sftpFixture("remove", `${path}/${name}`);
      remote[path] = remote[path].filter((entry) => entry.name !== name);
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
        if (command === "ssh_profiles") return [
          { id: "ssh", label: "Remote fixture", host: "fixture", port: 22 },
          { id: "other", label: "Alternate fixture", host: "other.example", port: 2202 },
        ];
        if (command === "ftp_profiles") return [];
        if (command === "connect_ssh") {
          const other = args.id === "other";
          state.connection = other ? 38 : 37;
          state.connectAttempts.push(args.id);
          return { kind: "connected", id: state.connection,
            address: other ? "" : "Remote fixture", origin: other ? "sftp://other.example:2202" : "sftp://fixture",
            segments: ["destination"], listing: { entries: await entriesFor("/destination"), omitted: 0, elevated: false } };
        }
        if (command === "list_ssh") {
          const path = "/" + args.segments.join("/");
          state.listings.push([args.id, path]);
          if (args.reuseSudo) state.requests.push(["ssh", args.id, path]);
          if (args.id === state.offline || (args.id === 37 && path === state.lostPath)) {
            if (state.deferLoss) {
              state.deferLoss = false;
              await new Promise((done) => { state.releaseLoss = done; });
              state.lossReleased = true;
            }
            throw { sshCause: "connection_lost", message: "The SSH server could not be reached." };
          }
          if (args.id === 37 && state.pathError) throw new Error(state.pathError);
          if (state.fail) throw new Error("SSH fixture could not list the directory.");
          if (path === "/destination/locked") {
            if (args.sudoPassword !== "fixture-password") throw new Error("SSH permission denied.");
            return { entries: [{ ...entry("measured.txt"), size: 4 }], omitted: 0, elevated: true };
          }
          const listing = { entries: await entriesFor(path), omitted: 0, elevated: false };
          if (state.measureFixture && path === "/destination") {
            listing.entries.push({ ...entry("locked"), directory: true, size: null });
          }
          if (state.hold) {
            state.hold = false;
            await new Promise((resolve) => { state.release = resolve; });
          }
          return listing;
        }
        if (command === "open_terminal") {
          state.terminal = { id: args.request.id, connection: args.request.ssh?.connection, output: args.output };
          return false;
        }
        if (command === "close_terminal") {
          state.closedTerminals.push(args.id);
          return null;
        }
        if (command === "complete_ssh_command") {
          state.completion ??= [];
          state.completion.push(args);
          const prefix = args.line.split(" ").at(-1);
          const names = args.segments[0] === "elsewhere" ? ["compose elsewhere"] : ["container", "compose"];
          if (state.holdCompletion) {
            state.holdCompletion = false;
            await new Promise((resolve) => { state.releaseCompletion = resolve; });
          }
          return { index: args.caret - prefix.length, length: prefix.length,
            matches: names.map((label) => ({ label, text: label, directory: false })) };
        }
        if (command === "transfer_item") {
          if (args.request.source.kind === "ssh" && args.request.moving) {
            const { source, destination } = args.request;
            if (source.connection !== state.connection || destination !== state.root) throw new Error("The SSH move used the wrong path or connection.");
            const name = source.segments.at(-1);
            state.local.push(entry(name));
            await state.remove("/destination", name);
            return { kind: "completed" };
          }
          if (args.request.sshDestination !== state.connection) throw new Error("The upload used the wrong SSH connection.");
          const { destination, source, moving, retry } = args.request;
          state.transfers ??= [];
          state.transfers.push(args.request);
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
          if (state.transfer === "sudo") {
            await state.write(destination, "first-file.txt");
            const allowed = await new Promise((resolve) => {
              state.sudoRequest = { id: args.id, ticket: destination, resolve };
              args.output.onmessage({ kind: "sudo_required", ticket: destination,
                address: "fixture:22", path: destination + "/protected" });
            });
            if (!allowed) throw new Error("SSH permission denied.");
          }
          if (!moving || !retry) await state.write(destination, source.name);
          if (moving && state.transfer === "cleanup-failed") {
            return { kind: "source_retained", destination: "/destination/rollback.txt", source: state.root + "/rollback.txt", error: "Sharing violation." };
          }
          if (moving) state.local = state.local.filter(({ name }) => name !== source.name);
          return { kind: "completed" };
        }
        if (command === "authorize_transfer_sudo") {
          if (args.id !== state.sudoRequest?.id || args.ticket !== state.sudoRequest?.ticket) throw new Error("Unknown request.");
          if (args.password !== "fixture-password") throw new Error("The server rejected the sudo password.");
          state.sudoRequest.resolve(true);
          state.sudoRequest = null;
          return null;
        }
        if (command === "delete_ssh") {
          const path = "/" + args.request.segments.join("/");
          const allowed = await new Promise((resolve) => {
            state.sudoRequest = { id: args.job, ticket: path, resolve };
            args.output.onmessage({ kind: "sudo_required", ticket: path, address: "fixture:22", path });
          });
          if (!allowed) throw new Error("SSH permission denied.");
          await state.remove("/destination", args.request.segments.at(-1));
          return null;
        }
        if (command === "rename_ssh") {
          if (args.sudoPassword !== "fixture-password") throw new Error("SSH permission denied.");
          await state.remove("/destination", args.segments.at(-1));
          await state.write("/destination", args.name);
          return null;
        }
        if (command === "decline_transfer_sudo") {
          if (args.id === state.sudoRequest?.id && args.ticket === state.sudoRequest.ticket) {
            state.sudoRequest.resolve(false);
            state.sudoRequest = null;
          }
          return null;
        }
        if (command === "cancel_transfer") { state.cancelTransfer(); return null; }
        return null;
      },
    };
  }, refresh ?? null);
  await page.goto("http://dirlume.test/");
  return page;
}

async function connect(page, side, profile = "Remote fixture", source = "NetBox") {
  const panel = pane(page, side);
  await button(panel, `Locations for ${side} pane`).click();
  await button(panel, source).click();
  await list(page, side).getByRole("option", { name: new RegExp("^" + profile) }).dblclick();
  await row(page, side, "remote.txt").waitFor();
}

const waitPath = (page, side, path) => page.waitForFunction(({ side, path }) =>
  document.getElementById(side + "-path")?.dataset.path === path &&
  document.getElementById(side + "-files")?.getAttribute("aria-busy") === "false", { side, path });

async function startSshTerminal(page, side) {
  const former = await page.evaluate(() => window.sshFixture.terminal?.id ?? 0);
  await row(page, side, "remote.txt").click();
  await list(page, side).press("F12");
  await page.waitForFunction((previous) => window.sshFixture.terminal?.id > previous, former);
  return page.evaluate(() => window.sshFixture.terminal.id);
}

async function closeSshTerminal(page, event) {
  const id = await page.evaluate((event) => {
    const { terminal } = window.sshFixture;
    terminal.output.onmessage({ event });
    return terminal.id;
  }, event);
  await page.waitForFunction((id) => window.sshFixture.closedTerminals.includes(id), id);
}

async function verifyConnectionLoss(browser) {
  const page = await fixture(browser);
  try {
    await connect(page, "left", "Remote fixture", "NetBox");
    await connect(page, "right");
    await startSshTerminal(page, "right");
    await page.evaluate(() => { window.sshFixture.listings = []; });
    await closeSshTerminal(page, "closed");
    assert.deepEqual(await page.evaluate(() => window.sshFixture.listings), []);
    await waitPath(page, "right", "/destination");
    await button(page, "Close terminal").click();
    await waitPath(page, "left", "/destination");

    await startSshTerminal(page, "right");
    await closeSshTerminal(page, "disconnected");
    await page.waitForFunction(() => window.sshFixture.listings.some(([id]) => id === 37));
    await waitPath(page, "right", "/destination");
    await button(page, "Close terminal").click();

    await startSshTerminal(page, "right");
    await page.evaluate(() => { window.sshFixture.offline = 37; });
    await closeSshTerminal(page, "disconnected");
    await Promise.all([waitPath(page, "left", "NetBox"), waitPath(page, "right", "NetBox")]);
    for (const [side, source] of [["left", "NetBox"], ["right", "NetBox"]]) {
      const address = page.locator(`#${side}-path nav`);
      assert.equal(await address.locator("[aria-current=location]").innerText(), source);
      assert.equal(await address.locator(".address-forward, .address-overflow").count(), 0);
      assert.equal(await button(pane(page, side), "Parent folder").isDisabled(), true);
      assert.equal(await list(page, side).locator('[data-tooltip=".."]').count(), 0);
    }
    await page.getByRole("status").filter({ hasText: "SSH connection lost." }).waitFor();
    await page.evaluate(() => { window.sshFixture.offline = null; });
    await list(page, "left").press("Enter");
    await waitPath(page, "left", "/destination");
    await waitPath(page, "right", "NetBox");
    assert.deepEqual(await page.evaluate(() => window.sshFixture.connectAttempts), ["ssh", "ssh", "ssh"]);
  } finally { await page.close(); }

  const explicit = await fixture(browser);
  try {
    await connect(explicit, "left");
    await connect(explicit, "right", "Alternate fixture");
    for (const message of ["SSH permission denied.", "No such file."]) {
      await explicit.evaluate((error) => { window.sshFixture.pathError = error; }, message);
      await button(pane(explicit, "left"), "Refresh folder").click();
      await pane(explicit, "left").getByRole("alert").filter({ hasText: message }).waitFor();
      await waitPath(explicit, "left", "/destination");
    }
    await explicit.evaluate(() => { window.sshFixture.offline = 37; });
    await button(pane(explicit, "left"), "Refresh folder").click();
    await waitPath(explicit, "left", "NetBox");
    await waitPath(explicit, "right", "/destination");
    await explicit.evaluate(() => { window.sshFixture.offline = null; });
    await list(explicit, "left").press("Enter");
    await waitPath(explicit, "left", "/destination");
    const address = await editPaneAddress(explicit, "left");
    await address.fill("/elsewhere");
    await explicit.evaluate(() => { window.sshFixture.lostPath = "/elsewhere"; });
    await address.press("Enter");
    await waitPath(explicit, "left", "NetBox");
    await waitPath(explicit, "right", "/destination");
  } finally { await explicit.close(); }

  const delayed = await fixture(browser);
  try {
    await connect(delayed, "right");
    await startSshTerminal(delayed, "right");
    await delayed.evaluate(() => Object.assign(window.sshFixture, { offline: 37, deferLoss: true }));
    await closeSshTerminal(delayed, "disconnected");
    await delayed.waitForFunction(() => window.sshFixture.releaseLoss);
    await button(pane(delayed, "right"), "Locations for right pane").click();
    await button(pane(delayed, "right"), "Home").click();
    const home = await delayed.evaluate(() => window.sshFixture.root);
    await waitPath(delayed, "right", home);
    await delayed.evaluate(() => window.sshFixture.releaseLoss());
    await delayed.waitForFunction(() => window.sshFixture.lossReleased);
    await waitPath(delayed, "right", home);
    assert.equal(await delayed.getByRole("status").filter({ hasText: "SSH connection lost." }).count(), 0);
  } finally { await delayed.close(); }
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
  await verifyConnectionLoss(browser);
  console.log("Verified SSH connection loss, normal terminal exit, catalog routing, reconnection, listing errors, and stale probes.");
  {
    const page = await fixture(browser);
    await connect(page, "right");
    const input = page.getByRole("combobox", { name: "Command line", exact: true });
    const choices = page.getByRole("listbox", { name: "Command suggestions", exact: true });
    // The pane returns focus on a frame after its listing has been rendered.
    const finishPaneFocus = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await finishPaneFocus();
    await input.fill("docker co");
    await choices.getByRole("option", { name: "container", exact: true }).waitFor();
    assert.equal(await page.locator(".terminal-card:visible").count(), 0);
    assert.deepEqual(await page.evaluate(() => window.sshFixture.completion.at(-1)),
      { id: 37, segments: ["destination"], line: "docker co", caret: 9 });
    await page.evaluate(() => { window.sshFixture.holdCompletion = true; });
    await input.fill("docker con");
    await page.waitForFunction(() => window.sshFixture.releaseCompletion);
    const address = await editPaneAddress(page, "right");
    await address.fill("/elsewhere");
    await address.press("Enter");
    await waitPath(page, "right", "/elsewhere");
    await finishPaneFocus();
    await input.fill("docker co");
    await choices.getByRole("option", { name: "compose elsewhere", exact: true }).waitFor();
    await page.evaluate(() => window.sshFixture.releaseCompletion());
    assert.equal(await choices.getByRole("option", { name: "container", exact: true }).count(), 0);
    await page.close();
  }
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

  for (const sshSide of ["left", "right"]) {
    const localSide = sshSide === "left" ? "right" : "left";
    const other = sshSide === "left";
    const page = await fixture(browser);
    await connect(page, sshSide, other ? "Alternate fixture" : undefined);
    const identity = other ? "SFTP · other.example:2202" : "SFTP · Remote fixture";
    await row(page, localSide, "rollback.txt").click();
    await page.keyboard.press("F5");
    const copy = page.getByRole("dialog", { name: "Copy", exact: true });
    await copy.getByText(identity, { exact: true }).waitFor();
    await button(copy, "Cancel").click();
    await page.evaluate(() => { window.sshFixture.transfer = "cleanup-failed"; });
    await list(page, localSide).press("F6");
    const move = page.getByRole("dialog", { name: "Rename or move", exact: true });
    const field = move.getByLabel("Destination", { exact: true });
    assert.equal(await field.inputValue(), "/destination");
    await move.getByText(identity, { exact: true }).waitFor();
    await button(move, "Move").click();
    const stopped = page.getByRole("dialog", { name: "Transfer stopped", exact: true });
    await stopped.getByRole("alert").filter({ hasText: "Uploaded to /destination/rollback.txt" }).waitFor();
    await row(page, sshSide, "rollback.txt").waitFor();
    assert.equal(await row(page, localSide, "rollback.txt").count(), 1);
    await page.evaluate(() => { window.sshFixture.transfer = "complete"; });
    await button(stopped, "Retry").click();
    await row(page, localSide, "rollback.txt").waitFor({ state: "detached" });
    assert.equal(await row(page, sshSide, "rollback.txt").count(), 1);
    assert.deepEqual(await page.evaluate(() => window.sshFixture.transfers.map(({ moving, retry, sshDestination }) =>
      [moving, retry, sshDestination])), [[true, false, other ? 38 : 37], [true, true, other ? 38 : 37]]);
    await row(page, localSide, "upload.txt").click();
    await page.keyboard.press("F6");
    await field.fill("/elsewhere");
    await button(move, "Move").click();
    await row(page, localSide, "upload.txt").waitFor({ state: "detached" });
    const edited = await page.evaluate(() => window.sshFixture.transfers.at(-1));
    assert.equal(edited.sshDestination, other ? 38 : 37);
    assert.equal(edited.destination, "/elsewhere");
    assert.equal(await row(page, sshSide, "upload.txt").count(), 0);
    await page.close();
  }

  for (const refresh of [["Ctrl+Shift+F9"], []]) {
    const page = await fixture(browser, refresh);
    await connect(page, "right");
    const modifier = await page.evaluate(() => /Macintosh/.test(navigator.userAgent) ? "Meta" : "Control");
    await page.evaluate(() => { window.sshFixture.requests = []; });
    await list(page, "right").press(`${modifier}+r`);
    assert.deepEqual(await page.evaluate(() => window.sshFixture.requests), []);
    if (refresh.length) {
      await list(page, "right").press("Control+Shift+F9");
      await page.waitForFunction(() => window.sshFixture.requests.some(([kind, id, path]) => kind === "ssh" && id === 37 && path === "/destination"));
    }
    await page.close();
  }
  const sudoPage = await fixture(browser);
  await connect(sudoPage, "right");
  await sudoPage.evaluate(() => { window.sshFixture.transfer = "sudo"; });
  await upload(sudoPage, "left", "upload.txt");
  const permissions = sudoPage.getByRole("dialog", { name: "SSH permissions", exact: true });
  await permissions.getByText("/destination/protected", { exact: true }).waitFor();
  await permissions.getByText("fixture:22", { exact: true }).waitFor();
  const password = permissions.getByLabel("Sudo password", { exact: true });
  await password.fill("wrong-fixture-password");
  await button(permissions, "Continue with sudo").click();
  await permissions.getByRole("alert").filter({ hasText: "The server rejected the sudo password." }).waitFor();
  assert.equal(await password.inputValue(), "");
  await password.fill("fixture-password");
  await button(permissions, "Continue with sudo").click();
  await row(sudoPage, "right", "upload.txt").waitFor();
  assert.equal(await row(sudoPage, "right", "first-file.txt").count(), 1);
  assert.equal(await sudoPage.evaluate(() => window.sshFixture.transfers.length), 1);
  await row(sudoPage, "right", "upload.txt").click();
  await list(sudoPage, "right").press("Shift+Delete");
  const deletion = sudoPage.getByRole("dialog", { name: "Delete permanently", exact: true });
  await button(deletion, "Delete permanently").click();
  await permissions.getByText("/destination/upload.txt", { exact: true }).waitFor();
  await button(permissions, "Cancel").click();
  await deletion.waitFor({ state: "hidden" });
  assert.equal(await row(sudoPage, "right", "upload.txt").count(), 1);
  await row(sudoPage, "right", "upload.txt").click();
  await list(sudoPage, "right").press("Shift+Delete");
  await button(deletion, "Delete permanently").click();
  await password.fill("fixture-password");
  await button(permissions, "Continue with sudo").click();
  await row(sudoPage, "right", "upload.txt").waitFor({ state: "detached" });
  await row(sudoPage, "right", "first-file.txt").click();
  await list(sudoPage, "right").press("F2");
  const rename = sudoPage.getByRole("dialog", { name: "Rename", exact: true });
  await rename.getByLabel("Name", { exact: true }).fill("renamed.txt");
  await button(rename, "Rename").click();
  await permissions.getByText("/destination/first-file.txt", { exact: true }).waitFor();
  await password.fill("fixture-password");
  await button(permissions, "Continue with sudo").click();
  await row(sudoPage, "right", "renamed.txt").waitFor();
  await sudoPage.evaluate(() => { window.sshFixture.measureFixture = true; });
  await button(pane(sudoPage, "right"), "Refresh folder").click();
  await row(sudoPage, "right", "locked").click();
  await list(sudoPage, "right").press("F3");
  await permissions.getByText("/destination/locked", { exact: true }).waitFor();
  await password.fill("fixture-password");
  await button(permissions, "Continue with sudo").click();
  await permissions.waitFor({ state: "hidden" });
  await list(sudoPage, "right").getByText("4 B", { exact: true }).last().waitFor();
  await row(sudoPage, "right", "renamed.txt").click();
  await list(sudoPage, "right").press("F6");
  const downloadMove = sudoPage.getByRole("dialog", { name: "Rename or move", exact: true });
  await button(downloadMove, "Move").click();
  await row(sudoPage, "left", "renamed.txt").waitFor();
  await row(sudoPage, "right", "renamed.txt").waitFor({ state: "detached" });
  await sudoPage.close();
  console.log("Verified SSH uploads during listing and navigation, failures, skips, cancellation, pane refresh, and custom or disabled bindings.");
  console.log("Verified SFTP connection identity, local-to-remote move, editable paths, and cleanup retry in both pane positions.");
  if (process.env.DIRLUME_SFTP_TEST_PYTHON) console.log("Listings and writes used a live loopback SFTP connection.");
} finally {
  await browser.close();
}
