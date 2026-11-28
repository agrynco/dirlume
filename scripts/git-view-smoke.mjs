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
    const linked = windows ? "C:\\linked repo ł" : "/linked repo ł";
    const cloned = windows ? "C:\\cloned repo ł" : "/cloned repo ł";
    const file = { name: "note.txt", directory: false, link: false, hidden: false, size: 1, modified: null };
    const fileContextFixture = sessionStorage.getItem("git-file-context-fixture") === "yes";
    const hash = (value) => value.repeat(40);
    const commit = (value, subject) => ({
      subject, hash: hash(value), shortHash: value.repeat(7), author: "Fixture Author", date: "2026-11-21T01:00:00Z",
    });
    window.gitEvents = [];
    window.graphRequests = [];
    let indexVersion = 0;
    let stashes = [];
    const remotes = [
      { name: "origin", fetchUrls: ["https://example.invalid/origin"], pushUrls: ["https://example.invalid/origin"], stamp: [1] },
      { name: "backup", fetchUrls: ["https://example.invalid/backup"], pushUrls: ["https://example.invalid/backup"], stamp: [2] },
    ];
    let worktrees = [
      { path: root, branch: "refs/heads/main", head: hash("a"), primary: true, locked: false, bare: false, prunable: false },
      { path: linked, branch: "refs/heads/topic", head: hash("b"), primary: false, locked: false, bare: false, prunable: false },
    ];
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
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      invoke: async (command, args = {}) => {
        switch (command) {
          case "locations": return [{ label: "Home", path: root }, { label: "Downloads", path: sub }];
          case "list_directory": return { path: args.path, parent: null, entries: fileContextFixture ?
            [file, { ...file, name: "another.txt" }, { ...file, name: "outside.txt" }] : [file], omitted: 0 };
          case "file_icons": return [null];
          case "windows_item_menu": window.nativeFileMenu = args; return false;
          case "git_file_context": {
            window.fileContextRequest = { directory: args.directory, name: args.name };
            if (window.gitError || args.name === "outside.txt") throw "notRepository";
            const actualRoot = args.directory === sub ? sub : root;
            const value = { root: actualRoot, path: args.name, head: hash("c"), hasHistory: true,
              hasBlame: true, hasDiff: args.name === "note.txt" };
            if (window.holdGitFileContext && args.name === "note.txt") return new Promise((resolve) => {
              window.finishGitFileContext = () => resolve(value);
            });
            return value;
          }
          case "git_working_file_content":
            assertRoot(args.root);
            if (args.path !== "note.txt") throw "unexpected working comparison path";
            return { state: "available", text: "Working line" };
          case "git_repository":
            window.gitEvents.push(args.path);
            if (window.gitError) throw window.gitError;
            return { root: args.path === linked ? linked : args.path === cloned ? cloned : fileContextFixture && args.path === sub ? sub : root,
              name: args.path === linked ? "linked repo ł" : args.path === cloned ? "cloned repo ł" : fileContextFixture && args.path === sub ? "nested" : "repo ł",
              headRef: window.gitDetached ? null : args.path === linked ? "refs/heads/topic" : "refs/heads/main",
              head: window.gitEmpty ? null : hash("a"),
              branches: window.gitEmpty || window.gitDetached ? [] : [
                { reference: "refs/heads/main", name: "main", tip: hash("a"), remote: false },
                { reference: "refs/heads/stable", name: "stable", tip: hash("a"), remote: false },
                { reference: "refs/heads/topic", name: "topic", tip: hash("b"), remote: false },
                { reference: "refs/remotes/origin/topic", name: "origin/topic", tip: hash("c"), remote: true },
                { reference: "refs/remotes/backup/base-tip", name: "backup/base-tip", tip: hash("a"), remote: true },
                { reference: "refs/remotes/backup/graph-upstream", name: "backup/graph-upstream", tip: hash("e"), remote: true },
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
            if (args.path === "review-new.txt" && args.previousPath === "review-old.txt" && args.target === hash("a") &&
              args.base === hash("b") && !args.reverse) return { patch: "-original review\n+forward review\n", fallback: null };
            if (args.path === "merge-review.txt" && args.target === hash("a") && args.reverse && [hash("b"), hash("c")].includes(args.base)) {
              return { patch: "-merge result\n+mainline " + args.base[0] + "\n", fallback: null };
            }
            if (args.path === "review-image.png" && args.target === hash("a") && !args.reverse) return { patch: null, fallback: "binary" };
            if (args.path === "new ł.txt" && args.base === hash("b") && args.target === hash("a") && args.previousPath === null) {
              return { patch: "+new in this commit\n", fallback: null };
            }
            if (args.base !== hash("a") || args.target !== hash("c") || args.path !== "compare.txt") throw "invalid comparison";
            return { patch: "-old\n+new\n", fallback: null };
          case "git_graph_upstream":
            assertRoot(args.root);
            return args.reference === "refs/heads/main" ? { reference: "refs/remotes/backup/graph-upstream", tip: hash("e") } : null;
          case "git_commit_graph": {
            assertRoot(args.root);
            const request = args.request;
            window.graphRequests.push(request);
            const normalize = (revision) => ({
              "refs/heads/main": hash("a"), "refs/tags/v1": hash("e"),
            }[revision] ?? revision);
            const base = normalize(request.base);
            const target = normalize(request.target);
            const graphCommit = (id, subject, parents, side = null) => ({ ...commit(id, subject), parents: parents.map(hash), side });
            const page = (commits, nextOffset = null) => ({ base, target, commits, nextOffset });
            if (base === hash("f") || target === hash("f")) throw "missingObject";
            if (request.search === "stall") return new Promise((resolve) => {
              window.finishGraphSearch = () => resolve(page([graphCommit("f", "Stale graph response", [])]));
            });
            if (request.search === "missing") return page([]);
            const common = graphCommit("d", "Common", [], target ? "shared" : null);
            const remote = graphCommit("c", "Topic match", ["d"], target ? "shared" : null);
            if (request.search) return page([remote]);
            if (!target && base === hash("c")) return page([remote, common]);
            const main = graphCommit("a", "Main merge", ["b", "c"], target ? "base" : null);
            const topic = graphCommit("b", "Local feature", ["d"], target ? "base" : null);
            const incoming = graphCommit("e", "Upstream change", ["d"], "target");
            if (target === hash("e")) return page([main, topic, remote, incoming, common]);
            if (target) return page([main, topic, remote, common]);
            if (request.offset === 250) {
              if (window.failGraphPage) { window.failGraphPage = false; throw "unreadable"; }
              return page([common]);
            }
            const synthetic = Array.from({ length: 32 }, (_, index) => {
              const hash = index.toString(16).padStart(40, "0");
              return { hash, shortHash: hash.slice(-7), subject: "Intermediate " + index, date: "", author: "", parents: [], side: null };
            });
            return page([main, topic, remote, ...synthetic], 250);
          }
          case "git_file_history":
            assertRoot(args.root);
            if (fileContextFixture && args.path === "another.txt" && args.tip === hash("c")) return { commits: [
              { ...commit("c", "Created a different file"), parent: hash("b"), merge: false,
                change: { status: "A", path: "another.txt", previousPath: null } },
            ], nextOffset: null };
            if (args.path !== "note.txt" || args.tip !== hash("c")) throw "invalid file history";
            if (args.offset) return { commits: [{ ...commit("d", "Added original note"), parent: null, merge: false,
              change: { status: "A", path: "old-note.txt", previousPath: null } }], nextOffset: null };
            return { commits: [
              { ...commit("c", "Edited tracked note"), parent: hash("b"), merge: false,
                change: { status: "M", path: "note.txt", previousPath: null } },
              { ...commit("b", "Renamed tracked note"), parent: hash("d"), merge: false,
                change: { status: "R100", path: "note.txt", previousPath: "old-note.txt" } },
            ], nextOffset: 2 };
          case "git_file_revision": {
            assertRoot(args.root);
            const revision = args.revision === "refs/heads/main" ? hash("a") : args.revision === "refs/tags/v1" ? hash("f") : args.revision;
            if (window.holdFileRevision && revision === hash("c")) return new Promise((resolve) => {
              window.finishFileRevision = () => resolve({ revision, path: args.path, content: {
                state: "available", text: "Late response for another row",
              } });
            });
            const available = revision === hash("d") ? args.path === "old-note.txt" : revision !== hash("f") && args.path === "note.txt";
            return { revision, path: args.path, content: available ? { state: "available", text: revision === hash("c") ? "Edited line" :
              revision === hash("a") ? "Alternate line" : "Original line" } : { state: "missing" } };
          }
          case "git_file_blame": {
            assertRoot(args.root);
            if (args.path === "empty.txt" && args.tip === hash("c")) return { revision: args.tip, path: args.path, content: { state: "empty" } };
            if (args.path === "binary.txt" && args.tip === hash("c")) return { revision: args.tip, path: args.path, content: { state: "binary" } };
            if (args.path !== "note.txt" || args.tip !== hash("c")) throw "invalid file revision";
            const lines = Array.from({ length: 32 }, (_, index) => ({ number: index + 1, original: index + 2,
              hash: hash(index === 16 ? "d" : "c"), author: index === 16 ? "Prior author" : "Fixture Author",
              path: index === 16 ? "old-note.txt" : "note.txt", time: 1795222800,
              text: index === 15 ? "Long line " + "wrapped content here ".repeat(15) : "Text at line " + (index + 1),
            }));
            return { revision: args.tip, path: args.path, content: { state: "available", lines } };
          }
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
          case "git_history_plan": {
            assertRoot(args.root);
            const picking = args.action === "cherryPick";
            const reverting = args.action === "revert";
            return { review: { action: args.action, head: hash("a"), headRef: "refs/heads/main",
              target: args.target, parent: args.parent, index: {}, trackedChanges: null },
              subject: reverting ? "Merge feature" : picking ? "Commit under review" : null,
              parents: reverting ? [hash("b"), hash("c")] : picking ? [hash("b")] : [],
              paths: reverting ? args.parent ? [{ status: "M", path: "merge-review.txt", previousPath: null }] : [] : picking ? [
                { status: "R", path: "review-new.txt", previousPath: "review-old.txt" },
                { status: "A", path: "review-image.png", previousPath: null },
              ] : [{ status: "M", path: "fixture-reset.txt", previousPath: null }], localChanges: rows };
          }
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
          case "git_worktrees":
            assertRoot(args.root);
            return worktrees;
          case "git_create_worktree":
            assertRoot(args.root);
            window.gitCreatedWorktree = args.review;
            worktrees.push({ path: args.review.destination, branch: "refs/heads/" + args.review.branch,
              head: args.review.expectedCommit, primary: false, locked: false, bare: false, prunable: false });
            return null;
          case "git_remove_worktree":
            assertRoot(args.root);
            if (window.gitWorktreeDirty) throw { kind: "failed", detail: "The worktree contains local changes." };
            worktrees = worktrees.filter((tree) => tree.path !== args.review.path);
            window.gitRemovedWorktree = args.review.path;
            return null;
          case "git_submodules":
            assertRoot(args.root);
            return [{ path: "modules/local fixture", status: window.gitModuleUpdated ? " " : "-", head: hash("b") }];
          case "git_update_submodule":
            assertRoot(args.root);
            window.gitModuleUpdated = args.review.path;
            return null;
          case "git_lfs_state":
            assertRoot(args.root);
            return window.gitLfsInstalled ? { installed: true, version: "git-lfs/3.7.1", status: "LFS objects ready",
              remotes: ["origin"] } : { installed: false, version: null, status: null, remotes: [] };
          case "git_lfs_transfer":
            assertRoot(args.root);
            window.gitLfsTransfer = { action: args.action, remote: args.remote };
            return null;
          case "git_bisect_state":
            assertRoot(args.root);
            return window.gitBisect ?? null;
          case "git_start_bisect":
            assertRoot(args.root);
            window.gitBisect = { start: "main", head: hash("c"), log: "git bisect start", concluded: false };
            return null;
          case "git_update_bisect":
            assertRoot(args.root);
            window.gitBisectAction = args.action;
            window.gitBisect = args.action === "reset" ? null :
              { ...window.gitBisect, concluded: true, log: "# first bad commit: " + hash("c") };
            return null;
          case "git_repository_setup":
            window.gitSetup = args;
            if (args.action === "clone" && window.gitClonePartial) {
              throw { kind: "partialClone", detail: { path: args.path, message: "Git could not check out files." } };
            }
            return args.path;
          case "git_remotes":
            assertRoot(args.root);
            return remotes;
          case "git_fetch_remote":
            assertRoot(args.root);
            window.gitFetch = { remote: args.remote.name, prune: args.prune };
            return "Fetched updated refs";
          case "git_upstream":
            assertRoot(args.root);
            return { headRef: "refs/heads/main", head: hash("a"), reference: window.gitUpstream ?? null,
              remote: window.gitUpstream ? "origin" : null, remoteRef: window.gitUpstream ? "refs/heads/topic" : null,
              tip: window.gitUpstream ? hash("c") : null };
          case "git_set_upstream":
            assertRoot(args.root);
            window.gitUpstream = args.reference;
            return null;
          case "git_remote_ref_review":
            assertRoot(args.root);
            return { remote: args.remote, pushUrl: args.remote.pushUrls[0], source: args.source, destination: args.destination,
              object: args.source ? hash("a") : null, deleteTip: args.source ? null : hash("b") };
          case "git_transfer_remote_ref":
            assertRoot(args.root);
            window.gitTransfer = args.review;
            return "Updated reviewed reference";
          case "open_terminal":
            window.gitTerminalDirectory = args.request.directory;
            return false;
          case "git_history":
            if (args.tip === hash("b")) return new Promise((resolve) => {
              window.finishOldHistory = () => resolve({ commits: [commit("b", "Stale local topic")], nextOffset: null });
            });
            if (args.tip === hash("c")) return { commits: [commit("c", "Remote-tracking topic")], nextOffset: null };
            return { commits: args.offset ? [commit("d", "Old commit")] : [commit("a", "Merge feature")],
              nextOffset: args.offset ? null : 1 };
          case "git_details": return args.hash === hash("d") ? { message: "Why the original note changed", merge: false,
            firstParent: null, changes: [{ status: "A", path: "old-note.txt", previousPath: null }] } :
            { message: "Merge feature\n\nFull commit body", merge: true, firstParent: hash("b"), changes: [
            { status: "A", path: "new ł.txt", previousPath: null }, { status: "D", path: "removed.txt", previousPath: null },
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
      if (path !== root && path !== linked && path !== cloned && !(fileContextFixture && path === sub)) throw "notRepository";
    }
  });
  await page.goto("http://dirlume.test/");
  const swapKey = await page.evaluate(() => /Mac/i.test(navigator.userAgent) ? "Meta+u" : "Control+u");
  const button = (scope, name) => scope.getByRole("button", { name, exact: true });
  const gitMenu = (target) => page.getByRole("menu", { name: "Git actions for " + target, exact: true });
  const menuItem = (scope, name) => scope.getByRole("menuitem", { name, exact: true });
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
  assert.equal(await button(branches, "Create branch").getAttribute("data-tooltip"), "Create a branch from the selected revision.");
  assert.equal(await button(branches, "Create branch").locator("svg").count(), 1);
  await button(branches, "Create branch").focus();
  await page.getByRole("tooltip").filter({ hasText: "Create a branch from the selected revision." }).waitFor();
  await merge.focus();
  await page.keyboard.press("Shift+F10");
  const commitMenu = gitMenu("aaaaaaa");
  await commitMenu.waitFor();
  await page.keyboard.press("ArrowDown");
  assert.equal(await menuItem(commitMenu, "Copy commit hash").evaluate((item) => document.activeElement === item), true);
  await page.keyboard.press("Escape");
  assert.equal(await merge.evaluate((row) => document.activeElement === row), true);
  await merge.click({ button: "right" });
  await menuItem(commitMenu, "Revert commit").click();
  assert.equal(await history.getByRole("combobox", { name: "History action", exact: true }).inputValue(), "revert");
  assert.equal(await history.getByRole("textbox", { name: "Target commit", exact: true }).inputValue(), "a".repeat(40));
  await button(history, "Review changes").click();
  const mainline = history.getByRole("combobox", { name: "Mainline parent", exact: true });
  await mainline.selectOption("1");
  await history.getByText("Inverse of the source commit", { exact: true }).waitFor();
  await history.getByText("+mainline b", { exact: true }).waitFor();
  await mainline.selectOption("2");
  await history.getByText("+mainline c", { exact: true }).waitFor();
  assert.equal(await history.getByText("+mainline b", { exact: true }).count(), 0);
  await button(history, "History actions").click();
  await merge.click();
  await history.getByText("Changed paths relative to the first parent").waitFor();
  await history.getByText("new ł.txt").waitFor();
  await history.getByText("new ł.txt", { exact: true }).click({ button: "right" });
  await menuItem(gitMenu("new ł.txt"), "Show change").click();
  const historicalChange = page.getByRole("dialog", { name: "Change preview", exact: true });
  await historicalChange.getByText("+new in this commit", { exact: true }).waitFor();
  await button(historicalChange, "Close dialog").click();
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
  const graph = history.getByRole("list", { name: "Commit graph", exact: true });
  const graphSearch = history.getByRole("searchbox", { name: "Search commit messages", exact: true });
  const graphRow = (value) => graph.locator(`[data-commit="${value.repeat(40)}"]`);
  const fakeEdge = (child, parent) => graph.locator(`[data-graph-edge="${child.repeat(40)}:${parent.repeat(40)}"]`);
  await graph.getByText("Common", { exact: true }).waitFor();
  assert.equal(await button(history, "Show upstream").count(), 0);
  await graphSearch.fill("Topic");
  await button(history, "Search").click();
  await graph.getByText("Topic match", { exact: true }).waitFor();
  await graph.getByLabel("Parents outside current results", { exact: true }).waitFor();
  assert.equal(await graph.getByText("Common", { exact: true }).count(), 0);
  await graphSearch.fill("stall");
  await graphSearch.press("Enter");
  await page.waitForFunction(() => typeof window.finishGraphSearch === "function");
  await graphSearch.clear();
  await graph.getByText("Common", { exact: true }).waitFor();
  await page.evaluate(() => window.finishGraphSearch());
  assert.equal(await graph.getByText("Stale graph response", { exact: true }).count(), 0);

  await graphRow("c").getByRole("button").press("Shift+F10");
  const graphMenu = gitMenu("ccccccc");
  await menuItem(graphMenu, "Use as target").click();
  const graphCompare = history.locator(".git-graph-compare");
  await graphCompare.locator('input[name="Target revision"]:not([type=hidden])').waitFor();
  assert.equal(await graphCompare.locator('input[name="Target revision"]').inputValue(), "c".repeat(40));
  assert.equal(await graphCompare.locator('input[name="Base revision"]').inputValue(), "");
  assert.ok(await graphCompare.getByRole("combobox", { name: "Base revision", exact: true })
    .evaluate((control) => document.activeElement === control));
  await graphCompare.getByRole("combobox", { name: "Base revision", exact: true }).selectOption("refs/heads/main");
  await graphRow("d").getByRole("button").click({ button: "right" });
  await menuItem(gitMenu("ddddddd"), "Copy commit hash").click();
  assert.equal(await page.evaluate(() => window.gitCopied), "d".repeat(40));
  await graphCompare.getByRole("combobox", { name: "Target revision", exact: true }).selectOption("refs/tags/v1");
  await button(graphCompare, "Compare").click();
  await graphRow("e").getByText("Target only", { exact: true }).waitFor();
  await graphRow("a").getByText("Base only", { exact: true }).waitFor();
  assert.equal(await graphRow("d").count(), 1);
  assert.equal(await page.evaluate(() => window.graphRequests.at(-1).target), "refs/tags/v1");
  await graphRow("d").getByRole("button").click({ button: "right" });
  await menuItem(gitMenu("ddddddd"), "Use as base").click();
  assert.equal(await graphCompare.locator('input[name="Base revision"]').inputValue(), "d".repeat(40));
  assert.equal(await graphCompare.getByRole("combobox", { name: "Target revision", exact: true }).inputValue(), "refs/tags/v1");
  await graphCompare.locator('input[name="Base revision"]').fill("f".repeat(40));
  await button(graphCompare, "Compare").click();
  await history.getByRole("alert").filter({ hasText: "Check both local revisions and retry." }).waitFor();

  await filter.fill("");
  await branches.getByRole("option", { name: /main/ }).click();
  await graphRow("a").getByText("Main merge", { exact: true }).waitFor();
  await fakeEdge("a", "b").waitFor({ state: "attached" });
  await fakeEdge("a", "c").waitFor({ state: "attached" });
  assert.equal(await graphRow("a").locator('[data-graph-ref="refs/heads/stable"]').textContent(), "stable");
  assert.equal(await graphRow("a").locator('[data-graph-ref="refs/remotes/backup/base-tip"]').textContent(), "backup/base-tip");
  await graphRow("a").getByRole("button").first().click();
  await graphRow("a").getByText("Full commit body", { exact: false }).waitFor();
  await graphRow("a").getByRole("button").first().click();
  const graphScroll = history.locator(".git-graph-scroll");
  await graphScroll.evaluate((element) => { element.scrollTop = 250; });
  const graphScrollBefore = await graphScroll.evaluate((element) => element.scrollTop);
  assert.ok(graphScrollBefore > 0);
  await page.evaluate(() => { window.failGraphPage = true; });
  await button(history, "Load more").click();
  await button(history, "Retry").waitFor();
  assert.equal(await graphRow("a").count(), 1);
  await button(history, "Retry").click();
  await graphRow("d").getByText("Common", { exact: true }).waitFor({ state: "attached" });
  assert.equal(await button(history, "Load more").count(), 0);
  assert.ok(Math.abs(await graphScroll.evaluate((element) => element.scrollTop) - graphScrollBefore) <= 2);
  await button(history, "Show upstream").click();
  await graphRow("e").getByText("Incoming commit", { exact: true }).waitFor();
  await graphRow("a").getByText("Outgoing commit", { exact: true }).waitFor();
  await history.getByText("backup/graph-upstream", { exact: true }).first().waitFor();
  await page.setViewportSize({ width: 755, height: 600 });
  const changeButton = await button(branches, "Changes").boundingBox();
  const refreshButton = await button(branches, "Refresh").boundingBox();
  assert.ok(changeButton.x + changeButton.width <= refreshButton.x || changeButton.y + changeButton.height <= refreshButton.y);
  await page.setViewportSize({ width: 1120, height: 760 });
  await graphRow("e").getByRole("button").press(swapKey);
  await branches.and(page.locator(".git-pane-left")).waitFor();
  assert.equal(await graphRow("e").getByText("Incoming commit", { exact: true }).count(), 1);
  await graphRow("e").getByRole("button").press(swapKey);
  await branches.and(page.locator(".git-pane-right")).waitFor();
  await branches.getByRole("option", { name: "origin/topic", exact: true }).click();
  await button(history, "File history").click();
  await history.getByRole("textbox", { name: "Path relative to the repository", exact: true }).fill("note.txt");
  await button(history, "Show history").click();
  const revisionPreview = page.getByRole("region", { name: "File revision preview", exact: true });
  const editedRevision = history.getByRole("option", { name: /Edited tracked note/ });
  const renamed = history.getByRole("option", { name: /Renamed tracked note/ });
  await editedRevision.waitFor();
  await revisionPreview.getByText("Parent revision", { exact: true }).waitFor();
  await revisionPreview.getByLabel("Side-by-side revision diff").waitFor();
  await editedRevision.press("ArrowDown");
  assert.equal(await renamed.getAttribute("aria-selected"), "true");
  await revisionPreview.getByText("old-note.txt", { exact: true }).waitFor();
  await revisionPreview.getByText("The file contents are identical.", { exact: true }).waitFor();
  await page.evaluate(() => { window.holdFileRevision = true; });
  await renamed.press("ArrowUp");
  await page.waitForFunction(() => typeof window.finishFileRevision === "function");
  await editedRevision.press("ArrowDown");
  await page.evaluate(() => { window.finishFileRevision(); window.holdFileRevision = false; });
  await revisionPreview.getByText("The file contents are identical.", { exact: true }).waitFor();
  assert.equal(await revisionPreview.getByText("Late response for another row").count(), 0);
  await button(revisionPreview, "Show revision").click();
  const revisionDocument = page.getByRole("dialog", { name: "Show revision" });
  assert.equal(await revisionDocument.getByLabel("File revision text").textContent(), "Original line");
  await revisionDocument.press("Escape");
  assert.equal(await renamed.getAttribute("aria-selected"), "true");
  await button(revisionPreview, "Compare with revision…").click();
  const fileComparison = page.getByRole("dialog", { name: "Compare with revision…" });
  await fileComparison.getByRole("combobox", { name: "Comparison revision", exact: true }).selectOption("refs/heads/main");
  await button(fileComparison, "Compare").click();
  await revisionPreview.getByText("Comparison revision", { exact: true }).waitFor();
  await revisionPreview.getByLabel("Side-by-side revision diff").waitFor();
  await button(revisionPreview, "Show parent comparison").click();
  await button(history, "Load more").click();
  await history.getByRole("option", { name: /Added original note/ }).click();
  await revisionPreview.getByText("Empty tree", { exact: true }).waitFor();
  await revisionPreview.getByText("File absent at this revision.", { exact: true }).waitFor();
  await button(history, "Show blame").click();
  const blame = page.getByRole("dialog", { name: "Git blame · Text Viewer", exact: true });
  const blameList = blame.getByLabel("Line attribution", { exact: true });
  const originLine = blame.getByRole("button", { name: /Show commit details for line 17: Prior author/ });
  await originLine.waitFor();
  await blame.getByText("Committed revision", { exact: false }).waitFor();
  const fifth = blame.locator('[data-blame-line="16"]');
  const wrappedLine = await fifth.boundingBox();
  const attribution = await fifth.getByRole("button").boundingBox();
  assert.ok(Math.abs(wrappedLine.height - attribution.height) <= 1);
  await button(blame, "Wrap lines").click();
  assert.ok((await fifth.boundingBox()).height < wrappedLine.height);
  await button(blame, "Wrap lines").click();
  await blame.getByRole("button", { name: /Show commit details for line 16: Fixture Author/ }).focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await originLine.evaluate((row) => document.activeElement === row), true);
  const blameScrollPosition = await blameList.evaluate((element) => element.scrollTop);
  await page.keyboard.press("Enter");
  await blame.getByText("Why the original note changed", { exact: true }).waitFor();
  await blame.locator("li[data-highlight]").getByText("old-note.txt", { exact: true }).waitFor();
  await button(blame, "Back to line 17").click();
  assert.equal(await originLine.evaluate((row) => document.activeElement === row), true);
  assert.equal(await blameList.evaluate((element) => element.scrollTop), blameScrollPosition);
  await button(blame, "Close").click();
  const pathToBlame = history.getByRole("textbox", { name: "Path relative to the repository", exact: true });
  await pathToBlame.fill("empty.txt");
  await button(history, "Show blame").click();
  await blame.getByText("This file has no lines.", { exact: true }).waitFor();
  await button(blame, "Close").click();
  await pathToBlame.fill("binary.txt");
  await button(history, "Show blame").click();
  await blame.getByText("This revision contains binary data.", { exact: true }).waitFor();
  await button(blame, "Close").click();
  await button(history, "File history").click();
  await button(branches, "Create tracking branch and switch").click();
  const tracking = page.getByRole("dialog", { name: "Create tracking branch and switch", exact: true });
  assert.equal(await tracking.getByRole("textbox", { name: "Branch name", exact: true }).inputValue(), "topic");
  await button(tracking, "Cancel").click();
  await filter.fill("");
  await branches.getByRole("option", { name: /main/ }).click();
  await branches.getByRole("option", { name: "origin/topic", exact: true }).click({ button: "right" });
  const remoteMenu = gitMenu("origin/topic");
  await remoteMenu.waitFor();
  const bounds = await remoteMenu.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
  await menuItem(remoteMenu, "Merge into current branch…").click();
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
  await branches.getByRole("option", { name: "origin/topic", exact: true }).click();
  await button(history, "Review changes").click();
  await history.getByText("origin/topic", { exact: true }).waitFor();
  await history.getByText("main", { exact: true }).waitFor();
  await history.getByText("Commit under review", { exact: true }).waitFor();
  await history.getByText("+forward review", { exact: true }).waitFor();
  await button(history, "Copy commit hash").click();
  assert.equal(await page.evaluate(() => window.gitCopied), "a".repeat(40));
  await button(history, "review-image.png").click();
  await history.getByText("A text diff is unavailable for binary content.", { exact: true }).waitFor();
  await button(history, "Cherry-pick commit").click();
  const pick = page.getByRole("dialog", { name: "Cherry-pick commit", exact: true });
  await pick.getByText("A text diff is unavailable for binary content.", { exact: true }).waitFor();
  await button(pick, "Cancel").click();
  assert.equal(await page.evaluate(() => window.gitEdited.action), "hardReset");
  await button(history, "Cherry-pick commit").click();
  await button(pick, "Cherry-pick commit").click();
  await button(history, "Cherry-pick in progress").waitFor();
  await button(branches, "Close Git View").click();
  await git.click();
  await history.getByText("ours fixture", { exact: true }).waitFor();
  await button(history, "Abort cherry-pick").click();
  await button(page.getByRole("dialog", { name: "Abort cherry-pick", exact: true }), "Abort cherry-pick").click();
  await history.getByText("Select a source branch to merge.", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.gitFinishedOperation), { operation: "cherryPick", abort: true });
  await button(history, "Repository tools").click();
  const worktreePath = await page.evaluate(() =>
    (/Windows/i.test(navigator.userAgent) ? "C:\\created repo\\" : "/created repo/") + "long-worktree-name-".repeat(6) + "ł");
  const linkedPath = await page.evaluate(() => /Windows/i.test(navigator.userAgent) ? "C:\\linked repo ł" : "/linked repo ł");
  await history.getByRole("textbox", { name: "Worktree path", exact: true }).fill(worktreePath);
  await history.getByRole("textbox", { name: "Branch name", exact: true }).fill("created");
  await button(history, "Create linked worktree").click();
  const createTree = page.getByRole("dialog", { name: "Create linked worktree", exact: true });
  await createTree.getByText(worktreePath, { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.gitCreatedWorktree), undefined);
  await button(createTree, "Create linked worktree").click();
  const createdTree = history.locator("li").filter({ hasText: worktreePath });
  await button(createdTree, "Remove worktree").waitFor();
  assert.equal(await page.evaluate(() => window.gitCreatedWorktree.branch), "created");
  assert.equal(await button(history, "Worktrees").getAttribute("data-tooltip"), "Show linked worktrees.");
  assert.equal(await button(history, "Worktrees").locator("svg").count(), 1);
  const removeTree = page.getByRole("dialog", { name: "Remove worktree", exact: true });
  await page.setViewportSize({ width: 580, height: 460 });
  await createdTree.getByText(worktreePath, { exact: true }).click({ button: "right" });
  await menuItem(gitMenu(worktreePath), "Remove worktree").click();
  await removeTree.waitFor();
  const reviewFields = removeTree.locator("dl > div");
  assert.deepEqual(await reviewFields.locator("dt").allTextContents(),
    ["Worktree folder to remove", "Checked-out revision", "Repository folder"]);
  assert.equal(await reviewFields.first().locator("dd").textContent(), worktreePath);
  assert.equal(await reviewFields.nth(1).locator("dd").textContent(), "created");
  const reviewBody = removeTree.locator(".dialog-body");
  assert.ok(await reviewBody.evaluate((body) => body.scrollWidth <= body.clientWidth));
  assert.ok(await button(removeTree, "Cancel").evaluate((cancel) => cancel === document.activeElement));
  await page.keyboard.press("Enter");
  await removeTree.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.gitRemovedWorktree), undefined);
  await page.setViewportSize({ width: 1120, height: 760 });
  await page.evaluate(() => { window.gitWorktreeDirty = true; });
  await button(createdTree, "Remove worktree").click();
  await button(removeTree, "Remove worktree").click();
  await history.getByRole("alert").getByText("The worktree contains local changes.").waitFor();
  assert.equal(await page.evaluate(() => window.gitRemovedWorktree), undefined);
  await page.evaluate(() => { window.gitWorktreeDirty = false; });
  await button(createdTree, "Remove worktree").click();
  await button(removeTree, "Remove worktree").click();
  await createdTree.waitFor({ state: "hidden" });
  await button(history.locator("li").filter({ hasText: linkedPath }), "Open worktree").click();
  await branches.getByText("linked repo ł", { exact: true }).waitFor();
  await button(history, "Repository tools").click();
  await button(history, "Open terminal at worktree").click();
  await page.waitForFunction((path) => window.gitTerminalDirectory === path, linkedPath);
  await button(page.getByRole("region", { name: "Terminal", exact: true }), "Close terminal").click();
  await button(history.locator("li").filter({ hasText: "Primary worktree" }), "Open worktree").click();
  await branches.getByText("repo ł", { exact: true }).waitFor();
  await button(history, "Repository tools").click();
  await button(history, "Submodules").click();
  await history.getByText("modules/local fixture", { exact: true }).waitFor();
  await button(history, "Initialize submodule").click();
  await button(page.getByRole("dialog", { name: "Initialize submodule", exact: true }), "Initialize submodule").click();
  await button(history, "Update submodule").waitFor();
  assert.equal(await page.evaluate(() => window.gitModuleUpdated), "modules/local fixture");
  await button(history, "Git LFS").click();
  await history.getByText("Git LFS is not installed.", { exact: true }).waitFor();
  await page.evaluate(() => { window.gitLfsInstalled = true; });
  await button(branches, "Refresh").click();
  await history.getByLabel("Git LFS status", { exact: true }).filter({ hasText: "LFS objects ready" }).waitFor();
  await button(history, "Fetch LFS objects").click();
  await button(page.getByRole("dialog", { name: "Fetch LFS objects", exact: true }), "Fetch LFS objects").click();
  await page.waitForFunction(() => window.gitLfsTransfer?.action === "fetch");
  assert.equal(await page.evaluate(() => window.gitLfsTransfer.remote), "origin");
  await button(history, "Bisect").click();
  await history.getByRole("combobox", { name: "Known good commit", exact: true }).fill("d".repeat(40));
  await button(history, "Start bisect").click();
  await button(page.getByRole("dialog", { name: "Start bisect", exact: true }), "Start bisect").click();
  await history.getByText("Bisect in progress", { exact: true }).waitFor();
  await button(branches, "Close Git View").click();
  await git.click();
  await button(history, "Repository tools").click();
  await button(history, "Mark bad").click();
  await button(page.getByRole("dialog", { name: "Mark bad", exact: true }), "Mark bad").click();
  await history.getByLabel("Bisect log", { exact: true }).filter({ hasText: "# first bad commit:" }).waitFor();
  await button(history, "Finish bisect").click();
  await button(page.getByRole("dialog", { name: "Finish bisect", exact: true }), "Finish bisect").click();
  await page.waitForFunction(() => window.gitBisectAction === "reset");
  const repoPath = await page.evaluate(() => /Windows/i.test(navigator.userAgent) ? "C:\\repo ł" : "/repo ł");
  const clonePath = await page.evaluate(() => /Windows/i.test(navigator.userAgent) ? "C:\\cloned repo ł" : "/cloned repo ł");
  await button(branches, "Repository setup…").click();
  const setup = page.getByRole("dialog", { name: "Repository setup", exact: true });
  await setup.getByRole("combobox", { name: "Repository action", exact: true }).selectOption("clone");
  await setup.getByRole("textbox", { name: "Repository URL or path", exact: true }).fill("https://example.invalid/origin");
  await setup.getByRole("textbox", { name: "Repository folder", exact: true }).fill(clonePath);
  await button(setup, "Review changes").click();
  const clone = page.getByRole("dialog", { name: "Clone repository", exact: true });
  await clone.getByText(clonePath, { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.gitSetup), undefined);
  await page.evaluate(() => { window.gitClonePartial = true; });
  await button(clone, "Clone repository").click();
  await setup.getByText("Git left a partial clone at " + clonePath + ".", { exact: true }).waitFor();
  await button(setup, "Review opening the partial clone").click();
  const openRepo = page.getByRole("dialog", { name: "Open existing repository", exact: true });
  await button(openRepo, "Open existing repository").click();
  await branches.getByText("cloned repo ł", { exact: true }).waitFor();
  await button(branches, "Repository setup…").click();
  await setup.getByRole("textbox", { name: "Repository folder", exact: true }).fill(repoPath);
  await button(setup, "Review changes").click();
  await button(openRepo, "Open existing repository").click();
  await branches.getByText("repo ł", { exact: true }).waitFor();
  await button(history, "Synchronize repository").click();
  await history.getByRole("combobox", { name: "Remote", exact: true }).selectOption("backup");
  await button(history, "Fetch and prune").click();
  const fetch = page.getByRole("dialog", { name: "Fetch and prune", exact: true });
  await fetch.getByText("https://example.invalid/backup", { exact: true }).waitFor();
  await button(fetch, "Fetch and prune").click();
  await history.getByLabel("Git output", { exact: true }).filter({ hasText: "Fetched updated refs" }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.gitFetch), { remote: "backup", prune: true });
  await button(history, "Upstream").click();
  await history.getByRole("combobox", { name: "Upstream branch", exact: true }).selectOption("refs/remotes/origin/topic");
  await button(history, "Set upstream").click();
  await button(page.getByRole("dialog", { name: "Set upstream", exact: true }), "Set upstream").click();
  await button(history, "Compare upstream").click();
  assert.equal(await history.getByRole("combobox", { name: "Target revision", exact: true }).inputValue(), "refs/remotes/origin/topic");
  await button(history, "Synchronize repository").click();
  await button(history, "Upstream").click();
  await button(history, "Pull by merge").click();
  await button(page.getByRole("dialog", { name: "Pull by merge", exact: true }), "Pull by merge").click();
  await history.getByText("refs/remotes/origin/topic", { exact: false }).waitFor();
  await button(history, "Create merge commit").waitFor();
  await button(history, "Synchronize repository").click();
  await button(history, "Upstream").click();
  await button(history, "Pull by rebase").click();
  await button(page.getByRole("dialog", { name: "Pull by rebase", exact: true }), "Pull by rebase").click();
  assert.equal(await history.getByRole("combobox", { name: "History action", exact: true }).inputValue(), "rebase");
  assert.equal(await history.getByRole("combobox", { name: "Rebase base", exact: true }).inputValue(), "refs/remotes/origin/topic");
  await button(history, "Synchronize repository").click();
  await button(history, "Remote references").click();
  await history.getByRole("combobox", { name: "Reference action", exact: true }).selectOption("deleteTag");
  await history.getByRole("textbox", { name: "Remote tag name", exact: true }).fill("v1");
  await button(history, "Review changes").click();
  const deleteTag = page.getByRole("dialog", { name: "Delete remote tag", exact: true });
  await deleteTag.getByText("refs/tags/v1", { exact: true }).waitFor();
  await deleteTag.getByText("b".repeat(40), { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.gitTransfer), undefined);
  await button(deleteTag, "Delete remote tag").click();
  await history.getByLabel("Git output", { exact: true }).filter({ hasText: "Updated reviewed reference" }).waitFor();
  assert.equal(await page.evaluate(() => window.gitTransfer.destination), "refs/tags/v1");
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
  const stagedNote = changes.getByRole("group", { name: "Staged", exact: true }).getByRole("option", { name: /note\.txt/ });
  await stagedNote.click({ button: "right" });
  const stagedMenu = gitMenu("Staged · note.txt");
  assert.equal(await menuItem(stagedMenu, "Unstage").isEnabled(), true);
  assert.equal(await menuItem(stagedMenu, "Stage").count(), 0);
  await page.keyboard.press("Escape");
  await edited.click({ button: "right" });
  const unstagedMenu = gitMenu("Unstaged · note.txt");
  assert.equal(await menuItem(unstagedMenu, "Stage").isEnabled(), true);
  assert.equal(await menuItem(unstagedMenu, "Unstage").count(), 0);
  await page.keyboard.press("Escape");
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
  await stashes.getByRole("button", { name: /stash@\{0\} · Fixture stash/ }).click({ button: "right" });
  await menuItem(gitMenu("Fixture stash"), "Apply stash").click();
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
        shortcutSchemes: [{ id: "fixture-swap", name: "Fixture swap", bindings: {
          swap, gitContextMenu: swap.length ? ["Ctrl+Alt+K"] : [],
        } }] }));
    }, binding);
    await page.reload();
    await right.getByRole("option", { name: /^note\.txt/ }).click();
    await git.click();
    await branches.and(page.locator(".git-pane-right")).waitFor();
    const main = branches.getByRole("option", { name: /main/, selected: true });
    await main.focus();
    await page.keyboard.press("Control+Alt+k");
    const mainMenu = gitMenu("main");
    if (binding.length) {
      await mainMenu.waitFor();
      await page.keyboard.press("Escape");
      assert.ok(await main.evaluate((row) => document.activeElement === row));
    } else {
      assert.equal(await mainMenu.count(), 0);
      await page.keyboard.press("Shift+F10");
      assert.equal(await mainMenu.count(), 0);
      await main.click({ button: "right" });
      await mainMenu.waitFor();
      await page.keyboard.press("Escape");
    }
    await filter.press(swapKey);
    assert.equal(await branches.and(page.locator(".git-pane-right")).count(), 1);
    await filter.press("Control+Alt+j");
    assert.equal(await branches.and(page.locator(binding.length ? ".git-pane-left" : ".git-pane-right")).count(), 1);
  }
  await page.evaluate(() => sessionStorage.setItem("git-file-context-fixture", "yes"));
  await page.reload();
  const noteRow = right.getByRole("option", { name: /^note\.txt/ });
  const anotherRow = right.getByRole("option", { name: /^another\.txt/ });
  const fileActions = page.getByRole("menu", { name: "File actions", exact: true });
  const gitActions = fileActions.getByRole("group", { name: "Git", exact: true });
  await noteRow.click();
  await page.evaluate(() => { window.isTauri = true; });
  await anotherRow.click({ button: "right" });
  await gitActions.waitFor();
  assert.equal(await menuItem(gitActions, "Show diff").count(), 0);
  assert.equal(await page.evaluate(() => window.fileContextRequest.name), "another.txt");
  await menuItem(gitActions, "Show history").click();
  await history.getByRole("option", { name: /Created a different file/ }).waitFor();
  assert.equal(await history.getByRole("textbox", { name: "Path relative to the repository" }).inputValue(), "another.txt");
  assert.equal(await page.evaluate(() => window.gitEvents.at(-1)), await page.evaluate(() => window.fileContextRequest.directory));
  assert.match(await page.evaluate(() => window.gitEvents.at(-1)), /nested$/);
  await button(revisionPreview, "Close Git View").click();
  await page.waitForFunction(() => document.activeElement?.id === "right-files");
  assert.equal(await anotherRow.getAttribute("data-current"), "true");
  await noteRow.click();
  await right.press("Shift+F10");
  await menuItem(gitActions, "Show blame").click();
  await blame.getByText("note.txt", { exact: true }).waitFor();
  await button(blame, "Close").click();
  await page.waitForFunction(() => document.activeElement?.id === "right-files");
  assert.equal(await noteRow.getAttribute("data-current"), "true");
  await right.press("Shift+F10");
  await menuItem(gitActions, "Compare with revision…").click();
  await fileComparison.getByRole("combobox", { name: "Comparison revision", exact: true }).selectOption("refs/heads/main");
  await button(fileComparison, "Compare").click();
  await fileComparison.getByText("Stored revision", { exact: true }).waitFor();
  await fileComparison.getByText("Working file", { exact: true }).waitFor();
  await fileComparison.getByLabel("Side-by-side revision diff").waitFor();
  await fileComparison.getByRole("combobox", { name: "Comparison revision", exact: true }).selectOption("refs/tags/v1");
  await button(fileComparison, "Compare").click();
  await fileComparison.getByText("File absent at this revision.", { exact: true }).waitFor();
  await button(fileComparison, "Close").click();
  await page.waitForFunction(() => document.activeElement?.id === "right-files");
  await noteRow.click({ button: "right" });
  await menuItem(gitActions, "Show diff").click();
  const scopedChanges = page.getByRole("region", { name: "Changes", exact: true });
  await scopedChanges.getByRole("group", { name: "Staged", exact: true }).getByRole("option", { name: /note\.txt/ }).waitFor();
  await preview.getByText("HEAD → Index", { exact: true }).waitFor();
  await scopedChanges.getByRole("group", { name: "Unstaged", exact: true }).getByRole("option", { name: /note\.txt/ }).click();
  await preview.getByText("Index → Working file", { exact: true }).waitFor();
  assert.equal(await button(preview, "Stage").count(), 0);
  assert.equal(await scopedChanges.getByRole("option").count(), 2);
  await button(scopedChanges, "Close Git View").click();
  await page.waitForFunction(() => document.activeElement?.id === "right-files");
  await page.evaluate(() => { window.holdGitFileContext = true; });
  await noteRow.click({ button: "right" });
  await page.waitForFunction(() => typeof window.finishGitFileContext === "function");
  await anotherRow.click({ button: "right" });
  await gitActions.waitFor();
  await page.evaluate(() => window.finishGitFileContext());
  assert.equal(await menuItem(gitActions, "Show diff").count(), 0);
  await menuItem(gitActions, "Show history").click();
  await history.getByRole("option", { name: /Created a different file/ }).waitFor();
  await button(revisionPreview, "Close Git View").click();
  await right.getByRole("option", { name: /^outside\.txt/ }).click({ button: "right" });
  await page.waitForFunction(() => window.fileContextRequest?.name === "outside.txt");
  if (await page.evaluate(() => /Windows/i.test(navigator.userAgent))) {
    await page.waitForFunction(() => window.nativeFileMenu?.name === "outside.txt");
  } else {
    await fileActions.waitFor();
  }
  assert.equal(await gitActions.count(), 0);
  console.log("Verified Git View, file context actions, paged history, commit details, shortcut customization, and pane restoration.");
} finally {
  await browser.close();
}
