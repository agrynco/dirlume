import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { openMainMenu } from "./menu-header-smoke.mjs";

const markModifier = process.platform === "darwin" ? "Meta" : "Control";
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36" });
  page.setDefaultTimeout(8000);
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  await page.addInitScript(() => {
    const mode = new URL(location.href).searchParams.get("shortcuts");
    localStorage.removeItem("dirlume.workspace.v1");
    localStorage.setItem("dirlume.preferences.v1", JSON.stringify(mode ? {
      shortcutSchemes: [{ id: "test", name: "Test", bindings: {
        refresh: mode === "disabled" ? [] : ["Ctrl+Alt+R"],
        move: mode === "disabled" ? [] : ["Ctrl+Alt+M"],
      } }], activeShortcutScheme: "test",
    } : {}));
    const folder = (name) => ({ name, hidden: false, directory: true, link: false, size: null, modified: null });
    const file = (name, hidden = false) => ({ ...folder(name), hidden, directory: false, size: 8 });
    const files = {
      "/fixture": [folder("one"), folder("two"), folder("three"), file("ignore.txt")],
      "/fixture/one": [file("demo.mp4")],
      "/fixture/two": [file("demo.mp4")],
      "/fixture/three": [file("keep.mp4"), file("hidden.mp4", true)],
      "/destination": [],
    };
    window.searchFixture = { files, file, calls: [] };
    const fixture = window.searchFixture;
    const remove = (folder, name) => { files[folder] = files[folder].filter((entry) => entry.name !== name); };
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args = {}) => {
        if (command === "locations") return [{ label: "Home", path: "/fixture" }, { label: "Downloads", path: "/destination" }];
        if (command === "list_directory") {
          fixture.calls.push([command, args.path]);
          return { path: args.path, parent: null, omitted: 0, entries: files[args.path] ?? [] };
        }
        if (command === "file_icons") return [];
        if (command === "transfer_item") {
          const { directory, name } = args.request.source;
          fixture.calls.push([command, directory, name, args.request.moving, args.request.destination]);
          if (!args.request.moving && files["/destination"].some((entry) => entry.name === name)) {
            const details = { size: 8, modified: null, directory: false };
            args.output.onmessage({ kind: "conflict", conflict: { path: "/destination/" + name,
              replaceable: true, directory: false, readOnly: false, allowRemember: true, incoming: details, existing: details } });
            if (await new Promise((done) => { fixture.resolve = done; }) === "skip") return { kind: "skipped" };
          }
          if (args.request.moving && fixture.failMove && directory.endsWith("/two")) throw new Error("Fixture move denied");
          files["/destination"].push(file(name));
          if (args.request.moving) remove(directory, name);
          return { kind: "completed" };
        }
        if (command === "resolve_transfer") fixture.resolve(args.decision);
        if (command === "delete_selection") {
          fixture.calls.push([command, args.directory, args.relativePaths, args.permanent]);
          const paths = args.relativePaths;
          const selection = { files: paths.length, folders: 0, bytes: paths.length * 8, availableBefore: null, incomplete: false };
          const counts = { completed: 0, skipped: 0, failed: 0, unprocessed: 0 };
          const removedPaths = [];
          const failures = [];
          let cancelled = false;
          if (fixture.cancelBatch) {
            const first = paths[0];
            remove(args.directory + "/" + first[0], first[1]);
            removedPaths.push(first);
            counts.completed++;
            args.onProgress.onmessage({ phase: "removing", progress: { path: first.join("/"),
              currentTotal: 1, currentProcessed: 1, counts }, selection });
            await new Promise((done) => { fixture.cancel = done; });
            counts.unprocessed = paths.length - 1;
            cancelled = true;
          } else {
            for (const segments of paths) {
              if (!args.permanent && fixture.failTrash) {
                counts.failed++;
                failures.push({ path: segments.join("/"), message: "Fixture Trash unavailable" });
              } else {
                remove(args.directory + "/" + segments[0], segments[1]);
                removedPaths.push(segments);
                counts.completed++;
              }
            }
          }
          return { selection, counts, cancelled, removedPaths, failures, availableAfter: null };
        }
        if (command === "cancel_deletion") fixture.cancel();
        return null;
      },
    };
  });

  const left = page.locator("#left-pane");
  const right = page.locator("#right-pane");
  const list = (side = "left") => page.locator(`#${side}-files`);
  const row = (name) => list().locator(`[data-tooltip=${JSON.stringify(name)}]`);
  const button = (scope, name) => scope.getByRole("button", { name, exact: true });
  const dialog = (name) => page.getByRole("dialog", { name, exact: true });
  const calls = (command) => page.evaluate((name) => window.searchFixture.calls.filter(([command]) => command === name), command);
  const search = async (side = "left") => {
    const pane = side === "left" ? left : right;
    await list(side).locator('[data-tooltip="one"]').click();
    await pane.and(page.locator(".active")).waitFor();
    await list(side).press("Alt+F7");
    const find = dialog("Find files");
    await find.getByRole("textbox", { name: "File mask" }).fill("*.mp4");
    await button(find, "Search").click();
    await button(find, "Show in panel").click();
    await pane.getByRole("heading", { name: "Search results", exact: true }).waitFor();
  };
  const one = "one/demo.mp4";
  const two = "two/demo.mp4";
  const keep = "three/keep.mp4";
  const mark = async (name) => {
    if (!await row(name).evaluate((element) => element.classList.contains("marked"))) {
      await row(name).click({ modifiers: [markModifier] });
    }
  };
  const destination = (modal) => modal.getByRole("combobox", { name: "Destination", exact: true });
  const removeRow = (name) => row(name).waitFor({ state: "detached" });

  await page.goto("http://dirlume.test/");
  await button(right, "Locations for right pane").click();
  await right.getByRole("button", { name: /^Downloads/ }).click();
  await search();
  await mark(one);
  await mark(two);
  await list().press("F5");
  const copy = dialog("Copy");
  assert.equal(await destination(copy).inputValue(), "/destination");
  await button(copy, "Copy").click();
  await button(dialog("File already exists"), "Skip").click();
  await button(dialog("Transfer complete"), "Done").click();
  assert.deepEqual((await calls("transfer_item")).map(([, dir, name]) => [dir, name]),
    [["/fixture/one", "demo.mp4"], ["/fixture/two", "demo.mp4"]]);
  await row(one).waitFor();
  await row(two).waitFor();

  await page.evaluate(() => {
    window.searchFixture.files["/destination"] = [];
    window.searchFixture.failMove = true;
  });
  await list().press("F6");
  const move = dialog("Rename or move");
  assert.equal(await destination(move).inputValue(), "/destination");
  await button(move, "Move").click();
  const stopped = dialog("Transfer stopped");
  await stopped.getByRole("alert").getByText("Fixture move denied").waitFor();
  await removeRow(one);
  await row(two).waitFor();
  await row(keep).waitFor();
  await button(stopped, "Cancel").click();
  await row(two).click();
  await list().press("F8");
  const trash = dialog("Move to Trash");
  await button(trash, "Cancel").click();
  assert.deepEqual(await calls("delete_selection"), []);
  await page.evaluate(() => { window.searchFixture.failTrash = true; });
  await list().press("Delete");
  await button(trash, "Move to Trash").click();
  const failed = dialog("Deletion results");
  await failed.getByText("Failed items").click();
  await failed.getByText("Fixture Trash unavailable").waitFor();
  await row(two).waitFor();
  await button(failed, "Done").click();

  await page.evaluate(() => {
    const { files, file } = window.searchFixture;
    files["/fixture/one"].push(file("new.mp4"));
    files["/fixture/three"] = [file("hidden.mp4", true)];
  });
  await button(page, "Show hidden files").click();
  await list().press("Control+r");
  await row("one/new.mp4").waitFor();
  await removeRow(keep);
  assert.equal(await row("three/hidden.mp4").count(), 0);
  await left.getByText("2 matches", { exact: true }).waitFor();
  await page.evaluate(() => { window.searchFixture.cancelBatch = true; });
  await row("one/new.mp4").click();
  // Mark in the order the cancellation fixture processes them.
  if (await row(two).evaluate((element) => element.classList.contains("marked"))) {
    await row(two).click({ modifiers: [markModifier] });
  }
  await mark("one/new.mp4");
  await mark(two);
  await list().press("Shift+Delete");
  const permanent = dialog("Delete permanently");
  await button(permanent, "Cancel").click();
  await row("one/new.mp4").waitFor();
  await list().press("Shift+Delete");
  await button(permanent, "Delete permanently").click();
  await button(dialog("Deletion progress"), "Cancel deletion").click();
  await button(dialog("Deletion cancelled"), "Done").click();
  await removeRow("one/new.mp4");
  await row(two).waitFor();
  assert.deepEqual(await calls("delete_selection"), [
    ["delete_selection", "/fixture", [["two", "demo.mp4"]], false],
    ["delete_selection", "/fixture", [["one", "new.mp4"], ["two", "demo.mp4"]], true],
  ]);
  await page.evaluate(() => {
    window.searchFixture.failTrash = false;
    window.searchFixture.cancelBatch = false;
  });
  await row(two).click();
  const filesMenu = await openMainMenu(page, "Files");
  await filesMenu.getByRole("menuitem", { name: /^Trash/ }).click();
  await button(trash, "Move to Trash").click();
  await removeRow(two);
  await page.evaluate(() => {
    const { files, file } = window.searchFixture;
    files["/fixture/two"].push(file("late.mp4"));
  });
  await button(left, "Refresh").click();
  await row("two/late.mp4").waitFor();
  await page.evaluate(() => { window.searchFixture.files["/fixture/two"] = []; });
  await button(left, "Refresh").click();
  await left.getByText("0 matches", { exact: true }).waitFor();
  await left.getByRole("heading", { name: "Search results" }).waitFor();
  await list().press("F6");
  assert.equal(await move.count(), 0);

  for (const mode of ["custom", "disabled"]) {
    await page.goto(`http://dirlume.test/?shortcuts=${mode}`);
    await button(right, "Locations for right pane").click();
    await right.getByRole("button", { name: /^Home/ }).click();
    await search("right");
    await search();
    await row(one).click();
    await list().press("F6");
    assert.equal(await move.count(), 0);
    await list().press("Control+Alt+m");
    if (mode === "custom") {
      assert.equal(await destination(move).inputValue(), "");
      await button(move, "Cancel").click();
    } else assert.equal(await move.count(), 0);
    const before = (await calls("list_directory")).length;
    await list().press("Control+r");
    assert.equal((await calls("list_directory")).length, before);
    await list().press("Control+Alt+r");
    if (mode === "custom") {
      await page.waitForFunction((count) => window.searchFixture.calls.filter(([command]) => command === "list_directory").length >
        count, before);
    } else assert.equal((await calls("list_directory")).length, before);
  }
  console.log("Verified Search results copy, partial move, Trash failure, permanent deletion cancellation, and configurable refresh.");
} finally {
  await browser.close();
}
