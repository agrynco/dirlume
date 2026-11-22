import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

export async function testSyntaxMenu() {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 880, height: 550 } });
    page.setDefaultTimeout(8000);
    await page.route("http://dirlume.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    await page.addInitScript(() => {
      const path = /Windows/i.test(navigator.userAgent) ? "C:\\fixture\\nginx\\conf.d" : "/fixture/nginx/conf.d";
      const entry = { name: "source.txt", directory: false, link: false, hidden: false, size: 30, modified: null };
      const site = { ...entry, name: "example.com" };
      const siteText = [
        "server {",
        "  listen 443 ssl; # HTTPS",
        "  return 301 https://$host$request_uri;",
        '  add_header X-Site "site: ${host}#1";',
        "}",
      ].join("\n");
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args) => {
          if (command === "locations") return [{ label: "Home", path }];
          if (command === "list_directory") return { path, parent: null, entries: [entry, site, { ...site, name: "vhost.conf" }], omitted: 0 };
          if (command === "file_icons") return args.items.map(() => null);
          if (command === "read_text") return { text: args.name === entry.name ? "fn main() { let ready = true; }" : siteText, encoding: "utf8" };
          if (command === "ssh_profiles") return [{ id: "ssh", label: "SSH fixture", host: "fixture", port: 22 }];
          if (command === "connect_ssh") return { kind: "connected", id: 1, address: "fixture", origin: "sftp://fixture",
            segments: ["etc", "nginx", "sites-enabled"], listing: { entries: [site], omitted: 0, elevated: false } };
          if (command === "read_ssh_text") return { text: siteText, encoding: "utf8", revision: "1" };
          return null;
        },
      };
    });
    await page.goto("http://dirlume.test/");
    const list = page.getByRole("listbox", { name: "left files", exact: true });
    const file = list.getByRole("option", { name: /^source.txt/ });
    const document = page.getByRole("region", { name: "source.txt", exact: true });
    const bar = document.getByRole("menubar", { name: "Document menu", exact: true });
    const syntax = bar.getByRole("menuitem", { name: "Syntax", exact: true });
    const choose = bar.getByRole("menuitem", { name: "Choose syntax…", exact: true });
    const picker = page.getByRole("dialog", { name: "Choose syntax", exact: true });
    const search = picker.getByRole("searchbox", { name: "Search syntax", exact: true });
    const options = picker.getByRole("option");
    const selector = document.getByRole("button", { name: "Syntax", exact: true });
    const tokens = document.locator(".syntax-keyword").filter({ hasText: /^fn$/ });
    const waitForFocus = (control) => page.waitForFunction((element) => element === document.activeElement, control);

    await file.click();
    await list.press("F4");
    await selector.waitFor();
    await syntax.click();
    await choose.click();
    await search.waitFor();
    assert.equal(await search.evaluate((element) => element === element.ownerDocument.activeElement), true);
    assert.deepEqual((await options.allTextContents()).slice(0, 2), ["Automatic", "Plain text"]);
    assert.equal(await picker.getByRole("listbox").evaluate((node) => node.scrollHeight > node.clientHeight), true);
    for (const [query, first] of [["PS1", "PowerShell"], [".ps1", "PowerShell"], ["csharp", "C#"], ["bash", "Shell"]]) {
      await search.fill(query);
      assert.equal(await options.first().textContent(), first);
    }
    await search.fill("no-such-language");
    await picker.getByText("No matching syntax", { exact: true }).waitFor();
    await search.press("Enter");
    assert.equal(await picker.isVisible(), true);
    await search.press("Escape");
    await picker.waitFor({ state: "hidden" });
    await waitForFocus(await syntax.elementHandle());
    await selector.click();
    await search.fill("Rust");
    await options.getByText("Rust", { exact: true }).click();
    await tokens.waitFor();
    assert.equal(await selector.textContent(), "Rust");
    await waitForFocus(await selector.elementHandle());
    const content = document.locator(".cm-content");
    await content.press("End");
    await page.keyboard.insertText(" // unsaved draft");
    await syntax.click();
    await bar.getByRole("menuitem", { name: "Plain text", exact: true }).click();
    assert.equal(await selector.textContent(), "Plain text");
    assert.match(await content.textContent(), /unsaved draft/);
    await tokens.waitFor({ state: "hidden" });
    await document.getByRole("button", { name: "Close document", exact: true }).click();
    await page.getByRole("button", { name: "Discard changes", exact: true }).click();

    await file.click();
    await list.press("F3");
    await selector.waitFor();
    await selector.click();
    await search.press("ArrowDown");
    await search.press("Enter");
    await picker.waitFor({ state: "hidden" });
    assert.equal(await selector.textContent(), "Plain text");
    await syntax.click();
    await choose.click();
    await search.fill(".ps1");
    await search.press("Enter");
    await picker.waitFor({ state: "hidden" });
    assert.equal(await selector.textContent(), "PowerShell");
    await syntax.click();
    await bar.getByRole("menuitem", { name: "Automatic", exact: true }).click();
    assert.match(await selector.textContent(), /Automatic/);
    await document.getByRole("button", { name: "Close document", exact: true }).click();

    for (const [name, mode] of [["vhost.conf", "Nginx"], ["example.com", "Plain text"]]) {
      await list.getByRole("option", { name: new RegExp("^" + name.replace(".", "\\.")) }).click();
      await list.press("F3");
      const local = page.getByRole("region", { name, exact: true });
      await local.getByText(`Automatic (${mode})`, { exact: true }).waitFor();
      if (mode === "Plain text") {
        await local.getByRole("button", { name: "Syntax", exact: true }).click();
        await search.fill("Nginx");
        await search.press("Enter");
      }
      await local.locator(".syntax-keyword").filter({ hasText: /^server$/ }).waitFor();
      await local.getByRole("button", { name: "Close document", exact: true }).click();
    }

    const right = page.getByRole("listbox", { name: "right files", exact: true });
    await right.press("Alt+F2");
    await page.locator("#right-pane .location-popup").getByRole("button", { name: "SSH", exact: true }).click();
    await right.getByRole("option", { name: /^SSH fixture/ }).click();
    await right.press("Enter");
    await right.getByRole("option", { name: /^example\.com/ }).click();
    await right.press("F3");
    const site = page.getByRole("region", { name: "example.com", exact: true });
    for (const action of ["View", "Edit"]) {
      if (action === "Edit") await site.press("F6");
      await site.getByLabel(`${action} example.com`, { exact: true }).waitFor();
      await site.getByText("Automatic (Nginx)", { exact: true }).waitFor();
      await site.locator(".syntax-comment").filter({ hasText: /^# HTTPS$/ }).waitFor();
      assert.deepEqual(await site.locator(".syntax-keyword").allTextContents(), ["server", "listen", "return", "add_header"]);
      assert.deepEqual(await site.locator(".syntax-number").allTextContents(), ["443", "301"]);
      assert.equal((await site.locator(".syntax-property").allTextContents()).join(""), "$host$request_uri${host}");
      assert.deepEqual(await site.locator(".syntax-string").allTextContents(), ['"site: ', '#1"']);
    }
    await site.getByRole("button", { name: "Close document", exact: true }).click();
    console.log("Verified automatic Nginx highlighting in the SFTP viewer and editor.");
    console.log("Verified searchable syntax selection, ranked aliases and extensions, focus restoration, and preserved editor drafts.");
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testSyntaxMenu();
