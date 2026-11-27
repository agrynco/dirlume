import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { clickBreadcrumbAncestor as clickCrumb } from "./pane-address-smoke.mjs";

const platforms = ["Windows NT 10.0; Win64; x64", "X11; Linux x86_64", "Macintosh; Intel Mac OS X 10_15_7"];
const folders = ["one-long-folder", "two-long-folder", "three-long-folder", "four-long-folder", "leaf-folder"];
const deep = "/" + folders.join("/");
const smbRoot = "\\\\fixture";
const smbDeep = [smbRoot, "share", ...folders].join("\\");
const bridgeDeep = ["C:", ...folders].join("\\");
const pane = (page, side) => page.getByRole("region", { name: `${side} pane`, exact: true });
const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const list = (page, side) => page.locator(`#${side}-files`);
const crumbs = (page, side) => pane(page, side).getByRole("navigation", { name: `${side} path breadcrumbs`, exact: true });
const row = (page, side, name) => list(page, side).locator(`[data-tooltip=${JSON.stringify(name)}]`);
const waitPath = (page, side, path) => page.waitForFunction(({ side, path }) =>
  document.getElementById(`${side}-path`)?.dataset.path === path &&
  document.getElementById(`${side}-files`)?.getAttribute("aria-busy") === "false", { side, path });

async function fixture(browser, platform, nestedLocal = false) {
  const windows = platform.startsWith("Windows");
  const home = windows ? "C:\\fixture" : "/fixture";
  const separator = windows ? "\\" : "/";
  const path = nestedLocal ? [home, ...folders].join(separator) : home;
  const page = await browser.newPage({ userAgent: `Mozilla/5.0 (${platform})`, viewport: { width: 740, height: 700 }, locale: "en-US" });
  page.setDefaultTimeout(8000);
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  await page.addInitScript(({ home, folders, smbRoot, windows, path, separator, nestedLocal }) => {
    const folder = (name) => ({ name, directory: true, hidden: false, link: false, size: null, modified: null });
    const entries = (depth) => depth < folders.length ? [folder(folders[depth])] : [];
    const listing = (depth) => ({ entries: entries(depth), omitted: 0, elevated: false });
    const state = window.connectionFixture = { attempts: 0, offline: false, failProfiles: false, emptySsh: false,
      operations: false, allowWrite: true, conflictPrompt: true, transfers: [], mutations: [], edits: [],
      directorySettings: JSON.parse(localStorage.getItem("fixture.directory-settings") ?? "null") ?? undefined };
    if (nestedLocal) {
      const place = { kind: "local", path, parent: path.slice(0, path.lastIndexOf(separator)) };
      localStorage.setItem("dirlume.workspace.v1", JSON.stringify({
        panels: { left: { place }, right: { place } }, active: "left", split: 50, documents: [],
      }));
    }
    localStorage.setItem("dirlume.smb-locations", JSON.stringify([smbRoot]));
    localStorage.setItem("dirlume.preferences.v1", JSON.stringify({
      kswitcher: "fixture-bridge", bindingDefaults: 10, activeShortcutScheme: "fixture",
      shortcutSchemes: [{ id: "fixture", name: "Fixture", bindings: { parent: ["Alt+ArrowUp"] } }],
    }));
    localStorage.setItem("dirlume.remote-connections", JSON.stringify([
      { id: "server", kind: "server", label: "Saved Dirlume Server", credential: "fixture-invitation" },
      { id: "paired", kind: "server", label: "Paired fixture", credential: "fixture-pair", lan: true },
      ...(windows ? [{ id: "bridge", kind: "kswitcher", label: "Saved KSwitcher", peer: "fixture-peer" }] : []),
    ]));
    const remote = (result) => {
      state.attempts++;
      if (state.offline) throw new Error("Remote fixture is offline.");
      return result;
    };
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args) => {
        if (command === "locations") return [{ label: "Home", path: home }];
        if (command === "file_icons") return args.items.map(() => null);
        if (command === "ftp_profiles") {
          if (state.failProfiles) throw new Error("Could not read FTP profiles.");
          return [{ id: "ftp", label: "Saved FTP", host: "fixture", port: 21, directories: state.directorySettings }];
        }
        if (command === "ssh_profiles") return state.emptySsh ? [] : [{ id: "ssh", label: "Saved SFTP", host: "fixture", port: 22 }];
        if (command === "connect_ftp") {
          state.requestedStart = args.remembered;
          const segments = args.segments ?? (state.directorySettings ? args.remembered ?? [] : folders);
          return remote({ id: 4, address: "FTP fixture", origin: "ftp://fixture",
            segments, listing: listing(segments.length), directories: state.directorySettings });
        }
        if (command === "connect_ssh") return remote({ kind: "connected", id: 5, address: "SFTP fixture", origin: "sftp://fixture",
          segments: folders, listing: listing(folders.length) });
        if (command === "list_saved_computer_drives") return [{ name: "Files", type: 3, total: null, available: null }];
        if (command === "connect_saved_server") return remote({ id: args.credential === "fixture-pair" ? 8 : 6,
          share: "share", address: "Server fixture", origin: "https://fixture", listing: listing(0) });
        if (command === "open_archive") return { id: 7, path: args.path, parent: home,
          writable: !!state.archiveWritable, canAdd: !!state.archiveWritable, listing: listing(0) };
        if (command === "list_archive") {
          if (state.measureArchive && args.segments.length) return {
            entries: [{ ...folder("uncompressed.txt"), directory: false, size: 3072 }], omitted: 0,
          };
          const result = listing(args.segments.length);
          if (args.segments.length === 1 && state.archivedFolder) result.entries.push(folder(state.archivedFolder));
          return result;
        }
        if (command === "change_archive") {
          state.mutations.push(args.change);
          state.archivedFolder = args.change.name;
          return null;
        }
        if (command === "delete_archive_entries") {
          state.mutations.push(args.paths);
          delete state.archivedFolder;
          return null;
        }
        if (["list_ftp", "list_ssh", "list_server"].includes(command)) {
          const segments = args.segments;
          const depth = segments[0] === "Files" ? segments.length - 1 : segments.length;
          return remote(listing(depth));
        }
        if (command === "list_kswitcher") {
          const parts = args.path.split("\\").filter(Boolean);
          const parent = parts.length === 0 ? null : parts.length === 1 ? "" : parts.length === 2 ? parts[0] + "\\" : parts.slice(0, -1).join("\\");
          if (state.operations) {
            if (!parts.length) return { parent, omitted: 0, entries: [folder("C:"), folder("D:")] };
            if (parts.length > 1 && state.delaySizes) {
              await new Promise((done) => { state.releaseSize = done; });
              return { parent, omitted: 0, entries: [{ ...folder("late.bin"), directory: false, size: 8192 }] };
            }
            return { parent, omitted: 0, entries: parts.length === 1
              ? [folder("subfolder"), { ...folder("notes.txt"), directory: false, size: 13 }]
              : [{ ...folder("contents.bin"), directory: false, size: 2048 }] };
          }
          return remote({ parent, omitted: 0, entries: parts.length ? entries(parts.length - 1) : [folder("C:")] });
        }
        if (command === "kswitcher_capabilities" && state.operations) return {
          write: state.allowWrite, delete: state.allowWrite, revisionRead: true,
          onHostTransfer: true, localEndpoint: true, conflictPrompt: state.conflictPrompt,
        };
        if (command === "transfer_item") {
          state.transfers.push(args.request);
          if (args.request.source.kind === "archive" && args.request.moving) delete state.archivedFolder;
          return { kind: "completed" };
        }
        if (command === "change_kswitcher") {
          state.mutations.push({ peer: args.peer, path: args.path, change: args.change });
          return null;
        }
        if (command === "read_kswitcher_text") return { text: "Remote notes\n", encoding: "utf8", revision: "123" };
        if (command === "save_kswitcher_text") {
          state.edits.push(args);
          return { text: args.text, encoding: args.encoding, revision: "124" };
        }
        if (command === "connect_smb") return remote({ kind: "shares", server: smbRoot, names: ["share"], warning: null });
        if (command === "list_directory") {
          if (!args.path.startsWith(smbRoot)) {
            const last = args.path.lastIndexOf(separator);
            const parent = args.path.startsWith(home + separator) ? args.path.slice(0, last) : null;
            return { path: args.path, parent, entries: args.path === home ? [{ ...folder("fixture.zip"), directory: false }] : [], omitted: 0 };
          }
          return remote({ path: args.path, parent: args.path.slice(0, args.path.lastIndexOf("\\")), entries: [], omitted: 0 });
        }
        return null;
      },
    };
  }, { home, folders, smbRoot, windows, path, separator, nestedLocal });
  await page.goto("http://dirlume.test/");
  await Promise.all([waitPath(page, "left", path), waitPath(page, "right", path)]);
  return { page, home, path };
}

async function enterFromCatalog(page, side, name, saved) {
  await button(pane(page, side), `Locations for ${side} pane`).click();
  await button(pane(page, side), name).click();
  await row(page, side, saved).dblclick();
}

async function checkKSwitcherOperations(page) {
  await page.evaluate(() => { window.connectionFixture.operations = true; });
  for (const [side, drive] of [["left", "C:"], ["right", "D:"]]) {
    await enterFromCatalog(page, side, "Remote machine", "Saved KSwitcher");
    await row(page, side, drive).dblclick();
    await waitPath(page, side, drive + "\\");
  }

  const parent = row(page, "left", "..");
  await parent.click();
  await list(page, "left").press("F3");
  await row(page, "left", "subfolder").getByText("2 KiB", { exact: true }).waitFor();
  assert.equal(await parent.getAttribute("data-current"), "true");
  await page.evaluate(() => { window.connectionFixture.delaySizes = true; });
  await list(page, "left").press("F3");
  await page.waitForFunction(() => typeof window.connectionFixture.releaseSize === "function");
  await list(page, "left").press("Escape");
  await page.evaluate(() => {
    window.connectionFixture.delaySizes = false;
    window.connectionFixture.releaseSize();
  });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await row(page, "left", "subfolder").getByText("2 KiB", { exact: true }).waitFor();

  await row(page, "left", "subfolder").click();
  await list(page, "left").press("F5");
  const copy = page.getByRole("dialog", { name: "Copy", exact: true });
  assert.equal(await copy.getByRole("combobox", { name: "Destination", exact: true }).inputValue(), "D:\\");
  await copy.getByRole("option", { name: "Ask", exact: true }).waitFor({ state: "attached" });
  await button(copy, "Copy").click();
  await copy.waitFor({ state: "hidden" });
  await list(page, "left").press("F6");
  const move = page.getByRole("dialog", { name: "Rename or move", exact: true });
  await button(move, "Move").click();
  await move.waitFor({ state: "hidden" });
  const transfers = await page.evaluate(() => window.connectionFixture.transfers);
  assert.equal(transfers.length, 2);
  for (const [index, request] of transfers.entries()) {
    assert.equal(request.source.kind, "kswitcher");
    assert.equal(request.source.path, "C:\\subfolder");
    assert.equal(request.destination, "D:\\");
    assert.equal(request.source.peer, request.kswitcherDestination);
    assert.equal(request.moving, index === 1);
  }

  await row(page, "left", "notes.txt").click();
  await list(page, "left").press("F3");
  const viewer = page.getByRole("region", { name: "notes.txt", exact: true });
  await viewer.getByText("Remote notes", { exact: true }).waitFor();
  await button(viewer, "Close document").click();
  await list(page, "left").waitFor();
  await row(page, "left", "notes.txt").click();
  await list(page, "left").press("F2");
  const rename = page.getByRole("dialog", { name: "Rename", exact: true });
  await rename.getByRole("textbox", { name: "Name", exact: true }).fill("renamed.txt");
  await button(rename, "Rename").click();
  await rename.waitFor({ state: "hidden" });

  await list(page, "left").press("F7");
  const mkdir = page.getByRole("dialog", { name: "New folder", exact: true });
  await mkdir.getByRole("textbox", { name: "Name", exact: true }).fill("Created remotely");
  await button(mkdir, "Create").click();
  await mkdir.waitFor({ state: "hidden" });

  await row(page, "left", "notes.txt").click();
  await list(page, "left").press("F8");
  const recycle = page.getByRole("dialog", { name: "Move to remote recycle bin", exact: true });
  await button(recycle, "Move to remote recycle bin").click();
  await recycle.waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => window.connectionFixture.mutations), [
    { peer: "fixture-peer", path: "C:\\notes.txt", change: { kind: "rename", name: "renamed.txt" } },
    { peer: "fixture-peer", path: "C:\\Created remotely", change: { kind: "create_folder" } },
    { peer: "fixture-peer", path: "C:\\notes.txt", change: { kind: "recycle" } },
  ]);

  await row(page, "right", "notes.txt").click();
  await list(page, "right").press("F4");
  const editor = page.getByRole("region", { name: "notes.txt", exact: true });
  const text = editor.locator(".cm-content");
  await text.press("Control+End");
  await page.keyboard.insertText("Updated remotely");
  await text.press("Control+s");
  await page.waitForFunction(() => window.connectionFixture.edits.length === 1);
  assert.deepEqual(await page.evaluate(() => window.connectionFixture.edits[0]), {
    peer: "fixture-peer", path: "D:\\notes.txt", text: "Remote notes\nUpdated remotely",
    encoding: "utf8", revision: "123",
  });
}

async function checkDirectoryCache(page) {
  const side = "left";
  const target = pane(page, side);
  const cached = target.getByText("Showing a cached directory listing.", { exact: true });
  await page.evaluate(() => {
    window.connectionFixture.directorySettings = {
      startingFolder: "", rememberLast: true, cacheListings: true, cacheChanges: true,
      persistentCache: true, resolveLinks: false,
    };
    localStorage.setItem("fixture.directory-settings", JSON.stringify(window.connectionFixture.directorySettings));
  });
  await enterFromCatalog(page, side, "NetBox", "Saved FTP");
  await waitPath(page, side, "/");
  await row(page, side, folders[0]).dblclick();
  await waitPath(page, side, "/" + folders[0]);
  const attempts = await page.evaluate(() => window.connectionFixture.attempts);
  await button(target, "Back").click();
  await waitPath(page, side, "/");
  await cached.waitFor();
  await page.evaluate(() => { window.connectionFixture.offline = true; });
  await button(target, "Forward").click();
  await waitPath(page, side, "/" + folders[0]);
  await cached.waitFor();
  assert.equal(await page.evaluate(() => window.connectionFixture.attempts), attempts);
  await page.reload();
  await waitPath(page, side, "/" + folders[0]);
  const afterRestart = await page.evaluate(() => window.connectionFixture.attempts);
  await button(target, "Parent folder").click();
  await waitPath(page, side, "/");
  await cached.waitFor();
  assert.equal(await page.evaluate(() => window.connectionFixture.attempts), afterRestart);
  await button(target, "Back").click();
  await waitPath(page, side, "/" + folders[0]);
  await page.evaluate(() => { window.connectionFixture.offline = true; });
  await button(target, "Refresh folder").click();
  await target.getByRole("alert").filter({ hasText: "Remote fixture is offline." }).waitFor();
  await cached.waitFor();
  assert.equal(await page.evaluate(() => window.connectionFixture.attempts), afterRestart + 1);
  await page.evaluate(() => { window.connectionFixture.offline = false; });
  await button(target, "Refresh folder").click();
  await cached.waitFor({ state: "hidden" });
  await button(crumbs(page, side), "Open NetBox connection list").click();
  await waitPath(page, side, "NetBox");
  await list(page, side).press("Enter");
  await waitPath(page, side, "/" + folders[0]);
  assert.deepEqual(await page.evaluate(() => window.connectionFixture.requestedStart), [folders[0]]);
}

async function checkOverflowMenu(address, kind) {
  const parents = kind === "parents";
  const name = parents ? "Show parent folders" : "Show previous path";
  const trigger = button(address, name);
  await trigger.waitFor();
  const current = address.locator("[aria-current=location]");
  const bounds = await trigger.boundingBox();
  const currentBounds = await current.boundingBox();
  assert.ok(parents ? bounds.x + bounds.width <= currentBounds.x + 1 :
    currentBounds.x + currentBounds.width <= bounds.x + 1);
  assert.equal(await trigger.getAttribute("data-tooltip"), name);
  const scope = parents ? ".address-crumbs >" : ".address-forward >";
  const hidden = await address.locator(`${scope} .address-ancestor[hidden] button`).allTextContents();
  assert.ok(hidden.length > 0);
  await trigger.press("Enter");
  const popup = address.locator(`.address-${kind}`);
  await popup.waitFor();
  assert.deepEqual(await popup.getByRole("button").allTextContents(), hidden);
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  await trigger.press("Tab");
  assert.ok(await popup.getByRole("button").first().evaluate((node) => node === document.activeElement));
  await address.page().keyboard.press("Escape");
  await popup.waitFor({ state: "hidden" });
  await trigger.and(address.locator(":focus")).waitFor();
}

async function checkParentNavigation(page, side, path, parentPath) {
  const address = crumbs(page, side);
  const parent = button(pane(page, side), "Parent folder");
  const other = side === "left" ? "right" : "left";
  const otherPath = await page.locator(`#${other}-path`).getAttribute("data-path");
  for (const goUp of [async () => {
    await row(page, side, "..").click();
    await list(page, side).press("Enter");
  }, () => parent.click(), () => list(page, side).press("Alt+ArrowUp")]) {
    await goUp();
    await waitPath(page, side, parentPath);
    await clickCrumb(address, folders.at(-1));
    await waitPath(page, side, path);
    assert.equal(await page.locator(`#${other}-path`).getAttribute("data-path"), otherPath);
  }
}

async function checkSourceRoot(page, side, path) {
  assert.equal(await row(page, side, "..").count(), 0);
  assert.equal(await button(pane(page, side), "Parent folder").isDisabled(), true);
  await list(page, side).press("Alt+ArrowUp");
  await waitPath(page, side, path);
}

async function checkCatalog(page, side, path, name, home, { key = "Enter", root, connectionName } = {}) {
  const other = side === "left" ? "right" : "left";
  await waitPath(page, side, path);
  const separator = path.includes("\\") ? "\\" : "/";
  await checkParentNavigation(page, side, path, path.slice(0, path.lastIndexOf(separator)));
  const source = button(crumbs(page, side), `Open ${name} connection list`);
  const overflow = button(crumbs(page, side), "Show parent folders");
  await overflow.waitFor();
  const sourceBounds = await source.boundingBox();
  const overflowBounds = await overflow.boundingBox();
  assert.ok(sourceBounds.width > 20 && sourceBounds.x + sourceBounds.width <= overflowBounds.x + 1);
  await overflow.click();
  const parents = crumbs(page, side).locator(".address-parents");
  await button(parents, connectionName).click();
  await waitPath(page, side, root);
  const address = crumbs(page, side);
  assert.equal(await address.locator("[aria-current=location]").innerText(), connectionName);
  await checkSourceRoot(page, side, root);
  await clickCrumb(address, folders.at(-1));
  await waitPath(page, side, path);
  await clickCrumb(address, connectionName);
  await waitPath(page, side, root);
  await source.click();
  await waitPath(page, side, name);
  await checkSourceRoot(page, side, name);
  assert.equal(await address.locator("[aria-current=location]").innerText(), name);
  const hidden = button(address, "Show previous path");
  await hidden.waitFor();
  assert.equal(await button(address, "Show parent folders").count(), 0);
  await checkOverflowMenu(address, "previous");
  await page.setViewportSize({ width: 2600, height: 700 });
  const fullTrail = address.locator(".address-forward");
  for (const label of [connectionName, ...folders]) await button(fullTrail, label).waitFor();
  await hidden.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 740, height: 700 });
  await hidden.waitFor();
  await clickCrumb(address, folders.at(-1));
  await waitPath(page, side, path);
  await button(pane(page, side), "Back").click();
  await waitPath(page, side, name);
  await button(pane(page, side), "Back").click();
  await waitPath(page, side, root);
  await button(pane(page, side), "Back").click();
  await waitPath(page, side, path);
  const parent = button(pane(page, side), "Parent folder");
  await parent.focus();
  await page.keyboard.press("Tab");
  assert.ok(await source.evaluate((node) => node === document.activeElement));
  await page.keyboard.press(key);
  await waitPath(page, side, name);
  await clickCrumb(address, connectionName);
  await waitPath(page, side, root);
  await button(pane(page, side), "Back").click();
  await waitPath(page, side, name);
  assert.equal(await page.locator(`#${other}-path`).getAttribute("data-path"), home);
  await button(pane(page, side), "Back").click();
  await waitPath(page, side, path);
  await button(pane(page, side), "Forward").click();
  await waitPath(page, side, name);
  await button(pane(page, side), "Back").click();
  await waitPath(page, side, path);
  await button(pane(page, side), `Locations for ${side} pane`).click();
  await button(pane(page, side), name).click();
  await waitPath(page, side, name);
  await checkSourceRoot(page, side, name);
  await clickCrumb(address, folders.at(-1));
  await waitPath(page, side, path);
  const unrelated = name === "Remote machine" ? "NetBox" : "Remote machine";
  await button(pane(page, side), `Locations for ${side} pane`).click();
  await button(pane(page, side), unrelated).click();
  await waitPath(page, side, unrelated);
  await checkSourceRoot(page, side, unrelated);
  assert.equal(await address.locator(".address-forward, .address-overflow").count(), 0);
  const homeButton = button(pane(page, side), `Locations for ${side} pane`);
  await homeButton.click();
  await button(pane(page, side), "Home").click();
  await waitPath(page, side, home);
}

async function checkLocalResize(page, home, path) {
  const root = home.includes("\\") ? home.slice(0, 2) : "/";
  const divider = page.getByRole("separator", { name: "Pane divider", exact: true });
  const dragTo = async (fraction) => {
    const grip = await divider.boundingBox();
    const workspace = await page.locator(".workspace").boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + 80);
    await page.mouse.down();
    await page.mouse.move(workspace.x + workspace.width * fraction, grip.y + 80);
    await page.mouse.up();
  };
  await page.setViewportSize({ width: 1500, height: 700 });
  for (const side of ["left", "right"]) {
    const other = side === "left" ? "right" : "left";
    await dragTo(side === "left" ? 0.79 : 0.21);
    const address = crumbs(page, side);
    const overflow = button(address, "Show parent folders");
    await overflow.waitFor({ state: "hidden" });
    const separator = home.includes("\\") ? "\\" : "/";
    await checkParentNavigation(page, side, path, [home, ...folders.slice(0, -1)].join(separator));
    await button(address, root).waitFor();
    for (const name of ["fixture", ...folders.slice(0, -1)]) await button(address, name).waitFor();
    await button(crumbs(page, other), "Show parent folders").waitFor();
    const current = crumbs(page, other).locator("[aria-current=location]").getByText("leaf-folder");
    await current.waitFor();
    const currentBounds = await current.boundingBox();
    const navBounds = await crumbs(page, other).boundingBox();
    assert.ok(currentBounds.width > 0 && currentBounds.x + currentBounds.width <= navBounds.x + navBounds.width);
    assert.equal(await page.locator(`#${other}-path`).getAttribute("data-path"), path);
    await page.setViewportSize({ width: 740, height: 700 });
    await overflow.waitFor();
    await page.setViewportSize({ width: 1500, height: 700 });
    await overflow.waitFor({ state: "hidden" });
    await dragTo(side === "left" ? 0.21 : 0.79);
    await overflow.waitFor();
    await clickCrumb(address, folders[1]);
    await waitPath(page, side, [home, ...folders.slice(0, 2)].join(separator));
    await checkOverflowMenu(address, "parents");
    await checkOverflowMenu(address, "previous");
    await clickCrumb(address, folders.at(-1));
    await waitPath(page, side, path);
  }
  await dragTo(0.21);
  const address = crumbs(page, "left");
  await button(address, "Show parent folders").click();
  const parents = address.locator(".address-parents");
  await button(parents, root).waitFor();
  await button(parents, "fixture").click();
  await waitPath(page, "left", home);
  await checkSourceRoot(page, "left", home);
  assert.equal(await page.locator("#right-path").getAttribute("data-path"), path);
  const forward = address.locator(".address-forward");
  const hiddenFolders = button(address, "Show previous path");
  await hiddenFolders.click();
  await button(address.locator(".address-previous"), folders.at(-1)).waitFor();
  await hiddenFolders.click();
  await dragTo(0.79);
  const first = button(forward, folders[0]);
  await first.click();
  const separator = home.includes("\\") ? "\\" : "/";
  await waitPath(page, "left", home + separator + folders[0]);
}

async function checkArchive(page, side, home) {
  const separator = home.includes("\\") ? "\\" : "/";
  const archive = home + separator + "fixture.zip!/";
  await row(page, side, "fixture.zip").dblclick();
  await waitPath(page, side, archive);
  for (const name of folders) await row(page, side, name).dblclick();
  await waitPath(page, side, archive + folders.join("/"));
  const address = crumbs(page, side);
  await clickCrumb(address, "fixture.zip");
  await waitPath(page, side, archive);
  await clickCrumb(address, folders.at(-1));
  await waitPath(page, side, archive + folders.join("/"));
  await clickCrumb(address, "fixture");
  await waitPath(page, side, home);
  await clickCrumb(address, folders.at(-1));
  await waitPath(page, side, archive + folders.join("/"));
}

async function checkTreeSources(page) {
  const side = "left";
  const target = pane(page, side);
  const treeButton = button(target, "Tree");
  const listButton = button(target, "List");
  const directRow = (name) => list(page, side).getByRole("treeitem").and(page.locator(
    `[data-tooltip=${JSON.stringify(name)}]`,
  ));
  const openFirstBranch = async () => {
    await treeButton.click();
    await button(directRow(folders[0]), "Expand folder").click();
    await directRow(folders.slice(0, 2).join("/")).waitFor();
  };

  await enterFromCatalog(page, side, "Remote machine", "Saved Dirlume Server");
  await openFirstBranch();
  await directRow(folders.slice(0, 2).join("/")).click();
  await list(page, side).press("F7");
  assert.equal(await page.getByRole("dialog", { name: "New folder", exact: true }).count(), 0);
  await listButton.click();
  await button(target, `Locations for ${side} pane`).click();
  await button(target, "Home").click();

  await row(page, side, "fixture.zip").dblclick();
  await openFirstBranch();
  await directRow(folders[0]).click();
  await list(page, side).press("Shift+F4");
  assert.equal(await page.getByRole("dialog", { name: "New file", exact: true }).count(), 0);
  await listButton.click();
  await button(target, "Parent folder").click();

  await page.evaluate(() => { window.connectionFixture.archiveWritable = true; });
  await row(page, side, "fixture.zip").dblclick();
  await openFirstBranch();
  await directRow(folders[0]).click();
  await list(page, side).press("F7");
  const create = page.getByRole("dialog", { name: "New folder", exact: true });
  await create.getByLabel("Name", { exact: true }).fill("new-directory");
  await button(create, "Create").click();
  await create.waitFor({ state: "hidden" });
  await directRow(folders[0] + "/new-directory").click();
  await list(page, side).press("F2");
  const rename = page.getByRole("dialog", { name: "Rename", exact: true });
  await rename.getByLabel("Name", { exact: true }).fill("renamed-directory");
  await button(rename, "Rename").click();
  await rename.waitFor({ state: "hidden" });
  await directRow(folders[0] + "/renamed-directory").click();
  await list(page, side).press("F8");
  const remove = page.getByRole("dialog", { name: "Delete permanently", exact: true });
  await button(remove, "Delete permanently").click();
  await remove.waitFor({ state: "hidden" });
  await directRow(folders[0] + "/renamed-directory").waitFor({ state: "detached" });
  await directRow(folders.slice(0, 2).join("/")).waitFor();
  assert.deepEqual(await page.evaluate(() => window.connectionFixture.mutations), [
    { kind: "folder", name: "new-directory", parent: [folders[0]] },
    { kind: "rename", name: "renamed-directory", segments: [folders[0], "new-directory"] },
    [[folders[0], "renamed-directory"]],
  ]);
  await directRow(folders[0]).click();
  await list(page, side).press("F7");
  await create.getByLabel("Name", { exact: true }).fill("move-directory");
  await button(create, "Create").click();
  await create.waitFor({ state: "hidden" });
  await directRow(folders[0] + "/move-directory").click();
  await list(page, side).press("F6");
  const move = page.getByRole("dialog", { name: "Rename or move", exact: true });
  await button(move, "Move").click();
  await move.waitFor({ state: "hidden" });
  await directRow(folders[0] + "/move-directory").waitFor({ state: "detached" });
  const [request] = await page.evaluate(() => window.connectionFixture.transfers);
  assert.equal(request.moving, true);
  assert.deepEqual(request.source, { kind: "archive", archive: 7, segments: [folders[0], "move-directory"] });
  assert.equal(request.destination, "/fixture");
}

async function checkLan(page, side) {
  await button(pane(page, side), `Locations for ${side} pane`).click();
  const host = page.getByRole("group", { name: "Paired fixture", exact: true });
  await host.getByRole("button", { name: /^Files/ }).click();
  await waitPath(page, side, "/Files");
  for (const name of folders) await row(page, side, name).dblclick();
  await waitPath(page, side, "/Files" + deep);
  await checkParentNavigation(page, side, "/Files" + deep, "/Files/" + folders.slice(0, -1).join("/"));
  const address = crumbs(page, side);
  await clickCrumb(address, "Files");
  await waitPath(page, side, "/Files");
  await button(address, "Open Remote machine connection list").click();
  await waitPath(page, side, "Remote machine");
  await clickCrumb(address, folders.at(-1));
  await waitPath(page, side, "/Files" + deep);
}

const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const [index, platform] of platforms.entries()) {
    const local = await fixture(browser, platform, true);
    await checkLocalResize(local.page, local.home, local.path);
    await local.page.close();
    const { page, home } = await fixture(browser, platform);
    const side = index === 1 ? "left" : "right";
    const other = side === "left" ? "right" : "left";
    await checkArchive(page, side, home);
    for (const [source, saved, connectionName] of [["NetBox", "Saved FTP", "FTP fixture"],
      ["NetBox", "Saved SFTP", "SFTP fixture"]]) {
      await enterFromCatalog(page, side, source, saved);
      await checkCatalog(page, side, deep, source, home, { key: "Space", root: "/", connectionName });
    }
    await enterFromCatalog(page, other, "NetBox", "Saved SFTP");
    await checkCatalog(page, other, deep, "NetBox", home, { root: "/", connectionName: "SFTP fixture" });
    await enterFromCatalog(page, other, "Remote machine", "Saved Dirlume Server");
    for (const name of folders) await row(page, other, name).dblclick();
    await checkCatalog(page, other, deep, "Remote machine", home, { root: "/", connectionName: "Server fixture" });
    await checkLan(page, other);
    await button(pane(page, other), `Locations for ${other} pane`).click();
    await button(pane(page, other), "Home").click();
    await waitPath(page, other, home);
    if (index === 0) {
      const breadcrumbs = crumbs(page, side);
      await breadcrumbs.hover();
      await button(breadcrumbs, `Edit ${side} path`).click();
      const address = pane(page, side).getByRole("combobox", { name: `${side} path`, exact: true });
      await address.fill(smbDeep);
      await address.press("Enter");
      await checkCatalog(page, side, smbDeep, "SMB", home, { root: smbRoot, connectionName: "fixture" });
      await enterFromCatalog(page, other, "Remote machine", "Saved KSwitcher");
      for (const name of ["C:", ...folders]) await row(page, other, name).dblclick();
      await checkCatalog(page, other, bridgeDeep, "Remote machine", home, { root: "", connectionName: "Saved KSwitcher" });
    }
    await enterFromCatalog(page, side, "NetBox", "Saved FTP");
    await waitPath(page, side, deep);
    await page.evaluate(() => { window.connectionFixture.failProfiles = true; });
    const ftp = button(crumbs(page, side), "Open NetBox connection list");
    await ftp.click();
    await pane(page, side).getByRole("alert").filter({ hasText: "Could not read FTP profiles." }).waitFor();
    await waitPath(page, side, "NetBox");
    await page.evaluate(() => Object.assign(window.connectionFixture, { failProfiles: false, offline: true, attempts: 0 }));
    await button(pane(page, side), "Refresh connections").click();
    await waitPath(page, side, "NetBox");
    assert.equal(await page.evaluate(() => window.connectionFixture.attempts), 0);
    await page.evaluate(() => { window.connectionFixture.offline = false; });
    await enterFromCatalog(page, other, "NetBox", "Saved SFTP");
    await waitPath(page, other, deep);
    await page.evaluate(() => { window.connectionFixture.emptySsh = true; });
    await button(crumbs(page, other), "Open NetBox connection list").click();
    await waitPath(page, other, "NetBox");
    await checkSourceRoot(page, other, "NetBox");
    await list(page, other).press("Shift+F4");
    await page.getByRole("dialog", { name: "Add NetBox connection", exact: true }).waitFor();
    await page.close();
  }
  console.log("Verified retained local, archive, and remote trails, overflow folders, and catalog Back and Forward navigation.");
  for (const platform of platforms.slice(0, 2)) {
    const { page } = await fixture(browser, platform);
    await checkDirectoryCache(page);
    await page.close();
  }
  console.log("Verified NetBox cached Back and Forward, manual refresh, and the remembered path on reconnect.");
  const { page } = await fixture(browser, platforms[0]);
  await checkKSwitcherOperations(page);
  await page.close();
  const archive = await fixture(browser, platforms[1]);
  await archive.page.evaluate(() => { window.connectionFixture.measureArchive = true; });
  await row(archive.page, "left", "fixture.zip").dblclick();
  await row(archive.page, "left", "..").click();
  await list(archive.page, "left").press("F3");
  await row(archive.page, "left", folders[0]).getByText("3 KiB", { exact: true }).waitFor();
  await archive.page.close();
  const treeSources = await fixture(browser, platforms[1]);
  await checkTreeSources(treeSources.page);
  await treeSources.page.close();
  console.log("Verified KSwitcher transfer routing across drives, revision-checked editing, rename, folder creation, and remote Trash.");
  console.log("Verified parent-row measures through KSwitcher and archived uncompressed file sizes.");
  console.log("Verified read-only Server and archive Trees and nested archive create, rename, delete, and move to a local pane.");
} finally {
  await browser.close();
}
