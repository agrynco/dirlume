---
name: dirlume-issue-writer
description: Draft or create Dirlume GitHub issues from user context. Use for new features, improvements to existing behavior, and bug reports in agrynco/dirlume.
---

# Write a Dirlume GitHub issue

Read [AGENTS.md](../../../AGENTS.md). Write a concise, specific title and an English Markdown body with one coherent outcome. Use Dirlume's actual UI and command names. Read the relevant documentation or code if it would clarify current behavior or scope. Check the default branch for applicable GitHub issue templates or forms. Use their fields and defaults when available. Otherwise, use the sections below.

| Category | When it applies | Body sections | Usual label |
| --- | --- | --- | --- |
| New feature | Adds a capability users cannot perform in Dirlume today. | **Problem**, **Requested behavior**, **Acceptance criteria** | `enhancement` |
| Improvement | Changes how an existing capability works or feels. | **Current behavior**, **Requested behavior**, **Acceptance criteria** | `enhancement` |
| Bug | Existing, documented, or intended behavior fails. | **Steps to reproduce**, **Actual behavior**, **Expected behavior**. Include **Environment** or **Regression** when details are available. | `bug` |

- For a feature, describe who needs the capability, what it enables, and where the first version ends if scope matters. For an improvement, describe what changes in the existing workflow and any behavior important to preserve.
- For a bug, number known reproduction steps. Include relevant preconditions, OS, Dirlume version, frequency, and the last known working version when supplied or verified. Identify missing details that affect diagnosis and distinguish a reported symptom from a verified cause.
- Make acceptance criteria observable. Use GitHub task-list checkboxes for feature and improvement criteria. For bugs, make the expected result verifiable from the reproduction steps and add separate acceptance criteria when additional regression cases matter.
- Apply Dirlume's development instructions where relevant. Cover affected platforms, configurable shortcuts, shared UI components, or a KSwitcher Files parity checklist update when the request touches them. Link related GitHub work and include supplied evidence after removing credentials, personal information, and private paths. Ask for clarification when a missing detail would substantially change the scope or expected result.

## Check and publish

1. Target `agrynco/dirlume`. Search open and closed issues using the affected UI, action, or symptom. If an existing issue already covers the same work, return its link. If the context establishes a distinct follow-up or a recurrence after a fix, explain the difference and link the earlier issue.
2. Use verified repository labels and any applicable template defaults. Use the existing `enhancement` label for both new features and improvements. Apply additional metadata only when supported by the template, repository conventions, or the user's request.
3. When the user asks to create or file an issue, publish it using the GitHub connector, or authenticated `gh` if the connector is unavailable. If the user asks for a draft or supplies context without authorizing publication, return the title, Markdown body, and proposed label in chat. Publishing an issue does not authorize edits to other issues or work on the implementation.
4. Verify the saved issue and return its number, URL, and applied label. If the create result is unclear, search for the title before retrying. If publication is blocked, return the draft and identify the blocker.
