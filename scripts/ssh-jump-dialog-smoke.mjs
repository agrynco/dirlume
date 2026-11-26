import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const dialog = (page, name) => page.getByRole("dialog", { name, exact: true });
const pane = (page, side) => page.getByRole("region", { name: `${side} pane`, exact: true });
const hostnames = ["first.example.test", "second.example.test", "production.example.test"];
const routeText = (...hosts) => ["This computer", ...hosts].join(" → ");

async function chooseSource(page, side, shortcut) {
  const panel = pane(page, side);
  await button(panel, `Locations for ${side} pane`).click();
  const netbox = button(panel, "NetBox");
  if (shortcut) {
    assert.equal(await netbox.locator("kbd").innerText(), shortcut);
    await page.keyboard.press(shortcut);
  } else {
    assert.equal(await netbox.locator("kbd").count(), 0);
    await netbox.click();
  }
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
  for (const [platform, ftpSources, sshSources, expectedShortcut] of [
    ["Windows NT 10.0; Win64; x64", ["7"], ["8"], "7"],
    ["X11; Linux x86_64", ["2"], ["8"], "8"],
    ["Macintosh; Intel Mac OS X 10_15_7", [], ["8"], null],
  ]) {
    const page = await browser.newPage({ userAgent: `Mozilla/5.0 (${platform})`, viewport: { width: 960, height: 620 }, locale: "en-US" });
    page.setDefaultTimeout(8000);
    await page.route("http://dirlume.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    await page.addInitScript(({ hostnames, ftpSources, sshSources, nextPageKey, previousPageDisabled }) => {
      if (!localStorage.getItem("dirlume.preferences.v1")) {
        localStorage.setItem("dirlume.preferences.v1", JSON.stringify({
          bindingDefaults: 10, shortcuts: { ftpSources, sshSources,
            ...(nextPageKey ? { netboxNextPage: [nextPageKey] } : {}),
            ...(previousPageDisabled ? { netboxPreviousPage: [] } : {}),
          },
        }));
      }
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
    }, { hostnames, ftpSources, sshSources, nextPageKey: /Linux/.test(platform) ? "Ctrl+Alt+N" : null,
      previousPageDisabled: /Macintosh/.test(platform) });
    await page.goto("http://dirlume.test/");
    const left = await chooseSource(page, "left", expectedShortcut);
    await left.getByText("No saved connections.", { exact: true }).waitFor();
    await button(left, "Add connection").click();
    const add = dialog(page, "Add NetBox connection");
    assert.equal(await add.getByLabel("Protocol", { exact: true }).inputValue(), "sftp");
    await add.getByLabel("Connection name", { exact: true }).fill("Production");
    const tabs = add.getByRole("tablist", { name: "NetBox settings pages", exact: true });
    const tab = (name) => tabs.getByRole("tab", { name, exact: true });
    const selected = (name) => tab(name).getAttribute("aria-selected");
    const previous = button(add, "Previous settings page");
    const next = button(add, "Next settings page");
    assert.equal(await selected("Session"), "true");
    assert.equal(await previous.isDisabled(), true);
    await next.click();
    assert.equal(await selected("Environment"), "true");
    assert.equal(await add.getByLabel("Filename code page").count(), 0);
    await next.click();
    assert.equal(await selected("Directories"), "true");
    await next.click();
    assert.equal(await selected("Connection"), "true");
    assert.equal(await next.isDisabled(), true);
    await tab("Session").click();
    const protocol = add.getByLabel("Protocol", { exact: true });
    await protocol.selectOption("ftp");
    const encryption = add.getByLabel("Encryption", { exact: true });
    const ftpPort = add.getByLabel("Port", { exact: true });
    assert.equal(await encryption.inputValue(), "plain");
    assert.equal(await ftpPort.inputValue(), "21");
    await encryption.selectOption("implicitTls");
    assert.equal(await ftpPort.inputValue(), "990");
    await encryption.selectOption("explicitTls");
    assert.equal(await ftpPort.inputValue(), "21");
    await encryption.selectOption("plain");
    await add.evaluate((element) => { element.style.width = "194px"; });
    await tab("Session").focus();
    if (/Linux/.test(platform)) {
      await page.keyboard.press("Control+PageDown");
      assert.equal(await selected("Session"), "true");
      await page.keyboard.press("Control+Alt+n");
    } else await page.keyboard.press("Control+PageDown");
    assert.equal(await selected("Environment"), "true", platform);
    assert.equal(await tabs.evaluate((element) => element.scrollLeft > 0), true);
    assert.equal(await previous.isVisible(), true);
    await add.getByLabel("Filename code page").fill("1251");
    await add.getByLabel("Line endings for files without line breaks").selectOption("crlf");
    await page.keyboard.press("Control+PageUp");
    if (/Macintosh/.test(platform)) {
      assert.equal(await selected("Environment"), "true");
      await previous.click();
    }
    assert.equal(await selected("Session"), "true");
    await protocol.focus();
    await page.keyboard.press(/Linux/.test(platform) ? "Control+Alt+n" : "Control+PageDown");
    assert.equal(await selected("Session"), "true");
    await next.click();
    assert.equal(await add.getByLabel("Filename code page").inputValue(), "1251");
    await button(add, "Save connection").click();
    await add.getByRole("tabpanel", { name: "Session" }).waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Server");
    await add.getByLabel("Server", { exact: true }).fill("ftp.example.test");
    await tab("Environment").click();
    await add.getByLabel("Filename code page").fill("70000");
    await tab("Session").click();
    await button(add, "Save connection").click();
    const codePage = add.getByRole("tabpanel", { name: "Environment" }).getByLabel("Filename code page");
    await codePage.waitFor();
    await page.waitForFunction(() => document.activeElement?.closest('[data-netbox-page="environment"]') !== null &&
      document.activeElement instanceof HTMLInputElement && document.activeElement.value === "70000");
    await next.click();
    const directories = add.getByRole("tabpanel", { name: "Directories" });
    assert.equal(await directories.getByLabel("Resolve directory symbolic links").isDisabled(), true);
    assert.equal(await directories.getByLabel("Keep directory cache after closing Dirlume").isDisabled(), true);
    await directories.getByLabel("Starting folder").fill("/configured");
    await directories.getByLabel("Cache directory changes").check();
    await directories.getByLabel("Remember last used directory").check();
    await directories.getByLabel("Keep directory cache after closing Dirlume").check();
    await next.click();
    const settings = add.getByRole("tabpanel", { name: "Connection" });
    await settings.getByLabel("Server response timeout").selectOption("custom");
    await settings.getByLabel("Response timeout (seconds)").fill("3601");
    await settings.getByLabel("Connection keepalive").selectOption("disabled");
    await settings.getByLabel("IP address family").selectOption("ipv6");
    await settings.getByLabel("Use larger FTP data buffers").check();
    await tab("Environment").click();
    await add.getByLabel("Filename code page").fill("1251");
    await tab("Session").click();
    await button(add, "Save connection").click();
    await settings.waitFor();
    await page.waitForFunction(() => document.activeElement?.closest('[data-netbox-page="connection"]') !== null &&
      document.activeElement instanceof HTMLInputElement && document.activeElement.value === "3601");
    await settings.getByLabel("Response timeout (seconds)").fill("90");
    await tab("Session").click();
    await add.evaluate((element) => { element.style.removeProperty("width"); });
    await protocol.selectOption("sftp");
    await tab("Environment").click();
    assert.equal(await add.getByLabel("Filename code page").count(), 0);
    assert.equal(await add.getByLabel("Line endings for files without line breaks").inputValue(), "crlf");
    await tab("Session").click();
    assert.equal(await add.getByLabel("Connection name", { exact: true }).inputValue(), "Production");
    await tab("Directories").click();
    assert.equal(await directories.getByLabel("Starting folder").inputValue(), "/configured");
    assert.equal(await directories.getByLabel("Remember last used directory").isChecked(), true);
    assert.equal(await directories.getByLabel("Keep directory cache after closing Dirlume").isChecked(), true);
    await directories.getByLabel("Resolve directory symbolic links").check();
    await tab("Connection").click();
    assert.equal(await settings.getByLabel("Response timeout (seconds)").inputValue(), "90");
    assert.equal(await settings.getByLabel("Connection keepalive").inputValue(), "disabled");
    assert.equal(await settings.getByLabel("IP address family").inputValue(), "ipv6");
    assert.equal(await settings.getByLabel("Use larger FTP data buffers").count(), 0);
    await tab("Session").click();
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
    const right = await chooseSource(page, "right", expectedShortcut);
    const production = right.getByRole("option", { name: /^Production/ });
    assert.equal(await production.locator(".file-protocol").textContent(), "SFTP");
    assert.equal(await production.locator(".file-host").textContent(), hostnames[2]);
    await production.click();
    await right.press("F4");
    const edit = dialog(page, "Edit NetBox connection");
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
  console.log("Verified NetBox page navigation, shortcut migration, cross-page validation, jump host editing, and per-server approvals.");
} finally {
  await browser.close();
}
