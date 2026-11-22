import { editPaneAddress } from "./pane-address-smoke.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join, parse } from "node:path";
import { closeToolWindow, openOptionsWindow } from "./tool-window-smoke.mjs";

export async function makeDockerFixture(directory) {
  const folder = join(directory, "docker-fixture");
  await mkdir(folder);
  const source = join(folder, "Program.cs");
  await writeFile(source, `using System;
using System.IO;
using System.Threading;
class Program {
  static int Main(string[] args) {
    if (args.Length > 1 && args[0] == "complete") {
      string root = Path.GetDirectoryName(typeof(Program).Assembly.Location);
      File.WriteAllText(Path.Combine(root, "dotnet.seen"), "1");
      Console.WriteLine("--list-sdks");
      return 0;
    }
    if (args.Length > 1 && args[0] == "__complete") {
      string prefix = args[args.Length - 1];
      string command = String.Join(" ", args, 1, args.Length - 2);
      string[] options = null;
      if (command == "") options = new[] { "container", "compose" };
      if (command == "container") options = new[] { "inspect", "logs", "start", "stop" };
      if (command == "compose") options = new[] { "logs", "ps", "up" };
      if (command == "container logs" || command == "compose logs") options = new[] { "--tail", "--follow", "-f" };
      if (command == "compose up") options = new[] { "--build", "-d" };
      foreach (string option in options ?? new string[0]) if (option.StartsWith(prefix)) Console.WriteLine(option);
      Console.WriteLine(":4");
      return 0;
    }
    string context = Environment.GetEnvironmentVariable("DOCKER_CONTEXT");
    if (args.Length > 2 && args[0] == "--context") {
      context = args[1];
      string[] remaining = new string[args.Length - 2];
      Array.Copy(args, 2, remaining, 0, remaining.Length);
      args = remaining;
    }
    if (args.Length >= 3 && args[0] == "compose" && args[args.Length-2] == "config" && args[args.Length-1] == "--services") {
      string project = args.Length == 5 && (args[1] == "-f" || args[1] == "--file") ? args[2] :
        Environment.GetEnvironmentVariable("COMPOSE_FILE");
      string path = Path.Combine(Environment.CurrentDirectory, String.IsNullOrEmpty(project) ? "compose.yaml" : project);
      if (!File.Exists(path)) return 1;
      foreach (string service in File.ReadAllLines(path)) Console.WriteLine(service);
      return 0;
    }
    if (args.Length != 6 || String.Join(" ", args, 0, 5) != "container ls --all --no-trunc --format" ||
        args[5] != "{\\"ID\\":{{json .ID}},\\"Names\\":{{json .Names}}}") return 2;
    if (context == "fixture-explicit") {
      Console.WriteLine("{\\"ID\\":\\"deadcafe\\",\\"Names\\":\\"web-explicit\\"}");
      return 0;
    }
    if (context == "fixture-offline" || context == "fixture-slow") {
      string root = Path.GetDirectoryName(typeof(Program).Assembly.Location);
      File.WriteAllText(Path.Combine(root, context + ".seen"), "1");
      if (context == "fixture-offline") return 1;
      Thread.Sleep(650);
    } else if (context != "fixture-active") return 2;
    Console.WriteLine("{\\"ID\\":\\"aabbccddeeff0011223344556677889900112233445566778899aabbccddeeff\\",\\"Names\\":\\"web-api\\"}");
    Console.WriteLine("{\\"ID\\":\\"bbccddeeff0011223344556677889900112233445566778899aabbccddeeff00\\",\\"Names\\":\\"worker\\"}");
    return 0;
}
}`);
  const target = join(folder, "docker.exe");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Add-Type -Path $env:DIRLUME_TEST_DOCKER_SOURCE -OutputAssembly $env:DIRLUME_TEST_DOCKER_TARGET -OutputType ConsoleApplication"], {
    windowsHide: true, stdio: "pipe", env: { ...process.env, DIRLUME_TEST_DOCKER_SOURCE: source, DIRLUME_TEST_DOCKER_TARGET: target },
  });
  await copyFile(target, join(folder, "dotnet.exe"));
  return folder;
}

export async function testCommandCompletion(page, root, docker) {
  async function setEnvironmentRefresh(enabled) {
    const tool = await openOptionsWindow(page);
    const options = tool.getByRole("dialog", { name: "Options", exact: true });
    const search = options.getByRole("searchbox", { name: "Search settings", exact: true });
    await search.fill("refresh environment variables");
    await search.press("Tab");
    await options.getByRole("button", { name: "Terminal", exact: true }).click();
    const refresh = options.getByRole("checkbox", { name: "Automatically refresh environment variables", exact: true });
    const previous = await refresh.isChecked();
    await refresh.setChecked(enabled);
    await closeToolWindow(tool, () => options.getByRole("button", { name: "Done", exact: true }).click());
    return previous;
  }
  // Use the environment of this isolated app process for the synthetic Docker executable.
  const previousRefresh = await setEnvironmentRefresh(false);
  const cwd = join(root, "completion");
  await mkdir(cwd);
  const childFolder = join(cwd, "completion folder", "Child Folder");
  await mkdir(childFolder, { recursive: true });
  await writeFile(join(cwd, "completion folder", "Child File.txt"), "");
  await writeFile(join(cwd, "completion file.txt"), "");
  await writeFile(join(cwd, "compose.yaml"), "web\nworker\n");
  await writeFile(join(cwd, "alternate.yaml"), "web-alternate\nqueue\n");
  await writeFile(join(childFolder, "compose.yaml"), "web-child\nworker-child\n");
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
  git("init", "-q");
  git("-c", "user.name=Dirlume", "-c", "user.email=dirlume@example.invalid",
    "commit", "--allow-empty", "--no-gpg-sign", "-qm", "Fixture");
  git("branch", "fixture-completion");

  const address = await editPaneAddress(page);
  await address.fill(cwd);
  await address.press("Enter");
  await page.locator("#left-files").getByRole("option", { name: /^completion folder/ }).click();
  await page.locator(".command-bar > span").getByText(cwd, { exact: true }).waitFor();
  const input = page.getByRole("combobox", { name: "Command line", exact: true });
  const list = page.getByRole("listbox", { name: "Command suggestions" });
  const option = (name) => list.getByRole("option", { name, exact: typeof name === "string" });
  async function draft(value, suggestion) {
    await input.fill(value);
    await option(suggestion).waitFor({ timeout: 15_000 });
  }

  await draft("cl", "cls");
  await input.press("Escape");
  await list.waitFor({ state: "hidden" });
  assert.equal(await input.inputValue(), "cl");

  await draft("ipconfig /re", "/renew");
  await option("/renew").click();
  assert.equal(await input.inputValue(), "ipconfig /renew");
  await draft("reg q", "query");
  await input.press("ArrowDown");
  await input.press("Enter");
  assert.equal(await input.inputValue(), "reg query");
  await draft("docker co", "container");
  await option("compose").waitFor();
  await draft("docker container logs --ta", "--tail");
  await draft("docker --context fixture-explicit container logs --tail 20 we", "web-explicit");
  assert.equal(await option("web-api").count(), 0);
  await draft("docker container inspect aabb", /^aabbccddeeff/);
  await draft("docker compose lo", "logs");
  await draft("docker compose up --bu", "--build");
  await draft("docker compose logs -", "-f");
  await option("--follow").waitFor();
  await draft("docker compose up wo", "worker");
  await draft("docker compose --file alternate.yaml logs --tail 20 we", "web-alternate");
  await input.fill('docker compose logs --tail 20 "we" --follow');
  await input.press("End");
  for (let step = 0; step < " --follow".length; step++) await input.press("ArrowLeft");
  await option("web").click();
  assert.equal(await input.inputValue(), 'docker compose logs --tail 20 "web" --follow');
  await draft("git checkout fixture-", "fixture-completion");
  await input.press("Tab");
  assert.equal(await input.inputValue(), "git checkout fixture-completion");

  await input.fill("git ch --quiet");
  assert.equal(await input.inputValue(), "git ch --quiet");
  await input.press("Home");
  for (let i = 0; i < 6; i++) await input.press("ArrowRight");
  await option("checkout").click();
  assert.equal(await input.inputValue(), "git checkout --quiet");

  await draft("cd comp", /completion folder/);
  assert.deepEqual(await option(/completion file/).allTextContents(), []);
  await option(/completion folder/).click();
  assert.match(await input.inputValue(), /^cd .*completion folder/);

  const openTerminal = () => page.locator("#left-files").press("F12");
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  const terminalInput = terminal.locator(".xterm-helper-textarea");
  const terminalOptions = terminal.getByRole("listbox", { name: "Command suggestions", exact: true });
  const terminalOption = (name) => terminalOptions.getByRole("option", { name, exact: true });
  const closeTerminal = () => terminal.getByRole("button", { name: "Close terminal", exact: true }).click();
  const atPrompt = () => page.waitForFunction(() => document.querySelector(".terminal-card:not([hidden]) .xterm-accessibility-tree")?.textContent.trim().endsWith(">"));

  // The .NET completer uses the application environment. Start a fresh terminal with
  // automatic environment refresh disabled so it resolves the synthetic dotnet.exe.
  if (await page.locator(".terminal-card").count()) {
    if (!await terminal.isVisible()) await openTerminal();
    await closeTerminal();
  }
  await openTerminal();
  await atPrompt();
  await terminalInput.pressSequentially("dotnet ");
  await terminalOption("--list-sdks").waitFor({ timeout: 15000 });
  assert.ok((await readdir(docker)).includes("dotnet.seen"));
  await terminalInput.press("Control+c");
  await closeTerminal();

  await setEnvironmentRefresh(true);
  for (const suffix of ["first", "second", "first"]) {
    const value = `Write-Output 'completion-history-${suffix}'`;
    await input.fill(value);
    if (suffix === "second") await input.press("Enter");
    else await input.press("Shift+Enter");
    await page.waitForFunction((output) => document.querySelector(".xterm-accessibility-tree")?.textContent?.includes(output),
      `completion-history-${suffix}`);
    await page.getByRole("button", { name: "Toggle terminal", exact: true }).click();
  }
  await draft("Write-Output 'completion-history-", /completion-history-first/);
  assert.match(await list.getByRole("option").nth(0).innerText(), /completion-history-first/);
  assert.match(await list.getByRole("option").nth(1).innerText(), /completion-history-second/);
  await input.press("ArrowDown");
  await input.press("Enter");
  assert.equal(await input.inputValue(), "Write-Output 'completion-history-first'");
  console.log("Verified PowerShell command completions, editing at the caret, and command history suggestions.");

  await openTerminal();
  const screen = terminal.locator(".xterm-accessibility-tree");
  await atPrompt();
  // Keep the completion fixture first in this PowerShell session after an environment refresh.
  await terminalInput.pressSequentially(`$env:PATH = '${docker.replaceAll("'", "''")};' + $env:PATH; Write-Output ('fixture-' + 'cli-ready')`);
  await terminalInput.press("Enter");
  await page.waitForFunction(() => document.querySelector(".xterm-accessibility-tree")?.textContent?.includes("fixture-cli-ready"));
  await atPrompt();
  const samples = [
    ["ipconfig /re", ["/release", "/renew"]],
    ["cmd /c dir /", ["/b"]],
    ["Get-ChildItem -Rec", ["-Recurse"]],
    ["dir -Rec", ["-Recurse"]],
  ];
  for (const [line, candidates] of samples) {
    await terminalInput.pressSequentially(line);
    for (const name of candidates) await terminalOptions.getByRole("option", { name, exact: true }).waitFor({ timeout: 15000 });
    if (line === "Get-ChildItem -Rec") {
      assert.equal(await terminalOptions.getByRole("option").count(), 1);
      assert.ok((await terminalOptions.boundingBox()).width < 200);
      assert.ok(await terminalInput.evaluate((element) => element === document.activeElement));
    }
    await terminalInput.press("Escape");
    await terminalOptions.waitFor({ state: "hidden" });
    await terminalInput.press("Control+c");
    await page.waitForFunction(() => document.querySelector(".terminal-card:not([hidden]) .xterm-accessibility-tree")?.textContent.trim().endsWith(">"));
  }
  await terminalInput.pressSequentially("git ch --quiet");
  for (let i = 0; i < " --quiet".length; i++) await terminalInput.press("ArrowLeft");
  await terminalOptions.getByRole("option", { name: "checkout", exact: true }).click();
  await screen.getByText(/git checkout --quiet/).waitFor();
  await terminalInput.press("Control+c");
  const cancel = async () => { await terminalInput.press("Control+c"); await atPrompt(); };
  await atPrompt();
  const drive = parse(process.env.SystemRoot ?? cwd).root;
  const knownRootFolder = basename(process.env.SystemRoot ?? cwd.split(/\\/).slice(0, 2).join("\\"));
  const rootFolder = (await readdir(drive)).find((name) => name.toLowerCase() === knownRootFolder.toLowerCase());
  assert.ok(rootFolder);
  await terminalInput.pressSequentially("cd " + drive);
  await terminalOption(rootFolder).waitFor({ timeout: 15000 });
  await terminalOption(rootFolder).locator("svg").waitFor();
  await terminalInput.pressSequentially(rootFolder.slice(0, 3));
  await terminalOption(rootFolder).waitFor();
  assert.ok((await terminalOptions.getByRole("option").allTextContents()).every((name) => name.toLowerCase().startsWith(rootFolder.slice(0, 3).toLowerCase())));
  await cancel();

  await terminalInput.pressSequentially("cd comp");
  await terminalOption("completion folder").click();
  await terminalOption("Child Folder").waitFor();
  assert.equal(await terminalOption("Child File.txt").count(), 0);
  await terminalInput.pressSequentially("Child");
  await terminalOption("Child Folder").waitFor();
  await terminalInput.press("ArrowDown");
  await terminalInput.press("Enter");
  await terminalOptions.waitFor({ state: "hidden" });
  await terminalInput.press("Enter");
  await page.waitForFunction((path) => document.getElementById("left-path")?.dataset.path === path, childFolder);

  let commandNumber = 0;
  const remember = async (line) => {
    const number = ++commandNumber;
    const command = `${line}; Write-Output ('completion-ready-' + '${number}')`;
    await terminalInput.pressSequentially(command);
    await terminalInput.press("Enter");
    await page.waitForFunction((expected) => JSON.parse(localStorage.getItem("dirlume.command-history") ?? "[]")
      .some(({ text }) => text === expected), command);
    await screen.getByText(`completion-ready-${number}`, { exact: true }).waitFor();
    await atPrompt();
  };
  await remember(`$env:Path = '${docker.replaceAll("'", "''")};' + $env:Path; $env:DOCKER_CONTEXT = 'fixture-active'`);
  await terminalInput.pressSequentially("docker cont");
  await terminalOption("container").waitFor();
  await terminalInput.press("Tab");
  await terminalInput.press("Space");
  await terminalOption("logs").waitFor();
  await terminalOption("inspect").waitFor();
  await terminalInput.pressSequentially("lo");
  await terminalOption("logs").waitFor();
  assert.equal(await terminalOption("inspect").count(), 0);
  await terminalInput.press("ArrowDown");
  await terminalInput.press("Enter");
  await terminalInput.pressSequentially(" web");
  await terminalOption("web-api").click();
  await terminalOptions.waitFor({ state: "hidden" });
  await screen.getByText(/docker container logs web-api/).waitFor();
  await cancel();

  await terminalInput.pressSequentially("docker container inspect aabb");
  await terminalOption(/^aabbccddeeff/).waitFor();
  await terminalInput.press("Escape");
  await terminalOptions.waitFor({ state: "hidden" });
  await cancel();
  await terminalInput.pressSequentially("docker compose up wo");
  await terminalOption("worker-child").waitFor();
  await cancel();
  await remember("Set-Location ../..; $env:COMPOSE_FILE = 'alternate.yaml'");
  await page.waitForFunction((path) => document.querySelector(".terminal-card:not([hidden]) header span")?.textContent === path, cwd);
  await terminalInput.pressSequentially("docker compose logs --tail 20 we");
  await terminalOption("web-alternate").waitFor();
  assert.equal(await terminalOption("web-api").count(), 0);
  await cancel();
  await terminalInput.pressSequentially("docker compose up --bu");
  await terminalOption("--build").waitFor();
  await cancel();
  await remember("Set-Location -LiteralPath './completion folder/Child Folder'");
  await remember("$env:DOCKER_CONTEXT = 'fixture-offline'");
  await terminalInput.pressSequentially("docker container logs web");
  const dockerObserved = (name) => page.waitForFunction(async ({ docker, name }) =>
    (await window.__TAURI_INTERNALS__.invoke("list_directory", { path: docker })).entries.some((entry) => entry.name === name),
    { docker, name });
  await dockerObserved("fixture-offline.seen");
  await terminalOptions.waitFor({ state: "hidden" });
  await cancel();
  await remember("$env:DOCKER_CONTEXT = 'fixture-slow'");
  await terminalInput.pressSequentially("docker container logs web");
  await dockerObserved("fixture-slow.seen");
  await cancel();
  await terminalInput.pressSequentially("cd ..\\..\\comp");
  await terminalOption("completion folder").waitFor();
  assert.equal(await terminalOption("web-api").count(), 0);
  await cancel();
  await closeTerminal();
  if (!previousRefresh) await setEnvironmentRefresh(false);
  console.log("Verified Windows completion for folders, Docker flags and containers, and Compose projects in both inputs.");
}
