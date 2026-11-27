import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

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
        { kind: "command", label: "Only folders", hotkey: "D", visibility: "folder", mask: "", steps: ["echo folder"], prompts: [] },
      ] }] };
    const personal = { path: "/profile/user-menu.json", personal: true, writable: true, revision: null, approved: true, entries: [], error: null };
    window.menuFixture = { runs: [], reviews: [], saves: [] };
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args) => {
        if (command === "locations") return [{ label: "Home", path: folder }];
        if (command === "file_icons" || command === "installed_fonts") return [];
        if (command === "list_directory") return { path: args.path, parent: null, omitted: 0,
          entries: [{ name: "note.txt", directory: false, size: 5, hidden: false, modified: 0 }] };
        if (command === "user_menu_sources") return [local, personal];
        if (command === "approve_user_menu") { window.menuFixture.reviews.push(args.source); local.approved = true; return null; }
        if (command === "save_user_menu") {
          window.menuFixture.saves.push(args);
          if (window.menuFixture.saves.length === 1) throw Error("The menu definition changed on disk. Reload before continuing.");
          Object.assign(personal, { entries: args.entries, revision: "personal-v1" });
          return personal;
        }
        if (command === "open_terminal" && args.request.userMenu) { window.menuFixture.runs.push(args.request); return false; }
        return null;
      },
    };
  });
  await page.goto("http://dirlume.test/");
  await page.locator('#left-files [data-tooltip="note.txt"]').click().catch(async (error) => {
    console.error(errors.join("\n"));
    throw error;
  });
  const button = (name) => page.getByRole("button", { name, exact: true });
  async function openMenu() {
    await page.getByRole("menubar", { name: "Main menu" }).getByRole("menuitem", { name: "Commands", exact: true }).click();
    await page.getByRole("menuitem", { name: "User Menu", exact: true }).click();
  }
  const list = () => page.getByRole("listbox", { name: "Menu entries" });
  await openMenu();
  await list().press("t");
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
  await openMenu();
  await page.getByRole("combobox", { name: "Menu source" }).selectOption({ label: "Personal menu" });
  await button("New command").click();
  await page.getByRole("textbox", { name: "Label", exact: true }).fill("Personal command");
  await page.getByRole("textbox", { name: "Shell steps, one per line" }).fill("echo hello");
  await button("Apply").click();
  await button("Save menu").click();
  await page.getByRole("alert").filter({ hasText: "The menu definition changed on disk" }).waitFor();
  await page.getByRole("option", { name: "Personal command" }).waitFor();
  await button("Save menu").click();
  await page.waitForFunction(() => window.menuFixture.saves.length === 2);
  assert.equal(await page.evaluate(() => window.menuFixture.saves[1].entries[0].label), "Personal command");
  console.log("Verified folder review, scoped hotkeys, visibility, parameter cancellation, captured arguments, and draft retention after a failed save.");
} finally {
  await browser.close();
}
