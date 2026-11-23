# Dirlume development

- Write GitHub issues, pull requests, commit messages, documentation, release notes, and user-facing text in English.
- Use the Tauri, Rust, React, and TypeScript project in this repository. Keep the Windows, Ubuntu, and macOS targets working.
- Register application shortcuts in `src/preferences.ts` so every command binding can be changed or disabled in Options. Use the shared color tokens and dialog component for new windows and dialogs.
- Update [the migration checklist](docs/migration.md) when a KSwitcher Files feature reaches a new stage of parity.
- When a task adds or changes user-facing behavior, update the relevant built-in Help topics in every supported language in the same pull request.
- For implementation tasks, default to a work branch based on the latest `origin/prerelease` and a pull request targeting `prerelease`.
- When the task is complete, run the relevant local checks in [the README](README.md), push the work branch, open the pull request, and squash-merge it into `prerelease` once ready. Link the task in the pull request when the user has provided a reference. GitHub Actions runs the full checks on the release pull request.
- Open a separate `prerelease` → `main` pull request to release a batch. Confirm its required GitHub Actions checks before merging. Use a merge commit to preserve the shared branch history. GitHub Actions publishes the release after the merge.
- Follow the [Dirlume Issue Writer](.agents/skills/dirlume-issue-writer/SKILL.md) conventions for issue types and readiness when drafting, publishing, or revising Dirlume GitHub issues.
- Use [$dirlume-backlog-runner](.agents/skills/dirlume-backlog-runner/SKILL.md) when asked to process the GitHub backlog through release as one batch. Run that skill in the current checkout without worktrees.
