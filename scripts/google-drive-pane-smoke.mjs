import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { openMainMenu } from "./menu-header-smoke.mjs";

const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const windows of [true, false]) {
    const page = await browser.newPage({ userAgent: windows ? "Mozilla/5.0 (Windows NT 10.0)" : "Mozilla/5.0 (X11; Linux x86_64)" });
    page.setDefaultTimeout(8000);
    await page.route("http://localhost/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    const home = windows ? "C:\\fixture" : "/fixture";
    await page.addInitScript(({ home }) => {
      const fileSize = 23851;
      const state = window.driveFixture = { profiles: JSON.parse(sessionStorage.getItem("drive-fixture-profiles") || "[]"),
        called: [], transfer: null, cancel: null, denied: false, changes: [], added: [], localFolder: "Local folder", spaceCalls: [] };
      const profile = (id, name) => ({ id, label: name, email: id + "@example.test", signInNeeded: false });
      const item = (id, name, fields = {}) => ({
        id, name, directory: false, modified: null, size: 42, download: true, webViewLink: null, ...fields,
      });
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args) => {
          switch (command) {
            case "locations": return [{ label: "Home", path: home }];
            case "file_icons": return args.items.map(() => null);
            case "list_directory": return { path: args.path, parent: null, omitted: 0, entries: [
              { name: "local.txt", directory: false, hidden: false, link: false, size: fileSize, modified: null },
              { name: state.localFolder, directory: true, hidden: false, link: false, size: null, modified: null },
            ] };
            case "operate":
              state.localRename = args;
              if (args.operation.kind === "rename") state.localFolder = args.operation.new_name;
              return null;
            case "google_drive_profiles": return state.profiles;
            case "sign_in_google_drive": {
              if (state.cancelNext) return new Promise((_, reject) => { state.cancel = reject; });
              const saved = args.profileId ?? state.nextAccount ?? "a";
              const existing = state.profiles.find(({ id }) => id === saved);
              if (existing) existing.signInNeeded = false;
              else state.profiles.push(profile(saved, saved === "a" ? "Personal" : "Work"));
              return saved;
            }
            case "cancel_google_drive_sign_in": state.cancel?.(new Error("Google sign-in was canceled.")); return null;
            case "rename_google_drive": state.profiles.find(({ id }) => id === args.id).label = args.label; return null;
            case "remove_google_drive": state.profiles = state.profiles.filter(({ id }) => id !== args.id); return null;
            case "google_drive_quota": return args.id === "a"
              ? { limit: 100 * 1024 ** 3, usage: 60 * 1024 ** 3, usageInDrive: 40 * 1024 ** 3, usageInDriveTrash: 0 }
              : { limit: null, usage: 5 * 1024 ** 3, usageInDrive: 3 * 1024 ** 3, usageInDriveTrash: null };
            case "google_drive_space_page": {
              const { id, folder, pageToken } = args;
              state.spaceCalls.push([id, folder, pageToken]);
              const measure = (id, name, quotaBytes, directory = false) => ({ id, name, quotaBytes, directory });
              const page = (items, nextPageToken = null) => ({ items, nextPageToken, partial: false });
              if (id === "b") return page([measure("work", "work.txt", 1024)]);
              if (folder === "second") return page([measure("copy", "download.txt", 3072)]);
              if (folder === "first") return page([measure("ordinary", "first.txt", 1024)]);
              if (pageToken) {
                if (state.waitForPage) await new Promise((resume) => { state.resumeSpacePage = resume; });
                return page([measure("paper", "Native document", 2048), measure("unknown", "Unknown size", null)]);
              }
              return page([measure("first", "Duplicate", null, true), measure("second", "Duplicate", null, true),
                measure("paper", "Native document", 2048), measure("zero", "Zero size", 0)], "next");
            }
            case "list_google_drive":
              state.called.push([args.id, args.folder]);
              if (state.denied && args.id === "a") throw new Error("Sign in to this Google Drive account again.");
              if (args.id === "b") return [item("work", "work.txt")];
              if (args.folder === "root") return [
                item("first", "Duplicate", { directory: true, download: false }),
                item("second", "Duplicate", { directory: true, download: false }),
                ...(state.showDestination ? [item("destination", "Demo destination", { directory: true, download: false })] : []),
              ];
              if (args.folder === "first") return [item("ordinary", "first.txt")];
              return [...state.added, item("copy", "download.txt", { size: fileSize }), item("excel", "08.09.xlsx", {
                webViewLink: "https://drive.google.com/file/d/excel/view",
              }), item("doc", "Paper", {
                download: false, webViewLink: "https://docs.google.com/document/d/example/edit",
              })];
            case "change_google_drive": {
              const { change } = args;
              state.changes.push(change);
              if (change.kind === "createFolder" || change.kind === "createFile") {
                const id = "created-" + state.changes.length;
                state.added.push(item(id, change.name, { directory: change.kind === "createFolder" }));
                return id;
              }
              if (change.kind === "rename") state.added.find(({ id }) => id === change.item).name = change.name;
              else state.added = state.added.filter(({ id }) => id !== change.item);
              return null;
            }
            case "open_web_link": state.opened = args.href; return null;
            case "measure_folders":
              state.measure = { source: args.source, names: args.names };
              for (const name of args.names) args.output.onmessage({ name, bytes: 512, incomplete: false });
              return null;
            case "transfer_item": {
              state.transfer = args.request;
              if (state.mixedMove && args.request.source.kind === "google_drive") {
                const { item, name } = args.request.source;
                state.mixedMove.push(item);
                if (item === "excel") throw new Error("Fixture transfer denied.");
                if (item === "doc") return { kind: "source_retained", source: name, destination: home,
                  error: "Saved local links. The source was kept in Google Drive." };
              }
              return { kind: "completed" };
            }
            default: return null;
          }
        },
      };
    }, { home });
    const list = (side) => page.locator("#" + side + "-files");
    const row = (side, name) => list(side).locator('[data-tooltip=' + JSON.stringify(name) + "]");
    const dialog = () => page.getByRole("dialog");
    const button = (scope, name) => scope.getByRole("button", { name, exact: true });
    const pane = (side) => page.locator("#" + side + "-pane");
    const chooseDrive = async (side) => {
      await list(side).press(side === "left" ? "Alt+F1" : "Alt+F2");
      await button(pane(side), "Google Drive").click();
    };
    const add = async (side) => {
      await list(side).press("Shift+F4");
      await button(dialog(), "Sign in with Google").click();
      await dialog().waitFor({ state: "hidden" });
    };

    await page.goto("http://localhost/");
    await page.waitForFunction((home) => document.getElementById("right-path")?.dataset.path === home, home);
    await page.evaluate(() => {
      window.driveFixture.profiles.push({ id: "a", label: "Personal", email: "a@example.test", signInNeeded: false });
    });
    await row("right", "Local folder").click();
    await list("right").press("F6");
    const renameOrMove = page.getByRole("dialog", { name: "Rename or move", exact: true });
    const target = renameOrMove.locator("#transfer-destination");
    assert.equal(await target.inputValue(), home);
    await target.fill("a@example.test:/My Drive");
    await button(renameOrMove, "Move").click();
    await renameOrMove.waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.driveFixture.transfer.googleDriveDestination), { profile: "a", parent: "root" });
    await page.evaluate(() => { window.driveFixture.profiles = []; window.driveFixture.transfer = null; });
    await chooseDrive("left");
    await button(pane("left"), "Add connection").waitFor();
    assert.equal(await page.locator("#right-path").getAttribute("data-path"), home);

    await page.evaluate(() => { window.driveFixture.cancelNext = true; });
    await button(pane("left"), "Add connection").click();
    await button(dialog(), "Sign in with Google").click();
    await page.waitForFunction(() => !!window.driveFixture.cancel);
    await button(dialog(), "Cancel sign-in").click();
    await button(pane("left"), "Add connection").waitFor();
    await page.evaluate(() => { window.driveFixture.cancelNext = false; });

    await add("left");
    await row("left", "Personal").waitFor();
    await add("left");
    assert.equal(await row("left", "Personal").count(), 1);
    await row("left", "Personal").click();
    await list("left").press("F4");
    await dialog().getByRole("textbox", { name: "Connection name" }).fill("Renamed");
    await button(dialog(), "Save").click();
    await row("left", "Renamed").waitFor();

    await row("left", "Renamed").dblclick();
    const duplicates = row("left", "Duplicate");
    await duplicates.nth(1).click();
    await list("left").press("F3");
    assert.deepEqual(await page.evaluate(() => window.driveFixture.measure), {
      source: { kind: "google_drive", profile: "a", folders: { second: "second" } }, names: ["second"],
    });
    await duplicates.nth(1).getByText("512 B", { exact: true }).waitFor();
    await button(pane("left"), "Folder sizes").click();
    assert.deepEqual(await page.evaluate(() => window.driveFixture.measure), {
      source: { kind: "google_drive", profile: "a", folders: { first: "first", second: "second" } }, names: ["first", "second"],
    });
    async function copyFrom(side, label) {
      await page.evaluate(() => { window.driveFixture.transfer = null; });
      await row(side, label).first().click();
      await list(side).press("F5");
      const copy = page.getByRole("dialog", { name: "Copy", exact: true });
      await button(copy, "Copy").click();
      await page.waitForFunction(() => !!window.driveFixture.transfer);
      await copy.waitFor({ state: "hidden" });
      return page.evaluate(() => window.driveFixture.transfer);
    }
    const folderDownload = await copyFrom("left", "Duplicate");
    assert.deepEqual(folderDownload.source, {
      kind: "google_drive", profile: "a", item: "first", name: "Duplicate", parent: "root", folder: true,
    });
    assert.equal(folderDownload.destination, home);
    for (const name of ["local.txt", "Local folder"]) {
      const upload = await copyFrom("right", name);
      assert.deepEqual(upload.source, { kind: "local", directory: home, name });
      assert.deepEqual(upload.googleDriveDestination, { profile: "a", parent: "root" });
    }
    await row("right", "Local folder").click();
    await list("right").press("F6");
    assert.equal(await target.inputValue(), "a@example.test:/My Drive");
    await button(renameOrMove, "Move").and(page.locator(":focus")).waitFor();
    for (const key of ["r", "e", "c", "m"]) {
      await renameOrMove.locator(`.dialog-access-keys [data-access-key="${key}"]`).waitFor();
    }
    const policy = renameOrMove.getByRole("combobox", { name: "Existing files" });
    const spacing = await policy.evaluate((select) => select.getBoundingClientRect().left -
      select.closest("label").querySelector("span").getBoundingClientRect().right);
    assert.ok(spacing >= 0 && spacing <= 12, `Expected the label beside the control, got ${spacing}px`);
    await page.keyboard.press("Alt+e");
    await policy.and(page.locator(":focus")).waitFor();
    await page.keyboard.press("Alt+c");
    await button(renameOrMove, "Cancel").and(page.locator(":focus")).waitFor();
    await page.keyboard.press("Alt+m");
    await button(renameOrMove, "Move").and(page.locator(":focus")).waitFor();
    await page.keyboard.press("Alt+r");
    await target.and(page.locator(":focus")).waitFor();
    await page.evaluate(() => { window.driveFixture.transfer = null; });
    await target.fill("7");
    await button(renameOrMove, "Rename").click();
    await renameOrMove.waitFor({ state: "hidden" });
    await row("right", "7").waitFor();
    assert.deepEqual(await page.evaluate(() => window.driveFixture.localRename), {
      directory: home, operation: { kind: "rename", name: "Local folder", new_name: "7" },
    });
    assert.equal(await page.evaluate(() => window.driveFixture.transfer), null);
    await row("right", "7").click();
    await list("right").press("F6");
    await button(renameOrMove, "Move").and(page.locator(":focus")).waitFor();
    await page.keyboard.press("Enter");
    await renameOrMove.waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.driveFixture.transfer.googleDriveDestination), { profile: "a", parent: "root" });
    await page.evaluate(() => { window.driveFixture.showDestination = true; });
    await row("right", "7").click();
    await list("right").press("F6");
    await target.fill("a@example.test:/My Drive/Duplicate");
    await button(renameOrMove, "Move").click();
    await renameOrMove.getByRole("alert").waitFor();
    await target.fill("a@example.test:/My Drive/Demo destination");
    await button(renameOrMove, "Move").click();
    await renameOrMove.waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.driveFixture.transfer.googleDriveDestination), { profile: "a", parent: "destination" });
    await button(pane("right"), "Tree").click();
    await row("right", "7").click();
    await list("right").press("F6");
    assert.equal(await target.inputValue(), "a@example.test:/My Drive");
    const localTarget = windows ? "C:\\fixture\\local-destination\\" : "/fixture/local-destination/";
    await target.fill(localTarget);
    await button(renameOrMove, "Move").click();
    await renameOrMove.waitFor({ state: "hidden" });
    const localMove = await page.evaluate(() => window.driveFixture.transfer);
    assert.equal(localMove.destination, localTarget);
    assert.equal(localMove.googleDriveDestination, undefined);
    assert.equal(localMove.moving, true);
    await button(pane("right"), "List").click();
    await duplicates.nth(1).dblclick();
    await row("left", "download.txt").waitFor();
    const driveSize = row("left", "download.txt").locator(".file-size").first();
    const localSize = row("right", "local.txt").locator(".file-size").first();
    assert.equal(await driveSize.textContent(), await localSize.textContent());
    assert.match(await driveSize.textContent(), /KiB/);
    const originalViewport = page.viewportSize();
    await page.setViewportSize({ width: 520, height: originalViewport.height });
    for (const value of [driveSize, localSize]) {
      assert.ok(await value.evaluate((cell) => cell.scrollWidth <= cell.clientWidth), "A file size was clipped in the narrow pane");
    }
    await page.setViewportSize(originalViewport);
    await row("left", "download.txt").click();
    await list("left").press("F5");
    const copy = page.getByRole("dialog", { name: "Copy", exact: true });
    assert.equal(await copy.getByRole("combobox", { name: "Destination", exact: true }).inputValue(), home);
    await button(copy, "Copy").click();
    await page.waitForFunction(() => !!window.driveFixture.transfer);
    assert.deepEqual(await page.evaluate(() => window.driveFixture.transfer.source), {
      kind: "google_drive", profile: "a", item: "copy", name: "download.txt", parent: "second", folder: false,
    });
    await dialog().waitFor({ state: "hidden" });
    for (const [shortcut, title, name] of [["F7", "New folder", "Demo folder"], ["Shift+F4", "New file", "Demo.txt"]]) {
      await list("left").press(shortcut);
      const action = page.getByRole("dialog", { name: title, exact: true });
      await action.getByRole("textbox", { name: "Name", exact: true }).fill(name);
      await button(action, "Create").click();
      await row("left", name).waitFor();
      await action.waitFor({ state: "hidden" });
    }
    await row("left", "Demo.txt").click();
    await (await openMainMenu(page, "Files")).getByRole("menuitem", { name: "Rename", exact: true }).click();
    const rename = page.getByRole("dialog", { name: "Rename", exact: true });
    await rename.getByRole("textbox", { name: "Name", exact: true }).fill("Renamed.txt");
    await button(rename, "Rename").click();
    await row("left", "Renamed.txt").waitFor();
    await rename.waitFor({ state: "hidden" });
    await list("left").press("F8");
    const trash = page.getByRole("dialog", { name: "Move to Trash", exact: true });
    await button(trash, "Move to Trash").click();
    await row("left", "Renamed.txt").waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.driveFixture.changes), [
      { kind: "createFolder", parent: "second", name: "Demo folder" },
      { kind: "createFile", parent: "second", name: "Demo.txt" },
      { kind: "rename", item: "created-2", name: "Renamed.txt" },
      { kind: "trash", item: "created-2" },
    ]);
    await row("left", "08.09.xlsx").click();
    await list("left").press("F4");
    await page.waitForFunction(() => window.driveFixture.opened === "https://drive.google.com/file/d/excel/view");
    await row("left", "Paper").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Edit in browser" }).click();
    await page.waitForFunction(() => window.driveFixture.opened?.startsWith("https://docs.google.com/"));

    await button(pane("left"), "Open Google Drive connection list").click();
    await row("left", "Renamed").waitFor();
    assert.equal(await row("left", "Renamed").getAttribute("data-current"), "true");
    await button(pane("left"), "Back").click();
    await row("left", "download.txt").waitFor();

    await page.evaluate(() => { window.driveFixture.mixedMove = []; });
    for (const name of ["08.09.xlsx", "download.txt", "Paper"]) {
      await row("left", name).click({ modifiers: ["Control"] });
    }
    await list("left").press("F6");
    await button(renameOrMove, "Move").click();
    const mixedResult = page.getByRole("dialog", { name: "Transfer complete", exact: true });
    await mixedResult.getByText("Saved local links.", { exact: false }).waitFor();
    await mixedResult.getByText("Fixture transfer denied.", { exact: false }).waitFor();
    assert.deepEqual((await page.evaluate(() => window.driveFixture.mixedMove)).sort(), ["copy", "doc", "excel"]);
    await button(mixedResult, "Done").click();
    await page.evaluate(() => { window.driveFixture.mixedMove = null; });

    await chooseDrive("right");
    await page.evaluate(() => { window.driveFixture.nextAccount = "b"; });
    await add("right");
    await row("right", "Work").dblclick();
    await row("right", "work.txt").waitFor();
    await row("left", "download.txt").waitFor();

    await page.evaluate(() => { window.driveFixture.denied = true; });
    await button(pane("left"), "Refresh folder").click();
    await button(pane("left"), "Reconnect").click();
    await page.evaluate(() => { window.driveFixture.denied = false; });
    await button(dialog(), "Reconnect").click();
    await dialog().waitFor({ state: "hidden" });
    await row("left", "download.txt").waitFor();

    const bookmarkDialog = page.getByRole("dialog", { name: "Folder shortcuts", exact: true });
    await list("left").dispatchEvent("keydown", { key: "8", code: "Digit8", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    await bookmarkDialog.getByRole("textbox", { name: "Title (optional)", exact: true }).fill("Second duplicate folder");
    await button(bookmarkDialog, "Save").click();
    await bookmarkDialog.waitFor({ state: "hidden" });
    await list("right").focus();
    await (await openMainMenu(page, "Commands")).getByRole("menuitem", { name: "Folder shortcuts", exact: true }).click();
    await bookmarkDialog.getByRole("button", { name: /^Group 7/ }).click();
    await button(bookmarkDialog, "Add").click();
    await bookmarkDialog.getByRole("textbox", { name: "Title (optional)", exact: true }).fill("Work Drive root");
    await button(bookmarkDialog, "Save").click();
    await bookmarkDialog.getByRole("option", { name: /^Work Drive root/ }).waitFor();
    await page.keyboard.press("Escape");
    const driveShortcuts = await page.evaluate(() => JSON.parse(localStorage.getItem("dirlume.folder-shortcuts.v1")));
    assert.equal(driveShortcuts[8][0].location.folders.at(-1).id, "second");
    assert.equal(driveShortcuts[7][0].location.id, "b");
    assert.deepEqual(driveShortcuts[7][0].location.folders, []);
    await page.evaluate(() => sessionStorage.setItem("drive-fixture-profiles", JSON.stringify(window.driveFixture.profiles)));
    await page.reload();
    const openGroup = async (side, digit) => {
      await list(side).focus();
      await page.keyboard.down("ControlRight");
      await page.keyboard.press(`Digit${digit}`);
      await page.keyboard.up("ControlRight");
    };
    await openGroup("right", 8);
    await row("right", "download.txt").waitFor();
    assert.ok((await page.evaluate(() => window.driveFixture.called)).some(([account, folder]) => account === "a" && folder === "second"));
    await openGroup("left", 7);
    await row("left", "work.txt").waitFor();

    const analyze = (side) => button(pane(side), "Analyze space");
    const analyzer = page.getByRole("region", { name: "Space Analyzer", exact: true });
    const diskInfo = page.getByRole("region", { name: "Disk information", exact: true });
    await analyze("right").filter({ hasText: "40 GiB free" }).waitFor();
    assert.equal(await pane("left").locator(".space-meter").count(), 0);
    await list("left").press("Control+Shift+l");
    await diskInfo.getByText("5 GiB", { exact: true }).waitFor();
    assert.equal(await diskInfo.getByRole("meter").count(), 0);
    assert.equal(await diskInfo.getByText("b@example.test", { exact: true }).count(), 1);
    assert.deepEqual(await page.evaluate(() => window.driveFixture.spaceCalls), []);
    await button(diskInfo, "Scan My Drive").click();
    await analyzer.getByText("work.txt", { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.driveFixture.spaceCalls), [["b", "root", null]]);
    await button(analyzer, "Close").click();
    await analyze("right").click();
    await analyzer.getByText("download.txt", { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.driveFixture.spaceCalls), [["b", "root", null], ["a", "second", null]]);
    await button(analyzer, "Close").click();

    await page.evaluate(() => { window.driveFixture.waitForPage = true; });
    await pane("right").locator('summary[aria-label="Analysis scope"]').click();
    await pane("right").getByRole("button", { name: /Analyze My Drive/ }).click();
    await page.waitForFunction(() => !!window.driveFixture.resumeSpacePage);
    await button(analyzer, "Stop").click();
    await analyzer.getByRole("status").filter({ hasText: "Partial results" }).waitFor();
    await page.evaluate(() => { window.driveFixture.waitForPage = false; window.driveFixture.resumeSpacePage(); });
    await button(analyzer, "Rescan").click();
    await analyzer.getByText("Unknown size", { exact: true }).waitFor();
    await button(analyzer, "Stop").waitFor({ state: "hidden" });
    await analyzer.getByText("6 KiB", { exact: true }).waitFor();
    await button(analyzer, "Treemap").click();
    const duplicateTile = analyzer.getByRole("button", { name: /Duplicate.*3 KiB/ });
    await duplicateTile.click();
    await analyzer.getByRole("button", { name: /download.txt/ }).waitFor();
    await analyzer.getByRole("button", { name: /download.txt/ }).click();
    await button(analyzer, "Show in other pane").click();
    await row("left", "download.txt").waitFor();
    assert.equal(await row("left", "download.txt").getAttribute("data-current"), "true");
    await button(analyzer, "Close").click();
    await openGroup("left", 7);
    await row("left", "work.txt").waitFor();

    await button(pane("right"), "Open Google Drive connection list").click();
    await row("right", "Renamed").click();
    await list("right").press("F4");
    await button(dialog(), "Remove connection").click();
    await button(dialog(), "Remove connection").click();
    await row("right", "Work").waitFor();
    await row("left", "work.txt").waitFor();
    assert.equal(await row("left", "Renamed").count(), 0);
    assert.equal(await row("right", "Renamed").count(), 0);
    await page.close();
  }
} finally {
  await browser.close();
}
