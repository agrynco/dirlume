import { editPaneAddress } from "./pane-address-smoke.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export async function testTerminalHistory({ page, root, startDesktop, exitDesktop }) {
  const left = join(root, "history-left");
  const right = join(root, "history-right");
  for (const [side, path] of [["left", left], ["right", right]]) {
    await mkdir(path);
    const address = await editPaneAddress(page, side);
    await address.fill(path);
    await address.press("Enter");
    await page.getByRole("heading", { name: `history-${side}`, exact: true }).waitFor({ state: "attached" });
  }
  const terminal = () => page.getByRole("region", { name: "Terminal", exact: true });
  const toggleTerminal = () => page.getByRole("button", { name: "Toggle terminal", exact: true }).click();
  if (await terminal().isVisible()) await terminal().getByRole("button", { name: "Close terminal", exact: true }).click();
  await toggleTerminal();
  await terminal().locator(".xterm-rows").waitFor();
  await page.waitForFunction(() => document.querySelector(".xterm-accessibility-tree")?.textContent?.includes("PS "));
  const terminalInput = () => terminal().locator(".xterm-helper-textarea");
  const run = async (line) => {
    await terminalInput().pressSequentially(line);
    await terminalInput().press("Enter");
  };
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("dirlume.command-history") ?? "[]"));
  const waitForCommand = (text, count = 1) => page.waitForFunction(({ text, count }) => {
    const history = JSON.parse(localStorage.getItem("dirlume.command-history") ?? "[]");
    return history.filter((item) => item.text === text).length >= count;
  }, { text, count });
  const direct = "Write-Output 'shared-history-direct'";
  await run(direct);
  try {
    await waitForCommand(direct);
  } catch (error) {
    const screen = await terminal().locator(".xterm-accessibility-tree").textContent();
    throw new Error(`PowerShell did not report the test command. Terminal: ${screen}`, { cause: error });
  }
  await run(direct);
  await waitForCommand(direct, 2);
  const failed = "throw 'shared-history-error'";
  await run(failed);
  await waitForCommand(failed);
  for (const line of ["if ($true) {", "Write-Output 'multiline-history'", "}"]) await run(line);
  const multiline = ["if ($true) {", "Write-Output 'multiline-history'", "}"].join("\n");
  await page.waitForFunction((expected) => JSON.parse(localStorage.getItem("dirlume.command-history") ?? "[]")
    .some(({ text }) => text.replaceAll("\r\n", "\n") === expected), multiline);

  const input = () => page.getByRole("combobox", { name: "Command line", exact: true });
  const fromField = "Write-Output 'history-from-field'";
  await toggleTerminal();
  await input().fill(fromField);
  await input().press("Shift+Enter");
  await waitForCommand(fromField);
  await page.waitForFunction(() => document.querySelector(".xterm-accessibility-tree")?.textContent?.includes("history-from-field"));

  const secure = "Read-Host 'history-password-prompt' -AsSecureString | Out-Null";
  await run(secure);
  await page.waitForFunction(() => document.querySelector(".xterm-accessibility-tree")?.textContent?.includes("history-password-prompt:"));
  const queued = "Write-Output ('queued-' + 'history-marker')";
  await toggleTerminal();
  await input().fill(queued);
  await input().press("Shift+Enter");
  await run("disposable-history-password");
  await waitForCommand(secure);
  await page.waitForFunction(() => document.querySelector(".xterm-accessibility-tree")?.textContent?.includes("queued-history-marker"));
  await terminalInput().pressSequentially("Write-Output 'abandoned-draft'");
  await terminalInput().press("Control+c");
  await run("Write-Output 'history-after-cancel'");
  await waitForCommand("Write-Output 'history-after-cancel'");
  const history = await stored();
  assert.equal(history.filter(({ text }) => text === fromField).length, 1);
  assert.equal(history.filter(({ text }) => text === queued).length, 1);
  assert.equal(history.some(({ text }) => /abandoned-draft|disposable-history-password|Set-Location -LiteralPath/.test(text)), false);
  assert.ok(history.find(({ text }) => text === direct).date > 0);
  await run("exit");
  await waitForCommand("exit");

  await page.evaluate(() => {
    const key = "dirlume.command-history";
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    localStorage.setItem(key, JSON.stringify([
      { text: "Write-Output 'DNS cache'", date: today.getTime() },
      { text: "ipconfig /flushdns", date: yesterday.getTime() },
      ...JSON.parse(localStorage.getItem(key) ?? "[]"),
      "ls legacy-entry",
    ]));
  });
  await terminal().getByRole("button", { name: "Close terminal", exact: true }).click();
  await exitDesktop(page);
  page = await startDesktop();
  await input().waitFor();
  await input().press("Alt+F8");
  const historyDialog = page.getByRole("dialog", { name: "Command history", exact: true });
  const search = historyDialog.getByLabel("Search commands");
  await historyDialog.getByRole("region", { name: "Unknown date", exact: true }).waitFor();
  await search.fill("dns cache");
  const choices = historyDialog.locator(".command-history-group button");
  assert.deepEqual(await choices.allTextContents(), ["Write-Output 'DNS cache'", "ipconfig /flushdns"]);
  await search.fill("shared-history-direct");
  const entry = historyDialog.getByRole("button", { name: direct, exact: true });
  assert.equal(await entry.count(), 1);
  await entry.click();
  assert.equal(await input().inputValue(), direct);
  await input().press("Alt+F8");
  await search.fill("multiline-history");
  await historyDialog.getByRole("button", { name: /if \(\$true\) \{ Write-Output 'multiline-history' \}/ }).click();
  assert.equal(await input().inputValue(), multiline);
  await input().fill("Write-Output 'shared-history-");
  await input().press("End");
  const suggestion = page.getByRole("listbox", { name: "Command suggestions" }).getByRole("option", { name: /shared-history-direct/ });
  try {
    await suggestion.waitFor();
  } catch (error) {
    const field = await input().evaluate((element) => ({
      value: element.value, caret: element.selectionStart, focus: element === document.activeElement,
      expanded: element.getAttribute("aria-expanded"),
    }));
    throw new Error(`The persisted command was missing from autocomplete: ${JSON.stringify(field)}`, { cause: error });
  }
  console.log("Verified PowerShell terminal and command-field history, repeats, failed commands, canceled input, restart, and topical filtering.");
  return page;
}
