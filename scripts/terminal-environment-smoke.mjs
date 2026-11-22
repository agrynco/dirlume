import { closeToolWindow, openOptionsWindow } from "./tool-window-smoke.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

function userEnvironment(request) {
  const data = Buffer.from(JSON.stringify(request)).toString("base64");
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  if ($request.read) {
    $value = $key.GetValue($request.name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = if ($null -ne $value) { $key.GetValueKind($request.name).ToString() } else { 'String' }
    [pscustomobject]@{value=$value; kind=$kind} | ConvertTo-Json -Compress
    return
  }
  if ($null -eq $request.value) { $key.DeleteValue($request.name, $false) }
  else { $key.SetValue($request.name, $request.value, [Microsoft.Win32.RegistryValueKind]$request.kind) }
} finally { $key.Dispose() }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EnvironmentNotice {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, string area, uint flags, uint timeout, out UIntPtr result);
}
'@
$result = [UIntPtr]::Zero
[void][EnvironmentNotice]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 250, [ref]$result)
`;
  const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 12000 });
  return request.read ? JSON.parse(output) : undefined;
}

export async function testTerminalEnvironment(page) {
  const variable = `DIRLUME_SMOKE_ENV_${randomBytes(8).toString("hex").toUpperCase()}`;
  const change = (value, kind = "String") => userEnvironment({ name: variable, value, kind });
  const saveInApp = async (value, kind) => {
    const result = await page.evaluate(async ({ name, value, kind }) => {
      const scope = "user";
      const expected = await window.__TAURI_INTERNALS__.invoke("environment_value", { scope, name });
      return window.__TAURI_INTERNALS__.invoke("save_environment", { scope, edits: [{ name, value, kind, expected, replacePath: false }], integrate: false });
    }, { name: variable, value, kind });
    assert.deepEqual(result.outcomes, [{ name: variable, result: "saved" }]);
  };
  const field = page.getByRole("combobox", { name: "Command line", exact: true });
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  const toggle = page.getByRole("button", { name: "Toggle terminal", exact: true });
  const notice = terminal.getByText(/Windows environment changed/);
  const oldPath = process.env.CI ? userEnvironment({ name: "Path", read: true }) : null;
  const extraPath = `${process.env.USERPROFILE}\\${variable}`;
  let serial = 0;

  async function setting(enabled) {
    const window = await openOptionsWindow(page);
    const options = window.getByRole("dialog", { name: "Options", exact: true });
    const search = options.getByRole("searchbox", { name: "Search settings" });
    await search.fill("refresh environment variables");
    await search.press("Tab");
    await options.getByRole("button", { name: "Terminal", exact: true }).click();
    await options.getByRole("checkbox", { name: "Automatically refresh environment variables", exact: true }).setChecked(enabled);
    await search.fill("");
    await closeToolWindow(window, () => options.getByRole("button", { name: "Done", exact: true }).click());
  }

  async function run(code, expected) {
    const marker = `ENVPROBE${++serial}`;
    if (await terminal.isVisible()) await toggle.click();
    await field.fill(`${code}; Write-Output ('${marker}' + '=' + $result)`);
    await field.press("Enter");
    await page.waitForFunction((value) => document.querySelector(".xterm-rows")?.textContent.replace(/\s/g, "").includes(value.replace(/\s/g, "")),
      `${marker}=${expected}`, { timeout: 15000 });
  }

  async function reopen() {
    await terminal.getByRole("button", { name: "Close terminal", exact: true }).click();
    await terminal.waitFor({ state: "hidden" });
    await toggle.click();
    await terminal.waitFor();
  }

  const read = `$result = [Environment]::GetEnvironmentVariable('${variable}'); if ($null -eq $result) { $result = 'missing' }`;
  let pathChanged = false;
  await setting(true);
  try {
    await run(`$global:DirlumeSmokeSession = 'initial'; ${read}`, "missing");
    for (const side of ["left", "right"]) {
      const status = page.locator("#" + side + "-pane .pane-footer > .pane-status-line");
      await status.waitFor();
      assert.equal(await status.count(), 1);
    }
    await saveInApp("%USERPROFILE%\\dirlume-env-probe", "expandable");
    assert.deepEqual(userEnvironment({ name: variable, read: true }), { value: "%USERPROFILE%\\dirlume-env-probe", kind: "ExpandString" });
    await notice.waitFor();
    await run(read, "missing");
    await run("$result = $global:DirlumeSmokeSession", "initial");
    if (oldPath) {
      const entries = [oldPath.value, extraPath].filter(Boolean).join(";");
      pathChanged = true;
      userEnvironment({ name: "Path", value: entries, kind: oldPath.kind });
    }
    await reopen();
    await run(read, `${process.env.USERPROFILE}\\dirlume-env-probe`);
    await run("$result = $env:DIRLUME_TEST_PROCESS_ONLY", "launcher-value");
    if (oldPath) {
      const expected = extraPath.replaceAll("'", "''");
      await run(`$result = ($env:Path.Split(';') -contains '${expected}')`, "True");
    }

    await saveInApp("Змінна ✓", "literal");
    await notice.waitFor();
    await run(read, `${process.env.USERPROFILE}\\dirlume-env-probe`);
    await reopen();
    await run(read, "Змінна ✓");
    change(null);
    await reopen();
    await run(read, "missing");

    await setting(false);
    change("disabled-preference");
    await reopen();
    assert.equal(await notice.count(), 0);
    await run(read, "missing");
  } finally {
    try {
      change(null);
    } finally {
      if (pathChanged) userEnvironment({ name: "Path", ...oldPath });
    }
  }
  await setting(true);
  await terminal.getByRole("button", { name: "Close terminal", exact: true }).click();
  console.log("Verified Windows environment broadcasts, refreshed PowerShell sessions, Unicode and expansion, process-only variables, and disabling refresh.");
}
