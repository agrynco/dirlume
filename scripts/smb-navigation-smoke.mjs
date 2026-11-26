import assert from "node:assert/strict";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright-core";
import { editPaneAddress } from "./pane-address-smoke.mjs";

export async function testSmbNavigation() {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    await page.clock.install();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error));
    const root = "\\\\192.0.2.10";
    const documents = root + "\\documents";
    const projects = root + "\\projects";
    await page.route("http://dirlume.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    await page.addInitScript(({ root, documents, projects }) => {
      const home = "C:\\test";
      const file = { name: "notes #1.txt", directory: false, link: false, hidden: false, size: 7, modified: null };
      let authorized = false;
      let sshProfile;
      const sshVerification = { host: "fixture.example", port: 22, fingerprint: "SHA256:fixture" };
      const sshListing = { entries: [{ ...file, name: "ssh-notes.txt" }], omitted: 0 };
      const localShells = new Map();
      window.localTerminalStarts = [];
      window.localTerminalCloses = [];
      window.localTerminalWrites = [];
      window.sshTerminalStarts = 0;
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args) => {
          switch (command) {
            case "locations": return [{ label: "Home", path: home }, { label: "C:", path: "C:\\" }, { label: "D:", path: "D:\\" }];
            case "list_directory": return { path: args.path, parent: null, entries: [], omitted: 0 };
            case "file_icons": return args.items.map(() => null);
            case "ftp_profiles": return [];
            case "ssh_profiles": return sshProfile ? [sshProfile] : [];
            case "save_ssh_profile": {
              const { secret, clearSecret: _clearSecret, ...fields } = args.input;
              sshProfile = { ...fields, id: "ssh-fixture", hasSecret: Boolean(secret || sshProfile?.hasSecret) };
              return sshProfile;
            }
            case "connect_ssh":
              if (args.id !== sshProfile?.id) throw new Error("Unknown SSH profile");
              if (!args.approval) return { kind: "verifyHost", verification: sshVerification };
              if (args.approval.fingerprint !== sshVerification.fingerprint) throw new Error("Unapproved SSH host key");
              return { kind: "connected", id: 17, address: sshVerification.host, origin: "sftp://fixture.example",
                segments: ["home"], listing: sshListing };
            case "list_ssh":
              window.lastSshRead = { id: args.id, segments: args.segments };
              return { ...sshListing, elevated: false };
            case "open_terminal": {
              const { promptToken, ssh, id, directory } = args.request;
              if (!ssh) {
                window.localTerminalStarts.push({ id, directory });
                if (window.localStartup === "reject") throw new Error("PowerShell fixture could not open.");
                const prompt = () => {
                  const marker = `\x1b]2;${promptToken}:1:${btoa(directory)}:::powershell:\x07`;
                  args.output.onmessage({ event: "data", data: btoa(marker + `PS ${directory}> `) });
                };
                localShells.set(id, { draft: "", output: args.output });
                if (window.localStartup === "stall") {
                  return new Promise((resolve) => {
                    window.finishStalledLocalStartup = () => { prompt(); resolve(true); };
                  });
                }
                window.localPrompt = prompt;
                return true;
              }
              window.sshTerminalStarts++;
              window.terminalWrites = [];
              window.sshPrompt = (path, environment) => {
                const encode = (value) => btoa(String.fromCharCode(...new TextEncoder().encode(value)));
                const encodedEnvironment = environment ? ":" + encode(environment) : "";
                args.output.onmessage({ event: "data", data: encode(`\x1b]2;${promptToken}:0:${encode(path)}:::bash:${encode("/fixture/bin:/usr/bin")}${encodedEnvironment}\x07`) });
              };
              window.sshOutput = (data) => args.output.onmessage({ event: "data", data: btoa(data) });
              return true;
            }
            case "close_terminal":
              window.localTerminalCloses.push(args.id);
              localShells.delete(args.id);
              return null;
            case "write_terminal": {
              const shell = localShells.get(args.id);
              if (!shell) {
                window.terminalWrites?.push(args.data);
                return null;
              }
              window.localTerminalWrites.push({ id: args.id, data: args.data });
              if (args.data === "\r" && shell.draft === "exit") {
                shell.output.onmessage({ event: "closed" });
              }
              shell.draft = args.data.endsWith("\r") ? "" : shell.draft + args.data;
              return null;
            }
            case "complete_command":
              window.unexpectedLocalCompletion = true;
              return null;
            case "complete_ssh_terminal": {
              window.lastSshCompletion = { id: args.id, ...args.request };
              if (args.request.line === "hostn") {
                const result = (label) => ({ index: 0, length: 5, matches: [{ label, text: label, directory: false }] });
                if (window.deferSshCompletion) {
                  window.deferSshCompletion = false;
                  return new Promise((resolve) => { window.finishOldSshCompletion = () => resolve(result("hostname-stale")); });
                }
                return result("hostname");
              }
              if (args.request.line.startsWith("remote-fi")) {
                return { index: 0, length: args.request.line.length, matches: [{ label: "remote-fixture", text: "remote-fixture", directory: false }] };
              }
              if (args.request.line === "xz ") {
                return { index: 3, length: 0, matches: [
                  { label: "var/", text: "var/", directory: true },
                  { label: "space dir/", text: "'space dir/'", directory: true },
                ] };
              }
              if (args.request.line === "xz var/" || args.request.line === "xz 'space dir/'") {
                const path = args.request.line.includes("space") ? "space dir/" : "var/";
                return { index: 3, length: args.request.line.length - 3,
                  matches: [{ label: path + "child", text: path + "child", directory: false }] };
              }
              if (args.request.line === "docker compose logs --tail 20 we" && args.request.shellEnvironment?.COMPOSE_FILE === "remote.yaml" &&
                  args.request.shellEnvironment?.DOCKER_CONTEXT === "remote-engine") {
                return { index: args.request.caret - 2, length: 2, matches: [{ label: "web-remote", text: "web-remote", directory: false }], exclusive: true };
              }
              return { index: 0, length: 0, matches: [] };
            }
            case "read_text":
              if (args.directory !== documents || args.name !== file.name) throw new Error("Unexpected SMB file");
              return { text: "Fixture", encoding: "utf8" };
            case "connect_smb":
              if (args.path === root || args.path === root.slice(2)) {
                return { kind: "shares", server: root, names: ["documents", "projects"], warning: null };
              }
              if (args.path !== documents && args.path !== projects) throw new Error("Unexpected SMB path");
              if (args.path === projects && !authorized) {
                if (!args.credentials) return { kind: "credentials_required", error: null };
                if (args.credentials.username !== "smb-user") throw new Error("Unexpected SMB username");
                authorized = true;
              }
              return { kind: "opened", listing: { path: args.path, parent: null, entries: [file], omitted: 0 }, warning: null };
            default: return null;
          }
        },
      };
    }, { root, documents, projects });
    await page.goto("http://dirlume.test/");

    const pane = (side) => page.getByRole("region", { name: side + " pane", exact: true });
    const fileList = (side) => pane(side).getByRole("listbox", { name: side + " files", exact: true });
    const pathIs = (side, path) => page.waitForFunction(({ side, path }) =>
      document.getElementById(side + "-path")?.dataset.path === path, { side, path });
    const connection = page.getByRole("dialog", { name: "Connect to SMB", exact: true });
    const connect = async (side, path) => {
      await pane(side).getByRole("button", { name: "Locations for " + side + " pane", exact: true }).click();
      await pane(side).getByRole("button", { name: "SMB", exact: true }).click();
      await pathIs(side, "SMB");
      const files = fileList(side);
      await files.press("Shift+F4");
      const form = page.getByRole("dialog", { name: "Add SMB connection", exact: true });
      await form.getByLabel("Connection name").fill(side + " SMB");
      await form.getByLabel("SMB server or share").fill(path);
      await form.getByRole("button", { name: "Save connection", exact: true }).click();
      await files.getByRole("option", { name: new RegExp("^" + side + " SMB") }).click();
      await files.press("F4");
      const edit = page.getByRole("dialog", { name: "Edit SMB connection", exact: true });
      assert.equal(await edit.getByLabel("SMB server or share").inputValue(), path.startsWith("\\\\") ? path : "\\\\" + path);
      await edit.getByLabel("Connection name").fill(side + " SMB edited");
      await edit.getByRole("button", { name: "Save connection", exact: true }).click();
      await files.getByRole("option", { name: new RegExp("^" + side + " SMB edited") }).click();
      await files.press("Enter");
    };

    await pathIs("left", "C:\\test");
    await connect("left", root.slice(2));
    await pathIs("left", root);
    const left = fileList("left");
    const share = (name) => left.getByRole("option", { name: new RegExp("^" + name) });
    await share("documents").waitFor();
    await share("projects").waitFor();
    assert.equal(await pane("left").getByRole("button", { name: "Parent folder" }).isDisabled(), true);
    await share("documents").dblclick();
    await pathIs("left", documents);
    await share("notes #1.txt").click();
    await page.keyboard.press("F3");
    const documentAddress = page.locator(".text-window:not([hidden]) .document-heading h2");
    await documentAddress.waitFor();
    assert.equal(await documentAddress.textContent(), "smb://192.0.2.10/documents/notes%20%231.txt");
    await page.keyboard.press("Escape");
    await left.getByRole("option", { name: /^\.\./ }).dblclick();
    await pathIs("left", root);

    await share("projects").dblclick();
    await connection.getByLabel("Username").fill("smb-user");
    // Keep the credential prompt open across a background refresh interval.
    await setTimeout(5200);
    await connection.getByRole("button", { name: "Connect", exact: true }).click();
    await pathIs("left", projects);
    await pane("left").getByRole("button", { name: "Back", exact: true }).click();
    await pathIs("left", root);
    await pane("left").getByRole("button", { name: "Forward", exact: true }).click();
    await pathIs("left", projects);

    await connect("right", documents);
    await pathIs("right", documents);
    await pane("right").getByRole("button", { name: "Parent folder", exact: true }).click();
    await pathIs("right", root);

    async function openSsh(side) {
      await pane(side).getByRole("button", { name: "Locations for " + side + " pane", exact: true }).click();
      await pane(side).getByRole("button", { name: "NetBox", exact: true }).click();
      await pathIs(side, "NetBox");
    }
    const right = fileList("right");
    await openSsh("right");
    assert.deepEqual(await right.locator(".file-name-text").allTextContents(), []);
    assert.equal(await pane("right").getByRole("button", { name: "Parent folder", exact: true }).isDisabled(), true);
    await pane("right").getByRole("button", { name: "Back", exact: true }).click();
    await pathIs("right", root);
    await openSsh("right");
    await right.press("Shift+F4");
    const addSsh = page.getByRole("dialog", { name: "Add NetBox connection", exact: true });
    await addSsh.getByLabel("Connection name").fill("SSH fixture");
    await addSsh.getByLabel("Server", { exact: true }).fill("fixture.example");
    await addSsh.getByLabel("Username").fill("fixture");
    await addSsh.getByLabel("Password", { exact: true }).fill("fixture-password");
    await addSsh.getByRole("button", { name: "Save connection", exact: true }).click();
    await right.getByRole("option", { name: /^SSH fixture/ }).click();
    await right.press("F4");
    const editSsh = page.getByRole("dialog", { name: "Edit NetBox connection", exact: true });
    assert.equal(await editSsh.getByLabel("Server", { exact: true }).inputValue(), "fixture.example");
    await editSsh.getByLabel("Connection name").fill("Edited SSH");
    await editSsh.getByRole("button", { name: "Save connection", exact: true }).click();
    await right.getByRole("option", { name: /^Edited SSH/ }).click();
    await right.press("Enter");
    const verify = page.getByRole("dialog", { name: "Verify SSH server", exact: true });
    await verify.getByText("SHA256:fixture", { exact: true }).waitFor();
    await verify.getByRole("button", { name: "Trust and connect", exact: true }).click();
    await pathIs("right", "/home");
    await right.getByRole("option", { name: /^ssh-notes/ }).waitFor();
    await right.press("F12");
    const sshTerminal = page.locator(".terminal-card").filter({ has: page.getByRole("heading", { name: "SSH terminal", exact: true }) });
    const terminalHint = page.locator(".statusbar").getByRole("status").filter({ hasText: "File shortcuts paused. Click a file pane to use them." });
    await sshTerminal.waitFor();
    await terminalHint.waitFor();
    await page.waitForFunction(() => typeof window.sshPrompt === "function");
    await page.evaluate(() => window.sshPrompt("/home"));
    await page.evaluate(() => window.sshPrompt("/srv/дані"));
    await pathIs("right", "/srv/дані");
    await pathIs("left", projects);
    assert.deepEqual(await page.evaluate(() => window.lastSshRead), { id: 17, segments: ["srv", "дані"] });
    assert.deepEqual(await page.evaluate(() => window.terminalWrites), []);
    const sshAddress = await editPaneAddress(page, "right");
    await sshAddress.fill("/var/log");
    await sshAddress.press("Enter");
    await pathIs("right", "/var/log");
    await page.waitForFunction(() => window.terminalWrites.some((command) => command.includes("cd -- '/var/log'")));
    await page.evaluate(() => window.sshPrompt("/var/log"));
    await sshTerminal.locator("header span").filter({ hasText: "/var/log" }).waitFor();
    await pathIs("right", "/var/log");
    assert.equal(await page.evaluate(() => window.terminalWrites.length), 1);
    const sshInput = sshTerminal.locator(".xterm-helper-textarea");
    await sshInput.pressSequentially("remote-fi");
    const suggestions = sshTerminal.getByRole("listbox", { name: "Command suggestions", exact: true });
    await suggestions.getByRole("option", { name: "remote-fixture", exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.lastSshCompletion), {
      id: 1, line: "remote-fi", caret: 9, directory: "/var/log", searchPath: "/fixture/bin:/usr/bin", shellEnvironment: undefined,
    });
    assert.equal(await page.evaluate(() => !!window.unexpectedLocalCompletion), false);
    await sshInput.press("Tab");
    await page.waitForFunction(() => window.terminalWrites.at(-1)?.endsWith("remote-fixture"));
    await sshInput.press("Enter");
    await sshInput.pressSequentially("private-input");
    await suggestions.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.lastSshCompletion.line), "remote-fi");
    for (const [label, next, useMouse] of [["var/", "xz var/", false], ["space dir/", "xz 'space dir/'", true]]) {
      await page.evaluate(() => window.sshPrompt("/var/log"));
      await sshInput.pressSequentially("xz ");
      const directory = suggestions.getByRole("option", { name: label, exact: true });
      await directory.waitFor();
      if (useMouse) await directory.click();
      else await sshInput.press("Tab");
      await suggestions.getByRole("option", { name: label + "child", exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.lastSshCompletion.line), next);
      assert.equal(await page.evaluate(() => window.lastSshCompletion.caret), next.length - Number(useMouse));
      await sshInput.press("Control+c");
    }
    await page.evaluate(() => window.sshPrompt("/var/log", "COMPOSE_FILE=remote.yaml\0DOCKER_CONTEXT=remote-engine\0COMPOSE_PROFILES\0"));
    await sshInput.pressSequentially("docker compose logs --tail 20 we");
    await suggestions.getByRole("option", { name: "web-remote", exact: true }).waitFor();
    const remoteDraft = await page.evaluate(() => window.lastSshCompletion);
    assert.deepEqual(remoteDraft.shellEnvironment, { COMPOSE_FILE: "remote.yaml", DOCKER_CONTEXT: "remote-engine", COMPOSE_PROFILES: null });
    assert.equal(remoteDraft.directory, "/var/log");
    assert.equal(remoteDraft.id, 1);
    assert.equal(await page.evaluate(() => !!window.unexpectedLocalCompletion), false);
    await sshInput.press("Tab");
    await page.waitForFunction(() => window.terminalWrites.at(-1)?.endsWith("web-remote"));
    const commandLine = page.getByRole("combobox", { name: "Command line", exact: true });
    await commandLine.fill("docker compose logs --tail 20 we");
    const lineOptions = page.locator(".command-entry").getByRole("listbox", { name: "Command suggestions", exact: true });
    await lineOptions.getByRole("option", { name: "web-remote", exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.lastSshCompletion), remoteDraft);
    await commandLine.fill("");
    await sshInput.focus();
    await right.focus();
    await terminalHint.waitFor({ state: "hidden" });
    assert.equal(await sshTerminal.isVisible(), true);
    await sshTerminal.locator(".xterm-helper-textarea").focus();
    await terminalHint.waitFor();
    await pathIs("left", projects);

    const localProjects = "C:\\Projects";
    async function navigateLocal(side, path) {
      const address = await editPaneAddress(page, side);
      await address.fill(path);
      await address.press("Enter");
      await pathIs(side, path);
    }
    const menu = (side) => pane(side).locator(".location-popup").filter({ has: page.getByRole("group", { name: "Sources", exact: true }) });
    const drive = (side, letter) => menu(side).getByRole("button", { name: letter + ":", exact: true });
    async function openDriveMenu(side, hotkey) {
      await fileList(side).press(hotkey);
      await menu(side).waitFor();
    }
    async function reconnectLeftSsh() {
      await openSsh("left");
      await left.getByRole("option", { name: /^Edited SSH/ }).dblclick();
      await verify.getByRole("button", { name: "Trust and connect", exact: true }).click();
      await pathIs("left", "/home");
    }
    await page.evaluate(() => { window.localStartup = "stall"; });
    await navigateLocal("left", localProjects);
    const local = page.getByRole("region", { name: "Terminal", exact: true });
    const queued = local.getByText("Command queued. It will run when the terminal is ready.", { exact: true });
    const restart = local.getByRole("button", { name: "Restart terminal", exact: true });
    const ended = local.getByText("This terminal session has closed.", { exact: true });
    async function submitLocal(command) {
      await commandLine.fill(command);
      await commandLine.press("Enter");
    }
    await submitLocal("Write-Output fixture-discarded");
    await queued.waitFor();
    await page.waitForFunction(() => typeof window.finishStalledLocalStartup === "function");
    await page.clock.fastForward(16_000);
    await local.getByText("PowerShell did not reach its prompt in time.", { exact: true }).waitFor();
    await queued.waitFor({ state: "hidden" });
    await page.getByRole("alert").filter({ hasText: "Could not submit the command." }).waitFor();
    const stalled = await page.evaluate(() => window.localTerminalStarts[0].id);
    const restartDirectory = "C:\\Restart folder";
    await navigateLocal("left", restartDirectory);
    await page.evaluate(() => { window.localStartup = "ready"; });
    await restart.click();
    await page.waitForFunction((directory) => window.localTerminalStarts.at(-1)?.directory === directory &&
      typeof window.localPrompt === "function", restartDirectory);
    await submitLocal("Write-Output fixture-queued");
    await queued.waitFor();
    await page.evaluate(() => window.finishStalledLocalStartup());
    await page.waitForFunction((id) => window.localTerminalCloses.includes(id), stalled);
    await page.evaluate(() => window.localPrompt());
    await queued.waitFor({ state: "hidden" });
    await page.waitForFunction(() => window.localTerminalWrites.some(({ data }) => data.includes("fixture-queued")));
    const lifecycle = await page.evaluate(() => ({ starts: window.localTerminalStarts, writes: window.localTerminalWrites }));
    assert.equal(lifecycle.starts[1].directory, restartDirectory);
    assert.equal(lifecycle.writes.filter(({ data }) => data.includes("fixture-queued")).length, 1);
    assert.ok(lifecycle.writes.every(({ id, data }) => id === lifecycle.starts[1].id && !data.includes("fixture-discarded")));
    await right.focus();
    await sshTerminal.waitFor();
    assert.equal(await page.evaluate(() => window.sshTerminalStarts), 1);
    const hostname = suggestions.getByRole("option", { name: "hostname", exact: true });
    await page.evaluate(() => window.sshOutput("\r\nretained SSH output\r\n"));
    await sshInput.press("Control+c");
    await sshInput.pressSequentially("hostn");
    await hostname.waitFor();
    const sshCompletionBeforeSwitch = await page.evaluate(() => window.lastSshCompletion);
    await sshInput.press("Control+c");
    await page.evaluate(() => { window.deferSshCompletion = true; });
    await sshInput.pressSequentially("hostn");
    await page.waitForFunction(() => typeof window.finishOldSshCompletion === "function");
    for (let i = 0; i < 2; i++) {
      await left.focus();
      await sshTerminal.waitFor({ state: "hidden" });
      await right.focus();
      await sshTerminal.waitFor();
      await sshInput.press("Backspace");
      await sshInput.press("n");
      await hostname.waitFor({ timeout: 3000 });
    }
    await page.evaluate(() => window.finishOldSshCompletion());
    await page.clock.runFor(200);
    assert.equal(await hostname.isVisible(), true);
    assert.equal(await suggestions.getByRole("option", { name: "hostname-stale", exact: true }).count(), 0);
    await left.focus();
    const localInput = local.locator(".xterm-helper-textarea");
    await localInput.pressSequentially("exit");
    await localInput.press("Enter");
    await ended.waitFor();
    await right.focus();
    await sshTerminal.waitFor();
    assert.equal(await page.evaluate(() => window.sshTerminalStarts), 1);
    await sshInput.press("Control+c");
    await sshInput.pressSequentially("hostn");
    await hostname.waitFor({ timeout: 3000 });
    assert.deepEqual(await page.evaluate(() => window.lastSshCompletion), sshCompletionBeforeSwitch);
    await sshTerminal.locator(".xterm-rows").getByText("retained SSH output", { exact: true }).waitFor();
    await left.focus();
    await ended.waitFor();
    await page.evaluate(() => { window.localStartup = "reject"; });
    await restart.click();
    await local.getByText("PowerShell could not start.", { exact: true }).waitFor();
    await local.getByRole("button", { name: "Close terminal", exact: true }).click();
    await local.waitFor({ state: "hidden" });
    await page.evaluate(() => { window.localStartup = "ready"; });
    await left.press("F12");
    await local.waitFor();
    await localInput.waitFor({ state: "attached" });
    await page.waitForFunction(() => window.localTerminalStarts.length === 4);
    await page.evaluate(() => window.localPrompt());
    assert.equal(await restart.isVisible(), false);
    await right.focus();
    await sshTerminal.waitFor();
    await sshTerminal.getByRole("button", { name: "Close terminal", exact: true }).click();
    await terminalHint.waitFor({ state: "hidden" });
    await navigateLocal("left", localProjects);
    console.log("Verified PowerShell startup timeout, late cleanup, restart from the active folder, queued input, exit, and close/reopen while retaining the SSH terminal.");
    await openDriveMenu("right", "Alt+F2");
    assert.equal(await drive("right", "C").locator("kbd").textContent(), "C");
    await page.keyboard.press("c");
    await menu("right").waitFor({ state: "hidden" });
    await pathIs("right", localProjects);
    await pathIs("left", localProjects);

    await reconnectLeftSsh();
    await openDriveMenu("left", "Alt+F1");
    await drive("left", "C").click();
    await pathIs("left", localProjects);
    await pathIs("right", localProjects);

    await navigateLocal("left", "D:\\Other");
    await openDriveMenu("right", "Alt+F2");
    await page.keyboard.press("C");
    await pathIs("right", "C:\\");
    await pathIs("left", "D:\\Other");
    await reconnectLeftSsh();
    await openDriveMenu("right", "Alt+F2");
    await page.keyboard.press("z");
    await menu("right").waitFor();
    await pathIs("right", "C:\\");
    await page.keyboard.press("d");
    await pathIs("right", "D:\\");
    await pathIs("left", "/home");

    const options = page.getByRole("dialog", { name: "Options", exact: true });
    await page.getByRole("button", { name: "Options", exact: true }).click();
    await options.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
    await options.getByRole("button", { name: "Change C for Select drive C: in the sources menu", exact: true }).click();
    await options.getByRole("textbox", { name: "New shortcut to replace C for Select drive C: in the sources menu", exact: true }).press("Control+Shift+x");
    await options.getByRole("button", { name: "Remove D from Select drive D: in the sources menu", exact: true }).click();
    await options.getByRole("button", { name: "Done", exact: true }).click();
    await openDriveMenu("right", "Alt+F2");
    assert.equal(await drive("right", "C").locator("kbd").textContent(), "Ctrl+Shift+X");
    assert.equal(await drive("right", "D").locator("kbd").count(), 0);
    await page.keyboard.press("C");
    await menu("right").waitFor();
    await page.keyboard.press("Control+Shift+x");
    await pathIs("right", "C:\\");
    await menu("right").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.id === "right-files");
    const address = await editPaneAddress(page, "right");
    await address.fill("C:\\");
    await address.press("End");
    await address.press("c");
    assert.equal(await address.inputValue(), "C:\\c");
    assert.deepEqual(errors, []);
    console.log("Verified saved SMB and SSH connections, authentication, and configurable Windows drive selection in both panes.");
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testSmbNavigation();
