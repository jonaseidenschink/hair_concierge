---
name: code-reviewer
description: Use when explicitly invoked or selected by request-code-review to inspect a diff, staged change, commit, or branch for correctness, regressions, security/privacy, data integrity, and missing tests. Do not use as an automatic extra review merely because code changed.
---

# Code Reviewer

## Overview

Perform a high-signal code review on the requested change set. Treat review as risk discovery, not polish. Start from the actual diff, read changed files in context, and surface only issues that are likely to matter in production or maintenance.

Follow applicable `AGENTS.md` instructions and local guidance governing the changed paths. Consult `CLAUDE.md` for Claude-side execution or explicitly relevant context; its tool and session procedures do not apply to Codex. Reuse instructions already loaded and unchanged in this task.

## Inputs

Prefer one of these scopes, in order:

- Explicit diff or PR range from the user
- Current branch diff against its base, usually `git diff main...HEAD`
- Current uncommitted changes via `git diff HEAD`
- Staged changes via `git diff --cached`

If scope is ambiguous, choose a reasonable default and state what you reviewed.

## Workflow

1. Determine the review scope.
   - Run `git status --short --branch`
   - Run `git diff --stat <scope>`
   - Run `git diff --name-only <scope>`
2. Read the changed files in context. Do not review filenames or hunks in isolation if surrounding code changes the meaning.
3. Build a risk map with this priority order:
   - Runtime correctness and regressions
   - Security, privacy, secrets, and auth
   - Data integrity, migrations, and schema coupling
   - API contracts and UI behavior changes
   - Concurrency, caching, and performance cliffs
   - Test gaps and rollback risks
4. Read nearby tests, helpers, types, or call sites when the change depends on shared behavior.
5. Mention style or refactor opportunities only when they hide a real defect or a concrete maintenance risk.
6. If a concern is plausible but not yet verified, label it as an open question instead of overstating it.

## Severity

- Critical: likely runtime breakage, security exposure, data loss, or irreversible bad state
- High: strong chance of user-facing bug, broken edge case, or contract mismatch
- Medium: meaningful maintainability or test gap with a plausible failure path
- Low: non-blocking risk worth fixing soon

## Output Format

Start with findings. Keep the overview short.

### Findings

- `[{severity}] <title>` - include a tight file reference, explain the failure mode, and say why it matters
- Order by severity, then confidence
- If there are no material issues, say `No blocking findings.`

### Open Questions / Assumptions

- Include only items that materially affect confidence

### Residual Risks

- Note missing tests, unverified migrations, environment assumptions, or areas you could not exercise

### Short Summary

- End with a 1-3 sentence ship-readiness summary

## Review Rules

- Be skeptical, not adversarial
- Do not invent bugs without a causal explanation
- Do not dilute the review with broad rewrites
- Prefer fewer, sharper findings over exhaustive commentary
- If the user asked for a review, default to findings-first and bug/risk focus
- If the user asks for fixes after the review, hand off a concise fix list

## Examples

- `Use $code-reviewer to review the current diff against main for correctness, regressions, security, and missing tests.`
- `Use $code-reviewer on the staged changes and call out only high-confidence issues.`
- `Use $code-reviewer to check whether the fix resolves the original bug without introducing auth or data regressions.`
