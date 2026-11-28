import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { editPaneAddress } from "./pane-address-smoke.mjs";

const browser = await chromium.launch({ channel: "chrome" });
const button = (scope, name) => scope.getByRole("button", { name, exact: true });
try {
  for (const platform of ["Windows NT 10.0", "X11; Linux x86_64"]) {
    const page = await browser.newPage({ viewport: { width: 1150, height: 800 }, locale: "en-US", userAgent: `Mozilla/5.0 (${platform})` });
    page.setDefaultTimeout(8000);
    await page.route("http://dirlume.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
    });
    await page.addInitScript(() => {
      const windows = navigator.userAgent.includes("Windows");
      const root = windows ? "C:\\workspace ł" : "/workspace ł";
      const other = windows ? "C:\\other" : "/other";
      const head = "a".repeat(40);
      const entry = (name, directory = false) => ({ name, directory, link: false, hidden: false, size: 12, modified: null });
      const change = (group, status, path, previousPath = null) => ({ group, status, path, previousPath });
      const note = "note ł.txt";
      const changes = [change("staged", "M", note), change("unstaged", "M", note), change("untracked", "?", "fresh.txt"),
        change("unstaged", "D", "folder/deleted.txt"), change("staged", "A", "added.txt"),
        change("staged", "R", "renamed.txt", "before.txt"), change("unstaged", "U", "conflict.txt")];
      const content = (text) => ({ state: "available", text });
      const entries = [entry(note), entry("folder", true), ...["ignored.txt", "fresh.txt", "added.txt", "renamed.txt", "conflict.txt"].map((name) => entry(name))];
      window.fixture = { root, other, lastRead: null, fail: false, delay: false };
      const initialStatus = new Promise((resolve) => { window.fixture.releaseInitial = resolve; });
      if (sessionStorage.getItem("git-pane-status-loaded")) window.fixture.releaseInitial();
      sessionStorage.setItem("git-pane-status-loaded", "yes");
      window.__TAURI_INTERNALS__ = { transformCallback: () => 1, invoke: async (command, args) => {
        switch (command) {
          case "locations": return [{ label: "Home", path: root }, { label: "Downloads", path: other }];
          case "list_directory": return { path: args.path, parent: null, entries, omitted: 0 };
          case "file_icons": return args.items.map(() => null);
          case "ssh_profiles": return [{ id: "ssh", label: "Linux fixture", host: "fixture", port: 22 }];
          case "ftp_profiles": return [];
          case "connect_ssh": return { kind: "connected", id: 37, address: "Linux fixture", origin: "sftp://fixture",
            segments: ["remote"], listing: { entries: [entry(note)], omitted: 0, elevated: false } };
          case "list_ssh": return { entries: [entry(note)], omitted: 0, elevated: false };
          case "git_pane_status": {
            await initialStatus;
            const ssh = args.source.kind === "ssh";
            if (ssh && window.fixture.fail) throw "unreadable";
            if (!ssh && args.source.directory !== root) throw "notRepository";
            if (!ssh && window.fixture.delay) await new Promise((resolve) => { window.fixture.release = resolve; });
            return { root: ssh ? "/remote" : root, prefix: "", headRef: ssh ? "refs/heads/remote-topic" : "refs/heads/local-main",
              head: window.fixture.unborn ? null : head, metadata: null, changes };
          }
          case "git_pane_read": {
            const { source, root: readRoot, request } = args;
            window.fixture.lastRead = args;
            if (readRoot !== (source.kind === "ssh" ? "/remote" : root)) throw "wrong root";
            if (request.kind === "diff") return changes.filter(({ path }) => path === request.path).map((change) => ({ change,
              versions: change.group === "staged" ? { left: content("Committed line"), right: content("Staged line") } :
                { left: content("Staged line"), right: content("Working line") } }));
            if (request.kind === "compare") return { left: content("Committed line"), right: content("Working line") };
            if (request.kind === "history") return { commits: [{ hash: head, shortHash: "aaaaaaa", subject: "Initial file",
              author: "Fixture Author", date: "2026-11-28T01:00:00Z", parent: null, merge: false,
              change: { path: request.path, previousPath: null, status: "A" } }], nextOffset: null };
            if (request.kind === "revision") return content("Committed line");
            return null;
          }
          default: return null;
        }
      } };
    });
    await page.goto("http://dirlume.test/");
    const left = page.locator("#left-pane");
    const right = page.locator("#right-pane");
    const leftFiles = page.locator("#left-files");
    const rightFiles = page.locator("#right-files");
    await leftFiles.getByRole("option", { name: /^note ł\.txt/ }).waitFor();
    const before = await leftFiles.boundingBox();
    await page.evaluate(() => window.fixture.releaseInitial());
    await left.getByText("local-main", { exact: true }).waitFor();
    const after = await leftFiles.boundingBox();
    assert.deepEqual([after.y, after.height], [before.y, before.height]);
    const note = leftFiles.getByRole("option", { name: /note ł\.txt.*Staged: Modified.*Unstaged: Modified/ });
    const marker = note.getByRole("button", { name: /Staged: Modified/ });
    assert.deepEqual(await marker.locator("span").allTextContents(), ["SM", "WM"]);
    assert.equal(await marker.evaluate((button) => button.scrollWidth <= button.clientWidth), true);
    await leftFiles.getByRole("option", { name: /folder.*Changes in this folder/ }).waitFor();
    for (const [name, status] of [["fresh", "Untracked"], ["added", "Staged: Added"], ["renamed", "Staged: Renamed"], ["conflict", "Unstaged: Conflict"]]) {
      await leftFiles.getByRole("option", { name: new RegExp(`^${name}\\.txt.*${status}`) }).waitFor();
    }
    assert.equal(await leftFiles.getByRole("option", { name: /ignored.*Untracked/ }).count(), 0);
    await button(right, "Locations for right pane").click();
    await button(right, "NetBox").click();
    await rightFiles.getByRole("option", { name: /^Linux fixture/ }).dblclick();
    await right.getByText("remote-topic", { exact: true }).waitFor();
    await left.getByText("local-main", { exact: true }).waitFor();
    const menu = page.getByRole("menu", { name: "File actions", exact: true });
    const action = (name) => menu.getByRole("menuitem", { name, exact: true });
    await marker.click();
    await action("Show diff").click();
    const diff = page.getByRole("dialog", { name: "Show diff", exact: true });
    await diff.locator(".diff-text").filter({ hasText: "Staged line" }).waitFor();
    await diff.getByRole("combobox", { name: "Change to compare" }).selectOption("unstaged");
    await diff.locator(".diff-text").filter({ hasText: "Working line" }).waitFor();
    await button(diff, "Options").click();
    await diff.getByRole("combobox", { name: "Layout", exact: true }).selectOption("unified");
    assert.equal(await diff.getByLabel("File differences", { exact: true }).getAttribute("data-layout"), "unified");
    await button(diff, "Close").click();
    await page.waitForFunction(() => document.activeElement?.id === "left-files");
    const remoteNote = rightFiles.getByRole("option", { name: /^note ł\.txt/ });
    await remoteNote.click({ button: "right" });
    await action("Compare with HEAD").click();
    const compare = page.getByRole("dialog", { name: "Compare with HEAD" });
    await compare.getByLabel("File differences", { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.fixture.lastRead.source), { kind: "ssh", id: 37, segments: ["remote"] });
    await button(compare, "Close").click();
    await remoteNote.click({ button: "right" });
    await action("Show history").click();
    const history = page.getByRole("dialog", { name: "File history" });
    await history.getByRole("option", { name: /Initial file/ }).waitFor({ state: "attached" });
    await history.getByLabel("File differences", { exact: true }).waitFor();
    await button(history, "Close").click();
    await page.waitForFunction(() => document.activeElement?.id === "right-files");
    await page.evaluate(() => { window.fixture.fail = true; });
    await button(right, "Refresh folder").click();
    await right.getByText("Git status unavailable", { exact: true }).waitFor();
    await remoteNote.waitFor();
    await page.evaluate(() => { window.fixture.delay = true; });
    await button(left, "Refresh folder").click();
    await page.waitForFunction(() => !!window.fixture.release);
    const other = await page.evaluate(() => window.fixture.other);
    const address = await editPaneAddress(page, "left");
    await address.fill(other);
    await address.press("Enter");
    await left.getByText("local-main", { exact: true }).waitFor({ state: "hidden" });
    await page.evaluate(() => window.fixture.release());
    await leftFiles.getByRole("option", { name: /^note ł\.txt(?!.*Modified)/ }).waitFor();
    await page.evaluate(() => { window.fixture.delay = false; window.fixture.unborn = true; });
    const original = await page.evaluate(() => window.fixture.root);
    const rootAddress = await editPaneAddress(page, "left");
    await rootAddress.fill(original);
    await rootAddress.press("Enter");
    await left.getByText("local-main · No commits yet", { exact: true }).waitFor();
    await note.waitFor();
    await note.click({ button: "right" });
    await action("Compare with HEAD").click();
    await compare.getByText("This repository has no commits yet.", { exact: true }).waitFor();
    await button(compare, "Close").click();
    await left.locator(".file-columns .col-git").click({ button: "right" });
    await page.getByRole("menuitemcheckbox", { name: "Git", exact: true }).click();
    await left.locator(".file-columns .col-git").waitFor({ state: "hidden" });
    await page.reload();
    await left.getByText("local-main", { exact: true }).waitFor();
    assert.equal(await left.locator(".file-columns .col-git").count(), 0);
    await page.close();
  }
  console.log("Verified distinct local and SSH Git pane statuses, comparison layout, history, and browsing when SSH exec is unavailable.");
} finally {
  await browser.close();
}
