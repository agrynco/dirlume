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
    let stashes = [];
    const conflictState = (operation) => ({ session: { operation, head: hash("a"), sources: [hash("c")] }, conflicts: [
      { path: "conflict.txt", base: { mode: "100644", oid: hash("a") },
        ours: { mode: "100644", oid: hash("b") }, theirs: { mode: "100644", oid: hash("c") } },
    ] });
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
              ], tags: [{ reference: "refs/tags/v1", name: "v1" }] };
          case "git_compare_revisions":
            assertRoot(args.root);
            window.gitCompared = { base: args.base, target: args.target };
            return {
              base: hash("a"), target: hash("c"),
              baseOnly: { commits: [commit("a", "Base-only commit")], nextOffset: null },
              targetOnly: { commits: [commit("c", "Target-only commit")], nextOffset: null },
              changes: [{ status: "M", path: "compare.txt", previousPath: null }],
            };
          case "git_revision_diff":
            assertRoot(args.root);
            if (args.base !== hash("a") || args.target !== hash("c") || args.path !== "compare.txt") throw "invalid comparison";
            return { patch: "-old\n+new\n", fallback: null };
          case "git_commit_graph":
            assertRoot(args.root);
            return args.search ? "* ccccccc Topic match\n" : "* ccccccc Topic match\n* aaaaaaa Common\n";
          case "git_file_history":
            assertRoot(args.root);
            if (args.path !== "note.txt") throw "invalid path";
            return { commits: [commit("c", "Edited tracked note")], nextOffset: null };
          case "git_file_blame":
            assertRoot(args.root);
            if (args.path !== "note.txt" || args.tip !== hash("c")) throw "invalid file revision";
            return "cccccccccccc (Fixture Author 2026-11-21 1) note\n";
          case "git_merge_plan":
            assertRoot(args.root);
            return { review: { headRef: "refs/heads/main", head: hash("a"), sourceRef: args.source, sourceTip: hash("c") },
              fastForward: false, upToDate: false, changes: [{ status: "M", path: "conflict.txt", previousPath: null }] };
          case "git_merge_state":
            assertRoot(args.root);
            return window.gitMerge ?? null;
          case "git_start_merge":
            assertRoot(args.root);
            if (args.review.sourceRef !== "refs/remotes/origin/topic" || args.mode !== "mergeCommit") throw "wrong reviewed branch";
            window.gitMerge = conflictState("merge");
            return null;
          case "git_inspect_merge":
            assertRoot(args.root);
            return { base: { text: "base fixture", fallback: null }, ours: { text: "ours fixture", fallback: null },
              theirs: { text: "theirs fixture", fallback: null }, workingPath: null };
          case "git_resolve_merge":
            assertRoot(args.root);
            if (args.resolution !== "theirs" || args.conflict.path !== "conflict.txt") throw "wrong resolution";
            window.gitMerge.conflicts = [];
            return null;
          case "git_finish_merge":
            assertRoot(args.root);
            window.gitFinishedOperation = { operation: args.session.operation, abort: args.abort };
            window.gitMerge = null;
            return null;
          case "git_history_plan":
            assertRoot(args.root);
            return { review: { action: args.action, head: hash("a"), headRef: "refs/heads/main",
              target: args.target, parent: args.parent, index: {}, trackedChanges: null },
              parents: [], paths: [{ status: "M", path: "fixture-reset.txt", previousPath: null }], localChanges: rows };
          case "git_edit_history":
            assertRoot(args.root);
            window.gitEdited = args.review;
            if (args.review.action === "cherryPick") window.gitMerge = conflictState("cherryPick");
            return null;
          case "git_rebase_plan":
            assertRoot(args.root);
            return { review: { head: hash("a"), headRef: "refs/heads/main", base: hash("b"),
              baseRef: args.target, index: {} }, merges: [],
              commits: [commit("c", "First commit to replay"), commit("d", "Second commit to replay")] };
          case "git_start_rebase":
            assertRoot(args.root);
            window.gitRebaseRequest = args;
            return null;
          case "git_reflog":
            assertRoot(args.root);
            return { entries: [{ hash: hash("d"), selector: "HEAD@{2026-11-21T01:00:00Z}",
              action: "reset: moving to main", subject: "Recovered commit" }], nextOffset: null };
          case "git_recover_commit":
            assertRoot(args.root);
            window.gitRecovered = args;
            return null;
          case "git_push_remotes":
            assertRoot(args.root);
            return ["origin", "review"];
          case "git_push_lease_plan":
            assertRoot(args.root);
            return { head: hash("a"), headRef: "refs/heads/main", remote: args.remote, destination: "refs/heads/" + args.branch,
              expected: hash("b"), url: "https://example.invalid/review/dirlume", urlDigest: [] };
          case "git_push_with_lease":
            assertRoot(args.root);
            window.gitLease = args.review;
            return null;
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
            if (window.gitExtraChanges) {
              window.gitExtraChanges = false;
              rows.push({ group: "unstaged", status: "M", path: "note.txt", previousPath: null },
                { group: "untracked", status: "?", path: "bulk.txt", previousPath: null });
            }
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
          case "git_amend_changes":
            assertRoot(args.root);
            window.gitAmended = args.message;
            return "abcdef1";
          case "git_hunk_plan":
            assertRoot(args.root);
            return { review: { expected: args.expected, change: args.change, stamp: [] },
              hunks: ["@@ -4 +4 @@\n-before\n+first hunk\n", "@@ -24 +24 @@\n-before\n+second hunk\n"] };
          case "git_apply_hunk":
            assertRoot(args.root);
            window.gitStagedHunk = { path: args.review.change.path, index: args.index };
            indexVersion++;
            return null;
          case "git_bulk_plan":
            assertRoot(args.root);
            return { expected: args.expected, changes: args.changes, action: args.action, stamps: [] };
          case "git_apply_bulk":
            assertRoot(args.root);
            window.gitBulk = args.plan.changes.map(({ path }) => path);
            indexVersion++;
            return null;
          case "git_discard_plan":
            assertRoot(args.root);
            return { review: { expected: args.expected, change: args.change, stamps: [] },
              diff: { patch: "+discard preview\n", fallback: null } };
          case "git_discard_worktree":
            assertRoot(args.root);
            window.gitDiscarded = args.review.change.path;
            rows = rows.filter((row) => row.path !== args.review.change.path);
            return null;
          case "git_stashes":
            assertRoot(args.root);
            return stashes;
          case "git_create_stash":
            assertRoot(args.root);
            window.gitStashCreated = { message: args.message, untracked: args.untracked };
            stashes = [{ hash: hash("b"), position: 0, subject: args.message }];
            return null;
          case "git_stash_preview":
            assertRoot(args.root);
            return { combined: { patch: "+saved stash diff\n", fallback: null },
              staged: { patch: "+saved staged version\n", fallback: null }, working: { patch: "+saved working version\n", fallback: null } };
          case "git_update_stash":
            assertRoot(args.root);
            window.gitStashAction = { hash: args.entry.hash, action: args.action, restoreIndex: args.restoreIndex };
            if (args.action === "drop") {
              stashes = [];
              return { changes: [], error: null };
            }
            return { changes: [{ group: "unstaged", status: "U", path: "stash-conflict.txt", previousPath: null }],
              error: "Git reported a conflict." };
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
  await button(history, "Compare revisions").click();
  await history.getByRole("combobox", { name: "Target revision", exact: true }).selectOption("refs/tags/v1");
  await button(history, "Compare").click();
  await history.getByText("Base-only commit", { exact: false }).waitFor();
  await history.getByText("Target-only commit", { exact: false }).waitFor();
  await history.getByRole("button", { name: /compare\.txt/ }).click();
  await history.getByText("+new", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.gitCompared), { base: "a".repeat(40), target: "refs/tags/v1" });
  assert.equal(await page.evaluate(() => window.gitLastAction), undefined);
  await button(history, "Compare revisions").click();
  await button(history, "Commit graph").click();
  const graph = history.getByLabel("Commit graph", { exact: true });
  await graph.filter({ hasText: "Common" }).waitFor();
  await history.getByRole("searchbox", { name: "Search commit messages", exact: true }).fill("Topic");
  await button(history, "Search").click();
  await graph.filter({ hasText: "Topic match" }).waitFor();
  assert.doesNotMatch(await graph.textContent(), /Common/);
  await button(history, "File history").click();
  await history.getByRole("textbox", { name: "Path relative to the repository", exact: true }).fill("note.txt");
  await button(history, "Show history").click();
  await history.getByRole("button", { name: /Edited tracked note/ }).waitFor();
  await button(history, "Show blame").click();
  await history.getByLabel("Blame", { exact: true }).filter({ hasText: "Fixture Author" }).waitFor();
  await button(history, "File history").click();
  await button(branches, "Create tracking branch and switch").click();
  const tracking = page.getByRole("dialog", { name: "Create tracking branch and switch", exact: true });
  assert.equal(await tracking.getByRole("textbox", { name: "Branch name", exact: true }).inputValue(), "topic");
  await button(tracking, "Cancel").click();
  await button(history, "Merge branch").click();
  await history.getByText("refs/remotes/origin/topic", { exact: false }).waitFor();
  assert.equal(await button(history, "Fast-forward only").isDisabled(), true);
  await button(history, "Create merge commit").click();
  await button(page.getByRole("dialog", { name: "Create merge commit", exact: true }), "Create merge commit").click();
  await history.getByText("ours fixture", { exact: true }).waitFor();
  assert.equal(await button(history, "Continue merge").isDisabled(), true);
  await button(branches, "Close Git View").click();
  await git.click();
  await history.getByText("ours fixture", { exact: true }).waitFor();
  await button(history, "Theirs").click();
  await history.getByText("theirs fixture", { exact: true }).waitFor();
  await button(history, "Use theirs").click();
  await button(page.getByRole("dialog", { name: "Use theirs", exact: true }), "Use theirs").click();
  await history.getByText("All conflicts are resolved.", { exact: true }).waitFor();
  await button(history, "Continue merge").click();
  await button(page.getByRole("dialog", { name: "Continue merge", exact: true }), "Continue merge").click();
  await history.getByText("Select a source branch to merge.", { exact: true }).waitFor();
  await button(history, "History actions").click();
  const actionType = history.getByRole("combobox", { name: "History action", exact: true });
  await actionType.selectOption("hardReset");
  await history.getByRole("textbox", { name: "Target commit", exact: true }).fill("d".repeat(40));
  await button(history, "Review changes").click();
  await history.getByText("fixture-reset.txt", { exact: true }).waitFor();
  await button(history, "Hard reset").click();
  const reset = page.getByRole("dialog", { name: "Hard reset", exact: true });
  await reset.getByText("Move HEAD, replace the index, and discard changes to tracked working files.", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.gitEdited), undefined);
  await button(reset, "Hard reset").click();
  await history.getByText("Git operation completed.", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.gitEdited.action), "hardReset");
  await actionType.selectOption("rebase");
  await history.getByRole("combobox", { name: "Rebase base", exact: true }).fill("refs/heads/topic");
  await button(history, "Review changes").click();
  await history.getByText("First commit to replay").waitFor();
  await button(history, "Move earlier").last().click();
  await history.getByRole("combobox", { name: "Rebase action", exact: true }).first().selectOption("reword");
  await history.getByRole("textbox", { name: "Replacement commit message", exact: true }).fill("Reworded second");
  await history.getByRole("combobox", { name: "Rebase action", exact: true }).last().selectOption("squash");
  await button(history, "Rebase branch").click();
  const rebase = page.getByRole("dialog", { name: "Rebase branch", exact: true });
  assert.match(await rebase.locator("ol li").first().innerText(), /Reword.*Reworded second/);
  await button(rebase, "Rebase branch").click();
  await history.getByText("Git operation completed.", { exact: true }).waitFor();
  assert.deepEqual((await page.evaluate(() => window.gitRebaseRequest.steps)).map((step) => [step.hash[0], step.action]),
    [["d", "reword"], ["c", "squash"]]);
  await actionType.selectOption("reflog");
  await button(history, "Read reflog").click();
  await history.getByText("Recovered commit", { exact: false }).waitFor();
  await button(history, "Recover into new branch").click();
  const recover = page.getByRole("dialog", { name: "Recover into new branch", exact: true });
  await recover.getByRole("textbox", { name: "Branch name", exact: true }).fill("rescued");
  await button(recover, "Recover into new branch").click();
  await history.getByText("Git operation completed.", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.gitRecovered.name), "rescued");
  await actionType.selectOption("push");
  await history.getByRole("combobox", { name: "Remote", exact: true }).selectOption("review");
  await history.getByRole("textbox", { name: "Destination branch", exact: true }).fill("topic");
  await button(history, "Review changes").click();
  await button(history, "Force-push with lease").click();
  const lease = page.getByRole("dialog", { name: "Force-push with lease", exact: true });
  await lease.getByText("refs/heads/topic", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.gitLease), undefined);
  await button(lease, "Force-push with lease").click();
  await history.getByText("Git operation completed.", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.gitLease.expected), "b".repeat(40));
  await actionType.selectOption("cherryPick");
  await button(history, "Review changes").click();
  await button(history, "Cherry-pick commit").click();
  await button(page.getByRole("dialog", { name: "Cherry-pick commit", exact: true }), "Cherry-pick commit").click();
  await button(history, "Cherry-pick in progress").waitFor();
  await button(branches, "Close Git View").click();
  await git.click();
  await history.getByText("ours fixture", { exact: true }).waitFor();
  await button(history, "Abort cherry-pick").click();
  await button(page.getByRole("dialog", { name: "Abort cherry-pick", exact: true }), "Abort cherry-pick").click();
  await history.getByText("Select a source branch to merge.", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.gitFinishedOperation), { operation: "cherryPick", abort: true });
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
  await page.evaluate(() => { window.gitExtraChanges = true; });
  await button(changes, "Refresh").click();
  await edited.click();
  await button(preview, "Stage hunk…").click();
  const hunks = page.getByRole("dialog", { name: "Review text hunks", exact: true });
  await hunks.getByRole("combobox", { name: "Hunk", exact: true }).selectOption("1");
  await hunks.getByLabel("Inline diff", { exact: true }).filter({ hasText: "+second hunk" }).waitFor();
  await button(hunks, "Stage this hunk").click();
  await page.waitForFunction(() => window.gitStagedHunk?.index === 1);
  assert.deepEqual(await page.evaluate(() => window.gitStagedHunk), { path: "note.txt", index: 1 });
  await button(changes, "Select files…").click();
  const selectFiles = page.getByRole("dialog", { name: "Select changed files", exact: true });
  await selectFiles.getByRole("checkbox", { name: "note.txt", exact: true }).check();
  await selectFiles.getByRole("checkbox", { name: "bulk.txt", exact: true }).check();
  await button(selectFiles, "Review changes").click();
  const bulk = page.getByRole("dialog", { name: "Stage selected files", exact: true });
  await bulk.getByText("bulk.txt", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.gitBulk), undefined);
  await button(bulk, "Stage selected files").click();
  await page.waitForFunction(() => window.gitBulk?.length === 2);
  assert.deepEqual((await page.evaluate(() => window.gitBulk)).sort(), ["bulk.txt", "note.txt"]);
  await edited.click();
  await button(preview, "Discard…").click();
  const discard = page.getByRole("dialog", { name: "Discard working change", exact: true });
  await discard.getByLabel("Inline diff", { exact: true }).filter({ hasText: "+discard preview" }).waitFor();
  assert.equal(await page.evaluate(() => window.gitDiscarded), undefined);
  await button(discard, "Discard working change").click();
  await page.waitForFunction(() => window.gitDiscarded === "note.txt");
  await button(changes, "Amend…").click();
  const amend = page.getByRole("dialog", { name: "Amend current commit", exact: true });
  const amendMessage = amend.getByRole("textbox", { name: "Commit message", exact: true });
  assert.match(await amendMessage.inputValue(), /Full commit body/);
  await amendMessage.fill("Amend the reviewed commit");
  await button(amend, "Amend commit").click();
  await changes.getByText("Amended commit abcdef1.", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.gitAmended), "Amend the reviewed commit");
  await button(changes, "Stashes…").click();
  const stashes = page.getByRole("dialog", { name: "Git stashes", exact: true });
  await stashes.getByRole("textbox", { name: "Stash message", exact: true }).fill("Fixture stash");
  await stashes.getByRole("checkbox", { name: "Include untracked files", exact: true }).check();
  await button(stashes, "Create stash").click();
  await stashes.getByLabel("Stash diff", { exact: true }).filter({ hasText: "+saved stash diff" }).waitFor();
  await button(stashes, "Staged").click();
  await stashes.getByLabel("Stash diff", { exact: true }).filter({ hasText: "+saved staged version" }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.gitStashCreated), { message: "Fixture stash", untracked: true });
  await button(stashes, "Apply stash").click();
  const apply = page.getByRole("dialog", { name: "Apply stash", exact: true });
  await button(apply, "Apply stash").click();
  await stashes.getByText("stash-conflict.txt", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.gitStashAction.restoreIndex), true);
  await button(stashes, "Drop stash").click();
  const drop = page.getByRole("dialog", { name: "Drop stash", exact: true });
  assert.equal(await page.evaluate(() => window.gitStashAction.action), "apply");
  await button(drop, "Drop stash").click();
  await stashes.getByText("No stashes.", { exact: true }).waitFor();
  await button(stashes, "Close").click();
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
