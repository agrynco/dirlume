---
name: dirlume-backlog-runner
description: Process open Dirlume GitHub issues in the project board's Ready column, merge completed work into prerelease, and promote the batch through main to a GitHub Release.
---

# Run the Dirlume backlog

Use the configured GitHub remote and read [AGENTS.md](../../../AGENTS.md) and the [release workflow](../../../README.md#ci-and-releases). A request to run this skill through release authorizes the task PRs, their merges into `prerelease`, and the final promotion and release. Follow any scope or publication limit in the user's request.

## Select the next issue

- Work in the current checkout throughout. Use one issue branch at a time and preserve existing user changes. If switching branches would overwrite user work, stop and identify the affected paths. Use neither new nor existing auxiliary worktrees.
- Fetch `origin/main` and `origin/prerelease`. Confirm the prerelease branch exists and the release workflows are installed on `main` before starting.
- Open the authenticated [DirLume project board](https://github.com/users/agrynco/projects/12/views/1) or query its GitHub Projects items. Use the project's `Status` field as the source of readiness. Include every open, unarchived issue from the repository configured as `origin` whose status is `Ready`, regardless of author. Read all result pages or cards in the column.
- Take the oldest actionable issue first, using the issue number to break ties. Apply any explicit user-provided order, filter, or limit. Record membership in the Ready queue when taking an issue. When resuming, use the known issue branch or task PR and its project card to recover selected work that the workflow has moved to `In progress`, `In review`, or `prerelease`.
- Read the issue and its comments before acting. Defer issues explicitly marked blocked or `Ready for Dev: No`. Work on an unresolved dependency first if it is eligible and in scope. Otherwise defer the dependent issue. Leave work already owned by another contributor with that contributor.
- Check for an existing issue branch or PR before starting. Treat the issue as staged if its task PR's squash commit is in `origin/prerelease` and has yet to reach `origin/main`. Reassess reopened issues whose previous fix has already shipped.

## Check the Ready queue every 10 minutes

- After the initial board scan, start a 10-minute timer in the active run. Re-read the entire Ready column at each tick and reset the timer. Keep polling during issue work, promotion checks, packaging, and idle periods after publication. Stop when the user asks or the requested run limit is reached. Break up long waits so they leave time for the next scan. Also scan immediately before opening or merging a promotion PR and before retrying publication. Require a successful scan before treating the queue as empty.
- Apply the existing eligibility, ownership, dependency, and ordering rules to new Ready issues. Finish the issue already in progress before taking another. If a new actionable issue is found before the promotion PR merges, pause promotion and process the issue in the current batch. Keep the promotion PR open. After the new task PR merges into `prerelease`, refresh the promotion PR and wait for checks on its updated head.
- If the promotion PR has already merged, check whether its GitHub Release is published. While the release is still unpublished, cancel only the automatic publication run for that merge and verify that it stopped before publication. Hold further promotion until that run's outcome is known. After cancellation, process the new issue and create a fresh promotion. Carry the unpublished changes and their highlights into the new candidate. Preserve the merged history and leave any already-created tag intact. If an existing tag blocks the new candidate, report that blocker.
- If publication finishes before cancellation takes effect, verify and report the published release. Process the new issue in the next batch in the normal order. Apply the same next-batch flow to issues first found after publication.

## Complete one issue at a time

For every issue that changes the frontend, use the `$ui-ux-pro-max` skill to guide implementation and verify the result in the running interface. This also applies to frontend changes within full-stack issues.

Use automated verification for every scenario it can cover. For multi-device and remote-source workflows, prefer isolated local instances, disposable servers, or protocol fixtures. Record what the checks exercised and any gaps. Manual verification is optional and does not block a task or release. Keep genuine prerequisite failures and required CI checks as blockers.

1. Base an issue branch such as `codex/issue-95` on the latest `origin/prerelease`, or resume the existing branch for that issue in the current checkout. Publish a new issue branch when work starts so the project workflow can mark the issue In progress.
2. Implement the issue, run the relevant local checks in the README, then push the branch. Create or reuse its PR into `prerelease`. Link the issue with `Refs #95` and record the checks performed. Keep issue closing keywords for the promotion PR.
3. Confirm the issue is still open and in the selected scope, and the project card is in Ready or in the expected workflow phase for its linked branch or PR. Verify that the PR still targets `prerelease`. Squash-merge the exact checked head. Refresh `origin/prerelease` after the merge and verify that it contains the merged change. Work PRs use local checks under this workflow.
4. Re-read the Ready column and repeat. If an issue hits a concrete blocker, finish independent issues and record the blocker. Preserve any unfinished changes on their own issue branch before switching tasks.

## Promote the batch and verify publication

1. Re-fetch both branches and confirm the selected queue is exhausted. If selected work is still blocked or in progress, report it and hold promotion unless the user authorizes releasing the completed subset. Check each issue linked in the promotion diff against the selected or recovered batch and the user's requested scope. An issue staged for release should be open and in `prerelease` with its task PR merged into that branch. If the diff includes out-of-scope issue work, report it and hold automatic promotion for the user's separate handling. Create or reuse one PR from the repository's `prerelease` into `main` with the staged work PRs and `Closes #…` for issues fully resolved by the batch. If the batch has already merged, resume watching that release.
2. Let both GitHub Actions workflows run on the promotion PR. Wait for the required checks on the latest PR head and keep scanning Ready while waiting. Diagnose failures and land fixes through `prerelease`. If the head changes, repeat the staged work check on the updated diff, refresh the issue list in the PR, and wait for the new head's checks. After checks pass, scan Ready again and recheck the linked issues' current eligibility and scope. If the queue is clear, merge using **Create a merge commit** with the expected head SHA.
3. After the merge, watch the automatic **CI and releases** run and continue checking Ready through packaging and publication. Confirm the published GitHub Release tag points to the promotion's merge commit. Use the post-merge run for recoverable retries while that candidate is still current. Report the task PRs, promotion PR, required check results, and published release, or the specific blocker if publication cannot finish.
