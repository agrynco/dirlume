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
      const files = ["first.txt", "notes.md", "some-photo.png", "logo.SVG", "art.svg", "Dockerfile", "backup.tar.gz", ".hidden.svg", "system.svg"]
        .map((name) => ({ name, directory: name === "art.svg", link: false, hidden: name.startsWith(".") || name === "system.svg",
          system: name === "system.svg", size: 7, modified: null }));
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command) => {
          if (command === "locations") return [{ label: "Home", path }];
          if (command === "list_directory") return { path, parent: null, entries: files, omitted: 0 };
          if (command === "file_icons") return [];
          if (command === "read_text") return { text: "Fixture text", encoding: "utf8" };
          if (command === "open_terminal") return false;
          if (command === "installed_fonts") return ["Arial", "Courier New"];
          return null;
        },
      };
    });
    await page.goto("http://dirlume.test/");
    const open = () => page.getByRole("button", { name: "Options", exact: true }).click();
    const options = optionsDialog(page);
    const selectPage = (name) => options.getByRole("navigation", { name: "Options sections" }).getByRole("button", { name, exact: true }).click();
    const done = () => options.getByRole("button", { name: "Done", exact: true }).click();
    const size = (name) => options.getByRole("spinbutton", { name: name + " font size", exact: true });
    const verifySteps = async (field, inherited) => {
      assert.equal(await field.inputValue(), String(inherited));
      await field.hover();
      const { width, height } = await field.boundingBox();
      const padding = await field.evaluate((input) => parseFloat(getComputedStyle(input).paddingRight));
      for (const [y, delta] of [[height / 3, 1], [height * 2 / 3, -1]]) {
        await field.click({ position: { x: width - padding - 5, y } });
        assert.equal(await field.inputValue(), String(inherited + delta));
        await field.fill("");
        await field.blur();
      }
      for (const [key, delta] of [["ArrowUp", 1], ["ArrowDown", -1]]) {
        await field.press(key);
        assert.equal(await field.inputValue(), String(inherited + delta));
        await field.fill("");
        await field.blur();
      }
    };
    await open();
    await selectPage("Fonts");
    await verifySteps(size("File pane dialogs"), 14);
    await size("Main window").fill("18");
    await verifySteps(size("File pane dialogs"), 18);
    await size("File pane dialogs").fill("24");
    await size("File pane dialogs").press("ArrowUp");
    assert.equal(await size("File pane dialogs").inputValue(), "24");
    await size("File pane dialogs").press("ArrowDown");
    assert.equal(await size("File pane dialogs").inputValue(), "23");
    await size("File pane dialogs").fill("");
    await size("File panels").fill("18");
    await selectPage("View font sizes");
    await verifySteps(size("Left file pane"), 18);
    await page.keyboard.press("Escape");
    await options.waitFor({ state: "hidden" });
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
    await open();
    await selectPage("Appearance");
    const colorScheme = options.getByRole("combobox", { name: "Color scheme", exact: true });
    const preview = options.locator(".preview-frame");
    await colorScheme.selectOption("lavender");
    const gradient = await preview.evaluate((frame) => getComputedStyle(frame).backgroundImage);
    assert.match(gradient, /gradient/);
    await options.getByRole("button", { name: "New scheme", exact: true }).click();
    await hex(page, "Window background").fill("#f4f0eb");
    assert.equal(await preview.evaluate((frame) => getComputedStyle(frame).backgroundColor), "rgb(244, 240, 235)");
    assert.equal(await preview.evaluate((frame) => getComputedStyle(frame).backgroundImage), "none");
    await options.getByRole("button", { name: "Apply", exact: true }).click();
    await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === "rgb(244, 240, 235)");
    await done();
    await page.reload();
    await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === "rgb(244, 240, 235)");
    await open();
    await selectPage("Appearance");
    await options.getByRole("button", { name: "Reset window background", exact: true }).click();
    assert.equal(await preview.evaluate((frame) => getComputedStyle(frame).backgroundImage), gradient);
    await done();
    await page.waitForFunction((image) => getComputedStyle(document.body).backgroundImage === image, gradient);
    await page.evaluate(() => {
      const key = "dirlume.preferences.v1";
      const preferences = JSON.parse(localStorage.getItem(key));
      preferences.activeScheme = "legacy-dialog-font";
      preferences.schemes.push({ id: "legacy-dialog-font", name: "Legacy dialog font", base: "light", colors: { "file-image": "#2d598e" },
        fonts: { ui: { size: 15 }, dialog: { size: 18, family: "Arial" } } });
      localStorage.setItem(key, JSON.stringify(preferences));
    });
    await page.reload();
    await open();
    await options.getByRole("searchbox", { name: "Search settings" }).fill("");
    const fontStyle = (element) => element.evaluate((node) => [getComputedStyle(node).fontSize, getComputedStyle(node).fontFamily]);
    let [pixels, family] = await fontStyle(options);
    assert.equal(pixels, "18px");
    assert.match(family, /^Arial,/);
    await selectPage("Dialogs");
    assert.equal(await size("File pane dialogs").inputValue(), "18");
    assert.equal(await size("Options window").inputValue(), "18");
    const optionFamily = options.getByRole("combobox", { name: "Options window font family", exact: true });
    await optionFamily.fill("Courier New");
    await size("Options window").fill("14");
    await selectPage("Fonts");
    assert.equal(await size("Options window").inputValue(), "14");
    assert.equal(await size("File pane dialogs").inputValue(), "18");
    assert.equal(await fontStyle(options.locator(".preview-dialog").first()).then(([size]) => size), "18px");
    assert.equal(await fontStyle(options.locator(".preview-options")).then(([size]) => size), "14px");
    await options.getByRole("button", { name: "Apply", exact: true }).click();
    [pixels, family] = await fontStyle(options.getByRole("button", { name: "General", exact: true }));
    assert.equal(pixels, "14px");
    assert.match(family, /^"?Courier New"?,/);
    await done();
    await row.click();
    await page.keyboard.press("F5");
    const copy = page.getByRole("dialog", { name: "Copy", exact: true });
    [pixels, family] = await fontStyle(copy.getByRole("combobox", { name: "Destination" }));
    assert.equal(pixels, "18px");
    assert.match(family, /^Arial,/);
    await copy.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.reload();
    await open();
    await selectPage("Dialogs");
    assert.equal(await size("Options window").inputValue(), "14");
    await options.getByRole("button", { name: "Reset options window font", exact: true }).click();
    assert.equal(await size("Options window").inputValue(), "15");
    assert.equal(await size("File pane dialogs").inputValue(), "18");
    await done();
    await page.reload();
    await open();
    await selectPage("Fonts");
    assert.equal(await size("Options window").inputValue(), "15");
    assert.equal(await size("File pane dialogs").inputValue(), "18");
    await selectPage("File types");
    const groups = options.getByRole("combobox", { name: "File extension group", exact: true });
    const groupName = options.getByRole("textbox", { name: "Group name", exact: true });
    const extension = options.getByRole("textbox", { name: "File extension", exact: true });
    const colorField = options.getByRole("textbox", { name: "Filename color hex", exact: true });
    const add = options.getByRole("button", { name: "Add extension", exact: true });
    const remove = (suffix) => options.getByRole("button", { name: `Remove extension .${suffix}`, exact: true });
    assert.equal(await groups.getByRole("option").count(), 8);
    await groups.selectOption("file-image");
    assert.equal(await colorField.inputValue(), "#2d598e");
    await groupName.fill("Photos");
    await groupName.press("Enter");
    await extension.fill(".JPEGXL");
    await add.click();
    await remove("jpegxl").waitFor();
    await remove("bmp").click();
    assert.equal(await remove("bmp").count(), 0);

    await options.getByRole("button", { name: "New group", exact: true }).click();
    await groupName.fill("Vector images");
    await groupName.press("Enter");
    const vectors = await groups.inputValue();
    const confirmMove = page.getByRole("dialog", { name: "Move extension", exact: true });
    const startMove = options.getByRole("button", { name: "Move extension…", exact: true });
    const extensionHint = (message) => options.locator(".file-type-settings [role=status]").filter({ hasText: message });
    await extensionHint("Add an extension to apply this group's color and font.").waitFor();
    await extension.fill(".SVG");
    await extensionHint(".svg is already in the Photos group.").waitFor();
    await startMove.click();
    await confirmMove.getByText("Move .svg from Photos to Vector images?", { exact: true }).waitFor();
    await confirmMove.getByRole("button", { name: "Cancel", exact: true }).click();
    await groups.selectOption("file-image");
    await remove("svg").waitFor();
    await groups.selectOption(vectors);
    await extension.fill("svg");
    await extension.press("Enter");
    await confirmMove.getByRole("button", { name: "Move extension", exact: true }).click();
    await colorField.fill("#853579");
    await options.getByRole("combobox", { name: "File type font family", exact: true }).fill("Courier New");
    const sample = options.getByLabel("Filename preview", { exact: true });
    assert.equal(await sample.textContent(), "sample.svg");
    assert.equal(await sample.evaluate((node) => getComputedStyle(node).color), "rgb(133, 53, 121)");
    if (process.env.DIRLUME_FILE_TYPES_SCREENSHOT) await options.screenshot({ path: process.env.DIRLUME_FILE_TYPES_SCREENSHOT });

    await options.getByRole("button", { name: "New group", exact: true }).click();
    await groupName.fill("Markdown");
    await groupName.press("Enter");
    const markdown = await groups.inputValue();
    await colorField.fill("#2fc8fb");
    const previewMarkdown = options.locator(".preview-file-types").getByText("notes.md", { exact: true });
    const filenameColor = (node) => node.evaluate((element) => getComputedStyle(element).color);
    const originalMarkdownInk = await filenameColor(previewMarkdown);
    const markdownInk = "rgb(47, 200, 251)";
    await extension.fill(".md");
    await extensionHint(".md is already in the Text and Markdown group.").waitFor();
    assert.equal(await filenameColor(previewMarkdown), originalMarkdownInk);
    await startMove.click();
    await confirmMove.getByRole("button", { name: "Cancel", exact: true }).click();
    await groups.selectOption("file-text");
    await remove("md").click();
    await groups.selectOption(markdown);
    await extension.fill(".md");
    await add.click();
    await remove("md").waitFor();
    assert.equal(await filenameColor(previewMarkdown), markdownInk);

    await selectPage("Main File Panels");
    await options.getByRole("checkbox", { name: "Show hidden files", exact: true }).check();
    await done();
    const file = (side, name) => page.locator(`#${side}-files .file-row[data-tooltip=${JSON.stringify(name)}]`);
    const filename = (side, name) => file(side, name).locator(".file-name-text");
    const appearance = (node) => node.evaluate((element) => [getComputedStyle(element).color, getComputedStyle(element).fontFamily]);
    for (const side of ["left", "right"]) {
      assert.equal(await filenameColor(filename(side, "notes.md")), markdownInk);
      assert.equal(await file(side, "logo.SVG").getAttribute("data-file-color"), "custom");
      assert.equal(await file(side, "art.svg").getAttribute("data-file-color"), null);
      assert.equal(await file(side, "Dockerfile").getAttribute("data-file-color"), null);
      assert.equal(await file(side, "backup.tar.gz").getAttribute("data-file-color"), "file-archive");
      assert.equal(await file(side, ".hidden.svg").getAttribute("data-file-color"), "file-hidden");
      assert.equal(await file(side, "system.svg").getAttribute("data-file-color"), "file-system");
      const [ink, font] = await appearance(filename(side, "logo.SVG"));
      assert.equal(ink, "rgb(133, 53, 121)");
      assert.match(font, /^"?Courier New"?,/);
    }
    await file("left", "logo.SVG").click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
    const [markedInk, markedFont] = await appearance(filename("left", "logo.SVG"));
    assert.notEqual(markedInk, "rgb(133, 53, 121)");
    assert.match(markedFont, /^"?Courier New"?,/);
    await page.reload();
    await open();
    await selectPage("File types");
    await groups.selectOption(markdown);
    await remove("md").waitFor();
    assert.equal(await filenameColor(previewMarkdown), markdownInk);
    await groups.selectOption(vectors);
    assert.equal(await colorField.inputValue(), "#853579");
    await remove("svg").waitFor();
    await options.getByRole("button", { name: "Reset file type font", exact: true }).click();
    await done();
    assert.equal((await appearance(filename("left", "logo.SVG")))[1], (await appearance(filename("left", "art.svg")))[1]);
    console.log("Verified appearance targets, grouped controls, draft preview, cancellation, and private date-grouped history.");
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testAppearancePicker();
