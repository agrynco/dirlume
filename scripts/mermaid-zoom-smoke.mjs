import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const wide = ["sequenceDiagram", ...Array.from({ length: 12 }, (_, i) => `participant P${i} as Participant ${i}`), "P0->>P11: Wide diagram"];
const tall = ["flowchart TD", ...Array.from({ length: 24 }, (_, i) => `N${i}[Step ${i}] --> N${i + 1}`)];
const mermaid = (lines) => ["```mermaid", ...lines, "```", ""].join("\n");
export const diagramFixture = ["# Diagram zoom", "", mermaid(wide), mermaid(tall), mermaid(["Not a Mermaid diagram"])].join("\n");
const button = (parent, name) => parent.getByRole("button", { name, exact: true });

export async function verifyMermaidZoom(page, setWheelBinding) {
  const viewer = page.getByRole("region", { name: "diagrams.md", exact: true });
  const surface = viewer.locator(".markdown");
  const images = surface.getByRole("img", { name: "Mermaid diagram", exact: true });
  const open = surface.getByRole("button", { name: "Open diagram", exact: true });
  const dialog = page.getByRole("dialog", { name: "Mermaid diagram", exact: true });
  const canvas = dialog.locator(".quick-view-image-canvas");
  const zoomIn = button(dialog, "Zoom in");
  const zoomOut = button(dialog, "Zoom out");
  const fit = button(dialog, "Fit");
  await images.nth(1).waitFor();
  await surface.getByRole("alert").waitFor();
  assert.equal(await open.count(), 2);

  const measure = () => surface.evaluate((element) => ({
    font: parseFloat(getComputedStyle(element).fontSize),
    diagrams: Array.from(element.querySelectorAll("img.mermaid-diagram"), (image) => {
      const { width, height } = image.getBoundingClientRect();
      return { width, height, cap: Math.min(640, innerHeight * .7), original: Number(image.getAttribute("width")) };
    }),
    available: element.querySelector(".markdown-content").clientWidth - 36,
  }));
  const initial = await measure();
  assert.ok(initial.diagrams.every(({ width, height, cap, original }) =>
    width <= Math.min(initial.available, original, 960) + 1 && height <= cap + 1));
  assert.ok(initial.diagrams[0].width > initial.diagrams[0].height * 2);
  assert.ok(initial.diagrams[1].height > initial.diagrams[1].width * 2);

  const wheel = (target, modifier, repeat = 1) => target.evaluate((element, { modifier, repeat }) => {
    for (let i = 0; i < repeat; i++) element.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, deltaY: -120, ctrlKey: modifier === "Control", altKey: modifier === "Alt",
    }));
  }, { modifier, repeat });
  await wheel(images.first(), "Control", 12);
  await page.waitForFunction(({ width, height, font }) => {
    const surface = document.querySelector(".text-window:not([hidden]) .markdown");
    const images = surface?.querySelectorAll("img.mermaid-diagram");
    return images?.length === 2 && images[0].getBoundingClientRect().width > width &&
      images[1].getBoundingClientRect().height > height && parseFloat(getComputedStyle(surface).fontSize) > font;
  }, { width: initial.diagrams[0].width + 50, height: initial.diagrams[1].height + 50, font: initial.font });
  const enlarged = await measure();
  assert.ok(enlarged.diagrams[0].width > enlarged.available);
  assert.ok(enlarged.diagrams[1].height > enlarged.diagrams[1].cap);
  assert.equal(await images.first().evaluate((image) => image.src.startsWith("data:image/svg+xml")), true);
  const rightEdge = await images.first().locator("..").evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    return {
      scrollLeft: element.scrollLeft,
      imageRight: element.querySelector("img.mermaid-diagram").getBoundingClientRect().right,
      visibleRight: element.getBoundingClientRect().left + element.clientLeft + element.clientWidth,
    };
  });
  assert.ok(rightEdge.scrollLeft > 0 && rightEdge.imageRight <= rightEdge.visibleRight + 1, JSON.stringify(rightEdge));

  await open.nth(1).scrollIntoViewIfNeeded();
  const firstPosition = await surface.evaluate((element) => [element.scrollLeft, element.scrollTop]);
  await open.nth(1).press("Enter");
  await fit.waitFor();
  const rendered = dialog.getByRole("img", { name: "Mermaid diagram", exact: true });
  assert.equal(await rendered.getAttribute("src"), await images.nth(1).getAttribute("src"));
  const status = dialog.getByRole("status");
  const firstScale = await status.innerText();
  await zoomIn.click();
  await zoomOut.click();
  assert.equal(await status.innerText(), firstScale);
  for (let i = 0; i < 5; i++) await zoomIn.click();
  const frame = await canvas.boundingBox();
  const startingPan = await canvas.evaluate((element) => element.scrollTop);
  const startX = frame.x + frame.width / 2;
  const startY = frame.y + frame.height * .7;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY - 100, { steps: 4 });
  await page.mouse.up();
  assert.ok(await canvas.evaluate((element) => element.scrollTop) > startingPan);
  const beforeResize = await dialog.boundingBox();
  const edge = await dialog.locator('[data-resize-edge="se"]').boundingBox();
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x - 65, edge.y - 65, { steps: 4 });
  await page.mouse.up();
  assert.ok((await dialog.boundingBox()).width < beforeResize.width);
  await fit.click();
  await page.waitForFunction(() => {
    const canvas = document.querySelector("dialog[open] .quick-view-image-canvas");
    const image = canvas?.querySelector("img")?.getBoundingClientRect();
    return image && image.width <= canvas.clientWidth + 1 && image.height <= canvas.clientHeight + 1;
  });
  await fit.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement === document.querySelectorAll(".markdown .mermaid-figure button")[1]);
  assert.deepEqual(await surface.evaluate((element) => [element.scrollLeft, element.scrollTop]), firstPosition);
  await open.first().click();
  await fit.waitFor();
  assert.equal(await rendered.getAttribute("src"), await images.first().getAttribute("src"));
  for (let i = 0; i < 3; i++) await zoomIn.click();
  const wideFrame = await canvas.boundingBox();
  const initialLeft = await canvas.evaluate((element) => element.scrollLeft);
  await page.mouse.move(wideFrame.x + wideFrame.width * .7, wideFrame.y + wideFrame.height / 2);
  await page.mouse.down();
  await page.mouse.move(wideFrame.x + wideFrame.width * .7 - 100, wideFrame.y + wideFrame.height / 2, { steps: 4 });
  await page.mouse.up();
  assert.ok(await canvas.evaluate((element) => element.scrollLeft) > initialLeft);
  await button(dialog, "Close dialog").click();

  await setWheelBinding("Alt+Wheel");
  const rebound = await measure();
  await wheel(images.first(), "Control");
  assert.deepEqual(await measure(), rebound);
  await wheel(images.first(), "Alt");
  await page.waitForFunction((font) => parseFloat(getComputedStyle(document.querySelector(".text-window:not([hidden]) .markdown")).fontSize) > font, rebound.font);
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
      const page = await browser.newPage({ userAgent: `Mozilla/5.0 (${platform})`, viewport: { width: 1120, height: 780 } });
      try {
        await page.route("http://dirlume.test/**", (route) => {
          const path = new URL(route.request().url()).pathname;
          return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
        });
        const home = platform.startsWith("Windows") ? "C:\\fixture" : "/fixture";
        await page.addInitScript(({ source, home }) => {
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
        page.setDefaultTimeout(8000);
        await page.goto("http://dirlume.test/");
        const files = page.locator("#left-files");
        await files.locator('[data-tooltip="diagrams.md"]').click();
        await files.press("F3");
        await verifyMermaidZoom(page, async (binding) => {
          await button(page, "Viewer options").click();
          const options = page.getByRole("dialog", { name: "Options", exact: true });
          await button(options, "Keyboard shortcuts").click();
          await options.getByRole("combobox", { name: "Change shortcut for Font zoom with mouse wheel" }).selectOption(binding);
          await button(options, "Done").click();
          await options.waitFor({ state: "hidden" });
        });
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
  console.log("Verified wide and tall Mermaid diagrams, shared Markdown zoom, separate viewing, pan, fit, and remappable wheel controls.");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await browserSmoke();
