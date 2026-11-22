import { editPaneAddress } from "./pane-address-smoke.mjs";
import { openMainMenu } from "./menu-header-smoke.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { close } from "./server-smoke.mjs";

export async function testLockingProcessPane(page, root) {
  const dialog = (name) => page.getByRole("dialog", { name, exact: true });
  const pane = (side) => page.getByRole("region", { name: side + " pane", exact: true });
  const row = (side) => pane(side).locator('[role="option"][data-tooltip="blocking-test.txt"]');
  for (const side of ["left", "right"]) {
    const target = join(root, `locking-${side}`);
    await mkdir(target);
    const filename = join(target, "blocking-test.txt");
    await writeFile(filename, "Locking process fixture");
    const address = await editPaneAddress(page, side);
    await address.fill(target);
    await address.press("Enter");
    await row(side).waitFor();
  }
  const button = (parent, name) => parent.getByRole("button", { name, exact: true });
  async function open(side) {
    await row(side).click();
    const menu = await openMainMenu(page, "Files");
    await menu.getByRole("menuitem", { name: "Find locking processes", exact: true }).click();
    const target = pane(side === "left" ? "right" : "left");
    await target.getByRole("grid", { name: "Running processes", exact: true }).waitFor();
    assert.equal(await row(side).getAttribute("data-current"), "true");
    return target;
  }

  for (const side of ["left", "right"]) {
    const filename = join(root, `locking-${side}`, "blocking-test.txt");
    const script = `$file = [IO.File]::Open('${filename.replaceAll("'", "''")}', 'Open', 'Read', 'None'); Write-Output 'LOCKED'; Start-Sleep -Seconds 90`;
    const locked = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    try {
      await new Promise((resolve, reject) => {
        locked.stdout.once("data", (data) => String(data).includes("LOCKED") ? resolve() : reject(new Error(String(data))));
        locked.once("error", reject);
        locked.once("exit", (code) => reject(new Error("Lock fixture exited with code " + code)));
      });
      const target = await open(side);
      const process = target.getByRole("row").filter({
        has: page.getByRole("gridcell", { name: String(locked.pid), exact: true }),
      });
      await process.waitFor();
      const cells = await process.getByRole("gridcell").allTextContents();
      assert.equal(cells[0].toLowerCase(), "powershell.exe");
      assert.match(cells[2], /%$/);
      assert.notEqual(cells[3], "0 B");
      await process.click();
      const confirmation = dialog("End processes");
      if (side === "left") {
        await page.keyboard.press("F8");
        await button(confirmation, "Cancel").click();
        assert.equal(locked.exitCode, null);
        await page.keyboard.press("F8");
      } else {
        await button(target, "Properties").click();
        const details = dialog("Process properties");
        await details.getByText(String(locked.pid), { exact: true }).waitFor();
        await details.getByText(/powershell\.exe$/i).first().waitFor();
        await button(details, "End process").click();
      }
      await button(confirmation, "End process").click();
      await confirmation.waitFor({ state: "hidden" });
      await target.getByText("Windows found no processes using these files.", { exact: true }).waitFor();
      await button(target, "Back to files").click();
      const opposite = side === "left" ? "right" : "left";
      await row(opposite).waitFor();
      await page.waitForFunction((side) => document.activeElement?.id === `${side}-files`, opposite);
    } finally {
      await close(locked);
    }
  }
  console.log("Verified locking processes in the opposite pane, preserved file selection, cancellation, F8 and Properties termination, and returning to files.");
}

async function startHolder(cwd, file) {
  const open = file ? `$file = [IO.File]::Open('${file.replaceAll("'", "''")}', 'Open', 'Read', 'None'); ` : "";
  const holder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference = 'Stop'; ${open}[Console]::WriteLine('LOCKED'); [Console]::ReadLine() | Out-Null`], { cwd, windowsHide: true });
  try {
    await new Promise((resolve, reject) => {
      holder.stdout.once("data", (data) => String(data).includes("LOCKED") ? resolve() : reject(new Error(String(data))));
      holder.once("error", reject);
      holder.once("exit", (code) => reject(new Error(`Folder lock fixture exited with code ${code}`)));
    });
    return holder;
  } catch (error) {
    await close(holder);
    throw error;
  }
}

export async function testFolderLockInspector(page, root) {
  const parent = join(root, "folder-lock-inspector");
  await mkdir(parent);
  const empty = join(parent, "Empty folder");
  const nested = join(parent, "Nested files");
  await mkdir(empty);
  await mkdir(join(nested, "child"), { recursive: true });
  const file = join(nested, "child", "in-use.txt");
  await writeFile(file, "Locked by a different process");
  const address = await editPaneAddress(page, "left");
  await address.fill(parent);
  await address.press("Enter");
  const list = page.locator("#left-files");
  const dialog = (name) => page.getByRole("dialog", { name, exact: true });
  const button = (scope, name) => scope.getByRole("button", { name, exact: true });

  async function inspect(name, holders) {
    const folder = list.locator(`[role="option"][data-tooltip=${JSON.stringify(name)}]`);
    await folder.click();
    await list.press("F6");
    const transfer = dialog("Rename or move");
    await transfer.getByRole("combobox", { name: "Destination" }).fill(join(parent, `${name} moved`));
    await button(transfer, "Move").click();
    const stopped = dialog("Transfer stopped");
    await button(stopped, "Find locking processes").click();
    const inspector = dialog("Processes using these files");
    for (const holder of holders) {
      await inspector.getByRole("option", { name: new RegExp(`^powershell\\.exe.*\\b${holder.pid}\\b`, "i") }).waitFor();
      assert.equal(holder.exitCode, null);
    }
    await button(inspector, "Close").click();
    await stopped.waitFor();
    await page.keyboard.press("Escape");
    await stopped.waitFor({ state: "hidden" });
    await folder.waitFor();
  }

  const first = await startHolder(empty);
  try { await inspect("Empty folder", [first]); }
  finally { await close(first); }

  const directoryHolder = await startHolder(nested);
  try {
    const fileHolder = await startHolder(parent, file);
    try { await inspect("Nested files", [directoryHolder, fileHolder]); }
    finally { await close(fileHolder); }
  } finally {
    await close(directoryHolder);
  }
  console.log("Verified the stopped-transfer inspector identifies an empty folder holder and separate holders for a folder and its nested file.");
}
