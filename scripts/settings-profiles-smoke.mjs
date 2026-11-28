import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const storageKey = "dirlume.preferences.v1";

async function testProfiles(browser, userAgent) {
  const page = await browser.newPage({ viewport: { width: 1150, height: 750 }, userAgent });
  const parentShortcut = /Macintosh/.test(userAgent) ? "⌃PageUp" : "Ctrl+PageUp";
  try {
    page.setDefaultTimeout(8000);
    await page.route("http://dirlume.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    await page.addInitScript((storageKey) => {
      if (!localStorage.getItem(storageKey)) localStorage.setItem(storageKey, JSON.stringify({
        bindingDefaults: 10, shortcutSchemes: [{ id: "named", name: "Independent shortcuts", bindings: {
          parent: ["Alt+ArrowUp"], openInSystem: [],
        } }],
      }));
      const home = /Windows/.test(navigator.userAgent) ? "C:\\fixture" : "/fixture";
      const entries = [{ name: "draft.txt", directory: false, hidden: false, size: 5, modified: null }];
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args) => {
          if (command === "locations") return [{ label: "Home", path: home }];
          if (command === "list_directory") return { path: args.path, parent: null, entries, omitted: 0 };
          if (command === "file_icons" || command === "installed_fonts") return [];
          if (command === "read_text") return { text: "draft", encoding: "utf8" };
          if (command === "ftp_profiles") return [];
          if (command === "ssh_profiles") return [{ id: "ssh", label: "Profile fixture", host: "fixture", port: 22 }];
          if (command === "connect_ssh") return { kind: "connected", id: 5, address: "SFTP fixture", origin: "sftp://fixture",
            segments: ["remote"], listing: { entries, omitted: 0, elevated: false } };
          if (command === "list_ssh") return { entries, omitted: 0, elevated: false };
          return null;
        },
      };
    }, storageKey);
    await page.goto("http://dirlume.test/");
    const options = page.getByRole("dialog", { name: "Options", exact: true });
    const activeProfile = options.getByRole("combobox", { name: "Current profile", exact: true });
    const preferences = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
    const open = () => button(page, "Options").click();
    const profiles = () => button(options, "Profiles").click();
    const shortcuts = () => button(options, "Keyboard shortcuts").click();
    const done = async () => {
      await button(options, "Done").click();
      await options.waitFor({ state: "hidden" });
    };
    const choose = (name) => activeProfile.selectOption({ label: name });
    const saveName = async (dialogTitle, name) => {
      const dialog = page.getByRole("dialog", { name: dialogTitle, exact: true });
      await dialog.getByRole("textbox", { name: "Profile name", exact: true }).fill(name);
      await button(dialog, "Save profile").click();
      await dialog.waitFor({ state: "hidden" });
    };
    const openProfiles = async () => { await open(); await profiles(); };
    const switchDialog = page.getByRole("dialog", { name: "Switch profile", exact: true });
    const left = page.locator("#left-files");
    const rightPane = page.getByRole("region", { name: "right pane", exact: true });
    const path = (side) => page.locator(`#${side}-path`).getAttribute("data-path");
    const waitTheme = (theme) => page.locator(`html[data-theme="${theme}"]`).waitFor();
    const initial = await preferences();
    assert.equal(initial.layout, "standard");
    assert.equal(initial.activeSettingsProfile, null);

    await button(rightPane, "Locations for right pane").click();
    await button(rightPane, "NetBox").click();
    await rightPane.getByRole("option", { name: /^Profile fixture/ }).dblclick();
    await page.waitForFunction(() => document.querySelector("#right-path")?.dataset.path === "/remote");
    const leftLocation = await path("left");

    await open();
    const query = options.getByRole("searchbox", { name: "Search settings", exact: true });
    await query.fill("Far Manager");
    await query.press("Enter");
    await activeProfile.waitFor();
    await query.fill("");
    await choose("Far Manager");
    assert.equal(await activeProfile.inputValue(), "far");
    assert.ok((await options.locator(".profile-shortcuts").innerText()).includes(parentShortcut));
    assert.equal((await preferences()).layout, "standard");
    await page.keyboard.press("Escape");
    await options.waitFor({ state: "hidden" });
    assert.equal((await preferences()).activeSettingsProfile, null);

    await left.getByRole("option", { name: /^draft\.txt/ }).click();
    await left.press("F4");
    const editor = page.locator(".text-window:not([hidden]) .cm-content");
    await editor.press("End");
    await editor.press("X");
    await openProfiles();
    await choose("Far Manager");
    await button(options, "Apply").click();
    await waitTheme("classic-blue");
    assert.equal((await preferences()).rightClickSelection, true);
    assert.deepEqual((await preferences()).selectedPanelModes, { left: "brief", right: "brief" });
    await done();
    assert.match(await editor.innerText(), /draftx/i);
    assert.equal(await path("left"), leftLocation);
    assert.equal(await path("right"), "/remote");
    await button(page.locator(".text-window:not([hidden])"), "Close document").click();
    await button(page.getByRole("dialog", { name: "Unsaved changes" }), "Discard changes").click();

    await openProfiles();
    await button(options, "Duplicate profile").click();
    await saveName("Duplicate profile", "My layout");
    await choose("My layout");
    await shortcuts();
    await button(options, `Remove ${parentShortcut} from Parent folder`).click();
    await profiles();
    await options.getByText("Modified", { exact: true }).waitFor();
    await button(options, "Update profile").click();
    await button(options, "Rename profile").click();
    await saveName("Rename profile", "Saved layout");
    await done();
    let prefs = await preferences();
    assert.deepEqual(prefs.profileBindings.parent, []);
    assert.deepEqual(prefs.shortcutSchemes, initial.shortcutSchemes);
    assert.equal(prefs.settingsProfiles[0].name, "Saved layout");
    const customId = prefs.activeSettingsProfile;
    await page.reload();
    await waitTheme("classic-blue");
    assert.equal((await preferences()).activeSettingsProfile, customId);
    assert.deepEqual((await preferences()).profileBindings.parent, []);

    await openProfiles();
    await shortcuts();
    await button(options, "Remove Space from Clear marks").click();
    await profiles();
    await done();
    await openProfiles();
    await options.getByText("Modified", { exact: true }).waitFor();
    await choose("Total Commander");
    await button(switchDialog, "Cancel").click();
    assert.equal(await activeProfile.inputValue(), customId);
    await choose("Total Commander");
    await button(switchDialog, "Save as profile and switch").click();
    await saveName("Save current setup as profile", "Before switching");
    await done();
    await waitTheme("light");
    prefs = await preferences();
    assert.equal(prefs.activeSettingsProfile, "total");
    assert.deepEqual(prefs.selectedPanelModes, { left: "full", right: "full" });
    assert.ok(prefs.profileBindings.rename.includes("Shift+F6"));
    assert.ok(prefs.profileBindings.folderShortcuts.includes("Ctrl+D"));
    assert.deepEqual(prefs.settingsProfiles.find(({ name }) => name === "Before switching").values.bindings.clearMarks, []);

    await openProfiles();
    await choose("Saved layout");
    await button(options, "Delete profile").click();
    await button(page.getByRole("dialog", { name: "Delete profile", exact: true }), "Delete profile").click();
    await done();
    await waitTheme("classic-blue");
    prefs = await preferences();
    assert.equal(prefs.activeSettingsProfile, null);
    assert.deepEqual(prefs.profileBindings.parent, []);
    assert.equal(prefs.layout, "classic");

    await page.evaluate((key) => {
      const prefs = JSON.parse(localStorage.getItem(key));
      prefs.activeSettingsProfile = "missing";
      prefs.settingsProfiles[0].values.theme = "midnight";
      prefs.settingsProfiles[0].values.colorSchemeId = "missing-color";
      localStorage.setItem(key, JSON.stringify(prefs));
    }, storageKey);
    await page.reload();
    await waitTheme("classic-blue");
    assert.equal((await preferences()).activeSettingsProfile, null);
    await openProfiles();
    await choose("Before switching");
    await button(switchDialog, "Discard and switch").click();
    await options.getByText("The saved color scheme is missing. The profile uses Midnight blue.", { exact: true }).waitFor();
    await done();
    await waitTheme("midnight");
    assert.deepEqual((await preferences()).profileBindings.clearMarks, []);
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch({ channel: "chrome" });
try {
  await testProfiles(browser, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  await testProfiles(browser, "Mozilla/5.0 (X11; Linux x86_64)");
  await testProfiles(browser, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
  console.log("Verified pending apply, presets, custom profiles, modified settings, independent shortcuts, restart, and missing references.");
} finally {
  await browser.close();
}
