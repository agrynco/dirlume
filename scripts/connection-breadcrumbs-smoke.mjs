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
    const state = window.connectionFixture = { attempts: 0, offline: false, failProfiles: false, emptySsh: false };
    if (nestedLocal) {
      const place = { kind: "local", path, parent: path.slice(0, path.lastIndexOf(separator)) };
      localStorage.setItem("dirlume.workspace.v1", JSON.stringify({
        panels: { left: { place }, right: { place } }, active: "left", split: 50, documents: [],
      }));
    }
    localStorage.setItem("dirlume.smb-locations", JSON.stringify([smbRoot]));
    localStorage.setItem("dirlume.preferences.v1", JSON.stringify({ kswitcher: "fixture-bridge" }));
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
          return [{ id: "ftp", label: "Saved FTP", host: "fixture", port: 21 }];
        }
        if (command === "ssh_profiles") return state.emptySsh ? [] : [{ id: "ssh", label: "Saved SFTP", host: "fixture", port: 22 }];
        if (command === "connect_ftp") return remote({ id: 4, address: "FTP fixture", origin: "ftp://fixture",
          segments: args.segments ?? folders, listing: listing(folders.length) });
        if (command === "connect_ssh") return remote({ kind: "connected", id: 5, address: "SFTP fixture", origin: "sftp://fixture",
          segments: folders, listing: listing(folders.length) });
        if (command === "list_saved_computer_drives") return [{ name: "Files", type: 3, total: null, available: null }];
        if (command === "connect_saved_server") return remote({ id: args.credential === "fixture-pair" ? 8 : 6,
          share: "share", address: "Server fixture", origin: "https://fixture", listing: listing(0) });
        if (command === "open_archive") return { id: 7, path: args.path, parent: home, writable: false, canAdd: false, listing: listing(0) };
        if (command === "list_archive") return listing(args.segments.length);
        if (["list_ftp", "list_ssh", "list_server"].includes(command)) {
          const segments = args.segments;
          const depth = segments[0] === "Files" ? segments.length - 1 : segments.length;
          return remote(listing(depth));
        }
        if (command === "list_kswitcher") {
          const parts = args.path.split("\\").filter(Boolean);
          const parent = parts.length === 0 ? null : parts.length === 1 ? "" : parts.length === 2 ? parts[0] + "\\" : parts.slice(0, -1).join("\\");
          return remote({ parent, omitted: 0, entries: parts.length ? entries(parts.length - 1) : [folder("C:")] });
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

async function checkCatalog(page, side, path, name, home, { key = "Enter", root, connectionName } = {}) {
  const other = side === "left" ? "right" : "left";
  await waitPath(page, side, path);
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
  await clickCrumb(address, folders.at(-1));
  await waitPath(page, side, path);
  await clickCrumb(address, connectionName);
  await waitPath(page, side, root);
  await source.click();
  await waitPath(page, side, name);
  assert.equal(await address.locator("[aria-current=location]").innerText(), name);
  const hidden = button(address, "Show hidden folders");
  await hidden.waitFor();
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
  }
  await dragTo(0.21);
  const address = crumbs(page, "left");
  await button(address, "Show parent folders").click();
  const parents = address.locator(".address-parents");
  await button(parents, root).waitFor();
  await button(parents, "fixture").click();
  await waitPath(page, "left", home);
  assert.equal(await page.locator("#right-path").getAttribute("data-path"), path);
  const forward = address.locator(".address-forward");
  const hiddenFolders = button(address, "Show hidden folders");
  await hiddenFolders.click();
  await button(address.locator(".address-parents"), folders.at(-1)).waitFor();
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

async function checkLan(page, side) {
  await button(pane(page, side), `Locations for ${side} pane`).click();
  const host = page.getByRole("group", { name: "Paired fixture", exact: true });
  await host.getByRole("button", { name: /^Files/ }).click();
  await waitPath(page, side, "/Files");
  for (const name of folders) await row(page, side, name).dblclick();
  await waitPath(page, side, "/Files" + deep);
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
    for (const [source, saved, connectionName] of [["FTP", "Saved FTP", "FTP fixture"],
      ["FTP", "Saved SFTP", "SFTP fixture"], ["SSH", "Saved SFTP", "SFTP fixture"]]) {
      await enterFromCatalog(page, side, source, saved);
      await checkCatalog(page, side, deep, source, home, { key: "Space", root: "/", connectionName });
    }
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
    await enterFromCatalog(page, side, "FTP", "Saved FTP");
    await waitPath(page, side, deep);
    await page.evaluate(() => { window.connectionFixture.failProfiles = true; });
    const ftp = button(crumbs(page, side), "Open FTP connection list");
    await ftp.click();
    await pane(page, side).getByRole("alert").filter({ hasText: "Could not read FTP profiles." }).waitFor();
    await waitPath(page, side, deep);
    await page.evaluate(() => Object.assign(window.connectionFixture, { failProfiles: false, offline: true, attempts: 0 }));
    await ftp.click();
    await waitPath(page, side, "FTP");
    assert.equal(await page.evaluate(() => window.connectionFixture.attempts), 0);
    await page.evaluate(() => { window.connectionFixture.offline = false; });
    await enterFromCatalog(page, other, "SSH", "Saved SFTP");
    await waitPath(page, other, deep);
    await page.evaluate(() => { window.connectionFixture.emptySsh = true; });
    await button(crumbs(page, other), "Open SSH connection list").click();
    await waitPath(page, other, "SSH");
    await list(page, other).press("Shift+F4");
    await page.getByRole("dialog", { name: "Add SSH connection", exact: true }).waitFor();
    await page.close();
  }
  console.log("Verified retained local, archive, and remote trails, overflow folders, and catalog Back and Forward navigation.");
} finally {
  await browser.close();
}
