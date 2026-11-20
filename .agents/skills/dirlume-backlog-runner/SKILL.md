---
name: dirlume-backlog-runner
description: Process open Dirlume GitHub issues created by agrynco and labeled ready for dev in one checkout, merge completed work into prerelease, and promote the batch through main to a GitHub Release. Use when asked to process the backlog as a batch through release.
---

# Run the Dirlume backlog

Use the configured GitHub remote and read [AGENTS.md](../../../AGENTS.md) and the [release workflow](../../../README.md#ci-and-releases). A request to run this skill through release authorizes the task PRs, their merges into `prerelease`, and the final promotion and release. Follow any scope or publication limit in the user's request.

## Select the next issue

- Work in the current checkout throughout. Use one issue branch at a time and preserve existing user changes. If switching branches would overwrite user work, stop and identify the affected paths. Use neither new nor existing auxiliary worktrees.
- Fetch `origin/main` and `origin/prerelease`. Confirm the prerelease branch exists and the release workflows are installed on `main` before starting.
- Build the queue from issues in the repository configured as `origin` using `is:issue is:open author:agrynco label:"ready for dev"`. Verify from current GitHub issue metadata that each issue is still open, was created by `agrynco`, and has the `ready for dev` label. Apply these checks when selecting or rechecking the queue, following dependencies, resuming work, or using an explicit issue list. Defer any issue with both `ready for dev` and `needs refinement`.
- Read enough pages to establish the full eligible queue. Take the oldest actionable issue first, using the issue number to break ties. Apply any explicit user-provided order, filter, or limit within the eligible queue.
- Read the issue and its comments before acting. Defer issues explicitly marked blocked or `Ready for Dev: No`. Work on an unresolved dependency first if it is eligible and in scope. Otherwise defer the dependent issue. Leave work already owned by another contributor with that contributor.
- Check for an existing issue branch or PR before starting. Treat the issue as staged if its task PR's squash commit is in `origin/prerelease` and has yet to reach `origin/main`. Reassess reopened issues whose previous fix has already shipped.

## Complete one issue at a time

1. Base an issue branch such as `codex/issue-95` on the latest `origin/prerelease`, or resume the existing branch for that issue in the current checkout.
2. Implement the issue, run the relevant local checks in the README, then push the branch. Create or reuse its PR into `prerelease`. Link the issue with `Refs #95` and record the checks performed. Keep issue closing keywords for the promotion PR.
3. Confirm the issue still meets the selection rules and the PR still targets `prerelease`. Squash-merge the exact checked head. Refresh `origin/prerelease` after the merge and verify that it contains the merged change. Work PRs use local checks under this workflow.
4. Re-read the backlog and repeat. If an issue hits a concrete blocker, finish independent issues and record the blocker. Preserve any unfinished changes on their own issue branch before switching tasks. Recover prior progress from branches and PRs when resuming in a later turn.

## Promote the batch and verify publication

1. Re-fetch both branches and confirm the selected queue is exhausted. If work in the selected queue is still blocked or in progress, report it and hold promotion unless the user authorizes releasing the completed subset. Check the promotion diff for staged work tied to issues. Verify each linked issue against the current selection rules and the user's requested scope, including issues absent from the queue. If the diff includes out-of-scope issue work, report it and hold automatic promotion for the user's separate handling. When `prerelease` has changes to promote, create or reuse one PR from the repository's `prerelease` into `main`. Include the staged work PRs and `Closes #…` for eligible issues fully resolved by the batch. If the batch has already merged, resume watching that release.
2. Let both GitHub Actions workflows run on the promotion PR. Wait for the required checks on the latest PR head. Diagnose failures and land fixes through `prerelease`. If the head changes, repeat the staged work check on the updated diff, refresh the issue list in the PR, and wait for the new head's checks. After checks pass, recheck the linked issues' current eligibility and scope before automatically merging using **Create a merge commit** with the expected head SHA.
3. After the merge, watch the automatic **CI and releases** run through packaging and publication. Confirm the published GitHub Release tag points to the promotion's merge commit. Use the post-merge run for recoverable retries. Report the task PRs, promotion PR, required check results, and published release, or the specific blocker if publication cannot finish.
