import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const linux = "Mozilla/5.0 (X11; Linux x86_64)";
const windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const script = "quoted 'script' $(printf bad);&.sh";
const ordinary = "ordinary.sh";
const tmp = process.platform === "linux" ? await mkdtemp(join(tmpdir(), "dirlume scripts ")) : null;
const directory = tmp ?? "/fixture/script folder";
const browser = await chromium.launch({ channel: "chrome" });

async function fixture(userAgent, open) {
  const folder = userAgent === windows ? "C:\\fixture" : directory;
  const page = await browser.newPage({ userAgent, viewport: { width: 980, height: 650 } });
  page.setDefaultTimeout(8000);
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  await page.addInitScript(({ folder, script, ordinary, open }) => {
    if (open) localStorage.setItem("dirlume.preferences.v1", JSON.stringify({ bindingDefaults: 12, activeShortcutScheme: "fixture",
      shortcutSchemes: [{ id: "fixture", name: "Fixture", bindings: { open } }] }));
    const files = [ordinary, script].map((name) => ({ name, directory: false, link: false, hidden: false, size: 3, modified: null }));
    const fixture = window.scriptFixture = { checks: [], shellWrites: [], shellOpens: [], systemOpens: [] };
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args) => {
        if (command === "locations") return [{ label: "Home", path: folder }];
        if (command === "list_directory") return { path: args.path, parent: null, entries: files, omitted: 0 };
        if (command === "ftp_profiles") return [];
        if (command === "ssh_profiles") return [{ id: "ssh-fixture", label: "Script host", host: "fixture", port: 22 }];
        if (command === "connect_ssh") return { kind: "connected", id: 3, address: "fixture", origin: "sftp://fixture",
          segments: ["remote"], listing: { entries: files, omitted: 0, elevated: false } };
        if (command === "list_ssh") return { entries: files, omitted: 0, elevated: false };
        if (command === "read_ssh_text") return { text: "# Remote script", encoding: "utf8" };
        if (command === "file_icons") return args.items.map(() => null);
        if (command === "installed_fonts") return [];
        if (command === "executable_shell_script") {
          fixture.checks.push(args);
          return args.name === script;
        }
        if (command === "operate" && args.operation.kind === "open") fixture.systemOpens.push(args.operation.name);
        if (command === "open_terminal") {
          fixture.shellOpens.push(args.request.directory);
          fixture.output = args.output;
          return false;
        }
        if (command === "write_terminal") fixture.shellWrites.push(args.data);
        return null;
      },
    };
  }, { folder, script, ordinary, open });
  await page.goto("http://dirlume.test/");
  return page;
}

const files = (page) => page.locator("#left-files");
const row = (page, name) => files(page).locator(`[data-tooltip=${JSON.stringify(name)}]`);
const waitForOpen = (page, count) => page.waitForFunction((count) => window.scriptFixture.systemOpens.length === count, count);
const snapshot = (page) => page.evaluate(() => {
  const { checks, shellWrites, shellOpens, systemOpens } = window.scriptFixture;
  return { checks, shellWrites, shellOpens, systemOpens };
});

try {
  if (tmp) {
    const path = join(tmp, script);
    await writeFile(path, "#!/bin/sh\nprintf 'dirlume-launch:%s:%s\\n' \"$PWD\" \"$0\"\n");
    await chmod(path, 0o755);
  }
  const page = await fixture(linux);
  await row(page, ordinary).click();
  await files(page).press("Enter");
  await waitForOpen(page, 1);
  await row(page, script).dblclick();
  await waitForOpen(page, 2);
  await files(page).press("Shift+Enter");
  await waitForOpen(page, 3);
  assert.deepEqual(await snapshot(page), {
    checks: [{ directory, name: ordinary }], shellWrites: [], shellOpens: [], systemOpens: [ordinary, script, script],
  });
  await row(page, script).click();
  await files(page).press("Enter");
  await page.waitForFunction(() => window.scriptFixture.shellWrites.some((write) => write.startsWith("cd -- ")));
  const launched = await snapshot(page);
  assert.deepEqual(launched.shellOpens, [directory]);
  assert.deepEqual(launched.checks[1], { directory, name: script });
  const requests = launched.shellWrites.filter((write) => write.startsWith("cd -- "));
  assert.equal(requests.length, 1);
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  assert.equal(requests[0], `cd -- ${quote(directory)} && ${quote("./" + script)}\r`);
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  const input = terminal.locator(".xterm-helper-textarea");
  await input.waitFor({ state: "attached" });
  await page.waitForFunction(() => document.activeElement?.classList.contains("xterm-helper-textarea"));
  if (tmp) {
    const run = spawnSync("sh", ["-c", requests[0].trimEnd()], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trimEnd(), `dirlume-launch:${directory}:./${script}`);
    await page.evaluate((output) => window.scriptFixture.output.onmessage({ event: "data", data: btoa(output.replaceAll("\n", "\r\n")) }), run.stdout);
    await terminal.locator(".xterm-accessibility-tree").getByText(/dirlume-launch/).first().waitFor();
  }
  await page.close();

  const remapped = await fixture(linux, ["Ctrl+Alt+L"]);
  await row(remapped, script).click();
  await files(remapped).press("Enter");
  assert.deepEqual((await snapshot(remapped)).checks, []);
  await files(remapped).press("Control+Alt+l");
  await remapped.waitForFunction(() => window.scriptFixture.shellOpens.length === 1);
  await remapped.close();

  const disabled = await fixture(linux, []);
  await row(disabled, script).click();
  await files(disabled).press("Enter");
  assert.deepEqual((await snapshot(disabled)).checks, []);
  await disabled.close();

  const remote = await fixture(linux);
  await remote.getByRole("button", { name: "Locations for left pane", exact: true }).click();
  await remote.getByRole("button", { name: "NetBox", exact: true }).click();
  await files(remote).getByRole("option", { name: /^Script host/ }).dblclick();
  await row(remote, script).click();
  await files(remote).press("Enter");
  await remote.locator(".text-window:not([hidden])").waitFor();
  assert.deepEqual((await snapshot(remote)).checks, []);
  assert.deepEqual((await snapshot(remote)).shellOpens, []);
  await remote.close();

  const other = await fixture(windows);
  await row(other, script).click();
  await files(other).press("Enter");
  await waitForOpen(other, 1);
  assert.deepEqual((await snapshot(other)).checks, []);
  await other.close();
  console.log("Verified executable Linux scripts open with a literal filename and correct directory, and existing open routes stay available.");
} finally {
  await browser.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
}
