import assert from "node:assert/strict";
import { mkdir, open, readFile, utimes, writeFile } from "node:fs/promises";
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
  "09-large.exe": null,
  "10-utf16.txt": "UTF-16 file remains readable.",
  "11-large-text.txt": null,
  "12-middle.png": null,
  "13-last.png": null,
  "14-first.png": null,
  "15-corrupt.png": null,
};
const binaryHeader = [0x4d, 0x5a, 0, 1, 9, 13, 10, 0xb3, 46, 116, 101, 120, 116];
const largeBytes = 9 * 1024 * 1024 + 3;
const middleByte = 16389;
const middleMarker = "MID";
const endMarker = "END";
const back = {
  "01-another.txt": "First file on the right.",
  "02-remember.txt": "Selected file on the right.",
  "03-right.png": null,
};
const viewerOrder = ["14-first.png", "12-middle.png", "13-last.png", "15-corrupt.png", "05-image.png"];
const modified = (name) => Date.UTC(2025, 0, 1, 0, 0, viewerOrder.length - viewerOrder.indexOf(name));
const toolbar = (page) => page.locator(".top-actions");
const toggle = (page) => toolbar(page).getByRole("button", { name: "Quick View", exact: true });
const list = (page, side) => page.getByRole("listbox", { name: side + " files", exact: true });
const row = (page, side, name) => list(page, side).locator('.file-row[data-tooltip="' + name + '"]');
const preview = (page, side) => page.locator(".quick-view-" + side);
const control = (surface, name) => surface.getByRole("button", { name, exact: true });

async function pngFixture(page, width = 520, height = 260) {
  const encoded = await page.evaluate(({ width, height }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.fillStyle = "#25aac4";
    context.fillRect(0, 0, width, height);
    return canvas.toDataURL("image/png").split(",")[1];
  }, { width, height });
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
  const dump = right.getByLabel("Binary contents", { exact: true });
  const firstRow = dump.locator('[data-byte-offset="0"]');
  await firstRow.waitFor();
  assert.deepEqual(await firstRow.locator("span").allTextContents(), ["M", "Z", " ", "☺", "○", "♪", "◙", "│", ".", "t", "e", "x", "t"]);
  assert.equal(await list(page, "left").evaluate((node) => node === document.activeElement), true);
  await row(page, "left", "09-large.exe").click();
  await firstRow.getByText("M", { exact: true }).waitFor();
  await dump.evaluate((element, { size, position }) => {
    const row = element.querySelector(".binary-preview-row");
    const rows = Math.ceil(size / row.children.length);
    const rowHeight = row.getBoundingClientRect().height;
    const logical = Math.floor(position / row.children.length) * rowHeight;
    element.scrollTop = logical / (rows * rowHeight - element.clientHeight) * (element.scrollHeight - element.clientHeight);
  }, { size: largeBytes, position: middleByte });
  const readAt = (start, text) => page.waitForFunction(({ start, text }) => {
    const cells = [...document.querySelectorAll(".binary-preview-row")].flatMap((row) => {
      const first = Number(row.dataset.byteOffset);
      return [...row.children].map((span, index) => [first + index, span.textContent]);
    });
    return cells.filter(([offset]) => offset >= start && offset < start + text.length).map(([, value]) => value).join("") === text;
  }, { start, text });
  await readAt(middleByte, middleMarker);
  await dump.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await readAt(largeBytes - endMarker.length, endMarker);
  await row(page, "left", "10-utf16.txt").click();
  await right.getByText(front["10-utf16.txt"], { exact: true }).waitFor();
  await dump.waitFor({ state: "hidden" });
  await row(page, "left", "11-large-text.txt").click();
  await right.getByText("Could not read this file: Text files can be at most 8 MiB.", { exact: true }).waitFor();
  assert.equal(await dump.count(), 0);
  await page.keyboard.press("Control+q");
  await right.waitFor({ state: "hidden" });
}

async function checkImageDocuments(page) {
  const document = page.locator(".image-document:not([hidden])");
  const image = (name) => document.getByRole("img", { name, exact: true });
  const heading = (name) => document.getByRole("heading", { name, exact: true });
  const nav = (name) => control(document, name);
  const open = async (side, name) => {
    await row(page, side, name).click();
    await list(page, side).press("F3");
    await heading(name).waitFor();
  };
  await row(page, "left", "12-middle.png").click();
  await list(page, "left").press("Control+F5");
  await open("left", "12-middle.png");
  await document.getByText("1,600 × 900 px", { exact: true }).waitFor();
  const fit = (await image("12-middle.png").boundingBox()).width;
  assert.ok(fit < 1600);
  await nav("Actual size").click();
  assert.equal(Math.round((await image("12-middle.png").boundingBox()).width), 1600);
  const viewport = document.locator(".quick-view-image-canvas");
  const scroll = () => viewport.evaluate((element) => ({ x: element.scrollLeft, y: element.scrollTop,
    maxX: element.scrollWidth - element.clientWidth, maxY: element.scrollHeight - element.clientHeight }));
  const before = await scroll();
  const rect = await viewport.boundingBox();
  const dx = before.x < before.maxX / 2 ? -96 : 96;
  const dy = before.y < before.maxY / 2 ? -64 : 64;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + dx, rect.y + rect.height / 2 + dy, { steps: 4 });
  await page.mouse.up();
  const after = await scroll();
  assert.ok((after.x - before.x) * dx < 0 && (after.y - before.y) * dy < 0,
    JSON.stringify({ before, after, rect }));
  const pointer = { x: rect.x + rect.width * 0.43, y: rect.y + rect.height * 0.42 };
  const imagePoint = (bounds) => ({ x: (pointer.x - bounds.x) / bounds.width, y: (pointer.y - bounds.y) / bounds.height });
  const original = imagePoint(await image("12-middle.png").boundingBox());
  await page.mouse.move(pointer.x, pointer.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await document.getByText("125%", { exact: true }).waitFor();
  const zoomed = imagePoint(await image("12-middle.png").boundingBox());
  assert.ok(Math.abs(original.x - zoomed.x) < 0.002 && Math.abs(original.y - zoomed.y) < 0.002);
  await nav("Fit").click();
  await page.waitForFunction((initial) => Math.abs(document.querySelector(".image-document:not([hidden]) img").getBoundingClientRect().width - initial) < 1, fit);
  await nav("Next image").click();
  await image("13-last.png").waitFor();
  assert.equal(await page.getByRole("navigation", { name: "Open documents", exact: true }).getByRole("button", { name: /^View / }).count(), 1);
  await document.press("ArrowLeft");
  await image("12-middle.png").waitFor();
  await document.press("ArrowLeft");
  await image("14-first.png").waitFor();
  assert.equal(await nav("Previous image").isDisabled(), true);
  for (const name of ["12-middle.png", "13-last.png", "15-corrupt.png"]) {
    await document.press("ArrowRight");
    await heading(name).waitFor();
  }
  await document.getByText("Could not display this image.", { exact: true }).waitFor();
  assert.equal(await image("13-last.png").count(), 0);
  await document.press("F4");
  await document.getByLabel("Hexadecimal contents").waitFor();
  await document.press("F4");
  await document.getByText("Could not display this image.", { exact: true }).waitFor();
  await document.press("ArrowRight");
  await image("05-image.png").waitFor();
  assert.equal(await nav("Next image").isDisabled(), true);
  await document.press("ArrowLeft");
  await heading("15-corrupt.png").waitFor();
  await document.press("Escape");
  await page.waitForFunction(() => document.activeElement?.id === "left-files");
  assert.equal(await row(page, "left", "15-corrupt.png").getAttribute("data-current"), "true");
  await list(page, "left").press("Control+F5");
  const pane = page.locator("#left-pane");
  await control(pane, "Filter folder").click();
  await pane.getByRole("textbox", { name: "Filter left folder", exact: true }).fill("1");
  await open("left", "15-corrupt.png");
  assert.equal(await nav("Previous image").isDisabled(), true);
  for (const name of ["13-last.png", "12-middle.png", "14-first.png"]) {
    await document.press("ArrowRight");
    await image(name).waitFor();
  }
  assert.equal(await nav("Next image").isDisabled(), true);
  await document.press("Escape");
  await control(pane, "Close filter").click();
  await open("right", "03-right.png");
  await image("03-right.png").waitFor();
  assert.equal(await nav("Previous image").isDisabled(), true);
  assert.equal(await nav("Next image").isDisabled(), true);
  await document.press("F10");
  await page.waitForFunction(() => document.activeElement?.id === "right-files");
}

async function checkImageEditor(page, side, name, capture = false) {
  const editor = page.locator(".image-editor:not([hidden])");
  const viewer = page.locator(".image-document:not(.image-editor):not([hidden])");
  const size = (node, value) => node.getByText(value + " px", { exact: true }).waitFor();
  const field = (name) => editor.getByRole("spinbutton", { name, exact: true });
  await row(page, side, name).click();
  await list(page, side).press("F4");
  await size(editor, "1,200 × 800");
  await editor.press("]");
  await size(editor, "800 × 1,200");
  await control(editor, "Crop").click();
  const overlay = editor.locator(".image-crop-overlay");
  const frame = await overlay.boundingBox();
  const screen = (x, y) => [frame.x + x * frame.width / 800, frame.y + y * frame.height / 1200];
  await page.mouse.move(...screen(20, 20));
  await page.mouse.down();
  await page.mouse.move(...screen(200, 150), { steps: 5 });
  await page.mouse.up();
  assert.ok(Math.abs(Number(await field("Crop width").inputValue()) - 180) <= 2);
  assert.ok(Math.abs(Number(await field("Crop height").inputValue()) - 130) <= 2);
  await page.mouse.move(...screen(100, 80));
  await page.mouse.down();
  await page.mouse.move(...screen(132, 117), { steps: 5 });
  await page.mouse.up();
  assert.ok(Math.abs(Number(await field("Crop left").inputValue()) - 52) <= 2);
  assert.ok(Math.abs(Number(await field("Crop top").inputValue()) - 57) <= 2);
  const ratio = editor.getByRole("combobox", { name: "Aspect ratio", exact: true });
  await ratio.selectOption("Custom");
  await field("Ratio width").fill("5");
  await field("Ratio height").fill("4");
  await control(editor, "Swap aspect ratio").click();
  await field("Crop width").fill("400");
  assert.equal(await field("Crop height").inputValue(), "500");
  await ratio.selectOption("16:9");
  await field("Crop width").fill("720");
  await field("Crop left").fill("50");
  await field("Crop top").fill("30");
  assert.equal(await field("Crop left").inputValue(), "50");
  assert.equal(await field("Crop top").inputValue(), "30");
  assert.equal(await field("Crop height").inputValue(), "405");
  await control(editor, "Actual size").click();
  assert.equal(await field("Crop width").inputValue(), "720");
  assert.equal(await field("Crop height").inputValue(), "405");
  await control(editor, "Fit").click();
  if (capture) await page.screenshot({ path: process.env.DIRLUME_IMAGE_EDIT_CAPTURE });
  await control(editor, "Apply crop").click();
  await size(editor, "720 × 405");
  await control(editor, "Undo").click();
  await size(editor, "800 × 1,200");
  await control(editor, "Redo").click();
  await size(editor, "720 × 405");
  await control(editor, "Crop").click();
  await control(editor, "Cancel crop").click();
  await size(editor, "720 × 405");
  await editor.press("F6");
  await size(viewer, "1,200 × 800");
  await viewer.press("F4");
  await viewer.getByLabel("Hexadecimal contents").waitFor();
  await viewer.press("F6");
  await size(editor, "720 × 405");
  await editor.press("Escape");
  const unsaved = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
  await control(unsaved, "Cancel").click();
  await size(editor, "720 × 405");
  return editor;
}

async function checkNativeImageEdits(page, directory) {
  const name = "image-edit.png";
  const source = join(directory, name);
  const original = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 800;
    const context = canvas.getContext("2d");
    context.fillStyle = "#18a0b4";
    context.fillRect(0, 0, 1200, 800);
    context.fillStyle = "#e64930";
    context.fillRect(30, 730, 16, 20);
    return canvas.toDataURL("image/png").split(",")[1];
  }), "base64");
  await writeFile(source, original);
  const collision = join(directory, "image-edit-edited.png");
  await writeFile(collision, "existing file");
  await control(page.locator("#left-pane"), "Refresh folder").click();
  const editor = await checkImageEditor(page, "left", name, Boolean(process.env.DIRLUME_IMAGE_EDIT_CAPTURE));
  assert.deepEqual(await readFile(source), original);
  await control(editor, "Save a copy").click();
  const copyDialog = page.getByRole("dialog", { name: "Save a copy", exact: true });
  const save = () => control(copyDialog, "Save a copy").click();
  assert.equal(await copyDialog.getByRole("combobox", { name: "File destination", exact: true }).inputValue(), collision);
  await save();
  await copyDialog.getByRole("alert").getByText("A file already exists at that path. Choose a new file name.").waitFor();
  const target = join(directory, "crop-saved.png");
  await copyDialog.getByRole("combobox", { name: "File destination", exact: true }).fill(target);
  await save();
  await copyDialog.waitFor({ state: "hidden" });
  assert.equal(await readFile(collision, "utf8"), "existing file");
  assert.deepEqual(await readFile(source), original);
  const decoded = await page.evaluate(async (encoded) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    return [bitmap.width, bitmap.height, ...context.getImageData(0, 0, 1, 1).data];
  }, (await readFile(target)).toString("base64"));
  assert.deepEqual(decoded, [720, 405, 230, 73, 48, 255]);
  await control(editor, "Rotate right").click();
  const replace = page.getByRole("dialog", { name: "Replace original", exact: true });
  await control(editor, "Replace original").click();
  await replace.getByText(/camera and color profile metadata may be lost/).waitFor();
  await writeFile(source, "external change");
  await control(replace, "Replace original").click();
  await replace.getByRole("alert").getByText("The original image changed on disk. You can still save a copy.").waitFor();
  await control(replace, "Cancel").click();
  const unsaved = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "main" }));
  await control(unsaved, "Cancel").click();
  await editor.press("Escape");
  await control(unsaved, "Save a copy").click();
  const recovery = join(directory, "crop-recovered.png");
  await copyDialog.getByRole("combobox", { name: "File destination", exact: true }).fill(recovery);
  await save();
  await editor.waitFor({ state: "hidden" });
  assert.equal(await readFile(source, "utf8"), "external change");
  assert.ok((await readFile(recovery)).length > 0);
  await row(page, "left", "crop-saved.png").click();
  await list(page, "left").press("F3");
  const viewer = page.locator(".image-document:not(.image-editor):not([hidden])");
  await viewer.getByText("720 × 405 px", { exact: true }).waitFor();
  await viewer.press("F6");
  await editor.getByText("720 × 405 px", { exact: true }).waitFor();
  await control(editor, "Rotate right").click();
  await control(editor, "Replace original").click();
  await control(replace, "Replace original").click();
  await replace.waitFor({ state: "hidden" });
  await control(editor, "Rotate right").waitFor();
  await editor.press("F6");
  await viewer.getByText("405 × 720 px", { exact: true }).waitFor();
  await viewer.press("F10");
  console.log("Verified image crop, rotation, draft mode switches, save collisions and external changes in the Windows editor.");
}

export async function testNativeQuickView(page, root) {
  const left = join(root, "quick-view-left");
  const right = join(root, "quick-view-right");
  await mkdir(left);
  await mkdir(right);
  await mkdir(join(left, "folder"));
  const png = await pngFixture(page);
  const largePng = await pngFixture(page, 1600, 900);
  const image = join(left, "05-image.png");
  for (const [name, text] of Object.entries(front)) {
    const path = join(left, name);
    if (name === "11-large-text.txt") {
      await writeFile(path, Buffer.alloc(largeBytes, 65));
      continue;
    }
    if (name === "09-large.exe") {
      const file = await open(path, "w");
      try {
        await file.truncate(largeBytes);
        await file.write(Buffer.from(binaryHeader), 0, binaryHeader.length, 0);
        await file.write(middleMarker, middleByte);
        await file.write(endMarker, largeBytes - endMarker.length);
      } finally { await file.close(); }
      continue;
    }
    const value = name === "05-image.png" ? png : name === "15-corrupt.png" ? "Invalid image" :
      name.endsWith(".png") ? largePng : name === "10-utf16.txt" ? Buffer.from("\ufeff" + text, "utf16le") : text ?? Buffer.from(binaryHeader);
    await writeFile(path, value);
    if (viewerOrder.includes(name)) await utimes(path, new Date(modified(name)), new Date(modified(name)));
  }
  for (const [name, text] of Object.entries(back)) await writeFile(join(right, name), text ?? largePng);
  for (const [side, path] of [["left", left], ["right", right]]) {
    const address = await editPaneAddress(page, side);
    await address.fill(path);
    await address.press("Enter");
    await row(page, side, side === "left" ? "01-alpha.txt" : "01-another.txt").waitFor();
    const sort = await page.evaluate((side) => JSON.parse(localStorage.getItem("dirlume.workspace.v1")).panels[side].sort, side);
    if (sort.column !== "name" || !sort.asc) await list(page, side).press("Control+F3");
  }
  await checkViews(page);
  await checkImageDocuments(page);
  assert.deepEqual(await readFile(image), png);
  await checkNativeImageEdits(page, left);
  console.log("Verified native Windows Quick View for text, Markdown, sandboxed HTML and image files in both panes.");
}

export async function testBrowserQuickView(userAgent) {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({ userAgent, viewport: { width: 1020, height: 720 } });
    page.setDefaultTimeout(8000);
    page.on("pageerror", (error) => console.error(error));
    const png = [...await pngFixture(page)];
    const largePng = [...await pngFixture(page, 1600, 900)];
    const editPng = [...await pngFixture(page, 1200, 800)];
    let externalRequests = 0;
    await page.route("https://external.invalid/**", (route) => { externalRequests++; return route.abort(); });
    await page.route("http://dirlume.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    await page.addInitScript(({ front, back, png, largePng, editPng, imageTimes, binaryHeader, largeBytes, middleByte, middleMarker, endMarker }) => {
      if (location.hostname !== "dirlume.test") return;
      const path = /Windows/i.test(navigator.userAgent) ? "C:\\fixture\\" : "/fixture/";
      const panel = (name) => ({ place: { kind: "local", path: path + name, parent: null } });
      localStorage.setItem("dirlume.workspace.v1", JSON.stringify({
        panels: { left: panel("left"), right: panel("right") }, active: "left", split: 50, documents: [],
      }));
      const file = (name) => ({ name, directory: name === "folder", link: false, size: 12, modified: imageTimes[name] ?? null });
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args) => {
          if (command === "locations") return [{ label: "Home", path: path + "left" }];
          if (command === "list_directory") return {
            path: args.path, parent: null, omitted: 0,
            entries: Object.keys(args.path.endsWith("left") ? { ...front, folder: null, "07-slow.txt": "", "08-unreadable.txt": "",
              ...(window.useEditorFixture ? { "image-edit.png": null } : {}) } : back).map(file),
          };
          if (command === "read_text") {
            if (args.name === "06-binary.bin") throw "The file contains binary data.";
            if (args.name === "09-large.exe" || args.name === "11-large-text.txt") throw "Text files can be at most 8 MiB.";
            if (args.name === "08-unreadable.txt") throw "Permission denied";
            if (args.name === "07-slow.txt") {
              await new Promise((wait) => { window.finishOldRead = wait; });
              return { text: "Outdated contents", encoding: "utf8" };
            }
            return { text: (args.directory.endsWith("left") ? front : back)[args.name], encoding: "utf8" };
          }
          if (command === "read_bytes") {
            if (args.name === "06-binary.bin") return { length: binaryHeader.length, data: binaryHeader };
            if (args.name === "11-large-text.txt") return { length: largeBytes, data: Array(1024).fill(65) };
            const blocks = [[0, binaryHeader], [middleByte, [...middleMarker].map((char) => char.charCodeAt(0))],
              [largeBytes - endMarker.length, [...endMarker].map((char) => char.charCodeAt(0))]];
            return { length: largeBytes, data: Array.from({ length: Math.min(1024, largeBytes - args.offset) }, (_, index) => {
              const offset = args.offset + index;
              const block = blocks.find(([start, bytes]) => offset >= start && offset < start + bytes.length);
              return block ? block[1][offset - block[0]] : 0;
            }) };
          }
          if (command === "read_preview_image") {
            const name = args.source.name;
            return new Uint8Array(name === "05-image.png" ? png : name === "15-corrupt.png" ? [0, 1] : name === "image-edit.png" ? editPng : largePng).buffer;
          }
          if (command === "open_image_edit") return { id: "edit", width: 1200, height: 800, canReplace: true };
          if (command === "read_image_edit") return new Uint8Array(editPng).buffer;
          if (command === "file_icons") return [];
          return null;
        },
      };
    }, { front, back, png, largePng, editPng, imageTimes: Object.fromEntries(viewerOrder.map((name) => [name, modified(name)])),
      binaryHeader, largeBytes, middleByte, middleMarker, endMarker });
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
    await checkImageDocuments(page);
    await page.evaluate(() => { window.useEditorFixture = true; });
    await control(page.locator("#left-pane"), "Refresh folder").click();
    const editor = await checkImageEditor(page, "left", "image-edit.png");
    await editor.press("Escape");
    await control(page.getByRole("dialog", { name: "Unsaved changes", exact: true }), "Discard").click();
    await editor.waitFor({ state: "hidden" });

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
    console.log("Verified both Quick View directions, read-only formats, stale reads, remappable shortcuts, and Image Viewer navigation and zoom.");
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testBrowserQuickView();
