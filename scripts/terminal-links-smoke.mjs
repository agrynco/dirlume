import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const longUrl = `https://example.org/${"device/".repeat(22)}confirm?name=two%20words&mode=browser#finished`;
const labeledUrl = "https://example.org/activate?code=two%20words#continue";
const labeled = "Open device sign-in";
const rejected = "Blocked file scheme";
const malformed = "Broken web link";
const output = [longUrl, `\x1b]8;;${labeledUrl}\x07${labeled}\x1b]8;;\x07`,
  `\x1b]8;;file:///tmp/example\x07${rejected}\x1b]8;;\x07`, `\x1b]8;;https://[invalid]\x07${malformed}\x1b]8;;\x07`].join("\r\n");

async function textPoint(terminal, search, { nextRow = false, offset = 3 } = {}) {
  return terminal.evaluate((element, { search, nextRow, offset }) => {
    const rows = Array.from(element.querySelectorAll(".xterm-rows > div"));
    const index = rows.findIndex((row) => row.textContent.replaceAll("\u00a0", " ").includes(search));
    if (index < 0) throw new Error(`Missing terminal row for ${search}. Rows: ${rows.map((row) => row.textContent).join(" | ")}`);
    const row = rows[index + Number(nextRow)];
    let character = (nextRow ? 0 : row.textContent.replaceAll("\u00a0", " ").indexOf(search)) + offset;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (character >= node.length) { character -= node.length; continue; }
      const range = new Range();
      range.setStart(node, character);
      range.setEnd(node, character + 1);
      const { x, y, width, height } = range.getBoundingClientRect();
      return { x: x + width / 2, y: y + height / 2 };
    }
    throw new Error(`No terminal character at offset ${offset} for ${search}`);
  }, { search, nextRow, offset });
}

async function checkLinks(page, terminal, { mac = false } = {}) {
  const rows = terminal.locator(".xterm-rows");
  const tooltip = page.getByRole("tooltip");
  const requests = () => page.evaluate(() => window.terminalLinks.requests);
  const waitForCount = (count) => page.waitForFunction((value) => window.terminalLinks.requests.length === value, count);
  const verifyClick = async (point, href) => {
    const previous = await requests();
    await page.mouse.move(point.x, point.y);
    await tooltip.getByText(href, { exact: true }).waitFor();
    await page.mouse.click(point.x, point.y);
    await waitForCount(previous.length + 1);
    assert.deepEqual(await requests(), [...previous, href]);
  };
  await rows.getByText(labeled, { exact: true }).waitFor();
  assert.deepEqual(await requests(), []);
  const wrap = await textPoint(terminal, "https://example.org/", { nextRow: true });
  await verifyClick(wrap, longUrl);
  const label = await textPoint(terminal, labeled);
  await verifyClick(label, labeledUrl);

  const sideMenu = page.getByRole("menu", { name: "Terminal actions", exact: true });
  const before = await requests();
  if (mac) {
    await page.keyboard.down("Control");
    try { await page.mouse.click(label.x, label.y); } finally { await page.keyboard.up("Control"); }
  } else await page.mouse.click(label.x, label.y, { button: "right" });
  await sideMenu.waitFor();
  await page.keyboard.press("Escape");
  const selectionEnd = await textPoint(terminal, labeled, { offset: labeled.length - 1 });
  await page.mouse.move(label.x, label.y);
  await page.mouse.down();
  await page.mouse.move(selectionEnd.x, selectionEnd.y, { steps: 6 });
  await page.mouse.up();
  await terminal.locator(".xterm-selection div").first().waitFor();
  assert.deepEqual(await requests(), before);

  for (const label of [rejected, malformed]) {
    const point = await textPoint(terminal, label);
    await page.mouse.click(point.x, point.y);
  }
  assert.deepEqual(await requests(), before);
  await page.evaluate(() => { window.terminalLinks.fail = true; });
  await page.mouse.click(label.x, label.y);
  await page.getByRole("alert").filter({ hasText: "Fixture browser could not be opened." }).waitFor();
  await waitForCount(before.length + 1);
  assert.equal(await terminal.isVisible(), true);
  await terminal.locator(".xterm-helper-textarea").focus();
}

export async function testNativeTerminalLinks(page) {
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.terminalLinks = { requests: [], originalFetch: fetch };
    window.fetch = (input, init) => {
      if (typeof input === "string" && /^https?:\/\/ipc\.localhost\/open_web_link$/.test(input)) {
        window.terminalLinks.requests.push(JSON.parse(init.body).href);
        const failed = window.terminalLinks.fail;
        return Promise.resolve(new Response(JSON.stringify(failed ? "Fixture browser could not be opened." : null), {
          headers: { "Content-Type": "application/json", "Tauri-Response": failed ? "error" : "ok" },
        }));
      }
      return fetch(input, init);
    };
  });
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  try {
    if (await terminal.isVisible()) await terminal.getByRole("button", { name: "Close terminal", exact: true }).click();
    const command = page.getByRole("combobox", { name: "Command line", exact: true });
    const encoded = Buffer.from(output, "utf8").toString("base64");
    await command.fill(`[Console]::WriteLine([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))`);
    await command.press("Enter");
    await terminal.locator(".xterm-helper-textarea").press("Control+o");
    await page.locator(".app.panels-hidden").waitFor();
    await checkLinks(page, terminal);
    const input = terminal.locator(".xterm-helper-textarea");
    await input.pressSequentially("Write-Output ('dirlume-' + 'terminal-still-works')");
    await input.press("Enter");
    await terminal.locator(".xterm-rows").getByText("dirlume-terminal-still-works", { exact: true }).waitFor();
  } finally {
    await page.evaluate(() => {
      window.fetch = window.terminalLinks.originalFetch;
      delete window.terminalLinks;
    });
    if (await terminal.isVisible()) await terminal.getByRole("button", { name: "Close terminal", exact: true }).click();
  }
  console.log("Verified native WebView2 URL activation, selection, context menus, launch errors, and continued PowerShell input.");
}

async function testBrowserTerminalLinks() {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const platforms = ["Windows NT 10.0; Win64; x64", "X11; Linux x86_64", "Macintosh; Intel Mac OS X 10_15_7"];
    for (const platform of platforms) {
      for (const ssh of [false, true]) {
        const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, userAgent: `Mozilla/5.0 (${platform})`, locale: "en-US" });
        page.setDefaultTimeout(8000);
        await page.route("http://dirlume.test/**", (route) => {
          const path = new URL(route.request().url()).pathname;
          return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
        });
        await page.addInitScript(({ output, windows }) => {
          const path = windows ? "C:\\fixture" : "/fixture";
          const file = { name: "fixture.txt", directory: false, hidden: false, link: false, size: 7, modified: null };
          window.terminalLinks = { requests: [], ssh: false, fail: false };
          window.__TAURI_INTERNALS__ = {
            transformCallback: () => 1,
            invoke: async (command, args) => {
              if (command === "locations") return [{ label: "Home", path }];
              if (command === "list_directory") return { path, parent: null, entries: [file], omitted: 0 };
              if (command === "file_icons") return args.items.map(() => null);
              if (command === "ssh_profiles") return [{ id: "ssh", label: "SSH fixture", host: "fixture", port: 22 }];
              if (command === "connect_ssh") return { kind: "connected", id: 17, address: "fixture", origin: "sftp://fixture",
                segments: ["home"], listing: { entries: [file], omitted: 0, elevated: false } };
              if (command === "open_terminal") {
                window.terminalLinks.ssh = Boolean(args.request.ssh);
                args.output.onmessage({ event: "data", data: btoa(output) });
                return false;
              }
              if (command === "open_web_link") {
                window.terminalLinks.requests.push(args.href);
                if (window.terminalLinks.fail) throw new Error("Fixture browser could not be opened.");
              }
              return null;
            },
          };
        }, { output, windows: platform.startsWith("Windows") });
        await page.goto("http://dirlume.test/");
        const list = page.getByRole("listbox", { name: "left files", exact: true });
        if (ssh) {
          await list.press("Alt+F1");
          await page.locator("#left-pane .location-popup").getByRole("button", { name: "SSH", exact: true }).click();
          await list.getByRole("option", { name: /SSH fixture/ }).dblclick();
        }
        await list.getByRole("option", { name: /^fixture\.txt/ }).waitFor();
        await list.press("F12");
        const terminal = page.getByRole("region", { name: "Terminal", exact: true });
        await checkLinks(page, terminal, { mac: platform.startsWith("Macintosh") }).catch((error) => {
          throw new Error(`Terminal links failed with ${platform} in a ${ssh ? "SSH" : "local"} session.`, { cause: error });
        });
        assert.equal(await page.evaluate(() => window.terminalLinks.ssh), ssh);
        await page.close();
      }
    }
    console.log("Verified wrapped web links and OSC 8 destinations in local and SSH terminals with all three client settings.");
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testBrowserTerminalLinks();
