import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const wide = ["sequenceDiagram", ...Array.from({ length: 12 }, (_, i) => `participant P${i} as Participant ${i}`), "P0->>P11: Wide diagram"];
const tall = ["flowchart TD", ...Array.from({ length: 24 }, (_, i) => `N${i}[Step ${i}] --> N${i + 1}`)];
const mermaid = (lines) => ["```mermaid", ...lines, "```", ""].join("\n");
export const diagramFixture = ["# Diagram zoom", "", mermaid(wide), mermaid(tall), mermaid(["Not a Mermaid diagram"])].join("\n");
const button = (parent, name) => parent.getByRole("button", { name, exact: true });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1, `${actual} vs ${expected}`);

export async function verifyMermaidZoom(page, { setWheelBinding, setDefaultScale, reopen, resize }) {
  const viewer = page.getByRole("region", { name: "diagrams.md", exact: true });
  const surface = viewer.locator(".markdown");
  const images = surface.getByRole("img", { name: "Mermaid diagram", exact: true });
  const tools = surface.locator(".mermaid-tools");
  const open = surface.getByRole("button", { name: "Open in new window", exact: true });
  await images.nth(1).waitFor();
  await surface.getByRole("alert").waitFor();
  assert.equal(await open.count(), 2);

  const measure = () => surface.evaluate((element) => ({
    font: parseFloat(getComputedStyle(element).fontSize),
    diagrams: Array.from(element.querySelectorAll("img.mermaid-diagram"), (image) => {
      const { width, height } = image.getBoundingClientRect();
      return { width, height, originalWidth: Number(image.getAttribute("width")), originalHeight: Number(image.getAttribute("height")) };
    }),
  }));
  const initial = await measure();
  for (const { width, height, originalWidth, originalHeight } of initial.diagrams) {
    near(width, originalWidth);
    near(height, originalHeight);
  }
  assert.equal(await images.first().evaluate((image) => image.src.startsWith("data:image/svg+xml")), true);
  const rightEdge = await images.first().locator("..").evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    return {
      scrollLeft: element.scrollLeft,
      imageRight: element.querySelector("img").getBoundingClientRect().right,
      visibleRight: element.getBoundingClientRect().left + element.clientLeft + element.clientWidth,
    };
  });
  assert.ok(rightEdge.scrollLeft > 0 && rightEdge.imageRight <= rightEdge.visibleRight + 1, JSON.stringify(rightEdge));
  assert.ok(await images.nth(1).evaluate((image) => {
    const surface = image.closest(".markdown");
    surface.scrollTop = surface.scrollHeight;
    return image.getBoundingClientRect().bottom <= surface.getBoundingClientRect().bottom &&
      image.height > surface.clientHeight;
  }));

  if (setDefaultScale) {
    await setDefaultScale("150");
    if (reopen) await reopen();
    await images.nth(1).waitFor();
    const larger = await measure();
    near(larger.diagrams[0].width, initial.diagrams[0].width * 1.5);
    near(larger.diagrams[1].height, initial.diagrams[1].height * 1.5);
    assert.equal(larger.font, initial.font);
    await setDefaultScale("");
    const reset = await measure();
    near(reset.diagrams[0].width, initial.diagrams[0].width);
  }

  const inlineIn = button(tools.first(), "Zoom in");
  const inlineOut = button(tools.first(), "Zoom out");
  const inlineReset = button(tools.first(), "Reset diagram zoom");
  await inlineOut.press("Enter");
  near((await measure()).diagrams[0].width, initial.diagrams[0].width / 1.25);
  await inlineIn.press("Enter");
  await inlineIn.press("Enter");
  const adjusted = await measure();
  near(adjusted.diagrams[0].width, initial.diagrams[0].width * 1.25);
  near(adjusted.diagrams[1].height, initial.diagrams[1].height);
  assert.equal(adjusted.font, initial.font);

  const wheel = (target, modifier, repeat = 1) => target.evaluate((element, { modifier, repeat }) => {
    for (let i = 0; i < repeat; i++) element.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, deltaY: -120, ctrlKey: modifier === "Control", altKey: modifier === "Alt",
    }));
  }, { modifier, repeat });
  const waitForFont = (font) => page.waitForFunction((previous) =>
    parseFloat(getComputedStyle(document.querySelector(".text-window:not([hidden]) .markdown")).fontSize) > previous, font);
  await wheel(images.first(), "Control", 3);
  await waitForFont(initial.font);
  const enlarged = await measure();
  const sharedScale = enlarged.font / initial.font;
  near(enlarged.diagrams[0].width, adjusted.diagrams[0].width * sharedScale);
  near(enlarged.diagrams[1].height, initial.diagrams[1].height * sharedScale);
  await inlineReset.press("Enter");
  const reset = await measure();
  near(reset.diagrams[0].width, initial.diagrams[0].width * sharedScale);
  near(reset.diagrams[1].height, enlarged.diagrams[1].height);

  async function openDiagram(index, action) {
    const [popup] = await Promise.all([page.context().waitForEvent("page", { timeout: 12000 }), action()]);
    const dialog = popup.getByRole("dialog", { name: "Mermaid diagram", exact: true });
    const image = dialog.getByRole("img", { name: "Mermaid diagram", exact: true });
    await dialog.getByRole("status").waitFor();
    assert.equal(await image.getAttribute("src"), await images.nth(index).getAttribute("src"));
    return { popup, dialog, image, status: dialog.getByRole("status") };
  }

  const first = await openDiagram(0, () => open.first().press("Enter"));
  near((await first.image.boundingBox()).width, reset.diagrams[0].width);
  await inlineIn.press("Enter");
  assert.equal(await first.status.innerText(), `${Math.round(sharedScale * 100)}%`);
  const firstZoom = await first.status.innerText();
  const next = await openDiagram(1, () => open.nth(1).click());
  near((await next.image.boundingBox()).height, reset.diagrams[1].height);

  const beforePan = await measure();
  const zoomIn = button(next.dialog, "Zoom in");
  const zoomOut = button(next.dialog, "Zoom out");
  const fit = button(next.dialog, "Fit");
  const originalZoom = await next.status.innerText();
  await zoomIn.click();
  await zoomOut.click();
  assert.equal(await next.status.innerText(), originalZoom);
  await zoomIn.click();
  assert.equal(await first.status.innerText(), firstZoom);
  assert.deepEqual(await measure(), beforePan);
  const canvas = next.dialog.locator(".quick-view-image-canvas");
  const frame = await canvas.boundingBox();
  await canvas.evaluate((element) => { element.scrollTop = 0; });
  const startX = frame.x + frame.width / 2;
  const startY = frame.y + frame.height * 0.7;
  await next.popup.mouse.move(startX, startY);
  await next.popup.mouse.down();
  await next.popup.mouse.move(startX, startY - 100, { steps: 4 });
  await next.popup.mouse.up();
  assert.ok(await canvas.evaluate((element) => element.scrollTop) > 0);
  if (resize) await resize(next.popup);
  await fit.click();
  await next.popup.waitForFunction(() => {
    const canvas = document.querySelector("dialog[open] .quick-view-image-canvas");
    const image = canvas?.querySelector("img")?.getBoundingClientRect();
    return image && image.width <= canvas.clientWidth + 1 && image.height <= canvas.clientHeight + 1;
  });
  const position = await surface.evaluate((element) => [element.scrollLeft, element.scrollTop]);
  async function closeWindow(popup, action) {
    const closed = popup.waitForEvent("close");
    try {
      await action();
    } catch (error) {
      if (!popup.isClosed()) throw error;
    }
    await closed;
  }
  await closeWindow(next.popup, () => fit.press("Escape"));
  await page.waitForFunction(() => document.activeElement === document.querySelectorAll(".mermaid-tools button:last-child")[1]);
  assert.deepEqual(await surface.evaluate((element) => [element.scrollLeft, element.scrollTop]), position);
  assert.equal(first.popup.isClosed(), false);
  await closeWindow(first.popup, () => button(first.dialog, "Close").click());

  await setWheelBinding("Alt+Wheel");
  const rebound = await measure();
  await wheel(images.first(), "Control");
  assert.deepEqual(await measure(), rebound);
  await wheel(images.first(), "Alt");
  await waitForFont(rebound.font);
  assert.ok((await measure()).diagrams[0].width > rebound.diagrams[0].width);
  await setWheelBinding("");
  const disabled = await measure();
  await wheel(images.first(), "Control");
  await wheel(images.first(), "Alt");
  assert.deepEqual(await measure(), disabled);
}

async function browserSmoke() {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    for (const platform of ["Windows NT 10.0; Win64; x64", "X11; Linux x86_64"]) {
      const context = await browser.newContext({ userAgent: `Mozilla/5.0 (${platform})`, viewport: { width: 1120, height: 650 } });
      try {
        await context.route("http://dirlume.test/**", (route) => {
          const path = new URL(route.request().url()).pathname;
          return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
        });
        const home = platform.startsWith("Windows") ? "C:\\fixture" : "/fixture";
        await context.addInitScript(({ source, home }) => {
          window.__TAURI_INTERNALS__ = {
            transformCallback: () => 1,
            invoke: async (name, args) => {
              if (name === "locations") return [{ label: "Home", path: home }];
              if (name === "list_directory") return { path: args.path, parent: null, omitted: 0, entries: [
                { name: "diagrams.md", directory: false, hidden: false, size: source.length, modified: null },
              ] };
              if (name === "read_text") return { text: source, encoding: "utf8" };
              if (name === "file_icons" || name === "installed_fonts") return [];
              return null;
            },
          };
        }, { source: diagramFixture, home });
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        await page.goto("http://dirlume.test/");
        const openMarkdown = async () => {
          if (await page.getByRole("region", { name: "diagrams.md", exact: true }).isVisible()) return;
          const files = page.locator("#left-files");
          await files.locator('[data-tooltip="diagrams.md"]').click();
          await files.press("F3");
        };
        await openMarkdown();
        const changeOptions = async (change) => {
          await button(page, "Viewer options").click();
          const options = page.getByRole("dialog", { name: "Options", exact: true });
          await change(options);
          await button(options, "Done").click();
          await options.waitFor({ state: "hidden" });
        };
        await verifyMermaidZoom(page, {
          setWheelBinding: (binding) => changeOptions(async (options) => {
            await button(options, "Keyboard shortcuts").click();
            await options.getByRole("combobox", { name: "Change shortcut for Font zoom with mouse wheel" }).selectOption(binding);
          }),
          setDefaultScale: (scale) => changeOptions((options) => options.getByRole("spinbutton", { name: "Default diagram scale (%)" }).fill(scale)),
          reopen: async () => { await page.reload(); await openMarkdown(); },
          resize: (popup) => popup.setViewportSize({ width: 610, height: 400 }),
        });
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  console.log("Verified intrinsic size, persistent default scale, inline and shared zoom, independent windows, pan, fit, and wheel rebinding.");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await browserSmoke();
