---
name: dirlume-contributor
description: Follow the Dirlume contributor workflow for GitHub issues, the project board, issue branches, task pull requests, and release handoff in agrynco/dirlume. Use when onboarding a contributor or working on a Dirlume task.
---

# Contribute to Dirlume

Work from a checkout of [agrynco/dirlume](https://github.com/agrynco/dirlume) and use [the Dirlume project board](https://github.com/users/agrynco/projects/12/views/1). Paths below are relative to the repository root, including when this skill is installed elsewhere. Read `AGENTS.md` for development rules and the Build and CI and releases sections of `README.md` for current checks and automation. Write issues, pull requests, commits, documentation, release notes, and product text in English.

## Pick up an issue

- Read the issue, its acceptance criteria, and its project card. When selecting from the backlog, use the board's `Status` field and pick an open, unarchived issue in `Ready`. Check for an existing issue branch or pull request and coordinate with whoever is already working on it.
- When drafting or updating an issue, follow `.agents/skills/dirlume-issue-writer/SKILL.md` if available. Use the applicable type label (`new feature`, `enhancement`, or `bug`) and one readiness label. Apply `ready for dev` when the scope and verification criteria are clear. Use `needs refinement` when a concrete open question blocks work and record what needs to be resolved.
- Let the board automation advance the card. `ready for dev` moves a queued issue to `Ready`. A published `codex/issue-N` branch or draft task PR signals `In progress`. A task PR ready for review signals `In review`. A merge into `prerelease` moves the card to `prerelease`, and closing the issue moves it to `Done`.

## Deliver a task

1. Fetch `origin/prerelease`. Start an issue branch such as `codex/issue-123` from the latest `origin/prerelease` or resume the existing branch. Publish the branch when work starts so the board can track it.
2. Follow `AGENTS.md` for platform compatibility, configurable shortcuts, shared UI, Help translations, and the KSwitcher Files migration checklist where applicable.
3. Run the relevant local checks documented in `README.md`. Push the branch and open or reuse a task PR targeting `prerelease`. Include `Refs #123` for an issue-linked PR, a summary, and the checks actually run. Reserve closing keywords for the release PR.
4. Once ready, use a squash merge into `prerelease` if the contributor has permission and the task includes merging. Otherwise hand off the PR for review or merge. Report the PR link, checks, and current status.

## Release handoff

A task merged into `prerelease` is staged. A separately requested release uses a `prerelease` to `main` PR. Link fully resolved issues with `Closes #N`, wait for the required GitHub Actions checks on the latest PR head, and use a merge commit. GitHub Actions publishes the release. For an expressly requested batch run, use the repository's `.agents/skills/dirlume-backlog-runner/SKILL.md` when available.
