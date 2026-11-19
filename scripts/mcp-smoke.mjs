import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { close, withServer } from "./server-smoke.mjs";
import { closeToolWindow, openOptionsWindow } from "./tool-window-smoke.mjs";

export async function testMcp({ page, root, startDesktop, exitDesktop, pid }) {
  const source = join(root, "mcp-source");
  const target = join(root, "mcp-target");
  await mkdir(source);
  await mkdir(target);
  for (const [side, path] of [["left", source], ["right", target]]) {
    const address = page.getByLabel(side + " path", { exact: true });
    await address.fill(path);
    await address.press("Enter");
    await page.getByRole("heading", { name: `mcp-${side === "left" ? "source" : "target"}`, exact: true }).waitFor({ state: "attached" });
  }
  const dialog = (name) => page.getByRole("dialog", { name, exact: true });
  const button = (parent, name) => parent.getByRole("button", { name, exact: true });
  async function serverDialog() {
    const menu = page.getByRole("menu", { name: "Commands", exact: true });
    if (!await menu.isVisible()) await page.getByRole("menubar").getByRole("menuitem", { name: "Commands", exact: true }).click();
    await menu.getByRole("menuitem", { name: "MCP server", exact: true }).click();
    return dialog("MCP server");
  }
  const server = await serverDialog();
  await button(server, "Start server").click();
  const configuration = JSON.parse(await server.getByLabel("MCP connection configuration").inputValue());
  await button(server, "Close").click();

  let id = 0;
  const http = (method, params, headers = configuration.headers) => fetch(configuration.url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const rpc = async (method, params) => (await http(method, params)).json();
  const call = async (name, args = {}) => rpc("tools/call", { name, arguments: args });
  const data = async (name, args) => {
    const response = await call(name, args);
    assert.equal(response.error, undefined, name);
    assert.equal(response.result.isError, undefined, response.result.content[0].text);
    return JSON.parse(response.result.content[0].text);
  };
  assert.equal((await http("initialize", {}, {})).status, 401);
  assert.equal((await http("initialize", {}, { ...configuration.headers, Origin: "https://example.invalid" })).status, 403);
  const initialized = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Dirlume verification", version: "1" } });
  assert.equal(initialized.result.protocolVersion, "2025-11-25");
  assert.ok((await rpc("tools/list")).result.tools.some((tool) => tool.name === "delete_items" && tool.annotations.destructiveHint));
  await data("create_entry", { side: "left", kind: "file", name: "new-file.txt" });
  const original = await data("read_text", { side: "left", name: "new-file.txt" });
  await data("save_text", { side: "left", name: "new-file.txt", text: "Saved by MCP", revision: original.revision });
  await data("rename_item", { side: "left", name: "new-file.txt", newName: "example.txt" });
  await data("select_items", { side: "left", names: ["example.txt"] });
  assert.deepEqual((await data("workspace")).panes.left.marked, ["example.txt"]);
  assert.equal((await data("search_files", { side: "left", mask: "*.txt" })).matches[0].path, "example.txt");
  await data("transfer_items", { side: "left", destination: "right", operation: "copy", names: ["example.txt"] });
  const path = join(target, "example.txt");
  assert.equal(await readFile(path, "utf8"), "Saved by MCP");
  assert.ok((await call("delete_items", { paths: [path], permanent: true, approved: true })).error);
  assert.ok((await stat(path)).isFile());

  const confirmation = dialog("Confirm MCP request");
  function waitForApproval(request, target) {
    return Promise.race([
      confirmation.getByText(target, { exact: typeof target === "string" }).waitFor().catch(async (error) => {
        if (await confirmation.isVisible()) throw new Error(`Unexpected approval targets: ${await confirmation.locator("li").allTextContents()}`);
        throw error;
      }),
      request.then((response) => { throw new Error(response.error?.message ?? response.result.content[0].text); }),
    ]);
  }
  const decline = call("delete_items", { paths: [path], permanent: true });
  await waitForApproval(decline, path);
  await button(confirmation, "Cancel").click();
  assert.equal((await decline).result.isError, true);
  assert.ok((await stat(path)).isFile());

  const fixtureHandle = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-Process -Id ${pid()}).MainWindowHandle.ToInt64()`], { encoding: "utf8", windowsHide: true, timeout: 10_000 }).trim();
  assert.match(fixtureHandle, /^[1-9][0-9]*$/);
  function windowState(state) {
    const program = `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class McpFixtureWindow { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window); }'
$fixture = [IntPtr]${fixtureHandle}
[void][McpFixtureWindow]::ShowWindow($fixture, ${state})
if ([McpFixtureWindow]::IsIconic($fixture) -ne (${state} -eq 6)) { throw 'Test window did not change state' }
`;
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", program], { windowsHide: true, timeout: 10_000 });
  }
  windowState(6);
  try {
    const unavailable = await call("delete_items", { paths: [path], permanent: true });
    assert.equal(unavailable.result.content[0].text, "Open the Dirlume window to handle the MCP request.");
    assert.ok((await stat(path)).isFile());
  } finally { windowState(9); }

  const approve = call("delete_items", { paths: [path], permanent: true });
  await waitForApproval(approve, path);
  await button(confirmation, "Delete permanently").click();
  assert.equal((await approve).result.isError, undefined);
  await assert.rejects(stat(path), { code: "ENOENT" });

  const process = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60"], { windowsHide: true });
  try {
    assert.ok((await data("list_processes")).some(({ pid }) => pid === process.pid));
    const refusal = call("terminate_processes", { pids: [process.pid] });
    await waitForApproval(refusal, new RegExp(`PID ${process.pid}\\)`));
    await button(confirmation, "Cancel").click();
    assert.equal((await refusal).result.isError, true);
    assert.equal(process.exitCode, null);
    const ended = call("terminate_processes", { pids: [process.pid] });
    await waitForApproval(ended, new RegExp(`PID ${process.pid}\\)`));
    await button(confirmation, "End processes").click();
    assert.equal((await ended).result.isError, undefined);
  } finally { await close(process); }

  await withServer(async ({ invitation, bytes }) => {
    await data("connect_dirlume_server", { side: "left", invitation });
    await data("navigate_pane", { side: "left", path: "/folder" });
    assert.ok((await data("list_directory", { side: "left" })).entries.some(({ name }) => name === "файл.bin"));
    await data("transfer_items", { side: "left", destination: "right", operation: "copy", names: ["файл.bin"] });
    assert.deepEqual(await readFile(join(target, "файл.bin")), bytes);
  });
  const scheme = await data("create_color_scheme", { name: "MCP smoke scheme", base: "dark", colors: { "panel-bg": "#13263a" } });
  assert.equal(scheme.colors["panel-bg"], "#13263a");
  await writeFile(join(target, "keep.txt"), "not touched");
  const controls = await serverDialog();
  await button(controls, "Stop server").click();
  await button(controls, "Start server").waitFor();
  await button(controls, "Close").click();
  await exitDesktop(page);
  page = await startDesktop();
  const optionsWindow = await openOptionsWindow(page);
  const options = optionsWindow.getByRole("dialog", { name: "Options", exact: true });
  if (!await options.getByRole("button", { name: "Window", exact: true }).isVisible()) {
    await options.getByRole("button", { name: "Appearance", exact: true }).click();
  }
  await options.getByRole("button", { name: "Window", exact: true }).click();
  const selector = options.getByLabel("Color scheme", { exact: true });
  await selector.getByRole("option", { name: "MCP smoke scheme", exact: true }).waitFor({ state: "attached" });
  await selector.selectOption({ label: "MCP smoke scheme" });
  await closeToolWindow(optionsWindow, () => button(options, "Done").click());
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--panel-bg") === "#13263a");
  console.log("Verified local MCP connection, file and remote operations, approval, refusal, unavailable confirmation, and saved color schemes.");
  return page;
}
