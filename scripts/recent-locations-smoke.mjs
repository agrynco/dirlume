import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const store = "dirlume.recent-locations.v1";
const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const filePane = (page, side) => page.getByRole("region", { name: side + " pane", exact: true });
const recentPane = (page, side) => page.getByRole("region", { name: "Recent locations in " + side + " pane", exact: true });
const fileRow = (page, side, name) => page.locator('#' + side + '-files [data-tooltip=' + JSON.stringify(name) + ']');
const stored = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "[]"), store);
const calls = (page) => page.evaluate(() => window.recentFixture.calls);
const waitPath = (page, side, path) => page.waitForFunction(({ side, path }) =>
  document.getElementById(side + "-path")?.dataset.path === path &&
  document.getElementById(side + "-files")?.getAttribute("aria-busy") === "false", { side, path });

async function openSource(page, side, source, scope = filePane(page, side)) {
  await button(scope, "Locations for " + side + " pane").click();
  const menu = page.getByRole("group", { name: (side === "left" ? "Left" : "Right") + " pane sources", exact: true });
  if (source === "Recent") {
    const labels = await menu.getByRole("button").allTextContents();
    const downloads = labels.findIndex((label) => label.trim() === "Downloads");
    assert.ok(downloads >= 0);
    assert.equal(labels[downloads + 1]?.trim(), "Recent");
  }
  await button(menu, source).click();
}

async function chooseRecent(page, side, filter, viaMouse = false) {
  const pane = recentPane(page, side);
  const search = pane.getByRole("searchbox", { name: "Filter recent locations", exact: true });
  await search.fill(filter);
  const row = pane.getByRole("option");
  await row.waitFor();
  if (viaMouse) await row.dblclick();
  else await search.press("Enter");
}

const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const platform of ["Windows NT 10.0; Win64; x64", "X11; Linux x86_64", "Macintosh; Intel Mac OS X 10_15_7"]) {
    const windows = platform.startsWith("Windows");
    const home = windows ? "C:\\fixture" : "/fixture";
    const sep = windows ? "\\" : "/";
    const local = home + sep + "Local folder";
    const downloads = home + sep + "Downloads folder";
    const smb = "\\\\RemoteShare\\Files\\nested";
    const page = await browser.newPage({ userAgent: "Mozilla/5.0 (" + platform + ")", viewport: { width: 1180, height: 700 }, locale: "en-US" });
    page.setDefaultTimeout(8000);
    await page.route("http://dirlume.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    await page.addInitScript(({ home, local, downloads, sep, smb, windows }) => {
      const state = window.recentFixture = { calls: [], offline: false, verifySsh: false, smbCredentials: false };
      if (!localStorage.getItem("dirlume.remote-connections")) {
        localStorage.setItem("dirlume.remote-connections", JSON.stringify([
          { kind: "server", id: "server-profile", label: "Saved Server", credential: "SECRET-invitation" },
        ]));
      }
      localStorage.setItem("dirlume.smb-locations", JSON.stringify([
        { kind: "smb", id: "smb-profile", label: "Saved SMB", path: smb },
      ]));
      const folder = (name) => ({ name, directory: true, hidden: false, link: false, size: null, modified: null });
      const listing = (entries = []) => ({ entries, omitted: 0, elevated: false });
      const nested = (segments) => segments.length ? listing() : listing([folder("nested")]);
      const localListing = (path) => ({
        path, parent: path === home ? null : path.slice(0, path.lastIndexOf(sep)),
        ...listing(path === home ? [folder("Local folder"), folder("Downloads folder")] : []),
      });
      const network = (kind, id, address, segments = []) => ({
        id, address, origin: kind + "://fixture", segments, listing: nested(segments),
      });
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args = {}) => {
          switch (command) {
            case "locations": return [{ label: "Home", path: home }, { label: "Downloads", path: downloads }];
            case "list_directory": return localListing(args.path);
            case "file_icons": return args.items.map(() => null);
            case "ftp_profiles": return [{ id: "ftp-profile", label: "Saved FTP", host: "ftp.example", port: 21, hasSecret: true }];
            case "ssh_profiles": return [{ id: "ssh-profile", label: "Saved SFTP", host: "ssh.example", port: 22, hasSecret: true }];
            case "connect_ftp":
              state.calls.push([command, args.id, args.segments ?? []]);
              if (state.offline) throw "Connect to the FTP host and try again.";
              return network("ftp", 1234, "Transfer fixture host", args.segments);
            case "connect_ssh":
              state.calls.push([command, args.id, args.segments ?? [], args.approvals?.length ?? 0]);
              if (state.verifySsh && !args.approvals?.length) {
                return { kind: "verifyHost", verification: { host: "ssh.example", port: 22, fingerprint: "SHA256:fixture" } };
              }
              return { kind: "connected", ...network("ssh", 5678, "Secure fixture host", args.segments) };
            case "connect_saved_server":
              state.calls.push([command, args.segments ?? []]);
              assertCredential(args.credential);
              return { ...network("https", 9012, "Server fixture host", args.segments), share: "share-id" };
            case "list_ftp":
            case "list_ssh":
            case "list_server": return nested(args.segments);
            case "connect_smb":
              state.calls.push([command, args.path, !!args.credentials]);
              return state.smbCredentials && !args.credentials ? { kind: "credentials_required" } :
                { kind: "opened", listing: { ...localListing(args.path), parent: "\\\\RemoteShare\\Files" }, warning: null };
            case "kswitcher_peers": return windows ? [{ id: "peer-1", name: "KS fixture host", online: true }] : [];
            case "list_kswitcher":
              if (!args.path) return { ...listing(), parent: null, drives: [{ name: "C:", type: 3, total: null, available: null }] };
              state.calls.push([command, args.peer, args.path]);
              return args.path === "C:\\" ? { ...listing([folder("nested")]), parent: "" } : { ...listing(), parent: "C:\\" };
            default: return null;
          }
        },
      };
      function assertCredential(credential) {
        if (credential !== "SECRET-invitation") throw Error("Expected the saved invitation to be loaded only at reconnect");
      }
    }, { home, local, downloads, sep, smb, windows });

    await page.goto("http://dirlume.test/");
    await waitPath(page, "left", home);
    await waitPath(page, "right", downloads);
    await openSource(page, "left", "Recent");
    const leftRecent = recentPane(page, "left");
    const rightRecent = recentPane(page, "right");
    await leftRecent.getByText("No recent locations yet.", { exact: true }).waitFor();
    assert.deepEqual(await stored(page), []);
    await button(leftRecent, "Back to files").click();

    await fileRow(page, "left", "Local folder").dblclick();
    await waitPath(page, "left", local);
    const providers = [["FTP", "Saved FTP"], ["SSH", "Saved SFTP"], ["Remote machine", "Saved Server"]];
    for (const [name, profile] of providers) {
      await openSource(page, "left", name);
      await fileRow(page, "left", profile).dblclick();
      await fileRow(page, "left", "nested").dblclick();
      await waitPath(page, "left", "/nested");
    }
    if (windows) {
      await openSource(page, "left", "SMB");
      await fileRow(page, "left", "Saved SMB").dblclick();
      await waitPath(page, "left", smb);
      await button(filePane(page, "left"), "Locations for left pane").click();
      await page.getByRole("group", { name: "KS fixture host", exact: true }).getByRole("button", { name: /^C:.*Fixed/ }).click();
      await fileRow(page, "left", "nested").dblclick();
      await waitPath(page, "left", "C:\\nested");
    }
    await openSource(page, "left", "Home");
    await waitPath(page, "left", home);
    const snapshot = await stored(page);
    assert.equal(snapshot[0].path, home);
    assert.equal(snapshot.filter(({ segments }) => segments?.join("/") === "nested").length, 3);
    assert.equal(snapshot.some(({ kind }) => kind === "smb"), windows);
    assert.equal(snapshot.some(({ kind }) => kind === "kswitcher"), windows);
    assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|credential|\b(1234|5678|9012)\b/);

    await page.reload();
    await waitPath(page, "left", home);
    await waitPath(page, "right", downloads);
    await button(filePane(page, "right"), "Refresh folder").click();
    await waitPath(page, "right", downloads);
    const before = await calls(page);
    await openSource(page, "right", "Recent");
    await rightRecent.getByRole("searchbox").waitFor();
    assert.deepEqual(await calls(page), before);
    assert.deepEqual(await stored(page), snapshot);
    await rightRecent.getByRole("searchbox").fill("no such folder");
    await rightRecent.getByText("No recent locations match the filter.", { exact: true }).waitFor();

    await page.evaluate(() => { window.recentFixture.offline = true; });
    await chooseRecent(page, "right", "/nested transfer");
    await rightRecent.getByRole("alert").filter({ hasText: "Connect to the FTP host" }).waitFor();
    assert.deepEqual(await stored(page), snapshot);
    await page.evaluate(() => { window.recentFixture.offline = false; });
    await chooseRecent(page, "right", "/nested transfer", true);
    await waitPath(page, "right", "/nested");
    await waitPath(page, "left", home);
    assert.deepEqual((await calls(page)).at(-1), ["connect_ftp", "ftp-profile", ["nested"]]);
    assert.equal((await stored(page))[0].kind, "ftp");

    await openSource(page, "right", "Recent");
    await page.evaluate(() => { window.recentFixture.verifySsh = true; });
    await chooseRecent(page, "right", "/nested secure");
    const trust = page.getByRole("dialog", { name: "Verify SSH server", exact: true });
    await button(trust, "Cancel").click();
    await rightRecent.getByRole("searchbox").waitFor();
    assert.equal((await stored(page))[0].kind, "ftp");
    await chooseRecent(page, "right", "/nested secure");
    await button(trust, "Trust and connect").click();
    await rightRecent.waitFor({ state: "hidden" });
    assert.deepEqual((await calls(page)).at(-1), ["connect_ssh", "ssh-profile", ["nested"], 1]);

    await openSource(page, "right", "Recent");
    await chooseRecent(page, "right", "/nested Dirlume server");
    await rightRecent.waitFor({ state: "hidden" });
    assert.deepEqual((await calls(page)).at(-1), ["connect_saved_server", ["nested"]]);

    if (windows) {
      await openSource(page, "right", "Recent");
      await page.evaluate(() => { window.recentFixture.smbCredentials = true; });
      await chooseRecent(page, "right", smb);
      const connect = page.getByRole("dialog", { name: "Connect to SMB", exact: true });
      await connect.getByLabel("Username", { exact: true }).fill("user");
      await connect.getByLabel("Password", { exact: true }).fill("SECRET-password");
      await button(connect, "Connect").click();
      await waitPath(page, "right", smb);
      assert.deepEqual((await calls(page)).at(-1), ["connect_smb", smb, true]);
      await openSource(page, "right", "Recent");
      await chooseRecent(page, "right", "C:\\nested");
      await waitPath(page, "right", "C:\\nested");
      assert.deepEqual((await calls(page)).at(-1), ["list_kswitcher", "peer-1", "C:\\nested"]);
    }

    await openSource(page, "right", "Recent");
    await chooseRecent(page, "right", local);
    await waitPath(page, "right", local);
    await waitPath(page, "left", home);
    await openSource(page, "left", "Recent");
    const leftFilter = leftRecent.getByRole("searchbox");
    await leftFilter.fill(local);
    await leftFilter.press("ArrowDown");
    await page.keyboard.press("Tab");
    assert.equal(await button(leftRecent, "Open folder").evaluate((node) => document.activeElement === node), true);
    await page.keyboard.press("Tab");
    assert.equal(await button(leftRecent, "Remove from Recent").evaluate((node) => document.activeElement === node), true);
    await page.keyboard.press("Enter");
    await leftRecent.getByText("No recent locations match the filter.", { exact: true }).waitFor();
    assert.equal((await stored(page)).some(({ path }) => path === local), false);
    await page.setViewportSize({ width: 680, height: 640 });
    assert.equal(await leftRecent.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
    await page.evaluate(() => { localStorage.setItem("dirlume.remote-connections", "[]"); });
    await chooseRecent(page, "left", "/nested Dirlume server");
    await leftRecent.getByRole("alert").filter({ hasText: "This saved connection is missing." }).waitFor();
    assert.ok((await stored(page)).some(({ kind, segments }) => kind === "server" && segments.join("/") === "nested"));

    await page.evaluate(({ key, home, sep }) => {
      localStorage.setItem(key, JSON.stringify(Array.from({ length: 100 }, (_, index) => ({
        kind: "local", name: "Remembered " + index, source: "", path: home + sep + index,
      }))));
    }, { key: store, home, sep });
    await page.reload();
    await waitPath(page, "left", home);
    await fileRow(page, "left", "Local folder").dblclick();
    await waitPath(page, "left", local);
    const full = await stored(page);
    assert.equal(full.length, 100);
    assert.equal(full[0].path, local);
    assert.equal(full.at(-1).path, home + sep + "98");
    await openSource(page, "left", "Recent");
    await button(leftRecent, "Clear Recent").click();
    await button(page.getByRole("dialog", { name: "Clear Recent", exact: true }), "Clear Recent").click();
    await leftRecent.getByText("No recent locations yet.", { exact: true }).waitFor();
    await page.reload();
    await waitPath(page, "left", local);
    assert.deepEqual(await stored(page), []);
    await page.close();
    console.log("Verified shared Recent history, persistence, eviction, and provider reconnection for " + platform + ".");
  }
} finally {
  await browser.close();
}
