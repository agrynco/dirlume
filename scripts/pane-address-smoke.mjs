import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

export async function editPaneAddress(page, side = "left") {
  await page.waitForFunction((side) => document.getElementById(side + "-path")?.dataset.path &&
    document.getElementById(side + "-files")?.getAttribute("aria-busy") === "false", side);
  const address = page.locator("#" + side + "-address");
  if (!await address.isVisible()) {
    if (!await page.evaluate(() => document.hasFocus())) {
      await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|set_focus", { label: "main" }));
    }
    await page.locator("#" + side + "-files").focus();
    await page.waitForFunction((side) => document.activeElement?.id === side + "-files" &&
      document.getElementById(side + "-pane")?.classList.contains("active"), side);
    const mac = await page.evaluate(() => /Macintosh/.test(navigator.userAgent));
    await page.keyboard.press(mac ? "Meta+l" : "Control+l");
    await address.waitFor();
  }
  return address;
}

export async function clickBreadcrumbAncestor(breadcrumbs, name) {
  const visible = breadcrumbs.locator(".address-crumbs").getByRole("button", { name, exact: true });
  if (await visible.isVisible()) {
    await visible.click();
  } else {
    const previous = await breadcrumbs.locator(".address-forward button").evaluateAll(
      (buttons, name) => buttons.some((button) => button.textContent === name), name,
    );
    await breadcrumbs.getByRole("button", { name: previous ? "Show previous path" : "Show parent folders", exact: true }).click();
    await breadcrumbs.locator(previous ? ".address-previous" : ".address-parents").getByRole("button", { name, exact: true }).click();
  }
}

export async function checkAddressFocusLoss(page, side, path, name, parentName) {
  const pane = page.locator(`#${side}-pane`);
  const field = pane.getByRole("combobox", { name: side + " path", exact: true });
  const breadcrumbs = pane.getByRole("navigation", { name: side + " path breadcrumbs", exact: true });
  const files = pane.getByRole("listbox", { name: side + " files", exact: true });
  const parent = pane.getByRole("button", { name: "Parent folder", exact: true });
  const active = (element) => element.evaluate((node) => document.activeElement === node);
  const draft = path + "-unsubmitted";
  await editPaneAddress(page, side);
  await field.fill(draft);
  await files.locator(`[data-tooltip="${name}"]`).click();
  await breadcrumbs.waitFor();
  assert.equal(await active(files), true);
  assert.equal(await pane.locator(`#${side}-path`).getAttribute("data-path"), path);

  await editPaneAddress(page, side);
  assert.equal(await field.inputValue(), path);
  await field.press("Alt+ArrowDown");
  const history = pane.getByRole("listbox", { name: "Entry history", exact: true });
  await history.waitFor();
  assert.equal(await history.getByRole("option", { name: draft, exact: true }).count(), 0);
  await field.press("Escape");
  await history.waitFor({ state: "hidden" });
  assert.equal(await active(field), true);
  await field.press("Shift+Tab");
  await breadcrumbs.waitFor();
  assert.equal(await active(parent), true);

  await clickBreadcrumbAncestor(breadcrumbs, parentName);
  await breadcrumbs.locator("[aria-current=location]").filter({ hasText: parentName }).waitFor();
  await editPaneAddress(page, side);
  await field.press("Alt+ArrowDown");
  await history.getByRole("option", { name: path, exact: true }).click();
  await breadcrumbs.waitFor();
  await page.waitForFunction(({ side, path }) => document.getElementById(side + "-path")?.dataset.path === path, { side, path });
  assert.equal(await active(files), true);
}

export async function testBrowserAddressFocus(userAgent) {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({ userAgent, viewport: { width: 1070, height: 720 } });
    page.setDefaultTimeout(8000);
    await page.route("http://dirlume.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    const paths = await page.evaluate(() => {
      const separator = /Windows/i.test(navigator.userAgent) ? "\\" : "/";
      const base = separator === "\\" ? "C:\\" : "/";
      const parent = base + "Pictures";
      return { separator, base, parent, leaf: parent + separator + "Camera Roll" };
    });
    await page.addInitScript(({ base, parent, leaf }) => {
      const location = { kind: "local", path: leaf, parent };
      localStorage.setItem("dirlume.workspace.v1", JSON.stringify({
        panels: { left: { place: location }, right: { place: location } }, active: "left", split: 50, documents: [],
      }));
      for (const side of ["left", "right"]) localStorage.setItem(`dirlume.field-history.${side}-address.local`, JSON.stringify([leaf]));
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => 1,
        invoke: async (command, args) => {
          if (command === "locations") return [{ label: "Home", path: leaf }];
          if (command === "list_directory") {
            const path = args.path.replace(/[\\/]$/, "");
            const atLeaf = path === leaf;
            return { path, parent: atLeaf ? parent : base, omitted: 0, entries: [{
              name: atLeaf ? "fixture.txt" : "Camera Roll", directory: !atLeaf, hidden: false, size: 1, modified: null,
            }] };
          }
          if (command === "plugin:dialog|open") {
            document.activeElement?.blur();
            return new Promise((done) => { window.finishFolderPicker = () => done(parent); });
          }
          return command === "file_icons" ? [] : null;
        },
      };
    }, paths);
    await page.goto("http://dirlume.test/");
    for (const side of ["left", "right"]) await checkAddressFocusLoss(page, side, paths.leaf, "fixture.txt", "Pictures");
    const right = page.locator("#right-pane");
    const input = await editPaneAddress(page, "right");
    await input.fill(paths.parent + paths.separator + "Ca");
    await right.getByRole("option", { name: "Camera Roll", exact: true }).click();
    await right.getByRole("navigation", { name: "right path breadcrumbs", exact: true }).waitFor();
    await page.evaluate(() => { window.isTauri = true; });
    await editPaneAddress(page, "right");
    await right.getByRole("button", { name: "Browse for a folder", exact: true }).click();
    await page.waitForFunction(() => typeof window.finishFolderPicker === "function");
    assert.equal(await input.isVisible(), true);
    await page.evaluate(() => window.finishFolderPicker());
    await page.waitForFunction((parent) => document.querySelector("#right-path")?.dataset.path === parent, paths.parent);
    console.log("Verified breadcrumb restoration, focus, address history, completion and a native-folder-picker response.");
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testBrowserAddressFocus();
