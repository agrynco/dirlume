---
name: dirlume-backlog-runner
description: Run the Dirlume GitHub Issues backlog sequentially in one checkout, merge completed tasks into prerelease, and promote the completed batch through main to a GitHub Release. Use when asked to process the backlog as a batch through release.
---

# Run the Dirlume backlog

Use the configured GitHub remote and read [AGENTS.md](../../../AGENTS.md) and the [release workflow](../../../README.md#ci-and-releases). A request to run this skill through release authorizes the task PRs, their merges into `prerelease`, and the final promotion and release. Follow any scope or publication limit in the user's request.

## Select the next issue

- Work in the current checkout throughout. Use one issue branch at a time and preserve existing user changes. If switching branches would overwrite user work, stop and identify the affected paths. Use neither new nor existing auxiliary worktrees.
- Fetch `origin/main` and `origin/prerelease`. Confirm the prerelease branch exists and the release workflows are installed on `main` before starting.
- Use open issues in the repository configured as `origin`. Read enough pages to establish the full queue. Take the oldest actionable issue first, using the issue number to break ties. Honor an explicit user-provided order, filter, or limit.
- Read the issue and its comments before acting. Defer issues explicitly marked blocked or `Ready for Dev: No`, and work on a dependency first when it is also in scope. An issue with clear acceptance criteria can be actionable without a readiness label. Leave work already owned by another contributor with that contributor.
- Check for an existing issue branch or PR before starting. Treat the issue as staged if its task PR's squash commit is in `origin/prerelease` and has yet to reach `origin/main`. Reassess reopened issues whose previous fix has already shipped.

## Complete one issue at a time

1. Base an issue branch such as `codex/issue-95` on the latest `origin/prerelease`, or resume the existing branch for that issue in the current checkout.
2. Implement the issue, run the relevant local checks in the README, then push the branch. Create or reuse its PR into `prerelease`. Link the issue with `Refs #95` and record the checks performed. Keep issue closing keywords for the promotion PR.
3. Confirm the PR still targets `prerelease` and squash-merge the exact checked head. Refresh `origin/prerelease` after the merge and verify that it contains the merged change. Work PRs use local checks under this workflow.
4. Re-read the backlog and repeat. If an issue hits a concrete blocker, finish independent issues and record the blocker. Preserve any unfinished changes on their own issue branch before switching tasks. Recover prior progress from branches and PRs when resuming in a later turn.

## Promote the batch and verify publication

1. Re-fetch both branches and confirm the selected queue is exhausted. If work in the selected queue is still blocked or in progress, report it and hold promotion unless the user authorizes releasing the completed subset. When `prerelease` has changes to promote, create or reuse one PR from the repository's `prerelease` into `main`. Include the staged work PRs and `Closes #…` for issues fully resolved by the batch. If the batch has already merged, resume watching that release.
2. Let both GitHub Actions workflows run on the promotion PR. Wait for the required checks on the latest PR head. Diagnose failures and land fixes through `prerelease`. If the head changes, review the updated diff, refresh the issue list in the PR, and wait for the new head's checks. When checks pass, automatically merge using **Create a merge commit** and provide the expected head SHA.
3. After the merge, watch the automatic **CI and releases** run through packaging and publication. Confirm the published GitHub Release tag points to the promotion's merge commit. Use the post-merge run for recoverable retries. Report the task PRs, promotion PR, required check results, and published release, or the specific blocker if publication cannot finish.
