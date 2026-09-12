---
name: ship
description: Publish an explicitly authorized, verified Hair Concierge branch through commit, push, and draft PR creation.
---

# Ship

Apply `AGENTS.md` and `.agents/skills/ship-it/SKILL.md` as the publication contracts. This is a publish-only adapter, not another implementation or verification pipeline.

## Establish publication readiness

- Inspect the task branch/base, committed and uncommitted changes, task-owned untracked artifacts, and existing PR state. A clean worktree may contain reviewed commits that still need pushing or a PR; do not infer “nothing to ship” from an empty working diff.
- Verify the user explicitly authorized the requested publication actions. An explicit “ship it” includes commit, push, and draft PR creation without a second confirmation. Legacy `--yes` adds no broader authority; `--light`, `--standard`, or `--full` do not waive the canonical gates.
- Require applicable `ready-check` and `request-code-review` receipts identifying the same canonical content fingerprint, no verified blocking finding, and resolved task-artifact disposition. If evidence is absent or stale, return to the owning workflow; perform only checks/repairs already authorized, and preserve the publishing request for when its gates pass.

## Publish

Follow the `ship-it` default path: stage only intended files, commit the reviewed content when needed, verify the commit fingerprint, require a clean task worktree, push its branch, and create or update its draft PR. Preserve user-provided commit/PR wording where applicable. Do not reset/unstage unrelated files, simplify code, or add review/evaluation stages just because publishing was invoked. Repository hooks and required CI still apply.

## Stop and hand off

Stop after the authorized publication actions. Report branch, reviewed content identity, commit, PR, checks considered, and any exact blocker. Never infer deployment, production writes, or merge from a push.

A later “merge it” is handled by the main session under `AGENTS.md`'s reviewed-head, author-specific approval, migration, merge-verification, and guarded-finisher rules. That authorization includes finisher dry run and apply when all guards pass. Preserve explicit retention and cleanup-refusal behavior; do not substitute direct removal.
