import { editPaneAddress } from "./pane-address-smoke.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function testCommandCompletion(page, root) {
  const cwd = join(root, "completion");
  await mkdir(cwd);
  await mkdir(join(cwd, "completion folder"));
  await writeFile(join(cwd, "completion file.txt"), "");
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
  await terminal.getByRole("button", { name: "Close terminal", exact: true }).click();
  console.log("Verified Windows terminal completion examples, dismissal, and replacement with the caret inside the draft.");
}
