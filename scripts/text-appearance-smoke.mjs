import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { testDocumentHeaders } from "./appearance-picker-smoke.mjs";

const legacy = {
  id: "legacy", base: "light", name: "Legacy light",
  colors: { "viewer-bg": "#ddeeff", "text-bg": "#f0ede8", accent: "#416083", "panel-selection": "#591d70" },
  fonts: { viewer: { size: 16 }, terminal: { size: 17 } },
};

const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 770 }, colorScheme: "light" });
  page.setDefaultTimeout(8000);
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  await page.addInitScript((legacy) => {
    const key = "dirlume.preferences.v1";
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
      theme: "system", systemLightScheme: "custom:legacy", systemDarkScheme: "dark", schemes: [legacy],
      viewFontSizes: { viewer: 27, editor: 25, markdown: 26 },
    }));
    const path = /Windows/i.test(navigator.userAgent) ? "C:\\fixture" : "/fixture";
    const files = {
      "sample.rs": "fn main() { let value = 42; }",
      "other.rs": "fn main() { let value = 117; }",
      "guide.md": "# View settings\n\n[Home](https://example.com)",
    };
    const entries = Object.keys(files).map((name) => ({ name, directory: false, link: false, hidden: false, size: files[name].length, modified: null }));
    window.openedTerminals = [];
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args) => {
        if (command === "locations") return [{ label: "Home", path }];
        if (command === "list_directory") return { path, parent: null, entries, omitted: 0 };
        if (command === "file_icons") return args.items.map(() => null);
        if (command === "read_text") return { text: files[args.name], encoding: "utf8" };
        if (command === "read_bytes") return { length: files[args.name].length, data: [...new TextEncoder().encode(files[args.name])] };
        if (command === "installed_fonts") return ["Fixture Sans"];
        if (command === "ftp_profiles") return [];
        if (command === "ssh_profiles") return [{ id: "ssh", label: "SSH fixture", host: "fixture", port: 22 }];
        if (command === "connect_ssh") return { kind: "connected", id: 17, address: "fixture", origin: "sftp://fixture",
          segments: ["home"], listing: { entries, omitted: 0, elevated: false } };
        if (command === "open_terminal") { window.openedTerminals.push(args.request); return false; }
        return null;
      },
    };
  }, legacy);
  await page.goto("http://dirlume.test/");
  const left = page.getByRole("listbox", { name: "left files", exact: true });
  const right = page.getByRole("listbox", { name: "right files", exact: true });
  const file = (pane, name) => pane.getByRole("option", { name: new RegExp("^" + name.replace(".", "\\.")) });
  const documentWindow = page.locator(".text-window:not([hidden])");
  const showDocument = async (name, key) => { await file(left, name).click(); await left.press(key); };
  const closeDocument = () => documentWindow.getByRole("button", { name: "Close document", exact: true }).click();
  const command = page.getByRole("combobox", { name: "Command line" });
  const options = page.getByRole("dialog", { name: "Options", exact: true });
  const exactButton = (scope, name) => scope.getByRole("button", { name, exact: true });
  const openOptions = () => exactButton(page, "Options").click();
  const openPage = (name) => exactButton(options, name).click();
  const field = (name) => options.getByLabel(name + " hex", { exact: true });
  const font = (name) => options.getByRole("spinbutton", { name: name + " font size", exact: true });
  const done = () => exactButton(options, "Done").click();
  const style = (element, name, pseudo) => element.evaluate((node, [name, pseudo]) => getComputedStyle(node, pseudo).getPropertyValue(name), [name, pseudo]);
  const preferences = () => page.evaluate(() => JSON.parse(localStorage.getItem("dirlume.preferences.v1")));
  const waitForTerminalStyle = (element, color) => page.waitForFunction(({ css, color }) =>
    [...document.querySelectorAll(css + " style")].some((node) => node.textContent.includes(color)),
  { css: element, color });
  const documentShortcuts = documentWindow.locator(".document-shortcuts");
  const invokeDocumentMenu = async (group, action) => {
    const menu = documentWindow.getByRole("menubar", { name: "Document menu" });
    await menu.getByRole("menuitem", { name: group, exact: true }).press("ArrowDown");
    const item = menu.getByRole("menu", { name: group, exact: true }).getByRole("menuitem", { name: action });
    await item.press("Enter");
  };
  const verifyReadingArea = async (surface) => {
    assert.equal(await documentShortcuts.count(), 0);
    const bottom = await surface.evaluate((node) => node.closest(".text-window").getBoundingClientRect().bottom -
      node.getBoundingClientRect().bottom - parseFloat(getComputedStyle(node).marginBottom));
    assert.ok(bottom <= 2, "The Viewer reading area should fill the space below the toolbar");
  };

  await showDocument("guide.md", "F3");
  const markdown = documentWindow.locator(".markdown");
  assert.equal(await style(markdown, "background-color"), "rgb(221, 238, 255)");
  assert.equal(await style(markdown, "font-size"), "26px");
  await verifyReadingArea(markdown);
  await page.setViewportSize({ width: 1100, height: 420 });
  await verifyReadingArea(markdown);
  const toolbarSearch = exactButton(documentWindow, "Search");
  await toolbarSearch.click();
  await documentWindow.locator(".markdown-search").waitFor({ state: "visible" });
  await exactButton(documentWindow, "Close search").click();
  await documentWindow.locator(".markdown-search").waitFor({ state: "hidden" });
  await invokeDocumentMenu("Navigate", "Search");
  await documentWindow.locator(".markdown-search").waitFor({ state: "visible" });
  await exactButton(documentWindow, "Source").click();
  await verifyReadingArea(documentWindow.locator(".source-surface:not([hidden])"));
  await invokeDocumentMenu("Navigate", "Hex");
  await verifyReadingArea(documentWindow.locator(".hex-view"));
  await invokeDocumentMenu("Navigate", "Hex");
  await invokeDocumentMenu("File", "Open in Editor");
  await documentShortcuts.getByRole("button", { name: /Save/ }).waitFor({ state: "visible" });
  await closeDocument();
  await exactButton(page.getByRole("navigation", { name: "Open documents", exact: true }), "View guide.md").click();
  await verifyReadingArea(documentWindow.locator(".source-surface:not([hidden])"));
  await invokeDocumentMenu("File", "Close");
  await page.setViewportSize({ width: 1100, height: 770 });
  await showDocument("sample.rs", "F3");
  await documentWindow.getByRole("button", { name: "Hex", exact: true }).click();
  assert.equal(await style(documentWindow.locator(".hex-view"), "font-size"), "27px");
  await closeDocument();
  assert.equal(await style(command, "font-size"), "17px");
  await left.press("F12");
  await waitForTerminalStyle(".terminal-card:not([hidden])", "#416083");
  await waitForTerminalStyle(".terminal-card:not([hidden])", "#591d70");

  await openOptions();
  await openPage("Viewer");
  await field("Viewer text background").fill("#122639");
  await field("Hex Viewer background").fill("#293257");
  await field("Markdown background").fill("#f1e8db");
  await field("Markdown links").fill("#1b5063");
  await font("Viewer").fill("19");
  await font("Hex Viewer").fill("20");
  await font("Markdown preview").fill("21");
  await options.getByRole("combobox", { name: "Markdown preview font family", exact: true }).fill("Missing Dirlume Font");
  await options.getByText("Unavailable. Using System font.", { exact: true }).waitFor();
  await openPage("Editor");
  await field("Editor background").fill("#192232");
  await field("Editor caret").fill("#e79d67");
  await field("Editor active line").fill("#293646");
  await field("Editor selection").fill("#fae493");
  await field("Syntax keywords").fill("#ffae72");
  await font("Editor").fill("22");
  const search = options.getByRole("searchbox", { name: "Search settings" });
  await search.fill("Terminal cursor");
  await search.press("Enter");
  await options.getByRole("heading", { name: "Terminal", exact: true }).waitFor();
  await field("Terminal cursor").fill("#123456");
  await field("Terminal selection").fill("#345678");
  await field("Terminal background").fill("#dee4ed");
  await font("Terminal").fill("23");
  await font("Command line").fill("24");
  await field("Command line input background").fill("#edf3fc");
  await search.fill("Compare files added lines");
  await search.press("Enter");
  await options.getByRole("heading", { name: "Text tools", exact: true }).waitFor();
  await font("Compare files").fill("15");
  await field("Compare files background").fill("#263949");
  await field("Compare files added lines").fill("#185533");
  await field("Compare files removed lines").fill("#943323");
  await search.fill("");
  await done();

  await waitForTerminalStyle(".terminal-card:not([hidden])", "#123456");
  await waitForTerminalStyle(".terminal-card:not([hidden])", "#345678");
  assert.equal(await page.evaluate(() => window.openedTerminals.length), 1);
  assert.equal(await style(page.locator("html"), "--panel-selection"), "#591d70");
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  assert.equal(await style(terminal.locator(".xterm-rows"), "font-size"), "23px");
  await left.press("F12");
  assert.equal(await style(command, "font-size"), "24px");
  assert.equal(await style(command, "background-color"), "rgba(0, 0, 0, 0)");
  assert.equal(await style(command.locator(".."), "background-color"), "rgb(237, 243, 252)");

  await showDocument("sample.rs", "F3");
  const code = documentWindow.locator(".code-surface");
  assert.equal(await style(code, "background-color"), "rgb(18, 38, 57)");
  assert.equal(await style(code, "font-size"), "19px");
  await documentWindow.getByRole("button", { name: "Hex", exact: true }).click();
  const hex = documentWindow.locator(".hex-view");
  assert.equal(await style(hex, "background-color"), "rgb(41, 50, 87)");
  assert.equal(await style(hex, "font-size"), "20px");
  await closeDocument();
  await showDocument("sample.rs", "F4");
  assert.equal(await style(code, "background-color"), "rgb(25, 34, 50)");
  assert.equal(await style(code, "font-size"), "22px");
  assert.equal(await style(code.locator(".cm-content"), "caret-color"), "rgb(231, 157, 103)");
  assert.equal(await style(code.locator(".cm-activeLine").first(), "background-color"), "rgb(41, 54, 70)");
  assert.equal(await style(code.locator(".cm-line").first(), "background-color", "::selection"), "rgb(250, 228, 147)");
  assert.equal(await style(code.locator(".syntax-keyword").first(), "color"), "rgb(255, 174, 114)");
  await closeDocument();
  await showDocument("guide.md", "F3");
  assert.equal(await style(markdown, "background-color"), "rgb(241, 232, 219)");
  assert.equal(await style(markdown, "font-size"), "21px");
  assert.equal(await style(markdown.getByRole("link", { name: "Home", exact: true }), "color"), "rgb(27, 80, 99)");
  await closeDocument();
  await file(left, "sample.rs").click();
  await file(right, "other.rs").click();
  await exactButton(page.getByRole("navigation", { name: "File actions", exact: true }), "Compare").click();
  const compare = page.getByRole("dialog", { name: "Compare files", exact: true });
  const differences = compare.getByLabel("File differences", { exact: true });
  assert.equal(await style(differences, "background-color"), "rgb(38, 57, 73)");
  assert.equal(await style(differences, "font-size"), "15px");
  assert.equal(await style(differences.locator(".diff-row .added").first(), "background-color"), "rgb(24, 85, 51)");
  await page.keyboard.press("Escape");
  await compare.waitFor({ state: "hidden" });

  await right.press("Alt+F2");
  await exactButton(page.locator("#right-pane .location-popup"), "NetBox").click();
  await file(right, "SSH fixture").click();
  await right.press("Enter");
  await file(right, "sample.rs").waitFor();
  await right.press("F12");
  await page.getByRole("heading", { name: "SSH terminal", exact: true }).waitFor();
  await waitForTerminalStyle(".terminal-card:not([hidden])", "#123456");
  await openOptions();
  await openPage("Terminal");
  await exactButton(options, "Reset terminal cursor").click();
  await field("Terminal selection").fill("#456789");
  await done();
  await waitForTerminalStyle(".terminal-card:not([hidden])", "#416083");
  await waitForTerminalStyle(".terminal-card:not([hidden])", "#456789");
  assert.deepEqual((await page.evaluate(() => window.openedTerminals)).map((session) => session.ssh?.connection ?? null), [null, 17]);

  await openOptions();
  await openPage("Viewer");
  const hexZoom = font("Hexadecimal view");
  await hexZoom.fill("29");
  await font("Text viewer").fill("28");
  await options.getByRole("combobox", { name: "Viewer font family", exact: true }).fill("Fixture Sans");
  assert.equal(await hexZoom.inputValue(), "29");
  assert.equal(await font("Text viewer").inputValue(), "28");
  await font("Viewer").fill("18");
  assert.equal(await font("Text viewer").inputValue(), "18");
  assert.equal(await hexZoom.inputValue(), "29");
  await exactButton(options, "Reset markdown preview font family").click();
  assert.equal(await font("Markdown preview").inputValue(), "21");
  await done();
  assert.deepEqual((await preferences()).viewFontSizes, { hex: 29 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.locator('html[data-theme="dark"]').waitFor();
  assert.notEqual(await style(page.locator("html"), "--terminal-selection"), "#456789");
  await page.emulateMedia({ colorScheme: "light" });
  await page.locator('html[data-theme="light"]').waitFor();
  assert.equal(await style(page.locator("html"), "--terminal-selection"), "#456789");
  await page.reload();
  await page.locator('html[data-theme="light"]').waitFor();
  assert.equal(await style(page.locator("html"), "--terminal-selection"), "#456789");

  await showDocument("guide.md", "F3");
  const markdownColumn = markdown.locator(".markdown-content");
  await markdownColumn.waitFor();
  await exactButton(documentWindow, "Viewer options").click();
  const sharedWidth = options.getByRole("spinbutton", { name: "Max width (px)", exact: true });
  await sharedWidth.fill("620");
  await field("Outside reading area background").fill("#8d2878");
  const mode = options.getByRole("combobox", { name: "Markdown reading width" });
  assert.equal(await mode.inputValue(), "inherit");
  await exactButton(options, "Apply").click();
  assert.equal((await markdownColumn.boundingBox()).width, 620);
  await mode.selectOption("custom");
  await options.getByRole("spinbutton", { name: "Markdown max width (px)", exact: true }).fill("510");
  await done();
  assert.equal((await markdownColumn.boundingBox()).width, 510);
  assert.equal(await style(markdown, "background-color"), "rgb(141, 40, 120)");
  await page.setViewportSize({ width: 460, height: 670 });
  assert.ok((await markdownColumn.boundingBox()).width < 460);
  await page.setViewportSize({ width: 1100, height: 770 });
  await exactButton(documentWindow, "Source").click();
  const sourceViewport = code.locator(".cm-scroller");
  await sourceViewport.waitFor();
  const [viewBounds, sourceBounds] = await Promise.all([documentWindow.boundingBox(), sourceViewport.boundingBox()]);
  assert.ok(Math.abs(viewBounds.x + viewBounds.width - sourceBounds.x - sourceBounds.width) <= 2);
  assert.match(await style(sourceViewport, "background-size"), /620px/);
  await exactButton(documentWindow, "Preview").click();
  await exactButton(documentWindow, "Viewer options").click();
  await mode.selectOption("full");
  await done();
  assert.equal(await style(markdown, "background-image"), "none");
  assert.equal(await style(markdown, "background-color"), "rgb(241, 232, 219)");
  await page.reload();
  assert.equal((await preferences()).viewerMarkdownContentWidth, "full");
  assert.equal((await preferences()).schemes.find(({ id }) => id === legacy.id).colors["viewer-outside-bg"], "#8d2878");

  const typography = (scope) => scope.evaluate((element) => {
    const style = getComputedStyle(element);
    return Object.fromEntries([
      "--panel-font", "--panel-size", "--viewer-font", "--viewer-size", "--markdown-font", "--markdown-code-font",
      "--markdown-size", "--compare-editor-font", "--compare-editor-size", "--dialog-font", "--dialog-size",
      "--terminal-font", "--terminal-size", "--command-font",
    ].map((property) => [property, style.getPropertyValue(property).trim()]));
  });
  const root = page.locator("html");
  const originalFonts = await typography(root);
  const originalSettings = await preferences();
  await openOptions();
  await search.fill("Keep current fonts");
  await search.press("Enter");
  const keepFonts = options.getByRole("checkbox", { name: "Keep current fonts", exact: true });
  const scheme = options.getByRole("combobox", { name: "Color scheme", exact: true });
  assert.equal(await keepFonts.isChecked(), false);
  await keepFonts.check();
  await scheme.selectOption("lavender");
  const preview = options.locator(".preview-frame");
  assert.equal(await preview.getAttribute("data-theme"), "lavender");
  assert.deepEqual(await typography(preview), originalFonts);
  await options.getByRole("checkbox", { name: "Show color scheme switcher in the title bar", exact: true }).check();
  await exactButton(options, "Apply").click();
  await page.locator('html[data-theme="lavender"]').waitFor();
  assert.deepEqual(await typography(root), originalFonts);
  await done();
  const titlebar = page.locator(".topbar-scheme");
  await titlebar.selectOption("graphite");
  await page.locator('html[data-theme="graphite"]').waitFor();
  assert.deepEqual(await typography(root), originalFonts);
  await exactButton(page, "Switch to favorite light scheme").click();
  await page.locator('html[data-theme="light"]').waitFor();
  assert.deepEqual(await typography(root), originalFonts);
  await titlebar.selectOption("system");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.locator('html[data-theme="dark"]').waitFor();
  assert.deepEqual(await typography(root), originalFonts);
  await page.reload();
  await page.locator('html[data-theme="dark"]').waitFor();
  assert.deepEqual(await typography(root), originalFonts);
  assert.deepEqual((await preferences()).viewFontSizes, originalSettings.viewFontSizes);
  assert.deepEqual((await preferences()).schemes, originalSettings.schemes);

  await openOptions();
  await search.fill("Keep current fonts");
  await search.press("Enter");
  assert.equal(await keepFonts.isChecked(), true);
  await keepFonts.uncheck();
  assert.notDeepEqual(await typography(preview), originalFonts);
  assert.deepEqual(await typography(root), originalFonts);
  await page.keyboard.press("Escape");
  assert.deepEqual(await typography(root), originalFonts);
  await openOptions();
  assert.equal(await keepFonts.isChecked(), true);
  await keepFonts.uncheck();
  await done();
  assert.equal((await preferences()).retainedFonts, undefined);
  assert.notDeepEqual(await typography(root), originalFonts);
  console.log("Verified seven text surfaces, live local and SSH terminal themes, inherited colors, font fallback, independent zoom, system schemes, and restart.");
  await testDocumentHeaders(browser);
  console.log("Verified Classic blue document headers, controls, legacy scheme overrides, and appearance picking.");
} finally {
  await browser.close();
}
