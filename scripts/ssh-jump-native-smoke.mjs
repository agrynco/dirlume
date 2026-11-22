import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { editPaneAddress } from "./pane-address-smoke.mjs";
import { close } from "./server-smoke.mjs";

const invoke = (page, command, args) => page.evaluate(({ command, args }) =>
  window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const button = (scope, name) => scope.getByRole("button", { name, exact: true });

export async function testNativeJumpHosts(page, temp, destination, config, restartDesktop) {
  const root = join(temp, "ssh-jump-remote");
  const source = join(temp, "ssh-jump-local");
  await mkdir(root);
  await mkdir(source);
  await writeFile(join(root, "download-from-jumps.txt"), "download through both hops");
  await writeFile(join(source, "upload-through-jumps.txt"), "upload through both hops");
  const child = spawn(process.env.DIRLUME_SSH_FIXTURE_PYTHON, ["-u", resolve("scripts/ssh-jump-fixture.py"), root], { windowsHide: true });
  const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let stderr = "";
  let fixtureError;
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", (error) => { fixtureError = error; });
  let profileId;
  const list = (side) => page.getByRole("listbox", { name: `${side} files`, exact: true });
  const row = (side, name) => list(side).locator(`[data-tooltip=${JSON.stringify(name)}]`);
  const dialog = (name) => page.getByRole("dialog", { name, exact: true });
  const pane = () => page.getByRole("region", { name: "right pane", exact: true });

  try {
    const ready = await replies.next();
    assert.ok(!ready.done, `Could not start the SSH route fixture. ${fixtureError ?? stderr}`);
    const { hosts } = JSON.parse(ready.value);
    for (const [side, path] of [["left", source], ["right", destination]]) {
      const address = await editPaneAddress(page, side);
      await address.fill(path);
      await address.press("Enter");
      await page.waitForFunction(({ side, path }) => document.getElementById(`${side}-path`)?.dataset.path === path &&
        document.getElementById(`${side}-files`)?.getAttribute("aria-busy") === "false", { side, path });
    }
    await row("left", "upload-through-jumps.txt").waitFor();
    const input = { ...hosts[2], label: "Production jump route", jumpHosts: [hosts[0], hosts[1]] };
    const testApprovals = [];
    for (const host of hosts) {
      const reply = await invoke(page, "test_ssh_connection", { input, approvals: testApprovals });
      assert.equal(reply.kind, "verifyHost");
      assert.equal(reply.verification.host, host.host);
      assert.equal(reply.verification.port, host.port);
      testApprovals.push(reply.verification);
    }
    assert.equal((await invoke(page, "test_ssh_connection", { input, approvals: testApprovals })).kind, "success");
    const profile = await invoke(page, "save_ssh_profile", { input });
    profileId = profile.id;
    assert.ok(profile.hasSecret && profile.jumpHosts.every(({ hasSecret }) => hasSecret));
    const stored = await readFile(join(config, "ssh-profiles.json"), "utf8");
    assert.equal(JSON.parse(stored).trustedHosts.length, 0);
    for (const { secret } of hosts) assert.ok(!stored.includes(secret), "SSH profile JSON must omit passwords and passphrases");
    const { hasSecret: _hasSecret, jumpHosts, ...savedDestination } = profile;
    const [first, second] = jumpHosts.map(({ hasSecret: _saved, ...host }) => host);
    await invoke(page, "save_ssh_profile", { input: { ...savedDestination, jumpHosts: [second, first] } });
    await invoke(page, "save_ssh_profile", { input: { ...savedDestination, jumpHosts: [first, second] } });

    await button(pane(), "Locations for right pane").click();
    await button(pane(), "FTP").click();
    await row("right", "Production jump route").waitFor();
    await row("right", "Production jump route").click();
    await list("right").press("Enter");
    for (const host of hosts) {
      const verify = dialog("Verify SSH server");
      await verify.locator("p").filter({ hasText: host.host }).first().waitFor();
      await button(verify, "Trust and connect").click();
    }
    await row("right", "download-from-jumps.txt").waitFor();

    async function copy(from, name) {
      await list(from).focus();
      await page.locator(`#${from}-pane.active`).waitFor();
      await row(from, name).click();
      await list(from).press("F5");
      const transfer = dialog("Copy");
      await button(transfer, "Copy").click();
      await transfer.waitFor({ state: "hidden" });
      await page.locator(".statusbar").getByText("Transfer complete", { exact: true }).waitFor();
    }

    await copy("left", "upload-through-jumps.txt");
    assert.equal(await readFile(join(root, "upload-through-jumps.txt"), "utf8"), "upload through both hops");
    await copy("right", "download-from-jumps.txt");
    await row("left", "download-from-jumps.txt").waitFor();
    assert.equal(await readFile(join(source, "download-from-jumps.txt"), "utf8"), "download through both hops");
    await list("right").press("F12");
    const shell = page.locator(".xterm-helper-textarea");
    await shell.focus();
    await page.keyboard.type("jump-shell-echo");
    await page.locator(".xterm-rows").getByText("jump-shell-echo", { exact: false }).waitFor();
    await button(page, "Close terminal").click();

    await list("right").press("Control+Shift+Digit1");
    const shortcut = dialog("Folder shortcuts");
    await shortcut.getByLabel("Title (optional)", { exact: true }).fill("Jump route bookmark");
    await button(shortcut, "Save").click();
    await shortcut.waitFor({ state: "hidden" });
    page = await restartDesktop();
    const saved = (await invoke(page, "ssh_profiles")).find(({ id }) => id === profileId);
    assert.deepEqual(saved.jumpHosts.map(({ host }) => host), hosts.slice(0, 2).map(({ host }) => host));
    await list("right").focus();
    await page.locator("#right-pane.active").waitFor();
    await page.keyboard.down("ControlRight");
    await page.keyboard.press("Digit1");
    await page.keyboard.up("ControlRight");
    await row("right", "download-from-jumps.txt").waitFor();
    assert.equal(await dialog("Verify SSH server").count(), 0);

    child.stdin.write(JSON.stringify({ rotate: 1 }) + "\n");
    assert.equal((await replies.next()).done, false);
    await assert.rejects(invoke(page, "connect_ssh", { id: profileId }), /jump host 2 .*different host key/i);
    console.log("Verified SSH jump host credentials, saved order after restart, terminal, transfers, bookmark reconnect, and changed host key rejection.");
  } finally {
    try {
      if (profileId && !page.isClosed()) await invoke(page, "remove_ssh_profile", { id: profileId });
    } finally {
      await close(child);
    }
  }
}
