import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { closeToolWindow, openOptionsWindow } from "./tool-window-smoke.mjs";

const optionsDialog = (page) => page.getByRole("dialog", { name: "Options", exact: true });
const pickerButton = (page) => optionsDialog(page).getByRole("button", { name: "Pick an element", exact: true });
const heading = (page, name) => optionsDialog(page).getByRole("heading", { name, exact: true });
const hex = (page, name) => optionsDialog(page).getByRole("textbox", { name: name + " hex", exact: true });
const historyKey = "dirlume.appearance-picks";
const overlay = (page) => page.locator(".appearance-picker");

export async function testNativeAppearancePicker(main) {
  const tool = await openOptionsWindow(main);
  const returned = () => tool.waitForFunction(() => {
    const tauri = window.__TAURI_INTERNALS__;
    return tauri.invoke("plugin:window|is_focused", { label: tauri.metadata.currentWindow.label });
  });
  await pickerButton(tool).click();
  await overlay(main).waitFor();
  assert.equal(await pickerButton(tool).isDisabled(), true);
  await main.waitForFunction(async () => {
    const tauri = window.__TAURI_INTERNALS__;
    return !await tauri.invoke("plugin:window|is_visible", { label: "options" }) &&
      await tauri.invoke("plugin:window|is_focused", { label: "main" });
  });
  await main.keyboard.press("Escape");
  await overlay(main).waitFor({ state: "hidden" });
  await returned();

  const status = main.locator(".statusbar");
  await pickerButton(tool).click();
  await overlay(main).waitFor();
  await status.hover();
  await main.locator(".appearance-picker-outline").waitFor();
  await status.click();
  await heading(tool, "Status bar").waitFor();
  await hex(tool, "Toolbar and status bar").waitFor();
  await returned();

  const trigger = main.getByRole("button", { name: "Find files", exact: true });
  await trigger.click();
  const find = main.getByRole("dialog", { name: "Find files", exact: true });
  await find.waitFor();
  await pickerButton(tool).click();
  await find.locator(".appearance-picker").waitFor();
  await find.locator(".dialog-heading").click();
  await heading(tool, "Dialog header or footer").waitFor();
  await hex(tool, "Dialog headers and footers").waitFor();
  assert.equal(await find.isVisible(), true);
  await closeToolWindow(tool);
  await main.keyboard.press("Escape");
  await find.waitFor({ state: "hidden" });
  console.log("Verified native appearance picker window handoff, Escape, dialog picking, and return focus.");
}

export async function testAppearancePicker() {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 735 } });
    page.setDefaultTimeout(8000);
    await page.route("http://dirlume.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    await page.addInitScript(() => {
      const path = "/fixture";
      const files = ["first.txt", "some-photo.png"].map((name) => ({ name, directory: false, link: false, hidden: false, size: 7, modified: null }));
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command) => {
          if (command === "locations") return [{ label: "Home", path }];
          if (command === "list_directory") return { path, parent: null, entries: files, omitted: 0 };
          if (command === "file_icons") return [];
          if (command === "read_text") return { text: "Fixture text", encoding: "utf8" };
          if (command === "open_terminal") return false;
          if (command === "installed_fonts") return ["Arial"];
          return null;
        },
      };
    });
    await page.goto("http://dirlume.test/");
    const open = () => page.getByRole("button", { name: "Options", exact: true }).click();
    const options = optionsDialog(page);
    const selectPage = (name) => options.getByRole("navigation", { name: "Options sections" }).getByRole("button", { name, exact: true }).click();
    const done = () => options.getByRole("button", { name: "Done", exact: true }).click();
    const start = async () => {
      await pickerButton(page).click();
      await overlay(page).waitFor();
      await options.waitFor({ state: "hidden" });
    };
    const pick = async (target, title, color) => {
      await start();
      await target.hover();
      await page.locator(".appearance-picker-outline").waitFor();
      await target.click();
      await heading(page, title).waitFor();
      await hex(page, color).waitFor();
    };
    const left = page.getByRole("listbox", { name: "left files", exact: true });
    const row = left.getByRole("option", { name: /^first\.txt/ });
    await row.click().catch(async (error) => {
      throw new Error(await page.locator("body").innerText(), { cause: error });
    });
    const currentRow = left.locator(".file-row[data-current=true]");
    for (const [layout, title, color] of [
      ["standard", "Standard", "Active selection background"],
      ["twin", "Twin panels", "Accent and focus"],
      ["classic", "Classic commander", "Primary button background"],
    ]) {
      await open();
      await selectPage("Main File Panels");
      await options.getByRole("combobox", { name: "Panel layout" }).selectOption(layout);
      await done();
      await open();
      await pick(currentRow, `Current file row (${title})`, color);
      if (layout === "standard") await hex(page, "Active selection text").waitFor();
      if (layout === "classic") await hex(page, "Primary button text").waitFor();
      await done();
    }

    await open();
    await pick(left.getByRole("option", { name: /^some-photo\.png/ }), "File row (Classic commander)", "Images");
    assert.match(await currentRow.getAttribute("data-tooltip"), /^first\.txt$/);
    await done();

    await open();
    await pick(page.locator(".statusbar"), "Status bar", "Toolbar and status bar");
    const toolbar = hex(page, "Toolbar and status bar");
    await toolbar.fill("#245978");
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".preview-picked-element")).backgroundColor === "rgb(36, 89, 120)");
    await start();
    await page.getByRole("separator", { name: "Pane divider", exact: true }).click();
    await overlay(page).getByText("No appearance settings here. Pick another element or press Esc.", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await heading(page, "Status bar").waitFor();
    assert.equal(await toolbar.inputValue(), "#245978");
    const apply = options.getByRole("button", { name: "Apply", exact: true });
    const naming = page.getByRole("dialog", { name: "Name color scheme", exact: true });
    const schemeName = naming.getByRole("textbox", { name: "Scheme name", exact: true });
    const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("dirlume.preferences.v1")));
    const before = await saved();
    const assertPrefilled = async (expected) => {
      await schemeName.waitFor();
      assert.equal(await schemeName.inputValue(), expected);
      assert.ok(await schemeName.evaluate((field) => field.matches(":focus-visible") &&
        field.selectionStart === 0 && field.selectionEnd === field.value.length));
    };
    await apply.click();
    await assertPrefilled("Custom scheme");
    await page.keyboard.press("Escape");
    await naming.waitFor({ state: "hidden" });
    assert.ok(await apply.evaluate((button) => button === document.activeElement));
    assert.deepEqual(await saved(), before);
    assert.equal(await toolbar.inputValue(), "#245978");
    await apply.click();
    await assertPrefilled("Custom scheme");
    await page.keyboard.insertText("Slate status");
    assert.equal(await schemeName.inputValue(), "Slate status");
    await schemeName.press("Enter");
    await naming.waitFor({ state: "hidden" });
    assert.ok(await options.isVisible());
    assert.equal((await saved()).schemes[0].name, "Slate status");
    assert.equal(Object.hasOwn((await saved()).schemes[0], "suggestedName"), false);
    await done();

    await row.click();
    for (const [key, title, color] of [["F3", "Viewer", "Viewer text background"], ["F4", "Editor", "Editor background"]]) {
      await left.press(key);
      const document = page.locator(".text-window:not([hidden]) :is(.text-view, .code-surface)");
      await document.waitFor();
      await open();
      await pick(document, title, color);
      await done();
      await page.locator(".text-window:not([hidden])").getByRole("button", { name: "Close document", exact: true }).click();
      await left.waitFor();
    }
    await left.press("F12");
    await open();
    await pick(page.locator(".terminal-surface"), "Terminal", "Terminal background");
    await done();

    await page.evaluate(({ historyKey }) => {
      const entries = JSON.parse(localStorage.getItem(historyKey));
      for (const entry of entries) {
        if (entry.target === "terminal") entry.colors = ["text-bg", "text-ink", "accent", "panel-selection"];
        if (entry.target === "editor") entry.colors = ["text-bg", "text-ink", "line"];
      }
      const previousDate = new Date();
      previousDate.setDate(previousDate.getDate() - 1);
      entries.at(-1).time = previousDate.getTime();
      localStorage.setItem(historyKey, JSON.stringify(entries));
    }, { historyKey });
    await page.reload();
    await open();
    await options.getByRole("button", { name: "Picker history", exact: true }).click();
    const dates = await options.locator(".picker-history h4").allTextContents();
    assert.equal(dates.length, 2);
    assert.ok(Date.parse(dates[0]) > Date.parse(dates[1]));
    for (const [title, color] of [["Terminal", "Terminal cursor"], ["Editor", "Editor line-number gutter"]]) {
      await options.locator(".picker-history").getByRole("button", { name: title, exact: true }).click();
      await heading(page, title).waitFor();
      await hex(page, color).waitFor();
    }
    await options.locator(".picker-history").getByRole("button", { name: "Status bar", exact: true }).click();
    await heading(page, "Status bar").waitFor();
    assert.equal(await toolbar.inputValue(), "#245978");
    const history = await page.evaluate((key) => localStorage.getItem(key), historyKey);
    assert.equal(JSON.parse(history).length, 8);
    assert.doesNotMatch(history, /first\.txt|some-photo\.png|\/fixture|Fixture text/);
    await toolbar.fill("#654321");
    await selectPage("General");
    await heading(page, "General").waitFor();
    assert.equal(await toolbar.isVisible(), false);
    await page.keyboard.press("Escape");
    await open();
    await options.getByRole("button", { name: "Picker history", exact: true }).click();
    await options.locator(".picker-history").getByRole("button", { name: "Status bar", exact: true }).click();
    assert.equal(await toolbar.inputValue(), "#245978");
    const search = options.getByRole("searchbox", { name: "Search settings" });
    await search.fill("Window background");
    await search.press("Enter");
    const active = options.getByRole("combobox", { name: "Color scheme", exact: true });
    await active.selectOption("light");
    await hex(page, "Window background").fill("#f0f3f6");
    await done();
    await assertPrefilled("Custom scheme 2");
    await naming.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal((await saved()).schemes.length, 1);
    await done();
    await assertPrefilled("Custom scheme 2");
    await schemeName.press("Enter");
    await options.waitFor({ state: "hidden" });
    await page.reload();
    assert.deepEqual((await saved()).schemes.map(({ name }) => name), ["Slate status", "Custom scheme 2"]);
    console.log("Verified appearance targets, grouped controls, draft preview, cancellation, and private date-grouped history.");
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testAppearancePicker();
