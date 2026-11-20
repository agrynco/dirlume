import assert from "node:assert/strict";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright-core";

export async function testSmbNavigation() {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error));
    const root = "\\\\192.0.2.10";
    const documents = root + "\\documents";
    const projects = root + "\\projects";
    await page.route("http://dirlume.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    await page.addInitScript(({ root, documents, projects }) => {
      const home = "C:\\test";
      const file = { name: "notes #1.txt", directory: false, link: false, hidden: false, size: 7, modified: null };
      let authorized = false;
      let sshProfile;
      const sshVerification = { host: "fixture.example", port: 22, fingerprint: "SHA256:fixture" };
      const sshListing = { entries: [{ ...file, name: "ssh-notes.txt" }], omitted: 0 };
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args) => {
          switch (command) {
            case "locations": return [{ label: "Home", path: home }];
            case "list_directory": return { path: home, parent: null, entries: [], omitted: 0 };
            case "file_icons": return args.items.map(() => null);
            case "ssh_profiles": return sshProfile ? [sshProfile] : [];
            case "save_ssh_profile": {
              const { secret, clearSecret: _clearSecret, ...fields } = args.input;
              sshProfile = { ...fields, id: "ssh-fixture", hasSecret: Boolean(secret || sshProfile?.hasSecret) };
              return sshProfile;
            }
            case "connect_ssh":
              if (args.id !== sshProfile?.id) throw new Error("Unknown SSH profile");
              if (!args.approval) return { kind: "verifyHost", verification: sshVerification };
              if (args.approval.fingerprint !== sshVerification.fingerprint) throw new Error("Unapproved SSH host key");
              return { kind: "connected", id: 17, address: sshVerification.host, origin: "sftp://fixture.example",
                segments: ["home"], listing: sshListing };
            case "list_ssh": return { ...sshListing, elevated: false };
            case "open_terminal": return false;
            case "read_text":
              if (args.directory !== documents || args.name !== file.name) throw new Error("Unexpected SMB file");
              return { text: "Fixture", encoding: "utf8" };
            case "connect_smb":
              if (args.path === root || args.path === root.slice(2)) {
                return { kind: "shares", server: root, names: ["documents", "projects"], warning: null };
              }
              if (args.path !== documents && args.path !== projects) throw new Error("Unexpected SMB path");
              if (args.path === projects && !authorized) {
                if (!args.credentials) return { kind: "credentials_required", error: null };
                if (args.credentials.username !== "smb-user") throw new Error("Unexpected SMB username");
                authorized = true;
              }
              return { kind: "opened", listing: { path: args.path, parent: null, entries: [file], omitted: 0 }, warning: null };
            default: return null;
          }
        },
      };
    }, { root, documents, projects });
    await page.goto("http://dirlume.test/");

    const pane = (side) => page.getByRole("region", { name: side + " pane", exact: true });
    const fileList = (side) => pane(side).getByRole("listbox", { name: side + " files", exact: true });
    const pathIs = (side, path) => page.waitForFunction(({ side, path }) =>
      document.getElementById(side + "-path")?.dataset.path === path, { side, path });
    const connection = page.getByRole("dialog", { name: "Connect to SMB", exact: true });
    const connect = async (side, path) => {
      await pane(side).getByRole("button", { name: "Locations for " + side + " pane", exact: true }).click();
      await pane(side).getByRole("button", { name: "SMB", exact: true }).click();
      await pathIs(side, "SMB");
      const files = fileList(side);
      await files.press("Shift+F4");
      const form = page.getByRole("dialog", { name: "Add SMB connection", exact: true });
      await form.getByLabel("Connection name").fill(side + " SMB");
      await form.getByLabel("SMB server or share").fill(path);
      await form.getByRole("button", { name: "Save connection", exact: true }).click();
      await files.getByRole("option", { name: new RegExp("^" + side + " SMB") }).click();
      await files.press("F4");
      const edit = page.getByRole("dialog", { name: "Edit SMB connection", exact: true });
      assert.equal(await edit.getByLabel("SMB server or share").inputValue(), path.startsWith("\\\\") ? path : "\\\\" + path);
      await edit.getByLabel("Connection name").fill(side + " SMB edited");
      await edit.getByRole("button", { name: "Save connection", exact: true }).click();
      await files.getByRole("option", { name: new RegExp("^" + side + " SMB edited") }).click();
      await files.press("Enter");
    };

    await pathIs("left", "C:\\test");
    await connect("left", root.slice(2));
    await pathIs("left", root);
    const left = fileList("left");
    const share = (name) => left.getByRole("option", { name: new RegExp("^" + name) });
    await share("documents").waitFor();
    await share("projects").waitFor();
    assert.equal(await pane("left").getByRole("button", { name: "Parent folder" }).isDisabled(), true);
    await share("documents").dblclick();
    await pathIs("left", documents);
    await share("notes #1.txt").click();
    await page.keyboard.press("F3");
    const documentAddress = page.locator(".text-window:not([hidden]) .document-heading h2");
    await documentAddress.waitFor();
    assert.equal(await documentAddress.textContent(), "smb://192.0.2.10/documents/notes%20%231.txt");
    await page.keyboard.press("Escape");
    await left.getByRole("option", { name: /^\.\./ }).dblclick();
    await pathIs("left", root);

    await share("projects").dblclick();
    await connection.getByLabel("Username").fill("smb-user");
    // Keep the credential prompt open across a background refresh interval.
    await setTimeout(5200);
    await connection.getByRole("button", { name: "Connect", exact: true }).click();
    await pathIs("left", projects);
    await pane("left").getByRole("button", { name: "Back", exact: true }).click();
    await pathIs("left", root);
    await pane("left").getByRole("button", { name: "Forward", exact: true }).click();
    await pathIs("left", projects);

    await connect("right", documents);
    await pathIs("right", documents);
    await pane("right").getByRole("button", { name: "Parent folder", exact: true }).click();
    await pathIs("right", root);

    async function openSsh(side) {
      await pane(side).getByRole("button", { name: "Locations for " + side + " pane", exact: true }).click();
      await pane(side).getByRole("button", { name: "SSH", exact: true }).click();
      await pathIs(side, "SSH");
    }
    const right = fileList("right");
    await openSsh("right");
    assert.deepEqual(await right.locator(".file-name-text").allTextContents(), [".."]);
    await right.getByRole("option", { name: /^\.\./ }).dblclick();
    await pathIs("right", root);
    await openSsh("right");
    await right.press("Shift+F4");
    const addSsh = page.getByRole("dialog", { name: "Add SSH connection", exact: true });
    await addSsh.getByLabel("Connection name").fill("SSH fixture");
    await addSsh.getByLabel("Server", { exact: true }).fill("fixture.example");
    await addSsh.getByLabel("Username").fill("fixture");
    await addSsh.getByLabel("Password", { exact: true }).fill("fixture-password");
    await addSsh.getByRole("button", { name: "Save connection", exact: true }).click();
    await right.getByRole("option", { name: /^SSH fixture/ }).click();
    await right.press("F4");
    const editSsh = page.getByRole("dialog", { name: "Edit SSH connection", exact: true });
    assert.equal(await editSsh.getByLabel("Server", { exact: true }).inputValue(), "fixture.example");
    await editSsh.getByLabel("Connection name").fill("Edited SSH");
    await editSsh.getByRole("button", { name: "Save connection", exact: true }).click();
    await right.getByRole("option", { name: /^Edited SSH/ }).click();
    await right.press("Enter");
    const verify = page.getByRole("dialog", { name: "Verify SSH server", exact: true });
    await verify.getByText("SHA256:fixture", { exact: true }).waitFor();
    await verify.getByRole("button", { name: "Trust and connect", exact: true }).click();
    await pathIs("right", "/home");
    await right.getByRole("option", { name: /^ssh-notes/ }).waitFor();
    await right.press("F12");
    const sshTerminal = page.locator(".terminal-card").filter({ has: page.getByRole("heading", { name: "SSH terminal", exact: true }) });
    const terminalHint = page.locator(".statusbar").getByText("File shortcuts paused. Click a file pane to use them.", { exact: true });
    await sshTerminal.waitFor();
    await terminalHint.waitFor();
    await right.focus();
    await terminalHint.waitFor({ state: "hidden" });
    assert.equal(await sshTerminal.isVisible(), true);
    await sshTerminal.locator(".xterm-helper-textarea").focus();
    await terminalHint.waitFor();
    await sshTerminal.getByRole("button", { name: "Close terminal", exact: true }).click();
    await terminalHint.waitFor({ state: "hidden" });
    await pathIs("left", projects);
    assert.deepEqual(errors, []);
    console.log("Verified saved SMB and SSH connections, edit forms, parent navigation, and authentication.");
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testSmbNavigation();
