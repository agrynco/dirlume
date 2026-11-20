import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const local = { id: "local", name: "Local palette", base: "light", colors: { canvas: "#f0f0f0" }, fonts: {} };
const evening = { id: "evening", name: "Evening palette", base: "dark", colors: { canvas: "#121824" }, fonts: { panel: { family: "Fixture Sans", size: 17 } } };
const standalone = { id: "single", name: "Standalone palette", base: "sunrise", colors: { canvas: "#fef2dd" }, fonts: {} };
const archive = (groups, schemes) => JSON.stringify({ format: "dirlume-settings", version: 1, groups, schemes });

const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 770 }, locale: "en-US" });
  page.setDefaultTimeout(8000);
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  await page.addInitScript(({ local, evening }) => {
    const key = "dirlume.preferences.v1";
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
      layout: "standard", mainMenuAlignment: "right", schemes: [local, evening], activeScheme: null,
      activeShortcutScheme: "custom-keys", bindingDefaults: 7,
      shortcutSchemes: [{ id: "custom-keys", name: "My keys", bindings: { newFile: ["Ctrl+Alt+N"] } }],
    }));
    const home = /Windows/i.test(navigator.userAgent) ? "C:\\fixture" : "/fixture";
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args) => {
        if (command === "locations") return [{ label: "Home", path: home }];
        if (command === "list_directory") return { path: home, parent: null, entries: [], omitted: 0 };
        if (command === "read_settings_archive") return window.settingsInput ?? null;
        if (command === "write_settings_archive") {
          if (window.cancelSave) return false;
          window.settingsExport = JSON.parse(args.contents);
          return true;
        }
        return null;
      },
    };
  }, { local, evening });
  await page.goto("http://dirlume.test/");
  const openOptions = () => page.getByRole("button", { name: "Options", exact: true }).click();
  const dialog = (name) => page.getByRole("dialog", { name, exact: true });
  const button = (parent, label) => parent.getByRole("button", { name: label, exact: true });
  const check = (parent, label) => parent.getByRole("checkbox", { name: label, exact: true });
  const readPreferences = () => page.evaluate(() => JSON.parse(localStorage.getItem("dirlume.preferences.v1")));
  const exported = () => page.evaluate(() => window.settingsExport);
  await openOptions();
  const options = dialog("Options");
  const exportDialog = dialog("Export settings");
  const importDialog = dialog("Import settings");
  const startImport = async (file) => {
    await page.evaluate((contents) => { window.settingsInput = contents; }, file);
    await button(options, "Import settings").click();
  };

  await button(options, "Export settings").click();
  assert.equal(await button(exportDialog, "Export").isDisabled(), true);
  await check(exportDialog, local.name).check();
  await check(exportDialog, evening.name).check();
  await page.evaluate(() => { window.cancelSave = true; });
  await button(exportDialog, "Export").click();
  await button(exportDialog, "Export").waitFor();
  assert.equal(await exported(), undefined);
  await page.evaluate(() => { window.cancelSave = false; });
  await button(exportDialog, "Export").click();
  await exportDialog.waitFor({ state: "hidden" });
  const themeFile = await exported();
  assert.deepEqual(themeFile.groups, {});
  assert.deepEqual(themeFile.schemes.map(({ name }) => name), [local.name, evening.name]);
  assert.deepEqual(themeFile.schemes[1].fonts.panel, evening.fonts.panel);

  await button(options, "Export settings").click();
  for (const group of ["General", "Appearance", "Keyboard shortcuts", "Main File Panels", "Terminal", "Viewer"]) {
    await check(exportDialog, group).check();
  }
  await button(exportDialog, "Export").click();
  await exportDialog.waitFor({ state: "hidden" });
  const settingsFile = await exported();
  assert.deepEqual(Object.keys(settingsFile.groups).sort(), ["appearance", "filePanels", "general", "shortcuts", "terminal", "viewer"]);
  assert.deepEqual(settingsFile.schemes, []);
  assert.deepEqual(settingsFile.groups.shortcuts.shortcutSchemes[0].bindings.newFile, ["Ctrl+Alt+N"]);

  await startImport(JSON.stringify(standalone));
  assert.equal(await check(importDialog, standalone.name).isChecked(), true);
  await button(importDialog, "Import").click();
  await importDialog.waitFor({ state: "hidden" });
  await page.reload();
  await openOptions();
  await button(options, "Appearance").click();
  const scheme = options.getByRole("combobox", { name: "Color scheme", exact: true });
  const importedScheme = scheme.getByRole("option", { name: standalone.name, exact: true });
  assert.equal(await importedScheme.getAttribute("value"), "custom:single");
  await scheme.selectOption("custom:single");
  await button(options, "Apply").click();
  await page.locator('html[data-theme="sunrise"]').waitFor();
  assert.equal((await readPreferences()).activeScheme, standalone.id);

  const other = { ...evening, id: "other", name: "Imported second", colors: { canvas: "#212c33" } };
  const changed = { ...local, id: "source-local", colors: { canvas: "#fafafa" } };
  const mixed = archive({ ...settingsFile.groups, general: { language: "uk" }, filePanels: { layout: "twin" } }, [changed, other]);
  await startImport(mixed);
  for (const group of ["General", "Appearance", "Keyboard shortcuts", "Terminal", "Viewer"]) await check(importDialog, group).uncheck();
  await check(importDialog, other.name).uncheck();
  const before = await readPreferences();
  await button(importDialog, "Import").click();
  const confirm = dialog("Replace color schemes?");
  await confirm.getByText(local.name, { exact: true }).waitFor();
  await button(confirm, "Cancel").click();
  assert.deepEqual(await readPreferences(), before);
  await button(importDialog, "Import").click();
  await button(confirm, "Replace and import").click();
  const after = await readPreferences();
  assert.equal(after.layout, "twin");
  assert.equal(after.language, before.language);
  assert.equal(after.mainMenuAlignment, "right");
  assert.equal(after.activeScheme, standalone.id);
  assert.equal(after.schemes.find(({ id }) => id === local.id).colors.canvas, "#fafafa");
  assert.equal(after.schemes.some(({ id }) => id === other.id), false);

  const invalidDialog = dialog("Could not import settings");
  for (const [input, message] of [
    ["{bad json", "The settings file is invalid."],
    [JSON.stringify({ ...themeFile, version: 2 }), "This settings file version is not supported."],
    [archive({ filePanels: { layout: "bad" } }, []), "The settings file is invalid."],
  ]) {
    await startImport(input);
    await invalidDialog.getByRole("alert").getByText(message, { exact: true }).waitFor();
    await button(invalidDialog, "Close").click();
    assert.deepEqual(await readPreferences(), after);
  }
  await startImport(null);
  await button(options, "Import settings").waitFor();
  assert.equal(await importDialog.count(), 0);
  assert.deepEqual(await readPreferences(), after);

  await page.evaluate(() => localStorage.removeItem("dirlume.preferences.v1"));
  await page.reload();
  await page.evaluate(() => {
    const key = "dirlume.preferences.v1";
    const saved = JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify({ ...saved, schemes: [], shortcutSchemes: [], activeShortcutScheme: null }));
  });
  await page.reload();
  await openOptions();
  await startImport(JSON.stringify(themeFile));
  await button(importDialog, "Import").click();
  assert.deepEqual((await readPreferences()).schemes, themeFile.schemes);
  await startImport(archive({ shortcuts: settingsFile.groups.shortcuts }, []));
  await button(importDialog, "Import").click();
  const restored = await readPreferences();
  assert.equal(restored.activeShortcutScheme, "custom-keys");
  assert.deepEqual(restored.shortcutSchemes[0].bindings.newFile, ["Ctrl+Alt+N"]);
  console.log("Verified selective settings export and import, theme round trips, replacement confirmation, restart, and cancel and error handling.");
} finally {
  await browser.close();
}
