import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const mainMenu = (page) => page.getByRole("menubar", { name: "Main menu", exact: true });

export async function revealMainMenu(page) {
  const bar = mainMenu(page);
  if (!await bar.isVisible()) await page.keyboard.press("F9");
  await bar.waitFor();
  return bar;
}

export async function openMainMenu(page, name) {
  const bar = await revealMainMenu(page);
  const dropdown = bar.getByRole("menu", { name, exact: true });
  if (!await dropdown.isVisible()) await bar.getByRole("menuitem", { name, exact: true }).click();
  await dropdown.waitFor();
  return dropdown;
}

export function blankMenuHeaderPoint(menubar) {
  return menubar.evaluate((bar) => {
    const bounds = bar.getBoundingClientRect();
    const y = bounds.top + bounds.height / 2;
    for (let x = bounds.left + 2; x < bounds.right - 2; x += 3) {
      if (document.elementFromPoint(x, y) === bar) return { x, y };
    }
    throw new Error("The menu header has no blank area.");
  });
}

export async function testHeaderMenus(page, windows = false) {
  const bar = mainMenu(page);
  const list = page.getByRole("listbox", { name: "left files", exact: true });
  const connect = page.getByRole("button", { name: "Connect", exact: true });
  const search = page.getByRole("button", { name: "Find files", exact: true });
  await bar.waitFor({ state: "hidden" });
  assert.equal(await connect.isVisible(), true);
  assert.equal(await search.isVisible(), true);
  await list.focus();
  await revealMainMenu(page);
  assert.deepEqual(await bar.getByRole("menuitem").allTextContents(), ["Left", "Files", "Commands", "Options", "Right", "Help"]);
  assert.equal(await bar.evaluate((node) => node.contains(document.activeElement)), true);
  await page.keyboard.press("ArrowDown");
  await bar.getByRole("menu", { name: "Left", exact: true }).waitFor();
  await page.keyboard.press("F9");
  await bar.waitFor({ state: "hidden" });
  assert.equal(await list.evaluate((element) => element === document.activeElement), true);
  for (const side of ["Right", "Left"]) {
    await openMainMenu(page, side);
    const { x, y } = await blankMenuHeaderPoint(bar);
    await page.mouse.click(x, y);
    await bar.waitFor({ state: "hidden" });
    assert.equal(await page.locator("dialog[open]").count(), 0);
    await list.focus();
    await openMainMenu(page, side);
    await page.keyboard.press("Escape");
    await bar.waitFor({ state: "hidden" });
    assert.equal(await list.evaluate((element) => element === document.activeElement), true);
  }
  await page.keyboard.press("Alt");
  await bar.waitFor();
  await page.keyboard.press("Alt");
  await bar.waitFor({ state: "hidden" });

  await openMainMenu(page, "Right");
  await connect.click();
  await bar.waitFor({ state: "hidden" });
  const connection = page.getByRole("dialog", { name: /^Connect (to|through) / });
  await connection.waitFor();
  await page.keyboard.press("Escape");
  await connection.waitFor({ state: "hidden" });
  if (windows) {
    const maximize = page.getByRole("button", { name: "Maximize window", exact: true });
    const restore = page.getByRole("button", { name: "Restore window", exact: true });
    const initiallyMaximized = await restore.isVisible();
    for (const next of initiallyMaximized ? [maximize, restore] : [restore, maximize]) {
      // Exercise Tauri's native double-click handler without starting a Windows move loop on the first down event.
      await page.locator(".topbar > .main-menu").dispatchEvent("mousedown", { button: 0, detail: 2, bubbles: true, cancelable: true });
      await next.waitFor();
    }
  }
  console.log("Verified the hidden menu, F9 and Alt toggles, Escape and focus restoration, and outside clicks" +
    (windows ? ", including Windows title bar maximize and restore." : "."));
}

async function checkMenuBindings(page) {
  const bar = mainMenu(page);
  const focus = () => page.getByRole("listbox", { name: "left files", exact: true }).focus();
  const button = (parent, name) => parent.getByRole("button", { name, exact: true });
  const options = page.getByRole("dialog", { name: "Options", exact: true });
  const openBindings = async () => {
    await button(page, "Options").click();
    await button(options, "Keyboard shortcuts").click();
  };
  const sequences = [
    ["Open main menu", "F9", "Ctrl+Alt+F9", "Control+Alt+F9"],
    ["Open main menu (alternate)", "Alt", "Ctrl+Alt+F10", "Control+Alt+F10"],
  ];
  await openBindings();
  for (const [name, old, , shortcut] of sequences) {
    await button(options, "Change " + old + " for " + name).click();
    await options.getByRole("textbox", { name: "New shortcut to replace " + old + " for " + name, exact: true }).press(shortcut);
  }
  await button(options, "Done").click();
  await focus();
  for (const [, old, , shortcut] of sequences) {
    await page.keyboard.press(old);
    assert.equal(await bar.isVisible(), false);
    await page.keyboard.press(shortcut);
    await bar.waitFor();
    await page.keyboard.press("ArrowDown");
    await bar.getByRole("menu").waitFor();
    await page.keyboard.press(shortcut);
    await bar.waitFor({ state: "hidden" });
  }
  await openBindings();
  for (const [name, , label] of sequences) await button(options, "Remove " + label + " from " + name).click();
  await button(options, "Done").click();
  await focus();
  for (const [, , , shortcut] of sequences) {
    await page.keyboard.press(shortcut);
    assert.equal(await bar.isVisible(), false);
  }
}

async function checkNestedMenu(page) {
  const { build } = await import("vite");
  const output = await build({
    logLevel: "error",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry: "scripts/nested-menu-fixture.mjs", formats: ["iife"], name: "NestedMenuSmoke" } },
  });
  const bundle = Array.isArray(output) ? output[0] : output;
  await page.setContent('<button id="before">Before</button><div id="fixture"></div><p id="result"></p>');
  await page.addScriptTag({ content: bundle.output.find((output) => output.type === "chunk").code });
  const before = page.getByRole("button", { name: "Before", exact: true });
  const bar = mainMenu(page);
  await page.locator('[role="menubar"][hidden]').waitFor({ state: "attached" });
  async function openNested() {
    await before.focus();
    await page.keyboard.press("F9");
    await bar.waitFor();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight");
    await bar.getByRole("menu", { name: "More", exact: true }).waitFor();
    assert.equal(await bar.getByRole("menuitem", { name: "Run item", exact: true }).evaluate((node) => node === document.activeElement), true);
  }
  for (const key of ["Escape", "F9"]) {
    await openNested();
    await page.keyboard.press(key);
    await bar.waitFor({ state: "hidden" });
    assert.equal(await before.evaluate((node) => node === document.activeElement), true);
  }
  await openNested();
  await bar.getByRole("menuitem", { name: "Run item", exact: true }).click();
  await page.getByText("Item ran", { exact: true }).waitFor();
  await bar.waitFor({ state: "hidden" });
}

async function testBrowserHeader() {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 1120, height: 730 } });
    page.setDefaultTimeout(8000);
    await page.route("http://dirlume.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    await page.addInitScript(() => {
      const home = /Windows/i.test(navigator.userAgent) ? "C:\\fixture" : "/fixture";
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command) => {
          if (command === "locations") return [{ label: "Home", path: home }];
          if (command === "list_directory") return { path: home, parent: null, entries: [], omitted: 0 };
          if (command === "file_icons") return [];
          return null;
        },
      };
    });
    await page.goto("http://dirlume.test/");
    await testHeaderMenus(page);
    await checkMenuBindings(page);
    const nested = await browser.newPage();
    nested.setDefaultTimeout(8000);
    nested.on("pageerror", (error) => console.error(error));
    await checkNestedMenu(nested);
    console.log("Verified remapping, disabling, and nested menu dismissal and activation.");
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testBrowserHeader();
