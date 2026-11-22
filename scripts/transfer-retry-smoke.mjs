import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { editPaneAddress } from "./pane-address-smoke.mjs";
import { close } from "./server-smoke.mjs";

export async function testStoppedTransfer(page, root) {
  const source = join(root, "retry-source");
  const target = join(root, "retry-target");
  await mkdir(source);
  await mkdir(target);
  const names = ["01 moved.txt", "02 locked.txt", "03 pending.txt"];
  await writeFile(join(source, "denied.txt"), "Still in the source");
  for (const name of names) await writeFile(join(source, name), name);
  const button = (scope, name) => scope.getByRole("button", { name, exact: true });
  const files = page.locator("#left-files");
  const row = (name) => files.locator(`[role="option"][data-tooltip=${JSON.stringify(name)}]`);
  const stopped = page.getByRole("dialog", { name: "Transfer stopped", exact: true });
  const retry = button(stopped, "Retry");
  const destination = join(target, "denied.txt");
  const sid = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).match(/S-1-[\d-]+/)[0];
  const permissions = (...args) => execFileSync("icacls.exe", [target, ...args], { windowsHide: true });
  const address = await editPaneAddress(page, "left");
  await address.fill(source);
  await address.press("Enter");

  async function moveTo(path) {
    await files.press("F6");
    const dialog = page.getByRole("dialog", { name: "Rename or move", exact: true });
    await dialog.getByRole("combobox", { name: "Destination" }).fill(path);
    await button(dialog, "Move").click();
  }

  async function checkStopped(recovery) {
    await retry.waitFor();
    await button(stopped, "Cancel").waitFor();
    await button(stopped, recovery).waitFor();
    assert.equal(await button(stopped, "Done").count(), 0);
    assert.ok(await retry.evaluate((button) => button.classList.contains("primary")));
  }

  await row("denied.txt").click();
  permissions("/deny", `*${sid}:(WD,AD)`);
  try {
    await moveTo(destination);
    await checkStopped("Open as administrator");
    await stopped.getByRole("alert").getByText(/access is denied|permission denied/i).waitFor();
  } finally {
    permissions("/remove:d", `*${sid}`);
  }
  await button(stopped, "Cancel").click();
  await stopped.waitFor({ state: "hidden" });
  assert.equal(await readFile(join(source, "denied.txt"), "utf8"), "Still in the source");
  await assert.rejects(readFile(destination), { code: "ENOENT" });

  const path = join(source, names[1]);
  const powershell = `$ErrorActionPreference = 'Stop'; $file = [IO.File]::Open('${path.replaceAll("'", "''")}', 'Open', 'Read', 'None'); [Console]::WriteLine('LOCKED'); [Console]::ReadLine() | Out-Null`;
  const holder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", powershell], { windowsHide: true });
  try {
    await new Promise((resolve, reject) => {
      holder.stdout.once("data", (data) => String(data).includes("LOCKED") ? resolve() : reject(new Error(String(data))));
      holder.once("error", reject);
      holder.once("exit", (code) => reject(new Error(`Transfer lock fixture exited with code ${code}`)));
    });
    await row(names[0]).click();
    for (const name of names) await row(name).click({ modifiers: ["Control"] });
    await moveTo(target);
    await checkStopped("Find locking processes");
    assert.equal(await readFile(join(target, names[0]), "utf8"), names[0]);
    await assert.rejects(readFile(join(source, names[0])), { code: "ENOENT" });
    assert.equal(await readFile(join(source, names[2]), "utf8"), names[2]);
    await button(stopped, "Find locking processes").click();
    const inspector = page.getByRole("dialog", { name: "Processes using these files", exact: true });
    await inspector.getByRole("option", { name: new RegExp(`\\b${holder.pid}\\b`) }).waitFor();
    await button(inspector, "Close").click();
    await checkStopped("Find locking processes");
    await retry.click();
    await checkStopped("Find locking processes");
    assert.equal(holder.exitCode, null);
    await close(holder);
    await retry.click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await files.waitFor();
    for (const name of names) {
      assert.equal(await readFile(join(target, name), "utf8"), name);
      await assert.rejects(readFile(join(source, name)), { code: "ENOENT" });
    }
  } finally { await close(holder); }
  console.log("Verified Windows stopped-transfer Cancel, direct Retry, the lock inspector, and resuming a batch without replaying its first move.");
}
