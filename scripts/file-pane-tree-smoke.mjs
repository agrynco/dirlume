import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const markModifier = process.platform === "darwin" ? "Meta" : "Control";
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36" });
  page.setDefaultTimeout(8000);
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  await page.addInitScript(() => {
    window.isTauri = true;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    const width = new URL(location.href).searchParams.get("sizeWidth");
    if (width) {
      localStorage.removeItem("dirlume.workspace.v1");
      localStorage.setItem("dirlume.preferences.v1", JSON.stringify({
        paneViews: { left: "tree", right: "list" },
        panelModes: { full: { list: [{ field: "name", width: "0" }, { field: "size", width }],
          status: [{ field: "rightName", width: "0" }] } },
      }));
    }
    const file = (name, size) => ({ name, directory: false, hidden: false, link: false, size, modified: null });
    const dir = (name) => ({ ...file(name, null), directory: true });
    const listings = {
      "/fixture": [dir("A"), dir("B"), dir("Empty"), dir("Limited")],
      "/fixture/A": [file("report.txt", 12), ...(width ? [dir("Nested")] : [])],
      "/fixture/A/Nested": [dir("Child"), file("readme.txt", 12)],
      "/fixture/B": [file("report.txt", 25)],
      "/target": [],
    };
    let hold = true;
    let wideRuns = 0;
    window.treeCalls = [];
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      invoke: async (command, args = {}) => {
        if (command === "locations") return [{ label: "Home", path: "/fixture" }, { label: "Downloads", path: "/target" }];
        if (command === "watch_directory" && args.path === "/fixture") {
          window[args.recursive ? "treeWatch" : "listWatch"] = () => args.changes.onmessage(null);
        }
        if (command === "list_directory") {
          window.treeCalls.push([command, args.path]);
          if (window.rejectNextListing === args.path) {
            window.rejectNextListing = null;
            throw new Error("Permission denied");
          }
          if (window.holdTreeListing === args.path) {
            window.holdTreeListing = null;
            const names = await new Promise((resolve) => { window.finishTreeListing = resolve; });
            if (names === null) throw new Error("Permission denied");
            listings[args.path] = names.map((name) => file(name, 12));
          }
          return { path: args.path, parent: args.path.split("/").slice(0, -1).join("/") || "/",
            entries: listings[args.path] ?? [], omitted: 0 };
        }
        if (command === "scan_local_space") {
          window.treeCalls.push([command, args.root, args.id]);
          const send = (event) => args.output.onmessage(event);
          const node = (parent, entry) => ({ parent, name: entry.name, directory: entry.directory,
            size: entry.size, allocated: entry.size === null ? null : 4096, shared: false });
          const close = (closed, error = null) => ({ closed, error, partial: !!error });
          send({ kind: "start", strategy: "walk" });
          if (args.root === "/fixture" && width) {
            wideRuns++;
            send({ kind: "batch", changes: [node(0, dir("A")), node(0, dir("B")),
              node(1, file("large.dat", Math.round(17.6 * 1024 ** 3))), node(2, file("large.dat", 170 * 1024 ** 3)),
              close(1)] });
            await new Promise((resolve) => { window.finishWideScan = resolve; });
            window.finishWideScan = null;
            send({ kind: "batch", changes: [...(wideRuns === 1 ? [] : [node(2, file("new.dat", 1024 ** 3))]),
              close(2, "Some files could not be read"), close(0)] });
          } else if (args.root === "/fixture") {
            send({ kind: "batch", changes: [node(0, dir("A")), node(0, dir("B")), node(0, dir("Empty")),
              node(0, dir("Limited")), node(2, listings["/fixture/B"][0]),
              close(2), close(3), close(4, "Permission denied"), close(0)] });
            if (hold) {
              hold = false;
              await new Promise((resolve) => { window.finishOldScan = resolve; });
            }
            send({ kind: "batch", changes: [node(1, listings["/fixture/A"][0]), close(1)] });
          } else if (args.root === "/fixture/A/Nested") {
            send({ kind: "batch", changes: [node(0, dir("Child")), node(0, file("readme.txt", 512)),
              node(1, file("data.bin", 2048)), close(1), close(0)] });
          } else {
            send({ kind: "batch", changes: [...(listings[args.root] ?? []).map((entry) => node(0, entry)), close(0)] });
          }
          send({ kind: "finished" });
          return null;
        }
        if (command === "cancel_space_scan") window.treeCalls.push([command, args.id]);
        if (command === "read_text") {
          window.treeCalls.push([command, args.directory, args.name]);
          return { text: "Fixture text", encoding: "utf8" };
        }
        if (command === "transfer_item") {
          window.treeCalls.push([command, args.request.source, args.request.destination]);
          return { kind: "completed" };
        }
        if (command === "copy_file_references") {
          window.treeCalls.push([command, args.items]);
          return null;
        }
        if (command === "file_icons") return [];
        return null;
      },
    };
  });
  await page.goto("http://dirlume.test/");
  const pane = (side) => page.locator(`#${side}-pane`);
  const files = (side = "left") => page.locator(`#${side}-files`);
  const button = (scope, name) => scope.getByRole("button", { name, exact: true });
  const row = (key) => files().locator(`[data-tooltip=${JSON.stringify(key)}]`);
  const size = (key) => row(key).locator(".file-size");
  const dialog = (name) => page.getByRole("dialog", { name, exact: true });
  const scanCalls = () => page.evaluate(() => window.treeCalls.filter(([name]) => name === "scan_local_space"));

  await row("A").waitFor();
  assert.equal(await button(pane("left"), "List").getAttribute("aria-pressed"), "true");
  assert.equal(await button(pane("left"), "Folder sizes").getAttribute("aria-pressed"), "false");
  await button(pane("right"), "Locations for right pane").click();
  await pane("right").getByRole("button", { name: /^Downloads/ }).click();
  await button(pane("left"), "Folder sizes").click();
  await page.waitForFunction(() => window.finishOldScan);
  await size("B").getByText("25 B", { exact: true }).waitFor();
  assert.equal(await size("A").innerText(), "…");
  assert.equal(await size("Empty").innerText(), "0 B");
  assert.equal(await size("Limited").innerText(), "—");
  for (let change = 0; change < 2; change++) {
    const previousCalls = await page.evaluate(() => {
      const count = window.treeCalls.filter(([command, path]) => command === "list_directory" && path === "/fixture").length;
      window.listWatch();
      return count;
    });
    await page.waitForFunction((count) => window.treeCalls.filter(([command, path]) =>
      command === "list_directory" && path === "/fixture").length > count, previousCalls);
    assert.equal(await size("B").innerText(), "25 B");
    assert.equal((await scanCalls()).length, 1);
  }
  await button(pane("left"), "Tree").click();
  await page.waitForFunction(() => window.treeWatch);
  assert.equal(await files().getAttribute("role"), "tree");
  assert.equal(await files("right").getAttribute("role"), "listbox");
  assert.equal((await scanCalls()).length, 1);
  assert.equal(await page.evaluate(() => window.treeCalls.filter(([, path]) => path === "/fixture/A").length), 0);
  await button(row("A"), "Expand folder").click();
  await row("A/report.txt").waitFor();
  await row("B").click();
  await files().press("ArrowRight");
  await row("B/report.txt").waitFor();
  await pane("left").getByRole("combobox", { name: "Size metric" }).selectOption("allocated");
  await size("B").getByText("4 KiB", { exact: true }).waitFor();
  await row("A/report.txt").click({ modifiers: [markModifier] });
  await row("B/report.txt").click({ modifiers: [markModifier] });
  await files().press("Control+c");
  await page.waitForFunction(() => window.treeCalls.some(([name]) => name === "copy_file_references"));
  assert.deepEqual(await page.evaluate(() => window.treeCalls.find(([name]) => name === "copy_file_references")[1]),
    [{ directory: "/fixture/A", name: "report.txt" }, { directory: "/fixture/B", name: "report.txt" }]);
  const dragged = await row("B/report.txt").boundingBox();
  const target = await files("right").boundingBox();
  assert.ok(dragged && target);
  await page.mouse.move(dragged.x + 80, dragged.y + dragged.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + 80, target.y + 48, { steps: 8 });
  await page.mouse.up();
  await button(dialog("Copy"), "Cancel").click();
  await files().press("F5");
  const copy = dialog("Copy");
  assert.equal(await copy.getByRole("combobox", { name: "Destination" }).inputValue(), "/target");
  await button(copy, "Copy").click();
  await page.getByText("Transfer complete", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.treeCalls.filter(([name]) => name === "transfer_item")
    .map(([, source]) => [source.directory, source.name])), [["/fixture/A", "report.txt"], ["/fixture/B", "report.txt"]]);
  await row("A/report.txt").waitFor();
  await row("B/report.txt").waitFor();
  await row("A").click({ modifiers: [markModifier] });
  await files().press("F5");
  await copy.getByText(/2 selected items/).waitFor();
  await button(copy, "Cancel").click();
  await files().press("Shift+Delete");
  await button(dialog("Delete permanently"), "Cancel").click();

  const finishRefresh = (names) => page.evaluate((names) => {
    const finish = window.finishTreeListing;
    window.finishTreeListing = null;
    finish(names);
  }, names);
  async function startRefresh(automatic) {
    await page.evaluate(() => { window.holdTreeListing = "/fixture/A"; });
    if (automatic) await page.evaluate(() => window.treeWatch());
    else await button(pane("left"), "Refresh folder").click();
    await page.waitForFunction(() => typeof window.finishTreeListing === "function");
    await row("A/report.txt").waitFor();
    assert.equal(await row("A").locator(".spin").count(), 0);
  }
  await row("A/report.txt").click();
  if (!(await row("A/report.txt").evaluate((element) => element.classList.contains("marked")))) {
    await row("A/report.txt").click({ modifiers: [markModifier] });
  }
  await startRefresh(true);
  await finishRefresh(["report.txt", "added.txt"]);
  await row("A/added.txt").waitFor();
  assert.equal(await row("A/report.txt").getAttribute("data-current"), "true");
  assert.ok(await row("A/report.txt").evaluate((element) => element.classList.contains("marked")));
  await startRefresh(false);
  await finishRefresh(null);
  await row("A").locator(".file-tree-error").waitFor();
  assert.match(await row("A").getAttribute("aria-description"), /Folder contents may be out of date/);
  await row("A/added.txt").waitFor();
  await startRefresh(true);
  await finishRefresh(["report.txt"]);
  await row("A/added.txt").waitFor({ state: "detached" });
  await row("A").locator(".file-tree-error").waitFor({ state: "detached" });
  await startRefresh(false);
  assert.equal((await scanCalls()).length, 1);
  assert.equal(await size("B").innerText(), "4 KiB");
  await row("B/report.txt").click();
  await button(pane("left"), "List").click();
  await row("report.txt").waitFor();
  await finishRefresh(["late.txt"]);
  assert.equal(await row("late.txt").count(), 0);
  assert.equal(await row("report.txt").getAttribute("data-current"), "true");
  assert.equal(await page.locator("#left-path").getAttribute("data-path"), "/fixture/B");
  await page.evaluate(() => window.finishOldScan());
  await page.waitForFunction(() => window.treeCalls.some(([name, path]) => name === "scan_local_space" && path === "/fixture/B"));
  assert.ok(await page.evaluate(() => window.treeCalls.some(([name]) => name === "cancel_space_scan")));
  await button(pane("right"), "Tree").click();
  await page.reload();
  await files("right").waitFor();
  assert.equal(await files("right").getAttribute("data-file-view"), "tree");
  assert.equal(await button(pane("left"), "Folder sizes").getAttribute("aria-pressed"), "false");

  await row("..").dblclick();
  await row("B").waitFor();
  await button(pane("left"), "Tree").click();
  await button(row("B"), "Expand folder").click();
  await row("B/report.txt").click();
  await page.evaluate(() => { window.rejectNextListing = "/fixture/B"; });
  await button(pane("left"), "List").click();
  await pane("left").getByRole("alert").filter({ hasText: "Permission denied" }).waitFor();
  assert.equal(await button(pane("left"), "List").getAttribute("aria-pressed"), "true");
  assert.equal(await files().getAttribute("role"), "listbox");
  assert.equal(await page.locator("#left-path").getAttribute("data-path"), "/fixture");
  assert.equal(await row("B/report.txt").count(), 0);
  assert.equal(await files("right").getAttribute("data-file-view"), "tree");
  await page.reload();
  await row("B").waitFor();
  assert.equal(await button(pane("left"), "List").getAttribute("aria-pressed"), "true");
  assert.equal(await files("right").getAttribute("data-file-view"), "tree");

  for (const width of ["6", "5%"]) {
    await page.goto(`http://dirlume.test/?sizeWidth=${encodeURIComponent(width)}`);
    await row("A").waitFor();
    await button(row("A"), "Expand folder").click();
    await button(row("A/Nested"), "Expand folder").click();
    await row("A/Nested/Child").waitFor();
    await row("B").click({ modifiers: [markModifier] });
    await row("A/Nested").click();
    const siblingSize = await size("B").innerText();
    await files().press("F3");
    await size("A/Nested").getByText("2.5 KiB", { exact: true }).waitFor();
    await size("A/Nested/Child").getByText("2 KiB", { exact: true }).waitFor();
    assert.deepEqual((await scanCalls()).map(([, path]) => path), ["/fixture/A/Nested"]);
    assert.equal(await size("B").innerText(), siblingSize);
    assert.equal(await button(pane("left"), "Folder sizes").getAttribute("aria-pressed"), "false");
    await row("A/Nested/readme.txt").click();
    await files().press("F3");
    await page.waitForFunction(() => window.treeCalls.some(([command, path, name]) =>
      command === "read_text" && path === "/fixture/A/Nested" && name === "readme.txt"));
    await page.keyboard.press("Escape");

    const otherSize = pane("right").locator(".file-column.col-size");
    const savedWidth = () => otherSize.evaluate((element) => element.getBoundingClientRect().width);
    const otherWidth = await savedWidth();
    await button(pane("left"), "Folder sizes").click();
    await size("A").getByText("17.6 GiB", { exact: true }).waitFor();
    await page.evaluate(() => window.finishWideScan());
    await size("B").getByText("≥ 170 GiB", { exact: true }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll("#left-files .file-size")]
      .filter((element) => /17\.6 GiB|170 GiB/.test(element.textContent))
      .every((element) => element.scrollWidth <= element.clientWidth));
    assert.equal(await savedWidth(), otherWidth, "Folder sizing changed the opposite pane's width.");
    await button(pane("left"), "Refresh folder").click();
    await page.waitForFunction(() => window.finishWideScan);
    assert.equal(await size("B").innerText(), "≥ 170 GiB");
    await page.evaluate(() => window.finishWideScan());
    await size("B").getByText("≥ 171 GiB", { exact: true }).waitFor();
  }
  console.log("Verified stable Tree refresh, scoped F3, and folder totals that fit saved character and percentage widths.");
} finally {
  await browser.close();
}
