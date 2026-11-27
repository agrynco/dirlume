import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright-core";
import { close, fixture, port, withServer } from "./server-smoke.mjs";
import { testFtp } from "./ftp-smoke.mjs";
import { testNativeJumpHosts } from "./ssh-jump-native-smoke.mjs";
import { testMountedSmbNavigation, testSmbNavigation } from "./smb-navigation-smoke.mjs";
import { testSyntaxMenu } from "./syntax-menu-smoke.mjs";
import { testSystemTheme } from "./system-theme-smoke.mjs";
import { testMarkdown, testViewerReadingArea } from "./markdown-smoke.mjs";
import { testMarkdownNoWrap } from "./markdown-nowrap-smoke.mjs";
import { testNewFileEncoding } from "./new-file-encoding-smoke.mjs";
import { testTerminalEnvironment } from "./terminal-environment-smoke.mjs";
import { testFolderShortcuts } from "./folder-shortcuts-smoke.mjs";
import { testPanelModes } from "./panel-modes-smoke.mjs";
import { testFileSort } from "./file-sort-smoke.mjs";
import { checkAddressFocusLoss, clickBreadcrumbAncestor, editPaneAddress } from "./pane-address-smoke.mjs";
import { testFolderNavigationHeader } from "./pane-header-smoke.mjs";
import { testFolderMeasurement } from "./folder-measurement-smoke.mjs";
import { makeDockerFixture, testCommandCompletion } from "./command-completion-smoke.mjs";
import { testCompareWorker } from "./compare-smoke.mjs";
import { testCompareLayouts } from "./compare-layouts-smoke.mjs";
import { testNewFolder } from "./new-folder-smoke.mjs";
import { testShortcutFields } from "./shortcut-field-smoke.mjs";
import { testTerminalHistory } from "./terminal-history-smoke.mjs";
import { testRetainedTerminalDirectory } from "./terminal-directory-smoke.mjs";
import { testNativeTerminalLinks } from "./terminal-links-smoke.mjs";
import { testNativeTerminalMenu, testTerminalPaste } from "./terminal-paste-smoke.mjs";
import { testAppearancePicker, testNativeAppearancePicker } from "./appearance-picker-smoke.mjs";
import { testArchives } from "./archive-smoke.mjs";
import { testFilenameRendering } from "./filename-rendering-smoke.mjs";
import { testInlineRename } from "./inline-rename-smoke.mjs";
import { testAlertDialogStyles, testBatchDeletion, testPermanentDelete } from "./permanent-delete-smoke.mjs";
import { testScreenColor } from "./screen-color-smoke.mjs";
import { testDocumentMode } from "./document-mode-smoke.mjs";
import { testDocumentWatch } from "./document-watch-smoke.mjs";
import { openMainMenu, revealMainMenu, testCommandIcons, testHeaderMenus } from "./menu-header-smoke.mjs";
import { testMcp } from "./mcp-smoke.mjs";
import { testProcessColumns } from "./process-columns-smoke.mjs";
import { testProcessQuickSearch } from "./process-quick-search-smoke.mjs";
import { testProcessExecutablePath } from "./process-executable-smoke.mjs";
import { testFolderLockInspector, testLockingProcessPane } from "./locking-process-pane-smoke.mjs";
import { testOsTimestamps } from "./os-timestamps-smoke.mjs";
import { testStoppedTransfer } from "./transfer-retry-smoke.mjs";
import { testNativeQuickView } from "./quick-view-smoke.mjs";
import { testNativeOptionalStatusBar } from "./status-bar-smoke.mjs";
import { appendDiagnosticFixture, checkDiagnosticLog } from "./diagnostic-log-smoke.mjs";
import { checkResizeMarker, closeToolWindow, keepSuggestedColorSchemeName, openOptionsWindow, testMarkdownOptionsDismissal } from "./tool-window-smoke.mjs";

if (process.platform !== "win32") throw new Error("This smoke test uses Windows WebView2.");
const profile = process.env.DIRLUME_BUILD_PROFILE ?? "release";
if (process.env.CI) {
  await testSmbNavigation();
  await testMountedSmbNavigation();
  await testFolderMeasurement();
  await testFolderNavigationHeader();
  await testSyntaxMenu();
  await testTerminalPaste();
  await testAppearancePicker();
  await testAlertDialogStyles();
}
const temp = await fixture("desktop-");
const build = resolve(`src-tauri/target/${profile}`);
const executable = join(temp, "Dirlume.exe");
await copyFile(join(build, "dirlume.exe"), executable);
await cp(join(build, "archive-tools"), join(temp, "archive-tools"), { recursive: true }).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
const dockerCompletionFixture = await makeDockerFixture(temp);
const src = join(temp, "from");
const dst = join(temp, "to");
const diagnostics = join(temp, "diagnostics");
const diagnosticsFile = join(diagnostics, "diagnostics.jsonl");
const attributes = join(temp, "attributes");
await mkdir(src);
await mkdir(dst);
await writeFile(join(src, ".hidden-file"), "Hidden file");
await mkdir(join(dst, ".hidden-folder"));
await mkdir(attributes);
await mkdir(join(attributes, ".metadata"));
await mkdir(join(attributes, "system-folder"));
await writeFile(join(attributes, "hidden.rs"), "Hidden source file");
await writeFile(join(attributes, "system-hidden.dll"), "System and hidden file");
await writeFile(join(attributes, "ordinary.sys"), "File without the System attribute");
for (const [name, flags] of [["hidden.rs", ["+H"]], ["system-folder", ["+S"]], ["system-hidden.dll", ["+S", "+H"]]]) {
  execFileSync("attrib.exe", [...flags, join(attributes, name)], { windowsHide: true });
}
await writeFile(join(src, "notes.txt"), "Dirlume\n");
await writeFile(join(src, "second.txt"), "Second file\n");
await writeFile(join(src, "guide.md"), "# Getting started\n\n**Dirlume** on Windows.\n\n```mermaid\nflowchart LR\n  A[Files] --> B[Preview]\n```\n");
await writeFile(join(src, "sample.rs"), "fn main() { let ready = true; }\n");
await writeFile(join(src, "control.bin"), Buffer.from([0xef, 0xbb, 0xbf, 0x41, 0, 9, 13, 10, 255]));
await copyFile(join(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), join(src, "sample-app.exe"));
await writeFile(join(src, "drag-file.txt"), "Dragged file");
await mkdir(join(src, "drag-folder"));
await writeFile(join(src, "drag-folder", "child.txt"), "Dragged folder");
await mkdir(join(src, "measured"));
await writeFile(join(src, "measured", "data.bin"), Buffer.alloc(12));
await mkdir(join(src, "overlap"));
await mkdir(join(dst, "overlap"));
await writeFile(join(src, "overlap", "data.bin"), Buffer.alloc(12));
await writeFile(join(src, "overlap", "other.bin"), Buffer.alloc(13, 7));
await writeFile(join(dst, "overlap", "data.bin"), Buffer.alloc(2, 1));
await writeFile(join(dst, "overlap", "other.bin"), Buffer.alloc(2, 2));
if (process.env.DIRLUME_CROSS_VOLUME_TEST_ROOT) {
  await writeFile(join(src, "volume.txt"), "Cross-volume move");
  await mkdir(join(src, "merge"));
  await writeFile(join(src, "merge", "update.txt"), "New contents");
}
let child;
let browser;
let otherVolume;
let lockedBy;

async function launchDesktop(program, storage) {
  const debuggingPort = await port();
  const childProcess = spawn(program, [], {
    windowsHide: true,
    env: {
      ...process.env,
      PATH: `${dockerCompletionFixture};${process.env.PATH ?? process.env.Path ?? ""}`,
      DOCKER_CONTEXT: "fixture-active",
      COMPOSE_FILE: "",
      DIRLUME_TEST_PROCESS_ONLY: "launcher-value",
      DIRLUME_TEST_SKIP_UPDATE_CHECK: "1",
      ...(process.env.DIRLUME_INTERNAL_CDP === "1"
        ? { DIRLUME_CDP_PORT: String(debuggingPort) }
        : { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${debuggingPort}` }),
      WEBVIEW2_USER_DATA_FOLDER: join(storage, "webview"),
      DIRLUME_FTP_TEST_CONFIG: join(temp, "ftp-config"),
      DIRLUME_SSH_TEST_CONFIG: join(temp, "ssh-config"),
      DIRLUME_TEST_DIAGNOSTICS_DIR: join(storage, "diagnostics"),
      DIRLUME_TEST_HIGHLIGHTS_DIR: join(storage, "release-highlights"),
    },
  });
  let startupError = "";
  let startupOutput = "";
  childProcess.on("error", (error) => { startupError = error.message; });
  childProcess.stderr.on("data", (chunk) => { startupOutput = (startupOutput + chunk).slice(-2500); });
  let connection;
  try {
    for (let attempt = 0; !connection; attempt++) {
      if (attempt === 100 || startupError || childProcess.exitCode !== null) {
        throw new Error(`The Windows WebView did not start. PID ${childProcess.pid}, exit code ${childProcess.exitCode}. ${startupError} ${startupOutput}`);
      }
      try {
        connection = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`, { timeout: 1000 });
      } catch {
        await setTimeout(250);
      }
    }
    const context = connection.contexts()[0];
    const page = context.pages()[0] ?? await context.waitForEvent("page", { timeout: 8000 });
    page.setDefaultTimeout(8000);
    await page.getByRole("heading", { name: "Dirlume" }).waitFor();
    const release = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("installed_release"));
    if (release.showOnStartup) {
      const whatsNew = page.getByRole("dialog", { name: "What's new", exact: true });
      for (const highlight of release.highlights) await whatsNew.getByText(highlight, { exact: true }).waitFor();
      await whatsNew.getByRole("button", { name: "Close", exact: true }).click();
      await whatsNew.waitFor({ state: "hidden" });
      assert.equal(await readFile(join(storage, "release-highlights", release.version), "utf8"), "");
    }
    return { process: childProcess, connection, page };
  } catch (error) {
    await connection?.close().catch(() => {});
    await close(childProcess);
    throw error;
  }
}

async function startDesktop() {
  const instance = await launchDesktop(executable, temp);
  child = instance.process;
  browser = instance.connection;
  return instance.page;
}

async function testDirectComputerPairing(guest) {
  const hostStorage = join(temp, "paired-desktop-host");
  await mkdir(hostStorage);
  const hostProgram = join(hostStorage, "Dirlume.exe");
  await copyFile(executable, hostProgram);
  const host = await launchDesktop(hostProgram, hostStorage);
  const systemDrive = process.env.SystemDrive ?? "C:";
  let name;
  try {
    assert.notEqual(host.process.pid, child.pid);
    name = await host.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("computer_name")) ?? "127.0.0.1";
    const share = await host.page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("start_desktop_computer_share", { address: "127.0.0.1" }));
    await guest.bringToFront();
    const options = await openOptionsWindow(guest);
    await options.getByRole("button", { name: "Computers", exact: true }).click();
    await options.getByText("Legacy pairing codes", { exact: true }).click();
    assert.equal(await options.getByLabel("Computer name", { exact: true }).count(), 0);
    await options.getByLabel("Pairing code", { exact: true }).evaluate((input, invitation) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, invitation);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, share.invitation);
    await options.getByRole("button", { name: "Pair computer", exact: true }).click();
    await options.getByRole("button", { name: `Forget ${name}`, exact: true }).waitFor();
    await closeToolWindow(options, () => options.getByRole("button", { name: "Done", exact: true }).click());

    for (const side of ["left", "right"]) {
      const pane = guest.getByRole("region", { name: `${side} pane`, exact: true });
      await pane.getByRole("button", { name: `Locations for ${side} pane`, exact: true }).click();
      const computer = pane.getByRole("group", { name, exact: true });
      const drive = computer.getByRole("button", { name: new RegExp(`^${systemDrive}`) });
      await drive.getByText("Fixed", { exact: true }).waitFor();
      await drive.getByText(/free of/).waitFor();
      await drive.click();
      await guest.waitForFunction(({ side, drive }) =>
        document.querySelector(`#${side}-path`)?.dataset.path === `/${drive}`, { side, drive: systemDrive });
      await pane.getByRole("option", { name: /^Windows(?:\s|$)/i }).waitFor();
    }
    await host.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("stop_desktop_share"));
    const left = guest.getByRole("region", { name: "left pane", exact: true });
    await left.getByRole("button", { name: "Locations for left pane", exact: true }).click();
    const offline = left.getByRole("group", { name, exact: true });
    await offline.getByRole("status").filter({ hasText: /could not|offline/i }).waitFor();
    assert.equal(await offline.getByRole("button").count(), 0);
    await left.getByRole("button", { name: "Locations for left pane", exact: true }).click();
    console.log("Verified native Dirlume-to-Dirlume pairing, drives in both panes, and revocation on a separate host process.");
  } finally {
    try {
      if (name && !guest.isClosed()) await guest.evaluate(async (label) => {
        const key = "dirlume.remote-connections";
        const profiles = JSON.parse(localStorage.getItem(key) ?? "[]");
        const paired = profiles.find((profile) => profile.label === label && profile.lan === true);
        if (paired) {
          await window.__TAURI_INTERNALS__.invoke("remove_server_invitation", { credential: paired.credential });
          localStorage.setItem(key, JSON.stringify(profiles.filter((profile) => profile.id !== paired.id)));
        }
      }, name);
    } finally {
      await host.connection.close().catch(() => {});
      await close(host.process);
    }
  }
}

async function exitDesktop(page) {
  const exit = new Promise((complete) => child.once("exit", complete));
  const closeKey = page.keyboard.press("F10").catch((error) => {
    if (!page.isClosed()) throw error;
  });
  const status = await Promise.race([exit, setTimeout(8000, "timeout", { ref: false })]);
  await closeKey;
  assert.equal(status, 0, "Dirlume should exit after closing a workspace with no unsaved changes.");
  await browser?.close().catch(() => {});
  browser = undefined;
}

try {
  let page = await startDesktop();
  async function startTransfer(action, destination = dst) {
    const setup = page.getByRole("dialog", { name: action === "Move" ? "Rename or move" : action, exact: true });
    await setup.waitFor();
    assert.equal(await setup.getByLabel("Destination", { exact: true }).inputValue(), destination);
    await setup.getByRole("button", { name: action, exact: true }).click();
  }
  async function waitForCompletedTransfer() {
    await page.locator("dialog[open]").first().waitFor({ state: "hidden" });
    await page.locator(".statusbar").getByText("Transfer complete", { exact: true }).waitFor();
  }
  async function finishTransfer(action, destination = dst) {
    await startTransfer(action, destination);
    await waitForCompletedTransfer();
  }
  const pageErrors = [];
  page.on("pageerror", (error) => { pageErrors.push(error.message); });
  await page.getByRole("heading", { name: "Dirlume" }).waitFor();
  assert.equal(await page.locator(".topbar-scheme").count(), 0, "The scheme picker is hidden by default.");
  await page.waitForFunction(() => window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "main" }));
  const resizeMain = page.locator(".statusbar > .window-resize-marker");
  await checkResizeMarker(resizeMain);
  assert.equal(await resizeMain.evaluate((marker) => {
    const status = marker.parentElement.querySelector("span:last-of-type")?.getBoundingClientRect();
    return !!status && status.right < marker.getBoundingClientRect().left;
  }), true);
  await page.getByRole("button", { name: "Maximize window" }).click();
  await resizeMain.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Restore window" }).click();
  await page.getByRole("button", { name: "Maximize window" }).waitFor();
  await checkResizeMarker(resizeMain);
  assert.equal(await page.locator(".window-titlebar").getAttribute("data-tauri-drag-region"), "deep");
  assert.equal(await page.locator(".window-controls").getAttribute("data-tauri-drag-region"), "false");
  await testHeaderMenus(page, true);
  await testCommandIcons(page, true);
  await testNativeOptionalStatusBar(page);
  await testNativeTerminalMenu(page);
  const paneDivider = page.getByRole("separator", { name: "Pane divider" });
  async function dragHorizontally(handle, delta) {
    const bounds = await handle.boundingBox();
    assert.ok(bounds);
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + delta, y, { steps: 6 });
    await page.mouse.up();
  }
  const paneSplit = async () => Number(await paneDivider.getAttribute("aria-valuenow"));
  await dragHorizontally(paneDivider, 150);
  assert.ok(await paneSplit() >= 55);
  await paneDivider.dblclick();
  assert.equal(await paneSplit(), 50);
  await dragHorizontally(paneDivider, -150);
  assert.ok(await paneSplit() <= 45, "The splitter should move freely after being reset with a double-click.");
  await paneDivider.dblclick();
  assert.equal(await paneSplit(), 50);
  const bundledFamily = "GoMono Nerd Font Mono";
  const defaultFonts = await page.evaluate(async (family) => {
    const styles = ["400", "700", "italic 400", "italic 700"];
    const loaded = await Promise.all(styles.map((style) => document.fonts.load(`${style} 18px "${family}"`, "Dirlume Україна")));
    const root = getComputedStyle(document.documentElement);
    const groups = ["ui", "panel", "dialog", "viewer", "editor", "terminal"];
    return {
      faces: loaded.map((faces) => faces.length > 0 && faces.every((face) => face.status === "loaded")),
      bundled: groups.map((group) => root.getPropertyValue(`--${group}-font`).trim().startsWith(`"${family}"`)),
      system: groups.map((group) => root.getPropertyValue(`--${group}-font`).trim()
        .startsWith(root.getPropertyValue("--system-font").trim())),
      sizes: groups.map((group) => root.getPropertyValue(`--${group}-size`).trim()),
    };
  }, bundledFamily);
  assert.deepEqual(defaultFonts.faces, [true, true, true, true]);
  assert.deepEqual(defaultFonts.bundled, [false, true, false, true, true, true]);
  assert.deepEqual(defaultFonts.system, [true, false, true, false, false, false]);
  assert.deepEqual(defaultFonts.sizes, ["14px", "15px", "14px", "18px", "18px", "18px"]);
  assert.equal(await page.getByRole("button", { name: "Find files" }).getAttribute("data-tooltip"), "Find files (Alt+F7)");
  assert.equal(await page.getByRole("region", { name: "right pane" }).getByRole("button", { name: "Refresh folder" }).getAttribute("data-tooltip"), "Refresh folder");
  assert.deepEqual(await page.locator("button:visible").evaluateAll((buttons) =>
    buttons.filter((button) => !button.closest(".address-ancestor") && !button.dataset.tooltip?.trim()).map((button) => button.textContent)), []);
  await page.waitForFunction(() => ["left", "right"].every((side) =>
    document.getElementById(`${side}-path`)?.dataset.path &&
    document.getElementById(`${side}-files`)?.getAttribute("aria-busy") === "false"));
  const tooltip = page.getByRole("tooltip");
  await page.getByRole("button", { name: "Find files" }).dispatchEvent("pointerover", { pointerType: "mouse" });
  await tooltip.filter({ hasText: /^Find files \(Alt\+F7\)$/ }).waitFor();
  await page.keyboard.press("Escape");
  await tooltip.waitFor({ state: "hidden" });
  async function checkTooltip(button, expected) {
    await button.dispatchEvent("pointerover", { pointerType: "mouse" });
    if (expected) {
      await tooltip.waitFor();
      assert.equal(await tooltip.textContent(), expected);
    } else {
      await button.evaluate(() => new Promise((resolve) => setTimeout(resolve, 525)));
      assert.equal(await tooltip.isVisible(), false);
    }
    await button.dispatchEvent("pointerout", { pointerType: "mouse" });
    await tooltip.waitFor({ state: "hidden" });
  }
  const rightTools = page.getByRole("region", { name: "right pane", exact: true });
  await checkTooltip(rightTools.getByRole("button", { name: "Refresh folder", exact: true }), "Refresh folder");
  const leftTools = page.getByRole("region", { name: "left pane", exact: true });
  const locationsTrigger = leftTools.getByRole("button", { name: "Locations for left pane", exact: true });
  await locationsTrigger.click();
  const netboxSource = leftTools.getByRole("button", { name: "NetBox", exact: true });
  assert.equal(await netboxSource.locator("kbd").innerText(), "2");
  const homeLocation = leftTools.getByRole("button", { name: "Home", exact: true });
  const homePath = await homeLocation.getAttribute("data-tooltip");
  assert.ok(homePath && homePath !== "Home");
  await checkTooltip(homeLocation, homePath);
  await checkTooltip(netboxSource);
  await locationsTrigger.click();
  await testNativeAppearancePicker(page);
  function editAddress(side) {
    return editPaneAddress(page, side);
  }
  const panePath = (side) => page.locator(`#${side}-path`).getAttribute("data-path");
  for (const side of ["left", "right"]) {
    const path = await panePath(side);
    const breadcrumbs = page.getByRole("navigation", { name: `${side} path breadcrumbs` });
    const blankArea = await breadcrumbs.boundingBox();
    assert.ok(blankArea);
    await breadcrumbs.click({ position: { x: blankArea.width - 8, y: blankArea.height / 2 } });
    const input = page.getByRole("combobox", { name: `${side} path`, exact: true });
    assert.equal(await input.inputValue(), path);
    assert.equal(await input.evaluate((field) => field === document.activeElement), true);
    await input.press("Escape");
    await breadcrumbs.waitFor();
    assert.equal(await panePath(side), path);
  }
  async function navigate(side, path) {
    const input = await editAddress(side);
    await input.fill(path);
    await input.press("Enter");
    try {
      await page.getByRole("region", { name: `${side} pane`, exact: true })
        .getByRole("heading", { name: path.split(/[\\/]/).filter(Boolean).at(-1), exact: true }).waitFor({ state: "attached" });
      await page.waitForFunction((side) => document.getElementById(`${side}-files`)?.getAttribute("aria-busy") === "false", side);
    } catch (error) {
      throw new Error(`Could not navigate the ${side} pane: ${await page.getByRole("alert").allTextContents()}`, { cause: error });
    }
  }
  let diagnosticsBeforeRestart;
  await testFilenameRendering(page, temp);
  if (process.env.DIRLUME_INTERNAL_CDP === "1") {
    const secret = "dirlume-private-fixture-data";
    await page.evaluate(async (path) => {
      for (let action = 0; action < 34; action++) {
        await window.__TAURI_INTERNALS__.invoke("list_directory", { path });
      }
    }, src);
    const address = await editAddress("left");
    await address.fill(join(src, secret));
    await address.press("Enter");
    await page.locator("#left-pane").getByRole("alert").waitFor();
    await page.evaluate((secret) => {
      const error = new TypeError(secret);
      const filename = document.querySelector('script[type="module"][src]').src;
      window.dispatchEvent(new ErrorEvent("error", { error, message: secret, filename, lineno: 1, colno: 1 }));
      window.dispatchEvent(new ErrorEvent("error", { error, message: secret }));
    }, secret);
    for (let attempt = 0; attempt < 50; attempt++) {
      diagnosticsBeforeRestart = await readFile(diagnosticsFile, "utf8").catch(() => "");
      if (diagnosticsBeforeRestart.includes('"code":"type_error"') &&
          diagnosticsBeforeRestart.includes('"operation":"list_directory","code":')) break;
      await setTimeout(100);
    }
    const records = diagnosticsBeforeRestart.trim().split("\n").map((line) => JSON.parse(line));
    const nativeErrors = records.filter(({ operation }) => operation === "list_directory");
    assert.equal(nativeErrors.length, 1, "The IPC failure and UI error use one log entry.");
    assert.equal(nativeErrors[0].recentActions.length, 32);
    assert.ok(nativeErrors[0].recentActions.every(({ operation }) => operation === "list_directory"));
    const frontendErrors = records.filter(({ code }) => code === "type_error");
    assert.equal(frontendErrors.length, 1);
    const { build, origin, source, surface } = frontendErrors[0].frontend;
    assert.ok(build);
    assert.equal(origin, "window_error");
    assert.equal(surface, "main");
    assert.match(source.asset, /^index-[\w-]{8}\.js$/);
    assert.equal(source.line, 1);
    assert.equal(source.column, 1);
    assert.ok(!diagnosticsBeforeRestart.includes(secret), "Diagnostic records contain safe codes and operation names only.");
  }
  const fontSize = (selector) => page.locator(selector).evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  async function wheelFont(selector, deltaY, modifier = "Control") {
    await page.locator(selector).hover();
    if (modifier) await page.keyboard.down(modifier);
    try {
      await page.mouse.wheel(0, deltaY);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    } finally {
      if (modifier) await page.keyboard.up(modifier);
    }
  }
  await navigate("left", src);
  await navigate("right", dst);
  const driveName = /^[a-z]:/i.exec(parse(src).root)?.[0]?.toUpperCase();
  assert.ok(driveName, "The Windows test folders must be on a lettered drive.");
  const leftDrive = page.locator("#left-pane .location-popup").getByRole("button", { name: driveName, exact: true });
  await page.locator("#left-files").press("Alt+F1");
  await leftDrive.waitFor();
  await page.keyboard.press(driveName[0]);
  await leftDrive.waitFor({ state: "hidden" });
  await page.waitForFunction((path) => document.getElementById("left-path")?.dataset.path === path, dst);
  assert.equal(await panePath("right"), dst);
  await navigate("left", src);
  await page.locator("#right-files").press("Alt+F2");
  await page.locator("#right-pane .location-popup").getByRole("button", { name: driveName, exact: true }).click();
  await page.waitForFunction((path) => document.getElementById("right-path")?.dataset.path === path, src);
  assert.equal(await panePath("left"), src);
  await navigate("right", dst);
  const branchFolder = join(src, "breadcrumb-branch");
  const branchLeaf = join(branchFolder, "breadcrumb-leaf");
  await mkdir(branchLeaf, { recursive: true });
  await writeFile(join(branchLeaf, "focus-fixture.txt"), "address focus fixture");
  for (const side of ["left", "right"]) {
    await navigate(side, branchLeaf);
    await checkAddressFocusLoss(page, side, branchLeaf, "focus-fixture.txt", "breadcrumb-branch");
  }
  await navigate("right", dst);
  await navigate("left", branchLeaf);
  const leftBreadcrumbs = page.getByRole("navigation", { name: "left path breadcrumbs" });
  const currentCrumb = leftBreadcrumbs.locator('[aria-current="location"]');
  const forwardCrumbs = leftBreadcrumbs.locator(".address-forward");
  await clickBreadcrumbAncestor(leftBreadcrumbs, "from");
  await currentCrumb.getByText("from", { exact: true }).waitFor();
  await forwardCrumbs.locator(".address-ancestor").filter({ hasText: "breadcrumb-leaf" }).waitFor({ state: "attached" });
  await clickBreadcrumbAncestor(leftBreadcrumbs, "breadcrumb-branch");
  await page.waitForFunction(() => document.querySelector("#left-path [aria-current=location]")?.textContent === "breadcrumb-branch");
  await clickBreadcrumbAncestor(leftBreadcrumbs, "breadcrumb-leaf");
  await page.waitForFunction((path) => document.getElementById("left-path")?.dataset.path === path &&
    document.getElementById("left-files")?.getAttribute("aria-busy") === "false", branchLeaf);
  await forwardCrumbs.waitFor({ state: "hidden" });
  assert.equal(await currentCrumb.innerText(), "breadcrumb-leaf");
  await clickBreadcrumbAncestor(leftBreadcrumbs, "from");
  await forwardCrumbs.waitFor({ state: "attached" });
  await navigate("left", dst);
  await navigate("left", src);
  await forwardCrumbs.waitFor({ state: "hidden" });
  if (process.env.DIRLUME_BUNDLED_FONT_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_BUNDLED_FONT_SCREENSHOT, scale: "css" });
  const leftList = page.getByRole("listbox", { name: "left files", exact: true });
  const rightList = page.getByRole("listbox", { name: "right files", exact: true });
  const parentRow = '[role="option"][data-tooltip=".."]';
  const emptyFolder = join(temp, "empty");
  await mkdir(emptyFolder);
  const populatedFolder = join(temp, "enter-navigation");
  await mkdir(populatedFolder);
  await writeFile(join(populatedFolder, "first.txt"), "Enter navigation fixture");
  for (const [side, list] of [["left", leftList], ["right", rightList]]) {
    const pane = page.getByRole("region", { name: `${side} pane`, exact: true });
    const otherSide = side === "left" ? "right" : "left";
    const otherPath = await panePath(otherSide);
    const up = pane.getByRole("button", { name: "Parent folder", exact: true });
    await navigate(side, emptyFolder);
    await list.locator(parentRow).waitFor();
    assert.equal(await list.getByRole("option").count(), 1);
    await up.click();
    await pane.getByRole("heading", { name: parse(temp).base, exact: true }).waitFor({ state: "attached" });
    await list.locator('[data-current="true"][data-tooltip="empty"]').waitFor();
    const column = pane.getByRole("button", { name: /^Name/ });
    await column.click();
    await pane.getByRole("button", { name: "Filter folder", exact: true }).click();
    await pane.getByRole("textbox", { name: `Filter ${side} folder`, exact: true }).fill("no match");
    assert.equal(await list.getByRole("option").count(), 1);
    assert.equal(await list.getByRole("option").first().getAttribute("data-tooltip"), "..");
    await pane.getByRole("button", { name: "Close filter", exact: true }).click();
    assert.equal(await list.getByRole("option").first().getAttribute("data-tooltip"), "..");
    await column.click();
    await navigate(side, emptyFolder);
    await list.press("ArrowLeft");
    assert.equal(await list.locator(parentRow).getAttribute("data-current"), "true");
    assert.equal(await list.locator(parentRow).evaluate((row) => row.draggable), false);
    assert.equal(await page.getByRole("navigation", { name: "File actions" }).getByRole("button", { name: "Copy", exact: true }).isEnabled(), false);
    await list.press("Enter");
    await pane.getByRole("heading", { name: parse(temp).base, exact: true }).waitFor({ state: "attached" });
    await list.locator('[data-current="true"][data-tooltip="empty"]').waitFor();
    const populatedRow = list.locator('[role="option"][data-tooltip="enter-navigation"]');
    await populatedRow.click();
    await list.press("Enter");
    await list.locator('[role="option"][data-tooltip="first.txt"]').waitFor();
    await list.locator(`${parentRow}[data-current="true"]`).waitFor();
    assert.equal(await list.evaluate((element) => document.activeElement === element), true);
    await list.press("Enter");
    await populatedRow.and(list.locator('[data-current="true"]')).waitFor();
    assert.equal(await panePath(otherSide), otherPath);
    await navigate(side, parse(temp).root);
    assert.equal(await list.locator(parentRow).count(), 0);
    assert.equal(await up.isEnabled(), false);
    await navigate(side, side === "left" ? src : dst);
  }
  await leftList.getByRole("option", { name: /^notes\.txt/ }).click();
  await page.keyboard.press("Control+a");
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), "",
    "Ctrl+A in a file pane must not highlight the workspace text.");
  const selectAllAttributes = page.getByRole("dialog", { name: "Attributes", exact: true });
  await selectAllAttributes.waitFor();
  await page.keyboard.press("Escape");
  await selectAllAttributes.waitFor({ state: "hidden" });
  await leftList.evaluate((list) => list.blur());
  await page.keyboard.press("Control+a");
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), "",
    "Ctrl+A with focus on the workspace background must not highlight the interface.");
  const pathField = await editAddress("left");
  await pathField.press("Control+a");
  assert.deepEqual(await pathField.evaluate((field) => [field.selectionStart, field.selectionEnd]),
    [0, src.length], "Ctrl+A must still select the text in the address field.");

  const hiddenFile = leftList.getByRole("option", { name: /^\.hidden-file/ });
  const hiddenFolder = rightList.getByRole("option", { name: /^\.hidden-folder/ });
  const hiddenToggle = page.getByRole("button", { name: "Show hidden files", exact: true });
  const optionsButton = page.getByRole("button", { name: "Options", exact: true });
  let optionsPage;
  let options;
  const ukrainianCtrlH = { key: "р", code: "KeyH", ctrlKey: true, bubbles: true };
  await hiddenFile.waitFor({ state: "detached" });
  await hiddenFolder.waitFor({ state: "detached" });
  await leftList.press("Control+h");
  await hiddenFile.waitFor();
  await hiddenFolder.waitFor();
  assert.equal(await hiddenToggle.getAttribute("aria-pressed"), "true");
  optionsPage = await openOptionsWindow(page, () => optionsButton.click());
  options = optionsPage.getByRole("dialog", { name: "Options", exact: true });
  await options.getByRole("button", { name: "General", exact: true }).click();
  const menuPosition = options.getByRole("combobox", { name: "Main menu position" });
  assert.equal(await menuPosition.inputValue(), "center");
  for (const alignment of ["left", "right", "center"]) {
    await menuPosition.selectOption(alignment);
    await options.getByRole("button", { name: "Apply", exact: true }).click();
    await page.locator(`.topbar[data-menu-position="${alignment}"]`).waitFor();
  }
  const productVersion = JSON.parse(await readFile("package.json", "utf8")).version;
  const buildNumber = process.env.DIRLUME_BUILD_NUMBER;
  await options.getByText(buildNumber ? `${productVersion}+${buildNumber}` : productVersion, { exact: true }).waitFor();
  await options.getByRole("button", { name: "Main File Panels", exact: true }).click();
  assert.equal(await options.getByRole("checkbox", { name: "Show hidden files" }).isChecked(), true);
  await closeToolWindow(optionsPage, () => options.getByRole("button", { name: "Done", exact: true }).click());
  await rightList.focus();
  await rightList.dispatchEvent("keydown", ukrainianCtrlH);
  await hiddenFile.waitFor({ state: "detached" });
  await hiddenFolder.waitFor({ state: "detached" });
  assert.equal(await hiddenToggle.getAttribute("aria-pressed"), "false");

  optionsPage = await openOptionsWindow(page, () => optionsButton.click());
  options = optionsPage.getByRole("dialog", { name: "Options", exact: true });
  assert.equal(await options.getByRole("checkbox", { name: "Show hidden files" }).isChecked(), false);
  const shortcuts = options.getByRole("button", { name: "Keyboard shortcuts", exact: true });
  await shortcuts.click();
  await options.getByRole("button", { name: "Remove Ctrl+H from Show or hide hidden files", exact: true }).click();
  await closeToolWindow(optionsPage, () => options.getByRole("button", { name: "Done", exact: true }).click());
  await checkTooltip(hiddenToggle, "Show hidden files");
  await rightList.focus();
  await rightList.dispatchEvent("keydown", ukrainianCtrlH);
  await rightList.press("Control+h");
  assert.equal(await hiddenToggle.getAttribute("aria-pressed"), "false");

  optionsPage = await openOptionsWindow(page, () => optionsButton.click());
  options = optionsPage.getByRole("dialog", { name: "Options", exact: true });
  await options.getByRole("button", { name: "Add shortcut for Show or hide hidden files", exact: true }).click();
  await options.getByRole("textbox", { name: "New shortcut for Show or hide hidden files" }).press("Control+Shift+h");
  await closeToolWindow(optionsPage, () => options.getByRole("button", { name: "Done", exact: true }).click());
  await checkTooltip(hiddenToggle, "Show hidden files (Ctrl+Shift+H)");
  await leftList.press("Control+Shift+h");
  await hiddenFile.waitFor();
  await hiddenFolder.waitFor();
  await leftList.press("Control+Shift+h");
  await hiddenFile.waitFor({ state: "detached" });
  optionsPage = await openOptionsWindow(page, () => optionsButton.click());
  options = optionsPage.getByRole("dialog", { name: "Options", exact: true });
  await options.getByRole("button", { name: "Add shortcut for Show or hide hidden files", exact: true }).click();
  await options.getByRole("textbox", { name: "New shortcut for Show or hide hidden files" }).press("Home");
  const shortcutConflict = () => optionsPage.getByRole("dialog", { name: "Shortcut conflict" });
  await shortcutConflict().getByText("Home is assigned to First item.", { exact: true }).waitFor();
  await shortcutConflict().getByRole("button", { name: "Reassign shortcut", exact: true }).click();
  await options.getByRole("button", { name: "Change ← for Previous page or first item", exact: true }).waitFor();
  await options.getByRole("button", { name: "Add shortcut for First item", exact: true }).waitFor();
  await options.getByRole("button", { name: "Change F2 for Save text", exact: true }).waitFor();
  assert.equal(await options.getByRole("button", { name: "Change Home for First item", exact: true }).count(), 0);
  await closeToolWindow(optionsPage, () => options.getByRole("button", { name: "Done", exact: true }).click());
  await leftList.press("Home");
  await hiddenFile.waitFor();
  await leftList.press("Control+Shift+h");
  await hiddenFile.waitFor({ state: "detached" });
  optionsPage = await openOptionsWindow(page, () => optionsButton.click());
  options = optionsPage.getByRole("dialog", { name: "Options", exact: true });
  const shortcutScheme = () => options.getByRole("combobox", { name: "Shortcut scheme", exact: true });
  assert.equal(await shortcutScheme().locator("option:checked").textContent(), "My shortcuts");
  await options.getByRole("button", { name: "New scheme", exact: true }).click();
  const newShortcutScheme = optionsPage.getByRole("dialog", { name: "New shortcut scheme", exact: true });
  const schemeName = newShortcutScheme.getByRole("textbox", { name: "Scheme name", exact: true });
  await schemeName.fill("My shortcuts");
  await newShortcutScheme.getByRole("alert").waitFor();
  await schemeName.fill("Smoke shortcuts");
  await newShortcutScheme.getByRole("button", { name: "Create", exact: true }).click();
  assert.equal(await shortcutScheme().locator("option:checked").textContent(), "Smoke shortcuts");
  await options.getByRole("button", { name: "Remove Home from Show or hide hidden files", exact: true }).click();
  await shortcutScheme().selectOption({ label: "My shortcuts" });
  await options.getByRole("button", { name: "Change Home for Show or hide hidden files", exact: true }).waitFor();
  await shortcutScheme().selectOption({ label: "Smoke shortcuts" });
  assert.equal(await options.getByRole("button", { name: "Change Home for Show or hide hidden files", exact: true }).count(), 0);
  await options.getByRole("button", { name: "Rename shortcut scheme", exact: true }).click();
  const renameShortcutScheme = optionsPage.getByRole("dialog", { name: "Rename shortcut scheme", exact: true });
  await renameShortcutScheme.getByRole("textbox", { name: "Scheme name", exact: true }).fill("Renamed shortcuts");
  await renameShortcutScheme.getByRole("button", { name: "Save", exact: true }).click();
  assert.equal(await shortcutScheme().locator("option:checked").textContent(), "Renamed shortcuts");
  await options.getByRole("button", { name: "Delete shortcut scheme", exact: true }).click();
  await optionsPage.getByRole("dialog", { name: "Delete shortcut scheme", exact: true }).getByRole("button", { name: "Delete scheme", exact: true }).click();
  assert.equal(await shortcutScheme().inputValue(), "");
  await closeToolWindow(optionsPage, () => options.getByRole("button", { name: "Done", exact: true }).click());
  await leftList.press("Control+h");
  await hiddenFile.waitFor();
  await leftList.press("Control+h");
  await hiddenFile.waitFor({ state: "detached" });
  optionsPage = await openOptionsWindow(page, () => optionsButton.click());
  options = optionsPage.getByRole("dialog", { name: "Options", exact: true });
  assert.equal(await shortcutScheme().inputValue(), "");
  await shortcutScheme().selectOption({ label: "My shortcuts" });
  await options.getByRole("button", { name: "Change Home for Show or hide hidden files", exact: true }).waitFor();
  await options.getByRole("button", { name: "Restore defaults" }).click();
  await options.getByRole("button", { name: "General", exact: true }).click();
  await closeToolWindow(optionsPage, () => options.getByRole("button", { name: "Done", exact: true }).click());
  console.log("Verified independent shortcut schemes, switching, duplicate-name validation, renaming, and deletion.");

  const leftFont = await fontSize("#left-pane");
  const rightFont = await fontSize("#right-pane");
  const activePane = await page.locator(".pane.active").getAttribute("id");
  await wheelFont("#left-files", -120);
  assert.ok(await fontSize("#left-pane") > leftFont, "Ctrl+Wheel should enlarge the hovered pane's font.");
  assert.equal(await fontSize("#right-pane"), rightFont);
  assert.equal(await page.locator(".pane.active").getAttribute("id"), activePane);
  await wheelFont("#left-files", 120);
  await wheelFont("#right-files", -120);
  assert.equal(await fontSize("#left-pane"), leftFont);
  assert.ok(await fontSize("#right-pane") > rightFont);
  await wheelFont("#right-files", 120);
  await wheelFont("#right-files", -120, "");
  assert.equal(await fontSize("#right-pane"), rightFont, "Unmodified wheel input should leave font size alone.");
  const leftAddress = page.getByLabel("left path", { exact: true });
  const leftSuggestions = page.getByRole("listbox", { name: "left path suggestions", exact: true });
  await (await editAddress("left")).fill(join(src, "me"));
  await leftSuggestions.getByRole("option", { name: "measured", exact: true }).waitFor();
  if (process.env.DIRLUME_ADDRESS_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_ADDRESS_SCREENSHOT, scale: "css" });
  await leftAddress.press("Tab");
  assert.equal(await leftAddress.inputValue(), join(src, "measured") + "\\");
  await leftAddress.press("Enter");
  const filePane = page.getByRole("region", { name: "left pane", exact: true });
  await filePane.getByRole("heading", { name: "measured", exact: true }).waitFor({ state: "attached" });
  await (await editAddress("left")).fill(join(src, "ov"));
  await leftSuggestions.getByRole("option", { name: "overlap", exact: true }).click();
  await filePane.getByRole("heading", { name: "overlap", exact: true }).waitFor({ state: "attached" });
  await (await editAddress("left")).fill(join(src, "me"));
  await leftSuggestions.getByRole("option", { name: "measured", exact: true }).waitFor();
  await leftAddress.press("ArrowDown");
  await leftSuggestions.getByRole("option", { name: "measured", selected: true }).waitFor();
  await leftAddress.press("Enter");
  await filePane.getByRole("heading", { name: "measured", exact: true }).waitFor({ state: "attached" });
  await navigate("left", src);
  const copySetup = page.getByRole("dialog", { name: "Copy", exact: true });
  const destination = copySetup.getByRole("combobox", { name: "Destination", exact: true });
  const destinationSuggestions = copySetup.getByRole("listbox", { name: "Destination suggestions", exact: true });
  await filePane.getByRole("option", { name: /^notes\.txt/ }).click();
  await openMainMenu(page, "Commands");
  const copyPath = page.getByRole("menuitem", { name: "Copy full path", exact: true });
  assert.equal(await copyPath.getAttribute("aria-disabled"), null);
  assert.equal(await copyPath.locator("kbd").textContent(), "Ctrl+Shift+C");
  await page.keyboard.press("Escape");
  if (process.env.CI) {
    const clipboardText = () => execFileSync("powershell.exe", ["-NoProfile", "-Command",
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Write((Get-Clipboard -Raw))"],
    { encoding: "utf8", windowsHide: true });
    async function expectClipboard(path) {
      let text;
      for (let attempt = 0; attempt < 20; attempt++) {
        text = clipboardText();
        if (text === path) return;
        await setTimeout(100);
      }
      assert.equal(text, path);
    }
    await leftList.press("Control+Shift+c");
    await page.locator(".statusbar").getByText("Path copied to the clipboard.", { exact: true }).waitFor();
    await expectClipboard(join(src, "notes.txt"));
    await filePane.getByRole("option", { name: /^drag-folder/ }).click();
    await openMainMenu(page, "Commands");
    await copyPath.click();
    await expectClipboard(join(src, "drag-folder"));
    await filePane.getByRole("option", { name: /^notes\.txt/ }).click();
  }
  await (await revealMainMenu(page)).getByRole("menuitem", { name: "Left", exact: true }).focus();
  await leftList.focus();
  await page.keyboard.press("F5");
  const browseDestination = copySetup.getByRole("button", { name: "Choose a file destination", exact: true });
  await browseDestination.waitFor();
  assert.equal(await browseDestination.evaluate((button) => button.previousElementSibling?.matches(".editable-dropdown")), true);
  await destination.fill(join(temp, "t"));
  await destinationSuggestions.getByRole("option", { name: "to", exact: true }).waitFor();
  await destination.press("Tab");
  assert.equal(await destination.inputValue(), dst + "\\");
  await destinationSuggestions.getByRole("option", { name: "overlap", exact: true }).waitFor();
  await destination.press("Escape");
  assert.equal(await destinationSuggestions.count(), 0);
  assert.equal(await copySetup.isVisible(), true);
  await destination.fill(join(src, "sec"));
  await destinationSuggestions.getByRole("option", { name: "second.txt", exact: true }).click();
  assert.equal(await destination.inputValue(), join(src, "second.txt"));
  await copySetup.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.keyboard.press("F5");
  await copySetup.getByRole("button", { name: "Show entry history" }).click();
  await copySetup.getByRole("listbox", { name: "Entry history", exact: true })
    .getByRole("option", { name: join(src, "second.txt"), exact: true }).waitFor();
  await destination.press("ArrowDown");
  await destination.press("Enter");
  assert.equal(await destination.inputValue(), join(src, "second.txt"));
  await copySetup.getByRole("button", { name: "Cancel", exact: true }).click();
  await filePane.getByRole("option", { name: /^measured/ }).click();
  await page.keyboard.press("F5");
  await copySetup.getByRole("button", { name: "Browse for a folder", exact: true }).waitFor();
  await copySetup.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("listbox", { name: "left files", exact: true }).focus();
  await page.keyboard.press("Alt+F7");
  const search = page.getByRole("dialog", { name: "Find files", exact: true });
  const mask = search.getByRole("textbox", { name: "File mask", exact: true });
  await mask.fill("*.missing");
  await mask.press("Enter");
  await search.getByText("No matching files.", { exact: true }).waitFor();
  await mask.fill("DATA.B?N");
  await search.getByRole("button", { name: "Search", exact: true }).click();
  await search.getByText("2 matches.", { exact: true }).waitFor();
  const matches = search.getByRole("listbox", { name: "Search results", exact: true });
  await matches.getByRole("option", { name: "overlap/data.bin", exact: true }).waitFor();
  await matches.selectOption("measured/data.bin");
  if (process.env.DIRLUME_SEARCH_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_SEARCH_SCREENSHOT, scale: "css" });
  await search.getByRole("button", { name: "Show in panel", exact: true }).click();
  const leftPane = page.getByRole("region", { name: "left pane", exact: true });
  const left = leftPane.getByRole("listbox", { name: "left files", exact: true });
  const right = page.getByRole("listbox", { name: "right files", exact: true });
  await leftPane.getByRole("heading", { name: "Search results", exact: true }).waitFor();
  assert.equal(await left.locator(parentRow).count(), 0);
  await left.getByRole("option", { name: /measured\/data\.bin/, selected: true }).waitFor();
  await left.getByRole("option", { name: /overlap\/data\.bin/ }).waitFor();
  await page.keyboard.press("F5");
  await finishTransfer("Copy");
  assert.deepEqual(await readFile(join(dst, "data.bin")), Buffer.alloc(12));
  const searchSource = join(src, "search-action");
  const searchTarget = join(temp, "search-target");
  await mkdir(searchSource);
  await mkdir(searchTarget);
  const searchInput = join(searchSource, "data.bin");
  await writeFile(searchInput, "Search actions");
  const searchResult = left.getByRole("option", { name: /search-action\/data\.bin/ });
  const searchRefresh = leftPane.getByRole("button", { name: "Refresh", exact: true });
  await searchRefresh.click();
  await searchResult.click();
  await left.press("F6");
  const searchMove = page.getByRole("dialog", { name: "Rename or move", exact: true });
  const searchDestination = searchMove.getByLabel("Destination", { exact: true });
  assert.equal(await searchDestination.inputValue(), dst);
  await searchDestination.fill(searchTarget);
  await searchMove.getByRole("button", { name: "Move", exact: true }).click();
  await waitForCompletedTransfer();
  await searchResult.waitFor({ state: "detached" });
  assert.equal(await readFile(join(searchTarget, "data.bin"), "utf8"), "Search actions");
  await assert.rejects(readFile(searchInput), { code: "ENOENT" });
  await writeFile(searchInput, "Delete from Search results");
  await left.press("Control+r");
  await searchResult.click();
  await left.press("Shift+Delete");
  const searchDelete = page.getByRole("dialog", { name: "Delete permanently", exact: true });
  await searchDelete.getByRole("button", { name: "Delete permanently", exact: true }).click();
  await searchResult.waitFor({ state: "detached" });
  await assert.rejects(readFile(searchInput), { code: "ENOENT" });
  await rmdir(searchSource);
  await left.getByRole("option", { name: /measured\/data\.bin/ }).click();
  await leftPane.getByRole("button", { name: "Go to selected file", exact: true }).click();
  await page.getByRole("heading", { name: "measured", exact: true }).waitFor({ state: "attached" });
  await page.getByRole("option", { name: /^data.bin/, selected: true }).waitFor();
  const bulk = join(temp, "bulk");
  await mkdir(bulk);
  for (let start = 0; start < 10_000; start += 100) {
    await Promise.all(Array.from({ length: 100 }, (_, offset) => {
      const index = start + offset;
      const name = index < 1005 ? `file-${index}.tmp` : `unmatched-${index}.dat`;
      return writeFile(join(bulk, name), "");
    }));
  }
  const openBulk = performance.now();
  await navigate("left", bulk);
  await left.getByRole("option", { name: /^file-0.tmp/ }).waitFor();
  const mountedRows = await left.getByRole("option").count();
  assert.ok(mountedRows < 100, `Mounted ${mountedRows} rows for 10,000 entries.`);
  await left.focus();
  await left.press("ArrowRight");
  const tail = left.getByRole("option", { name: /^unmatched-9999.dat/, selected: true });
  await tail.waitFor();
  assert.equal(await tail.getAttribute("aria-posinset"), "10001");
  assert.equal(await left.getAttribute("aria-activedescendant"), await tail.getAttribute("id"));
  await left.evaluate((list) => { list.scrollTop = list.scrollHeight / 2; });
  await left.getByRole("option", { name: /^unmatched-5000.dat/ }).waitFor();
  assert.ok(await left.getByRole("option").count() < 100);
  assert.equal(await left.getAttribute("aria-activedescendant"), await tail.getAttribute("id"));
  await left.press("ArrowLeft");
  await left.getByRole("option", { name: /^\.\./, selected: true }).waitFor();
  console.log(`Mounted ${mountedRows} rows for 10,000 files in ${Math.round(performance.now() - openBulk)} ms including keyboard jumps and scrolling.`);
  await page.keyboard.press("Alt+F7");
  await mask.fill("*.tmp");
  await mask.press("Enter");
  await search.getByText(/1,005 matches/).waitFor();
  await search.getByRole("button", { name: "Show in panel", exact: true }).click();
  await leftPane.getByText("1,005 matches", { exact: true }).waitFor();
  await left.focus();
  await page.keyboard.press("ArrowRight");
  await left.getByRole("option", { name: /^file-1004.tmp/, selected: true }).waitFor();
  await page.keyboard.press("Shift+ArrowUp");
  await left.locator('.file-row[data-current="true"][data-tooltip="file-1003.tmp"]').waitFor();
  assert.deepEqual(await left.locator(".file-row.marked").getAttribute("data-tooltip"), "file-1004.tmp");
  await page.keyboard.press("Shift+ArrowDown");
  await left.locator('.file-row[data-current="true"][data-tooltip="file-1004.tmp"]').waitFor();
  assert.equal(await left.locator(".file-row.marked").count(), 2);
  assert.ok(await left.getByRole("option").count() < 100);
  await left.press("ArrowLeft");
  const firstResult = left.locator('.file-row[data-current="true"][data-tooltip="file-0.tmp"]');
  await firstResult.waitFor();
  await left.press("Shift+ArrowUp");
  await firstResult.and(left.locator(".marked")).waitFor();
  await left.press("Shift+ArrowUp");
  await firstResult.and(left.locator(":not(.marked)")).waitFor();
  await leftPane.getByRole("button", { name: "Close search results" }).click();
  await leftPane.getByRole("heading", { name: "bulk" }).waitFor({ state: "attached" });
  await navigate("left", src);
  await left.getByRole("option", { name: /^sample-app\.exe/ }).locator(".native-file-icon").waitFor();
  await left.getByRole("option", { name: /^notes.txt/ }).click({ modifiers: ["Control"] });
  await left.getByRole("option", { name: /^second.txt/ }).click({ modifiers: ["Control"] });
  assert.equal(await left.getByRole("option", { selected: true }).count(), 2);
  const guideRow = left.getByRole("option", { name: /^guide.md/ });
  await guideRow.click();
  assert.equal(await guideRow.getAttribute("aria-selected"), "true");
  assert.equal(await left.getByRole("option", { selected: true }).count(), 1);
  const orderedRows = await left.locator(".file-row").evaluateAll((rows) => rows.map((row) => row.dataset.tooltip));
  const guideIndex = orderedRows.indexOf("guide.md");
  const nextAfterGuide = orderedRows[guideIndex + 1];
  const markedRows = (list) => list.locator(".file-row.marked").evaluateAll((rows) => rows.map((row) => row.dataset.tooltip));
  assert.ok(guideIndex > 1 && guideIndex + 2 < orderedRows.length);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  assert.deepEqual(await markedRows(left), ["guide.md", nextAfterGuide]);
  const activeRow = (list) => list.locator('.file-row[data-current="true"]').getAttribute("data-tooltip");
  assert.equal(await activeRow(left), orderedRows[guideIndex + 2]);
  await page.keyboard.press("Shift+ArrowUp");
  assert.deepEqual(await markedRows(left), orderedRows.slice(guideIndex, guideIndex + 3));
  assert.equal(await activeRow(left), nextAfterGuide);

  const keyboardFolder = join(temp, "keyboard-marking");
  const singleItemFolder = join(keyboardFolder, "single");
  await mkdir(singleItemFolder, { recursive: true });
  const adjacentNames = ["a.txt", "b.txt", "c.txt", "d.txt"];
  for (const name of adjacentNames) await writeFile(join(keyboardFolder, name), "");
  await writeFile(join(singleItemFolder, "only.txt"), "");
  const rightBefore = await page.locator("#right-path").getAttribute("data-path");
  await navigate("right", keyboardFolder);
  await right.getByRole("option", { name: /^b\.txt/ }).click();
  await right.press("Shift+ArrowUp");
  assert.equal(await activeRow(right), "a.txt");
  assert.equal(await right.locator(".file-row.marked").getAttribute("data-tooltip"), "b.txt");
  await right.getByRole("option", { name: /^d\.txt/ }).click();
  await right.press("Shift+ArrowDown");
  assert.equal(await activeRow(right), "d.txt");
  assert.deepEqual(await markedRows(right), ["d.txt"]);
  await navigate("right", singleItemFolder);
  await right.getByRole("option", { name: /^only\.txt/ }).click();
  await right.press("Shift+ArrowDown");
  assert.equal(await activeRow(right), "only.txt");
  assert.equal(await right.locator(".file-row.marked").getAttribute("data-tooltip"), "only.txt");
  const leftBefore = await page.locator("#left-path").getAttribute("data-path");
  const clipboardIs = (expected) => page.waitForFunction(async (expected) => {
    const text = await window.__TAURI_INTERNALS__.invoke("clipboard_text");
    return text.replaceAll("\r\n", "\n") === expected;
  }, expected);
  for (const [side, list] of [["left", left], ["right", right]]) {
    await navigate(side, keyboardFolder);
    const row = (name) => list.locator(`.file-row[data-tooltip="${name}"]`);
    await row("c.txt").click({ modifiers: ["Control"] });
    await row("a.txt").click({ modifiers: ["Control"] });
    await list.press("ArrowDown");
    await list.press("Control+Insert");
    await clipboardIs("a.txt\nc.txt");
    assert.equal(await activeRow(list), "b.txt");
    assert.deepEqual(await markedRows(list), ["a.txt", "c.txt"]);
    await row("b.txt").click();
    await list.press("Control+Insert");
    await clipboardIs("b.txt");
    await list.press("Control+Shift+c");
    await clipboardIs(join(keyboardFolder, "b.txt"));
    for (const name of adjacentNames) await row(name).click({ modifiers: ["Control"] });
    await list.press("ArrowUp");
    await list.press("ArrowUp");
    assert.equal(await activeRow(list), "b.txt");
    await list.press("Shift+ArrowDown");
    assert.equal(await activeRow(list), "c.txt");
    assert.deepEqual(await markedRows(list), ["a.txt", "c.txt", "d.txt"]);
    await list.press("Shift+ArrowDown");
    assert.equal(await activeRow(list), "d.txt");
    assert.deepEqual(await markedRows(list), ["a.txt", "d.txt"]);
    await list.press("Shift+ArrowDown");
    assert.equal(await activeRow(list), "d.txt");
    assert.deepEqual(await markedRows(list), ["a.txt"]);

    for (const name of adjacentNames.slice(1)) await row(name).click({ modifiers: ["Control"] });
    await list.press("ArrowUp");
    assert.equal(await activeRow(list), "c.txt");
    await list.press("Shift+ArrowUp");
    assert.equal(await activeRow(list), "b.txt");
    assert.deepEqual(await markedRows(list), ["a.txt", "b.txt", "d.txt"]);
    await list.press("Shift+ArrowUp");
    assert.equal(await activeRow(list), "a.txt");
    assert.deepEqual(await markedRows(list), ["a.txt", "d.txt"]);
  }
  await navigate("left", leftBefore);
  await navigate("right", rightBefore);
  await left.locator(".file-row").nth(guideIndex - 1).click();
  await guideRow.click();
  const dragFile = left.getByRole("option", { name: /^drag-file.txt/ });
  await dragFile.click({ modifiers: ["Control"] });
  await left.getByRole("option", { name: /^drag-folder/ }).click({ modifiers: ["Control"] });
  const sourceBounds = await dragFile.boundingBox();
  const destinationBounds = await right.boundingBox();
  await page.mouse.move(sourceBounds.x + 30, sourceBounds.y + sourceBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(destinationBounds.x + 50, destinationBounds.y + 60, { steps: 15 });
  await page.mouse.up();
  const dragDialog = page.getByRole("dialog", { name: "Copy", exact: true });
  await dragDialog.getByText("2 selected items", { exact: true }).waitFor();
  await dragDialog.getByLabel("Move instead of copying").check();
  await finishTransfer("Move");
  assert.equal(await readFile(join(dst, "drag-file.txt"), "utf8"), "Dragged file");
  assert.equal(await readFile(join(dst, "drag-folder", "child.txt"), "utf8"), "Dragged folder");
  await assert.rejects(readFile(join(src, "drag-file.txt")), { code: "ENOENT" });
  const droppedPath = join(temp, "from-explorer.txt");
  await writeFile(droppedPath, "Dropped from outside Dirlume");
  await page.evaluate(async (path) => {
    const pane = document.querySelector("#right-files").getBoundingClientRect();
    const position = { x: (pane.left + 20) * devicePixelRatio, y: (pane.top + 20) * devicePixelRatio };
    await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "tauri://drag-drop", payload: { paths: [path], position },
    });
  }, droppedPath);
  await finishTransfer("Copy");
  assert.equal(await readFile(join(dst, "from-explorer.txt"), "utf8"), "Dropped from outside Dirlume");
  await page.getByRole("option", { name: /^measured/ }).click();
  await page.keyboard.press("F3");
  await page.getByRole("option", { name: /^measured/ }).getByText("12 B", { exact: true }).waitFor();
  const sizeFixture = join(temp, "size-refresh");
  const measuredPath = join(sizeFixture, "measured-item");
  await mkdir(measuredPath, { recursive: true });
  const measuredData = join(measuredPath, "initial.txt");
  await writeFile(measuredData, Buffer.alloc(2048));
  await writeFile(join(sizeFixture, "other.txt"), Buffer.alloc(16));
  await navigate("left", sizeFixture);
  const measuredItem = left.getByRole("option", { name: /^measured-item/ });
  await measuredItem.click();
  await page.keyboard.press("F3");
  await measuredItem.getByText("2 KiB", { exact: true }).waitFor();
  await writeFile(measuredData, Buffer.alloc(64));
  const refreshSizeFixture = leftPane.getByRole("button", { name: "Refresh folder", exact: true });
  await refreshSizeFixture.click();
  await measuredItem.getByText("2 KiB", { exact: true }).waitFor({ state: "hidden" });
  await measuredItem.click();
  await page.keyboard.press("F3");
  await measuredItem.getByText("64 B", { exact: true }).waitFor();
  await rm(measuredData);
  await rmdir(measuredPath);
  await writeFile(measuredPath, "x");
  await refreshSizeFixture.click();
  await measuredItem.getByText("1 B", { exact: true }).waitFor();
  const sizeSort = leftPane.getByRole("button", { name: /^Size\b/ });
  const sizeOrder = () => left.getByRole("option").evaluateAll((rows) => rows.map((row) => row.dataset.tooltip));
  await sizeSort.click();
  assert.deepEqual(await sizeOrder(), ["..", "other.txt", "measured-item"]);
  await sizeSort.click();
  assert.deepEqual(await sizeOrder(), ["..", "measured-item", "other.txt"]);
  await leftPane.getByRole("button", { name: /^Name\b/ }).click();
  await navigate("left", src);
  await page.getByRole("option", { name: /^notes.txt/ }).click();
  await page.keyboard.press("Insert");
  await left.getByRole("option", { name: /^second.txt/ }).click({ modifiers: ["Control"] });
  await page.getByRole("combobox", { name: "Command line" }).press("F5");
  await finishTransfer("Copy");
  await page.getByRole("listbox", { name: "right files", exact: true }).getByRole("option", { name: /^notes.txt/ }).waitFor();
  assert.equal(await readFile(join(dst, "notes.txt"), "utf8"), "Dirlume\n");
  assert.equal(await readFile(join(dst, "second.txt"), "utf8"), "Second file\n");
  await left.getByRole("option", { name: /^notes.txt/ }).click({ modifiers: ["Control"] });
  await left.getByRole("option", { name: /^second.txt/ }).click({ modifiers: ["Control"] });
  await writeFile(join(dst, "notes.txt"), "Previous version\n");
  await left.getByRole("option", { name: /^notes.txt/ }).click();
  await page.keyboard.press("F5");
  await startTransfer("Copy");
  const conflict = page.getByRole("dialog", { name: "File already exists" });
  await conflict.waitFor();
  assert.equal(await readFile(join(dst, "notes.txt"), "utf8"), "Previous version\n");
  await conflict.getByRole("button", { name: "Overwrite", exact: true }).click();
  await waitForCompletedTransfer();
  assert.equal(await readFile(join(dst, "notes.txt"), "utf8"), "Dirlume\n");
  await navigate("left", src);
  await left.getByRole("option", { name: /^overlap/ }).click();
  await page.keyboard.press("F5");
  await startTransfer("Copy");
  assert.equal(await page.getByRole("dialog", { name: "Folder already exists" }).count(), 0);
  await conflict.getByText("Incoming", { exact: true }).waitFor();
  await conflict.getByText("2 B", { exact: true }).waitFor();
  assert.equal(await conflict.getByRole("button", { name: "Skip", exact: true }).evaluate((button) => document.activeElement === button), true);
  if (process.env.DIRLUME_CONFLICT_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_CONFLICT_SCREENSHOT, scale: "css" });
  await conflict.getByLabel("Remember choice").check();
  await conflict.getByRole("button", { name: "Overwrite", exact: true }).click();
  await waitForCompletedTransfer();
  assert.deepEqual(await readFile(join(dst, "overlap", "data.bin")), Buffer.alloc(12));
  assert.deepEqual(await readFile(join(dst, "overlap", "other.bin")), Buffer.alloc(13, 7));
  await writeFile(join(src, "outside-change.txt"), "watch me");
  await writeFile(join(dst, "outside-right.txt"), "watch both panes");
  await left.getByRole("option", { name: /^outside-change.txt/ }).waitFor();
  await right.getByRole("option", { name: /^outside-right.txt/ }).waitFor();

  await guideRow.click({ modifiers: ["Control"] });
  await page.keyboard.press("Alt+S");
  const quick = leftPane.getByRole("textbox", { name: "Quick search", exact: true });
  assert.equal((await quick.inputValue()).toLowerCase(), "s");
  await quick.fill("sec");
  const secondRow = left.getByRole("option", { name: /^second.txt/ });
  await page.waitForFunction(() => document.querySelector("#left-files [data-current=true]")?.getAttribute("data-tooltip") === "second.txt");
  if (process.env.DIRLUME_QUICK_SEARCH_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_QUICK_SEARCH_SCREENSHOT, scale: "css" });
  await quick.fill("nosuchfile");
  await leftPane.getByText("No match", { exact: true }).waitFor();
  await quick.press("Escape");
  await quick.waitFor({ state: "hidden" });
  assert.equal(await secondRow.getAttribute("data-current"), "true");
  assert.match(await guideRow.getAttribute("class"), /marked/);
  await secondRow.click();

  let optionsDialog, optionsContent, searchSettings;
  async function showOptions(trigger) {
    optionsPage = await openOptionsWindow(page, trigger);
    optionsDialog = optionsPage.getByRole("dialog", { name: "Options", exact: true });
    optionsContent = optionsDialog.locator(".settings-page-body");
    searchSettings = optionsDialog.getByRole("searchbox", { name: "Search settings", exact: true });
    assert.notEqual(optionsPage, page);
  }
  await showOptions(() => page.locator("#left-files").press("Alt+Control+S"));
  await searchSettings.fill("menu");
  await optionsDialog.getByRole("button", { name: "Window", exact: true }).click();
  const alignment = optionsContent.locator("label.setting").filter({ hasText: "Main menu alignment" });
  assert.equal(await alignment.locator("mark").innerText(), "menu");
  await searchSettings.fill("right");
  await alignment.locator(".setting-search-alias").waitFor();
  assert.equal(await alignment.locator("mark").count(), 0);
  await searchSettings.fill("menu");
  await optionsDialog.getByRole("button", { name: "General", exact: true }).click();
  assert.equal(await optionsContent.locator("mark").innerText(), "menu");
  await searchSettings.fill("");
  assert.equal(await optionsContent.locator("mark, .setting-search-alias").count(), 0);
  await optionsDialog.getByRole("button", { name: "Computers", exact: true }).click();
  await optionsDialog.getByRole("heading", { name: "Computers", exact: true }).waitFor();
  const lanGroup = optionsDialog.getByRole("group", { name: "Dirlume LAN group", exact: true });
  await lanGroup.getByLabel("Group code", { exact: true }).waitFor();
  assert.equal(await lanGroup.getByRole("button", { name: "Join group", exact: true }).isEnabled(), false);
  assert.equal(await optionsDialog.getByLabel("KSwitcher installation folder", { exact: true }).count(), 0);
  await closeToolWindow(optionsPage);
  await showOptions(() => page.locator("#left-files").dispatchEvent("keydown", { key: "і", code: "KeyS", ctrlKey: true, altKey: true }));
  await optionsDialog.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  const zoomBinding = () => optionsDialog.getByLabel("Change shortcut for Font zoom with mouse wheel", { exact: true });
  assert.equal(await zoomBinding().inputValue(), "Ctrl+Wheel");
  await zoomBinding().selectOption("Alt+Wheel");
  await searchSettings.fill("keyboard shortcuts");
  const shortcutScroll = await optionsContent.evaluate((content) => { content.scrollTop = 180; return content.scrollTop; });
  assert.ok(shortcutScroll > 0);
  await closeToolWindow(optionsPage, () => optionsDialog.getByRole("button", { name: "Done", exact: true }).click());
  await wheelFont("#left-files", -120);
  assert.equal(await fontSize("#left-pane"), leftFont);
  await wheelFont("#left-files", -120, "Alt");
  assert.ok(await fontSize("#left-pane") > leftFont);
  await wheelFont("#left-files", 120, "Alt");
  await showOptions(() => page.locator("#right-files").press("Alt+Control+S"));
  assert.equal(await optionsDialog.getByRole("button", { name: "Keyboard shortcuts", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await searchSettings.inputValue(), "keyboard shortcuts");
  assert.equal(await optionsContent.evaluate((content) => content.scrollTop), shortcutScroll);
  await searchSettings.fill("");
  await zoomBinding().selectOption("Ctrl+Wheel");
  await optionsDialog.getByRole("button", { name: "View font sizes", exact: true }).click();
  for (const [side, size] of [["Left", leftFont], ["Right", rightFont]]) {
    const field = optionsDialog.getByRole("spinbutton", { name: `${side} file pane font size` });
    assert.equal(await field.inputValue(), String(size));
    await field.fill("");
  }
  await optionsDialog.getByRole("button", { name: "Apply", exact: true }).click();

  const panelsSection = optionsDialog.getByRole("button", { name: "Panels", exact: true });
  await panelsSection.click();
  await panelsSection.press("Tab");
  await optionsPage.keyboard.press("Shift+Tab");
  if (process.env.DIRLUME_SETTINGS_FOCUS_SCREENSHOT) {
    await optionsPage.screenshot({ path: process.env.DIRLUME_SETTINGS_FOCUS_SCREENSHOT, scale: "css" });
  }
  const settingsFocus = await panelsSection.evaluate((button) => {
    const tree = button.closest(".settings-tree");
    const bounds = button.getBoundingClientRect();
    const clip = tree.getBoundingClientRect();
    const style = getComputedStyle(button);
    const outside = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
    const left = clip.left + tree.clientLeft;
    const top = clip.top + tree.clientTop;
    return {
      visible: button.matches(":focus-visible") && style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0,
      fits: bounds.left - outside >= left && bounds.right + outside <= left + tree.clientWidth &&
        bounds.top - outside >= top && bounds.bottom + outside <= top + tree.clientHeight,
    };
  });
  assert.deepEqual(settingsFocus, { visible: true, fits: true }, "The Options tree should show the full keyboard focus outline.");
  await optionsPage.getByRole("button", { name: "Window", exact: true }).click();
  await optionsPage.getByLabel("Color scheme", { exact: true }).selectOption("light");
  await optionsPage.getByRole("button", { name: "Apply", exact: true }).click();
  await optionsPage.getByRole("dialog", { name: "Options", exact: true }).waitFor();
  await page.locator("html[data-theme=light]").waitFor();
  await optionsPage.getByRole("button", { name: "Window", exact: true }).click();
  assert.notEqual(await optionsPage.getByLabel("Toolbar and status bar hex").inputValue(), "#000000");
  const swatch = optionsDialog.getByRole("button", { name: "Window background color", exact: true });
  const picker = optionsPage.getByRole("dialog", { name: "Window background color", exact: true });
  await swatch.click();
  const spectrum = picker.getByRole("group", { name: /^Saturation and brightness/ });
  await spectrum.click({ position: { x: 120, y: 45 } });
  const hex = picker.getByLabel("HEX", { exact: true });
  const shade = await hex.inputValue();
  await picker.getByRole("slider", { name: "Hue" }).press("End");
  assert.notEqual(await hex.inputValue(), shade);
  await hex.fill("#112233");
  const previewColor = () => optionsDialog.locator(".preview-frame")
    .evaluate((element) => getComputedStyle(element).getPropertyValue("--canvas").trim());
  assert.equal(await previewColor(), "#112233");
  if (process.env.DIRLUME_COLOR_PICKER_SCREENSHOT) await optionsPage.screenshot({ path: process.env.DIRLUME_COLOR_PICKER_SCREENSHOT, scale: "css" });
  await hex.press("Escape");
  await picker.waitFor({ state: "hidden" });
  await optionsDialog.waitFor();
  assert.equal(await optionsPage.getByLabel("Color scheme", { exact: true }).inputValue(), "light");
  await swatch.click();
  const initialColor = await hex.inputValue();
  await spectrum.click({ position: { x: 120, y: 45 } });
  const chosenColor = await hex.inputValue();
  assert.notEqual(chosenColor, initialColor);
  await picker.getByRole("button", { name: "Use color", exact: true }).click();
  assert.equal(await optionsPage.getByLabel("Window background hex").inputValue(), chosenColor);
  await optionsPage.getByLabel("Window background hex").fill("#eef3fe");
  await optionsPage.getByLabel("Scheme name").fill("Blueprint");
  assert.equal(await optionsPage.getByLabel("Window background hex").inputValue(), "#eef3fe");
  await optionsPage.getByRole("button", { name: "Panels", exact: true }).click();
  await optionsPage.getByLabel("Panel background hex").fill("#ecf9f5");
  await optionsPage.getByRole("button", { name: "Dialogs", exact: true }).click();
  await optionsPage.getByLabel("Dialog background hex").fill("#f5f9fe");
  const sourceName = left.getByRole("option", { name: /^sample\.rs/ }).locator(".file-name");
  const textName = left.getByRole("option", { name: /^guide\.md/ }).locator(".file-name");
  const foreground = (element) => element.evaluate((name) => getComputedStyle(name).color);
  assert.notEqual(await foreground(sourceName), await foreground(textName));
  await searchSettings.fill("office documents");
  await searchSettings.press("Enter");
  await optionsPage.getByRole("heading", { name: "File types", exact: true }).waitFor();
  await optionsPage.getByRole("combobox", { name: "File extension group", exact: true }).selectOption("file-source");
  await optionsPage.getByRole("textbox", { name: "Filename color hex", exact: true }).fill("#7c2144");
  const exampleSource = optionsPage.getByRole("region", { name: "Settings preview" }).getByText("main.rs", { exact: true });
  assert.equal(await foreground(exampleSource), "rgb(124, 33, 68)");
  assert.notEqual(await foreground(sourceName), "rgb(124, 33, 68)");
  const attributeColors = { hidden: "rgb(65, 83, 109)", system: "rgb(115, 18, 76)" };
  const preview = optionsDialog.getByRole("region", { name: "Settings preview" });
  await optionsDialog.getByLabel("Hidden files and folders hex", { exact: true }).fill("#41536d");
  await optionsDialog.getByLabel("System files and folders hex", { exact: true }).fill("#73124c");
  assert.equal(await foreground(preview.getByText(".env", { exact: true })), attributeColors.hidden);
  assert.equal(await foreground(preview.getByText("System Volume Information", { exact: true })), attributeColors.system);
  await searchSettings.fill("");
  await optionsPage.getByRole("button", { name: "Fonts", exact: true }).click();
  const panelFont = optionsDialog.getByRole("combobox", { name: "File panels font family", exact: true });
  const panelSuggestions = optionsDialog.getByRole("listbox", { name: "File panels font suggestions", exact: true });
  await optionsDialog.getByRole("button", { name: "Browse installed fonts for file panels", exact: true }).click();
  await panelSuggestions.getByRole("option").first().waitFor();
  await panelFont.press("Escape");
  await panelSuggestions.waitFor({ state: "hidden" });
  await optionsDialog.waitFor();
  assert.equal(await optionsPage.getByRole("button", { name: "Fonts", exact: true }).getAttribute("aria-pressed"), "true");
  await panelFont.fill("GoMono Nerd");
  await panelSuggestions.getByRole("option", { name: bundledFamily, exact: true }).click();
  assert.equal(await panelFont.inputValue(), bundledFamily);
  await optionsDialog.getByLabel("File panels font size").fill("20");
  await optionsDialog.getByRole("button", { name: "Reset file panels font", exact: true }).click();
  assert.equal(await panelFont.inputValue(), "");
  assert.equal(await optionsDialog.locator(".preview-frame").evaluate((element) =>
    getComputedStyle(element).getPropertyValue("--panel-size").trim()), "15px");
  await panelFont.fill("aRiAl");
  const arial = panelSuggestions.getByRole("option", { name: "Arial", exact: true });
  await arial.waitFor();
  assert.equal(await optionsPage.getByRole("dialog").count(), 1, "Font suggestions should appear inside Options.");
  assert.ok((await panelSuggestions.getByRole("option").allTextContents()).every((family) => /arial/i.test(family)));
  await panelFont.press("ArrowDown");
  assert.equal(await arial.getAttribute("aria-selected"), "true");
  await panelFont.press("Enter");
  assert.equal(await panelFont.inputValue(), "Arial");
  await panelSuggestions.waitFor({ state: "hidden" });
  await optionsPage.getByLabel("File panels font size").fill("17");
  assert.notEqual(await page.locator("#left-pane").evaluate((pane) => getComputedStyle(pane).fontSize), "17px");
  await optionsPage.getByRole("button", { name: "Apply", exact: true }).click();
  await optionsPage.getByRole("button", { name: "Apply", exact: true }).isDisabled().then((disabled) => assert.equal(disabled, true));
  assert.equal(await optionsPage.getByRole("button", { name: "Fonts", exact: true }).getAttribute("aria-pressed"), "true");
  await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === "rgb(238, 243, 254)");
  assert.equal(await page.locator("#left-pane").evaluate((pane) => getComputedStyle(pane).backgroundColor), "rgb(236, 249, 245)");
  assert.equal(await page.locator("#left-pane").evaluate((pane) => getComputedStyle(pane).fontSize), "17px");
  assert.equal(await optionsPage.getByRole("dialog", { name: "Options" }).evaluate((dialog) => getComputedStyle(dialog).backgroundColor), "rgb(245, 249, 254)");
  assert.equal(await foreground(sourceName), "rgb(124, 33, 68)");
  assert.notEqual(await foreground(textName), "rgb(124, 33, 68)");
  if (process.env.DIRLUME_APPEARANCE_SCREENSHOT) await optionsPage.screenshot({ path: process.env.DIRLUME_APPEARANCE_SCREENSHOT, scale: "css" });
  const fontScroll = await optionsContent.evaluate((content) => { content.scrollTop = 120; return content.scrollTop; });
  assert.ok(fontScroll > 0);
  await optionsPage.getByLabel("File panels font size").fill("19");
  await optionsContent.evaluate((content, position) => { content.scrollTop = position; }, fontScroll);
  for (const closeWith of ["button", "Escape"]) {
    await closeToolWindow(optionsPage, closeWith === "button" ? () => optionsDialog.getByRole("button", { name: "Cancel", exact: true }).click() : undefined);
    await showOptions(() => page.locator("#left-files").press("Alt+Control+S"));
    assert.equal(await optionsDialog.getByRole("button", { name: "Fonts", exact: true }).getAttribute("aria-pressed"), "true");
    assert.equal(await optionsContent.evaluate((content) => content.scrollTop), fontScroll);
    assert.equal(await optionsPage.getByLabel("File panels font size").inputValue(), "17");
  }
  await optionsPage.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  await optionsPage.getByRole("button", { name: "Change F7 for New folder", exact: true }).click();
  const captureNewFolder = optionsPage.getByRole("textbox", { name: "New shortcut to replace F7 for New folder", exact: true });
  await captureNewFolder.press("F5");
  await shortcutConflict().getByText("F5 is assigned to Copy.", { exact: true }).waitFor();
  await shortcutConflict().getByRole("button", { name: "Choose another shortcut", exact: true }).click();
  await captureNewFolder.press("Control+Shift+F12");
  await optionsDialog.getByRole("button", { name: "Change F5 for Copy", exact: true }).waitFor();
  await closeToolWindow(optionsPage, () => optionsDialog.getByRole("button", { name: "Done", exact: true }).click());
  await navigate("left", attributes);
  const attributeRow = (name) => left.locator(`.file-row[data-tooltip="${name}"]`);
  const attributeName = (name) => attributeRow(name).locator(".file-name");
  const selectionForeground = (name) => attributeName(name).evaluate((element) => {
    const sample = document.createElement("span");
    sample.style.color = "var(--panel-selected-ink)";
    element.append(sample);
    const color = getComputedStyle(sample).color;
    sample.remove();
    return color;
  });
  assert.equal(await attributeRow("hidden.rs").count(), 0);
  assert.equal(await attributeRow("system-hidden.dll").count(), 0);
  const ordinary = attributeRow("ordinary.sys");
  const currentOrdinary = ordinary.and(page.locator('[data-current="true"]'));
  await ordinary.click();
  await currentOrdinary.waitFor();
  assert.equal(await foreground(attributeName("system-folder")), attributeColors.system);
  assert.notEqual(await foreground(attributeName("ordinary.sys")), attributeColors.system);
  await left.press("Control+h");
  await currentOrdinary.waitFor();
  assert.equal(await foreground(attributeName(".metadata")), attributeColors.hidden);
  assert.equal(await foreground(attributeName("hidden.rs")), attributeColors.hidden);
  assert.equal(await foreground(attributeName("system-hidden.dll")), attributeColors.system);
  await attributeRow("system-hidden.dll").click();
  assert.equal(await foreground(attributeName("system-hidden.dll")), await selectionForeground("system-hidden.dll"));
  await attributeRow("system-hidden.dll").click({ modifiers: ["Control"] });
  assert.match(await attributeRow("system-hidden.dll").getAttribute("class"), /marked/);
  assert.equal(await foreground(attributeName("system-hidden.dll")), await selectionForeground("system-hidden.dll"));
  if (process.env.DIRLUME_ATTRIBUTES_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_ATTRIBUTES_SCREENSHOT, scale: "css" });
  await left.press("Control+h");
  const properties = page.getByRole("dialog", { name: "Attributes", exact: true });
  const flag = (name) => properties.getByRole("checkbox", { name, exact: true });
  const applyAttributes = () => properties.getByRole("button", { name: "Apply", exact: true }).click();
  const cancelAttributes = () => properties.getByRole("button", { name: "Cancel", exact: true }).click();
  await (await editAddress("left")).press("Control+a");
  assert.equal(await leftAddress.evaluate((field) => field.selectionEnd - field.selectionStart), attributes.length);
  assert.equal(await properties.count(), 0);
  await attributeRow("ordinary.sys").click();
  await left.press("Control+a");
  await properties.getByText("ordinary.sys", { exact: true }).waitFor();
  await flag("System attribute").waitFor();
  assert.equal(await flag("System attribute").isChecked(), false);
  assert.equal(await flag("Compressed").isDisabled(), true);
  assert.equal(await flag("Encrypted").isDisabled(), true);
  assert.ok(await properties.getByText("Owner", { exact: true }).isVisible());
  await flag("System attribute").check();
  await cancelAttributes();
  assert.notEqual(await attributeRow("ordinary.sys").getAttribute("data-file-color"), "file-system");
  await left.press("Control+a");
  await flag("System attribute").check();
  await flag("Read-only").check();
  await applyAttributes();
  await properties.getByText("Attributes saved.", { exact: true }).waitFor();
  assert.equal(await flag("Read-only").isChecked(), true);
  await attributeRow("ordinary.sys").and(page.locator('[data-file-color="file-system"]')).waitFor();
  assert.equal(await foreground(attributeName("ordinary.sys")), await selectionForeground("ordinary.sys"));
  await flag("Read-only").uncheck();
  await flag("System attribute").uncheck();
  await applyAttributes();
  await properties.getByText("Attributes saved.", { exact: true }).waitFor();
  await cancelAttributes();
  await navigate("right", attributes);
  const rightSystemFolder = right.locator('.file-row[data-tooltip="system-folder"]');
  await rightSystemFolder.click();
  await right.press("Control+a");
  await properties.getByText("system-folder", { exact: true }).waitFor();
  await flag("Hidden").check();
  assert.equal(await flag("Read-only").isDisabled(), true);
  await applyAttributes();
  await properties.getByText("Attributes saved.", { exact: true }).waitFor();
  await rightSystemFolder.waitFor({ state: "detached" });
  await flag("Hidden").uncheck();
  await applyAttributes();
  await properties.getByText("Attributes saved.", { exact: true }).waitFor();
  await cancelAttributes();
  await rightSystemFolder.waitFor();
  await navigate("right", dst);
  console.log("Verified file and folder attributes, cancel, pane refresh, and text selection.");
  await navigate("left", src);
  await page.getByRole("listbox", { name: "right files", exact: true }).focus();
  await page.keyboard.press("Control+Shift+F12");
  await page.getByRole("dialog", { name: "New folder" }).getByLabel("Name", { exact: true }).fill("verified");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("option", { name: /^verified/ }).waitFor();

  const encodedFiles = join(temp, "encodings");
  await mkdir(encodedFiles);
  await navigate("left", encodedFiles);
  await testNewFileEncoding(page, encodedFiles);
  await testDocumentMode(page, temp);
  await testDocumentWatch(page, temp);
  await navigate("left", src);
  await left.focus();
  await page.keyboard.press("Shift+F4");
  await page.getByRole("dialog", { name: "New file" }).getByLabel("Name", { exact: true }).fill("draft.md");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("textbox", { name: "Edit draft.md" }).fill("# Draft");
  await page.keyboard.press("F2");
  const editor = page.getByRole("region", { name: "draft.md", exact: true });
  await editor.locator(".document-heading .document-encoding").filter({ hasText: /^UTF-8$/ }).waitFor();
  await editor.locator(".document-heading").getByRole("button", { name: "Syntax", exact: true }).waitFor();
  assert.ok(await editor.locator(".cm-lineNumbers .cm-gutterElement").first().evaluate((number) =>
    parseFloat(getComputedStyle(number).paddingInlineEnd) >= 6));
  assert.equal(await editor.getByRole("button", { name: "Save", exact: true }).count(), 0);
  await editor.locator(".document-modified").waitFor({ state: "hidden" });
  await page.keyboard.press("F10");
  await editor.waitFor({ state: "hidden" });
  assert.equal(await readFile(join(src, "draft.md"), "utf8"), "# Draft");
  await left.getByRole("option", { name: /^draft.md/ }).click();
  await page.keyboard.press("F6");
  await finishTransfer("Move");
  await assert.rejects(readFile(join(src, "draft.md")), { code: "ENOENT" });
  const draft = page.getByRole("listbox", { name: "right files" }).getByRole("option", { name: /^draft.md/ });
  await draft.click();
  await page.keyboard.press("F8");
  const trashDialog = page.getByRole("dialog", { name: "Move to Trash" });
  await trashDialog.getByRole("button", { name: "Cancel" }).click();
  await trashDialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.getElementById("right-files")?.getAttribute("aria-busy") === "false");
  await draft.click();
  await page.keyboard.press("Shift+Delete");
  const deleteDialog = page.getByRole("dialog", { name: "Delete permanently" });
  assert.equal(await deleteDialog.getByRole("button", { name: "Cancel" }).evaluate((button) => document.activeElement === button), true);
  await deleteDialog.getByRole("button", { name: "Delete permanently" }).click();
  await draft.waitFor({ state: "detached" });

  const lockedPath = join(src, "locked-by-process.txt");
  await writeFile(lockedPath, "Temporary test file.");
  lockedBy = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `$file = [IO.File]::Open('${lockedPath.replaceAll("'", "''")}', 'Open', 'Read', 'None'); Write-Output LOCKED; Start-Sleep 60`],
  { windowsHide: true });
  await new Promise((complete, reject) => {
    lockedBy.once("error", reject);
    lockedBy.once("exit", () => reject(new Error("The test process exited before locking the file.")));
    lockedBy.stdout.on("data", (chunk) => { if (chunk.toString().includes("LOCKED")) complete(); });
  });
  await left.focus();
  await page.keyboard.press("Alt+F1");
  await leftPane.getByRole("button", { name: "Processes", exact: true }).click();
  const taskList = leftPane.getByRole("grid", { name: "Running processes" });
  const pidHeader = taskList.getByRole("columnheader", { name: "PID" });
  await pidHeader.getByRole("button").click();
  assert.equal(await pidHeader.getAttribute("aria-sort"), "ascending");
  const pids = await taskList.locator("tbody tr td:nth-child(2)").allTextContents();
  assert.deepEqual(pids.map(Number), pids.map(Number).sort((a, b) => a - b));
  await pidHeader.getByRole("button").click();
  assert.equal(await pidHeader.getAttribute("aria-sort"), "descending");
  const task = taskList.getByRole("row").filter({ has: page.getByRole("gridcell", { name: String(lockedBy.pid), exact: true }) });
  await task.locator(".process-icon").waitFor();
  await task.click();
  await page.keyboard.press("F8");
  const endProcesses = page.getByRole("dialog", { name: "End processes", exact: true });
  await endProcesses.getByText(new RegExp(`PID ${lockedBy.pid}\\)`)).waitFor();
  await endProcesses.getByRole("button", { name: "Cancel", exact: true }).click();
  if (process.env.DIRLUME_PROCESSES_SCREENSHOT) {
    await page.screenshot({ path: process.env.DIRLUME_PROCESSES_SCREENSHOT, scale: "css" });
  }
  await leftPane.getByRole("button", { name: "Close processes" }).click();
  await left.getByRole("option", { name: /^locked-by-process.txt/ }).click();
  await page.keyboard.press("Shift+Delete");
  await deleteDialog.getByRole("button", { name: "Delete permanently", exact: true }).click();
  const blockedRemoval = page.getByRole("dialog", { name: "Item is in use", exact: true });
  await blockedRemoval.getByRole("button", { name: "Find locking processes", exact: true }).click();
  const lockDialog = page.getByRole("dialog", { name: "Processes using these files", exact: true });
  await lockDialog.getByRole("option", { name: new RegExp(`PID ${lockedBy.pid}\\)`) }).waitFor();
  await lockDialog.getByRole("button", { name: "Select all", exact: true }).click();
  await lockDialog.getByRole("button", { name: "End selected", exact: true }).click();
  await endProcesses.getByRole("button", { name: "End process", exact: true }).click();
  await lockDialog.getByText("Windows found no processes using these files.").waitFor();
  await lockDialog.getByRole("button", { name: "Close", exact: true }).click();
  await blockedRemoval.getByRole("button", { name: "Retry", exact: true }).click();
  await left.getByRole("option", { name: /^locked-by-process.txt/ }).waitFor({ state: "detached" });

  if (process.env.DIRLUME_CROSS_VOLUME_TEST_ROOT) {
    const root = resolve(process.env.DIRLUME_CROSS_VOLUME_TEST_ROOT);
    assert.notEqual(root.slice(0, 2).toLowerCase(), src.slice(0, 2).toLowerCase());
    otherVolume = await mkdtemp(join(root, "dirlume-f6-"));
    assert.equal(dirname(otherVolume), root);
    await navigate("right", otherVolume);
    await navigate("left", src);
    await left.getByRole("option", { name: /^volume.txt/ }).click();
    await page.keyboard.press("F6");
    await finishTransfer("Move", otherVolume);
    await assert.rejects(readFile(join(src, "volume.txt")), { code: "ENOENT" });
    assert.equal(await readFile(join(otherVolume, "volume.txt"), "utf8"), "Cross-volume move");

    await mkdir(join(otherVolume, "merge"));
    await writeFile(join(otherVolume, "merge", "update.txt"), "Old contents");
    await writeFile(join(otherVolume, "merge", "keep.txt"), "Destination-only file");
    await navigate("left", src);
    const mergeRow = left.getByRole("option", { name: /^merge/ });
    await mergeRow.click();
    await page.keyboard.press("F6");
    await startTransfer("Move", otherVolume);
    await folderConflict.getByRole("button", { name: "Merge", exact: true }).click();
    await conflict.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("dialog", { name: "Transfer canceled" }).getByRole("button", { name: "Done" }).click();
    assert.equal(await readFile(join(src, "merge", "update.txt"), "utf8"), "New contents");
    assert.equal(await readFile(join(otherVolume, "merge", "update.txt"), "utf8"), "Old contents");
    await mergeRow.click();
    await page.keyboard.press("F6");
    await startTransfer("Move", otherVolume);
    await folderConflict.getByRole("button", { name: "Merge", exact: true }).click();
    await conflict.getByRole("button", { name: "Overwrite", exact: true }).click();
    await waitForCompletedTransfer();
    await assert.rejects(readFile(join(src, "merge", "update.txt")), { code: "ENOENT" });
    assert.equal(await readFile(join(otherVolume, "merge", "update.txt"), "utf8"), "New contents");
    assert.equal(await readFile(join(otherVolume, "merge", "keep.txt"), "utf8"), "Destination-only file");
    await navigate("right", dst);
    console.log("Verified F6 between Windows volumes, including cancellation and a folder merge.");
  }

  const linkedMarkdownFont = await testMarkdown(page, src, wheelFont);
  await testMarkdownNoWrap(page, temp);
  await page.getByRole("option", { name: /^guide.md/ }).click();
  await page.keyboard.press("F3");
  await page.getByRole("heading", { name: "Getting started" }).waitFor();
  const diagram = page.getByRole("img", { name: "Mermaid diagram" });
  await diagram.waitFor();
  assert.ok(await diagram.evaluate((image) => image.complete && image.naturalWidth > 0));
  const markdownSurface = ".text-window:not([hidden]) .markdown";
  assert.equal(await fontSize(markdownSurface), linkedMarkdownFont, "Unrelated Markdown files should open with the same saved preview size.");
  await showOptions(() => page.getByRole("button", { name: "Viewer options", exact: true }).click());
  await optionsDialog.getByRole("heading", { name: "Viewer", exact: true }).waitFor();
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("open_tool_window", { title: "Options", initialPage: "editor" }));
  await optionsDialog.getByRole("heading", { name: "Editor", exact: true }).waitFor();
  await closeToolWindow(optionsPage);
  await showOptions(() => page.keyboard.press("Control+Alt+S"));
  await optionsDialog.getByRole("button", { name: "Fonts", exact: true }).click();
  const textFontFamily = optionsDialog.getByLabel("Editor, viewer, and terminal font family");
  const textFontSize = optionsDialog.getByLabel("Editor, viewer, and terminal font size");
  const markdownFamily = () => page.locator(markdownSurface).evaluate((surface) => getComputedStyle(surface).fontFamily);
  await textFontFamily.fill("ari");
  await optionsDialog.getByRole("listbox", { name: "Editor, viewer, and terminal font suggestions", exact: true })
    .getByRole("option", { name: "Arial", exact: true }).click();
  assert.equal(await textFontFamily.inputValue(), "Arial");
  await textFontSize.fill("18");
  await optionsDialog.getByRole("button", { name: "Apply", exact: true }).click();
  assert.equal(await fontSize(markdownSurface), linkedMarkdownFont, "Changing the family while keeping the same base size should preserve zoom.");
  assert.match(await markdownFamily(), /^Arial,/);
  await textFontFamily.fill("Georgia");
  await textFontSize.fill("16");
  await closeToolWindow(optionsPage, () => optionsDialog.getByRole("button", { name: "Done", exact: true }).click());
  assert.match(await markdownFamily(), /^Georgia,/);
  assert.equal(await fontSize(markdownSurface), 16, "Done should update the open Markdown preview without reopening the file.");
  await showOptions(() => page.keyboard.press("Control+Alt+S"));
  await optionsDialog.getByRole("button", { name: "Reset editor, viewer, and terminal font", exact: true }).click();
  await closeToolWindow(optionsPage, () => optionsDialog.getByRole("button", { name: "Done", exact: true }).click());
  const markdownFont = await fontSize(markdownSurface);
  await wheelFont(markdownSurface, -120);
  const enlargedMarkdown = await fontSize(markdownSurface);
  assert.ok(enlargedMarkdown > markdownFont, "Ctrl+Wheel should enlarge Markdown preview text.");
  if (process.env.DIRLUME_DOCUMENT_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_DOCUMENT_SCREENSHOT, scale: "css" });
  await page.keyboard.press("Control+Tab");
  await left.getByRole("option", { name: /^sample.rs/ }).click();
  await page.keyboard.press("F4");
  const sourceEditor = page.getByRole("textbox", { name: "Edit sample.rs" });
  await sourceEditor.locator(".syntax-keyword").first().waitFor();
  const codeSurface = ".text-window:not([hidden]) .cm-scroller";
  const sourceFont = await fontSize(codeSurface);
  await wheelFont(codeSurface, 120);
  assert.ok(await fontSize(codeSurface) < sourceFont, "Ctrl+Wheel should shrink the editor's font.");
  await sourceEditor.fill("fn main() { let retained = true; }");
  await showOptions(() => sourceEditor.press("Control+Alt+S"));
  await closeToolWindow(optionsPage);
  assert.match(await sourceEditor.innerText(), /retained/);
  await page.keyboard.press("Escape");
  const unsaved = page.getByRole("dialog", { name: "Unsaved changes" });
  await unsaved.getByText(/Discard the unsaved changes/).waitFor();
  await unsaved.getByRole("button", { name: "Keep editing" }).click();
  await page.getByRole("navigation", { name: "Open documents" }).getByRole("button", { name: "Files", exact: true }).click();
  await page.keyboard.press("F10");
  await unsaved.getByRole("button", { name: "Keep working", exact: true }).click();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("Control+Shift+Tab");
  assert.match(await sourceEditor.innerText(), /retained/);
  await page.keyboard.press("Control+Shift+Tab");
  await diagram.waitFor();
  assert.equal(await fontSize(markdownSurface), enlargedMarkdown, "Editor zoom should leave the Markdown preview size alone.");
  await page.keyboard.press("Control+Tab");
  assert.match(await sourceEditor.innerText(), /retained/);
  await page.keyboard.press("F2");
  await page.locator(".text-window:not([hidden]) .document-modified").waitFor({ state: "hidden" });
  await page.keyboard.press("Escape");
  await page.getByRole("navigation", { name: "Open documents", exact: true })
    .getByRole("button", { name: "View guide.md", exact: true }).click();
  await diagram.waitFor();
  await page.keyboard.press("Escape");
  await left.getByRole("option", { name: /^control.bin/ }).click();
  await page.keyboard.press("F3");
  const raw = page.getByLabel("Hexadecimal contents");
  await page.getByRole("alert").getByText(/binary data|utf-8/i).waitFor();
  await raw.waitFor({ state: "hidden" });
  await page.keyboard.press("F4");
  await raw.waitFor();
  assert.match(await raw.innerText(), /EF BB BF 41 00 09 0D 0A FF/);
  const hexSurface = ".text-window:not([hidden]) .hex-view";
  const hexFont = await fontSize(hexSurface);
  await wheelFont(hexSurface, -120);
  const enlargedHexFont = await fontSize(hexSurface);
  assert.ok(enlargedHexFont > hexFont, "Ctrl+Wheel should enlarge the hexadecimal viewer's font.");
  await page.getByRole("button", { name: "Close document", exact: true }).click();
  await left.getByRole("option", { name: /^sample.rs/ }).click();
  await page.keyboard.press("F3");
  await page.getByText("fn", { exact: true }).first().waitFor();
  assert.equal(await fontSize(codeSurface), hexFont, "Hexadecimal zoom should leave the text viewer size alone.");
  await page.keyboard.press("Escape");
  if (process.env.DIRLUME_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_SMOKE_SCREENSHOT, scale: "css" });

  const commandLine = page.getByRole("combobox", { name: "Command line" });
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  const toggleTerminal = page.getByRole("button", { name: "Toggle terminal", exact: true });
  const terminalInput = page.locator(".xterm-helper-textarea");
  const terminalFocusHint = page.locator(".statusbar").getByRole("status").filter({ hasText: "File shortcuts paused. Click a file pane to use them." });
  const paneHeight = () => left.evaluate((pane) => pane.getBoundingClientRect().height);
  const compactHeight = await paneHeight();
  await page.locator("#left-files").press("Control+ArrowRight");
  assert.equal(await page.getByRole("separator", { name: "Pane divider" }).getAttribute("aria-valuenow"), "51");
  await commandLine.fill("preserved draft");
  await page.locator(".command-bar").getByRole("button", { name: "Terminal", exact: true }).click();
  await terminal.waitFor();
  await terminalFocusHint.waitFor();
  await commandLine.waitFor();
  assert.equal(await commandLine.inputValue(), "preserved draft");
  const firstHeight = await paneHeight();
  assert.ok(firstHeight < compactHeight, "Opening the terminal should shrink both file panes.");
  const terminalSplit = await paneSplit();
  for (const key of ["ArrowUp", "ArrowDown", "Control+ArrowLeft", "Control+ArrowRight",
    "Control+Shift+ArrowLeft", "Control+Shift+ArrowRight", "F5", "F8", "Alt+F7"]) {
    await terminalInput.press(key);
  }
  assert.equal(await paneSplit(), terminalSplit);
  assert.equal(await paneHeight(), firstHeight);
  assert.equal(await page.getByRole("dialog").count(), 0);
  await terminalInput.press("Control+ArrowUp");
  const expandedHeight = await paneHeight();
  assert.ok(expandedHeight < firstHeight, "Ctrl+Up should make more room for the terminal.");
  await terminalInput.press("F12");
  await terminal.waitFor({ state: "hidden" });
  await terminalFocusHint.waitFor({ state: "hidden" });
  await page.getByRole("navigation", { name: "File actions" }).getByRole("button", { name: "Terminal", exact: true }).click();
  await terminal.waitFor();
  assert.equal(await paneHeight(), expandedHeight);
  await page.locator("#left-files").press("Control+ArrowDown");
  await terminalFocusHint.waitFor({ state: "hidden" });
  assert.ok(Math.abs(await paneHeight() - firstHeight) <= 2);
  const terminalDivider = page.getByRole("separator", { name: "Resize terminal" });
  const terminalBounds = await terminalDivider.boundingBox();
  assert.ok(terminalBounds);
  const dividerX = terminalBounds.x + terminalBounds.width / 2;
  const dividerY = terminalBounds.y + terminalBounds.height / 2;
  await page.mouse.move(dividerX, dividerY);
  await page.mouse.down();
  await page.mouse.move(dividerX, dividerY - 30, { steps: 4 });
  await page.mouse.up();
  const draggedHeight = await paneHeight();
  assert.ok(draggedHeight < firstHeight - 20, "Dragging up should grow the terminal.");
  await toggleTerminal.click();
  await terminal.waitFor({ state: "hidden" });
  assert.equal(await commandLine.inputValue(), "preserved draft");
  assert.equal(await paneHeight(), compactHeight);
  await toggleTerminal.click();
  await terminal.waitFor();
  assert.equal(await paneHeight(), draggedHeight);
  await toggleTerminal.click();
  await commandLine.waitFor();
  assert.equal(await paneHeight(), compactHeight);
  await commandLine.press("Control+ArrowUp");
  await terminal.waitFor();
  assert.equal(await paneHeight(), draggedHeight);
  await toggleTerminal.click();
  await commandLine.waitFor();
  await commandLine.press("Control+o");
  await left.waitFor({ state: "hidden" });
  assert.ok(await page.getByRole("button", { name: "Swap panes", exact: true }).isDisabled());
  await toggleTerminal.click();
  await commandLine.waitFor();
  await left.waitFor();
  await toggleTerminal.click();
  await terminal.getByRole("button", { name: "Close terminal", exact: true }).click();
  await commandLine.waitFor();
  await commandLine.fill("Write-Output ('dirlume-' + 'command-bar-ok')");
  await commandLine.press("Enter");
  try {
    await page.waitForFunction(() => document.querySelector(".xterm-accessibility-tree")?.textContent?.includes("dirlume-command-bar-ok"));
  } catch (error) {
    throw new Error(`The terminal did not run the command bar input. ${await terminal.innerText()}`, { cause: error });
  }
  await terminalInput.press("ArrowUp");
  await terminalInput.press("Enter");
  await page.waitForFunction(() => (document.querySelector(".xterm-accessibility-tree")?.textContent?.match(/dirlume-command-bar-ok/g)?.length ?? 0) >= 2);
  await toggleTerminal.click();
  await commandLine.press("Control+e");
  assert.match(await commandLine.inputValue(), /command-bar-ok/);
  await commandLine.fill("");
  await toggleTerminal.click();

  const input = terminalInput;
  await left.getByRole("option", { name: /^notes\.txt/ }).click();
  await page.keyboard.press("F5");
  await copySetup.waitFor();
  await copySetup.getByRole("button", { name: "Cancel", exact: true }).click();
  await terminal.waitFor();
  await input.focus();
  const terminalText = () => page.locator(".terminal-card").innerText();
  await page.waitForFunction(() => document.querySelector(".xterm-accessibility-tree")?.textContent?.includes("PS "));
  await input.pressSequentially("if ((Get-Location).Path.EndsWith('from')) { Write-Output ('dirlume-' + 'terminal-ok') }");
  await input.press("Enter");
  try {
    await page.waitForFunction(() => document.querySelector(".xterm-accessibility-tree")?.textContent?.includes("dirlume-terminal-ok"));
  } catch (error) {
    throw new Error(`No terminal result. ${await terminalText()} ${pageErrors.join(", ")}`, { cause: error });
  }
  const waitForTerminalText = (text) => page.waitForFunction((text) =>
    document.querySelector(".xterm-accessibility-tree")?.textContent?.includes(text), text);
  const waitForDirectory = (path) => page.waitForFunction((path) =>
    document.querySelector(".terminal-card header span")?.textContent?.toLowerCase() === path.toLowerCase(), path);
  const driveRoot = parse(src).root;
  await input.pressSequentially(`cd ${driveRoot}`);
  await input.press("Enter");
  await waitForDirectory(driveRoot);
  await page.waitForFunction((path) => document.querySelector("#left-path")?.dataset.path.toLowerCase() === path.toLowerCase() &&
    document.querySelector("#left-files")?.getAttribute("aria-busy") === "false", driveRoot);
  assert.equal(await panePath("right"), dst);
  await input.pressSequentially("cd 'missing-dirlume-terminal-fixture'; Write-Output ('unchanged-' + (Get-Location).Path)");
  await input.press("Enter");
  await waitForTerminalText("unchanged-" + driveRoot);
  assert.equal(await panePath("left"), driveRoot);
  const subfolder = join(src, "terminal ' [folder]");
  await mkdir(subfolder);
  await navigate("left", subfolder);
  await waitForDirectory(subfolder);
  assert.ok(await input.count(), "Changing folders should keep the terminal open.");
  await input.pressSequentially("$dirlumeTestSession = 42");
  await input.press("Enter");
  await toggleTerminal.click();
  await commandLine.waitFor();
  await toggleTerminal.click();
  await input.pressSequentially("Write-Output ('dirlume-' + 'busy'); Start-Sleep -Seconds 2; Write-Output ('from:' + (Get-Location).Path)");
  await input.press("Enter");
  await waitForTerminalText("dirlume-busy");
  await right.focus();
  await waitForTerminalText("from:" + subfolder);
  await waitForDirectory(dst);
  await input.pressSequentially("Write-Output ('dirlume-session=' + $dirlumeTestSession)");
  await input.press("Enter");
  await waitForTerminalText("dirlume-session=42");
  await input.pressSequentially("Write-Output ('dirlume-' + 'draft')");
  await navigate("left", subfolder);
  await waitForDirectory(dst);
  await input.press("Enter");
  await waitForTerminalText("dirlume-draft");
  await waitForDirectory(subfolder);
  await toggleTerminal.click();
  await commandLine.press("Alt+F8");
  const commandHistory = page.getByRole("dialog", { name: "Command history", exact: true });
  await commandHistory.getByRole("button", { name: /command-bar-ok/ }).click();
  assert.match(await commandLine.inputValue(), /command-bar-ok/);
  await commandLine.fill("");
  await toggleTerminal.click();
  await navigate("left", src);
  await waitForDirectory(src);
  await input.pressSequentially('[Console]::WriteLine(("$([char]27)[93m" + "dirlume-" + "yellow-probe" + "$([char]27)[0m"))');
  await input.press("Enter");
  async function assertTerminalContrast(previousColor = "") {
    const result = await page.waitForFunction((previousColor) => {
      const span = Array.from(document.querySelectorAll(".xterm-rows span"))
        .find((span) => span.textContent === "dirlume-yellow-probe");
      if (!span) return null;
      const text = getComputedStyle(span).color;
      const background = getComputedStyle(span.closest(".terminal-card")).backgroundColor;
      if (!text || !background || text === previousColor) return null;
      function luminance(color) {
        const [red, green, blue] = color.match(/[\d.]+/g).map((value) => {
          const channel = Number(value) / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return red * 0.2126 + green * 0.7152 + blue * 0.0722;
      }
      const fg = luminance(text);
      const bg = luminance(background);
      return { text, contrast: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) };
    }, previousColor);
    const style = await result.jsonValue();
    assert.ok(style.contrast >= 4.5, `Terminal output contrast was ${style.contrast}`);
    return style.text;
  }
  const lightYellow = await assertTerminalContrast();
  if (process.env.DIRLUME_TERMINAL_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_TERMINAL_SCREENSHOT, scale: "css" });
  await showOptions();
  await optionsDialog.getByRole("button", { name: "Text tools", exact: true }).click();
  const textBackground = optionsDialog.getByLabel("Editor, viewer, and terminal background hex");
  await textBackground.fill("#101924");
  await optionsDialog.getByRole("button", { name: "Apply", exact: true }).click();
  await keepSuggestedColorSchemeName(optionsPage);
  await closeToolWindow(optionsPage, () => optionsDialog.getByRole("button", { name: "Done", exact: true }).click());
  await assertTerminalContrast(lightYellow);
  if (process.env.DIRLUME_DARK_TERMINAL_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_DARK_TERMINAL_SCREENSHOT, scale: "css" });
  await page.getByRole("button", { name: "Close terminal" }).click();

  await withServer(async ({ invitation, config, bytes }) => {
    const remote = page.getByRole("listbox", { name: "left files", exact: true });
    const local = page.getByRole("listbox", { name: "right files", exact: true });
    async function openRemoteConnections() {
      await leftPane.getByRole("button", { name: "Locations for left pane", exact: true }).click();
      await leftPane.getByRole("button", { name: "Remote machine", exact: true }).click();
      await page.waitForFunction(() => document.getElementById("left-path")?.dataset.path === "Remote machine");
    }
    await openRemoteConnections();
    assert.deepEqual(await remote.locator(".file-name-text").allTextContents(), []);
    assert.equal(await leftPane.getByRole("button", { name: "Parent folder", exact: true }).isDisabled(), true);
    await remote.press("Shift+F4");
    const add = page.getByRole("dialog", { name: "Add remote machine", exact: true });
    await add.getByLabel("Connection name").fill("Local test server");
    await add.getByLabel("Server invitation").fill(invitation);
    await add.getByRole("button", { name: "Save connection", exact: true }).click();
    const savedServer = remote.getByRole("option", { name: /^Local test server/ });
    await savedServer.click();
    assert.doesNotMatch(await page.evaluate(() => localStorage.getItem("dirlume.remote-connections")), /dirlume-v1:/);
    await remote.press("F4");
    const edit = page.getByRole("dialog", { name: "Edit remote machine", exact: true });
    assert.equal(await edit.getByLabel("Server invitation").inputValue(), "");
    await edit.getByLabel("Connection name").fill("Saved test server");
    await edit.getByRole("button", { name: "Save connection", exact: true }).click();
    const renamedServer = remote.getByRole("option", { name: /^Saved test server/ });
    await renamedServer.click();
    await remote.press("Enter");
    const remoteFolder = remote.getByRole("option", { name: /^folder/ });
    await remoteFolder.waitFor();
    await remote.press("Control+F12");
    const remoteSort = page.getByRole("dialog", { name: "Sort by", exact: true });
    assert.equal(await remoteSort.locator('[data-sort-mode="streamCount"]').getAttribute("aria-disabled"), "true");
    assert.equal(await remoteSort.locator('[data-sort-mode="hardLinks"]').getAttribute("aria-disabled"), "true");
    assert.equal(await remoteSort.locator('[data-sort-mode="modified"]').getAttribute("aria-disabled"), null);
    await page.keyboard.press("Escape");
    await remoteFolder.click();
    await remote.press("Control+a");
    await properties.getByText("folder", { exact: true }).waitFor();
    assert.equal(await properties.getByRole("button", { name: "Apply", exact: true }).isDisabled(), true);
    assert.equal(await flag("Hidden").isDisabled(), true);
    await cancelAttributes();
    await page.keyboard.press("F5");
    await finishTransfer("Copy");
    await local.getByRole("option", { name: /^folder/ }).waitFor();
    assert.deepEqual(await readFile(join(dst, "folder", "файл.bin")), bytes);
    await remote.focus();
    await page.getByRole("button", { name: "Find files", exact: true }).click();
    await mask.fill("*.md");
    await search.getByRole("button", { name: "Search", exact: true }).click();
    await matches.getByRole("option", { name: "folder/remote.md", exact: true }).waitFor();
    await search.getByRole("button", { name: "Go to file", exact: true }).click();
    await remote.getByRole("option", { name: /^remote.md/ }).click();
    await page.keyboard.press("F3");
    await page.getByRole("heading", { name: "Remote Markdown" }).waitFor();
    assert.equal(await page.locator(".text-window:not([hidden]) .document-heading h2").textContent(),
      new URL(config.address).origin + "/folder/remote.md");
    await page.keyboard.press("F4");
    await raw.waitFor();
    assert.match(await raw.innerText(), /23 20 52 65 6D 6F 74 65/);
    await page.getByRole("button", { name: "Close document", exact: true }).click();
    await page.getByRole("option", { name: /^файл.bin/ }).click();
    await page.keyboard.press("F5");
    await finishTransfer("Copy");
    await page.getByRole("listbox", { name: "right files", exact: true }).getByRole("option", { name: /^файл.bin/ }).waitFor();
    assert.deepEqual(await readFile(join(dst, "файл.bin")), bytes);
    const back = leftPane.getByRole("button", { name: "Back", exact: true });
    await back.click();
    await page.waitForFunction(() => document.getElementById("left-path")?.dataset.path === "/");
    await back.click();
    await leftPane.getByRole("heading", { name: "from", exact: true }).waitFor({ state: "attached" });
    await openRemoteConnections();
    await renamedServer.click();
    await remote.press("F8");
    await page.getByRole("dialog", { name: "Remove connection", exact: true })
      .getByRole("button", { name: "Remove connection", exact: true }).click();
    await renamedServer.waitFor({ state: "detached" });
    assert.equal(await leftPane.getByRole("button", { name: "Parent folder", exact: true }).isDisabled(), true);
    await back.click();
    await leftPane.getByRole("heading", { name: "from", exact: true }).waitFor({ state: "attached" });
  });
  await left.getByRole("option", { name: /^guide.md/ }).click({ modifiers: ["Control"] });
  await page.keyboard.press("F3");
  await diagram.waitFor();
  await page.reload();
  await diagram.waitFor();
  assert.equal(await page.getByRole("navigation", { name: "Open documents" }).getByRole("button", { name: "View guide.md" }).getAttribute("aria-pressed"), "true");
  await page.keyboard.press("Control+Tab");
  await wheelFont("#right-files", -120);
  const enlargedRight = await fontSize("#right-pane");
  const columnWidth = (side, column) => page.locator(`#${side}-pane .col-${column}`).evaluate((element) => element.getBoundingClientRect().width);
  const waitForColumnWidth = (side, column, width) => page.waitForFunction(({ selector, width }) =>
    document.querySelector(selector)?.getBoundingClientRect().width === width,
  { selector: `#${side}-pane .col-${column}`, width });
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.locator("#right-files .file-time").filter({ hasText: /\d{1,2}:\d{2}/ }).first().waitFor();
  assert.equal(await page.locator(".file-columns [role=separator]").count(), 0);
  const leftSize = await columnWidth("left", "size");
  const rightSize = await columnWidth("right", "size");
  const rightModified = await columnWidth("right", "modified");
  const rightTime = await columnWidth("right", "time");
  const timeEdge = () => page.locator("#right-pane .col-time").evaluate((element) => element.getBoundingClientRect().right);
  const initialTimeEdge = await timeEdge();
  const timedRow = left.getByRole("option", { name: /^guide\.md/ });
  assert.doesNotMatch(await timedRow.locator(".file-date").innerText(), /:/);
  assert.match(await timedRow.locator(".file-time").innerText(), /\d{1,2}:\d{2}/);
  assert.ok(await left.evaluate((list) => {
    const pane = list.closest(".pane");
    const fits = list.scrollWidth === list.clientWidth;
    const column = pane.querySelector(".col-size").getBoundingClientRect();
    const cell = list.querySelector(".file-size").getBoundingClientRect();
    const name = pane.querySelector(".col-name").getBoundingClientRect();
    return fits && Math.abs(column.left - cell.left) <= 1 && Math.abs(column.left - name.right) <= 1;
  }), "Name should fill the space up to Size, with matching headers and rows.");
  assert.ok(Math.abs(await timeEdge() - initialTimeEdge) <= 1);
  const columnMenu = () => page.getByRole("menu", { name: "Columns", exact: true });
  const rightHeader = () => page.locator("#right-pane .file-columns");
  await rightHeader().getByRole("button", { name: "Time", exact: true }).click();
  await rightHeader().locator(".col-time button svg").waitFor();
  await rightHeader().getByRole("button", { name: "Date", exact: true }).click({ button: "right" });
  assert.equal(await columnMenu().getByRole("menuitemcheckbox", { name: "Name", exact: true, checked: true }).isDisabled(), true);
  const modifiedPosition = await rightHeader().locator(".col-modified").evaluate((column) => column.getBoundingClientRect().left);
  await columnMenu().getByRole("menuitemcheckbox", { name: "Size", exact: true, checked: true }).click();
  await rightHeader().getByRole("button", { name: "Size", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await page.locator("#right-files .file-size:visible").count(), 0);
  assert.equal(await columnWidth("right", "modified"), rightModified);
  const newModifiedPosition = await rightHeader().locator(".col-modified").evaluate((column) => column.getBoundingClientRect().left);
  assert.ok(Math.abs(newModifiedPosition - modifiedPosition) <= 1);
  assert.equal(await columnWidth("left", "size"), leftSize);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await columnMenu().getByRole("menuitemcheckbox", { name: "Date", exact: true, checked: false }).waitFor();
  await rightHeader().getByRole("button", { name: "Date", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await page.locator("#right-files .file-date:visible").count(), 0);
  assert.ok(await rightHeader().getByRole("button", { name: "Time", exact: true }).isVisible());
  await columnMenu().getByRole("menuitemcheckbox", { name: "Size", exact: true, checked: false }).click();
  assert.equal(await columnWidth("right", "size"), rightSize);
  await page.keyboard.press("Escape");
  await columnMenu().waitFor({ state: "hidden" });
  assert.equal(await rightHeader().getByRole("button", { name: "Name", exact: true }).evaluate((button) => button === document.activeElement), true);
  await exitDesktop(page);
  page = await startDesktop();
  if (diagnosticsBeforeRestart !== undefined) {
    assert.ok((await readFile(diagnosticsFile, "utf8")).startsWith(diagnosticsBeforeRestart));
    console.log("Verified diagnostic log context, redaction, deduplication, and persistence after restart.");
  }
  await page.getByRole("button", { name: "View guide.md" }).click();
  await page.getByRole("img", { name: "Mermaid diagram" }).waitFor();
  assert.equal(await fontSize(markdownSurface), enlargedMarkdown, "Restarting should restore the Markdown font size.");
  await page.keyboard.press("Control+Tab");
  assert.equal(await fontSize("#right-pane"), enlargedRight, "Restarting should restore the individual pane font size.");
  await waitForColumnWidth("left", "size", leftSize);
  await waitForColumnWidth("right", "size", rightSize);
  await rightHeader().getByRole("button", { name: "Date", exact: true }).waitFor({ state: "hidden" });
  await waitForColumnWidth("right", "time", rightTime);
  await rightHeader().locator(".col-time button svg").waitFor();
  await rightHeader().getByRole("button", { name: "Name", exact: true }).press("Shift+F10");
  await columnMenu().getByRole("menuitemcheckbox", { name: "Date", exact: true, checked: false }).click();
  await page.keyboard.press("Escape");
  await columnMenu().waitFor({ state: "hidden" });
  await waitForColumnWidth("right", "modified", rightModified);
  assert.equal(await panePath("left"), src);
  assert.equal(await panePath("right"), dst);
  await page.getByRole("listbox", { name: "left files", exact: true }).getByRole("option", { name: /^guide.md/, selected: true }).waitFor();
  await showOptions();
  assert.equal(await optionsDialog.getByRole("button", { name: "Text tools", exact: true }).getAttribute("aria-pressed"), "true");
  await optionsDialog.getByRole("button", { name: "View font sizes", exact: true }).click();
  assert.equal(await optionsDialog.getByRole("spinbutton", { name: "Markdown reading view font size" }).inputValue(), String(enlargedMarkdown));
  assert.equal(await optionsDialog.getByRole("spinbutton", { name: "Hexadecimal view font size" }).inputValue(), String(enlargedHexFont));
  await optionsDialog.getByRole("button", { name: "Window", exact: true }).click();
  assert.equal(await optionsDialog.getByLabel("Scheme name").inputValue(), "Blueprint");
  assert.equal(await page.locator("html").evaluate((element) => element.style.getPropertyValue("--file-hidden")), "#41536d");
  assert.equal(await page.locator("html").evaluate((element) => element.style.getPropertyValue("--file-system")), "#73124c");
  await closeToolWindow(optionsPage, () => optionsDialog.getByRole("button", { name: "Done", exact: true }).click());

  await showOptions();
  const englishOptions = optionsPage.getByRole("dialog", { name: "Options", exact: true });
  await englishOptions.getByRole("button", { name: "General", exact: true }).click();
  await englishOptions.getByLabel("Language", { exact: true }).selectOption("uk");
  await englishOptions.getByRole("button", { name: "Apply", exact: true }).click();
  const ukrainianOptions = optionsPage.getByRole("dialog", { name: "Налаштування", exact: true });
  assert.equal(await ukrainianOptions.getByLabel("Мова", { exact: true }).inputValue(), "uk");
  assert.equal(await page.locator("html").getAttribute("lang"), "uk");
  const ukrainianSearch = ukrainianOptions.getByRole("searchbox", { name: "Пошук налаштувань", exact: true });
  await ukrainianSearch.fill("Шрифти");
  await ukrainianSearch.press("F1");
  const ukrainianHelp = optionsPage.getByRole("dialog", { name: "Довідка", exact: true });
  await ukrainianHelp.getByRole("heading", { name: "Загальні", exact: true }).waitFor();
  const ukrainianTopics = ukrainianHelp.getByRole("navigation", { name: "Зміст" }).getByRole("link");
  const topicLinks = await ukrainianTopics.evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  await ukrainianHelp.getByRole("link", { name: "Термінал", exact: true }).click();
  assert.match(await ukrainianHelp.locator("#help-terminal").innerText(), /інтерактивну оболонку/);
  await optionsPage.keyboard.press("Escape");
  assert.equal(await ukrainianSearch.inputValue(), "Шрифти");
  assert.equal(await ukrainianSearch.evaluate((field) => field === document.activeElement), true);
  await ukrainianSearch.press("Enter");
  await ukrainianOptions.getByRole("heading", { name: "Шрифти", exact: true }).waitFor();
  await ukrainianSearch.fill("");
  await closeToolWindow(optionsPage, () => ukrainianOptions.getByRole("button", { name: "Готово", exact: true }).click());
  await page.getByRole("button", { name: "Знайти файли", exact: true }).click();
  const ukrainianFind = page.getByRole("dialog", { name: "Знайти файли", exact: true });
  await ukrainianFind.getByLabel("Маска файлів", { exact: true }).waitFor();
  await ukrainianFind.getByRole("button", { name: "Закрити", exact: true }).click();
  await exitDesktop(page);
  page = await startDesktop();
  await page.getByRole("button", { name: "Знайти файли", exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "uk");
  assert.equal(await page.locator("#left-pane .col-name button").textContent(), "Назва");
  await rightHeader().getByRole("button", { name: "Назва", exact: true }).click({ button: "right" });
  const ukrainianColumns = page.getByRole("menu", { name: "Колонки", exact: true });
  await ukrainianColumns.getByRole("menuitemcheckbox", { name: "Розмір", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await ukrainianColumns.waitFor({ state: "hidden" });
  optionsPage = await openOptionsWindow(page, () => page.getByRole("button", { name: "Налаштування", exact: true }).click(), "Налаштування");
  const reopenedOptions = optionsPage.getByRole("dialog", { name: "Налаштування", exact: true });
  await reopenedOptions.getByRole("button", { name: "Загальні", exact: true }).click();
  await reopenedOptions.getByLabel("Мова", { exact: true }).selectOption("ru");
  await closeToolWindow(optionsPage, () => reopenedOptions.getByRole("button", { name: "Готово", exact: true }).click());
  assert.equal(await page.locator("html").getAttribute("lang"), "ru");
  assert.equal(await page.locator("#left-pane .col-name button").textContent(), "Имя");
  await page.locator("#left-pane .file-list").press("F1");
  const russianHelp = page.getByRole("dialog", { name: "Справка", exact: true });
  await russianHelp.getByRole("heading", { name: "Основные файловые панели", exact: true }).waitFor();
  assert.deepEqual(await russianHelp.getByRole("navigation", { name: "Оглавление" }).getByRole("link")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href"))), topicLinks);
  assert.match(await russianHelp.locator("#help-files").innerText(), /Введите путь/i);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Найти файлы", exact: true }).click();
  const russianFind = page.getByRole("dialog", { name: "Найти файлы", exact: true });
  await russianFind.getByLabel("Маска файлов", { exact: true }).waitFor();
  await russianFind.getByRole("button", { name: "Закрыть", exact: true }).click();
  optionsPage = await openOptionsWindow(page, () => page.getByRole("button", { name: "Настройки", exact: true }).click(), "Настройки");
  const russianOptions = optionsPage.getByRole("dialog", { name: "Настройки", exact: true });
  assert.equal(await russianOptions.getByLabel("Язык", { exact: true }).inputValue(), "ru");
  await russianOptions.getByLabel("Язык", { exact: true }).selectOption("en");
  await closeToolWindow(optionsPage, () => russianOptions.getByRole("button", { name: "Готово", exact: true }).click());
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  await page.getByRole("button", { name: "Options", exact: true }).waitFor();
  console.log("Verified English, Ukrainian and Russian interface switching and language restoration after restart.");

  if (process.env.DIRLUME_FTP_PYTHON) {
    await page.getByRole("button", { name: "View guide.md" }).click();
    await page.keyboard.press("Escape");
    await testFtp(page, temp, src, dst, join(temp, "ftp-config"), async () => {
      await exitDesktop(page);
      page = await startDesktop();
      return page;
    });
    await navigate("left", src);
    await navigate("right", dst);
  }
  await showOptions();
  const featureDialog = optionsDialog;
  const featureSearch = featureDialog.getByRole("searchbox", { name: "Search settings" });
  await featureSearch.fill("show hidden files");
  await featureSearch.press("Enter");
  await featureDialog.getByRole("heading", { name: "Main File Panels", exact: true }).waitFor();
  await featureDialog.getByRole("checkbox", { name: "Show hidden files" }).waitFor();
  const layoutSelect = featureDialog.getByRole("combobox", { name: "Panel layout" });
  assert.deepEqual(await layoutSelect.locator("option").evaluateAll((options) => options.map((option) => option.value)),
    ["standard", "twin", "classic"]);
  const actionButtonWidth = featureDialog.getByRole("combobox", { name: "Action button width" });
  const actionBarDisplay = () => page.locator(".actionbar").evaluate((bar) => getComputedStyle(bar).display);
  assert.equal(await actionButtonWidth.inputValue(), "compact");
  assert.equal(await actionBarDisplay(), "flex");
  await actionButtonWidth.selectOption("full");
  const leftDrives = page.getByRole("navigation", { name: "Drives and places for left pane", exact: true });
  for (const layout of ["twin", "classic"]) {
    await layoutSelect.selectOption(layout);
    await featureDialog.getByRole("button", { name: "Apply", exact: true }).click();
    await page.locator(`.app[data-layout="${layout}"]`).waitFor();
    assert.ok(await leftDrives.getByRole("button").count() > 0);
    assert.equal(await actionBarDisplay(), "grid");
  }
  await layoutSelect.selectOption("standard");
  await featureDialog.getByRole("button", { name: "Apply", exact: true }).click();
  await page.locator('.app[data-layout="standard"]').waitFor();
  assert.equal(await leftDrives.count(), 0);
  assert.equal(await actionBarDisplay(), "grid");
  await featureDialog.getByLabel("Panel background hex", { exact: true }).waitFor();
  await featureDialog.getByRole("spinbutton", { name: "Left file pane font size" }).waitFor();
  async function checkFeatureFontLayout() {
    const fits = await featureDialog.locator(".font-setting:has(.feature-font-sizes)").first().evaluate((group) => {
      const family = group.querySelector(".font-family").getBoundingClientRect();
      const size = group.querySelector(".font-size-controls").getBoundingClientRect();
      const details = group.querySelector(".feature-font-sizes").getBoundingClientRect();
      return Math.abs(details.left - family.left) < 1 && Math.abs(details.right - size.right) < 1 &&
        details.top >= Math.max(family.bottom, size.bottom);
    });
    assert.ok(fits, "Individual sizes should span both columns below the font family and size controls.");
  }
  await checkFeatureFontLayout();
  const featureFonts = [["Viewer", "Consolas", "21"], ["Editor", "Courier New", "19"], ["Terminal", "Arial", "17"]];
  for (const [name, family, size] of featureFonts) {
    await featureSearch.fill(`${name} font size`);
    await featureSearch.press("Enter");
    await featureDialog.getByRole("heading", { name, exact: true }).waitFor();
    await featureDialog.getByRole("combobox", { name: `${name} font family`, exact: true }).fill(family);
    await featureDialog.getByRole("spinbutton", { name: `${name} font size`, exact: true }).fill(size);
    if (name === "Viewer") {
      await checkFeatureFontLayout();
      await featureDialog.getByRole("spinbutton", { name: "Max width (px)", exact: true }).fill("640");
      await featureDialog.getByLabel("Viewer background hex", { exact: true }).fill("#142335");
      await featureDialog.getByLabel("Block background hex", { exact: true }).fill("#056767");
    }
  }
  await featureSearch.fill("");
  await closeToolWindow(optionsPage, async () => {
    await featureDialog.getByRole("button", { name: "Done", exact: true }).click();
    if (!optionsPage.isClosed()) await keepSuggestedColorSchemeName(optionsPage);
  });
  await exitDesktop(page);
  page = await startDesktop();
  await page.getByRole("button", { name: "Options", exact: true }).waitFor();
  assert.equal(await page.locator(".actionbar").getAttribute("data-button-width"), "full");
  const featureValues = await page.locator("html").evaluate((root) => {
    const style = getComputedStyle(root);
    return ["viewer", "editor", "terminal"].map((view) => [style.getPropertyValue(`--${view}-font`), style.getPropertyValue(`--${view}-size`)]);
  });
  assert.deepEqual(featureValues.map(([, size]) => size), featureFonts.map(([, , size]) => `${size}px`));
  featureFonts.forEach(([, family], index) => assert.ok(featureValues[index][0].replaceAll("\\", "").startsWith(family)));
  const filesTab = page.getByRole("navigation", { name: "Open documents", exact: true }).getByRole("button", { name: "Files", exact: true });
  if (await filesTab.isVisible()) await filesTab.click();
  const sampleForFonts = leftPane.getByRole("option", { name: /^sample\.rs/ });
  const sampleSurface = page.getByRole("region", { name: "sample.rs", exact: true }).locator(".code-surface");
  for (const [shortcut, expected] of [["F3", "21px"], ["F4", "19px"]]) {
    await sampleForFonts.click();
    await page.keyboard.press(shortcut);
    assert.equal(await sampleSurface.evaluate((surface) => getComputedStyle(surface).fontSize), expected);
    await page.locator(".actionbar").waitFor({ state: "hidden" });
    await page.keyboard.press("F1");
    await page.getByRole("dialog", { name: "Help", exact: true })
      .getByRole("heading", { name: shortcut === "F3" ? "Viewer" : "Editor", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Help", exact: true }).waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.closest(".text-window:not([hidden])"));
    await sampleSurface.waitFor();
    await page.keyboard.press("Escape");
    await sampleSurface.waitFor({ state: "hidden" });
    const filesPane = page.getByRole("listbox", { name: "left files", exact: true });
    if (!await filesPane.isVisible()) {
      const documents = page.getByRole("navigation", { name: "Open documents" });
      await documents.getByRole("button", { name: "Files", exact: true }).click();
    }
    await filesPane.waitFor();
  }
  assert.equal(await page.getByRole("combobox", { name: "Command line" }).evaluate((input) => getComputedStyle(input).fontSize), "17px");
  console.log("Verified feature settings search, independent font overrides, and persistence after restart.");
  const help = page.getByRole("dialog", { name: "Help", exact: true });
  await page.context().setOffline(true);
  try {
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press("F1");
    const contents = help.getByRole("navigation", { name: "Table of contents" });
    await contents.waitFor();
    const links = contents.getByRole("link");
    assert.ok(topicLinks.includes("#help-archives"));
    assert.deepEqual(await links.evaluateAll((items) => items.map((link) => link.getAttribute("href"))), topicLinks);
    if (process.env.DIRLUME_HELP_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_HELP_SCREENSHOT, scale: "css" });
    for (const href of topicLinks) {
      const link = contents.locator(`a[href="${href}"]`);
      await link.click();
      assert.equal(await help.locator(`${href} h3`).innerText(), await link.innerText());
      assert.match(await help.locator(`${href} p`).first().innerText(), /\S/);
    }
    await page.keyboard.press("Control+f");
    const helpSearch = help.getByRole("searchbox", { name: "Search Help", exact: true });
    assert.ok(await helpSearch.evaluate((node) => node === document.activeElement));
    await helpSearch.fill("select all");
    await help.locator('.help-results a[href="#help-terminal"]').press("Enter");
    await help.locator("#help-terminal [data-help-match]").filter({ hasText: "Select All" }).waitFor();
    await help.getByRole("button", { name: "Clear Help search", exact: true }).click();
    await contents.locator('[aria-current="location"][href="#help-terminal"]').waitFor();
    await page.keyboard.press("Escape");
  } finally {
    await page.context().setOffline(false);
  }

  const terminalButton = page.getByRole("button", { name: "Toggle terminal", exact: true });
  if (await terminalButton.getAttribute("aria-pressed") === "false") await terminalButton.click();
  const helpTerminalInput = page.locator(".xterm-helper-textarea");
  await helpTerminalInput.press("F1");
  await help.getByRole("heading", { name: "Terminal", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await help.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.matches(".xterm-helper-textarea"));
  await terminalButton.click();
  await page.getByRole("combobox", { name: "Command line", exact: true }).press("F1");
  await help.getByRole("heading", { name: "Terminal", exact: true }).waitFor();
  await page.keyboard.press("Escape");

  await showOptions();
  const shortcutOptions = optionsDialog;
  const shortcutSearch = shortcutOptions.getByRole("searchbox", { name: "Search settings" });
  await shortcutSearch.fill("");
  const helpAppearance = shortcutOptions.getByRole("button", { name: "Appearance", exact: true });
  await helpAppearance.press("F1");
  const optionsHelp = optionsPage.getByRole("dialog", { name: "Help", exact: true });
  await optionsHelp.locator('.help-contents [aria-current="location"][href="#help-appearance"]').waitFor();
  await optionsHelp.locator('.help-reading a[href="#help-window"]').press("Enter");
  await optionsHelp.locator('.help-contents [aria-current="location"][href="#help-window"]').waitFor();
  await optionsPage.keyboard.press("Escape");
  await optionsHelp.waitFor({ state: "hidden" });
  const appearanceFocus = await helpAppearance.elementHandle();
  try { await optionsPage.waitForFunction((element) => element === document.activeElement, appearanceFocus); }
  finally { await appearanceFocus.dispose(); }
  await shortcutSearch.fill("help");
  await shortcutOptions.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  await shortcutOptions.getByRole("button", { name: "Change F1 for Help", exact: true }).click();
  const captureHelp = shortcutOptions.getByRole("textbox", { name: "New shortcut to replace F1 for Help", exact: true });
  await captureHelp.press("F4");
  await shortcutConflict().getByText(/F4 is assigned to .*Edit text/).waitFor();
  await shortcutConflict().getByRole("button", { name: "Choose another shortcut", exact: true }).click();
  await captureHelp.press("Control+Shift+F1");
  await shortcutOptions.getByRole("button", { name: "Apply", exact: true }).click();
  await shortcutOptions.getByRole("button", { name: "Change Ctrl+Shift+F1 for Help", exact: true }).waitFor();
  // Verify Dirlume no longer handles F1 without invoking the WebView's native help accelerator.
  await shortcutSearch.dispatchEvent("keydown", { key: "F1", code: "F1", bubbles: true });
  assert.equal(await help.count(), 0);
  await shortcutSearch.press("Control+Shift+F1");
  await optionsPage.getByRole("dialog", { name: "Help", exact: true }).waitFor();
  await optionsPage.keyboard.press("Escape");
  await shortcutOptions.getByRole("button", { name: "Remove Ctrl+Shift+F1 from Help", exact: true }).click();
  await closeToolWindow(optionsPage, () => shortcutOptions.getByRole("button", { name: "Done", exact: true }).click());
  await page.keyboard.press("Control+Shift+F1");
  assert.equal(await help.count(), 0);
  await showOptions();
  await optionsDialog.getByRole("button", { name: "Add shortcut for Help", exact: true }).click();
  await optionsDialog.getByRole("textbox", { name: "New shortcut for Help", exact: true }).press("F1");
  await closeToolWindow(optionsPage, () => optionsDialog.getByRole("button", { name: "Done", exact: true }).click());
  console.log("Verified offline Help, all topics in three languages, focus restoration, and rebinding or disabling F1.");
  const menubar = page.getByRole("menubar", { name: "Main menu" });
  const group = (name) => menubar.getByRole("menuitem", { name, exact: true });
  const menu = (name) => menubar.getByRole("menu", { name, exact: true });
  const fileList = page.getByRole("listbox", { name: "left files", exact: true });
  await fileList.focus();
  await page.keyboard.press("Alt");
  await menubar.waitFor();
  assert.deepEqual(await menubar.getByRole("menuitem").allTextContents(), ["Left", "Files", "Commands", "Options", "Right", "Help"]);
  await group("Left").focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowDown");
  const helpItems = menu("Help").getByRole("menuitem");
  assert.deepEqual(await helpItems.locator("span").allTextContents(), ["Help", "What's new", "About", "Open error log"]);
  const errorLogAction = helpItems.filter({ hasText: "Open error log" });
  assert.equal(await errorLogAction.evaluate((item) => item.previousElementSibling?.getAttribute("role")), "separator");
  await page.keyboard.press("Enter");
  await help.getByRole("navigation", { name: "Table of contents" }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await fileList.evaluate((list) => document.activeElement === list), true);
  await openMainMenu(page, "Help");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const whatsNew = page.getByRole("dialog", { name: "What's new", exact: true });
  const releaseNotes = whatsNew.getByRole("link", { name: `Full release notes for ${productVersion}`, exact: true });
  assert.match(await releaseNotes.getAttribute("href"), new RegExp(`/releases/tag/v${productVersion.replaceAll(".", "\\.")}$`));
  await page.keyboard.press("Escape");
  await whatsNew.waitFor({ state: "hidden" });
  await openMainMenu(page, "Help");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const about = page.getByRole("dialog", { name: "About", exact: true });
  await about.getByText("Dirlume", { exact: true }).waitFor();
  await about.getByText(buildNumber ? `${productVersion}+${buildNumber}` : productVersion, { exact: true }).waitFor();
  await about.getByRole("button", { name: "Donate via monobank", exact: true }).waitFor();
  assert.ok(await about.locator("img").evaluate((image) => image.complete && image.naturalWidth > 0));
  assert.equal(await about.getByRole("link", { name: "Anatolii Hrynchuk", exact: true }).getAttribute("href"), "https://hrynco.com/");
  await about.getByRole("button", { name: "Report an issue", exact: true }).waitFor();
  await about.getByRole("button", { name: "Releases", exact: true }).waitFor();
  await about.getByRole("button", { name: "User guide", exact: true }).click();
  await help.getByRole("navigation", { name: "Table of contents" }).waitFor();
  await page.keyboard.press("Escape");
  const errorLogViewer = page.getByRole("region", { name: "diagnostics.jsonl", exact: true });
  await appendDiagnosticFixture(diagnosticsFile);
  await openMainMenu(page, "Help");
  assert.equal(await helpItems.getByText("Clear error log", { exact: true }).count(), 0);
  await page.keyboard.press("End");
  assert.equal(await errorLogAction.evaluate((item) => item === document.activeElement), true);
  await page.keyboard.press("Enter");
  await errorLogViewer.waitFor();
  await checkDiagnosticLog(errorLogViewer, diagnosticsFile);
  await page.keyboard.press("Escape");
  await errorLogViewer.waitFor({ state: "hidden" });
  const oversizedLog = Buffer.alloc(8 * 1024 * 1024 + 1, " ");
  await writeFile(diagnosticsFile, oversizedLog);
  await openMainMenu(page, "Help");
  await errorLogAction.click();
  await errorLogViewer.waitFor();
  await errorLogViewer.getByText("Text files can be at most 8 MiB.", { exact: true }).waitFor();
  await setTimeout(400);
  assert.equal((await readFile(diagnosticsFile)).length, oversizedLog.length);
  const clearLogDialog = page.getByRole("dialog", { name: "Clear error log", exact: true });
  const logFileMenu = errorLogViewer.getByRole("menuitem", { name: "File", exact: true });
  const clearLogAction = errorLogViewer.getByRole("menuitem", { name: "Clear error log", exact: true });
  await logFileMenu.press("ArrowDown");
  await clearLogAction.press("Enter");
  const cancelLogClear = clearLogDialog.getByRole("button", { name: "Cancel", exact: true });
  assert.equal(await cancelLogClear.evaluate((button) => button === document.activeElement), true);
  await cancelLogClear.click();
  assert.equal((await readFile(diagnosticsFile)).length, oversizedLog.length);
  await logFileMenu.click();
  await clearLogAction.click();
  await clearLogDialog.getByRole("button", { name: "Clear error log", exact: true }).click();
  await clearLogDialog.waitFor({ state: "hidden" });
  assert.equal((await readFile(diagnosticsFile)).length, 0);
  await errorLogViewer.getByText("No errors have been logged yet.", { exact: true }).waitFor();
  await appendDiagnosticFixture(diagnosticsFile);
  await errorLogViewer.locator(".diagnostic-entry > summary").first().waitFor();
  await errorLogViewer.getByRole("button", { name: "Close document", exact: true }).click();
  await errorLogViewer.waitFor({ state: "hidden" });
  await openMainMenu(page, "Files");
  const attributesAction = menu("Files").getByRole("menuitem", { name: "File attributes", exact: true });
  assert.match(await attributesAction.getAttribute("data-tooltip"), /Ctrl\+A/);
  if (process.env.DIRLUME_MENU_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_MENU_SCREENSHOT, scale: "css" });
  await page.keyboard.press("Escape");
  await menu("Files").waitFor({ state: "hidden" });
  await openMainMenu(page, "Commands");
  const updateAction = menu("Commands").getByRole("menuitem", { name: "Check for updates", exact: true });
  await updateAction.click();
  const updateStatus = page.getByRole("dialog", { name: "Check for updates", exact: true });
  await updateStatus.getByText("Dirlume is up to date.", { exact: true }).waitFor();
  await updateStatus.getByRole("button", { name: "Close", exact: true }).click();
  async function openAppearance() {
    await showOptions();
    const settings = optionsDialog;
    await settings.getByRole("searchbox", { name: "Search settings" }).fill("");
    await settings.getByRole("button", { name: "Appearance", exact: true }).click();
    const windowSection = settings.getByRole("button", { name: "Window", exact: true });
    if (!await windowSection.isVisible()) await settings.getByRole("button", { name: "Appearance", exact: true }).click();
    await windowSection.click();
    return settings;
  }
  // The modern themes share rounded panes and must keep text readable on every surface.
  const contrast = (foreground, background) => {
    const [light, dark] = [foreground, background].map((rgb) => rgb.match(/\d+/g).slice(0, 3).map((value) => {
      const channel = Number(value) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)).sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
  };
  const modernAppearance = await openAppearance();
  for (const [modernTheme, colorScheme] of [["lavender", "light"], ["emerald", "dark"], ["aurora", "dark"], ["midnight", "dark"],
    ["sunrise", "light"], ["graphite", "dark"]]) {
    await modernAppearance.getByLabel("Color scheme", { exact: true }).selectOption(modernTheme);
    await modernAppearance.locator(`.preview-frame[data-theme=${modernTheme}]`).waitFor();
    await modernAppearance.getByRole("button", { name: "Apply", exact: true }).click();
    const modernRoot = page.locator(`html[data-theme=${modernTheme}][data-look=modern]`);
    await modernRoot.waitFor();
    const modern = await modernRoot.evaluate((root) => {
      const probe = document.createElement("span");
      probe.hidden = true;
      document.body.append(probe);
      const value = (name) => {
        probe.style.color = `var(--${name})`;
        return getComputedStyle(probe).color;
      };
      const pairs = [["panel-ink", "panel-bg"], ["panel-muted", "panel-bg"], ["panel-selected-ink", "panel-selection"],
        ["ink", "surface"], ["dialog-ink", "dialog-bg"], ["text-ink", "text-bg"],
        ...["source", "text", "document", "image", "media", "archive", "config", "executable", "hidden", "system"]
          .flatMap((group) => [[`file-${group}`, "panel-bg"], [`file-${group}`, "hover"]])].map(([ink, background]) => [value(ink), value(background)]);
      probe.remove();
      return { pairs, colorScheme: getComputedStyle(root).colorScheme,
        radius: getComputedStyle(root.querySelector("#left-pane")).borderTopLeftRadius };
    });
    assert.equal(modern.colorScheme, colorScheme);
    assert.equal(modern.radius, "14px");
    for (const [foreground, background] of modern.pairs) {
      assert.ok(contrast(foreground, background) >= 4.5, `${modernTheme}: ${foreground} on ${background} must be readable`);
    }
  }
  await closeToolWindow(optionsPage, () => modernAppearance.getByRole("button", { name: "Done", exact: true }).click());
  console.log("Verified the Lavender, Emerald, Aurora, Midnight blue, Sunrise, and Graphite themes.");
  const themeRoot = () => page.locator("html[data-theme=classic-blue]");
  const appearance = await openAppearance();
  await appearance.getByLabel("Color scheme", { exact: true }).selectOption("classic-blue");
  await appearance.locator(".preview-frame[data-theme=classic-blue]").waitFor();
  assert.equal(await themeRoot().count(), 0);
  await appearance.getByRole("button", { name: "Apply", exact: true }).click();
  await themeRoot().waitFor();
  assert.equal(await page.locator("html[data-look]").count(), 0);
  const { paneColors, pairs } = await themeRoot().evaluate((root) => {
    const probe = document.createElement("span");
    probe.hidden = true;
    document.body.append(probe);
    const value = (name) => {
      probe.style.color = `var(--${name})`;
      return getComputedStyle(probe).color;
    };
    const pane = (selector) => getComputedStyle(root.querySelector(selector));
    const files = ["panel-ink", "panel-muted", "file-source", "file-text", "file-document", "file-image", "file-media",
      "file-archive", "file-config", "file-executable", "file-hidden", "file-system"];
    const result = {
      paneColors: {
        list: pane("#left-pane").backgroundColor,
        heading: pane("#left-pane .pane-heading").backgroundColor,
        columns: pane("#left-pane .file-columns").backgroundColor,
        columnText: pane("#left-pane .file-columns button").color,
        frames: [pane("#left-pane").borderTopColor, pane("#right-pane").borderTopColor],
        scrollbars: [pane("#left-files").scrollbarColor, pane(".actionbar").scrollbarColor],
      },
      pairs: [
        ...files.flatMap((color) => ["panel-bg", "panel-inactive-selection"].map((background) =>
          [value(color), value(background)])),
        [value("panel-selected-ink"), value("panel-selection")], [value("dialog-ink"), value("dialog-bg")],
        [value("text-ink"), value("text-bg")], [value("ink"), value("surface")],
      ],
    };
    probe.remove();
    return result;
  });
  assert.deepEqual(paneColors, {
    list: "rgb(0, 0, 128)", heading: "rgb(0, 0, 128)", columns: "rgb(0, 0, 128)",
    columnText: "rgb(255, 255, 0)", frames: ["rgb(0, 255, 255)", "rgb(0, 255, 255)"],
    scrollbars: ["rgb(0, 255, 255) rgb(0, 0, 128)", "rgb(0, 255, 255) rgb(0, 0, 128)"],
  });
  const luminance = (rgb) => rgb.match(/\d+/g).map((value) => {
    const channel = Number(value) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  for (const [foreground, background] of pairs) {
    const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    assert.ok((light + 0.05) / (dark + 0.05) >= 4.5, `${foreground} on ${background} must be readable`);
  }
  await closeToolWindow(optionsPage, () => appearance.getByRole("button", { name: "Done", exact: true }).click());
  // Closing the error log can return to another open document.
  const fileWorkspace = page.getByRole("navigation", { name: "Open documents", exact: true })
    .getByRole("button", { name: "Files", exact: true });
  if (await fileWorkspace.isVisible()) await fileWorkspace.click();
  await navigate("left", attributes);
  const showHidden = page.getByRole("button", { name: "Show hidden files", exact: true });
  if (await showHidden.getAttribute("aria-pressed") === "false") await showHidden.click();
  const attributeList = page.getByRole("listbox", { name: "left files", exact: true });
  const otherRow = attributeList.getByRole("option", { name: /^ordinary\.sys/ });
  for (const name of [/^hidden\.rs/, /^system-hidden\.dll/]) {
    const row = attributeList.getByRole("option", { name });
    const colors = () => row.evaluate((element) => [getComputedStyle(element).backgroundColor,
      getComputedStyle(element.querySelector(".file-name")).color,
      getComputedStyle(element.querySelector(".file-size")).color]);
    await otherRow.click();
    const original = await colors();
    await row.click();
    const selected = await colors();
    assert.deepEqual(selected, ["rgb(0, 128, 128)", "rgb(255, 255, 255)", "rgb(255, 255, 255)"]);
    await row.click({ modifiers: ["Control"] });
    await attributeList.press("Home");
    assert.match(await row.getAttribute("class"), /\bmarked\b/);
    assert.notEqual(await row.getAttribute("data-current"), "true");
    const marked = await colors();
    assert.notEqual(marked[0], original[0]);
    assert.notEqual(marked[1], original[1]);
    assert.equal(marked[1], selected[1]);
  }
  if (process.env.DIRLUME_CLASSIC_SCREENSHOT) await page.screenshot({ path: process.env.DIRLUME_CLASSIC_SCREENSHOT, scale: "css" });
  await exitDesktop(page);
  page = await startDesktop();
  await themeRoot().waitFor();
  const customAppearance = await openAppearance();
  await customAppearance.getByRole("button", { name: "New scheme", exact: true }).click();
  assert.equal(await customAppearance.getByLabel("Base theme", { exact: true }).inputValue(), "classic-blue");
  await customAppearance.getByLabel("Scheme name", { exact: true }).fill("Classic blue custom");
  const selectedScheme = await customAppearance.getByLabel("Color scheme", { exact: true }).inputValue();
  await customAppearance.getByRole("combobox", { name: "Favorite dark scheme", exact: true }).selectOption(selectedScheme);
  await customAppearance.getByRole("checkbox", { name: "Show color scheme switcher in the title bar" }).check();

  await customAppearance.getByRole("button", { name: "Panels", exact: true }).click();
  await customAppearance.getByLabel("Panel background hex", { exact: true }).fill("#142560");
  await closeToolWindow(optionsPage, () => customAppearance.getByRole("button", { name: "Done", exact: true }).click());
  await exitDesktop(page);
  page = await startDesktop();
  await themeRoot().waitFor();
  assert.equal(await themeRoot().evaluate((root) => getComputedStyle(root).getPropertyValue("--panel-bg").trim()), "#142560");
  console.log("Verified Classic blue colors, selection contrast, preview, and custom and built-in theme persistence.");
  page = await testPanelModes({ page, startDesktop, exitDesktop, root: temp });
  page = await testFolderShortcuts({ page, startDesktop, exitDesktop, src, dst });
  const localSources = page.getByRole("region", { name: "right pane", exact: true });
  await localSources.getByRole("button", { name: "Locations for right pane", exact: true }).click();
  await localSources.getByRole("group", { name: "Right pane sources", exact: true })
    .getByRole("button", { name: "Home", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#right-path nav:not([data-connection-source])"));
  await navigate("right", dst);
  if (process.env.CI || process.env.DIRLUME_VERIFY_WINDOWS_ENVIRONMENT === "1") await testTerminalEnvironment(page);
  await testCompareWorker(page, src, dst);
  await testCompareLayouts(page, temp);
  await testCommandCompletion(page, temp, dockerCompletionFixture);
  page = await testNewFolder({ page, startDesktop, exitDesktop, root: temp });
  await testShortcutFields(page);
  page = await testTerminalHistory({ page, root: temp, startDesktop, exitDesktop });
  await testRetainedTerminalDirectory(page, temp);
  await testNativeTerminalLinks(page);
  await testOsTimestamps(page, temp);
  await testPermanentDelete(page, temp);
  await testBatchDeletion(page, temp);
  await testInlineRename(page, temp);
  await testLockingProcessPane(page, temp);
  await testFolderLockInspector(page, temp);
  await testProcessColumns(page);
  await testStoppedTransfer(page, temp);
  await testProcessQuickSearch(page, temp);
  await testProcessExecutablePath(page, child.pid);
  if (process.env.DIRLUME_VERIFY_ARCHIVES === "1") await testArchives(page, temp);
  page = await testMcp({ page, root: temp, startDesktop, exitDesktop, pid: () => child.pid });
  await testSystemTheme(page);
  await testScreenColor(page);
  page = await testFileSort({ page, startDesktop, exitDesktop, root: temp });
  await testNativeQuickView(page, temp, diagnosticsFile);
  await navigate("left", attributes);
  await testNativeSpaceAnalyzer(page);
  await testViewerReadingArea(page, attributes);
  await testMarkdownOptionsDismissal(page, attributes, temp);
  if (process.env.DIRLUME_SSH_FIXTURE_PYTHON) {
    await testNativeJumpHosts(page, temp, dst, join(temp, "ssh-config"), async () => {
      await exitDesktop(page);
      page = await startDesktop();
      return page;
    });
  }
  await testDirectComputerPairing(page);
  await exitDesktop(page);
  console.log("Verified the main menu, keyboard navigation, focus restoration, Help, About, and update action.");
  console.log("Verified copy progress, multiple selection, move, file creation, editing, deletion, appearance persistence, keyboard shortcuts, the command line, and remote transfers.");
} finally {
  if (lockedBy) await close(lockedBy);
  await browser?.close().catch(() => {});
  if (child) await close(child);
  if (otherVolume) await rm(otherVolume, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
      break;
    } catch (error) {
      if (attempt === 4) throw error;
      await setTimeout(400);
    }
  }
}

async function testNativeSpaceAnalyzer(page) {
  const exactButton = (scope, name) => scope.getByRole("button", { name, exact: true });
  const pane = page.getByRole("region", { name: "left pane", exact: true });
  const leftFiles = pane.getByRole("listbox", { name: "left files", exact: true });
  const rightFiles = page.getByRole("listbox", { name: "right files", exact: true });
  const selected = await rightFiles.getAttribute("aria-activedescendant");
  const rightPath = await page.locator("#right-path").getAttribute("data-path");
  await leftFiles.press("Control+Shift+l");
  const disk = page.getByRole("region", { name: "Disk information", exact: true });
  await exactButton(disk, "Scan volume").waitFor();
  assert.equal(await disk.getAttribute("data-pane-side"), "right");
  assert.equal(await leftFiles.isVisible(), true);
  await leftFiles.press("Control+Shift+l");
  await rightFiles.waitFor();
  assert.equal(await rightFiles.getAttribute("aria-activedescendant"), selected);
  assert.equal(await page.locator("#right-path").getAttribute("data-path"), rightPath);
  const nested = join(attributes, "system-folder", "scan-nested");
  await mkdir(nested);
  await writeFile(join(nested, "scan-report.txt"), "Scan fixture");
  await exactButton(pane, "Analyze space").click();
  const analyzer = page.getByRole("region", { name: "Space Analyzer", exact: true });
  await exactButton(analyzer, "Rescan").waitFor();
  await exactButton(analyzer, "Stop").waitFor({ state: "hidden" });
  assert.equal(await analyzer.getByRole("combobox", { name: "Size metric" }).inputValue(), "allocated");
  const row = (name) => analyzer.getByRole("row").filter({ has: page.getByText(name, { exact: true }) });
  await row("system-folder").dblclick();
  await row("scan-nested").dblclick();
  await row("scan-report.txt").click();
  assert.equal(await analyzer.locator(".address-current").textContent(), "scan-nested");
  const terminalToggle = page.getByRole("navigation", { name: "File actions" }).getByRole("button", { name: /^Terminal/ });
  const terminal = page.locator(".terminal-card:visible");
  if (!await terminal.isVisible()) await terminalToggle.click();
  const input = terminal.locator(".xterm-helper-textarea");
  const output = (text) => page.waitForFunction((expected) =>
    document.querySelector(".terminal-card:not([hidden]) .xterm-accessibility-tree")?.textContent?.includes(expected), text);
  await output("PS ");
  await input.pressSequentially("if ((Get-Location).Path.EndsWith('scan-nested')) { Write-Output ('scan-' + 'directory-ok') }");
  await input.press("Enter");
  await output("scan-directory-ok");
  await input.pressSequentially("cd ..");
  await input.press("Enter");
  await page.waitForFunction(() => document.querySelector(".space-analyzer .address-current")?.textContent === "system-folder");
  assert.equal(await row("system-folder").getAttribute("data-current"), "true");
  assert.equal(await input.evaluate((element) => element === document.activeElement), true);
  await terminalToggle.click();
  await analyzer.getByText("system-hidden.dll", { exact: true }).click();
  await exactButton(analyzer, "Show in other pane").click();
  await page.locator("#right-files").getByRole("option", { name: /^system-hidden\.dll/, selected: true }).waitFor();
  await exactButton(analyzer, "Close").click();
  await page.waitForFunction(() => document.activeElement?.id === "left-files");
}
