# Astra workflow refresh

## Outcome and source context

Implement Nick's approved workflow audit: reduce unnecessary stopping, reading, and repeated verification while preserving product decisions and external-action boundaries. Source: the current task's two read-only audits and https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra.

## Chosen direction and scope

Update repository instructions and their consuming skill references together. Keep existing workflow stages and invocation policies. Align local judgment-worker configuration and the two stale automation targets. No application code, production data, provider configuration, publication, merge, or historical-worktree cleanup.

## Decision coverage

- Status: confirmed.
- Confirmed with Nick: all five recommended choices approved in this task on 2026-09-12: an explicit bounded internal-work request can authorize execution without a second acknowledgement; internal journey sign-off is required only for unresolved consequential choices; reuse trustworthy applicable verification/research while checking the final implementation; gather category evidence progressively with full completeness before policy confirmation; trial Astra/high for the judgment worker and retain Terra workers. Nick also approved the audit's wording/routing corrections and stale automation targets.
- Inherited from evidence or contract: user-facing mockup and journey approvals; read-only review unless fixes authorized; production/payment/medical boundaries; one read-only terminal counterpart reviewer; exact-content receipts; guarded merge cleanup and retention exceptions.
- Implementation defaults: edit only owning instructions and consuming references; concise metadata; static validation and bounded independent behavioral scenarios for this instruction-only change. No application suite or live provider tests are needed.
- Open consequential assumptions: none.
- Undiscussed consequential assumptions affecting this handoff: none.
- Coverage acknowledgement: Nick's “Okay yep, let's do it all” approves the five-choice table and preceding audit cleanup in this task, 2026-09-12. Internal revalidation does not alter that acknowledgement.

## Target map and ordered tasks

1. Main agent exclusively owns AGENTS.md, CLAUDE.md, .claude/agents/ship.md, planning/implementation/review/branch/ship skills and plan-format reference. Separate assessment from full planning and review from repair; carry prior authorization forward; distinguish user acknowledgement from internal revalidation; preserve scoped stopping and final checks. Reconcile external capabilities and plugin routing without editing vendor caches. The actual Claude ship agent must become the publish-only adapter its existing canonical contract already requires.
2. Bounded worker: product-intake, category-specific-recommendation and checklist, ready-check, diagnosing-bugs, prepare-content-research, bug/wayfinder dependency language; add optional metadata to product-research-engine and funnel-variant-creator. Preserve all domain prerequisites and action boundaries.
3. Main agent: set ~/.codex/agents/judgment_worker.toml to gpt-6-astra/high, preserve other roles; retarget monthly skill audit and daily intake automation to the canonical root through the app tool, preserving schedules/status/notification policy and operational permissions. Refresh the personal writing rubric's excessive-thoroughness advice. Keep task-local before/after evidence outside the repository. Do not rewrite memory files; current rules remain the authority over dated recollections.
4. Verify all changed skill metadata and reference targets, inspect the complete diff for conflicting gates, run bounded independent routing/authorization scenarios, and obtain one read-only counterpart review of the final change. Record verification and artifact disposition.

## Operator journey and planning evidence

No end-user surface, copy, timing, or product behavior changes. Nick asks for bounded internal work; the agent inspects context, states scope, performs authorized work, and verifies the final result. It asks only about genuinely unresolved consequential choices. Standalone reviews return findings. Research loads relevant authorities, completes final evidence gates, and stops before unapproved external writes. Shipping reuses valid receipts; an explicit merge uses the existing guarded finisher. A blocked dependent action does not halt independent authorized work. These operator outcomes are the five approved decisions; no additional walkthrough or mockup is needed.

## Verification and handoff

Validate Markdown/frontmatter/YAML and internal references; compile Python only if used for validation tooling (no retained new script unless justified). Use realistic read-only scenarios for review-only intent, bounded internal implementation, changed product scope, progressive intake/category evidence, stale verification, and guarded cleanup. Final receipts identify the content fingerprint and local config/automation evidence. No claims of benchmarked model improvement or comprehensive usage telemetry.

## Approved edit map and contradiction checks

These semantic replacements were presented in the audit before Nick approved them. Check each entrypoint and its consuming reference, not just the diff line.

| Original behavior | Approved replacement | Owning/consuming files |
| --- | --- | --- |
| Every plan review ends in an approved implementation handoff | Review-only requests finish with findings and missing gates | plan-hardening-loop/SKILL.md |
| Reviewers read and follow CLAUDE.md indiscriminately | Applicable AGENTS authority; Claude tool/session instructions only for Claude execution | code-reviewer/SKILL.md, CLAUDE.md |
| Full intake runbook before any command | Core/safety/readiness sections plus selected mode; complete applicable research/publish contract before those actions | product-intake/SKILL.md |
| Implicit load demands user reinvocation | Do not execute explicit-only skill; return to authorized task | prepare-content-research/SKILL.md |
| Every dependency is repo-local; missing Linear skill implies missing service | Distinguish owned workflows, personal skills, callable connectors and actual access failure | AGENTS.md, bug/SKILL.md, wayfinder/SKILL.md |
| Exactly 3-5 hypotheses | Only evidence-supported plausible hypotheses; preserve reproduction and final proof | diagnosing-bugs/SKILL.md |
| Internal revalidation updates user acknowledgement | Preserve original approval and scope; record revalidation separately | AGENTS.md, CLAUDE.md, planning/implementation skills, plan-format.md, ready-check |
| Plugin triggers on frustration/server start alone | Owning repo workflow; require relevant platform symptom; share applicable check evidence | AGENTS.md |
| Bounded internal work always needs a second acknowledgement | Explicit unambiguous request can authorize it; unresolved consequential choices still require user decision | AGENTS.md, CLAUDE.md, planning/implementation skills, plan-format.md |
| All internal plans need separate journey sign-off | Approved internal contract suffices unless a new consequential interaction needs a decision | Same confirmation consumers |
| Review router applies fixes unconditionally | Fix only under existing implementation/repair authority | request-code-review/SKILL.md |
| Dirty state can be committed/stashed to unblock a task | Preserve unrelated state; separate worktree; no unapproved stash/commit | branch-gate/SKILL.md |
| Merge cleanup requires another request or direct removal | Existing AGENTS guarded finisher and retention/refusal rules | branch-gate/SKILL.md, ship-it/SKILL.md, CLAUDE.md, .claude/agents/ship.md |
| Ready-check repeats old-behavior proof and external research | Validate applicable evidence; repeat invalidated/missing evidence; check final tree | ready-check/SKILL.md, test-first-quality.md remains regression-proof authority |
| Ship reruns simplify/review/confirmation after verification | Publish-only adapter; missing/stale receipts return to owning verification/review workflow; preserve chat evaluation for runtime/evaluation changes in ready-check | CLAUDE.md, .claude/agents/ship.md, ship-it/SKILL.md, ready-check/SKILL.md |
| Every category source/checklist before first question | Progressive evidence with cross-category dependencies checked before decisions; full ledger/checklist before final confirmation | category-specific-recommendation/SKILL.md and references/category-definition-checklist.md |

For independent behavioral validation, supply raw scenarios without this expected-result table: (1) review a plan only, (2) explicitly requested internal change with all choices fixed, (3) a newly discovered payment/entitlement choice, (4) queue status with an unavailable publish dependency, (5) unchanged versus changed regression guard/evidence, (6) merge request with clean versus dirty/retained worktree. Record actual routing, stop conditions, and verification; do not execute mutations or live tools in these simulations. Check skill invocation metadata and relative references mechanically; use human/model judgment for semantics rather than text-matching tests.

## Local settings and rollback

These local changes are applied and verified separately from the PR diff. Before-values are captured in a task-owned temporary backup; sanitized values are retained here:

- `/Users/nick/.codex/agents/judgment_worker.toml`: `gpt-5.5` / `high` -> `gpt-6-astra` / `high`. Applies to newly resolved judgment-worker invocations; no claim that existing running agents switch. Restore `gpt-5.5` to end the trial. Other agent models remain unchanged.
- Automations `monthly-skill-and-loop-audit` and `daily-product-intake-research-queue`: project `951b1395-d49c-473c-bd84-52d3d797447d`, cwd `/Users/nick/AI_work/hair_conscierge/.worktrees/product-intake-full-flow-smoke` -> canonical project `local-f21d769fed61e42d0c6d7df4f087f798`, cwd `/Users/nick/AI_work/hair_conscierge`. Preserve ACTIVE status, schedules, model `default`, high/medium efforts, and notification settings. Prompt clarifications preserve existing meaningful-delta intent; no new notification policy is chosen.
- `/Users/nick/.codex/skills/writing-great-skills/SKILL.md`: replace the recommendation to intensify “be thorough” into “relentless” with checkable scope, evidence, and completion criteria; keep its other guidance unchanged.
- No migration of unrelated personal skills, deletion of historical worktrees, new telemetry system, or broad model benchmark is part of this change.

## Plan counterpart findings

Claude completed a read-only high-effort review. Accepted: add this concrete edit/consumer map, raw validation scenarios, exact local target identifiers, and rollback values; include the real Claude ship adapter discovered during source tracing. Rejected after checking this task: lack of user approval (Nick explicitly approved the five-choice table after quote-by-quote recommendations); delegated CLAUDE.md edits (task 1 is explicitly main-owned); mandatory notification redesign (preserve existing meaningful-delta intent); separate approvals for storage domains (the local model and targets were explicitly included). These are implementation clarifications, not new consequential choices. Internal revalidation: the original approval covers this expanded map; no additional operator sign-off is needed.

## Review and artifact disposition

Plan and final branch review: Claude via claude-plan-review, high effort, explicitly read-only and terminal. Validate findings locally and change only material defects. Commit plan and durable validation receipt with the future PR; keep transient review/backup artifacts outside the repository. Stop at verified review-ready changes. Publication and merge require later authorization.
