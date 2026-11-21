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
          case "copy_path": window.gitCopied = args.path; return null;
          default: return null;
        }
      },
    };
  });
  await page.goto("http://dirlume.test/");
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
  await filter.press("Control+u");
  await branches.and(page.locator(".git-pane-left")).waitFor();
  assert.equal(await filter.inputValue(), "mai");
  assert.ok(await filter.evaluate((field) => document.activeElement === field));
  await history.getByText("Full commit body").waitFor();
  await history.getByRole("button", { name: /Old commit/ }).press("Control+u");
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
  await page.keyboard.press("F5");
  assert.equal(await page.getByRole("dialog", { name: "Copy" }).count(), 0);
  await filter.press("Control+u");
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
  assert.match(events[1], /repo ł$/);
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
    await filter.press("Control+u");
    assert.equal(await branches.and(page.locator(".git-pane-right")).count(), 1);
    await filter.press("Control+Alt+j");
    assert.equal(await branches.and(page.locator(binding.length ? ".git-pane-left" : ".git-pane-right")).count(), 1);
  }
  console.log("Verified Git View, paged history, commit details, state-preserving swaps, shortcut customization, and pane restoration.");
} finally {
  await browser.close();
}
