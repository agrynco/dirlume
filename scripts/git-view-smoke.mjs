import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { openMainMenu } from "./menu-header-smoke.mjs";

const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
  page.setDefaultTimeout(8000);
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  await page.addInitScript(() => {
    const windows = /Windows/i.test(navigator.userAgent);
    const root = windows ? "C:\\repo ł" : "/repo ł";
    const sub = root + (windows ? "\\nested" : "/nested");
    const file = { name: "note.txt", directory: false, link: false, hidden: false, size: 1, modified: null };
    const hash = (value) => value.repeat(40);
    const commit = (value, subject) => ({
      subject, hash: hash(value), shortHash: value.repeat(7), author: "Fixture Author", date: "2026-11-21T01:00:00Z",
    });
    window.gitEvents = [];
    let indexVersion = 0;
    let rows = [
      { group: "staged", status: "M", path: "note.txt", previousPath: null },
      { group: "unstaged", status: "M", path: "note.txt", previousPath: null },
      { group: "unstaged", status: "D", path: "removed.txt", previousPath: null },
      { group: "untracked", status: "?", path: "new ł.txt", previousPath: null },
    ];
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args = {}) => {
        switch (command) {
          case "locations": return [{ label: "Home", path: root }, { label: "Downloads", path: sub }];
          case "list_directory": return { path: args.path, parent: null, entries: [file], omitted: 0 };
          case "file_icons": return [null];
          case "git_repository":
            window.gitEvents.push(args.path);
            if (window.gitError) throw window.gitError;
            return { root, name: "repo ł", headRef: window.gitDetached ? null : "refs/heads/main",
              head: window.gitEmpty ? null : hash("a"),
              branches: window.gitEmpty || window.gitDetached ? [] : [
                { reference: "refs/heads/main", name: "main", tip: hash("a"), remote: false },
                { reference: "refs/heads/topic", name: "topic", tip: hash("b"), remote: false },
                { reference: "refs/remotes/origin/topic", name: "origin/topic", tip: hash("c"), remote: true },
              ] };
          case "git_history":
            if (args.tip === hash("b")) return new Promise((resolve) => {
              window.finishOldHistory = () => resolve({ commits: [commit("b", "Stale local topic")], nextOffset: null });
            });
            if (args.tip === hash("c")) return { commits: [commit("c", "Remote-tracking topic")], nextOffset: null };
            return { commits: args.offset ? [commit("d", "Old commit")] : [commit("a", "Merge feature")],
              nextOffset: args.offset ? null : 1 };
          case "git_details": return { message: "Merge feature\n\nFull commit body", merge: true, changes: [
            { status: "A", path: "new ł.txt" }, { status: "D", path: "removed.txt" },
          ] };
          case "git_index_state":
            assertRoot(args.root);
            if (window.workingError) throw "unreadable";
            return { snapshot: { headRef: window.gitDetached ? null : "refs/heads/main",
              head: window.gitEmpty ? null : hash("a"), index: String(indexVersion), gitDir: root + "/.git" },
            writeBlocked: false, submodules: [], changes: window.workingClean ? [] : rows };
          case "git_update_index": {
            assertRoot(args.root);
            if (args.expected.index !== String(indexVersion)) throw { kind: "stale" };
            const { path, group } = args.change;
            if (args.action === "stage" && rows.some((row) => row.path === path && row.group === "staged") && !args.replace) {
              throw { kind: "confirmReplacement" };
            }
            rows = rows.filter((row) => row.path !== path || (args.action === "unstage" && row.group !== "staged"));
            if (args.action === "stage") rows.unshift({ ...args.change, group: "staged" });
            else if (!rows.some((row) => row.path === path)) rows.unshift({ ...args.change, group: "unstaged" });
            indexVersion++;
            window.gitLastAction = { path, group, action: args.action };
            return null;
          }
          case "git_commit_changes":
            assertRoot(args.root);
            if (window.gitExternalChange || args.expected.index !== String(indexVersion)) {
              window.gitExternalChange = false;
              indexVersion++;
              throw { kind: "stale" };
            }
            window.gitCommitted = { message: args.message, ref: args.expected.headRef,
              paths: rows.filter((row) => row.group === "staged").map((row) => row.path).sort() };
            rows = rows.filter((row) => row.group !== "staged");
            indexVersion++;
            return "abcdef0";
          case "git_working_diff": {
            assertRoot(args.root);
            const { group, path } = args.change;
            const deleted = path === "removed.txt";
            return { workingPath: deleted ? null : root + (windows ? "\\" : "/") + path, workingText: !deleted,
              patch: deleted ? "-deleted\n" : "+" + (path === "note.txt" ? group === "unstaged" && window.gitSaved || group : path) + "\n",
              fallback: null, unborn: false };
          }
          case "read_text": return { text: window.gitSaved ?? "saved working text", encoding: "utf8" };
          case "save_text": window.gitSaved = args.text; return null;
          case "copy_path": window.gitCopied = args.path; return null;
          default: return null;
        }
      },
    };
    function assertRoot(path) {
      if (path !== root) throw "notRepository";
    }
  });
  await page.goto("http://dirlume.test/");
  const swapKey = await page.evaluate(() => /Mac/i.test(navigator.userAgent) ? "Meta+u" : "Control+u");
  const button = (scope, name) => scope.getByRole("button", { name, exact: true });
  const right = page.locator("#right-files");
  const git = button(page, "Git View");
  const branches = page.getByRole("region", { name: "Branches", exact: true });
  const history = page.getByRole("region", { name: "Commit history", exact: true });
  const merge = history.getByRole("button", { name: /Merge feature/ });
  await right.getByRole("option", { name: /^note\.txt/ }).click();
  const selected = await right.getAttribute("aria-activedescendant");
  await git.click();
  assert.equal(await branches.evaluate((node) => node.classList.contains("git-pane-right")), true);
  await branches.getByRole("option", { name: /main/, selected: true }).waitFor();
  assert.equal(await button(page, "Quick View").isDisabled(), true);
  await merge.click();
  await history.getByText("Changed paths relative to the first parent").waitFor();
  await history.getByText("new ł.txt").waitFor();
  await button(history, "Copy commit hash").click();
  assert.equal(await page.evaluate(() => window.gitCopied), "a".repeat(40));
  await button(history, "Load more").click();
  await history.getByRole("button", { name: /Old commit/ }).waitFor();
  const filter = branches.getByRole("searchbox", { name: "Filter branches" });
  await filter.fill("mai");
  await filter.press(swapKey);
  await branches.and(page.locator(".git-pane-left")).waitFor();
  assert.equal(await filter.inputValue(), "mai");
  assert.ok(await filter.evaluate((field) => document.activeElement === field));
  await history.getByText("Full commit body").waitFor();
  await history.getByRole("button", { name: /Old commit/ }).press(swapKey);
  await branches.and(page.locator(".git-pane-right")).waitFor();
  await button(page, "Swap panes").click();
  await branches.and(page.locator(".git-pane-left")).waitFor();
  const commands = await openMainMenu(page, "Commands");
  await commands.getByRole("menuitem", { name: "Swap panes", exact: true }).click();
  await branches.and(page.locator(".git-pane-right")).waitFor();
  assert.equal(await page.evaluate(() => window.gitEvents.length), 1);

  await filter.fill("topic");
  assert.equal(await branches.getByRole("option").count(), 2);
  await filter.press("ArrowDown");
  await page.waitForFunction(() => window.finishOldHistory);
  await page.keyboard.press("ArrowDown");
  await history.getByRole("button", { name: /Remote-tracking topic/ }).waitFor();
  await page.evaluate(() => window.finishOldHistory());
  assert.equal(await history.getByText("Stale local topic").count(), 0);
  await button(branches, "Changes").click();
  const changes = page.getByRole("region", { name: "Changes", exact: true });
  const preview = page.getByRole("region", { name: "Change preview", exact: true });
  const changeFilter = changes.getByRole("searchbox", { name: "Filter changed paths" });
  await preview.getByText("HEAD → Index", { exact: true }).waitFor();
  await preview.getByText("+staged", { exact: true }).waitFor();
  await changeFilter.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await preview.getByText("Index → Working file", { exact: true }).waitFor();
  await preview.getByText("+unstaged", { exact: true }).waitFor();
  const edited = changes.getByRole("group", { name: "Unstaged", exact: true }).getByRole("option", { name: /note\.txt/ });
  assert.equal(await edited.getAttribute("aria-selected"), "true");
  await edited.press(swapKey);
  await changes.and(page.locator(".git-pane-left")).waitFor();
  await preview.and(page.locator(".git-pane-right")).waitFor();
  assert.equal(await edited.getAttribute("aria-selected"), "true");
  await button(preview, "Open in Viewer").click();
  await page.getByText("saved working text", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await changes.waitFor();
  assert.equal(await edited.getAttribute("aria-selected"), "true");
  await button(preview, "Open in Editor").click();
  const source = page.locator('.text-window[data-editing="true"] .cm-content');
  await source.fill("edited working text");
  await source.press(swapKey.replace("+u", "+s"));
  await page.waitForFunction(() => window.gitSaved === "edited working text");
  await source.press("Escape");
  await preview.getByText("+edited working text", { exact: true }).waitFor();
  assert.equal(await edited.getAttribute("aria-selected"), "true");
  await changes.getByRole("option", { name: /removed/ }).click();
  await preview.getByText("-deleted", { exact: true }).waitFor();
  assert.equal(await button(preview, "Open in Editor").count(), 0);
  await changeFilter.fill("nothing");
  await changes.getByText("No matching changed paths.").waitFor();
  await changes.getByText("Staged files: 1", { exact: true }).waitFor();
  await changeFilter.fill("");
  await edited.click();
  await button(preview, "Stage").click();
  const replace = page.getByRole("dialog", { name: "Replace staged changes?" });
  await button(replace, "Cancel").click();
  assert.equal(await page.evaluate(() => window.gitLastAction), undefined);
  await button(preview, "Stage").click();
  await button(replace, "Replace and stage").click();
  const staged = changes.getByRole("group", { name: "Staged", exact: true });
  await staged.getByRole("option", { name: /note\.txt/, selected: true }).waitFor();
  assert.equal(await page.evaluate(() => window.gitLastAction.action), "stage");
  await button(preview, "Unstage").press("Enter");
  await edited.waitFor();
  assert.equal(await page.evaluate(() => window.gitLastAction.action), "unstage");
  await button(preview, "Stage").click();
  await staged.getByRole("option", { name: /note\.txt/ }).waitFor();
  await changes.getByRole("option", { name: /new ł\.txt/ }).click();
  await button(preview, "Stage").click();
  await changes.getByText("Staged files: 2", { exact: true }).waitFor();
  await changeFilter.fill("removed.txt");
  await button(changes, "Commit…").click();
  const commitDialog = page.getByRole("dialog", { name: "Commit staged changes" });
  const message = commitDialog.getByRole("textbox", { name: "Commit message" });
  assert.equal(await button(commitDialog, "Commit").isDisabled(), true);
  await commitDialog.getByText("Branch main", { exact: true }).waitFor();
  await button(commitDialog, "note.txt").click();
  await commitDialog.getByText("+staged", { exact: true }).waitFor();
  await button(commitDialog, "new ł.txt").waitFor();
  await message.fill("Review two files");
  await button(commitDialog, "Cancel").click();
  await button(changes, "Commit…").click();
  assert.equal(await message.inputValue(), "Review two files");
  await page.evaluate(() => { window.gitExternalChange = true; });
  await button(commitDialog, "Commit").click();
  await changes.getByRole("alert").getByText(/checked-out branch or staged changes changed/).waitFor();
  await button(changes, "Commit…").click();
  assert.equal(await message.inputValue(), "Review two files");
  await button(commitDialog, "Commit").click();
  await changes.getByRole("status").getByText("Created commit abcdef0.").waitFor();
  assert.deepEqual(await page.evaluate(() => window.gitCommitted),
    { message: "Review two files", ref: "refs/heads/main", paths: ["new ł.txt", "note.txt"] });
  await changeFilter.fill("");
  await page.evaluate(() => { window.workingClean = true; });
  await button(changes, "Refresh").click();
  await changes.getByText("Working tree is clean.").waitFor();
  await page.evaluate(() => { window.workingError = true; });
  await button(changes, "Refresh").click();
  await changes.getByRole("alert").getByText("Could not read working tree changes.").waitFor();
  await button(changes, "Branches").click();
  await filter.press(swapKey);
  await branches.and(page.locator(".git-pane-right")).waitFor();
  await page.keyboard.press("F5");
  assert.equal(await page.getByRole("dialog", { name: "Copy" }).count(), 0);
  await filter.press(swapKey);
  await branches.and(page.locator(".git-pane-left")).waitFor();
  await button(branches, "Close Git View").click();
  await page.waitForFunction(() => document.activeElement?.id === "right-files");
  assert.equal(await right.getAttribute("aria-activedescendant"), selected);

  for (const [flag, condition, message] of [
    ["gitEmpty", true, "No commits yet"],
    ["gitDetached", true, "Detached HEAD"],
    ["gitError", "notRepository", "This folder is outside a Git working tree."],
    ["gitError", "missingGit", "Git is unavailable. Install Git and open Git View again."],
    ["gitError", "unreadable", "Could not read the Git repository."],
    ["gitError", "missingObject", "A required Git object is missing from this local repository."],
  ]) {
    await page.evaluate(([flag, condition]) => {
      window.gitError = window.gitEmpty = window.gitDetached = false;
      window[flag] = condition;
    }, [flag, condition]);
    await page.locator("#left-files").focus();
    await git.click();
    await page.getByText(message, { exact: true }).first().waitFor();
    await button(branches, "Close Git View").click();
    await branches.waitFor({ state: "hidden" });
  }
  const events = await page.evaluate(() => window.gitEvents);
  assert.match(events[0], /nested$/);
  assert.ok(events.some((path) => /repo ł$/.test(path)));
  for (const binding of [["Ctrl+Alt+J"], []]) {
    await page.evaluate((swap) => {
      const key = "dirlume.preferences.v1";
      const current = JSON.parse(localStorage.getItem(key));
      localStorage.setItem(key, JSON.stringify({ ...current, activeShortcutScheme: "fixture-swap",
        shortcutSchemes: [{ id: "fixture-swap", name: "Fixture swap", bindings: { swap } }] }));
    }, binding);
    await page.reload();
    await right.getByRole("option", { name: /^note\.txt/ }).click();
    await git.click();
    await branches.and(page.locator(".git-pane-right")).waitFor();
    await filter.press(swapKey);
    assert.equal(await branches.and(page.locator(".git-pane-right")).count(), 1);
    await filter.press("Control+Alt+j");
    assert.equal(await branches.and(page.locator(binding.length ? ".git-pane-left" : ".git-pane-right")).count(), 1);
  }
  console.log("Verified Git View, paged history, commit details, state-preserving swaps, shortcut customization, and pane restoration.");
} finally {
  await browser.close();
}
