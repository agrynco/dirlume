import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

async function checkControl(field) {
  await field.focus();
  const result = await field.evaluate((input) => {
    const group = input.closest(".editable-dropdown");
    const button = group?.querySelector(":scope > button");
    if (!button) return null;
    const frame = getComputedStyle(group);
    const fieldStyle = getComputedStyle(input);
    const buttonStyle = getComputedStyle(button);
    const inputBox = input.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    return {
      border: frame.borderWidth,
      outline: frame.outlineWidth,
      outlineStyle: frame.outlineStyle,
      fieldBorder: fieldStyle.borderWidth,
      buttonBorder: buttonStyle.borderWidth,
      gap: buttonBox.left - inputBox.right,
      heightDifference: buttonBox.height - inputBox.height,
      background: frame.backgroundColor,
    };
  });
  assert.ok(result, "The field and its chevron should share a wrapper.");
  assert.equal(result.border, "1px");
  assert.equal(result.outline, "2px");
  assert.equal(result.outlineStyle, "solid");
  assert.equal(result.fieldBorder, "0px");
  assert.equal(result.buttonBorder, "0px");
  assert.ok(Math.abs(result.gap) < 0.5);
  assert.ok(Math.abs(result.heightDifference) < 0.5);
  return result.background;
}

const browser = await chromium.launch({ channel: "chrome" });
try {
  const backgrounds = new Set();
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 735 }, locale: "en-US" });
    page.setDefaultTimeout(8000);
    await page.route("http://dirlume.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    await page.addInitScript((theme) => {
      const home = /Windows/i.test(navigator.userAgent) ? "C:\\fixture" : "/fixture";
      localStorage.setItem("dirlume.preferences.v1", JSON.stringify({ theme }));
      localStorage.setItem("dirlume.command-history", JSON.stringify(["echo previous"]));
      localStorage.setItem("dirlume.field-history.left-address.local", JSON.stringify([home]));
      localStorage.setItem("dirlume.field-history.settings-search", JSON.stringify(["Fonts"]));
      localStorage.setItem("dirlume.folder-name-history.v1", JSON.stringify([{ name: "Past folder", date: Date.now() }]));
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args) => {
          if (command === "locations") return [{ label: "Home", path: home }];
          if (command === "list_directory") return { path: home, parent: null, entries: [], omitted: 0 };
          if (command === "file_icons") return args.items.map(() => null);
          if (command === "installed_fonts") return ["Fixture Sans"];
          return null;
        },
      };
    }, theme);
    await page.goto("http://dirlume.test/");
    await page.locator(`html[data-theme="${theme}"]`).waitFor();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    const commandBar = page.locator(".command-bar");
    const command = commandBar.getByRole("combobox", { name: "Command line" });
    await command.fill("first line\nsecond line");
    assert.equal(await command.getAttribute("rows"), "2");
    backgrounds.add(await checkControl(command));
    await commandBar.getByRole("button", { name: "Show entry history", exact: true }).click();
    assert.equal(await command.evaluate((field) => field === document.activeElement), true);
    await command.press("ArrowDown");
    await command.press("Enter");
    assert.equal(await command.inputValue(), "echo previous");

    const left = page.locator("#left-pane");
    await left.locator('.address-breadcrumbs[data-editable="true"]').click();
    const address = left.locator("#left-address");
    await checkControl(address);
    await address.press("Alt+ArrowDown");
    const pathHistory = left.getByRole("listbox", { name: "Entry history", exact: true });
    await pathHistory.getByRole("option").waitFor();
    await address.press("Escape");
    await pathHistory.waitFor({ state: "hidden" });
    await address.press("Escape");

    await page.getByRole("navigation", { name: "File actions" }).getByRole("button", { name: "New folder", exact: true }).click();
    const folderDialog = page.getByRole("dialog", { name: "New folder", exact: true });
    const folderName = folderDialog.getByRole("textbox", { name: "Name", exact: true });
    await checkControl(folderName);
    await folderDialog.getByRole("button", { name: "Folder name history", exact: true }).click();
    await folderDialog.getByRole("option", { name: "Past folder", exact: true }).click();
    assert.equal(await folderName.inputValue(), "Past folder");
    assert.equal(await folderName.evaluate((field) => field === document.activeElement), true);
    await folderDialog.getByRole("button", { name: "Cancel", exact: true }).click();

    await page.getByRole("button", { name: "Options", exact: true }).click();
    const options = page.getByRole("dialog", { name: "Options", exact: true });
    const search = options.getByRole("searchbox", { name: "Search settings", exact: true });
    await checkControl(search);
    await search.press("Alt+ArrowDown");
    await options.getByRole("listbox", { name: "Entry history", exact: true }).getByRole("option", { name: "Fonts" }).waitFor();
    await search.press("ArrowDown");
    await search.press("Enter");
    assert.equal(await search.inputValue(), "Fonts");
    await search.fill("");
    await options.getByRole("button", { name: "Fonts", exact: true }).click();
    const font = options.getByRole("combobox", { name: "File panels font family", exact: true });
    await checkControl(font);
    await options.getByRole("button", { name: "Browse installed fonts for file panels", exact: true }).click();
    const fonts = options.getByRole("listbox", { name: "File panels font suggestions", exact: true });
    await fonts.getByRole("option", { name: "Fixture Sans", exact: true }).waitFor();
    assert.equal(await font.evaluate((field) => field === document.activeElement), true);
    await font.fill("Fixture");
    await font.press("ArrowDown");
    await font.press("Enter");
    assert.equal(await font.inputValue(), "Fixture Sans");
    await page.close();
  }
  assert.equal(backgrounds.size, 2, "The shared control should use the active theme's input surface.");
  console.log("Verified editable dropdown borders, keyboard focus, history, and font selection in light and dark themes.");
} finally {
  await browser.close();
}
