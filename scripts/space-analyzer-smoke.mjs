import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const row = (scope, name) => scope.locator(".space-tree-row").filter({ has: scope.page().getByText(name, { exact: true }) });
const pane = (page, side) => page.getByRole("region", { name: side + " pane", exact: true });

async function finished(analyzer) {
  await button(analyzer, "Rescan").waitFor();
  await button(analyzer, "Stop").waitFor({ state: "hidden" });
}

async function assertBreadcrumbs(analyzer, names) {
  const bar = analyzer.locator(".space-target .address-breadcrumbs");
  assert.deepEqual(await bar.locator(".address-ancestor > span, .address-current").allTextContents(), names);
  assert.equal(await bar.locator(".address-ancestor > svg").count(), names.length - 1);
  assert.equal(await bar.getByRole("button").count(), 0);
}

async function fixture(browser, layout, source = "local") {
  const windows = ["local", "long", "unc", "kswitcher"].includes(source);
  const page = await browser.newPage({ viewport: { width: 1120, height: 760 },
    userAgent: windows ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" : source === "mac" ?
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" : "Mozilla/5.0 (X11; Linux x86_64)" });
  page.setDefaultTimeout(8000);
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  await page.addInitScript(({ windows, layout, source }) => {
    const joiner = windows ? "\\" : "/";
    const base = source === "unc" ? "\\\\fixture\\storage" : source === "long" ?
      "C:\\A long directory with many characters\\Another long directory with many characters" :
      windows ? "C:\\fixture\\mount" : source === "mac" ? "/Users/fixture" : "/mnt/samba";
    const folder = base + joiner + "open";
    const other = windows ? "C:\\other" : "/other";
    const gib = 1024 ** 3;
    const file = (name, size, allocated, allocationId) => ({
      name, directory: false, link: false, hidden: name.startsWith("."), size, allocated, allocationId, modified: null,
    });
    const dir = (name, link = false) => ({ ...file(name, null), directory: true, link });
    const listing = (entries) => ({ entries, omitted: 0 });
    const fileA = file("payload.dat", Math.round(7.2 * gib), Math.round(7.2 * gib));
    const branchExtra = Math.round(9.6 * gib) - fileA.allocated;
    const large = 20 * gib - fileA.allocated - branchExtra - 4096;
    const top = [dir("branch"), file("largest.dat", 1, large), dir("empty"), dir("locked"),
      file("shared-a", 4096, 4096, "unique"), file("shared-b", 4096, 4096, "unique"),
      file(".hidden", 0, 0), file("unknown", null), dir("outside-link", true)];
    const logical = (segments, withAllocations = false) => {
      if (!segments.length) return listing([dir("open"), dir("outside-root")]);
      if (segments.join("/") === "open") return listing([dir("nested"), dir("broken"), dir("link", true)]);
      if (segments.at(-1) === "broken") throw new Error(window.spaceFailure || "Permission denied");
      if (segments.at(-1) === "outside-root") return listing([]);
      return listing([file("remote.dat", 1234, withAllocations ? 4096 : undefined)]);
    };
    localStorage.setItem("dirlume.preferences.v1", JSON.stringify({ layout, kswitcher: "Fixture bridge" }));
    localStorage.setItem("dirlume.remote-connections", JSON.stringify([
      { kind: "server", id: "server", label: "Server fixture", credential: "fixture-invitation" },
      { kind: "kswitcher", id: "kswitcher", label: "Bridge fixture", peer: "fixture-peer" },
    ]));
    window.spaceCalls = [];
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args = {}) => {
        switch (command) {
          case "locations": return [{ label: "Home", path: folder }, { label: "Downloads", path: other }];
          case "disk_space": return source === "local" ? { available: 1_000_000, total: 2_000_000 } : null;
          case "space_mount": return { path: base, share: source === "unc" || source === "mounted" };
          case "list_directory":
            return { path: args.path, parent: null, ...listing(args.path === folder
              ? [dir("branch"), ...Array.from({ length: 135 }, (_, i) => file("row-" + i, i))] : [fileA]) };
          case "connect_smb":
            return { kind: "opened", warning: null, listing: { path: args.path, parent: null, ...listing([dir("open")]) } };
          case "scan_local_space": {
            window.spaceCalls.push({ command, root: args.root });
            const send = (event) => args.output.onmessage(event);
            const batch = (...changes) => send({ kind: "batch", changes });
            const child = (parent, entry) => ({ parent, name: entry.name, directory: entry.directory,
              size: entry.size, allocated: entry.allocated ?? null, shared: false });
            const closed = (id, error = null) => ({ closed: id, error, partial: !!error });
            send({ kind: "start", strategy: "mft" });
            batch(child(0, file("discarded-before-fallback", 123, 4096)));
            send({ kind: "start", strategy: "walk" });
            if (window.failSpaceRoot) throw new Error("Permission denied");
            if (args.root === base) {
              batch(child(0, file("root-only", 1, 4096)), closed(0));
            } else {
              const children = top.filter((entry) => !entry.link).map((entry) => child(0, entry));
              Object.assign(children.find((entry) => entry.name === "shared-b"), { shared: true, allocated: 0 });
              batch(...children, closed(0));
              if (window.holdSpace) {
                await new Promise((resolve) => { window.finishOldSpace = resolve; });
                batch(child(1, file("stale.dat", large, large)));
              } else {
                const sub = children.length + 1;
                batch(child(1, dir("sub")), child(1, file("extra.dat", 2, branchExtra)), closed(1),
                  child(sub, fileA), closed(sub), closed(3), closed(4, "Permission denied"));
              }
            }
            send({ kind: "finished" });
            return;
          }
          case "cancel_space_scan": window.spaceCalls.push({ command, id: args.id }); return;

          case "ftp_profiles": return [{ id: "ftp", label: "FTP fixture", host: "fixture", port: 21 }];
          case "ssh_profiles": return [{ id: "sftp", label: "SFTP fixture", host: "fixture", port: 22 }];
          case "connect_ftp": return { id: 1, address: "fixture", origin: "ftp://fixture", segments: ["open"], listing: logical(["open"]) };
          case "connect_ssh": return { kind: "connected", id: 2, address: "fixture", origin: "sftp://fixture",
            segments: ["open"], listing: logical(["open"]) };
          case "connect_saved_server": return { id: 3, origin: "https://fixture", address: "fixture", share: "fixture-share", listing: logical([]) };
          case "list_ftp":
          case "list_ssh":
          case "list_server":
            window.spaceCalls.push({ command, ...args });
            return { ...logical(args.segments, command === "list_server"), elevated: false };
          case "list_kswitcher": {
            window.spaceCalls.push({ command, ...args });
            const path = args.path.split("\\").filter(Boolean);
            if (!path.length) return { ...listing([dir("D:")]), parent: "" };
            return { ...logical(path.slice(1)), parent: path.length === 1 ? "" : path.slice(0, -1).join("\\") + "\\" };
          }
          case "file_icons": return args.items.map(() => null);
          default: return null;
        }
      },
    };
  }, { windows, layout, source });
  await page.goto("http://dirlume.test/");
  await button(pane(page, "left"), "Analyze space").waitFor();
  return page;
}

async function openSource(page, menu, profile) {
  const left = pane(page, "left");
  await button(left, "Locations for left pane").click();
  await button(left, menu).click();
  await left.getByRole("option", { name: new RegExp("^" + profile) }).dblclick();
}

const browser = await chromium.launch({ channel: "chrome" });
try {
  const local = await fixture(browser, "standard");
  const left = pane(local, "left");
  const files = left.getByRole("listbox", { name: "left files" });
  await files.getByRole("option", { name: /^branch/ }).click();
  await files.evaluate((node) => { node.scrollTop = 740; });
  const scroll = await files.evaluate((node) => node.scrollTop);
  assert.ok(scroll > 0);
  const chosen = await files.getAttribute("aria-activedescendant");
  await button(left, "Analyze space").click();
  const analyzer = local.getByRole("region", { name: "Space Analyzer", exact: true });
  await finished(analyzer);
  await assertBreadcrumbs(analyzer, ["C:", "fixture", "mount", "open"]);
  assert.ok((await local.evaluate(() => window.spaceCalls[0].root)).endsWith("\\mount\\open"));
  const grid = analyzer.getByRole("treegrid");
  const roots = await grid.locator(".space-entry-label").allTextContents();
  assert.deepEqual(roots.slice(0, 3), ["open", "largest.dat", "branch"]);
  assert.ok(!roots.includes("outside-link"));
  assert.ok(!roots.includes("discarded-before-fallback"));
  assert.match(await row(grid, "branch").locator(".space-size").innerText(), /48%/);
  await row(grid, "branch").click();
  await grid.press("ArrowRight");
  await row(grid, "sub").waitFor();
  assert.match(await row(grid, "sub").locator(".space-size").innerText(), /75%/);
  assert.match(await row(grid, "empty").locator(".space-size").innerText(), /0 B\s*0%/);
  await row(grid, "shared-b").getByText("Shared allocation").waitFor();
  await row(grid, "locked").getByText("Unavailable").waitFor();
  await analyzer.getByRole("combobox", { name: "Size metric" }).selectOption("logical");
  assert.equal(await grid.locator(".space-entry-label").nth(1).textContent(), "branch");
  await button(analyzer, "Treemap").click();
  await analyzer.getByRole("button", { name: /^branch,/ }).click();
  await analyzer.getByRole("button", { name: /^sub,/ }).click();
  await analyzer.getByRole("button", { name: /^payload.dat,/ }).click();
  await assertBreadcrumbs(analyzer, ["C:", "fixture", "mount", "open"]);
  await button(analyzer, "Show in other pane").click();
  await pane(local, "right").getByRole("option", { name: /^payload.dat/, selected: true }).waitFor();
  await button(analyzer, "Close").click();
  await files.waitFor();
  await local.waitForFunction(() => document.activeElement?.id === "left-files");
  assert.equal(await files.evaluate((node) => node.scrollTop), scroll);
  assert.equal(await files.getAttribute("aria-activedescendant"), chosen);

  await local.evaluate(() => { window.holdSpace = true; });
  await files.press("Control+Shift+d");
  await local.waitForFunction(() => window.finishOldSpace);
  await row(analyzer, "branch").waitFor();
  const rootsBeforeSwap = await local.evaluate(() => window.spaceCalls.filter(({ command }) => command === "scan_local_space").length);
  await button(analyzer, "Stop").press("Control+u");
  await analyzer.and(local.locator(".space-analyzer-right")).waitFor();
  await button(analyzer, "Stop").waitFor();
  assert.equal(await local.evaluate(() => window.spaceCalls.filter(({ command }) => command === "scan_local_space").length), rootsBeforeSwap);
  await button(analyzer, "Stop").press("Control+u");
  await analyzer.and(local.locator(".space-analyzer-left")).waitFor();
  await button(analyzer, "Stop").click();
  await analyzer.getByRole("status").getByText("Partial results").waitFor();
  assert.ok(await local.evaluate(() => window.spaceCalls.some(({ command }) => command === "cancel_space_scan")));
  await local.evaluate(() => { window.holdSpace = false; });
  await button(analyzer, "Rescan").click();
  await local.evaluate(() => window.finishOldSpace());
  await finished(analyzer);
  await row(analyzer, "branch").dblclick();
  await row(analyzer, "sub").waitFor();
  assert.equal(await row(analyzer, "stale.dat").count(), 0);
  await local.keyboard.press("Escape");
  await analyzer.waitFor({ state: "hidden" });
  await local.evaluate(() => { window.failSpaceRoot = true; });
  await button(left, "Analyze space").click();
  await analyzer.getByRole("alert").getByText(/Could not scan the folder/).waitFor();
  await local.close();

  for (const [layout, source, label] of [["twin", "local", "Analyze volume"], ["classic", "unc", "Analyze share"], ["standard", "mounted", "Analyze share"]]) {
    const page = await fixture(browser, layout, source);
    await page.setViewportSize({ width: 600, height: 500 });
    const right = pane(page, "right");
    const rightFiles = right.getByRole("listbox", { name: "right files" });
    await rightFiles.getByRole("option", { name: /^payload.dat/ }).click();
    await rightFiles.press("Insert");
    await right.locator(".pane-marked").getByText(/1 marked/).waitFor();
    for (const side of ["left", "right"]) {
      const footer = pane(page, side).locator(".pane-footer");
      assert.equal(await footer.locator(":scope > .pane-status-line").count(), 1);
      assert.ok(await footer.locator(".pane-counts").getAttribute("data-tooltip"));
      assert.equal(await footer.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    }
    await page.setViewportSize({ width: 1120, height: 760 });
    await pane(page, "right").locator("summary[aria-label='Analysis scope']").click();
    await pane(page, "right").getByRole("button", { name: new RegExp("^" + label) }).click();
    await row(page.getByRole("region", { name: "Space Analyzer" }), "root-only").waitFor();
    const call = await page.evaluate(() => window.spaceCalls.find((item) => item.command === "scan_local_space"));
    assert.equal(call.root, { local: "C:\\fixture\\mount", unc: "\\\\fixture\\storage", mounted: "/mnt/samba" }[source]);
    await page.close();
  }

  for (const [source, names] of [["mounted", ["/", "mnt", "samba", "open"]], ["mac", ["/", "Users", "fixture", "open"]],
    ["long", ["C:", "A long directory with many characters", "Another long directory with many characters", "open"]]]) {
    const page = await fixture(browser, "standard", source);
    await button(pane(page, "left"), "Analyze space").click();
    const target = page.getByRole("region", { name: "Space Analyzer", exact: true });
    await finished(target);
    await assertBreadcrumbs(target, names);
    if (source === "long") {
      await page.setViewportSize({ width: 600, height: 500 });
      await target.locator(".address-ellipsis").waitFor();
      assert.equal(await target.locator(".address-current").evaluate((current) =>
        current.getBoundingClientRect().right <= current.closest(".address-crumb-clip").getBoundingClientRect().right + 1), true);
      assert.equal(await target.locator(".address-breadcrumbs").getAttribute("title"), names.join("\\"));
    }
    await page.close();
  }

  for (const [menu, profile, source, label] of [
    ["FTP", "FTP fixture", "ftp", "Analyze connection root"],
    ["FTP", "SFTP fixture", "ssh", "Analyze connection root"],
    ["SSH", "SFTP fixture", "ssh", "Analyze connection root"],
    ["Remote machine", "Server fixture", "server", "Analyze share"],
    ["Remote machine", "Bridge fixture", "kswitcher", "Analyze share"],
  ]) {
    const page = await fixture(browser, "twin", source);
    const left = pane(page, "left");
    await openSource(page, menu, profile);
    if (source === "kswitcher") await left.getByRole("option", { name: /^D:/ }).dblclick();
    if (source === "server" || source === "kswitcher") await left.getByRole("option", { name: /^open/ }).dblclick();
    await left.getByRole("option", { name: /^nested/ }).waitFor();
    await page.evaluate(() => { window.spaceCalls = []; });
    await button(left, "Analyze space").click();
    const remote = page.getByRole("region", { name: "Space Analyzer", exact: true });
    await finished(remote);
    await remote.getByRole("status").getByText("Partial results").waitFor();
    if (source === "server") assert.equal(await remote.getByRole("combobox", { name: "Size metric" }).inputValue(), "allocated");
    else await remote.getByText("File size", { exact: true }).waitFor();
    await row(remote, "broken").getByText("Unavailable").waitFor();
    if (source === "ftp") {
      await assertBreadcrumbs(remote, ["fixture", "open"]);
      await page.evaluate(() => { window.spaceFailure = "Connection reset by peer"; });
      await button(remote, "Rescan").click();
      await remote.getByRole("alert").filter({ hasText: "Reconnect and rescan." }).waitFor();
      await row(remote, "nested").getByText(/1\.2\d* KiB/).waitFor();
      await page.evaluate(() => { window.spaceFailure = ""; });
      await button(remote, "Rescan").click();
      await remote.getByRole("alert").waitFor({ state: "hidden" });
      await finished(remote);
      await assertBreadcrumbs(remote, ["fixture", "open"]);
    }
    await row(remote, "nested").dblclick();
    await row(remote, "remote.dat").click();
    await button(remote, "Show in other pane").click();
    await pane(page, "right").getByRole("option", { name: /^remote.dat/, selected: true }).waitFor();
    assert.equal(await remote.isVisible(), true);
    const calls = await page.evaluate(() => window.spaceCalls);
    assert.ok(calls.every((call) => call.segments?.[0] === "open" || call.path?.startsWith("D:\\open")));
    await button(remote, "Close").click();
    await left.locator("summary[aria-label='Analysis scope']").click();
    await left.getByRole("button", { name: new RegExp("^" + label) }).click();
    await row(remote, "outside-root").waitFor();
    await page.close();
  }
  console.log("Verified pane controls, metric bars, treemap, scan cancellation and provider scopes.");
} finally {
  await browser.close();
}
