import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

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
    const file = (name, size) => ({ name, directory: false, hidden: false, link: false, size, modified: null });
    const dir = (name) => ({ ...file(name, null), directory: true });
    const listings = {
      "/fixture": [dir("A"), dir("B"), dir("Empty"), dir("Limited")],
      "/fixture/A": [file("report.txt", 12)],
      "/fixture/B": [file("report.txt", 25)],
      "/target": [],
    };
    let hold = true;
    window.treeCalls = [];
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args = {}) => {
        if (command === "locations") return [{ label: "Home", path: "/fixture" }, { label: "Downloads", path: "/target" }];
        if (command === "list_directory") {
          window.treeCalls.push([command, args.path]);
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
          if (args.root === "/fixture") {
            send({ kind: "batch", changes: [node(0, dir("A")), node(0, dir("B")), node(0, dir("Empty")),
              node(0, dir("Limited")), node(2, listings["/fixture/B"][0]),
              close(2), close(3), close(4, "Permission denied"), close(0)] });
            if (hold) {
              hold = false;
              await new Promise((resolve) => { window.finishOldScan = resolve; });
            }
            send({ kind: "batch", changes: [node(1, listings["/fixture/A"][0]), close(1)] });
          } else {
            send({ kind: "batch", changes: [...(listings[args.root] ?? []).map((entry) => node(0, entry)), close(0)] });
          }
          send({ kind: "finished" });
          return null;
        }
        if (command === "cancel_space_scan") window.treeCalls.push([command, args.id]);
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
  await button(pane("left"), "Tree").click();
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
  await row("A/report.txt").click({ modifiers: ["Control"] });
  await row("B/report.txt").click({ modifiers: ["Control"] });
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
  await row("A").click({ modifiers: ["Control"] });
  await files().press("F5");
  await copy.getByText(/2 selected items/).waitFor();
  await button(copy, "Cancel").click();
  await files().press("Shift+Delete");
  await button(dialog("Delete permanently"), "Cancel").click();

  await row("B/report.txt").click();
  await button(pane("left"), "List").click();
  await row("report.txt").waitFor();
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
  console.log("Verified per-pane modes, lazy branches, duplicate marked files, size metrics, scan reuse, and selection when returning to List.");
} finally {
  await browser.close();
}
