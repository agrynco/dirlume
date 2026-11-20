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
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args) => {
          switch (command) {
            case "locations": return [{ label: "Home", path: home }];
            case "list_directory": return { path: home, parent: null, entries: [], omitted: 0 };
            case "file_icons": return args.items.map(() => null);
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
      await connection.getByLabel("SMB server or share").fill(path);
      await connection.getByRole("button", { name: "Connect", exact: true }).click();
      await connection.waitFor({ state: "hidden" });
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
    const documentAddress = page.locator(".text-window:not([hidden]) .text-toolbar > span");
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
    assert.deepEqual(errors, []);
    console.log("SMB navigation smoke passed.");
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await testSmbNavigation();
