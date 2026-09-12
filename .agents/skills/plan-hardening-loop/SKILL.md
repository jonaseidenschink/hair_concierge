---
name: plan-hardening-loop
description: Create or harden a Hair Concierge implementation plan through consequential decisions, evidence, and review. For review-only requests, return findings and missing gates without requiring implementation approval.
---

# Plan Hardening Loop

Turn fuzzy intent or an existing plan into one chosen, evidence-grounded implementation handoff.

## Boundary

- For plan creation or hardening, this skill owns discovery, options, decisions, user-facing evidence, plan writing, counterpart review, user-journey sign-off, and revision.
- For review-only requests, inspect the requested plan and relevant evidence, then return findings, unresolved choices, and missing implementation gates. Completing the assessment does not require revising the plan, obtaining sign-off, or implementing it. Use counterpart review only when required by `AGENTS.md` or explicitly requested.
- It does not implement the plan. Handoff execution to `implementation-loop`.
- It accepts a Wayfinder handoff once the planning contract can be stated. If dependent decisions still prevent that, explain the boundary and offer explicit `$wayfinder` invocation instead of silently switching workflows.
- Keep external evidence, internal product logic, and reconciliation separate as defined in `AGENTS.md`.
- Do not use it for a tiny non-user-facing change that does not need a durable plan unless evidence exposes a consequential choice; this loop then owns that decision before work continues. Any user-facing change still uses the mockup and journey gates even when the eventual code diff is small.

## 1. Establish the planning contract

Inspect the relevant repository context and any Wayfinder map first. Then establish:

```text
Outcome: what will be different
Constraints: what must remain true
Non-goals: what is excluded
Done when: evidence required for an implementation-ready plan
```

If the outcome spans independently shippable subsystems, split it before detailed grilling. Plan the first outcome and leave the others as explicit follow-ups.

Ask only for missing information that local context cannot answer. Acknowledge the contract and continue without seeking ceremonial confirmation unless an assumption changes scope.

Before writing a persistent plan or mockup, use `branch-gate` and create or reuse the task worktree. Keep all durable task artifacts there.

Completion criterion: outcome, constraints, non-goals, and done-when evidence are concrete enough to reject an unsuitable approach.

## 2. Grill the consequential decisions

Use one high-leverage question at a time. For architecture, UX, data ownership, rollout, verification, risk, or scope forks, present 2-3 similarly scoped options:

| Option | Plain meaning | What gets easier | What gets harder | Best when |
| ------ | ------------- | ---------------- | ---------------- | --------- |

Recommend one option when the evidence supports it. After every 2-4 substantive decisions, checkpoint what is settled, what remains open, and the likely direction.

Maintain a compact decision-coverage record with four buckets:

- **Confirmed with Nick:** product, experience, scope, and risk choices he explicitly approved.
- **Inherited from evidence or contract:** behavior uniquely determined by current product rules, repository authority, or supplied requirements, with no meaningful fork left; cite the determining source rather than asking ceremonially.
- **Implementation defaults:** routine technical choices with no meaningful product consequence.
- **Open consequential assumptions:** anything not yet confirmed where another choice could change user-visible behavior, product semantics, scope, data ownership, access or payment, rollout, recoverability, or material risk. Mark each item `resolve before handoff` or `parked out of scope` and name the affected work.

Track the record status as `pending` or `confirmed`. For plan-backed and user-facing work, confirmation requires Nick to have seen the record, settled every consequential choice affecting the handoff, and explicitly acknowledged any parked choice with its affected work out of scope. For clearly bounded non-user-facing work without a durable plan, an explicit request that uniquely determines the scope and leaves no consequential choice open can supply authorization: present the compact record and cite that request without asking again. In both cases state `Undiscussed consequential assumptions affecting this handoff: none`. Record the original user acknowledgement/request and its approved scope; do not rewrite its date or imply Nick saw later revisions. Separately record internal revalidation against the current plan, evidence, and findings. A new consequential choice returns dependent work to `pending`; unchanged approved choices retain their original acknowledgement.

Do not treat evidence that merely supports one viable direction, a reviewer preference, or the orchestrator's recommendation as user approval of a consequential choice. Move that choice into the open bucket and ask for the decision. Do not fill the record with naming, test mechanics, or other internals that cannot change the product outcome.

Before final handoff, explicitly state `Undiscussed consequential assumptions affecting this handoff: none`. If that is not true, list the assumptions and keep the affected work open.

Compact example:

```text
Decision coverage: <pending|confirmed>
Confirmed with Nick: <consequential choices>
Inherited from evidence or contract: <determining sources>
Implementation defaults: <non-consequential choices only>
Open consequential assumptions: <none, or explicitly acknowledged parked work>
Undiscussed consequential assumptions affecting this handoff: <none, or list>
Coverage acknowledgement: <original user acknowledgement/request and approved scope>
Internal revalidation: <current revision/evidence checked; changes since acknowledgement>
```

Completion criterion: every known consequential fork has a chosen direction or is explicitly marked `resolve before handoff` or `parked out of scope` with its affected work, the record is current for this planning stage, and no consequential assumption is hidden inside an implementation default.

## 3. Make consequential behavior concrete

For any user-facing work, create at least one reviewable mockup during planning and show it to the user before finalizing the plan. Do this even for apparently small copy, hierarchy, spacing, state, or interaction changes; put the proposal in context instead of asking the user to imagine it from prose.

State the decision the artifact must resolve, then choose the lightest evidence that makes it real:

- annotated current/proposed screenshot for a small change to an existing surface
- wireframe for information hierarchy or a multi-step flow
- rendered lightweight HTML for layout or responsive behavior
- 2-3 comparable mockup variants when a meaningful visual fork remains
- the `prototype` skill only when interaction, changing state, or a logic model cannot be judged reliably from a static artifact

Do enough grilling to name the prototype question and its decision criterion before invoking `prototype`. A prototype is a higher-fidelity branch of this mockup step, not an opening phase or an automatic requirement. Use its UI branch for interactive or stateful experience questions and its logic branch for state transitions, business rules, data shapes, or interface behavior. Return the prototype's answer to this loop, record the selected behavior in the plan, and require production implementation to rewrite retained behavior with normal tests and safeguards.

For non-user-facing planning, skip the user-facing mockup ladder. Invoke `prototype` only when operating a logic model will settle a consequential implementation decision more reliably than discussion or a static diagram.

Ground mockups in the actual product surface when one exists. Inspect and capture the current surface first, then annotate that screenshot or recreate the proposed state as rendered lightweight HTML. For copy-only changes, show the before/after wording inside the real component layout at a representative viewport. A Markdown quote, ASCII sketch, detached copy sample, or prose description does not count as a mockup for an existing surface.

Use realistic content and German UI copy. Show mobile and desktop when the experience materially differs, and include loading, empty, error, confirmation, or recovery states when they affect comprehension or trust.

Mockups and prototypes are planning artifacts, not production implementation. Keep durable decision evidence in the task worktree and transient previews outside the repository. Present the relevant evidence to the user, incorporate feedback, record what it proved, and record the selected direction in the plan. Purely non-user-facing work may skip user-facing evidence only when the plan explicitly states that no surface, copy, timing, or user-visible feedback changes.

Completion criterion: the user has seen or operated the relevant experience, feedback and prototype findings are reflected in the chosen direction, and evidence review is recorded as confirmed for user-facing work. Any logic prototype also has its finding and disposition recorded.

## 4. Write or update the plan

Read `references/plan-format.md`, then create or patch the plan under `plans/` in the task worktree. Preserve only the chosen path, include the current decision-coverage record, and complete its self-review before counterpart review.

Completion criterion: the plan contains concrete files or repository surfaces, scope boundaries, ordered tasks, automated and manual verification, review gates, and an execution handoff.

## 5. Run one counterpart review lane

Select the counterpart reviewer according to `AGENTS.md`. The reviewer is advisory and read-only. Keep its transient output outside the repository unless the plan intentionally retains it.

Maintain a findings ledger for material findings:

| ID  | Type | Evidence | Decision | Plan change | Revalidation |
| --- | ---- | -------- | -------- | ----------- | ------------ |

Classify `Type` as `defect`, `tradeoff`, or `scope/product decision`. Classify `Decision` as `accepted`, `rejected`, `deferred`, or `needs user decision`.

- Accept technical defects only after verifying them against the repository.
- Never silently accept a product, scope, architecture, or risk tradeoff on the user's behalf.
- Rerun the counterpart only after material blocker-driven changes, multiple concrete implementation traps, or an explicit user request. Do not rerun for a cleaner approval sentence.

Revalidate decision coverage after the review. A material finding that changes a consequential choice returns the record to `pending` until Nick confirms it. If findings change only technical defects or non-consequential defaults, update internal revalidation and retain `confirmed` with the original user acknowledgement.

Completion criterion: every material finding is classified, supported or rejected by evidence, reflected in the plan or an explicit open decision, and reconciled with current decision coverage.

## 6. Confirm the designed user journey

For user-facing plans, after the plan and counterpart findings are reconciled, translate the chosen design back into the experience the user will actually have. Add or update the plan's **Designed user journey** section, then present the same journey to the user for explicit confirmation.

Describe the journey from the user's perspective, not as an implementation checklist:

1. actor and entry condition
2. ordered user-visible steps, decisions, and system responses
3. important loading, empty, error, fallback, and recovery states
4. meaningful variants such as entitlement, device, prior state, or user choice
5. completion state and what the user sees or can do next

Link the reviewed mockups or screenshots for every user-facing change and ensure the narrated journey matches them. Keep invisible backend work outside the journey unless it changes timing, feedback, trust, or available actions. For work with no end-user surface, describe the operator/integration outcome in the implementation contract and state that no surface, copy, timing, or user-visible feedback changes. Request a separate walkthrough only when needed to resolve a consequential choice missing from that contract; otherwise record journey sign-off as not applicable.

Present the final decision-coverage record with the journey: what Nick decided, what was inherited, which non-consequential implementation defaults remain, and which decisions are explicitly parked out of scope. Journey sign-off is invalid while an open or undiscussed consequential assumption affects the handed-off scope.

For user-facing work, ask whether this journey exactly matches the user's intent. A general approval before this walkthrough does not count as journey sign-off. Do not implement dependent work while a required sign-off is pending; continue independent authorized preparation.

If the user corrects the journey:

- update the journey, plan tasks, acceptance criteria, and verification together
- return to counterpart review only when the correction materially changes architecture, data flow, scope, risk, or earlier review assumptions
- present the revised journey again and obtain explicit confirmation

Completion criterion: the plan records the confirmed user-facing journey, or an internal outcome whose consequential choices are settled and separate sign-off is not applicable. No implementation-relevant journey assumption remains implicit.

## 7. Hand off cleanly

For plan creation or hardening, the loop is done when the chosen direction is explicit, decision coverage is current and `confirmed`, no item remains marked `resolve before handoff`, no open or undiscussed consequential assumption affects the handoff, blockers are resolved or explicitly parked out of scope, required mockups have been reviewed, required user-facing journey sign-off is explicit and internal outcomes have no unresolved consequential choices, the plan is executable, and verification is checkable. A review-only request instead ends with the assessment and any missing gates; it does not require implementation approval.

Report:

- plan path
- review artifact path, if intentionally retained
- decision-coverage status, Coverage acknowledgement, the required no-undiscussed-assumptions statement, and any decisions parked out of scope
- accepted, rejected, deferred, and decision-required findings
- evidence review status and selected artifact or direction
- user-journey sign-off status and any corrections incorporated
- residual risks
- artifact disposition: commit, archive, or discard
- recommended `implementation-loop` kickoff

Do not create a formal Goal merely because the plan is ready. Goal selection belongs to `implementation-loop` and remains opt-in.
