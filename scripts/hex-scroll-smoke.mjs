import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

export const hexFixture = "A".repeat(1024) + "B".repeat(1024) + "C".repeat(1024) + "END";
const largeSize = 8 * 1024 ** 3 + 3;
const blockSize = 1024;
const button = (page, name) => page.getByRole("button", { name, exact: true });
const row = (hex, offset) => hex.locator(`[data-byte-offset="${offset}"]`);

export async function verifyHexScroll(page, first = /41 41 41.*AAAAAAAAAAAAAAAA/) {
  const hex = page.getByLabel("Hexadecimal contents", { exact: true });
  await row(hex, 0).filter({ hasText: first }).waitFor();
  const viewport = await hex.elementHandle();
  async function reach(offset, pattern, direction) {
    const target = row(hex, offset);
    for (let attempt = 0; attempt < 20 && !await target.count(); attempt++) {
      const step = await viewport.evaluate((view, direction) => {
        const top = view.scrollTop;
        const first = view.querySelector("[data-byte-offset]")?.getAttribute("data-byte-offset");
        view.scrollTop += direction * view.clientHeight / 2;
        return { first, moved: view.scrollTop !== top };
      }, direction);
      if (!step.moved) break;
      await page.waitForFunction(({ view, first, offset }) =>
        view.querySelector(`[data-byte-offset="${offset}"]`) ||
        view.querySelector("[data-byte-offset]")?.getAttribute("data-byte-offset") !== first,
      { view: viewport, first: step.first, offset });
    }
    await target.filter({ hasText: pattern }).waitFor();
    const offsets = await hex.locator("[data-byte-offset]").evaluateAll((lines) => lines.map((line) => Number(line.dataset.byteOffset)));
    assert.ok(offsets.slice(1).every((offset, index) => offset === offsets[index] + 16));
  }
  await reach(0x400, /42 42 42.*BBBBBBBBBBBBBBBB/, 1);
  await reach(0x800, /43 43 43.*CCCCCCCCCCCCCCCC/, 1);
  await reach(0xc00, /45 4E 44.*END$/, 1);
  await reach(0x800, /43 43 43.*CCCCCCCCCCCCCCCC/, -1);
  await reach(0x400, /42 42 42.*BBBBBBBBBBBBBBBB/, -1);
  await hex.press("Home");
  await row(hex, 0).waitFor();
  await page.getByLabel("Byte offset", { exact: true }).fill("0x800");
  await button(page, "Go to offset").click();
  await row(hex, 0x800).filter({ hasText: /43 43 43/ }).waitFor();
  await hex.press("End");
  await row(hex, 0xc00).filter({ hasText: /45 4E 44.*END$/ }).waitFor();
}

async function browserSmoke() {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 1140, height: 740 } });
    page.setDefaultTimeout(8000);
    await page.route("http://dirlume.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    await page.addInitScript(({ hexFixture, largeSize, blockSize }) => {
      const home = /Windows/.test(navigator.userAgent) ? "C:\\fixture" : "/fixture";
      const files = { "417.txt": hexFixture, "fixture.png": hexFixture, "large.txt": "large", "empty.txt": "", "tiny.txt": "END" };
      const entries = Object.entries(files).map(([name, content]) => ({
        name, directory: false, hidden: false, size: name === "large.txt" ? largeSize : content.length, modified: null,
      }));
      window.hexRequests = [];
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args) => {
          if (command === "locations") return [{ label: "Home", path: home }];
          if (command === "list_directory") return { path: args.path, entries, parent: null, omitted: 0 };
          if (command === "read_text") return { text: files[args.name], encoding: "utf8" };
          if (command === "ftp_profiles") return [];
          if (command === "ssh_profiles") return [{ id: "ssh", label: "Hex fixture", host: "fixture", port: 22 }];
          if (command === "connect_ssh") return { kind: "connected", id: 5, address: "Hex fixture", origin: "sftp://fixture",
            segments: ["remote"], listing: { entries, omitted: 0, elevated: false } };
          if (command === "list_ssh") return { entries, omitted: 0, elevated: false };
          if (command === "read_ssh_text") return { text: hexFixture, encoding: "utf8" };
          if (command === "read_bytes" || command === "read_ssh_bytes") {
            const name = args.name ?? args.segments.at(-1);
            const offset = args.offset;
            const length = name === "large.txt" ? largeSize : files[name].length;
            window.hexRequests.push({ name, offset });
            if (command === "read_ssh_bytes" && offset === blockSize) throw new Error("Remote fixture read failed");
            const data = name === "large.txt" ? Array(Math.min(blockSize, length - offset)).fill(65) :
              Array.from(files[name].slice(offset, offset + blockSize), (char) => char.charCodeAt(0));
            return { length, offset, data };
          }
          if (command === "file_icons" || command === "installed_fonts") return [];
          return null;
        },
      };
    }, { hexFixture, largeSize, blockSize });
    await page.goto("http://dirlume.test/");
    const hex = page.getByLabel("Hexadecimal contents", { exact: true });
    const left = page.locator("#left-files");
    async function open(name, files = left) {
      await files.locator(`[data-tooltip="${name}"]`).click();
      await files.press("F3");
      await page.getByRole("region", { name, exact: true }).waitFor();
      await page.keyboard.press("F4");
    }
    await open("417.txt");
    await verifyHexScroll(page);
    await hex.press("Escape");
    await open("fixture.png");
    await verifyHexScroll(page);
    await hex.press("Escape");
    await open("empty.txt");
    await page.getByRole("status").filter({ hasText: "This file is empty." }).waitFor();
    await page.keyboard.press("Escape");
    await open("tiny.txt");
    await row(hex, 0).filter({ hasText: /45 4E 44.*END$/ }).waitFor();
    assert.equal(await button(page, "Next page").isDisabled(), true);
    await hex.press("Escape");

    await open("large.txt");
    await row(hex, 0).filter({ hasText: /41 41 41/ }).waitFor();
    const target = 0x12345670;
    const address = page.getByLabel("Byte offset", { exact: true });
    await address.fill("0x12345670");
    await button(page, "Go to offset").click();
    await row(hex, target).filter({ hasText: /41 41 41/ }).waitFor();
    await hex.press("ArrowDown");
    assert.equal(await row(hex, target).count(), 0);
    await row(hex, target + 16).waitFor();
    await hex.press("End");
    await row(hex, largeSize - 3).filter({ hasText: /41 41 41.*AAA$/ }).waitFor();
    assert.ok(await hex.locator("[data-byte-offset]").count() < 60);
    const reads = await page.evaluate(() => window.hexRequests.filter(({ name }) => name === "large.txt"));
    assert.ok(reads.length <= 7 && reads.every(({ offset }) => offset % 1024 === 0));
    await hex.press("Escape");

    const right = page.getByRole("region", { name: "right pane", exact: true });
    await button(right, "Locations for right pane").click();
    await button(right, "NetBox").click();
    await right.getByRole("option", { name: /^Hex fixture/ }).dblclick();
    await page.waitForFunction(() => document.querySelector("#right-path")?.dataset.path === "/remote");
    await open("417.txt", page.locator("#right-files"));
    await row(hex, 0).filter({ hasText: /41 41 41/ }).waitFor();
    await button(page, "Next page").click();
    await hex.getByRole("alert").filter({ hasText: "Remote fixture read failed" }).waitFor();
    assert.equal(await hex.getByText("End of file.").count(), 0);
    await hex.press("End");
    await row(hex, 0xc00).filter({ hasText: /45 4E 44.*END$/ }).waitFor();
  } finally { await browser.close(); }
  console.log("Verified Hex scrolling through page boundaries, Text and Image Viewer, direct offsets, short and empty files, bounded reads, and remote errors.");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await browserSmoke();
