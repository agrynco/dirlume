import assert from "node:assert/strict";
import { mkdir, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { editPaneAddress } from "./pane-address-smoke.mjs";

export async function testRetainedTerminalDirectory(page, root) {
  const left = join(root, "terminal left");
  const right = join(root, "terminal right");
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  const toggle = page.getByRole("button", { name: "Toggle terminal", exact: true });
  const field = page.getByRole("combobox", { name: "Command line", exact: true });
  const input = terminal.locator(".xterm-helper-textarea");
  const files = (side) => page.getByRole("listbox", { name: `${side} files`, exact: true });
  const queued = terminal.getByText("Command queued. It will run when the terminal is ready.", { exact: true });

  async function openFolder(side, path) {
    const address = await editPaneAddress(page, side);
    await address.fill(path);
    await address.press("Enter");
    await page.waitForFunction(({ side, path }) => document.getElementById(`${side}-path`)?.dataset.path === path &&
      document.getElementById(`${side}-files`)?.getAttribute("aria-busy") === "false", { side, path });
  }

  function waitForIdle(path) {
    return page.waitForFunction((path) => {
      const card = document.querySelector(".terminal-card:not([hidden])");
      const console = card?.querySelector(".xterm-rows");
      const lines = Array.from(console?.children ?? [], (row) => row.textContent.trim()).filter(Boolean);
      return card?.querySelector(".terminal-location")?.textContent === path && lines.at(-1) === `PS ${path}>`;
    }, path);
  }

  async function expectDirectory(side, path) {
    await waitForIdle(path);
    assert.equal(await page.locator(`#${side}-path`).getAttribute("data-path"), path);
    assert.equal(await page.locator(".command-bar > span").textContent(), path);
  }

  async function submitProbe(side, path, tag) {
    await field.fill(`Write-Output ('dirlume-' + '${tag}:' + (Get-Location).Path + ':' + $dirlumeSmokeSession)`);
    assert.equal(await field.getAttribute("aria-activedescendant"), null);
    await field.press("Enter");
    const expected = `dirlume-${tag}:${path}:370`;
    const output = terminal.locator(".xterm-accessibility-tree");
    await waitForOutput(expected);
    await expectDirectory(side, path);
    assert.equal((await output.textContent()).split(expected).length - 1, 1);
  }

  function waitForOutput(expected) {
    return page.waitForFunction((expected) => document.querySelector(".terminal-card:not([hidden]) .xterm-accessibility-tree")?.textContent.includes(expected), expected)
      .catch(async (error) => { throw new Error(`Expected ${expected} in the terminal. ${await terminal.innerText()}`, { cause: error }); });
  }

  await page.waitForFunction(() => ["left", "right"].every((side) =>
    document.getElementById(`${side}-path`)?.dataset.path && document.getElementById(`${side}-files`)?.getAttribute("aria-busy") === "false"));
  const previousLeft = await page.locator("#left-path").getAttribute("data-path");
  const previousRight = await page.locator("#right-path").getAttribute("data-path");
  if (await terminal.isVisible()) await terminal.getByRole("button", { name: "Close terminal", exact: true }).click();
  await mkdir(left);
  await mkdir(right);
  await openFolder("left", left);
  await openFolder("right", right);
  await files("left").focus();
  await toggle.click();
  await expectDirectory("left", left);
  await input.pressSequentially("$dirlumeSmokeSession = 370");
  await input.press("Enter");
  await files("right").focus();
  await expectDirectory("right", right);
  await submitProbe("right", right, "visible");

  await toggle.click();
  await terminal.waitFor({ state: "hidden" });
  await files("left").focus();
  await submitProbe("left", left, "hidden");

  await input.pressSequentially("Write-Output ('dirlume-' + 'discarded-draft')");
  await files("right").focus();
  await field.fill("Write-Output ('dirlume-' + 'after-cancel')");
  await field.press("Enter");
  await queued.waitFor();
  await input.press("Control+c");
  await queued.waitFor({ state: "hidden" });
  await waitForOutput("dirlume-after-cancel");
  await expectDirectory("right", right);
  const output = terminal.locator(".xterm-accessibility-tree");
  assert.doesNotMatch(await output.textContent(), /dirlume-discarded-draft/);

  await files("left").focus();
  await expectDirectory("left", left);
  await input.pressSequentially("Write-Output ('dirlume-' + 'waiting'); Start-Sleep -Seconds 4");
  await input.press("Enter");
  await waitForOutput("dirlume-waiting");
  await files("right").focus();
  assert.equal(await page.locator(".command-bar > span").textContent(), right);
  await field.fill("Write-Output ('dirlume-' + 'must-not-run')");
  await field.press("Enter");
  await queued.waitFor();
  await rmdir(right);
  await waitForOutput("PathNotFound");
  await waitForIdle(left);
  assert.doesNotMatch(await output.textContent(), /dirlume-must-not-run/);
  await terminal.getByRole("button", { name: "Close terminal", exact: true }).click();
  await openFolder("left", previousLeft);
  await openFolder("right", previousRight);
  await files("left").focus();
  console.log("Verified retained PowerShell directory synchronization, one result per command, canceled shell drafts, and failure to enter the submission directory.");
}

async function testBrowserTerminalDirectory() {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    for (const [platform, editor] of [["X11; Linux x86_64", "bash"], ["Macintosh; Intel Mac OS X 10_15_7", "zsh"]]) {
      const page = await browser.newPage({ userAgent: `Mozilla/5.0 (${platform})`, locale: "en-US" });
      page.setDefaultTimeout(8000);
      await page.route("http://dirlume.test/**", (route) => {
        const pathname = new URL(route.request().url()).pathname;
        return route.fulfill({ path: resolve("dist", pathname === "/" ? "index.html" : "." + pathname) });
      });
      await page.addInitScript((editor) => {
        let shell;
        let promptSequence = 0;
        window.submittedCommands = [];
        const file = { name: "fixture.txt", directory: false, hidden: false, link: false, size: 7, modified: null };
        function prompt(directory, result = "") {
          const marker = `\x1b]2;${shell.token}:${++promptSequence}:${btoa(directory)}:::${editor}::\x07`;
          shell.output.onmessage({ event: "data", data: btoa(`${result}${marker}${directory} $ `) });
        }
        window.__TAURI_INTERNALS__ = {
          transformCallback: () => 1,
          invoke: async (command, args) => {
            if (command === "locations") return [{ label: "Home", path: "/fixture/left" }];
            if (command === "list_directory") return { path: args.path, parent: "/fixture", entries: [file], omitted: 0 };
            if (command === "file_icons") return args.items.map(() => null);
            if (command === "open_terminal") {
              shell = { token: args.request.promptToken, id: args.request.id, output: args.output };
              window.terminalStarts = (window.terminalStarts ?? 0) + 1;
              queueMicrotask(() => prompt(args.request.directory));
              return true;
            }
            if (command === "write_terminal") {
              if (args.id !== shell.id) throw new Error("Command was sent to the wrong terminal session.");
              const match = /^: '[^']+'; cd -- '([^']+)'(?: && ([^\r]+))?\r$/.exec(args.data);
              if (match) {
                if (window.rejectTerminalWrite) throw new Error("Fixture terminal write failed.");
                const [, directory, command] = match;
                if (command) window.submittedCommands.push({ directory, command });
                prompt(directory, command ? `\r\nResult: ${directory}\r\n` : "\r\n");
              }
            }
            return null;
          },
        };
      }, editor);
      await page.goto("http://dirlume.test/");
      const left = "/fixture/left";
      const right = "/fixture/right with spaces";
      await page.waitForFunction((left) => ["left", "right"].every((side) =>
        document.getElementById(`${side}-path`)?.dataset.path === left &&
        document.getElementById(`${side}-files`)?.getAttribute("aria-busy") === "false"), left);
      const leftFiles = page.locator("#left-files");
      await leftFiles.focus();
      const commandBar = page.locator(".command-bar");
      await commandBar.locator(":scope > span").getByText(left, { exact: true }).waitFor();
      await commandBar.getByRole("button", { name: "Terminal", exact: true }).click();
      const terminal = page.getByRole("region", { name: "Terminal", exact: true });
      const header = terminal.locator(".terminal-location");
      await header.getByText(left, { exact: true }).waitFor().catch(async (error) => {
        const state = await page.locator(".app").evaluate((app) => ({
          layout: app.className,
          directory: app.querySelector(".command-bar > span")?.textContent,
          terminalDirectory: app.querySelector(".terminal-card:not([hidden]) .terminal-location")?.textContent,
          sessions: window.terminalStarts ?? 0,
        }));
        throw new Error(`Terminal did not start in ${left} with ${platform}. ${JSON.stringify(state)}`, { cause: error });
      });
      const address = await editPaneAddress(page, "right");
      await address.fill(right);
      await address.press("Enter");
      await page.waitForFunction((right) => document.getElementById("right-path")?.dataset.path === right &&
        document.getElementById("right-files")?.getAttribute("aria-busy") === "false", right);
      await header.getByText(right, { exact: true }).waitFor();
      const field = page.getByRole("combobox", { name: "Command line", exact: true });
      await field.fill("pwd");
      await field.press("Enter");
      await terminal.locator(".xterm-rows").getByText(`Result: ${right}`, { exact: true }).waitFor();
      const submitted = await page.evaluate(() => window.submittedCommands);
      assert.deepEqual(submitted, [{ directory: right, command: "pwd" }]);
      assert.equal(await page.evaluate(() => window.terminalStarts), 1);
      await leftFiles.focus();
      await header.getByText(left, { exact: true }).waitFor();
      await page.evaluate(() => { window.rejectTerminalWrite = true; });
      await field.fill("pwd");
      await field.press("Enter");
      await page.getByRole("alert").filter({ hasText: "Fixture terminal write failed." }).waitFor();
      await page.close();
    }
    console.log("Verified pane directory synchronization, a retained session, and visible write errors with Bash and Zsh prompt fixtures.");
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testBrowserTerminalDirectory();
