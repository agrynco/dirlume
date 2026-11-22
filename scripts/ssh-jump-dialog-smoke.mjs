import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const dialog = (page, name) => page.getByRole("dialog", { name, exact: true });
const pane = (page, side) => page.getByRole("region", { name: `${side} pane`, exact: true });
const hostnames = ["first.example.test", "second.example.test", "production.example.test"];
const routeText = (...hosts) => ["This computer", ...hosts].join(" → ");

async function chooseSource(page, side, source) {
  const panel = pane(page, side);
  await button(panel, `Locations for ${side} pane`).click();
  await button(panel, source).click();
  const files = panel.getByRole("listbox", { name: `${side} files`, exact: true });
  await files.focus();
  await page.waitForFunction((side) => document.getElementById(`${side}-files`)?.getAttribute("aria-busy") === "false", side);
  return files;
}

async function hostDetails(scope, host, username, secret, { key, port = "22" } = {}) {
  await scope.getByLabel("Server", { exact: true }).fill(host);
  assert.equal(await scope.getByLabel("Port", { exact: true }).inputValue(), "22");
  await scope.getByLabel("Port", { exact: true }).fill(port);
  await scope.getByLabel("Username", { exact: true }).fill(username);
  if (key) {
    await scope.getByLabel("Authentication", { exact: true }).selectOption("privateKey");
    await scope.getByLabel("Private key file", { exact: true }).fill(key);
  }
  await scope.getByLabel(key ? "Private key passphrase" : "Password", { exact: true }).fill(secret);
}

async function verifyHosts(page, action) {
  for (const host of hostnames) {
    const verify = dialog(page, "Verify SSH server");
    await verify.getByText(host, { exact: false }).first().waitFor();
    await verify.locator("code").filter({ hasText: "SHA256:" }).waitFor();
    await button(verify, action).click();
  }
}

const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const [platform, leftSource] of [["Windows NT 10.0; Win64; x64", "SSH"], ["X11; Linux x86_64", "FTP"],
    ["Macintosh; Intel Mac OS X 10_15_7", "SSH"]]) {
    const page = await browser.newPage({ userAgent: `Mozilla/5.0 (${platform})`, viewport: { width: 960, height: 620 }, locale: "en-US" });
    page.setDefaultTimeout(8000);
    await page.route("http://dirlume.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    await page.addInitScript((hostnames) => {
      const root = /Windows/.test(navigator.userAgent) ? "C:\\fixture" : "/fixture";
      const verification = (host, index) => ({ host, port: index === 1 ? 2202 : 22, fingerprint: `SHA256:fixture-${index}` });
      const listing = { omitted: 0, elevated: false, entries: [
        { name: "server.txt", directory: false, hidden: false, link: false, modified: null, size: 14 },
      ] };
      const profile = () => JSON.parse(localStorage.getItem("fixture.ssh.profile") ?? "null");
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args) => {
          if (command === "locations") return [{ label: "Home", path: root }];
          if (command === "list_directory") return { path: args.path, parent: null, entries: [], omitted: 0 };
          if (command === "file_icons") return args.items.map(() => null);
          if (command === "ftp_profiles") return [];
          if (command === "ssh_profiles") return profile() ? [profile()] : [];
          if (command === "save_ssh_profile") {
            const safe = ({ secret, clearSecret, ...host }) => ({ ...host, hasSecret: !!secret || !clearSecret });
            const { jumpHosts, ...destination } = args.input;
            const saved = { ...safe(destination), id: "production", jumpHosts: jumpHosts.map((host, index) => ({
              ...safe(host), id: host.id ?? `jump-${index}`,
            })) };
            localStorage.setItem("fixture.ssh.profile", JSON.stringify(saved));
            return saved;
          }
          if (command === "test_ssh_connection" || command === "connect_ssh") {
            const settings = args.input ?? profile();
            const route = [...settings.jumpHosts.map(({ host }) => host), settings.host];
            if (route.join(",") !== hostnames.join(",")) throw new Error("The route is in the wrong order.");
            const approved = args.approvals ?? [];
            if (approved.some(({ host, fingerprint }, index) => host !== hostnames[index] || fingerprint !== `SHA256:fixture-${index}`)) {
              throw new Error("Unexpected route approval.");
            }
            const next = approved.length;
            if (next < route.length) return { kind: "verifyHost", verification: verification(route[next], next) };
            return command === "test_ssh_connection" ? { kind: "success" } : { kind: "connected",
              id: 17, address: "Production", origin: "sftp://production.example.test", segments: [], listing };
          }
          if (command === "list_ssh") return listing;
          return null;
        },
      };
    }, hostnames);
    await page.goto("http://dirlume.test/");
    const left = await chooseSource(page, "left", leftSource);
    await left.press("Shift+F4");
    if (leftSource === "FTP") await dialog(page, "Add FTP connection").getByLabel("Protocol", { exact: true }).selectOption("sftp");
    const add = dialog(page, leftSource === "FTP" ? "Add SFTP connection" : "Add SSH connection");
    await add.getByLabel("Connection name", { exact: true }).fill("Production");
    await hostDetails(add, hostnames[2], "destination", "test-password");
    const route = add.getByLabel("Route", { exact: true });
    assert.equal(await route.textContent(), routeText(hostnames[2]));
    for (const [index, host] of hostnames.slice(0, 2).entries()) {
      await button(add, "Add jump host").click();
      const editor = add.getByRole("group", { name: "New jump host", exact: true });
      await hostDetails(editor, host, `admin-${index}`, "test-secret", index === 1 ? { key: "/fixtures/key", port: "2202" } : {});
      await button(editor, "Save jump host").click();
    }
    const second = `${hostnames[1]}:2202`;
    assert.equal(await route.textContent(), routeText(hostnames[0], second, hostnames[2]));
    await button(add.getByRole("listitem").first(), "Move down").click();
    assert.equal(await route.textContent(), routeText(second, hostnames[0], hostnames[2]));
    await button(add, "Edit jump host 1").click();
    const editor = add.getByRole("group", { name: "Edit jump host", exact: true });
    assert.equal(await editor.getByLabel("Username", { exact: true }).inputValue(), "admin-1");
    assert.equal(await editor.getByLabel("Private key file", { exact: true }).inputValue(), "/fixtures/key");
    await editor.getByLabel("Username", { exact: true }).fill("updated-admin");
    await button(editor, "Save jump host").click();
    await button(add.getByRole("listitem").first(), "Move down").click();
    await button(add, "Test connection").click();
    await verifyHosts(page, "Verify and test");
    await add.getByText("SFTP connection successful.", { exact: true }).waitFor();
    await button(add, "Save connection").click();
    await add.waitFor({ state: "hidden" });

    await page.reload();
    const right = await chooseSource(page, "right", leftSource === "FTP" ? "SSH" : "FTP");
    const production = right.getByRole("option", { name: /^Production/ });
    await production.click();
    await right.press("F4");
    const edit = dialog(page, leftSource === "FTP" ? "Edit SSH connection" : "Edit SFTP connection");
    assert.equal(await edit.getByLabel("Route", { exact: true }).textContent(), routeText(hostnames[0], second, hostnames[2]));
    await button(edit, "Edit jump host 2").click();
    const reopened = edit.getByRole("group", { name: "Edit jump host", exact: true });
    assert.equal(await reopened.getByLabel("Username", { exact: true }).inputValue(), "updated-admin");
    assert.equal(await reopened.getByLabel("Private key passphrase", { exact: true }).inputValue(), "");
    await button(reopened, "Cancel").click();
    await button(edit, "Remove jump host 2").click();
    await button(edit, "Remove jump host 1").click();
    assert.equal(await edit.getByLabel("Route", { exact: true }).textContent(), routeText(hostnames[2]));
    await button(edit, "Cancel").click();
    await right.press("Enter");
    await verifyHosts(page, "Trust and connect");
    await right.getByRole("option", { name: /^server.txt/ }).waitFor();
    await page.close();
  }
  console.log("Verified ordered jump host editing, persistence, direct route preview, and per-server approvals in the SSH and SFTP profile dialogs.");
} finally {
  await browser.close();
}
