import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { openMainMenu } from "./menu-header-smoke.mjs";

const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, colorScheme: "light" });
  page.setDefaultTimeout(8000);
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  await page.addInitScript(() => {
    const root = /Windows/i.test(navigator.userAgent) ? "C:\\fixture" : "/fixture";
    const row = (name, value, source, kind = "literal") => ({ name, value, source, kind, overriddenBy: null });
    window.environment = {
      user: { VALUE: row("VALUE", "private user text", "HKCU"), PATH: row("PATH", "%USERPROFILE%\\bin", "HKCU", "expandable"),
        PROFILE: { ...row("PROFILE", "profile value", "env/" + "very-long-path/".repeat(24)), overriddenBy: "local override" },
        "0_TEST": row("0_TEST", "zero value", "Fixture definition"), "2_TEST": row("2_TEST", "two value", "Fixture definition") },
      system: { PATH: row("PATH", "system path", "HKLM", "expandable") },
      process: { VALUE: row("VALUE", "inherited value", "Dirlume process"), PROMPT: row("PROMPT", "prompt value", "Dirlume process") },
    };
    const file = { name: "note.txt", directory: false, link: false, hidden: false, size: 7, modified: null };
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args = {}) => {
        if (command === "locations") return [{ label: "Home", path: root }, { label: "Downloads", path: root + "/other" }];
        if (command === "list_directory") return { path: args.path, parent: null, entries: [file], omitted: 0 };
        if (command === "file_icons") return [null];
        const table = window.environment[args.scope];
        if (command === "environment_scope") return {
          rows: Object.values(table).map(({ name, source, overriddenBy }) => ({ name, source, overriddenBy })),
          info: { target: args.scope === "user" ? "HKCU" : "HKLM", activation: "Fixture session", expandable: args.scope !== "process" },
        };
        if (command === "environment_value") {
          const value = structuredClone(table[args.name] ?? null);
          if (window.holdEnvironmentValue) {
            return new Promise((resolve) => { window.finishEnvironmentValue = () => resolve(value); });
          }
          return value;
        }
        if (command === "save_environment" && window.failEnvironmentWrite) throw new Error("Fixture save error");
        if (command === "save_environment") return { outcomes: args.edits.map((edit) => {
          const current = table[edit.name] ?? null;
          if (JSON.stringify(current) !== JSON.stringify(edit.expected)) return { name: edit.name, result: "conflict" };
          if (args.scope === "system" && edit.name === "VALUE") return { name: edit.name, result: "denied" };
          if (edit.name === "PATH" && current && !edit.replacePath) return { name: edit.name, result: "invalid" };
          table[edit.name] = row(edit.name, edit.value, args.scope === "user" ? "HKCU" : "HKLM", edit.kind);
          return { name: edit.name, result: "saved" };
        }) };
        return null;
      },
    };
  });
  const button = (scope, name) => scope.getByRole("button", { name, exact: true });
  const dialog = (name) => page.getByRole("dialog", { name, exact: true });
  async function enter(side, scope) {
    const files = page.locator("#" + side + "-files");
    await files.getByRole("option", { name: /^note\.txt/ }).click();
    const commands = await openMainMenu(page, "Commands");
    await commands.getByRole("menuitemradio", { name: "Environment variables", exact: true }).click();
    const root = page.locator(".environment-" + side);
    await button(root, scope).click();
    await root.getByRole("listbox", { name: scope }).waitFor();
    return root;
  }
  await page.goto("http://dirlume.test/");
  const swap = await page.evaluate(() => /Mac/i.test(navigator.userAgent) ? "Meta+u" : "Control+u");
  const left = await enter("left", "User variables");
  const leftList = page.locator("#left-environment");
  assert.equal(await left.getByText("private user text").count(), 0);
  const variable = (scope, name) => scope.locator(`[data-variable="${name}"]`);
  const selected = (scope) => scope.locator('[data-variable][aria-selected="true"]');
  const quick = (scope) => scope.getByRole("textbox", { name: "Quick search", exact: true });
  const leftFilter = left.getByRole("searchbox", { name: "Filter variables" });
  await page.setViewportSize({ width: 630, height: 560 });
  const columns = await left.evaluate((pane) => {
    const headers = [...pane.querySelectorAll(".environment-columns span")];
    const cells = [...pane.querySelector('[data-variable="PROFILE"]').children];
    return {
      columns: headers.map((header) => header.textContent),
      aligned: headers.every((header, index) => Math.abs(header.getBoundingClientRect().left - cells[index].getBoundingClientRect().left) < 2),
      clipped: cells[1].scrollWidth > cells[1].clientWidth && getComputedStyle(cells[1]).textOverflow === "ellipsis",
      source: cells[1].textContent,
    };
  });
  assert.deepEqual(columns.columns, ["Variable name", "Definition source"]);
  assert.ok(columns.aligned && columns.clipped);
  assert.match(columns.source, /env\/very-long-path.+Overridden by local override/);
  await page.setViewportSize({ width: 1100, height: 760 });
  await leftFilter.fill("P");
  const filtered = await left.getByRole("option").count();
  await leftList.press("Alt+p");
  assert.equal((await quick(left).inputValue()).toLowerCase(), "p");
  await quick(left).fill("pr");
  await variable(left, "PROFILE").and(selected(left)).waitFor();
  await quick(left).fill("p");
  await quick(left).press("ArrowDown");
  await variable(left, "PATH").and(selected(left)).waitFor();
  await quick(left).press("ArrowUp");
  await variable(left, "PROFILE").and(selected(left)).waitFor();
  assert.equal(await leftFilter.inputValue(), "P");
  assert.equal(await left.getByRole("option").count(), filtered);
  assert.equal(await leftList.getAttribute("aria-activedescendant"), await selected(left).getAttribute("id"));
  await quick(left).press("Enter");
  const profile = dialog("Inspect environment variable");
  assert.equal(await profile.getByLabel("Variable name").inputValue(), "PROFILE");
  await profile.getByText("env/" + "very-long-path/".repeat(24), { exact: true }).waitFor();
  await button(profile, "Close").click();
  await leftList.press("Alt+p");
  await quick(left).press("Escape");
  assert.ok(await leftList.evaluate((list) => document.activeElement === list && list.matches(":focus-visible")));
  await leftFilter.fill("");
  for (const digit of ["0", "2"]) {
    await leftList.press(`Alt+${digit}`);
    assert.equal(await quick(left).inputValue(), digit);
    await variable(left, `${digit}_TEST`).and(selected(left)).waitFor();
    await quick(left).press("Escape");
  }
  await leftList.press("Alt+9");
  await left.getByRole("status").getByText("No match", { exact: true }).waitFor();
  assert.equal(await selected(left).getAttribute("data-variable"), "2_TEST");
  await quick(left).press("Escape");
  await leftList.dispatchEvent("keydown", { key: "º", code: "Digit0", altKey: true });
  assert.equal(await quick(left).inputValue(), "0");
  await quick(left).press("Enter");
  const digitInspect = dialog("Inspect environment variable");
  assert.equal(await digitInspect.getByLabel("Variable name").inputValue(), "0_TEST");
  await button(digitInspect, "Close").click();

  await left.getByRole("option", { name: /^VALUE/ }).click();
  await leftList.press("F3");
  const inspect = dialog("Inspect environment variable");
  assert.equal(await inspect.getByRole("textbox", { name: "Value", exact: true }).inputValue(), "private user text");
  assert.ok(await inspect.getByRole("textbox", { name: "Value", exact: true }).evaluate((field) => field.readOnly));
  assert.equal(await button(inspect, "Save").count(), 0);
  await button(inspect, "Close").click();
  await page.evaluate(() => {
    window.environment.user.VALUE.overriddenBy = "override/" + "long-definition".repeat(20);
    window.holdEnvironmentValue = true;
  });
  await leftList.press("F4");
  const edit = dialog("Edit environment variable");
  const editName = edit.getByRole("textbox", { name: "Variable name", exact: true });
  const editValue = edit.getByRole("textbox", { name: "Value", exact: true });
  await edit.getByRole("status").getByText("Loading environment variable…").waitFor();
  assert.ok(await editName.evaluate((field) => field.readOnly));
  assert.ok(await button(edit, "Save").isDisabled());
  await page.waitForFunction(() => window.finishEnvironmentValue);
  await page.evaluate(() => { window.holdEnvironmentValue = false; window.finishEnvironmentValue(); });
  await editValue.waitFor();
  assert.ok(await editValue.evaluate((field) => field.matches(":focus-visible")));
  const editorLayout = () => edit.evaluate((dialog) => {
    const form = dialog.querySelector("form");
    const [name, type, value] = form.querySelectorAll("label.field");
    const a = name.getBoundingClientRect();
    const b = type.getBoundingClientRect();
    const v = value.getBoundingClientRect();
    const bar = dialog.querySelector("footer").getBoundingClientRect();
    const edge = form.getBoundingClientRect();
    return {
      stacked: b.top >= a.bottom,
      padding: a.left - edge.left,
      fullWidth: Math.abs(v.width - (form.clientWidth - 32)) < 2,
      detailsBelow: form.querySelector(".environment-source").getBoundingClientRect().top >= v.bottom,
      bodyScrolls: form.scrollHeight > form.clientHeight,
      footerFits: bar.bottom <= dialog.getBoundingClientRect().bottom,
      horizontalOverflow: form.scrollWidth > form.clientWidth,
    };
  });
  const wide = await editorLayout();
  assert.equal(wide.stacked, false);
  assert.equal(wide.padding, 16);
  assert.ok(wide.fullWidth && wide.detailsBelow && wide.footerFits && !wide.horizontalOverflow);
  await edit.getByText("Overridden by", { exact: true }).waitFor();
  await edit.getByText("Fixture session", { exact: true }).waitFor();
  assert.ok(await button(edit, "Save").evaluate((button) => button.classList.contains("primary")));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.locator('html[data-theme="dark"]').waitFor();
  await page.setViewportSize({ width: 350, height: 350 });
  const narrow = await editorLayout();
  assert.ok(narrow.stacked && narrow.fullWidth && narrow.bodyScrolls && narrow.footerFits && !narrow.horizontalOverflow, JSON.stringify(narrow));
  await editValue.press("Shift+Tab");
  assert.ok(await edit.getByLabel("Value type").evaluate((field) => field === document.activeElement));
  await page.setViewportSize({ width: 1100, height: 760 });
  await editValue.fill("new draft");
  await page.evaluate(() => { window.failEnvironmentWrite = true; });
  await button(edit, "Save").click();
  await edit.getByRole("alert").getByText("Could not save the environment variable.").waitFor();
  assert.equal(await editValue.inputValue(), "new draft");
  await page.evaluate(() => { window.failEnvironmentWrite = false; });
  await page.evaluate(() => { window.environment.user.VALUE.value = "external change"; });
  await button(edit, "Save").click();
  await edit.getByRole("alert").getByText("Changed since review").waitFor();
  assert.equal(await editValue.inputValue(), "new draft");
  await button(edit, "Use current definition for review").click();
  await button(edit, "Save").click();
  await edit.waitFor({ state: "hidden" });
  await leftList.press("Shift+F4");
  const create = dialog("New environment variable");
  const createName = create.getByLabel("Variable name");
  assert.ok(await createName.evaluate((field) => field.matches(":focus-visible")));
  await createName.fill("NEW_VALUE");
  await create.getByRole("textbox", { name: "Value", exact: true }).fill("é with whitespace ");
  await button(create, "Save").click();
  await left.getByRole("option", { name: /^NEW_VALUE/ }).waitFor();
  await left.getByRole("option", { name: /^PATH/ }).click();
  await leftList.press("F4");
  await edit.getByRole("checkbox", { name: "Replace the entire destination PATH definition." }).waitFor();
  assert.ok(await button(edit, "Save").isDisabled());
  await edit.getByRole("checkbox", { name: "Replace the entire destination PATH definition." }).check();
  assert.ok(await button(edit, "Save").isEnabled());
  await button(edit, "Cancel").click();

  const filter = left.getByRole("searchbox", { name: "Filter variables" });
  await filter.fill("NEW_VALUE");
  await left.getByRole("option", { name: /^NEW_VALUE/ }).click();
  await filter.press(swap);
  const moved = page.locator(".environment-right");
  await moved.getByRole("option", { name: /^NEW_VALUE/, selected: true }).waitFor();
  assert.equal(await moved.getByRole("searchbox", { name: "Filter variables" }).inputValue(), "NEW_VALUE");
  assert.equal(await page.locator("#left-files").isVisible(), true);
  await moved.getByRole("searchbox", { name: "Filter variables" }).press(swap);
  await filter.fill("");

  const right = await enter("right", "System variables");
  const rightList = page.locator("#right-environment");
  const beforeRight = await selected(left).getAttribute("data-variable");
  await rightList.press("Alt+p");
  await variable(right, "PATH").and(selected(right)).waitFor();
  await quick(right).press("Escape");
  await rightList.press("Alt+2");
  await right.getByRole("status").getByText("No match", { exact: true }).waitFor();
  assert.equal(await quick(right).inputValue(), "2");
  assert.equal(await selected(left).getAttribute("data-variable"), beforeRight);
  await quick(right).press("Escape");
  await left.getByRole("option", { name: /^VALUE/ }).click();
  await leftList.press("Insert");
  await left.getByRole("option", { name: /^PATH/ }).click();
  await leftList.press("Insert");
  await leftList.press(swap);
  await page.locator(".environment-right").getByRole("option", { name: /^PATH/, selected: true }).waitFor();
  await page.locator(".environment-left").getByRole("listbox", { name: "System variables" }).waitFor();
  await page.locator("#right-environment").press(swap);
  await leftList.press("F5");
  const copy = dialog("Copy environment variables");
  const path = copy.locator("li").filter({ hasText: "PATH" });
  await path.getByLabel("Action for PATH").selectOption("replace");
  assert.equal(await button(copy, "Copy").last().isDisabled(), true);
  await path.getByText("Inspect values", { exact: true }).click();
  assert.equal(await path.getByRole("textbox", { name: "Source value", exact: true }).inputValue(), "%USERPROFILE%\\bin");
  assert.equal(await path.getByRole("textbox", { name: "Destination value", exact: true }).inputValue(), "system path");
  await path.getByRole("checkbox", { name: "Replace the entire destination PATH definition." }).check();
  await button(copy, "Copy").last().click();
  await path.getByText("Copied", { exact: true }).waitFor();
  await copy.getByText("Authorization declined or access denied").waitFor();
  const state = await page.evaluate(() => window.environment.system);
  assert.equal(state.PATH.value, "%USERPROFILE%\\bin");
  assert.equal(state.PATH.kind, "expandable");
  assert.equal(state.VALUE, undefined);
  await button(copy, "Close").click();
  await button(left, "Back to files").click();
  await page.locator("#left-files").getByRole("option", { name: /^note\.txt/, selected: true }).waitFor();
  await button(right, "Back to files").click();
  const process = await enter("right", "Dirlume process environment");
  assert.equal(await button(process, "Edit").count(), 0);
  await rightList.press("Alt+p");
  await variable(process, "PROMPT").and(selected(process)).waitFor();
  await quick(process).press("Escape");
  await variable(process, "VALUE").click();
  await button(process, "Inspect").click();
  const inherited = dialog("Inspect environment variable");
  assert.equal(await inherited.getByRole("textbox", { name: "Value", exact: true }).inputValue(), "inherited value");
  assert.equal(await inherited.getByLabel("Value type").count(), 0);
  assert.ok(await inherited.getByLabel("Variable name").evaluate((field) => {
    const value = field.closest("form").querySelector("textarea");
    return Math.abs(field.getBoundingClientRect().width - value.getBoundingClientRect().width) < 1;
  }));
  await button(inherited, "Close").click();
  for (const binding of [["Ctrl+Alt+M"], []]) {
    await page.evaluate((quickSearch) => {
      const key = "dirlume.preferences.v1";
      const preferences = JSON.parse(localStorage.getItem(key));
      localStorage.setItem(key, JSON.stringify({ ...preferences, activeShortcutScheme: "environment-keys",
        shortcutSchemes: [{ id: "environment-keys", name: "Environment keys", bindings: { quickSearch } }] }));
    }, binding);
    await page.reload();
    await enter("left", "User variables");
    await leftList.press("Alt+p");
    await leftList.press("Alt+2");
    assert.equal(await quick(left).count(), 0);
    await leftList.press("Control+Alt+m");
    if (binding.length) {
      await quick(left).fill("profile");
      await variable(left, "PROFILE").and(selected(left)).waitFor();
    } else assert.equal(await quick(left).count(), 0);
  }
  console.log("Verified environment column geometry, prefix search, shortcut settings, pane swaps, and the variable dialogs.");
} finally {
  await browser.close();
}
