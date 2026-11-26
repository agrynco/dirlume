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
  assert.deepEqual(await bar.locator(".address-ancestor > button, .address-current").allTextContents(), names);
  assert.equal(await bar.locator(".address-ancestor > svg").count(), names.length - 1);
  assert.equal(await bar.locator(".address-ancestor > button").count(), names.length - 1);
}

async function fixture(browser, layout, source = "local", diskBinding) {
  const windows = ["local", "long", "unc", "kswitcher"].includes(source);
  const page = await browser.newPage({ viewport: { width: 1120, height: 760 },
    userAgent: windows ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" : source === "mac" ?
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" : "Mozilla/5.0 (X11; Linux x86_64)" });
  page.setDefaultTimeout(8000);
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  await page.addInitScript(({ windows, layout, source, diskBinding }) => {
    const joiner = windows ? "\\" : "/";
    const base = source === "unc" ? "\\\\fixture\\storage" : source === "long" ?
      "C:\\A long directory with many characters\\Another long directory with many characters" :
      windows ? "C:\\fixture\\mount" : source === "mac" ? "/Users/fixture" : "/mnt/samba";
    const folder = base + joiner + "open";
    const other = windows ? "D:\\other" : "/other";
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
    if (!localStorage.getItem("dirlume.preferences.v1")) {
      const preferences = { layout, kswitcher: "Fixture bridge" };
      if (diskBinding !== undefined) Object.assign(preferences, { bindingDefaults: 9,
        activeShortcutScheme: "fixture", shortcutSchemes: [{ id: "fixture", name: "Fixture keys",
          bindings: { diskInformation: diskBinding ? [diskBinding] : [] } }] });
      localStorage.setItem("dirlume.preferences.v1", JSON.stringify(preferences));
    }
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
          case "volume_information":
            window.spaceCalls.push({ command, path: args.path });
            if (args.path === other) return { path: other, share: false, label: "Other fixture disk", filesystem: windows ? "NTFS" : "ext4",
              capacity: { total: 8192, available: 4096 } };
            return { path: base, share: source === "unc" || source === "mounted", label: "Fixture disk",
              filesystem: windows ? "NTFS" : "smbfs", capacity: source === "unc" ? null : { total: 4096, available: 1024 } };
          case "space_mount": return { path: base, share: source === "unc" || source === "mounted" };
          case "list_directory":
            if (window.spaceOperationFixture && (args.path.endsWith(joiner + "alpha") || args.path.endsWith(joiner + "beta"))) {
              return { path: args.path, parent: null, ...listing([file("same.txt", 13, 4096)]) };
            }
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
            if (window.denseTreemap) {
              send({ kind: "start", strategy: "walk" });
              const media = Array.from({ length: 16 }, (_, i) => file(`media-${i}.dat`, Math.round(1.4 * gib), 2 * gib));
              const small = Array.from({ length: 54 }, (_, i) => file(`small-${i}.dat`, 8 * 1024 ** 2, 16 * 1024 ** 2));
              batch(child(0, dir("Recordings")), child(0, file("Archive.dat", 6 * gib, 9 * gib)),
                ...[...media, ...small].map((entry) => child(0, entry)), closed(0),
                child(1, file("Video.dat", 10 * gib, 12 * gib)), closed(1));
              send({ kind: "finished" });
              return;
            }
            if (window.spaceOperationFixture) {
              send({ kind: "start", strategy: "walk" });
              batch(child(0, dir("alpha")), child(0, dir("beta")), closed(0),
                child(1, file("same.txt", 7, 4096)), closed(1));
              const name = window.spaceOperationFixture.beta;
              if (name) batch(child(2, file(name, 13, 4096)));
              batch(closed(2));
              if (window.spaceOperationFixture.hold) {
                window.spaceOperationFixture.hold = false;
                await new Promise((resolve) => { window.finishOutdatedScan = resolve; });
                batch(child(2, file("obsolete.txt", 90, 4096)));
              }
              send({ kind: "finished" });
              return;
            }
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
          case "transfer_item":
            window.spaceCalls.push({ command, request: args.request });
            if (args.request.moving && args.request.source.directory === folder + joiner + "beta") {
              window.spaceOperationFixture.beta = args.request.destination.split(joiner).at(-1);
            }
            return { kind: "completed" };

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
  }, { windows, layout, source, diskBinding });
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

async function checkTreemapLabels(page, analyzer) {
  const tile = (name) => analyzer.getByRole("button", { name });
  const hasLabel = (button, fit) => button.locator(`.space-tile-label[data-fit=${fit}]`);
  const metric = analyzer.getByRole("combobox", { name: "Size metric" });
  const tooltip = page.locator(".app-tooltip");
  await button(analyzer, "Treemap").click();
  await hasLabel(tile(/^Recordings, 12 GiB$/), "both").waitFor();
  const more = tile(/^More items, 128 MiB$/);
  await more.hover();
  await tooltip.getByText("More items, 128 MiB", { exact: true }).waitFor();

  await page.setViewportSize({ width: 800, height: 500 });
  const sizeOnly = analyzer.locator('.space-tile-label[data-fit="size"]').first();
  await sizeOnly.locator(":scope > span").waitFor();
  assert.equal(await sizeOnly.locator("strong").isVisible(), false);
  assert.match(await sizeOnly.locator(":scope > span").textContent(), /^\d+(?:[.,]\d+)? [GM]iB$/);
  const hidden = analyzer.locator('.space-tile:has(.space-tile-label[data-fit="none"])').first();
  await hidden.hover();
  const hiddenLabel = await hidden.getAttribute("aria-label");
  await tooltip.getByText(hiddenLabel, { exact: true }).waitFor();
  assert.equal(await hidden.locator(".space-tile-label > span").isVisible(), false);

  await page.setViewportSize({ width: 1120, height: 760 });
  await metric.selectOption("logical");
  const recordings = tile(/^Recordings, 10 GiB$/);
  const label = hasLabel(recordings, "both");
  await label.getByText("10 GiB", { exact: true }).waitFor();
  await button(analyzer, "Treemap").hover();
  await recordings.hover();
  await tooltip.getByText("Recordings, 10 GiB", { exact: true }).waitFor();
  assert.equal(await tile(/^More items, 64 MiB$/).count(), 1);
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
  assert.equal(await analyzer.locator(".space-map-heading > span").textContent(), "branch");
  await analyzer.getByRole("button", { name: /^sub,/ }).click();
  await analyzer.getByRole("button", { name: /^payload.dat,/ }).click();
  await assertBreadcrumbs(analyzer, ["mount", "open", "branch", "sub"]);
  await button(analyzer, "Show in other pane").click();
  await pane(local, "right").getByRole("option", { name: /^payload.dat/, selected: true }).waitFor();
  await button(analyzer, "Close").click();
  await files.waitFor();
  await local.waitForFunction(() => document.activeElement?.id === "left-files");
  assert.equal(await files.evaluate((node) => node.scrollTop), scroll);
  assert.equal(await files.getAttribute("aria-activedescendant"), chosen);

  await local.evaluate(() => { window.holdSpace = true; });
  await files.focus();
  await local.keyboard.down("ControlLeft");
  await local.keyboard.press("Digit5");
  await local.keyboard.up("ControlLeft");
  await local.waitForFunction(() => window.finishOldSpace);
  await button(analyzer, "Tree").click();
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

  for (const source of ["local", "unc", "mounted"]) {
    const page = await fixture(browser, "standard", source);
    const left = pane(page, "left");
    const disk = page.getByRole("region", { name: "Disk information", exact: true });
    const chart = page.locator(".space-analyzer-right");
    const files = left.getByRole("listbox");
    const prior = await files.getAttribute("aria-activedescendant");
    await files.press("Control+Shift+l");
    await disk.getByText("Fixture disk", { exact: true }).waitFor();
    assert.equal(await disk.getAttribute("data-pane-side"), "right");
    assert.equal(await files.isVisible(), true);
    assert.equal(await disk.getByText(source === "mounted" ? "/mnt/samba" : source === "unc" ? "\\\\fixture\\storage" : "C:\\fixture\\mount", { exact: true }).count(), 1);
    assert.deepEqual(await page.evaluate(() => window.spaceCalls.map(({ command }) => command)), ["volume_information"]);
    assert.equal(await disk.getByText(source === "unc" ? "Unavailable" : "25%", { exact: true }).count(), source === "unc" ? 2 : 1);
    if (source === "local") await page.evaluate(() => { window.spaceOperationFixture = { beta: "same.txt", hold: false }; });
    await button(disk, source === "local" ? "Scan volume" : "Scan share").click();
    await finished(chart);
    assert.equal(await button(chart, "Sunburst").getAttribute("aria-pressed"), "true");
    if (source !== "local") {
      await chart.getByRole("button", { name: /^root-only / }).waitFor();
      await button(chart, "Close").click();
      await files.waitFor();
      assert.equal(await files.getAttribute("aria-activedescendant"), prior);
      await page.close();
      continue;
    }
    assert.equal(await chart.locator(".sunburst-chart path[data-depth='1']").count(), 2);
    const matches = chart.getByRole("button", { name: /^same\.txt / });
    await matches.nth(0).click();
    const betaFile = matches.nth(1);
    await betaFile.press("Shift+F10");
    const menu = page.getByRole("menu", { name: "File actions", exact: true });
    await menu.getByRole("menuitem", { name: "Copy", exact: true }).click();
    const copy = page.getByRole("dialog", { name: "Copy", exact: true });
    assert.ok((await copy.locator("label[data-tooltip]").filter({ hasText: "same.txt" }).getAttribute("data-tooltip")).endsWith("\\beta"));
    await button(copy, "Cancel").click();
    assert.equal(await betaFile.evaluate((node) => node === document.activeElement), true);
    const [x, y] = await chart.locator(".sunburst-chart path[data-depth='1']").nth(1).evaluate((sector) => {
      const bounds = sector.getBoundingClientRect();
      for (let y = Math.ceil(bounds.top); y < bounds.bottom; y += 4) {
        for (let x = Math.ceil(bounds.left); x < bounds.right; x += 4) {
          if (document.elementFromPoint(x, y) === sector) return [x, y];
        }
      }
      throw new Error("The chart has no visible target for this sector.");
    });
    await page.mouse.click(x, y, { button: "right" });
    await menu.getByRole("menuitem", { name: "Show in other pane", exact: true }).click();
    await left.getByRole("option", { name: /^same\.txt/, selected: true }).waitFor();
    assert.equal(await button(chart, "Sunburst").getAttribute("aria-pressed"), "true");
    if (process.env.DIRLUME_SUNBURST_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_SUNBURST_SCREENSHOT });
    await button(chart, "Sunburst").click();
    await button(left, "Analyze space").click();
    const leftChart = page.locator(".space-analyzer-left");
    await finished(leftChart);
    assert.equal(await button(leftChart, "Sunburst").getAttribute("aria-pressed"), "true");
    await button(leftChart, "Treemap").click();
    assert.equal(await button(chart, "Sunburst").getAttribute("aria-pressed"), "true");
    await page.reload();
    await button(left, "Analyze space").click();
    await finished(leftChart);
    assert.equal(await button(leftChart, "Treemap").getAttribute("aria-pressed"), "true");
    await page.close();
  }

  for (const source of ["local", "mounted", "mac"]) {
    const page = await fixture(browser, "standard", source);
    const disk = page.getByRole("region", { name: "Disk information", exact: true });
    const state = (side) => page.evaluate((side) => ({
      path: document.getElementById(`${side}-path`).dataset.path,
      current: document.querySelector(`#${side}-files [data-current="true"]`)?.dataset.tooltip,
    }), side);
    for (const [sourceSide, coveredSide, label] of [["left", "right", "Fixture disk"], ["right", "left", "Other fixture disk"]]) {
      const origin = pane(page, sourceSide).getByRole("listbox");
      const covered = pane(page, coveredSide).getByRole("listbox");
      await covered.locator(coveredSide === "left" ? '[data-tooltip="row-5"]' : '[data-tooltip="payload.dat"]').click();
      const originBefore = await state(sourceSide);
      const coveredBefore = await state(coveredSide);
      await origin.focus();
      await page.locator(`#${sourceSide}-pane.active`).waitFor();
      await page.keyboard.press("Control+Shift+l");
      await disk.locator(".disk-identity strong").waitFor();
      assert.equal(await disk.locator(".disk-identity strong").textContent(), label, `${source} ${sourceSide}: ${originBefore.path}`);
      assert.equal(await disk.getAttribute("data-pane-side"), coveredSide);
      assert.equal(await origin.isVisible(), true);
      assert.deepEqual(await state(sourceSide), originBefore);
      assert.deepEqual(await page.evaluate(() => window.spaceCalls.filter(({ command }) => command === "volume_information").at(-1)?.path), originBefore.path);
      await origin.press(source === "mac" ? "Meta+Shift+l" : "Control+Shift+l");
      await covered.waitFor();
      await disk.waitFor({ state: "hidden" });
      assert.deepEqual(await state(coveredSide), coveredBefore);
    }
    await button(pane(page, "right"), "Analyze space").click();
    const analyzer = page.locator(".space-analyzer-right");
    await finished(analyzer);
    const origin = pane(page, "left").getByRole("listbox");
    await origin.focus();
    await page.locator("#left-pane.active").waitFor();
    await page.keyboard.press("Control+Shift+l");
    await disk.waitFor();
    await analyzer.waitFor({ state: "hidden" });
    await button(disk, "Close").press("Control+Shift+l");
    await analyzer.waitFor();
    assert.equal(await disk.count(), 0);
    await page.close();
  }

  for (const binding of ["Ctrl+Alt+L", null]) {
    const page = await fixture(browser, "standard", "local", binding);
    const disk = page.getByRole("region", { name: "Disk information", exact: true });
    const origin = pane(page, "left").getByRole("listbox");
    await origin.press("Control+Shift+l");
    assert.equal(await disk.count(), 0);
    await origin.press("Control+Alt+l");
    if (binding) {
      await disk.getByText("Fixture disk", { exact: true }).waitFor();
      assert.equal(await disk.getAttribute("data-pane-side"), "right");
      await origin.press("Control+Alt+l");
      await disk.waitFor({ state: "hidden" });
    } else assert.equal(await disk.count(), 0);
    await page.close();
  }

  const dense = await fixture(browser, "standard");
  await dense.evaluate(() => { window.denseTreemap = true; });
  await button(pane(dense, "left"), "Analyze space").click();
  const denseAnalyzer = dense.getByRole("region", { name: "Space Analyzer", exact: true });
  await finished(denseAnalyzer);
  await checkTreemapLabels(dense, denseAnalyzer);
  await dense.close();

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
      await button(target, "Show parent folders").waitFor();
      assert.equal(await target.locator(".address-current").evaluate((current) =>
        current.getBoundingClientRect().right <= current.closest(".address-crumb-clip").getBoundingClientRect().right + 1), true);
      assert.equal(await target.locator(".address-breadcrumbs").getAttribute("title"), names.join("\\"));
    }
    await page.close();
  }

  for (const [menu, profile, source, label] of [
    ["NetBox", "FTP fixture", "ftp", "Analyze connection root"],
    ["NetBox", "SFTP fixture", "ssh", "Analyze connection root"],
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
      await button(remote, "Treemap").click();
      await remote.getByRole("button", { name: /^nested, 1\.2\d* KiB$/ }).hover();
      await page.locator(".app-tooltip").getByText(/^nested, 1\.2\d* KiB$/).waitFor();
      await button(remote, "Tree").click();
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
    const listings = calls.filter((call) => !(call.command === "list_kswitcher" && call.path === ""));
    assert.ok(listings.length > 0);
    assert.ok(listings.every((call) => call.segments?.[0] === "open" || call.path?.startsWith("D:\\open")));
    await button(remote, "Close").click();
    await left.locator("summary[aria-label='Analysis scope']").click();
    await left.getByRole("button", { name: new RegExp("^" + label) }).click();
    await row(remote, "outside-root").waitFor();
    await page.close();
  }
  for (const source of ["mac", "mounted"]) {
    const page = await fixture(browser, "standard", source);
    await page.evaluate(() => { window.spaceOperationFixture = { beta: "same.txt", hold: true }; });
    const left = pane(page, "left");
    const right = pane(page, "right");
    await button(right, "Locations for right pane").click();
    await right.getByRole("button", { name: /^Downloads/ }).click();
    await button(left, "Analyze space").click();
    const analyzer = page.getByRole("region", { name: "Space Analyzer", exact: true });
    const tree = analyzer.getByRole("treegrid");
    const root = row(tree, "open");
    const alpha = row(tree, "alpha");
    const beta = row(tree, "beta");
    await alpha.dblclick();
    await beta.dblclick();
    const duplicate = row(tree, "same.txt");
    await duplicate.nth(1).waitFor();
    await duplicate.nth(1).click();
    assert.equal(await analyzer.locator(".address-current").textContent(), "beta");
    await button(analyzer.locator(".space-target"), "open").click();
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "treegrid");
    assert.equal(await root.getAttribute("data-current"), "true");
    assert.equal(await duplicate.count(), 2);
    const rightFiles = right.getByRole("listbox");
    const rightSelection = await rightFiles.getAttribute("aria-activedescendant");
    await page.keyboard.press("Tab");
    await page.waitForFunction(() => document.activeElement?.id === "right-files");
    assert.equal(await rightFiles.getAttribute("aria-activedescendant"), rightSelection);
    await page.keyboard.press("Tab");
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "treegrid");
    if (source === "mounted") {
      await button(right, "Analyze space").click();
      const rightAnalysis = page.locator(".space-analyzer-right");
      await finished(rightAnalysis);
      assert.equal(await page.locator(".space-analyzer-left").isVisible(), true);
      assert.equal(await rightAnalysis.locator(".address-current").textContent(), "other");
      await button(rightAnalysis, "Close").click();
      await rightFiles.waitFor();
    }
    const markModifier = process.platform === "darwin" ? "Meta" : "Control";
    await duplicate.nth(0).click({ modifiers: [markModifier] });
    await duplicate.nth(1).click({ modifiers: [markModifier] });
    assert.equal(await tree.locator(".marked").count(), 2);
    await page.keyboard.press("ArrowUp");
    assert.equal(await beta.getAttribute("data-current"), "true");
    await tree.press("F5");
    const copy = page.getByRole("dialog", { name: "Copy", exact: true });
    await copy.getByText("2 selected items", { exact: true }).waitFor();
    await button(copy, "Cancel").click();
    await alpha.click();
    await duplicate.nth(1).click({ modifiers: ["Shift"] });
    assert.equal(await tree.locator(".marked").count(), 4);
    await tree.press("F5");
    await copy.getByText("2 selected items", { exact: true }).waitFor();
    await button(copy, "Cancel").click();
    await root.click();
    await tree.press("F6");
    assert.equal(await page.getByRole("dialog").count(), 0);
    await duplicate.nth(1).click({ button: "right" });
    const menu = page.getByRole("menu", { name: "File actions", exact: true });
    await menu.getByRole("menuitem", { name: "Rename or move" }).waitFor();
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    assert.equal(await tree.evaluate((element) => document.activeElement === element), true);
    await tree.press("F5");
    assert.equal(await copy.getByRole("combobox", { name: "Destination" }).inputValue(), "/other");
    await button(copy, "Cancel").click();
    await tree.press("F8");
    const recycle = page.getByRole("dialog").filter({ has: button(page, "Move to Trash") });
    await button(recycle, "Cancel").click();
    await tree.press("Shift+Delete");
    const remove = page.getByRole("dialog", { name: "Delete permanently", exact: true });
    await button(remove, "Cancel").click();
    assert.equal(await duplicate.count(), 2);
    await tree.press("F6");
    const move = page.getByRole("dialog", { name: "Rename or move", exact: true });
    const dest = move.getByRole("combobox", { name: "Destination" });
    assert.equal(await dest.inputValue(), "/other");
    const basedir = source === "mac" ? "/Users/fixture/open" : "/mnt/samba/open";
    await dest.fill(basedir + "/beta/new.txt");
    await button(move, "Move").click();
    await move.waitFor({ state: "hidden" });
    const transfer = await page.evaluate(() => window.spaceCalls.find(({ command }) => command === "transfer_item").request);
    assert.deepEqual(transfer.source, { kind: "local", directory: basedir + "/beta", name: "same.txt" });
    await row(tree, "new.txt").waitFor();
    await page.evaluate(() => window.finishOutdatedScan());
    await finished(analyzer);
    assert.equal(await duplicate.count(), 1);
    assert.equal(await alpha.getAttribute("aria-expanded"), "true");
    assert.equal(await beta.getAttribute("aria-expanded"), "true");
    assert.equal(await row(tree, "obsolete.txt").count(), 0);
    assert.equal(await tree.evaluate((element) => document.activeElement === element), true);
    await button(right, "Locations for right pane").click();
    await button(right, "NetBox").click();
    await right.getByRole("option", { name: /^FTP fixture/ }).waitFor();
    await row(tree, "new.txt").click();
    await tree.press("F5");
    assert.equal(await copy.getByRole("combobox", { name: "Destination" }).inputValue(), "");
    await button(copy, "Cancel").click();
    if (source === "mounted") {
      await button(page, "Options").click();
      const options = page.getByRole("dialog", { name: "Options", exact: true });
      await button(options, "Keyboard shortcuts").click();
      await button(options, "Change F5 for Copy").click();
      await options.getByRole("textbox", { name: "New shortcut to replace F5 for Copy" }).press("Control+Shift+F5");
      await button(options, "Done").click();
      await row(tree, "new.txt").click();
      await tree.press("F5");
      assert.equal(await copy.count(), 0);
      await tree.press("Control+Shift+F5");
      await button(copy, "Cancel").click();
    }
    await page.close();
  }
  console.log("Verified pane controls, metric bars, treemap, scan cancellation, provider scopes, and path-based local tree actions.");
} finally {
  await browser.close();
}
