import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { editPaneAddress } from "./pane-address-smoke.mjs";

const front = {
  "01-alpha.txt": "Text from the left pane.",
  "02-beta.txt": "Another file on the left.",
  "03-guide.md": "# Markdown heading\n\n- [ ] A read-only task",
  "04-page.html": '<h1 style="color: rgb(34, 85, 102)">HTML heading</h1><a href="https://external.invalid/link">A link</a>' +
    '<img src="https://external.invalid/pixel"><script>document.querySelector("h1").textContent = "Script ran";</script>',
  "05-image.png": null,
  "06-binary.bin": null,
};
const back = {
  "01-another.txt": "First file on the right.",
  "02-remember.txt": "Selected file on the right.",
};
const toolbar = (page) => page.locator(".top-actions");
const toggle = (page) => toolbar(page).getByRole("button", { name: "Quick View", exact: true });
const list = (page, side) => page.getByRole("listbox", { name: side + " files", exact: true });
const row = (page, side, name) => list(page, side).locator('.file-row[data-tooltip="' + name + '"]');
const preview = (page, side) => page.locator(".quick-view-" + side);
const control = (surface, name) => surface.getByRole("button", { name, exact: true });

async function pngFixture(page) {
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 520;
    canvas.height = 260;
    const context = canvas.getContext("2d");
    context.fillStyle = "#25aac4";
    context.fillRect(0, 0, 520, 260);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  return Buffer.from(encoded, "base64");
}

async function assertDivider(page, side) {
  const source = list(page, side);
  const target = preview(page, side === "left" ? "right" : "left");
  const divider = page.getByRole("separator", { name: "Pane divider", exact: true });
  const widths = async () => [
    (await page.locator("#" + side + "-pane").boundingBox()).width,
    (await target.boundingBox()).width,
  ];
  const initial = Number(await divider.getAttribute("aria-valuenow"));
  const [initialSource, initialTarget] = await widths();
  await source.focus();
  await page.keyboard.press("Control+ArrowLeft");
  await page.waitForFunction((value) => document.querySelector(".pane-divider").getAttribute("aria-valuenow") === String(value), initial - 1);
  const [movedSource, movedTarget] = await widths();
  assert.equal(movedSource < initialSource, side === "left");
  assert.equal(movedTarget < initialTarget, side === "right");
  await page.keyboard.press("Control+ArrowRight");
  await page.waitForFunction((value) => document.querySelector(".pane-divider").getAttribute("aria-valuenow") === String(value), initial);
  if (await page.evaluate(() => /Macintosh/.test(navigator.userAgent))) {
    await page.keyboard.press("Meta+ArrowLeft");
    await page.waitForFunction((value) => document.querySelector(".pane-divider").getAttribute("aria-valuenow") === String(value), initial - 1);
    await page.keyboard.press("Meta+ArrowRight");
    await page.waitForFunction((value) => document.querySelector(".pane-divider").getAttribute("aria-valuenow") === String(value), initial);
  }
}

async function checkViews(page) {
  const swap = await page.evaluate(() => /Mac/i.test(navigator.userAgent) ? "Meta+u" : "Control+u");
  const heading = (name) => preview(page, "right").getByRole("heading", { name, exact: true });
  const sourceButton = control(toolbar(page), "Source");
  const renderButton = control(toolbar(page), "Rendered");
  await row(page, "right", "02-remember.txt").click().catch(async (error) => {
    throw new Error(await page.locator("body").innerText(), { cause: error });
  });
  const path = await page.locator("#right-path").getAttribute("data-path");
  await row(page, "left", "01-alpha.txt").click();
  await page.keyboard.press("Control+q");
  await preview(page, "right").getByText(front["01-alpha.txt"], { exact: true }).waitFor();
  assert.equal(await toggle(page).getAttribute("aria-pressed"), "true");
  assert.equal(await list(page, "right").count(), 0);
  await page.keyboard.press("ArrowDown");
  await preview(page, "right").getByText(front["02-beta.txt"], { exact: true }).waitFor();
  await list(page, "left").press(swap);
  await preview(page, "left").getByText(front["02-beta.txt"], { exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.id === "right-files");
  await list(page, "right").press(swap);
  await preview(page, "right").getByText(front["02-beta.txt"], { exact: true }).waitFor();
  await assertDivider(page, "left");
  assert.equal(await preview(page, "right").getByText(front["02-beta.txt"], { exact: true }).isVisible(), true);
  await page.keyboard.press("Tab");
  assert.equal(await list(page, "left").evaluate((node) => node === document.activeElement), true);
  await page.keyboard.press("Control+q");
  await list(page, "right").waitFor();
  assert.equal(await toggle(page).getAttribute("aria-pressed"), "false");
  assert.equal(await page.locator("#right-path").getAttribute("data-path"), path);
  assert.equal(await row(page, "right", "02-remember.txt").getAttribute("data-current"), "true");

  await row(page, "right", "01-another.txt").click();
  await toggle(page).click();
  await preview(page, "left").getByText(back["01-another.txt"], { exact: true }).waitFor();
  await assertDivider(page, "right");
  await page.keyboard.press("ArrowDown");
  await preview(page, "left").getByText(back["02-remember.txt"], { exact: true }).waitFor();
  await row(page, "right", "01-another.txt").click();
  await preview(page, "left").getByText(back["01-another.txt"], { exact: true }).waitFor();
  await toggle(page).click();
  assert.equal(await row(page, "left", "02-beta.txt").getAttribute("data-current"), "true");

  await row(page, "left", "03-guide.md").click();
  await page.keyboard.press("Control+q");
  await heading("Markdown heading").waitFor();
  assert.equal(await preview(page, "right").getByRole("checkbox").isDisabled(), true);
  await sourceButton.click();
  await preview(page, "right").locator("pre").getByText("# Markdown heading", { exact: false }).waitFor();
  assert.equal(await sourceButton.getAttribute("aria-pressed"), "true");
  await renderButton.click();
  await heading("Markdown heading").waitFor();

  await row(page, "left", "04-page.html").click();
  const frame = preview(page, "right").frameLocator("iframe");
  const htmlHeading = frame.getByRole("heading", { name: "HTML heading", exact: true });
  await htmlHeading.waitFor();
  assert.equal(await htmlHeading.evaluate((element) => getComputedStyle(element).color), "rgb(34, 85, 102)");
  assert.equal(await frame.getByText("A link", { exact: true }).getAttribute("href"), null);
  assert.equal(await preview(page, "right").locator("iframe").getAttribute("sandbox"), "");
  await htmlHeading.click();
  await page.waitForFunction(() => document.activeElement?.id === "left-files");
  await sourceButton.click();
  await preview(page, "right").locator("pre").getByText("<script>", { exact: false }).waitFor();
  await renderButton.click();
  await htmlHeading.waitFor();

  await row(page, "left", "05-image.png").click();
  const right = preview(page, "right");
  const image = right.getByRole("img", { name: "05-image.png", exact: true });
  await image.waitFor();
  const imageWidth = async () => (await image.boundingBox()).width;
  const fitted = await imageWidth();
  await control(right, "Zoom in").click();
  assert.ok(await imageWidth() > fitted);
  await control(right, "Zoom out").click();
  assert.ok(Math.abs(await imageWidth() - fitted) < 1);
  await control(right, "Rotate clockwise").click();
  assert.equal(await image.evaluate((element) => element.style.transform.endsWith("rotate(90deg)")), true);
  await control(right, "Fit to pane").click();
  await control(right, "Rotate counterclockwise").click();
  assert.ok(Math.abs(await imageWidth() - fitted) < 1);
  assert.equal(await image.evaluate((element) => element.style.transform.endsWith("rotate(0deg)")), true);

  await row(page, "left", "folder").click();
  await right.getByText("Folders cannot be previewed.", { exact: true }).waitFor();
  assert.equal(await image.count(), 0);
  await row(page, "left", "06-binary.bin").click();
  await right.getByText("This file type cannot be previewed.", { exact: true }).waitFor();
  await page.keyboard.press("Control+q");
  await right.waitFor({ state: "hidden" });
}

export async function testNativeQuickView(page, root) {
  const left = join(root, "quick-view-left");
  const right = join(root, "quick-view-right");
  await mkdir(left);
  await mkdir(right);
  await mkdir(join(left, "folder"));
  const png = await pngFixture(page);
  const image = join(left, "05-image.png");
  for (const [name, text] of Object.entries(front)) {
    await writeFile(join(left, name), name === "05-image.png" ? png : text ?? Buffer.from([0, 1, 2]));
  }
  for (const [name, text] of Object.entries(back)) await writeFile(join(right, name), text);
  for (const [side, path] of [["left", left], ["right", right]]) {
    const address = await editPaneAddress(page, side);
    await address.fill(path);
    await address.press("Enter");
    await row(page, side, side === "left" ? "01-alpha.txt" : "01-another.txt").waitFor();
    const sort = await page.evaluate((side) => JSON.parse(localStorage.getItem("dirlume.workspace.v1")).panels[side].sort, side);
    if (sort.column !== "name" || !sort.asc) await list(page, side).press("Control+F3");
  }
  await checkViews(page);
  assert.deepEqual(await readFile(image), png);
  console.log("Verified native Windows Quick View for text, Markdown, sandboxed HTML and image files in both panes.");
}

export async function testBrowserQuickView(userAgent) {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({ userAgent, viewport: { width: 1020, height: 720 } });
    page.setDefaultTimeout(8000);
    page.on("pageerror", (error) => console.error(error));
    const png = [...await pngFixture(page)];
    let externalRequests = 0;
    await page.route("https://external.invalid/**", (route) => { externalRequests++; return route.abort(); });
    await page.route("http://dirlume.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    await page.addInitScript(({ front, back, png }) => {
      if (location.hostname !== "dirlume.test") return;
      const path = /Windows/i.test(navigator.userAgent) ? "C:\\fixture\\" : "/fixture/";
      const panel = (name) => ({ place: { kind: "local", path: path + name, parent: null } });
      localStorage.setItem("dirlume.workspace.v1", JSON.stringify({
        panels: { left: panel("left"), right: panel("right") }, active: "left", split: 50, documents: [],
      }));
      const file = (name) => ({ name, directory: name === "folder", link: false, size: 12, modified: null });
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args) => {
          if (command === "locations") return [{ label: "Home", path: path + "left" }];
          if (command === "list_directory") return {
            path: args.path, parent: null, omitted: 0,
            entries: Object.keys(args.path.endsWith("left") ? { ...front, folder: null, "07-slow.txt": "", "08-unreadable.txt": "" } : back).map(file),
          };
          if (command === "read_text") {
            if (args.name === "06-binary.bin") throw "The file contains binary data.";
            if (args.name === "08-unreadable.txt") throw "Permission denied";
            if (args.name === "07-slow.txt") {
              await new Promise((wait) => { window.finishOldRead = wait; });
              return { text: "Outdated contents", encoding: "utf8" };
            }
            return { text: (args.directory.endsWith("left") ? front : back)[args.name], encoding: "utf8" };
          }
          if (command === "read_preview_image") return new Uint8Array(png).buffer;
          if (command === "file_icons") return [];
          return null;
        },
      };
    }, { front, back, png });
    await page.goto("http://dirlume.test/");
    await checkViews(page);
    assert.equal(externalRequests, 0);

    await row(page, "left", "07-slow.txt").click();
    await toggle(page).click();
    await page.waitForFunction(() => typeof window.finishOldRead === "function");
    await row(page, "left", "08-unreadable.txt").click();
    const right = preview(page, "right");
    await right.getByText("Could not read this file: Permission denied", { exact: true }).waitFor();
    await page.evaluate(() => window.finishOldRead());
    assert.equal(await right.getByText("Outdated contents", { exact: true }).count(), 0);
    assert.equal(await right.getByText("Could not read this file: Permission denied", { exact: true }).isVisible(), true);
    await toggle(page).click();

    await page.getByRole("button", { name: "Options", exact: true }).click();
    const options = page.getByRole("dialog", { name: "Options", exact: true });
    const mac = await page.evaluate(() => /Macintosh/.test(navigator.userAgent));
    const initial = mac ? "⌃Q" : "Ctrl+Q";
    const replacement = mac ? "⌃⌥Q" : "Ctrl+Alt+Q";
    await control(options, "Keyboard shortcuts").click();
    await control(options, "Change " + initial + " for Quick View").click();
    await options.getByRole("textbox", { name: "New shortcut to replace " + initial + " for Quick View", exact: true }).press("Control+Alt+q");
    await control(options, "Done").click();
    await row(page, "left", "01-alpha.txt").click();
    await page.keyboard.press("Control+q");
    assert.equal(await toggle(page).getAttribute("aria-pressed"), "false");
    await page.keyboard.press("Control+Alt+q");
    await right.getByText(front["01-alpha.txt"], { exact: true }).waitFor();
    await toggle(page).click();
    await page.getByRole("button", { name: "Options", exact: true }).click();
    await control(options, "Keyboard shortcuts").click();
    await control(options, "Remove " + replacement + " from Quick View").click();
    await control(options, "Done").click();
    await list(page, "left").focus();
    await page.keyboard.press("Control+Alt+q");
    assert.equal(await toggle(page).getAttribute("aria-pressed"), "false");
    await toggle(page).click();
    await right.getByText(front["01-alpha.txt"], { exact: true }).waitFor();
    console.log("Verified both Quick View directions, browsing state, divider, read-only formats, stale reads, and remappable shortcuts.");
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testBrowserQuickView();
