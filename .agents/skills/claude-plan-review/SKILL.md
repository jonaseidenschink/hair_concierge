---
name: claude-plan-review
description: Delegate implementation plan/spec reviews or code reviews to the local Claude Code CLI. Use when the user asks Codex to get Claude's second opinion on a plan, review a plan with Claude, sanity-check a plan via Claude, ask Claude to review a diff/branch/commit/file, or avoid copy-pasting review context into Claude Code manually.
---

# Claude Review Bridge

## Overview

Use this skill to ask the local `claude` CLI for a structured second opinion, then summarize the result for the user.

- Plan/spec mode bridges to the user's Claude Code `reviewing-plans` skill.
- Code-review mode asks Claude to act as a senior code reviewer over a diff, branch, commit, file, directory, or current worktree.

## Workflow

### Shared setup

1. Confirm the local Claude CLI is available with `claude --version`.
2. Check billing/auth risk before running:
   - If `ANTHROPIC_API_KEY` is set in the shell, tell the user Claude Code may use API billing instead of Claude.ai subscription usage.
   - If it is unset, mention that the shell is not obviously configured for API-key billing.

### Plan/spec review

1. Resolve the requested plan path. Plans usually live under `plans/`, but accept any markdown file the user names.
2. The bundled script requires the reviewer to inspect Decision coverage against `.agents/skills/plan-hardening-loop/SKILL.md` and its plan-format reference: complete buckets, original user acknowledgement/request and approved scope, separate internal revalidation, hidden consequential assumptions, and any new choice that still needs Nick. Review is read-only and terminal; do not dispatch another reviewer.
3. From the repository root, run the script. Repository plan reviews default to the system temporary directory; pass an output path only when the review is intentionally retained:

```bash
./.agents/skills/claude-plan-review/scripts/claude-plan-review.sh <plan-file>
```

To choose the output path:

```bash
./.agents/skills/claude-plan-review/scripts/claude-plan-review.sh <plan-file> <output-file>
```

Optional environment controls:

```bash
CLAUDE_PLAN_REVIEW_MODEL=opus CLAUDE_PLAN_REVIEW_EFFORT=high CLAUDE_PLAN_REVIEW_TIMEOUT=900 ./.agents/skills/claude-plan-review/scripts/claude-plan-review.sh <plan-file>
```

4. Read the generated review and summarize the highest-signal findings. Do not paste the full report unless the user asks.

### Code review

1. Resolve the requested review target:
   - Omitted target: current worktree and branch diff.
   - Git ref/range/commit/branch: ask Claude to inspect the relevant diff.
   - File/directory: ask Claude to inspect the code and likely callers.
   - Free-form scope: pass the user's wording through as the target.
2. From the repository root, run the script in code mode:

```bash
./.agents/skills/claude-plan-review/scripts/claude-plan-review.sh --code
```

With an explicit target:

```bash
./.agents/skills/claude-plan-review/scripts/claude-plan-review.sh --mode code origin/main...HEAD
```

To choose the output path:

```bash
./.agents/skills/claude-plan-review/scripts/claude-plan-review.sh --code origin/main...HEAD reviews/branch.claude-code-review.md
```

Optional environment controls:

```bash
CLAUDE_CODE_REVIEW_MODEL=opus CLAUDE_CODE_REVIEW_EFFORT=high CLAUDE_CODE_REVIEW_TIMEOUT=900 ./.agents/skills/claude-plan-review/scripts/claude-plan-review.sh --code origin/main...HEAD
```

3. Read the generated review and summarize only actionable findings, test gaps, and residual risks. Treat "no findings" as useful signal, but do not overstate it.

## Output

By default plan mode writes to the system temporary directory:

```text
/tmp/claude-plan-review-example-<pid>.md
```

By default code-review mode writes to the system temporary directory:

```text
/tmp/claude-code-review-<repo>-<pid>.md
```

Treat Claude's report as advisory. Keep Codex responsible for deciding whether the plan/code should change, whether local evidence supports the critique, and what to do next.

## Notes

- Plan mode uses Claude Code non-interactive mode with the prompt `/reviewing-plans`.
- Code-review mode uses a direct senior-review prompt and does not require a Claude-side skill.
- Do not use `--bare`; Claude Code documents that bare mode ignores OAuth/keychain auth and relies on API-key style credentials.
- By default the wrapper pins reviews to Claude Opus 4.8 (`claude-opus-4-8`). Override globally with `CLAUDE_REVIEW_MODEL`, or per mode with `CLAUDE_PLAN_REVIEW_MODEL` / `CLAUDE_CODE_REVIEW_MODEL`.
- Automatic fallback is disabled by default so a review does not silently run on a weaker model. If availability is more important than strict model quality, opt in with `CLAUDE_REVIEW_FALLBACK_MODEL`, `CLAUDE_PLAN_REVIEW_FALLBACK_MODEL`, or `CLAUDE_CODE_REVIEW_FALLBACK_MODEL`.
- The default Claude effort is `high`. The wrapper normalizes an inherited `xhigh` override back to `high`; review runs must not use extra-high effort.
- The default timeout is 15 minutes. If a large plan or diff times out, rerun with a higher `CLAUDE_PLAN_REVIEW_TIMEOUT` or `CLAUDE_CODE_REVIEW_TIMEOUT`.
- The Claude-side skill is expected at `~/.claude/skills/reviewing-plans/SKILL.md`. If Claude reports the skill is missing, inspect that path or ask the user whether it moved.
