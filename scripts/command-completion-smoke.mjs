import { editPaneAddress } from "./pane-address-smoke.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join, parse } from "node:path";

async function makeDockerFixture(directory) {
  const folder = join(directory, "docker-fixture");
  await mkdir(folder);
  const source = join(folder, "Program.cs");
  await writeFile(source, `using System;
using System.IO;
using System.Threading;
class Program {
  static int Main(string[] args) {
    if (args.Length != 6 || String.Join(" ", args, 0, 5) != "container ls --all --no-trunc --format" ||
        args[5] != "{\\"ID\\":{{json .ID}},\\"Names\\":{{json .Names}}}") return 2;
    string context = Environment.GetEnvironmentVariable("DOCKER_CONTEXT");
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
  return folder;
}

export async function testCommandCompletion(page, root) {
  const cwd = join(root, "completion");
  await mkdir(cwd);
  const childFolder = join(cwd, "completion folder", "Child Folder");
  await mkdir(childFolder, { recursive: true });
  await writeFile(join(cwd, "completion folder", "Child File.txt"), "");
  await writeFile(join(cwd, "completion file.txt"), "");
  const docker = await makeDockerFixture(root);
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

  await page.locator("#left-files").press("F12");
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  const terminalInput = terminal.locator(".xterm-helper-textarea");
  const terminalOptions = terminal.getByRole("listbox", { name: "Command suggestions", exact: true });
  const screen = terminal.locator(".xterm-accessibility-tree");
  const samples = [
    ["ipconfig /re", ["/release", "/renew"]],
    ["cmd /c dir /", ["/b"]],
    ["Get-ChildItem -Rec", ["-Recurse"]],
    ["dir -Rec", ["-Recurse"]],
  ];
  try {
    if (execFileSync("dotnet", ["--list-sdks"], { encoding: "utf8", windowsHide: true }).trim()) {
      samples.push(["dotnet ", ["--list-sdks"]]);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
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
  const terminalOption = (name) => terminalOptions.getByRole("option", { name, exact: true });
  const atPrompt = () => page.waitForFunction(() => document.querySelector(".terminal-card:not([hidden]) .xterm-accessibility-tree")?.textContent.trim().endsWith(">"));
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

  const remember = async (line) => {
    await terminalInput.pressSequentially(line);
    await terminalInput.press("Enter");
    await page.waitForFunction((expected) => JSON.parse(localStorage.getItem("dirlume.command-history") ?? "[]")
      .some(({ text }) => text === expected), line);
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
  await terminal.getByRole("button", { name: "Close terminal", exact: true }).click();
  console.log("Verified Windows terminal completion for drive roots, nested folders, Docker commands and active-context containers.");
}
