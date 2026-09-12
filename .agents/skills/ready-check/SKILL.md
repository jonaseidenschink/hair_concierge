---
name: ready-check
description: Use when a Hair Concierge change has been implemented and needs repo-specific verification of decision coverage and the promised end-state before claiming readiness, especially for UI, onboarding, recommendation, copy, data, migration, or trust-facing work.
---

# Hair Concierge Ready Check

Verify the promised end-state on the exact tree that will be reviewed. This skill owns verification, not code review or publication.

## 1. Define the proof

Read the approved plan/spec or inline implementation contract and the final diff. Map each promised outcome and risk to observable evidence. For every change entering through `implementation-loop`, revalidate that decision coverage is current and `confirmed`, preserve its original user **Coverage acknowledgement** and approved scope, and record the current internal revalidation separately. Return through `plan-hardening-loop` only if implementation surfaced a new consequential choice. A quick-work check that never triggered `implementation-loop` has no decision-coverage record to revalidate. If the intended end-state or required decision coverage is unclear, stale, or unobservable, stop and name the missing contract.

## 2. Run fresh checks

- Run focused tests at each changed seam, then the repository's broader relevant checks.
- For runtime or evaluation changes under `src/lib/rag/**`, `src/app/api/chat/**`, `src/lib/routines/**`, or `scripts/eval-chat/**`, run `npm run test:chat -- --base-url http://localhost:<task-port>` against the task worktree's server. Record its result in this receipt so shipping can reuse it; unavailable prerequisites are a verification blocker, not a silent skip. Documentation-only edits do not trigger this evaluation.
- For deterministic logic, validate a trustworthy, applicable recorded red proof and run the regression guard on the proposed tree. Repeat the old-behavior proof when it is missing, unreliable, or invalidated by a changed guard, relevant behavior, fixture, or environment. In Hair Concierge, use `.agents/skills/implementation-loop/references/test-first-quality.md` when present.
- For UI, onboarding, recommendation, copy, or trust-facing work, run the task worktree and inspect at least one meaningful changed flow. Use `simulated-user-review` when qualitative German clarity, fit, or trust matters.
- For migrations, auth, billing, privacy/security, or production-data behavior, add the relevant live-state or migration check without performing an unauthorized write.
- For evidence-sensitive or medically adjacent guidance, verify implementation against the approved evidence. Use `hair-care-expert` for a fresh pass when claims, population, applicability, source freshness, or material uncertainty changed.
- Inspect delegated changes and run their proof; worker reports are not verification.

Report blockers instead of substituting confidence for unavailable evidence.

## 3. Issue a verification receipt

Record:

- branch and base
- a canonical content fingerprint: SHA-256 of a sorted manifest containing each
  in-scope path relative to the base plus its current content hash or `DELETED`
- revalidated decision-coverage status, original user **Coverage acknowledgement**, and separate current internal revalidation for every `implementation-loop` change; omit only for quick work that never triggered that loop
- promised outcomes checked
- commands and results
- browser/manual evidence
- task-owned artifacts classified as commit, archive, or discard
- skipped checks, blockers, and residual risk

The fingerprint is independent of staging or commit layout, so staging and committing identical content do not stale the receipt. If content changes after verification, rerun only the affected checks plus any required repository-wide gate and issue a new receipt.

Completion criterion: every promised outcome is observed or explicitly blocked, and every success claim is backed by fresh evidence for the identified tree.
