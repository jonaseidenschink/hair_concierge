---
name: request-code-review
description: "Use for a final, pre-merge, or explicitly requested code review of a diff, commit, or branch. This is the repository's single review router: it always runs the normal correctness lens and adds a structural maintainability lens only when risk signals justify it."
---

# Request Code Review

Run one findings-first review gate on the exact proposed tree. Do not stack separate general review skills outside this router.

## 1. Freeze the review identity

Collect branch/base, committed diff, staged/unstaged changes, and all task-owned untracked files. Record a canonical content fingerprint: SHA-256 of a sorted manifest containing each in-scope path relative to the base plus its current content hash or `DELETED`. Read changed files in context and load repository instructions.

Choose scope in this order: explicit user scope, branch upstream/base, then `origin/main`. State whether review covers committed changes, uncommitted changes, or both.

Completion criterion: no in-scope change is silently omitted and the reviewed tree can be identified later.

## 2. Run the normal lens

Apply `code-reviewer` for correctness, regressions, security/privacy/auth, data integrity, API/UI contracts, and missing tests.

When reviewer delegation is explicitly authorized by the user or repository instructions, a read-only reviewer may run this bounded lens. Otherwise run it in the main session.

## 3. Decide whether structural review is needed

Add `thermo-nuclear-code-quality-review` only when one or more signals are present:

- meaningful architecture, workflow, state-model, migration, orchestration, concurrency, caching, or type-boundary change
- new route/service/major component or broad shared-module changes
- repeated conditionals, modes, feature flags, fallbacks, casts, or abstraction growth
- roughly 4+ source files, 150+ changed lines, a changed file approaching 700 lines, or a file approaching 1,000 lines
- explicit request for a harsh structural review

Skip it for docs/copy/comments-only changes, isolated tests, or a small localized fix without shared architecture impact. State the decision and signal; do not run it merely because it exists.

## 4. Verify and integrate findings

Merge duplicates, inspect every material finding locally, reject false positives, and distinguish hard defects from design tradeoffs. Do not silently turn a reviewer's product, scope, architecture, or risk preference into the user's decision.

Read all findings before editing; clarify related ambiguity before partial fixes. For proposals that expand infrastructure, abstraction, or behavior, confirm actual call sites and reject unused machinery as YAGNI. Apply supported fixes in coherent, focused-check batches only when implementation or repair is already authorized. A standalone review returns findings and does not authorize edits. Record rejected or deferred rulings.

## Refresh after findings

When a supported finding is fixed, compare the new content fingerprint with the prior reviewed fingerprint. Review the delta, affected callers/contracts, and affected tests; reuse unchanged lane conclusions. Run the full normal and structural routing again only when the fix materially changes scope, architecture, data flow, permissions, or the original review assumptions.

## Output receipt

Start with findings ordered by severity and confidence. Include:

- review scope, base, and canonical content fingerprint
- review lanes run and why
- actionable findings with file references, failure mode, impact, and direction
- open assumptions that change confidence
- artifact disposition and unresolved task-owned files
- verification considered and residual risk
- bottom line: ready, fixes required, or structural decision required

If clean, say `No blocking findings.` The receipt is stale only when reviewed content changes, not when identical content is staged or committed.
