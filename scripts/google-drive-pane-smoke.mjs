import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

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
      const state = window.driveFixture = { profiles: [], called: [], transfer: null, cancel: null, denied: false };
      const profile = (id, name) => ({ id, label: name, email: id + "@example.test", signInNeeded: false });
      const item = (id, name, fields = {}) => ({
        id, name, directory: false, modified: null, size: 42, download: true, webViewLink: null, ...fields,
      });
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args) => {
          switch (command) {
            case "locations": return [{ label: "Home", path: home }];
            case "list_directory": return { path: args.path, parent: null, entries: [], omitted: 0 };
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
            case "list_google_drive":
              state.called.push([args.id, args.folder]);
              if (state.denied && args.id === "a") throw new Error("Sign in to this Google Drive account again.");
              if (args.id === "b") return [item("work", "work.txt")];
              if (args.folder === "root") return [
                item("first", "Duplicate", { directory: true, download: false }),
                item("second", "Duplicate", { directory: true, download: false }),
              ];
              if (args.folder === "first") return [item("ordinary", "first.txt")];
              return [item("copy", "download.txt"), item("doc", "Paper", {
                download: false, webViewLink: "https://docs.google.com/document/d/example/edit",
              })];
            case "open_web_link": state.opened = args.href; return null;
            case "transfer_item": state.transfer = args.request; return { kind: "completed" };
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
    await duplicates.nth(1).dblclick();
    await row("left", "download.txt").waitFor();
    await row("left", "download.txt").click();
    await list("left").press("F5");
    const copy = page.getByRole("dialog", { name: "Copy", exact: true });
    assert.equal(await copy.getByRole("combobox", { name: "Destination", exact: true }).inputValue(), home);
    await button(copy, "Copy").click();
    await page.waitForFunction(() => !!window.driveFixture.transfer);
    assert.deepEqual(await page.evaluate(() => window.driveFixture.transfer.source), {
      kind: "google_drive", profile: "a", item: "copy", name: "download.txt",
    });
    await dialog().waitFor({ state: "hidden" });
    await row("left", "Paper").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Open in browser" }).click();
    await page.waitForFunction(() => window.driveFixture.opened?.startsWith("https://docs.google.com/"));

    await button(pane("left"), "Open Google Drive connection list").click();
    await row("left", "Renamed").waitFor();
    assert.equal(await row("left", "Renamed").getAttribute("data-current"), "true");
    await button(pane("left"), "Back").click();
    await row("left", "download.txt").waitFor();

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

    await button(pane("right"), "Open Google Drive connection list").click();
    await row("right", "Renamed").click();
    await list("right").press("F4");
    await button(dialog(), "Remove connection").click();
    await button(dialog(), "Remove connection").click();
    await row("left", "Work").waitFor();
    assert.equal(await row("left", "Renamed").count(), 0);
    assert.equal(await row("right", "Renamed").count(), 0);
    await page.close();
  }
} finally {
  await browser.close();
}
