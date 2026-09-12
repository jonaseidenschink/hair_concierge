---
name: branch-gate
description: Establish Git/worktree ownership before repository mutations, or inspect branch/worktree state when explicitly requested. Reuse a current gate decision until ownership or Git state changes.
---

# Branch Gate

## Purpose

Prevent accidental mixing of unrelated work. Before mutating a Git repo, inspect the current branch, dirty state, upstream, worktrees, stashes, and likely base branch; then choose whether to continue, create a branch, create a worktree, or pause for user intent.

## Quick Check

From the repository root, run the bundled read-only snapshot first:

```bash
./.agents/skills/branch-gate/scripts/git-state.sh
```

`git-dir != git-common-dir` identifies a linked worktree. `--show-superproject-working-tree` separately identifies submodule context and repository ownership. Treat detached HEAD as externally managed unless branch creation is authorized.

If the script is unavailable, run the equivalent read-only checks:

```bash
git status --short --branch
git branch -vv --all
git worktree list
git stash list
```

Use `git fetch --all --prune` before merge/rebase/PR decisions or when remote freshness matters. Fetch mutates Git metadata, so mention it as the first write-like step.

If the repo uses a root `main` checkout plus feature worktrees, treat the root checkout as the stable base:

- keep root `main` clean;
- fast-forward it before starting new work;
- branch/worktree creation should prefer fresh `origin/main`, not a stale local base.

Typical root-base refresh:

```bash
git fetch --all --prune
git switch main
git pull --ff-only
```

## Decision Rules

- **Current branch is `main` or another protected/base branch:** create or switch to a feature branch before edits unless the user explicitly asked to work on that branch.
- **Current branch is root `main` and it is behind its upstream:** fast-forward it with `git pull --ff-only` before creating a branch or worktree, unless local uncommitted files would be overwritten.
- **Worktree is dirty:** classify changes before editing. Continue only if the dirty changes are clearly part of the same task; otherwise preserve them and create a separate worktree. Commit or stash unrelated changes only when explicitly authorized.
- **User asks to start unrelated work while current branch has in-progress work:** prefer a new worktree over switching branches.
- **New task:** follow this repository's worktree policy and `npm run worktree:new -- <slug>`; a clean checkout alone does not override the root-main/worktree boundary.
- **Parallel feature streams, long-running experiments, PR review while preserving current state, or messy branch reconciliation:** prefer a worktree.
- **Existing branch already matches the task:** switch to it only if the current worktree is clean or the dirty changes are safely handled.
- **Untracked files exist:** inspect and classify them. Add ignores for repeatable local artifacts; preserve unique docs/data/code unless the user explicitly chooses deletion.
- **Stale worktrees appear:** run `git worktree prune --dry-run --verbose` before pruning. Prune only metadata for missing paths.
- **Branch deletion:** use the repository's guarded `worktree:finish` contract for the exact authorized merged task. Merged or patch-equivalent content alone does not establish cleanup ownership or authority; other deletion needs explicit authorization.

## Repository worktree procedure

Reuse the task worktree when ownership is clear. Create a separate worktree when:

- the current branch has unrelated uncommitted or partially committed work;
- the user wants to switch to a different task without disturbing the current one;
- a PR/review/fix should be isolated from a long-running branch;
- you need to compare or integrate separate branches side by side.

Use `npm run worktree:new -- <slug>` from the root checkout; let the helper enforce base freshness and setup. Do not improvise a second location or cleanup procedure when its guards refuse.

After an authorized merge, follow `AGENTS.md`'s exact `worktree:finish` procedure, including dry run, retention exceptions, and refusal handling. Do not substitute direct worktree removal or patch-equivalence for that contract.

## Sync Habit

When a repository follows a "root `main` + feature worktrees" model:

- Before new implementation work: refresh root `main`, then branch from `origin/main`.
- After a PR merge: refresh root `main` again with `git pull --ff-only`.
- Only clean up merged worktrees or branches after the base checkout is current, so merged-vs-unmerged decisions are based on fresh remote state.

## Response Habit

Before edits, state the gate decision in one short update:

- current branch and cleanliness;
- chosen path: continue, new branch, new worktree, or pause;
- reason, especially if preserving unrelated user work.

After cleanup or integration, finish with:

```bash
git status --short --branch
git branch -vv --all
git worktree list
```
