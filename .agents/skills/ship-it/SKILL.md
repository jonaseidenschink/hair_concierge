---
name: ship-it
description: Use when a verified Hair Concierge task branch is ready for explicitly authorized commit, push, and draft PR creation while merge and its guarded cleanup, deployment, and production writes remain separately authorized.
---

# Hair Concierge Ship

Publish an already verified, reviewed branch. Do not duplicate verification or review without evidence that the tree changed.

## Preconditions

- The user has explicitly authorized the requested publication actions.
- A fresh `ready-check` receipt and `request-code-review` receipt identify the same canonical content fingerprint.
- No verified blocking finding remains.
- Every task-owned artifact is classified as commit, archive, or discard.
- If content changed after either receipt, refresh the affected receipt before proceeding. Staging or committing byte-identical reviewed content does not invalidate a receipt.
- If `supabase/migrations/**` changed, identify the migration IDs and check the target project migration state before merge.

## Default path

1. Verify intended files, current branch/base, receipts, residual risk, and the already authorized stop point. An explicit shipping request needs no second confirmation for the same actions.
2. Stage only the intended changes.
3. Create a concise conventional commit for intended uncommitted changes. Reuse existing reviewed commits when the content is already committed; do not create an empty replacement commit.
4. Recompute the content fingerprint and prove the commit contains exactly the reviewed content.
5. Require a clean task worktree.
6. Push the task branch.
7. Open a draft PR by default.

## Boundaries

- “Ship it” authorizes commit, push, and draft PR creation only. Merge (including its guarded cleanup), deployment, and production writes are distinct authorizations; follow `AGENTS.md` for their exact boundaries.
- Before merge, refresh GitHub PR/CI state and ensure review covers the final diff.
- Never waive final review for migrations, auth, billing, payments, privacy/security, incidents, or broad user-facing behavior.
- Never infer deployment from push, PR, or merge.

## Separately authorized merge

Follow `AGENTS.md`'s **Merge and finish** contract, including exact reviewed-head checks, author-specific approval rules, migration ordering, merge verification, and guarded cleanup. Nick's explicit “merge it” includes the finisher dry run and apply when every guard passes; do not ask again for those same actions. Preserve the explicit retention exception. If cleanup refuses, preserve state and report the blocker. No deployment or production write is implied. Standalone cleanup still requires explicit authorization and the applicable ownership guards.

## Supabase migrations

- Production project: `pqdkhefxsxkyeqelqegq`.
- Report whether each changed migration is applied, applied during shipping, or unapplied.
- If application code would deploy before an unapplied required migration, stop before merge unless the user explicitly chooses the safe migration-first sequence.
- If migration history is divergent, do not run a blind `supabase db push`; report the state and use a surgical migration plan.

Completion criterion: every authorized action succeeded, no broader action was inferred, and cleanup did not discard state.
