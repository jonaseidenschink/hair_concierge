---
name: implementation-loop
description: Use for Hair Concierge when an approved implementation plan or clearly bounded non-trivial non-user-facing change should be executed through decision-coverage intake, branch setup, implementation, verification, final review, and a review-ready handoff. Use after plan-hardening-loop; do not use for brainstorming or plan creation.
---

# Implementation Loop

Execute one approved outcome to a verified, review-ready branch without letting process steps replace the objective.

## Goal, plan, and loop

- **Goal** is the durable outcome: what must become true.
- **Plan** is the current set of steps: it may change as evidence appears.
- **Loop** is this repeatable procedure: orient, implement, verify, review, and hand off.

A Goal can contain this loop. The loop does not require formal Goal mode.

## 1. Anchor the outcome

Read the approved plan when one exists and inspect any active goal before editing.

For plan-backed work, confirm the plan's **Decision coverage** is current and `confirmed`, states `Undiscussed consequential assumptions affecting this handoff: none`, and has no open decision that the handed-off tasks depend on. "Current" means the record reflects the latest chosen direction, scoped tasks, evidence, and counterpart findings; its original coverage acknowledgement names the approved scope, and separate internal revalidation links that approval to the current revision without claiming a new user acknowledgement. When a plan written before this contract is the current source for implementation or verification, refresh that active plan or its handoff before continuing, even if implementation edits are already complete; do not bulk retrofit historical plans that are not driving active work.

For clearly bounded non-user-facing work without a durable plan, present the compact coverage and cite the explicit task request. If that request uniquely determines the scope and no consequential choice remains, mark coverage `confirmed` and proceed without a second acknowledgement. An ambiguous request, evidence favoring one of several consequential options, or silence does not supply approval. Return unresolved consequential choices to `plan-hardening-loop` and pause only dependent work.

For user-facing work, also confirm **Planning evidence**, confirmed evidence review, a **Designed user journey**, and explicit user-journey sign-off. If any required gate is missing or pending, return to `plan-hardening-loop`; do not implement. A prose-only visual description or general plan approval is not a substitute. If a prototype settled a decision, confirm its finding and disposition are recorded and rewrite retained behavior through the normal production test and safeguard workflow. For non-user-facing work, use the approved implementation contract and state that no surface, copy, timing, or user-visible feedback changes. A separate operator/integration walkthrough is required only to settle a consequential choice absent from that contract.

Use formal Goal mode only when the user explicitly asks for it and the work is likely to span multiple turns, resumptions, or a long implementation sequence. If formal Goal mode is requested, first inspect the existing goal to avoid replacing unrelated active work.

On resume, continue a matching active goal without replacement. Reconcile plan status with `git log`, the current diff, and receipts; trust durable artifacts over chat and do not repeat completed slices after compaction. If the goal is paused, wait for the user or system to resume it. If an existing goal is unrelated or cannot be reconciled safely, ask before replacing it.

In every implementation-loop run, state a compact implementation contract. Formal Goal mode supplements this contract; it does not replace it:

```text
Outcome: <user-visible or repository state that must become true>
Scope: <plan path and boundaries>
Decision coverage: <confirmed from approved plan or explicit bounded internal-work request | pending for unresolved consequential choices>
Confirmed with Nick: <plan section or consequential choices>
Inherited from evidence or contract: <plan section or determining sources>
Implementation defaults: <plan section or non-consequential choices only>
Open consequential assumptions: <none, or acknowledged parked work>
Undiscussed consequential assumptions affecting this handoff: <none, or list>
Coverage acknowledgement: <original user acknowledgement/request and approved scope>
Internal revalidation: <current revision/evidence checked; changes since acknowledgement>
Verification: <proof required>
Stop: <last authorized external action>
```

Quick audits, questions, queue/status passes, tiny non-user-facing fixes, and routine non-user-facing automation runs do not trigger this skill and do not require an implementation contract or formal Goal unless evidence exposes a consequential choice. Use the consequence-based definition of "tiny" in `AGENTS.md`; line count alone does not create an exemption. A tiny user-facing fix still returns to `plan-hardening-loop` for contextual evidence review and journey sign-off.

Completion criterion: the controlling outcome is stable, authorization is clear, and process details are subordinate to it.

## 2. Establish a safe branch

Use `branch-gate`. Reuse the planning worktree; if no persistent planning artifact exists, create a repo-local worktree on `codex/<slug>` from fresh `origin/main`. Preserve unrelated state and record the plan path and execution mode.

Choose sequential execution for tightly coupled work, bounded delegation for independent scopes, or mixed execution when both apply. Keep product decisions, architecture, integration, and readiness in the main session.

Delegation uses the roles and brief contract in `AGENTS.md`. Require `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`; every non-`DONE` status must change the context, scope, model, plan, or stop decision before retry or review.

Completion criterion: the write location, base, dirty-state ownership, and execution scopes are unambiguous.

## 3. Implement in bounded slices

Follow the plan in dependency order. For each slice:

1. establish or update the regression guard when the behavior is deterministic;
2. make the smallest coherent change;
3. run focused verification;
4. update the working plan and record deviations with evidence.

When changing deterministic behavior or regression guards, read `references/test-first-quality.md` and record the red proof.

Return to planning only when evidence reveals a product decision, material architecture change, scope expansion, or risk acceptance that the approved plan did not settle. Mark dependent work's decision coverage `pending`; continue independent authorized work, but do not continue the affected work until `plan-hardening-loop` has resolved or explicitly parked the choice and restored current confirmed coverage.

Completion criterion: every in-scope plan item is implemented or explicitly blocked, with no unrelated edits absorbed and every task-owned artifact classified as commit, archive, or discard.

## 4. Verify the final tree

Use `ready-check` on the complete tree. Run repository checks plus the risk-specific checks named by the plan. For user-facing behavior, include browser or simulated-user evidence when useful.

Create a verification receipt containing:

- branch and base
- the canonical content fingerprint from `ready-check`
- revalidated decision-coverage status, original acknowledgement, and internal revalidation
- commands and outcomes
- manual or browser evidence
- artifact disposition and unresolved task-owned files
- skipped checks and residual risk

Completion criterion: the receipt matches the exact content proposed for review.

## 5. Review once, at the right boundary

Use `request-code-review` as the single repository review router. Run the configured counterpart whole-branch review only when `AGENTS.md` requires it. Verify findings locally, fix supported defects, and rerun affected checks.

If content changes after either receipt, refresh the stale receipt; do not blindly rerun unrelated review lanes. Staging or committing byte-identical content does not stale a receipt.

Before handoff, revalidate decision coverage against the final tree. A material implementation deviation or review finding that introduces a consequential choice returns coverage to `pending` and the affected work to `plan-hardening-loop`.

Completion criterion: no blocking verified findings remain and verification/review receipts identify the same canonical content fingerprint.

## 6. Hand off

Report outcome, changed behavior, revalidated decision-coverage status and coverage acknowledgement, verification, review findings, artifact disposition, residual risk, branch/worktree, and the next authorized action. Stop before commit, push, PR, merge, deploy, production write, or cleanup unless the user explicitly authorized that action.

Use `ship-it` only after the user asks to publish the verified branch.
