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

  const address = page.getByLabel("left path", { exact: true });
  await page.locator("#left-files").press("Control+l");
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
    await page.locator(".xterm-helper-textarea").press("F12");
  }
  await draft("Write-Output 'completion-history-", /completion-history-first/);
  assert.match(await list.getByRole("option").nth(0).innerText(), /completion-history-first/);
  assert.match(await list.getByRole("option").nth(1).innerText(), /completion-history-second/);
  await input.press("ArrowDown");
  await input.press("Enter");
  assert.equal(await input.inputValue(), "Write-Output 'completion-history-first'");
  console.log("Verified PowerShell command completions, editing at the caret, and command history suggestions.");
}
