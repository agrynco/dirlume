import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { settingsArchiveAction } from "./tool-window-smoke.mjs";

const local = { id: "local", name: "Local palette", base: "light", colors: { canvas: "#f0f0f0" }, fonts: {} };
const evening = {
  id: "evening", name: "Evening palette", base: "dark",
  colors: { canvas: "#121824", "terminal-cursor": "#abcdef", "editor-syntax-keyword": "#ffee22", "viewer-outside-bg": "#670456" },
  fonts: { panel: { family: "Fixture Sans", size: 17 }, markdown: { family: "An unavailable font", size: 22 } },
};
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
      kswitcher: "Fixture installation folder",
      viewerContentWidth: 630, viewerMarkdownContentWidth: "full",
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
  const archiveMenuTrigger = button(options, "Settings archive");
  await archiveMenuTrigger.press("ArrowDown");
  const archiveMenu = options.getByRole("menu", { name: "Settings archive", exact: true });
  const importItem = archiveMenu.getByRole("menuitem", { name: "Import settings", exact: true });
  const exportItem = archiveMenu.getByRole("menuitem", { name: "Export settings", exact: true });
  assert.ok(await importItem.evaluate((element) => document.activeElement === element));
  await importItem.press("End");
  assert.ok(await exportItem.evaluate((element) => document.activeElement === element));
  await exportItem.press("Escape");
  await archiveMenu.waitFor({ state: "hidden" });
  assert.ok(await archiveMenuTrigger.evaluate((element) => document.activeElement === element));
  const exportDialog = dialog("Export settings");
  const importDialog = dialog("Import settings");
  const startImport = async (file) => {
    await page.evaluate((contents) => { window.settingsInput = contents; }, file);
    await settingsArchiveAction(options, "Import settings");
  };

  async function assertAdjacent(control) {
    const bounds = await control.evaluate((input) => {
      const label = input.closest("label");
      const text = label.firstElementChild.getBoundingClientRect();
      const field = input.getBoundingClientRect();
      return { gap: field.left - text.right, verticalOffset: Math.abs((field.top + field.bottom - text.top - text.bottom) / 2),
        fits: field.right <= label.getBoundingClientRect().right + 1 };
    });
    assert.ok(bounds.gap >= 0 && bounds.gap <= 9 && bounds.verticalOffset <= 1 && bounds.fits, JSON.stringify(bounds));
  }

  await button(options, "Appearance").click();
  const menuAlignment = options.getByRole("combobox", { name: "Main menu alignment", exact: true });
  for (const width of [600, 1800]) {
    await page.setViewportSize({ width, height: 770 });
    await assertAdjacent(menuAlignment);
  }
  await button(options, "Panel modes").click();
  const modeSettings = options.locator(".panel-mode-settings");
  for (const width of [600, 1800]) {
    await page.setViewportSize({ width, height: 770 });
    for (const mode of ["Brief", "Medium", "Full", "Wide", "File owners", "File links", "Alternative full"]) {
      await button(options, mode).click();
      await assertAdjacent(modeSettings.getByRole("textbox", { name: "Name", exact: true }));
      const pairs = await modeSettings.getByRole("checkbox").evaluateAll((inputs) => inputs.map((input) => {
        const checkbox = input.getBoundingClientRect();
        return { left: checkbox.left, gap: input.closest("label").firstElementChild.getBoundingClientRect().left - checkbox.right };
      }));
      assert.ok(pairs.length > 1 && pairs.every(({ left, gap }) => left === pairs[0].left && gap >= 0 && gap <= 9), mode);
    }
  }
  const folderExtensions = check(modeSettings, "Align folder extensions");
  const wasChecked = await folderExtensions.isChecked();
  await modeSettings.getByText("Align folder extensions", { exact: true }).click();
  assert.equal(await folderExtensions.isChecked(), !wasChecked);
  await folderExtensions.press("Space");
  assert.equal(await folderExtensions.isChecked(), wasChecked);

  await button(options, "Main File Panels").click();
  const visibility = check(options, "Hide action button icons");
  const panelLayout = options.getByRole("combobox", { name: "Panel layout", exact: true });
  const buttonWidth = options.getByRole("combobox", { name: "Action button width", exact: true });
  for (const width of [600, 1800]) {
    await page.setViewportSize({ width, height: 770 });
    await assertAdjacent(panelLayout);
    await assertAdjacent(buttonWidth);
  }
  const actionBar = page.locator(".actionbar");
  assert.equal(await visibility.isChecked(), false);
  await panelLayout.selectOption("twin");
  await button(options, "Apply").click();
  assert.ok(await actionBar.locator("button > svg:visible").count() > 0);
  await visibility.check();
  for (const layout of ["standard", "twin", "classic"]) {
    await panelLayout.selectOption(layout);
    for (const width of ["compact", "full"]) {
      await buttonWidth.selectOption(width);
      await button(options, "Apply").click();
      assert.equal(await actionBar.locator("button > svg").count(), 0);
      assert.match(await actionBar.locator("button").last().getAttribute("data-tooltip"), /Terminal/);
      assert.equal(await actionBar.locator("button").last().locator("span").textContent(), "Terminal");
    }
  }
  await panelLayout.selectOption("standard");
  await buttonWidth.selectOption("compact");
  await button(options, "Done").click();
  await page.setViewportSize({ width: 1100, height: 770 });
  await page.reload();
  assert.equal((await readPreferences()).hideActionButtonIcons, true);
  await actionBar.locator("button").last().waitFor();
  assert.equal(await actionBar.locator("button > svg").count(), 0);
  await openOptions();

  await settingsArchiveAction(options, "Export settings");
  const groupChecks = exportDialog.getByRole("group", { name: "Settings groups", exact: true }).getByRole("checkbox");
  const allChecks = exportDialog.getByRole("checkbox");
  const assertDefaultSelection = async () => {
    assert.ok(await allChecks.evaluateAll((inputs) => inputs.length > 0 && inputs.every((input) => input.checked)));
    assert.equal(await button(exportDialog, "Export").isDisabled(), false);
  };
  await assertDefaultSelection();
  const groupCount = await groupChecks.count();
  await page.evaluate(() => { window.cancelSave = true; });
  await button(exportDialog, "Export").click();
  await button(exportDialog, "Export").waitFor();
  assert.equal(await exported(), undefined);
  await page.evaluate(() => { window.cancelSave = false; });
  await button(exportDialog, "Export").click();
  await exportDialog.waitFor({ state: "hidden" });
  const fullFile = await exported();
  assert.equal(Object.keys(fullFile.groups).length, groupCount);
  assert.deepEqual(fullFile.schemes.map(({ id }) => id), [local.id, evening.id]);

  await settingsArchiveAction(options, "Export settings");
  await assertDefaultSelection();
  for (const group of await groupChecks.all()) await group.uncheck();
  await button(exportDialog, "Export").click();
  await exportDialog.waitFor({ state: "hidden" });
  const themeFile = await exported();
  assert.deepEqual(themeFile.groups, {});
  assert.deepEqual(themeFile.schemes.map(({ name }) => name), [local.name, evening.name]);
  assert.deepEqual(themeFile.schemes[1].fonts.panel, evening.fonts.panel);
  assert.deepEqual(themeFile.schemes[1].fonts.markdown, evening.fonts.markdown);
  assert.deepEqual(themeFile.schemes[1].colors, evening.colors);

  await settingsArchiveAction(options, "Export settings");
  await assertDefaultSelection();
  for (const item of await allChecks.all()) await item.uncheck();
  assert.equal(await button(exportDialog, "Export").isDisabled(), true);
  for (const group of ["General", "Appearance", "Keyboard shortcuts", "Main File Panels", "Terminal", "Viewer"]) {
    await check(exportDialog, group).check();
  }
  await button(exportDialog, "Export").click();
  await exportDialog.waitFor({ state: "hidden" });
  const settingsFile = await exported();
  assert.deepEqual(Object.keys(settingsFile.groups).sort(), ["appearance", "filePanels", "general", "shortcuts", "terminal", "viewer"]);
  assert.deepEqual(settingsFile.schemes, []);
  assert.equal(Object.hasOwn(settingsFile.groups.general, "kswitcher"), false);
  assert.deepEqual(settingsFile.groups.shortcuts.shortcutSchemes[0].bindings.newFile, ["Ctrl+Alt+N"]);
  assert.equal(settingsFile.groups.filePanels.hideActionButtonIcons, true);
  assert.deepEqual(settingsFile.groups.viewer, { viewerContentWidth: 630, viewerMarkdownContentWidth: "full" });
  await button(options, "Main File Panels").click();
  await visibility.uncheck();
  await button(options, "Apply").click();
  assert.ok(await actionBar.locator("button > svg").count() > 0);

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
  const mixed = archive({ ...settingsFile.groups, general: { language: "uk" },
    filePanels: { layout: "twin", hideActionButtonIcons: settingsFile.groups.filePanels.hideActionButtonIcons } }, [changed, other]);
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
  assert.equal(after.hideActionButtonIcons, true);
  assert.equal(after.language, before.language);
  assert.equal(after.mainMenuAlignment, "right");
  assert.equal(after.activeScheme, standalone.id);
  assert.equal(after.schemes.find(({ id }) => id === local.id).colors.canvas, "#fafafa");
  assert.equal(after.schemes.some(({ id }) => id === other.id), false);

  const invalidDialog = dialog("Could not import settings");
  for (const [input, message] of [
    ["{bad json", "The settings file is invalid."],
    [JSON.stringify({ ...themeFile, version: 3 }), "This settings file version is not supported."],
    [archive({ filePanels: { layout: "bad" } }, []), "The settings file is invalid."],
    [archive({ terminal: { terminalResizeRows: 51 } }, []), "The settings file is invalid."],
    [archive({ viewer: { viewerMarkdownContentWidth: "invalid" } }, []), "The settings file is invalid."],
    [archive({}, [{ ...evening, colors: { "terminal-cursor": "#bad" } }]), "The settings file is invalid."],
    [archive({}, [{ ...evening, fonts: { compare: { size: 400 } } }]), "The settings file is invalid."],
  ]) {
    await startImport(input);
    await invalidDialog.getByRole("alert").getByText(message, { exact: true }).waitFor();
    await button(invalidDialog, "Close").click();
    assert.deepEqual(await readPreferences(), after);
  }
  await startImport(null);
  await button(options, "Settings archive").waitFor();
  assert.equal(await importDialog.count(), 0);
  assert.deepEqual(await readPreferences(), after);

  const legacy = JSON.parse(archive({
    general: { menuPosition: "left", retiredOption: true, kswitcher: "Other installation folder" },
    shortcuts: { shortcuts: { newFile: "Ctrl+Alt+M" } },
    retiredGroup: { unknownValue: 12 },
  }, []));
  legacy.version = 0;
  await startImport(JSON.stringify(legacy));
  await importDialog.waitFor();
  assert.deepEqual(await importDialog.getByRole("checkbox").evaluateAll((fields) => fields.map((field) => field.parentElement.textContent.trim())),
    ["General", "Keyboard shortcuts"]);
  await button(importDialog, "Import").click();
  await importDialog.waitFor({ state: "hidden" });
  const migrated = await readPreferences();
  assert.equal(migrated.mainMenuAlignment, "left");
  assert.equal(migrated.activeShortcutScheme, "my-shortcuts");
  assert.deepEqual(migrated.shortcutSchemes[0].bindings.newFile, ["Ctrl+Alt+M"]);
  assert.deepEqual(migrated.shortcutSchemes[0].bindings.firstRow, ["Home"]);
  assert.deepEqual(migrated.shortcutSchemes[0].bindings.leftRow, ["ArrowLeft"]);
  assert.deepEqual(migrated.shortcutSchemes[0].bindings.lastRow, ["End"]);
  assert.deepEqual(migrated.shortcutSchemes[0].bindings.rightRow, ["ArrowRight"]);
  assert.equal(migrated.language, after.language);
  assert.equal(migrated.kswitcher, "Fixture installation folder");
  assert.equal(Object.hasOwn(migrated, "retiredOption"), false);

  await startImport(archive({ filePanels: { layout: "classic", retiredOption: true } }, []));
  await button(importDialog, "Import").click();
  await importDialog.waitFor({ state: "hidden" });
  const current = await readPreferences();
  assert.equal(current.layout, "classic");
  assert.equal(current.mainMenuAlignment, "left");
  assert.equal(current.activeShortcutScheme, "my-shortcuts");
  await startImport(archive({ appearance: { viewFontSizes: { viewer: 23 } } }, []));
  await button(importDialog, "Import").click();
  await importDialog.waitFor({ state: "hidden" });
  assert.deepEqual((await readPreferences()).viewFontSizes, { viewer: 23, hex: 23 });

  await page.evaluate(() => localStorage.removeItem("dirlume.preferences.v1"));
  await page.reload();
  await page.evaluate(() => {
    const key = "dirlume.preferences.v1";
    const saved = JSON.parse(localStorage.getItem(key));
    delete saved.viewerContentWidth;
    delete saved.viewerMarkdownContentWidth;
    localStorage.setItem(key, JSON.stringify({ ...saved, schemes: [], shortcutSchemes: [], activeShortcutScheme: null }));
  });
  await page.reload();
  await openOptions();
  await settingsArchiveAction(options, "Export settings");
  await assertDefaultSelection();
  assert.equal(await exportDialog.getByRole("group", { name: "Color schemes", exact: true }).count(), 0);
  await button(exportDialog, "Cancel").click();
  await startImport(JSON.stringify(themeFile));
  await button(importDialog, "Import").click();
  assert.deepEqual((await readPreferences()).schemes, themeFile.schemes);
  await startImport(archive({ viewer: { viewerContentWidth: 640 } }, []));
  await button(importDialog, "Import").click();
  assert.equal((await readPreferences()).viewerContentWidth, 640);
  assert.equal((await readPreferences()).viewerMarkdownContentWidth, undefined);
  await startImport(archive({ shortcuts: settingsFile.groups.shortcuts, viewer: settingsFile.groups.viewer }, []));
  await button(importDialog, "Import").click();
  const restored = await readPreferences();
  assert.equal(restored.activeShortcutScheme, "custom-keys");
  assert.deepEqual(restored.shortcutSchemes[0].bindings.newFile, ["Ctrl+Alt+N"]);
  assert.equal(restored.viewerContentWidth, 630);
  assert.equal(restored.viewerMarkdownContentWidth, "full");
  const localBefore = restored.schemes.find(({ id }) => id === local.id);
  const openManagement = async () => {
    const search = options.getByRole("searchbox", { name: "Search settings" });
    await search.fill("Scheme to manage");
    await search.press("Enter");
  };
  await page.emulateMedia({ colorScheme: "light" });
  await openManagement();
  const managed = options.getByRole("combobox", { name: "Scheme to manage" });
  const name = options.getByRole("textbox", { name: "Scheme name", exact: true });
  const deletion = dialog("Delete color scheme");
  const deleteScheme = () => button(options, "Delete scheme").click();
  const favorite = (mode) => options.getByRole("combobox", { name: `Favorite ${mode} scheme`, exact: true });
  const appearance = () => page.locator("html").getAttribute("data-theme");
  await scheme.selectOption("light");
  await managed.selectOption(local.id);
  await name.fill("Daylight custom");
  assert.equal(await scheme.inputValue(), "light");
  await button(options, "Apply").click();
  assert.equal(await appearance(), "light");
  assert.deepEqual((await readPreferences()).schemes.find(({ id }) => id === local.id), { ...localBefore, name: "Daylight custom" });
  await managed.selectOption(evening.id);
  await deleteScheme();
  await deletion.getByText(evening.name, { exact: true }).waitFor();
  await button(deletion, "Keep scheme").click();
  assert.equal(await managed.getByRole("option", { name: evening.name }).count(), 1);

  await scheme.selectOption(`custom:${local.id}`);
  await managed.selectOption(local.id);
  assert.equal(await button(options, "Delete scheme").isDisabled(), true);
  await name.fill("Daylight renamed");
  await favorite("light").selectOption(`custom:${local.id}`);
  await favorite("dark").selectOption(`custom:${evening.id}`);
  await check(options, "Show color scheme switcher in the title bar").check();
  await button(options, "Apply").click();
  assert.equal((await readPreferences()).activeScheme, local.id);
  assert.equal(await page.locator(".topbar-scheme").getByRole("option", { name: "Daylight renamed" }).count(), 1);
  await scheme.selectOption("system");
  assert.ok(await button(options, "Delete scheme").isDisabled());
  await managed.selectOption(evening.id);
  await deleteScheme();
  await page.emulateMedia({ colorScheme: "dark" });
  await deletion.getByText("Switch to another color scheme before deleting this one.", { exact: true }).waitFor();
  assert.equal(await button(deletion, "Delete scheme").isDisabled(), true);
  await button(deletion, "Keep scheme").click();
  await page.emulateMedia({ colorScheme: "light" });
  await deleteScheme();
  await button(deletion, "Delete scheme").click();
  await button(options, "Done").click();
  await page.reload();
  const afterDeletion = await readPreferences();
  assert.equal(afterDeletion.theme, "system");
  assert.equal(afterDeletion.systemLightScheme, `custom:${local.id}`);
  assert.equal(afterDeletion.systemDarkScheme, "dark");
  assert.deepEqual(afterDeletion.schemes, [{ ...localBefore, name: "Daylight renamed" }]);
  await openOptions();
  await settingsArchiveAction(options, "Export settings");
  assert.ok(await check(exportDialog, "Daylight renamed").isVisible());
  assert.equal(await check(exportDialog, evening.name).count(), 0);
  await button(exportDialog, "Cancel").click();
  await openManagement();
  await scheme.selectOption("light");
  await name.fill("Unapplied rename");
  await deleteScheme();
  await button(deletion, "Delete scheme").click();
  await page.keyboard.press("Escape");
  assert.deepEqual(await readPreferences(), afterDeletion);
  console.log("Verified settings archive round trips and independent color scheme management, deletion protection, and favorite fallback.");
} finally {
  await browser.close();
}
