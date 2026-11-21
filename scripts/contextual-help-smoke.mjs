import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

async function openFixture(browser, language = "en", userAgent) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, userAgent });
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
        if (command === "space_mount") return { path: root, share: false };
        if (command === "scan_local_space") {
          args.output.onmessage({ kind: "start", strategy: "walk" });
          args.output.onmessage({ kind: "batch", changes: [{ parent: 0, name: file.name, directory: false, size: 7, allocated: 4096 }] });
          await new Promise((resolve) => { window.finishContextScan = resolve; });
          args.output.onmessage({ kind: "batch", changes: [{ closed: 0 }] });
          args.output.onmessage({ kind: "finished" });
        }
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

  const drive = page.getByRole("button", { name: "Locations for left pane", exact: true });
  await drive.click();
  const picker = page.getByRole("group", { name: "Left pane sources", exact: true });
  const source = picker.getByRole("button", { name: /^Downloads/ });
  await page.keyboard.press("ArrowDown");
  await openHelp(page, source, "paneSources");
  await help.locator('.help-reading a[href="#help-remote"]').click();
  await currentTopic(help, "remote").waitFor();
  await closeHelp(page, help, source);
  assert.equal(await picker.isVisible(), true);
  await page.keyboard.press("Escape");
  await picker.waitFor({ state: "hidden" });

  await files.press(await page.evaluate(() => /Macintosh/.test(navigator.userAgent)) ? "Meta+l" : "Control+l");
  const address = page.locator("#left-address");
  await address.fill("Unsubmitted draft");
  await openHelp(page, address, "paneAddress");
  await closeHelp(page, help, address);
  assert.equal(await address.inputValue(), "Unsubmitted draft");
  await address.press("Escape");

  await drive.hover();
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

  for (const [userAgent, sides] of [
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", ["right", "left"]],
    ["Mozilla/5.0 (X11; Linux x86_64)", ["right"]],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", ["left"]],
  ]) {
    const workspace = await openFixture(browser, "en", userAgent);
    const guide = workspace.getByRole("dialog", { name: "Help", exact: true });
    for (const side of sides) {
      const other = side === "left" ? "right" : "left";
      const scanPane = workspace.locator(`#${side}-pane`);
      const files = workspace.locator(`#${other}-files`);
      const drive = workspace.getByRole("button", { name: `Locations for ${other} pane`, exact: true });
      const file = files.locator('[data-tooltip="note.txt"]');
      await file.click();
      await files.press("Insert");
      const marks = await files.locator(".marked").count();
      const selected = await files.getAttribute("aria-activedescendant");
      await scanPane.getByRole("button", { name: "Analyze space", exact: true }).click();
      const analyzer = workspace.getByRole("region", { name: "Space Analyzer", exact: true });
      const stop = analyzer.getByRole("button", { name: "Stop", exact: true });
      const treemap = analyzer.getByRole("button", { name: "Treemap", exact: true });
      const metric = analyzer.getByRole("combobox", { name: "Size metric", exact: true });
      await stop.waitFor();
      await drive.hover();
      await workspace.keyboard.press("F1");
      await currentTopic(guide, "paneSources").waitFor();
      await guide.getByText(`This control changes the source for the ${other} pane.`, { exact: true }).waitFor();
      await workspace.keyboard.press("Escape");
      await guide.waitFor({ state: "hidden" });

      await analyzer.locator(".space-target").hover();
      await workspace.keyboard.press("F1");
      await currentTopic(guide, "spacePath").waitFor();
      assert.match(await guide.locator(".help-reading").innerText(), /root being scanned/);
      await workspace.keyboard.press("Escape");
      await guide.waitFor({ state: "hidden" });

      await treemap.focus();
      await drive.hover();
      await workspace.keyboard.press("Tab");
      assert.equal(await metric.evaluate((node) => node === document.activeElement), true);
      await workspace.keyboard.press("F1");
      await currentTopic(guide, "spaceMetric").waitFor();
      assert.match(await guide.locator(".help-reading").innerText(), /allocated storage/);
      await closeHelp(workspace, guide, metric);
      assert.equal(await stop.isVisible(), true);
      assert.equal(await files.locator(".marked").count(), marks);
      assert.equal(await files.getAttribute("aria-activedescendant"), selected);

      await openHelp(workspace, stop, "spaceActions");
      await workspace.evaluate(() => window.finishContextScan());
      await stop.waitFor({ state: "hidden" });
      await closeHelp(workspace, guide, analyzer.getByRole("treegrid"));
      await analyzer.getByRole("button", { name: "Close", exact: true }).click();
    }
    await workspace.close();
  }

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
    await guide.locator('.help-contents a[href="#help-spaceAnalyzer"]').click();
    const metrics = guide.locator('.help-reading a[href="#help-spaceMetric"]');
    await metrics.click();
    await currentTopic(guide, "spaceMetric").waitFor();
    assert.match(await guide.locator(".help-reading").innerText(), language === "uk" ? /виділене сховище/ : /выделенное хранилище/);
    await closeHelp(localized, guide, pane);
    await localized.close();
  }
  console.log("Verified pointer and keyboard Help in both panes, scan continuity, deferred focus, related links, three offline languages, and remappable F1.");
} finally {
  await browser.close();
}
