import { closeToolWindow, openToolWindow } from "./tool-window-smoke.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename as renamePath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { close, port } from "./server-smoke.mjs";

const server = [
  "from pyftpdlib.authorizers import DummyAuthorizer",
  "from pyftpdlib.handlers import FTPHandler",
  "from pyftpdlib.filesystems import AbstractedFS",
  "from pyftpdlib.servers import FTPServer",
  "import logging, os, sys",
  "class FixtureFS(AbstractedFS):",
  "    def rename(self, source, target):",
  "        os.replace(source, target)",
  "class Handler(FTPHandler):",
  "    abstracted_fs = FixtureFS",
  "    def on_login(self, username):",
  "        self.fs.cwd = '/start'",
  "        print('LOGIN', flush=True)",
  "    def ftp_RETR(self, path):",
  "        print('RETR ' + os.path.basename(path), flush=True)",
  "        print('RETR-SESSION ' + str(self.remote_port), flush=True)",
  "        return super().ftp_RETR(path)",
  "    def ftp_MLSD(self, path):",
  "        print('LIST ' + str(self.remote_port), flush=True)",
  "        return super().ftp_MLSD(path)",
  "    def ftp_LIST(self, path):",
  "        print('LIST ' + str(self.remote_port), flush=True)",
  "        return super().ftp_LIST(path)",
  "    def on_file_sent(self, path):",
  "        if os.path.basename(path) == 'change-during-download.txt':",
  "            with open(path, 'ab') as file: file.write(b' changed')",
  "logging.disable(logging.CRITICAL)",
  "auth = DummyAuthorizer()",
  "auth.add_user('dirlume', os.environ['DIRLUME_FIXTURE_PASSWORD'], sys.argv[1], perm='elradfmw')",
  "Handler.authorizer = auth",
  "if os.environ.get('DIRLUME_FTP_LEGACY'):",
  "    Handler.encoding = 'cp1251'",
  "    Handler.ftp_MLSD = lambda self, path: self.respond('502 MLSD is unavailable.')",
  "ftp = FTPServer(('127.0.0.1', int(sys.argv[2])), Handler)",
  "print('READY', flush=True)",
  "ftp.serve_forever()",
].join("\n");

export async function testFtp(page, temp, source, destination, config, restartDesktop) {
  const root = join(temp, "ftp");
  const remoteFolder = join(root, "start");
  const localFolder = join(source, "ftp-copy");
  const remoteCopy = join(remoteFolder, "ftp-copy");
  const downloadedFolder = join(destination, "ftp-copy");
  const lastFolder = join(remoteFolder, "saved-folder");
  const password = randomUUID();
  await mkdir(localFolder);
  await mkdir(remoteCopy, { recursive: true });
  await mkdir(downloadedFolder);
  await mkdir(lastFolder);
  const searchRoot = join(remoteFolder, "search-fixture");
  const nestedSearch = join(searchRoot, "branch", "nested");
  await mkdir(nestedSearch, { recursive: true });
  await writeFile(join(searchRoot, "root.find.txt"), "");
  await writeFile(join(searchRoot, ".hidden.find.txt"), "");
  await writeFile(join(searchRoot, "unrelated.txt"), "");
  await writeFile(join(searchRoot, "branch", "middle.find.txt"), "");
  await writeFile(join(nestedSearch, "deep.FIND.TXT"), "");
  for (const count of [100, 1000]) {
    const bulk = join(remoteFolder, "bulk-" + count);
    await mkdir(bulk);
    for (let start = 0; start < count; start += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, offset) => writeFile(join(bulk, `file-${start + offset}.txt`), "fixture")));
    }
  }
  const unstable = join(remoteFolder, "unstable");
  await mkdir(unstable);
  await writeFile(join(unstable, "change-during-download.txt"), "initial");
  await writeFile(join(localFolder, "existing.txt"), "local upload");
  await writeFile(join(localFolder, "файл.txt"), "Unicode name");
  await writeFile(join(remoteCopy, "existing.txt"), "remote original");
  await writeFile(join(downloadedFolder, "existing.txt"), "local original");
  await writeFile(join(remoteFolder, "guide.md"), "# FTP Markdown\n\n- [ ] FTP task\n\n[Remote details](saved-folder/details.md)\n");
  await writeFile(join(remoteFolder, "bytes.bin"), Buffer.alloc(2050, 0x42));
  await writeFile(join(lastFolder, "restored.txt"), "Restored FTP folder");
  await writeFile(join(lastFolder, "details.md"), "# Remote details\n");
  const ftpPort = await port();
  const child = spawn(process.env.DIRLUME_FTP_PYTHON, ["-u", "-c", server, root, String(ftpPort)], {
    windowsHide: true, env: { ...process.env, DIRLUME_FIXTURE_PASSWORD: password, PYTHONIOENCODING: "utf-8" },
  });
  let ftpLog = "";
  child.stdout.setEncoding("utf8").on("data", (data) => { ftpLog += data; });
  const retrieves = () => ftpLog.split(/\r?\n/).filter((line) => line.startsWith("RETR "));
  const logins = () => (ftpLog.match(/^LOGIN$/gm) ?? []).length;
  const profiles = join(config, "ftp-profiles.json");
  const rightPane = page.getByRole("region", { name: "right pane" });
  const right = rightPane.getByRole("listbox", { name: "right files" });
  const left = page.getByRole("listbox", { name: "left files" });
  const connections = page.getByRole("dialog", { name: "FTP and SFTP connections", exact: true });
  const remoteRow = (text) => right.getByRole("option", { name: new RegExp("^" + text) });
  const button = (scope, name) => scope.getByRole("button", { name, exact: true });
  const remotePath = page.getByLabel("right path", { exact: true });
  const copy = page.getByRole("dialog", { name: "Copy", exact: true });
  const complete = page.getByRole("dialog", { name: "Transfer complete" });
  async function transferred(timeout = 8000) {
    await page.locator("dialog[open]").first().waitFor({ state: "hidden", timeout });
    await page.locator(".statusbar").getByText("Transfer complete", { exact: true }).waitFor();
  }

  try {
    await new Promise((ready, fail) => {
      child.once("error", fail);
      child.once("exit", (code) => fail(new Error("FTP fixture exited with code " + code)));
      child.stdout.once("data", (data) => {
        if (data.toString().includes("READY")) ready();
        else fail(new Error("FTP fixture did not report readiness."));
      });
      child.stderr.once("data", (data) => fail(new Error(data.toString())));
    });
    await right.focus();
    await page.keyboard.press("Alt+F2");
    await button(rightPane, "FTP").waitFor();
    await page.keyboard.press("2");
    await connections.getByText("No saved FTP or SFTP connections.", { exact: true }).waitFor();
    await page.keyboard.press("Shift+F4");
    const add = page.getByRole("dialog", { name: "Add FTP connection" });
    await add.getByLabel("Connection name").fill("Local FTP fixture");
    await add.getByLabel("Protocol", { exact: true }).selectOption("sftp");
    const sftp = page.getByRole("dialog", { name: "Add SFTP connection", exact: true });
    assert.equal(await sftp.getByLabel("Port", { exact: true }).inputValue(), "22");
    assert.equal(await sftp.getByLabel("Connection name").inputValue(), "Local FTP fixture");
    await sftp.getByLabel("Protocol", { exact: true }).selectOption("ftp");
    assert.equal(await add.getByLabel("Port", { exact: true }).inputValue(), "21");
    await add.getByLabel("Server", { exact: true }).fill("127.0.0.1");
    await add.getByLabel("Port").fill(String(ftpPort));
    await add.getByLabel("Username").fill("dirlume");
    await add.getByLabel("Password", { exact: true }).fill(password);
    if (process.env.DIRLUME_FTP_LEGACY) await add.getByLabel("Filename code page").fill("1251");
    await button(add, "Save connection").click();
    const saved = connections.getByRole("listbox", { name: "Saved connections" });
    await saved.waitFor();
    const stored = await readFile(profiles, "utf8");
    assert.ok(!stored.includes(password));
    assert.ok(JSON.parse(stored)[0].credential);
    await saved.press("F4");
    const edit = page.getByRole("dialog", { name: "Edit FTP connection" });
    assert.equal(await edit.getByLabel("Password", { exact: true }).inputValue(), "");
    await edit.getByLabel("Connection name").fill("Saved FTP fixture");
    await button(edit, "Save connection").click();
    await saved.getByRole("option", { name: /^Saved FTP fixture/ }).waitFor({ state: "attached" });
    await saved.press("Enter");
    await remoteRow("guide.md").waitFor();
    assert.equal(await page.locator("#right-path").getAttribute("data-path"), "/start");
    const parentRow = right.getByRole("option", { name: /^\.\./ });
    await parentRow.click();
    await page.keyboard.press("Shift+ArrowDown");
    assert.equal(await right.locator(".file-row.marked").count(), 1);
    assert.equal(await parentRow.getAttribute("aria-selected"), "false");
    await page.keyboard.press("Shift+ArrowUp");
    assert.equal(await right.locator(".file-row.marked").count(), 0);
    await parentRow.dblclick();
    await right.getByRole("option", { name: /^start/ }).waitFor();
    assert.equal(await page.locator("#right-path").getAttribute("data-path"), "/");
    await right.getByRole("option", { name: /^start/ }).dblclick();

    await remoteRow("search-fixture").dblclick();
    await remoteRow("root.find.txt").waitFor();
    const beforeSearch = logins();
    await page.keyboard.press("Alt+F7");
    const search = page.getByRole("dialog", { name: "Find files", exact: true });
    await search.getByLabel("File mask").fill("*.find.txt");
    const searchStart = performance.now();
    await button(search, "Search").click();
    const matches = search.getByRole("listbox", { name: "Search results", exact: true });
    await matches.getByRole("option", { name: "root.find.txt", exact: true }).waitFor();
    const firstMatch = performance.now() - searchStart;
    await search.getByRole("status").filter({ hasText: "3 matches." }).waitFor();
    const totalSearch = performance.now() - searchStart;
    assert.deepEqual((await matches.getByRole("option").allTextContents()).sort(),
      ["branch/middle.find.txt", "branch/nested/deep.FIND.TXT", "root.find.txt"]);
    assert.equal(logins() - beforeSearch, 1, "One FTP login for the entire recursive search.");
    await button(search, "Close").click();
    await right.getByRole("option", { name: /^\.\./ }).dblclick();
    console.log(`FTP search used one login across three folders. First match ${Math.round(firstMatch)} ms, total ${Math.round(totalSearch)} ms.`);

    await remoteRow("guide.md").dblclick();
    await page.getByRole("heading", { name: "FTP Markdown", exact: true }).waitFor();
    await page.getByRole("checkbox", { name: "FTP task", exact: true }).click();
    await page.getByRole("checkbox", { name: "FTP task", exact: true, checked: true }).waitFor();
    assert.match(await readFile(join(remoteFolder, "guide.md"), "utf8"), /- \[x\] FTP task/);
    await page.getByRole("link", { name: "Remote details", exact: true }).click({ modifiers: ["Control"] });
    await page.getByRole("heading", { name: "Remote details", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("heading", { name: "FTP Markdown", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await remoteRow("bytes.bin").click();
    await page.keyboard.press("F3");
    await page.keyboard.press("F4");
    const hex = page.getByLabel("Hexadecimal contents", { exact: true });
    await hex.waitFor();
    assert.match(await hex.innerText(), /42 42 42/);
    await button(page, "Next page").click();
    await page.waitForFunction(() => document.querySelector(".hex-view")?.textContent.includes("000000000400"));
    await page.keyboard.press("Escape");
    await remoteRow("guide.md").click();
    await page.keyboard.press("F4");
    const editor = page.getByRole("textbox", { name: "Edit guide.md", exact: true });
    await editor.fill("# Edited on FTP\n");
    await page.keyboard.press("F2");
    await page.waitForFunction(() => {
      const active = document.querySelector(".text-window:not([hidden])");
      return active?.querySelector("[role=alert]") || active?.querySelector(".document-encoding")?.textContent.trim() === "UTF8";
    });
    const saveError = page.locator(".text-window:not([hidden])").getByRole("alert");
    if (await saveError.count()) throw new Error(await saveError.innerText());
    assert.equal(await readFile(join(remoteFolder, "guide.md"), "utf8"), "# Edited on FTP\n");
    await writeFile(join(remoteFolder, "guide.md"), "# Changed externally\n");
    await editor.fill("# Unsaved changes\n");
    await page.keyboard.press("F2");
    await page.getByText(/FTP file changed on the server/).waitFor();
    assert.equal(await readFile(join(remoteFolder, "guide.md"), "utf8"), "# Changed externally\n");
    await page.keyboard.press("Escape");
    await button(page.getByRole("dialog", { name: "Unsaved changes" }), "Discard changes").click();

    await left.getByRole("option", { name: /^ftp-copy/ }).click();
    await page.keyboard.press("F5");
    const uploadPath = copy.getByRole("combobox", { name: "Destination", exact: true });
    assert.equal(await uploadPath.inputValue(), "/start");
    assert.equal(await button(copy, "Browse for a folder").count(), 0);
    await uploadPath.fill("/start/sav");
    const uploadMatches = copy.getByRole("listbox", { name: "Destination suggestions", exact: true });
    await uploadMatches.getByRole("option", { name: "saved-folder", exact: true }).click();
    assert.equal(await uploadPath.inputValue(), "/start/saved-folder");
    await uploadPath.fill("/start");
    await button(copy, "Copy").click();
    await button(page.getByRole("dialog", { name: "Folder already exists" }), "Overwrite").click();
    await button(page.getByRole("dialog", { name: "File already exists" }), "Overwrite").click();
    await transferred();
    assert.equal(await readFile(join(remoteCopy, "existing.txt"), "utf8"), "local upload");
    assert.equal(await readFile(join(remoteCopy, "файл.txt"), "utf8"), "Unicode name");

    await remoteRow("ftp-copy").click();
    await page.keyboard.press("F3");
    await remoteRow("ftp-copy").getByText("24 B", { exact: true }).waitFor();
    const beforeMerge = retrieves().length;
    await page.keyboard.press("F5");
    await copy.getByLabel("Destination", { exact: true }).fill(destination);
    await button(copy, "Copy").click();
    await button(page.getByRole("dialog", { name: "Folder already exists" }), "Overwrite").click();
    await button(page.getByRole("dialog", { name: "File already exists" }), "Skip").click();
    await complete.getByText("0 completed, 1 skipped.", { exact: true }).waitFor();
    await button(complete, "Done").click();
    assert.equal(await readFile(join(downloadedFolder, "existing.txt"), "utf8"), "local original");
    assert.equal(await readFile(join(downloadedFolder, "файл.txt"), "utf8"), "Unicode name");
    assert.deepEqual(retrieves().slice(beforeMerge), ["RETR файл.txt"]);

    const beforeSkip = retrieves().length;
    const existingLocal = join(destination, "bytes.bin");
    await writeFile(existingLocal, "keep this");
    await remoteRow("bytes.bin").click();
    await page.keyboard.press("F5");
    await copy.getByLabel("Destination", { exact: true }).fill(destination);
    await copy.locator("label").filter({ hasText: "Existing files" }).locator("select").selectOption("skip");
    await button(copy, "Copy").click();
    await complete.getByText("0 completed, 1 skipped.", { exact: true }).waitFor();
    await button(complete, "Done").click();
    assert.equal(await readFile(existingLocal, "utf8"), "keep this");
    assert.equal(retrieves().length, beforeSkip);

    for (const count of [100, 1000]) {
      const folder = "bulk-" + count;
      await remoteRow(folder + "\\b").click();
      await page.keyboard.press("F5");
      await copy.getByLabel("Destination", { exact: true }).fill(destination);
      const before = ftpLog.length;
      await button(copy, "Copy").click();
      await transferred(90_000);
      // Pane refreshes use other control connections and are not part of the download.
      const transferLog = ftpLog.slice(before);
      const transferSessions = new Set(Array.from(transferLog.matchAll(/^RETR-SESSION (\d+)\r?$/gm), ([, session]) => session));
      assert.ok(transferSessions.size > 0, "The fixture must observe download requests.");
      const commands = Array.from(transferLog.matchAll(/^LIST (\d+)\r?$/gm), ([, session]) => session)
        .filter((session) => transferSessions.has(session)).length;
      assert.ok(commands <= 5, `Expected at most five directory listings for ${count} files, got ${commands}.`);
      assert.equal((await readdir(join(destination, folder))).length, count);
      console.log(`FTP downloaded ${count} small files with ${commands} directory listings.`);
    }

    await remoteRow("unstable").click();
    await page.keyboard.press("F5");
    await copy.getByLabel("Destination", { exact: true }).fill(destination);
    await button(copy, "Copy").click();
    const changed = page.getByRole("alert").filter({ hasText: "The FTP file changed during the download." });
    await changed.waitFor();
    await assert.rejects(readdir(join(destination, "unstable")), { code: "ENOENT" });
    await button(changed.locator("xpath=ancestor::dialog"), "Done").click();

    await remoteRow("guide.md").click();
    await page.keyboard.press("F6");
    const rename = page.getByRole("dialog", { name: "Rename", exact: true });
    await rename.getByLabel("Name", { exact: true }).fill("renamed.md");
    await button(rename, "Rename").click();
    await remoteRow("renamed.md").waitFor();
    await left.getByRole("option", { name: /^notes.txt/ }).click();
    await remoteRow("renamed.md").click();
    const window = await openToolWindow(page, () => page.keyboard.press("Shift+F11"), "Compare files");
    const comparison = window.getByRole("dialog", { name: "Compare files", exact: true });
    await comparison.getByText("# Changed externally", { exact: true }).waitFor();
    await closeToolWindow(window);

    await remoteRow("renamed.md").click();
    await page.keyboard.press("F5");
    await copy.getByLabel("Destination", { exact: true }).fill("ftp-alias.md");
    await button(copy, "Copy").click();
    await transferred();
    assert.equal(await readFile(join(source, "ftp-alias.md"), "utf8"), "# Changed externally\n");

    await remoteRow("ftp-copy").click();
    await page.keyboard.press("F8");
    await button(page.getByRole("dialog", { name: "Delete permanently" }), "Delete permanently").click();
    const recursion = page.getByRole("dialog", { name: "Delete FTP folder contents" });
    await recursion.waitFor();
    assert.equal(await readFile(join(remoteCopy, "файл.txt"), "utf8"), "Unicode name");
    await button(recursion, "Delete contents").click();
    await remoteRow("ftp-copy").waitFor({ state: "detached" });
    await assert.rejects(readFile(join(remoteCopy, "файл.txt")), { code: "ENOENT" });
    console.log("Verified saved FTP credentials, navigation, viewing, editing, conflicts, bidirectional copy, rename, and recursive deletion.");

    await right.press("Control+l");
    await remotePath.fill("/start/sav");
    await rightPane.getByRole("listbox", { name: "right path suggestions", exact: true })
      .getByRole("option", { name: "saved-folder", exact: true }).click();
    await remoteRow("restored.txt").waitFor();
    await page.keyboard.press("Control+U");
    const savedLocation = { profileId: JSON.parse(stored)[0].id, segments: ["start", "saved-folder"] };
    const waitForSavedLocation = () => page.waitForFunction((expected) => {
      const workspace = JSON.parse(localStorage.getItem("dirlume.workspace.v1") ?? "{}");
      return JSON.stringify(workspace.panels?.left?.ftp) === JSON.stringify(expected) && !workspace.panels?.right?.ftp;
    }, savedLocation);
    const expectRestoredFolder = async () => {
      const panel = page.getByRole("region", { name: "left pane", exact: true });
      await panel.getByRole("option", { name: /^restored.txt/ }).waitFor();
      assert.equal(await panel.locator("#left-path").getAttribute("data-path"), "/start/saved-folder");
      assert.equal(await page.locator("#right-path").getAttribute("data-path"), source);
      await waitForSavedLocation();
    };
    await waitForSavedLocation();
    page = await restartDesktop();
    await expectRestoredFolder();

    const unavailable = lastFolder + "-unavailable";
    await renamePath(lastFolder, unavailable);
    page = await restartDesktop();
    await page.getByRole("region", { name: "left pane", exact: true })
      .getByRole("alert").filter({ hasText: "Could not restore the FTP folder." }).waitFor();
    assert.equal(await page.locator("#left-path").getAttribute("data-path"), destination);
    await waitForSavedLocation();
    await renamePath(unavailable, lastFolder);
    page = await restartDesktop();
    await expectRestoredFolder();
    console.log("Verified FTP recovery after restarting, including fallback when the saved folder is unavailable.");
  } finally {
    try {
      const records = await readFile(profiles, "utf8").then(JSON.parse, () => []);
      for (const { id } of records) {
        if (!page.isClosed()) {
          await page.evaluate((id) => window.__TAURI_INTERNALS__.invoke("remove_ftp_profile", { id }), id);
        }
      }
    } finally {
      await close(child);
    }
  }
}
