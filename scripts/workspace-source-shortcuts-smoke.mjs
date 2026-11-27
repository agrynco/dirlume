import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { openMainMenu } from "./menu-header-smoke.mjs";

const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const [client, userAgent] of [
    ["Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"],
    ["Ubuntu", "Mozilla/5.0 (X11; Linux x86_64)"],
    ["macOS", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"],
  ]) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 760 }, userAgent });
    page.setDefaultTimeout(5000);
    await page.route("http://dirlume.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    const windows = client === "Windows";
    if (windows) await page.clock.install();
    const home = windows ? "C:\\fixture" : "/fixture";
    const bookmark = home + (windows ? "\\bookmarked" : "/bookmarked");
    const downloads = home + (windows ? "\\downloads" : "/downloads");
    await page.addInitScript(({ home, bookmark, downloads, windows }) => {
      localStorage.removeItem("dirlume.workspace.v1");
      const groups = Array.from({ length: 10 }, () => []);
      groups[8] = [{ title: "Bookmark", path: bookmark }];
      groups[9] = [...groups[8], { title: "Downloads folder", path: downloads }];
      localStorage.setItem("dirlume.folder-shortcuts.v1", JSON.stringify(groups));
      localStorage.setItem("dirlume.remote-connections", JSON.stringify([
        { id: "pair", kind: "server", label: "Dirlume test PC", credential: "fixture-credential", lan: true },
      ]));
      const file = { name: "note.txt", directory: false, link: false, hidden: false, size: 4, modified: null };
      const listing = { entries: [file], omitted: 0 };
      const gib = 1024 ** 3;
      const drive = (name, total, available) => ({ name, total: total == null ? null : total * gib, available: available == null ? null : available * gib });
      const pairedDrives = () => [drive("Files", 200, window.fixtureFree ?? 50), drive("Full disk", 100, 0), drive("Older disk", null, null)];
      const remoteListing = (segments) => segments.length === 1
        ? { ...listing, entries: [{ ...file, name: "nested", directory: true }, file] } : listing;
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => 1,
        invoke: async (command, args = {}) => {
          switch (command) {
            case "locations": return [{ label: "Home", path: home }, { label: "Downloads", path: downloads }];
            case "list_directory": return { path: args.path, parent: null, ...listing };
            case "disk_space": return { total: 10 * gib, available: 4 * gib };
            case "list_processes": return [];
            case "read_text": return { text: "Test", encoding: "utf8" };
            case "scan_local_space":
              args.output.onmessage({ kind: "start", strategy: "walk" });
              args.output.onmessage({ kind: "batch", changes: [
                { parent: 0, name: file.name, directory: false, size: file.size, allocated: 8, shared: false },
                { closed: 0, partial: false, error: null },
              ] });
              args.output.onmessage({ kind: "finished" });
              return;
            case "git_repository": return { root: home, name: "Fixture", headRef: null, head: null, branches: [] };
            case "git_history": return { commits: [], nextOffset: null };
            case "ftp_profiles": return [{ id: "ftp", label: "FTP fixture", host: "fixture", port: 21 }];
            case "ssh_profiles": return [{ id: "ssh", label: "SSH creation fixture", host: "fixture", port: 22 }];
            case "connect_ftp": return { id: 1, address: "fixture", origin: "ftp://fixture", segments: ["nested"], listing };
            case "list_ftp": return listing;
            case "connect_ssh": return { kind: "connected", id: 9, address: "fixture", origin: "sftp://fixture",
              segments: ["nested"], listing };
            case "list_ssh": return { ...listing, elevated: false };
            case "read_ftp_text":
            case "read_ssh_text": return { text: "", encoding: "utf8", revision: "fixture" };
            case "create_ftp_folder":
            case "create_ftp_text_file":
            case "create_ssh_folder":
            case "create_ssh_text_file":
              (window.remoteCreates ??= []).push({ command, segments: args.segments, encoding: args.encoding,
                elevated: args.sudoPassword !== undefined });
              if (command.startsWith("create_ssh") && args.sudoPassword === undefined) throw "SSH permission denied.";
              return null;
            case "computer_name": return "This test PC";
            case "active_lan_group": return Boolean(window.fixtureLanGroup);
            case "lan_group_writable": return Boolean(window.fixtureGroupWritable);
            case "set_lan_group_writable": window.fixtureGroupWritable = args.writable; return null;
            case "start_lan_group": window.fixtureLanGroup = args.code ?? "generated"; return null;
            case "copy_lan_group_code": return null;
            case "leave_lan_group": window.fixtureLanGroup = null; return null;
            case "list_lan_group_peers": return window.fixtureLanGroup ?
              [{ id: "group-peer", name: "Group test PC", online: true }] : [];
            case "list_lan_group_drives": return pairedDrives();
            case "connect_lan_group_peer":
              window.groupTarget = { peer: args.peer, segments: args.segments };
              return { id: 10, address: "fixture", origin: "https://fixture", share: "group", listing: remoteListing(args.segments) };
            case "change_lan_item":
              if (!window.fixturePeerAllowsCreate) throw "The remote computer allows read access only.";
              window.lastLanChange = args;
              return null;
            case "read_server_text": return { text: "", encoding: "utf8", revision: "remote-start" };
            case "save_lan_text": window.savedLanText = args; return "remote-saved";
            case "verify_computer_pairing": return "Name from the remote host";
            case "save_server_invitation": return "new-fixture-credential";
            case "list_saved_computer_drives": return pairedDrives();
            case "connect_saved_server":
              window.dirlumeDrive = args.segments;
              return { id: 8, address: "fixture", origin: "https://fixture", share: "fixture", listing: remoteListing(args.segments) };
            case "list_server": return remoteListing(args.segments);
            case "transfer_item":
              window.lastTransfer = args.request;
              return { kind: "completed" };
            case "prepare_collection_folders":
              window.collectionFolders = args;
              return null;
            case "list_connected_computer_drives":
              if (window.deferCapacity) {
                window.deferCapacity = false;
                return new Promise((resolve) => { window.finishCapacity = () => resolve([drive("Files", 800, 700)]); });
              }
              return pairedDrives();
            case "kswitcher_peers":
              if (window.kswitcherAuthorizationDenied) {
                throw "Authorize this executable in KSwitcher → Computers → Trusted clients.";
              }
              return windows ? [
                { id: "online", name: "KSwitcher PC", online: true },
                { id: "offline", name: "Offline KSwitcher PC", online: false },
              ] : [];
            case "list_kswitcher":
              if (args.peer === "offline") throw new Error("An offline peer must not be queried.");
              if (args.path === "") return { ...listing, entries: [], parent: null,
                drives: [{ name: "C:", type: 3, total: 1024 ** 3, available: 256 * 1024 ** 2 }] };
              window.kswitcherDrive = args.path;
              window.kswitcherListings = (window.kswitcherListings ?? 0) + 1;
              if (window.kswitcherFailure) throw window.kswitcherFailure;
              return { ...(window.collectionKSwitcher ? remoteListing(["drive"]) : listing), parent: "" };
            case "report_diagnostic":
              if (args.operation === "list_kswitcher") (window.kswitcherDiagnostics ??= []).push(args);
              return null;
            case "file_icons": return args.items.map(() => null);
            default: return null;
          }
        },
      };
    }, { home, bookmark, downloads, windows });

    const button = (scope, name) => scope.getByRole("button", { name, exact: true });
    const files = (side) => page.locator(`#${side}-files`);
    const pane = (side) => page.getByRole("region", { name: `${side} pane`, exact: true });
    const sources = (side) => page.getByRole("group", { name: `${side === "left" ? "Left" : "Right"} pane sources`, exact: true });
    const opposite = (side) => side === "left" ? "right" : "left";
    const sourceKey = (side) => side === "left" ? "Alt+F1" : "Alt+F2";
    const initialPath = (side) => side === "left" ? home : downloads;
    const folderPicker = page.getByRole("dialog", { name: "Folder shortcuts", exact: true });
    async function pressBookmark(digit) {
      await page.keyboard.down("ControlRight");
      try { await page.keyboard.press(`Digit${digit}`); }
      finally { await page.keyboard.up("ControlRight"); }
    }
    async function waitForPath(side, path) {
      await page.waitForFunction(({ side, path }) => document.getElementById(`${side}-path`)?.dataset.path === path &&
        document.getElementById(`${side}-files`)?.getAttribute("aria-busy") === "false", { side, path });
    }
    await page.goto("http://dirlume.test/");
    await waitForPath("left", home);
    assert.equal(await button(page.locator(".topbar"), "Connect").count(), 0);
    async function openPairedDrive(drive) {
      await files("left").press("Alt+F1");
      const lan = sources("left").getByRole("group", { name: "Dirlume LAN", exact: true });
      await lan.getByRole("group", { name: "Dirlume test PC", exact: true }).getByRole("button", { name: new RegExp(`^${drive}`) }).click();
      await page.waitForFunction((name) => window.dirlumeDrive?.[0] === name, drive);
    }
    const control = button(pane("left"), "Analyze space");
    const tooltip = page.getByRole("tooltip");
    const detail = "50 GiB free of 200 GiB, 150 GiB used";
    await openPairedDrive("Files");
    await control.getByText("50 GiB free of 200 GiB", { exact: true }).waitFor();
    assert.equal(await control.locator(".space-meter > span").evaluate((meter) => meter.style.width), "75%");
    await button(pane("right"), "Analyze space").getByText("4 GiB free of 10 GiB", { exact: true }).waitFor();
    await control.hover();
    await tooltip.getByText(detail, { exact: true }).waitFor();
    await page.mouse.move(0, 0);
    await tooltip.waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 650, height: 680 });
    await control.getByText("50 GiB free of 200 GiB", { exact: true }).waitFor({ state: "hidden" });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const scope = pane("left").locator('summary[aria-label="Analysis scope"]');
    await scope.focus();
    await page.keyboard.press("Shift+Tab");
    assert.equal(await control.evaluate((node) => node === document.activeElement), true);
    await control.evaluate((node) => node.dispatchEvent(new Event("scroll")));
    await tooltip.getByText(detail, { exact: true }).waitFor();
    await page.setViewportSize({ width: 1400, height: 760 });
    await files("left").getByRole("option", { name: /^nested/ }).dblclick();
    await files("left").getByRole("option", { name: /^note\.txt/ }).waitFor();
    await control.getByText("50 GiB free of 200 GiB", { exact: true }).waitFor();
    await page.evaluate(() => { window.fixtureFree = 40; });
    const refresh = button(pane("left"), "Refresh folder");
    await refresh.click();
    await control.getByText("40 GiB free of 200 GiB", { exact: true }).waitFor();
    await page.evaluate(() => { window.deferCapacity = true; });
    await refresh.click();
    await page.waitForFunction(() => typeof window.finishCapacity === "function");
    await openPairedDrive("Full disk");
    await files("left").getByRole("option", { name: /^nested/ }).click();
    await files("left").press("F5");
    const copyFolder = page.getByRole("dialog", { name: "Copy", exact: true });
    assert.equal(await copyFolder.getByRole("combobox", { name: "Destination", exact: true }).inputValue(), downloads);
    await button(copyFolder, "Copy").click();
    await page.waitForFunction(() => window.lastTransfer);
    assert.deepEqual(await page.evaluate(() => window.lastTransfer.source), {
      kind: "server", connection: 8, segments: ["Full disk", "nested"], folder: true,
    });
    await copyFolder.waitFor({ state: "hidden" });
    await control.getByText("0 B free of 100 GiB", { exact: true }).waitFor();
    await page.evaluate(() => window.finishCapacity());
    assert.equal(await control.getAttribute("aria-description"), "0 B free of 100 GiB, 100 GiB used");
    await openPairedDrive("Older disk");
    await control.getByText("Analyze space", { exact: true }).waitFor();
    assert.equal(await control.isEnabled(), true);
    if (windows) {
      await page.evaluate(() => { window.kswitcherAuthorizationDenied = true; });
      await files("right").press("Alt+F2");
      const kswitcher = sources("right").getByRole("group", { name: "KSwitcher LAN", exact: true });
      await kswitcher.getByRole("status").filter({ hasText: "To browse KSwitcher computers" }).waitFor();
      const direct = sources("right").getByRole("group", { name: "Dirlume LAN", exact: true });
      await direct.getByRole("group", { name: "Dirlume test PC", exact: true }).getByRole("button", { name: /^Full disk/ }).waitFor();
      assert.equal(await direct.getByText(/Trusted clients/).count(), 0);
      await page.keyboard.press("Escape");
      await page.evaluate(() => { window.kswitcherAuthorizationDenied = false; });
      await files("right").press("Alt+F2");
      const lan = sources("right").getByRole("group", { name: "KSwitcher LAN", exact: true });
      await lan.getByRole("group", { name: "Offline KSwitcher PC", exact: true }).getByText("Offline", { exact: true }).waitFor();
      await lan.getByRole("group", { name: "KSwitcher PC", exact: true }).getByRole("button", { name: /^C:.*Fixed/ }).click();
      await page.waitForFunction(() => window.kswitcherDrive === "C:\\");
      await files("right").getByRole("option", { name: /^note\.txt/ }).waitFor();
      await button(pane("right"), "Analyze space").getByText("256 MiB free of 1 GiB", { exact: true }).waitFor();
      const rightPane = pane("right");
      const alert = rightPane.getByRole("alert");
      const refreshRight = button(rightPane, "Refresh folder");
      const peerUnavailable = "The paired computer is offline or file browsing is unavailable.";
      const serviceStopped = "Start KSwitcher with support for trusted LAN clients.";
      const setFailure = (message) => page.evaluate((message) => {
        window.isTauri = true;
        window.kswitcherFailure = message;
        return window.kswitcherListings;
      }, message);
      const diagnostics = () => page.evaluate(() => window.kswitcherDiagnostics ?? []);

      for (const message of [peerUnavailable, serviceStopped]) {
        const before = await setFailure(message);
        await page.clock.runFor(16000);
        const refreshed = await page.evaluate(() => window.kswitcherListings);
        assert.ok(refreshed >= before + 3, `Expected three background refreshes, received ${refreshed - before}.`);
        assert.ok((await alert.textContent({ timeout: 1200 }).catch(() => ""))?.startsWith(message),
          `Expected the background refresh to show: ${message}\n${await page.locator("body").innerText()}`);
        assert.equal((await diagnostics()).length, 0);
        await refreshRight.click();
        await alert.filter({ hasText: message }).waitFor();
        assert.equal((await diagnostics()).length, 0);
        await setFailure(null);
        await page.clock.runFor(5200);
        await alert.waitFor({ state: "hidden", timeout: 7000 });
        await files("right").getByRole("option", { name: /^note\.txt/ }).waitFor();
      }

      for (const [message, code] of [
        ["Authorize this executable in KSwitcher → Computers → Trusted clients.", "permission_denied"],
        ["Invalid KSwitcher drive listing.", "native_error"],
      ]) {
        await setFailure(message);
        await refreshRight.click();
        await alert.filter({ hasText: message }).waitFor();
        const reports = await diagnostics();
        assert.equal(reports.at(-1)?.code, code);
        assert.equal(reports.at(-1)?.detail, undefined);
        assert.equal(reports.at(-1)?.peer, undefined);
        assert.equal(reports.at(-1)?.path, undefined);
      }
      await setFailure(null);
      await refreshRight.click();
      await alert.waitFor({ state: "hidden" });
      await page.evaluate(() => { window.isTauri = false; });
    }
    await page.setViewportSize({ width: 1100, height: 760 });
    await button(page, "Options").click();
    const options = page.getByRole("dialog", { name: "Options", exact: true });
    await button(options, "Computers").click();
    await options.getByRole("heading", { name: "Computers", exact: true }).waitFor();
    await options.getByText("This test PC", { exact: true }).waitFor();
    await options.getByText("Dirlume test PC", { exact: true }).waitFor();
    await options.getByText("Legacy pairing codes", { exact: true }).click();
    assert.equal(await options.getByLabel("Computer name", { exact: true }).count(), 0);
    await options.getByLabel("Pairing code", { exact: true }).fill("test-invitation");
    await button(options, "Pair computer").click();
    await options.getByText("Name from the remote host", { exact: true }).waitFor();
    const group = options.getByRole("group", { name: "Dirlume LAN group", exact: true });
    await group.getByLabel("Group code", { exact: true }).fill("same-fixture-code");
    await button(group, "Join group").click();
    await group.getByLabel("Allow group members to change files and folders", { exact: true }).check();
    await page.waitForFunction(() => window.fixtureGroupWritable === true);
    await button(group, "Copy group code").click();
    await group.getByText("Group code copied. Paste the same code on each computer.", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.fixtureLanGroup), "same-fixture-code");
    await button(options, "Done").click();
    await files("left").press("Alt+F1");
    const groupPeer = sources("left").getByRole("group", { name: "Group test PC", exact: true });
    await groupPeer.getByRole("button", { name: /^Files/ }).click();
    await waitForPath("left", "/Files");
    assert.deepEqual(await page.evaluate(() => window.groupTarget), { peer: "group-peer", segments: ["Files"] });
    await files("left").press("F7");
    const lanMkdir = page.getByRole("dialog", { name: "New folder", exact: true });
    await lanMkdir.getByRole("textbox", { name: "Name", exact: true }).fill("Projects");
    await button(lanMkdir, "Create").click();
    await lanMkdir.getByRole("alert").filter({ hasText: "The remote computer allows read access only." }).waitFor();
    await page.evaluate(() => { window.fixturePeerAllowsCreate = true; });
    await button(lanMkdir, "Create").click();
    await lanMkdir.waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.lastLanChange.segments), ["Files", "Projects"]);
    await button(pane("left"), "Tree").click();
    const lanBranch = files("left").getByRole("treeitem", { name: /^nested/ });
    await lanBranch.click();
    await files("left").press("F7");
    await lanMkdir.getByRole("textbox", { name: "Name", exact: true }).fill("Child");
    await button(lanMkdir, "Create").click();
    await lanMkdir.waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.lastLanChange.segments), ["Files", "nested", "Child"]);
    await lanBranch.click();
    await files("left").press("Shift+F4");
    const lanNewFile = page.getByRole("dialog", { name: "New file", exact: true });
    await lanNewFile.getByRole("textbox", { name: "Name", exact: true }).fill("draft.txt");
    await button(lanNewFile, "Create").click();
    const lanEditor = page.getByRole("region", { name: "draft.txt", exact: true });
    const lanContent = lanEditor.locator(".cm-content");
    await lanContent.fill("Updated from the other computer.");
    await lanContent.press(client === "macOS" ? "Meta+s" : "Control+s");
    await page.waitForFunction(() => window.savedLanText);
    assert.deepEqual(await page.evaluate(() => window.savedLanText), {
      id: 10, segments: ["Files", "nested", "draft.txt"], revision: "remote-start", text: "Updated from the other computer.",
    });
    await button(lanEditor, "Close document").click();
    const lanChild = files("left").getByRole("treeitem", { level: 2, name: /note\.txt/ });
    await lanChild.click();
    await files("left").press("F2");
    const lanRename = page.getByRole("dialog", { name: "Rename", exact: true });
    await lanRename.getByRole("textbox", { name: "Name", exact: true }).fill("renamed.txt");
    await button(lanRename, "Rename").click();
    await lanRename.waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.lastLanChange), {
      id: 10, segments: ["Files", "nested", "note.txt"], change: { kind: "rename", name: "renamed.txt" },
    });
    await lanChild.click();
    await files("left").press("Shift+Delete");
    const lanDelete = page.getByRole("dialog", { name: "Delete permanently", exact: true });
    await button(lanDelete, "Delete permanently").click();
    await lanDelete.waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.lastLanChange), {
      id: 10, segments: ["Files", "nested", "note.txt"], change: { kind: "delete", recursive: false },
    });
    await button(pane("left"), "List").click();
    await button(page, "Options").click();
    await button(options, "Computers").click();
    await button(group, "Leave group").click();
    await group.getByLabel("Group code", { exact: true }).waitFor();
    await button(options, "Done").click();

    async function enter(view, side) {
      await page.goto("http://dirlume.test/");
      await waitForPath(side, initialPath(side));
      await files(side).getByRole("option", { name: /^note\.txt/ }).click();
      if (view === "Local files") return files(side);
      if (view === "Search results") {
        await button(page, "Find files").click();
        const search = page.getByRole("dialog", { name: "Find files", exact: true });
        await button(search, "Search").click();
        await button(search, "Show in panel").click();
        await pane(side).getByRole("heading", { name: view, exact: true }).waitFor();
        return files(side);
      }
      if (view === "Environment variables") {
        const commands = await openMainMenu(page, "Commands");
        await commands.getByRole("menuitemradio", { name: view, exact: true }).click();
        return button(page.locator(`.environment-${side}`), "Back to files");
      }
      if (view === "Git View") {
        await button(page, view).click();
        return page.getByRole("searchbox", { name: "Filter branches", exact: true });
      }
      if (view === "Space Analyzer") {
        await button(pane(side), "Analyze space").click();
        const analyzer = page.locator(`.space-analyzer-${side}`);
        const tree = analyzer.getByRole("treegrid", { name: "Space usage", exact: true });
        await tree.waitFor();
        // The Windows fixture uses an installed clock for the connection-expiry tests.
        if (windows) await page.clock.runFor(32);
        await page.waitForFunction((node) => document.activeElement === node, await tree.elementHandle());
        return button(analyzer, "Treemap");
      }
      if (view === "Quick View") {
        await files(opposite(side)).getByRole("option", { name: /^note\.txt/ }).click();
        await button(page, view).click();
        return page.locator(`.quick-view-${side} .text-view`);
      }
      await page.keyboard.press(sourceKey(side));
      if (view === "Processes") {
        assert.equal(await button(sources(side), "Processes").locator("kbd").textContent(), "0");
        await page.keyboard.press("Digit0");
        await pane(side).getByRole("grid", { name: "Running processes", exact: true }).waitFor();
      } else {
        await button(sources(side), "NetBox").click();
      }
      if (view === "Remote files") await files(side).getByRole("option", { name: /^FTP fixture/ }).dblclick();
      return files(side);
    }

    for (const side of ["left", "right"]) {
      for (const view of ["Local files", "Remote files", "Connections", "Search results", "Processes",
        "Quick View", "Space Analyzer", "Environment variables", "Git View"]) {
        const origin = await enter(view, side);
        await origin.focus();
        for (const target of [side, opposite(side)]) {
          await page.keyboard.press(sourceKey(target));
          await sources(target).waitFor();
          const heading = target === "left" ? "Left pane sources" : "Right pane sources";
          await page.waitForFunction((label) => [...document.querySelectorAll(".location-popup")].some((menu) =>
            menu.getAttribute("aria-label") === label && menu.contains(document.activeElement)), heading).catch(async (error) => {
            const focused = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
            throw new Error(`${client} ${side} ${view} to ${target} sources left focus on ${focused}`, { cause: error });
          });
          await page.keyboard.press("Escape");
          await sources(target).waitFor({ state: "hidden" });
          if (windows) await page.clock.runFor(32);
          await page.waitForFunction((node) => node === document.activeElement, await origin.elementHandle()).catch(async (error) => {
            const focused = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
            throw new Error(`${client} ${side} ${view} after closing ${target} sources left focus on ${focused}`, { cause: error });
          });
        }
        await pressBookmark(0);
        await page.getByText("No folder shortcuts in group 0.", { exact: true }).waitFor();
        await pressBookmark(9);
        await folderPicker.getByRole("option", { name: /^Downloads folder/ }).waitFor();
        await page.keyboard.press("Escape");
        await folderPicker.waitFor({ state: "hidden" });
        await origin.focus();
        await pressBookmark(8);
        await waitForPath(side, bookmark);
        assert.equal(await page.locator(`#${opposite(side)}-path`).getAttribute("data-path"), initialPath(opposite(side)));
      }
      const preview = await enter("Quick View", side);
      await preview.focus();
      await page.keyboard.press(sourceKey(side));
      await button(sources(side), side === "left" ? "Downloads" : "Home").click();
      await waitForPath(side, initialPath(opposite(side)));
      await page.locator(`.quick-view-${side}`).waitFor({ state: "hidden" });
      assert.equal(await page.locator(`#${opposite(side)}-path`).getAttribute("data-path"), initialPath(opposite(side)));
    }
    // Open a populated group and keep the selection while scaling its shared dialog font.
    await enter("Local files", "left");
    await pressBookmark(9);
    const initialSize = await folderPicker.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
    const picker = folderPicker.getByRole("listbox");
    const selection = await picker.getAttribute("aria-activedescendant");
    await picker.dispatchEvent("wheel", { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true });
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--font-zoom-dialog") !== "");
    assert.equal(await folderPicker.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)), initialSize + 1);
    assert.equal(await picker.getAttribute("aria-activedescendant"), selection);
    assert.ok(await picker.evaluate((node) => document.activeElement === node));
    await picker.press("Escape");
    await folderPicker.waitFor({ state: "hidden" });
    await pressBookmark(9);
    assert.equal(await folderPicker.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)), initialSize + 1);
    await picker.press("Escape");
    await folderPicker.waitFor({ state: "hidden" });
    const mainFont = page.locator(".topbar");
    await mainFont.dispatchEvent("wheel", { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true });
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--font-zoom-ui") !== "");
    for (const { saved, expected, version } of [
      { saved: ["1"], expected: "0", version: 9 },
      { saved: "1", expected: "0", version: 9 },
      { saved: ["6"], expected: "6", version: 9 },
      { saved: [], expected: "", version: 9 },
      { saved: ["1"], expected: "1", version: 10 },
    ]) {
      await page.evaluate(({ saved, version }) => {
        localStorage.setItem("dirlume.preferences.v1", JSON.stringify({ bindingDefaults: version, activeShortcutScheme: "fixture",
          shortcutSchemes: [{ id: "fixture", name: "Fixture", bindings: { processSources: saved, imageFit: ["0"] } }] }));
      }, { saved, version });
      await enter("Local files", "left");
      await page.keyboard.press(sourceKey("left"));
      const processes = button(sources("left"), "Processes").locator("kbd");
      if (expected) {
        assert.equal(await processes.textContent(), expected);
        await page.keyboard.press(`Digit${expected}`);
        await pane("left").getByRole("grid", { name: "Running processes", exact: true }).waitFor();
      } else {
        assert.equal(await processes.count(), 0);
        await page.keyboard.press("Digit0");
        assert.equal(await sources("left").isVisible(), true);
      }
    }
    for (const [profile, provider] of [[/^FTP fixture/, "ftp"], [/^SSH creation fixture/, "ssh"]]) {
      await page.setViewportSize({ width: 1400, height: 760 });
      await files("left").press("Alt+F1");
      await button(sources("left"), "NetBox").click();
      await files("left").getByRole("option", { name: profile }).dblclick();
      await waitForPath("left", "/nested");
      for (const [key, title, name, suffix] of [
        ["F7", "New folder", "Projects", "folder"],
        ["Shift+F4", "New file", "draft.txt", "text_file"],
      ]) {
        await files("left").press(key);
        const create = page.getByRole("dialog", { name: title, exact: true });
        await create.getByRole("textbox", { name: "Name", exact: true }).fill(name);
        await button(create, "Create").click();
        if (provider === "ssh") {
          const sudo = page.getByRole("dialog", { name: "SSH permissions", exact: true });
          await sudo.getByLabel("Sudo password", { exact: true }).waitFor();
          await button(sudo, "Continue with sudo").click();
        }
        await create.waitFor({ state: "hidden" });
        const attempts = await page.evaluate(({ provider, suffix }) => window.remoteCreates.filter(({ command }) =>
          command === `create_${provider}_${suffix}`), { provider, suffix });
        assert.deepEqual(attempts.map(({ elevated }) => elevated), provider === "ssh" ? [false, true] : [false]);
        assert.deepEqual(attempts.at(-1).segments, ["nested", name]);
        if (suffix === "text_file") {
          await button(page.getByRole("region", { name, exact: true }), "Close document").click();
        }
      }
    }

    await page.goto("http://dirlume.test/");
    await waitForPath("right", downloads);
    await files("left").press("Alt+F1");
    await sources("left").press("Digit6");
    const collectionPane = page.locator('[data-pane-side="left"][aria-label="Collections"]');
    const collectionList = page.locator("#left-collections");
    async function nameCollectionItem(title, name) {
      const dialog = page.getByRole("dialog", { name: title, exact: true });
      await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
      await button(dialog, "Create").click();
      await dialog.waitFor({ state: "hidden" });
    }
    await button(collectionPane, "New collection").click();
    await nameCollectionItem("New collection", "Delivery");
    await collectionList.press("F7");
    await nameCollectionItem("New folder", "Notes");
    for (const confirm of [false, true, true]) {
      await files("right").getByRole("option", { name: /^note\.txt/ }).click();
      await files("right").press("F5");
      const dialog = page.getByRole("dialog", { name: "Add to collection", exact: true });
      await dialog.getByText("Delivery / Notes", { exact: true }).waitFor();
      await button(dialog, confirm ? "Add to collection" : "Cancel").click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(await collectionList.getByRole("option", { name: /^note\.txt/ }).count(), confirm ? 1 : 0);
    }
    await page.reload();
    await waitForPath("right", downloads);
    await files("right").press("Alt+F2");
    await button(sources("right"), "Collections").click();
    const reopened = page.locator("#right-collections");
    await reopened.getByRole("option", { name: "Delivery", exact: true }).click();
    await reopened.press("F5");
    const exportDialog = page.getByRole("dialog", { name: "Copy", exact: true });
    assert.equal(await exportDialog.getByRole("combobox", { name: "Destination", exact: true }).inputValue(), home);
    await button(exportDialog, "Copy").click();
    await exportDialog.waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.collectionFolders), { directory: home, paths: [["Delivery"], ["Delivery", "Notes"]] });
    assert.deepEqual(await page.evaluate(() => window.lastTransfer.source), { kind: "local", directory: downloads, name: "note.txt" });
    assert.equal(await page.evaluate(() => window.lastTransfer.destination), [home, "Delivery", "Notes"].join(windows ? "\\" : "/"));
    await reopened.getByRole("option", { name: "Delivery", exact: true }).dblclick();
    await reopened.getByRole("option", { name: "Notes", exact: true }).dblclick();
    const reference = reopened.getByRole("option", { name: /^note\.txt/ });
    await reference.waitFor();
    await reopened.press("Delete");
    const remove = page.getByRole("dialog", { name: "Remove from collection", exact: true });
    await button(remove, "Remove").click();
    await reference.waitFor({ state: "hidden" });
    assert.equal(await files("left").getByRole("option", { name: /^note\.txt/ }).count(), 1);

    await files("left").press("Alt+F1");
    await button(sources("left"), "NetBox").click();
    await files("left").getByRole("option", { name: /^FTP fixture/ }).dblclick();
    await waitForPath("left", "/nested");
    await files("left").getByRole("option", { name: /^note\.txt/ }).click();
    await files("left").press("F5");
    await button(page.getByRole("dialog", { name: "Add to collection", exact: true }), "Add to collection").click();
    await reference.waitFor();
    await files("left").press("Alt+F1");
    await button(sources("left"), "Home").click();
    await waitForPath("left", home);
    await reference.click();
    await reopened.press("F5");
    await button(exportDialog, "Copy").click();
    await exportDialog.waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.lastTransfer.source), {
      kind: "ftp", connection: 1, segments: ["nested", "note.txt"],
    });
    await openPairedDrive("Files");
    await files("left").getByRole("option", { name: /^nested/ }).click();
    await files("left").press("F5");
    const addCollection = page.getByRole("dialog", { name: "Add to collection", exact: true });
    await button(addCollection, "Add to collection").click();
    const directFolder = reopened.getByRole("option", { name: /^nested.*Dirlume test PC/ });
    await directFolder.waitFor();
    await files("left").press("Alt+F1");
    await button(sources("left"), "Home").click();
    await waitForPath("left", home);
    await directFolder.click();
    await reopened.press("F5");
    await button(exportDialog, "Copy").click();
    await exportDialog.waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.lastTransfer.source), {
      kind: "server", connection: 8, segments: ["Files", "nested"], folder: true,
    });
    if (windows) {
      await page.evaluate(() => { window.collectionKSwitcher = true; });
      await files("left").press("Alt+F1");
      const lan = sources("left").getByRole("group", { name: "KSwitcher LAN", exact: true });
      await lan.getByRole("group", { name: "KSwitcher PC", exact: true }).getByRole("button", { name: /^C:.*Fixed/ }).click();
      await files("left").getByRole("option", { name: /^nested/ }).click();
      await files("left").press("F5");
      await button(addCollection, "Add to collection").click();
      const kswitcherFolder = reopened.getByRole("option", { name: /^nested.*C:/ });
      await kswitcherFolder.waitFor();
      await files("left").press("Alt+F1");
      await button(sources("left"), "Home").click();
      await waitForPath("left", home);
      await kswitcherFolder.click();
      await reopened.press("F5");
      await button(exportDialog, "Copy").click();
      await exportDialog.waitFor({ state: "hidden" });
      assert.deepEqual(await page.evaluate(() => {
        const { kind, peer, path, folder } = window.lastTransfer.source;
        return { kind, peer, path, folder };
      }), { kind: "kswitcher", peer: "online", path: "C:\\nested", folder: true });
    }
    const localized = {
      Windows: { language: "en", title: "Folder shortcuts", up: "Move up", down: "Move down" },
      Ubuntu: { language: "uk", title: "Закладки папок", up: "Перемістити вгору", down: "Перемістити вниз" },
      macOS: { language: "ru", title: "Закладки папок", up: "Переместить вверх", down: "Переместить вниз" },
    }[client];
    for (const theme of ["light", "dark"]) {
      await page.evaluate(({ language, theme }) => {
        localStorage.setItem("dirlume.preferences.v1", JSON.stringify({
          language, theme, bindingDefaults: 8, activeShortcutScheme: "fixture",
          shortcutSchemes: [{ id: "fixture", name: "Fixture", bindings: { pickerFolderUp: ["Ctrl+Shift+ArrowUp"], pickerFolderDown: [] } }],
        }));
      }, { language: localized.language, theme });
      await page.setViewportSize({ width: theme === "dark" ? 330 : 1100, height: 680 });
      await page.reload();
      await page.locator(`html[lang=${localized.language}][data-theme=${theme}]`).waitFor();
      await waitForPath("left", home);
      await files("left").focus();
      await pressBookmark(9);
      const picker = page.getByRole("dialog", { name: localized.title, exact: true });
      const list = picker.getByRole("listbox");
      await list.waitFor();
      const strip = picker.locator(".dialog-action-strip");
      await picker.evaluate((element) => { element.style.setProperty("--dialog-size", "20px"); });
      assert.ok(await strip.evaluate((element) => {
        const actions = [...element.querySelectorAll("button")];
        const boxes = actions.map((action) => action.getBoundingClientRect());
        return actions.length === 5 && element.scrollWidth === element.clientWidth &&
          boxes.every(({ top, width, height }) => top === boxes[0].top && width === 32 && height === 32) &&
          actions.every((action) => action.getAttribute("aria-label") && action.textContent === "");
      }));
      const up = button(picker, localized.up);
      const down = button(picker, localized.down);
      assert.ok(await up.isDisabled());
      assert.ok(await down.isEnabled());
      await list.press("End");
      assert.ok(await down.isDisabled());
      assert.equal(await down.getAttribute("data-tooltip"), localized.down);
      await list.press("Control+ArrowUp");
      assert.match(await list.getByRole("option", { selected: true }).innerText(), /^Downloads folder/);
      await list.press("Tab");
      const add = strip.getByRole("button").first();
      assert.ok(await add.evaluate((element) => document.activeElement === element && getComputedStyle(element).outlineWidth === "2px"));
      await up.press("Control+Shift+ArrowUp");
      assert.match(await list.getByRole("option").first().innerText(), /^Downloads folder/);
      assert.equal(await up.isDisabled(), true);
      assert.match(await up.getAttribute("data-tooltip"), /↑/);
    }
    console.log(`Verified workspace sources and numbered bookmarks with ${client} bindings.`);
    console.log(`Verified one-row bookmark controls, localized labels, focus and remapped shortcuts with ${client} settings.`);
    await page.close();
  }
} finally {
  await browser.close();
}
