import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

async function openFixture(browser, language = "en") {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  page.setDefaultTimeout(8000);
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  await page.addInitScript((language) => {
    const root = /Windows/i.test(navigator.userAgent) ? "C:\\fixture" : "/fixture";
    const file = { name: "note.txt", directory: false, link: false, hidden: false, size: 7, modified: null };
    localStorage.setItem("dirlume.preferences.v1", JSON.stringify({ language }));
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args) => {
        if (command === "locations") return [{ label: "Home", path: root }, { label: "Downloads", path: root + "/other" }];
        if (command === "list_directory") return { path: args.path, parent: null, entries: [file], omitted: 0 };
        if (command === "file_icons") return [];
        if (command === "read_text") return { text: "A note\n", encoding: "utf8" };
        if (command === "open_terminal") return true;
        return null;
      },
    };
  }, language);
  await page.goto("http://dirlume.test/");
  await page.locator('#left-files [data-tooltip="note.txt"]').waitFor();
  return page;
}

function currentTopic(help, id) {
  return help.locator('.help-contents [aria-current="location"][href="#help-' + id + '"]');
}

async function openHelp(page, control, id, helpLabel = "Help") {
  await control.press("F1");
  const help = page.getByRole("dialog", { name: helpLabel, exact: true });
  await currentTopic(help, id).waitFor();
  return help;
}

async function closeHelp(page, help, previous) {
  await page.keyboard.press("Escape");
  await help.waitFor({ state: "hidden" });
  assert.equal(await previous.evaluate((node) => node === document.activeElement), true);
}

const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await openFixture(browser);
  const files = page.locator("#left-files");
  const help = await openHelp(page, files, "files");
  await help.locator('.help-reading a[href="#help-operations"]').press("Enter");
  await currentTopic(help, "operations").waitFor();
  await help.locator('.help-reading a[href="#help-files"]').click();
  await currentTopic(help, "files").waitFor();
  await closeHelp(page, help, files);

  await page.getByRole("button", { name: "Find files", exact: true }).click();
  const search = page.getByRole("dialog", { name: "Find files", exact: true });
  const mask = search.getByRole("textbox", { name: "File mask", exact: true });
  await openHelp(page, mask, "search");
  await closeHelp(page, help, mask);
  await page.keyboard.press("Escape");
  await search.waitFor({ state: "hidden" });

  const commandLine = page.getByRole("combobox", { name: "Command line", exact: true });
  await openHelp(page, commandLine, "terminal");
  await closeHelp(page, help, commandLine);

  for (const [key, topic] of [["F3", "viewer"], ["F4", "editor"]]) {
    await files.locator('[data-tooltip="note.txt"]').click();
    await files.press(key);
    const document = page.getByRole("region", { name: "note.txt", exact: true });
    const close = document.getByRole("button", { name: "Close document", exact: true });
    await openHelp(page, close, topic);
    if (topic === "editor") {
      await help.locator('.help-reading a[href="#help-viewer"]').click();
      await currentTopic(help, "viewer").waitFor();
    }
    await closeHelp(page, help, close);
    await close.click();
    await document.waitFor({ state: "hidden" });
  }

  await page.locator('#right-files [data-tooltip="note.txt"]').click();
  await files.locator('[data-tooltip="note.txt"]').click();
  await files.press("Shift+F11");
  const comparison = page.getByRole("dialog", { name: "Compare files", exact: true });
  const layout = comparison.getByRole("combobox", { name: "Layout", exact: true });
  await openHelp(page, layout, "compare");
  await closeHelp(page, help, layout);
  await page.keyboard.press("Escape");
  await comparison.waitFor({ state: "hidden" });

  await page.getByRole("button", { name: "Options", exact: true }).click();
  const options = page.getByRole("dialog", { name: "Options", exact: true });
  const appearance = options.getByRole("button", { name: "Appearance", exact: true });
  await openHelp(page, appearance, "appearance");
  await help.locator('.help-reading a[href="#help-window"]').click();
  await currentTopic(help, "window").waitFor();
  await closeHelp(page, help, appearance);
  const shortcuts = options.getByRole("button", { name: "Keyboard shortcuts", exact: true });
  await shortcuts.click();
  await openHelp(page, shortcuts, "shortcuts");
  await closeHelp(page, help, shortcuts);
  const edit = options.getByRole("button", { name: "Change F1 for Help", exact: true });
  await edit.click();
  await options.getByRole("textbox", { name: "New shortcut to replace F1 for Help", exact: true }).press("Control+Shift+F1");
  await options.getByRole("button", { name: "Apply", exact: true }).click();
  await shortcuts.press("F1");
  assert.equal(await help.count(), 0);
  await shortcuts.press("Control+Shift+F1");
  await currentTopic(help, "shortcuts").waitFor();
  await closeHelp(page, help, shortcuts);
  const removal = process.platform === "darwin" ? "Remove ⌃⇧F1 from Help" : "Remove Ctrl+Shift+F1 from Help";
  await options.getByRole("button", { name: removal, exact: true }).click();
  await options.getByRole("button", { name: "Apply", exact: true }).click();
  await shortcuts.press("Control+Shift+F1");
  assert.equal(await help.count(), 0);
  await page.close();

  for (const [language, helpLabel, operations] of [
    ["uk", "Довідка", "Операції з файлами"],
    ["ru", "Справка", "Операции с файлами"],
  ]) {
    const localized = await openFixture(browser, language);
    await localized.context().setOffline(true);
    const pane = localized.locator("#left-files");
    const guide = await openHelp(localized, pane, "files", helpLabel);
    const link = guide.locator('.help-reading a[href="#help-operations"]');
    assert.match(await link.innerText(), language === "uk" ? /елементів/ : /элементов/);
    await link.press("Enter");
    await currentTopic(guide, "operations").waitFor();
    assert.equal(await guide.locator("#help-operations h3").innerText(), operations);
    assert.equal(await localized.locator("html").getAttribute("lang"), language);
    await closeHelp(localized, guide, pane);
    await localized.close();
  }
  console.log("Verified contextual Help, related links, focus restoration, three offline languages, and remappable F1.");
} finally {
  await browser.close();
}
