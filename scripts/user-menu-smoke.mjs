import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { openMainMenu } from "./menu-header-smoke.mjs";

const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 720, height: 520 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  await page.addInitScript(() => {
    const folder = /Windows/.test(navigator.userAgent) ? "C:\\fixture" : "/fixture";
    const path = (name) => `${folder}${folder.startsWith("C:") ? "\\" : "/"}${name}`;
    const local = { path: path(".dirlume-menu.json"), personal: false, writable: true, revision: "v1", approved: false, error: null,
      entries: [{ kind: "submenu", label: "Tools", hotkey: "T", children: [
        { kind: "command", label: "Print {{focusedName}}", hotkey: "F4", visibility: "file", mask: "*.txt",
          steps: ["echo {{focusedPath}} {{prompt:value}}"], prompts: [{ name: "value", label: "Message", initial: "default" }] },
        { kind: "separator" },
        { kind: "command", label: "Only folders", hotkey: "D", visibility: "folder", mask: "", steps: ["echo folder"], prompts: [] },
      ] }] };
    const parent = { ...local, path: folder.startsWith("C:") ? "C:\\.dirlume-menu.json" : "/.dirlume-menu.json",
      writable: false, entries: local.entries, approved: true };
    const broken = { ...parent, path: "/broken/.dirlume-menu.json", entries: [], error: "Unreadable menu fixture." };
    const personal = { path: "/profile/user-menu.json", personal: true, writable: true, revision: null, approved: true, entries: [], error: null,
      ...JSON.parse(localStorage.getItem("fixture.personal-menu") ?? "null") };
    window.menuFixture = { runs: [], reviews: [], saves: [], local, personal };
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args) => {
        if (command === "locations") return [{ label: "Home", path: folder }];
        if (command === "file_icons" || command === "installed_fonts") return [];
        if (command === "list_directory") return { path: args.path, parent: null, omitted: 0,
          entries: [{ name: "note.txt", directory: false, size: 5, hidden: false, modified: 0 }] };
        if (command === "user_menu_sources") return [local, parent, broken, personal];
        if (command === "approve_user_menu") {
          window.menuFixture.reviews.push(args.source);
          assertRevision(args.source, local);
          local.approved = true;
          return null;
        }
        if (command === "save_user_menu") {
          window.menuFixture.saves.push(args);
          const target = args.source.path === local.path ? local : personal;
          if (target === personal && target.revision === null) {
            Object.assign(target, { revision: "external-v1", entries: [
              { kind: "command", label: "External edit", hotkey: "", visibility: "always", mask: "", steps: ["echo external"], prompts: [] }
            ] });
          }
          assertRevision(args.source, target);
          Object.assign(target, { entries: args.entries, revision: `saved-${window.menuFixture.saves.length}`, approved: target.personal });
          if (target.personal) localStorage.setItem("fixture.personal-menu", JSON.stringify(target));
          return target;
        }
        if (command === "open_terminal" && args.request.userMenu) { window.menuFixture.runs.push(args.request); return false; }
        return null;
      },
    };
    function assertRevision(source, target) {
      if (source.revision !== target.revision) throw Error("The menu definition changed on disk. Reload before continuing.");
    }
  });
  await page.goto("http://dirlume.test/");
  const note = (side = "left") => page.locator(`#${side}-files [data-tooltip="note.txt"]`);
  await note().click().catch(async (error) => {
    console.error(errors.join("\n"));
    throw error;
  });
  const button = (name) => page.getByRole("button", { name, exact: true });
  async function openMenu() {
    const item = (await openMainMenu(page, "Commands")).getByRole("menuitem", { name: "User Menu", exact: true });
    assert.equal(await item.locator("kbd").textContent(), "F2");
    await item.click();
  }
  const list = () => page.getByRole("listbox", { name: "Menu entries" });
  const launcher = page.getByRole("dialog", { name: "User Menu", exact: true });
  const source = page.getByRole("combobox", { name: "Menu source" });
  const name = () => page.getByRole("textbox", { name: "Name", exact: true });
  const shell = () => page.getByRole("textbox", { name: "Shell commands", exact: true });
  const inlineRename = page.getByRole("textbox", { name: "New name for note.txt", exact: true });
  const settingsKey = "dirlume.preferences.v1";
  await page.keyboard.press("F2");
  await launcher.waitFor();
  assert.equal(await inlineRename.count(), 0);
  await page.keyboard.press("Escape");
  await note("right").click();
  await page.keyboard.press("F2");
  await launcher.waitFor();
  await list().press("t");
  assert.equal(await list().locator("hr").count(), 1);
  await list().press("F4");
  await page.getByRole("dialog", { name: "Review folder menu" }).waitFor();
  assert.equal(await page.evaluate(() => window.menuFixture.runs.length), 0);
  await button("Approve this version").click();
  await page.getByRole("option", { name: /Print note\.txt/ }).waitFor();
  assert.equal(await page.getByRole("option", { name: /Only folders/ }).count(), 0);
  await list().press("Control+h");
  await page.getByRole("option", { name: /Only folders/ }).waitFor();
  await list().press("d");
  assert.equal(await page.evaluate(() => window.menuFixture.runs.length), 0);
  await list().press("F4");
  const input = page.getByRole("textbox", { name: "Message" });
  await input.press("Escape");
  await list().press("F4");
  await input.fill("a $b & 'c'");
  await button("Run").click();
  await page.waitForFunction(() => window.menuFixture.runs.length === 1);
  const { runs, reviews } = await page.evaluate(() => window.menuFixture);
  assert.equal(reviews.length, 1);
  assert.deepEqual(runs[0].userMenu.index, [0, 0]);
  assert.equal(runs[0].userMenu.source.revision, "v1");
  assert.ok(runs[0].userMenu.focused.replaceAll("\\", "/").endsWith("/fixture/note.txt"));
  assert.equal(runs[0].userMenu.inputs.value, "a $b & 'c'");
  await button("Close terminal").click();
  await page.evaluate(() => Object.assign(window.menuFixture.local, { revision: "v2", approved: false }));
  await openMenu();
  await list().press("t");
  await list().press("F4");
  await page.getByRole("dialog", { name: "Review folder menu" }).waitFor();
  assert.equal(await page.evaluate(() => window.menuFixture.runs.length), 1);
  await button("Cancel").click();
  await page.getByRole("dialog", { name: "Tools", exact: true }).getByRole("button", { name: "Back", exact: true }).click();
  await source.selectOption({ index: 1 });
  await launcher.getByText("Read only", { exact: true }).waitFor();
  assert.equal(await button("New command").count(), 0);
  await source.selectOption({ index: 2 });
  await launcher.getByRole("alert").filter({ hasText: "Unreadable menu fixture." }).waitFor();
  await source.selectOption({ label: "Personal menu" });
  const emptyMenu = launcher;
  await emptyMenu.getByText("No saved commands", { exact: true }).waitFor();
  assert.equal(await list().count(), 0);
  assert.equal(await emptyMenu.getByRole("checkbox", { name: "Show hidden entries" }).count(), 0);
  assert.equal(await emptyMenu.getByText("/profile/user-menu.json", { exact: true }).count(), 0);
  const create = button("New command");
  assert.equal(await create.evaluate((element) => document.activeElement === element && element.classList.contains("primary")), true);
  assert.ok(await emptyMenu.locator(".dialog-body").evaluate((element) => parseFloat(getComputedStyle(element).paddingInlineStart) >= 12));
  await page.setViewportSize({ width: 400, height: 330 });
  await create.press("Enter");
  const editor = page.getByRole("dialog", { name: "New command", exact: true });
  await editor.waitFor();
  assert.equal(await name().evaluate((element) => document.activeElement === element), true);
  assert.equal(await editor.getByRole("textbox", { name: "Menu hotkey" }).isVisible(), false);
  assert.equal(await button("Save command").isEnabled(), false);
  await page.setViewportSize({ width: 1100, height: 720 });
  assert.ok((await editor.boundingBox()).width < 600);
  await name().fill("Personal command");
  await shell().fill("pwd");
  const insert = page.getByRole("combobox", { name: "Insert value" });
  await insert.selectOption("activeFolder");
  assert.match(await shell().inputValue(), /\{\{activeFolder\}\}/);
  await shell().fill("pwd");
  assert.equal(await editor.locator('[data-access-key="m"]').count(), 0);
  if (process.env.DIRLUME_USER_MENU_PREVIEW) {
    await page.evaluate(() => new Promise((ready) => requestAnimationFrame(() => requestAnimationFrame(ready))));
    await editor.screenshot({ path: ".smoke/user-menu-766-editor.png" });
  }
  await page.setViewportSize({ width: 400, height: 330 });
  await button("Save command").press("Enter");
  await page.getByRole("alert").filter({ hasText: "The menu definition changed on disk" }).waitFor();
  assert.equal(await name().inputValue(), "Personal command");
  assert.equal(await shell().inputValue(), "pwd");
  await button("Reload menu and keep draft").click();
  await editor.getByRole("status").filter({ hasText: "Save your draft as a new entry" }).waitFor();
  await button("Save command").click();
  await list().getByRole("option", { name: "Personal command", selected: true }).waitFor();
  assert.equal(await list().evaluate((element) => document.activeElement === element), true);
  assert.equal(await source.inputValue(), "/profile/user-menu.json");
  assert.deepEqual(await page.evaluate(() => window.menuFixture.saves[1].entries.map(({ label }) => label)), ["External edit", "Personal command"]);
  assert.equal(await page.evaluate(() => window.menuFixture.runs.length), 1);
  await launcher.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("dialog", { name: "Edit command", exact: true }).waitFor();
  await name().fill("Working folder");
  await button("Save command").click();
  await list().getByRole("option", { name: "Working folder", selected: true }).waitFor();
  assert.equal(await page.evaluate(() => window.menuFixture.runs.length), 1);
  await list().press("Enter");
  await page.waitForFunction(() => window.menuFixture.runs.length === 2);
  assert.deepEqual(await page.evaluate(() => window.menuFixture.runs[1].userMenu.index), [1]);
  await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ theme: "dark" })), settingsKey);
  await page.setViewportSize({ width: 730, height: 540 });
  await page.reload();
  await page.locator('html[data-theme="dark"]').waitFor();
  await note().click();
  await page.keyboard.press("F2");
  await source.selectOption({ label: "Personal menu" });
  await list().getByRole("option", { name: "Working folder" }).waitFor();
  await source.selectOption({ label: "Current folder menu" });
  await list().press("t");
  await button("New command").click();
  await name().fill("Hidden command");
  await shell().fill("echo hidden");
  await name().press("F2");
  await name().waitFor();
  assert.equal(await launcher.count(), 0);
  await page.getByText("Advanced options", { exact: true }).click();
  await page.getByLabel("Visibility").selectOption("folder");
  if (process.env.DIRLUME_USER_MENU_PREVIEW) {
    await page.setViewportSize({ width: 400, height: 330 });
    await page.getByLabel("Visibility").focus();
    await editor.screenshot({ path: ".smoke/user-menu-766-advanced-dark.png" });
    await page.setViewportSize({ width: 730, height: 540 });
  }
  await button("Save command").click();
  const tools = page.getByRole("dialog", { name: "Tools", exact: true });
  await tools.getByRole("status").filter({ hasText: "Use Show hidden entries" }).waitFor();
  assert.equal(await tools.getByRole("option", { name: "Hidden command" }).count(), 0);
  await tools.getByRole("checkbox", { name: "Show hidden entries" }).check();
  await tools.getByRole("option", { name: "Hidden command", selected: true }).waitFor();
  assert.equal(await source.inputValue(), await page.evaluate(() => window.menuFixture.local.path));
  assert.equal(await page.evaluate(() => window.menuFixture.runs.length), 0);

  const bindingCases = [
    { version: 11, bindings: { rename: ["F2"], userMenu: [] }, menu: "F2" },
    { version: 11, bindings: { rename: [], userMenu: ["Ctrl+Shift+M"] }, menu: "Ctrl+Shift+M" },
    { version: 11, bindings: { rename: ["F2", "F11"], userMenu: [] }, rename: "F2" },
    { version: 12, bindings: { rename: ["Ctrl+Shift+R"], userMenu: [] }, rename: "Ctrl+Shift+R" },
  ];
  for (const { version, bindings, menu, rename } of bindingCases) {
    await page.evaluate(({ key, version, bindings }) => localStorage.setItem(key, JSON.stringify({
      bindingDefaults: version, activeShortcutScheme: "custom", shortcutSchemes: [{ id: "custom", name: "Custom", bindings }],
    })), { key: settingsKey, version, bindings });
    await page.reload();
    await note().click();
    if (menu) {
      await page.keyboard.press(menu.replaceAll("Ctrl", "Control"));
      await launcher.waitFor();
      assert.equal(await inlineRename.count(), 0);
      await page.keyboard.press("Escape");
    }
    if (rename) {
      await page.keyboard.press(rename.replaceAll("Ctrl", "Control"));
      await inlineRename.waitFor();
      await inlineRename.press("F2");
      await inlineRename.waitFor();
      assert.equal(await launcher.count(), 0);
      await inlineRename.press("Escape");
    }
    const commands = await openMainMenu(page, "Commands");
    assert.deepEqual(await commands.getByRole("menuitem", { name: "User Menu", exact: true }).locator("kbd").allTextContents(), menu ? [menu] : []);
  }
  assert.deepEqual(errors, []);
  console.log("Verified F2 from both panes, the compact command editor, direct save and restart, submenu and source retention, hidden items, approval, and recovery from external changes.");
} finally {
  await browser.close();
}
