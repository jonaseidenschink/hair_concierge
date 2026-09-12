---
name: category-specific-recommendation
description: Use only when Nick explicitly invokes this skill to define, grill, complete, or implement one Hair Concierge Personal Plan product category end to end, including Stage 1 need/type/tier/frequency, Stage 2 exact owned/recommended product fit and reconciliation, Stage 3 day-type occurrence/application, deterministic rules, product facts, fixtures, and catalog or launch gates. Use hair-care-expert first only when new external evidence is needed.
---

# Category-Specific Recommendation

Define one category as a complete, deterministic Personal Plan contract before implementation. Target the living plan's dedicated Personal Plan module boundary, currently proposed as `src/lib/personal-plan/**`: legacy CareBalance, recommendation, Routine, and Chat behavior may supply evidence or reusable pure helpers, but never becomes a second runtime authority.

## Source context

Locate these sources in the active worktree or the source branch/worktree Nick identifies. Before each decision, read the authorities relevant to that decision and its dependencies; do not delay the first useful question for unrelated reconnaissance:

- `docs/personal-plan/categories/category-design-framework.md`
- `docs/personal-plan/categories/README.md`
- the category's existing `evidence.md` and `decision.md`, if present
- confirmed adjacent-category records relevant to ownership or replacement
- `plans/2026-08-02-personal-plan-app-implementation-v2.md`, or its explicitly superseding living plan
- current computation, lossless answer schema, questions, product inventory/pending state, catalog spec tables, application protocols, selectors, and tests

Use [references/category-definition-checklist.md](references/category-definition-checklist.md) progressively: start with its reconnaissance map and the next decision's question set, resolve current paths with `rg`, and complete the full checklist and source ledger before final category confirmation. Examples in the reference are discovery hints, not permanent authority.

If the framework, category index, or living plan remains unavailable after checking the identified source context, use the bundled checklist as the process contract. Continue read-only reconnaissance and the one-decision-at-a-time working ledger, but treat the missing durable destination as a `category_blocker` for writing or committing the final category checkpoint. Report the missing authority and never invent a parallel architecture or convention.

## Authority boundaries

Keep four inputs distinct:

1. **External evidence** establishes support, uncertainty, safety, and overclaim limits. Put it only in `evidence.md`. Invoke `hair-care-expert` only when the category needs new external evidence; preserving or classifying current internal behavior does not require it.
2. **Current internal behavior** is inspected and classified `reuse`, `adapt`, `reject`, or `missing`. It is not future Personal Plan policy by default.
3. **Nick-confirmed product policy** becomes deterministic category policy in `decision.md`.
4. **Runtime and verified data** become executable authority only after implementation and tests.

Classify every open item as either:

- `category_local`: this category must decide it;
- `shared_dependency`: portfolio ownership, day-type shell, plan lifecycle, generic reconciliation, reason salience, or presentation mechanics that must be named and deliberately deferred;
- `catalog_data_gap`: policy is decided but verified facts/backfill are missing;
- `category_blocker`: the category cannot be confirmed yet.

Do not duplicate shared shopping, pending-product, versioning, confirmation, day-type, logging, or generic presentation mechanics inside a category. Record only the category's use of them and justified exceptions.

## Workflow

### 1. Establish current truth

- Name the category, its likely adjacent categories, and the intended runtime/test seam.
- Inspect the live/repo computation, lossless schemas, existing questions, product-state flow, catalog rows/specs, selectors, protocols, and tests as needed for the next decision and its dependencies. Complete the full reconnaissance before final category confirmation.
- Build a compact `reuse / adapt / reject / missing` ledger.
- List already-confirmed decisions so Nick is never asked to redefine them.
- Identify evidence gaps separately from product-policy gaps. Run `hair-care-expert` only for the former.
- Before recording a category-local decision that touches ownership, replacement,
  day types, lifecycle, reconciliation, or presentation, inspect the relevant
  confirmed adjacent-category record and shared-dependency authority. Defer an
  unresolved dependency explicitly instead of committing an incompatible rule.

Keep reconnaissance read-only. Do not change runtime, database, category documents, or the living plan while the category is still being grilled unless Nick explicitly changes the scope.

### 2. Grill one decision at a time

Follow the reference in order. For each consequential decision:

1. state the current evidence and repository behavior briefly;
2. identify the one unresolved product choice and why it matters;
3. present only materially different options with tradeoffs and a recommendation when evidence supports one;
4. ask one precise question;
5. wait for Nick's answer;
6. record the confirmed answer, rule implication, and any dependency in a working decision ledger.

Do not batch unrelated questions, reopen a confirmed decision without new evidence, or treat silence as approval. Preserve exact canonical values, follow the project vocabulary in `AGENTS.md`, and use German for all proposed user-facing copy.

### 3. Lock the three-stage contract

Before calling the category confirmed, make all outputs explicit:

- **Stage 1:** why the category is included, `basis | optional | not_needed`, target product type/roles/functions, and total cadence or event frequency.
- **Stage 2:** every owned, pending, recommended, shopping, acquired, and override product; exact role-relative fit; `ideal | supportive | mismatch | unknown`; deterministic selection, no-valid-match behavior, and explicit state transitions.
- **Stage 3:** occurrences allocated into eligible day types; ordered application steps; wet/damp/dry state, placement, rinse/leave-in behavior, amount/time semantics, replacement/interactions, and verified exact-product protocol overrides.

Complete the checklist's source ledger and final stop gate before confirming the
category. Earlier progressive reading supports individual decisions; it does not
waive final evidence completeness.

Category computation owns total cadence. Product allocation must cover that total exactly and must not silently add occurrences. Only confirmed in-hand products compile into executable steps.

### 4. Prove completeness

- Express every hard rule with stable ID, exact inputs, trigger including missing/empty behavior, output, precedence, confidence, reason facts, and fixture.
- Define the minimal product schema, including `null`, `[]`, missing identity, pending review, explicit exclusion, and unverified-fact semantics field by field.
- Define layered fit gates, candidate ordering, tie-breaks, stable saved-choice behavior, and the honest no-valid-match state.
- Cover normal, boundary, conflict, missing-data, multi-product, pending, shopping, acquisition, override, protocol, safety, recomputation, and proposal-delta fixtures.
- Name every catalog/backfill, data-quality, protocol, migration, test-discovery, launch, and shared dependency gate.

Use the reference's stop gate. Ambiguous thresholds, precedence, fallbacks, fixtures, product facts, or named shared dependencies mean the category is not complete.

### 5. Write the scoped checkpoint

Only after Nick has confirmed the full category policy:

1. update/create `evidence.md` with external evidence only;
2. update/create `decision.md` with confirmed policy, deterministic mappings, fallbacks, reason facts, fixtures, metadata, runtime/test targets, and explicit deferrals;
3. update the living implementation plan's category-status, implementation, verification, gate, and artifact-disposition sections without redesigning shared architecture;
4. inspect the complete diff and ensure it contains only the category evidence/decision, the living plan, and directly required category-framework/index metadata;
5. run the named document/traceability checks from the living plan; report any unavailable check instead of improvising one;
6. create one scoped category checkpoint commit only when Nick has explicitly authorized committing or shipping; otherwise stop with a review-ready diff.

Do not mark `decision.md` confirmed or commit the checkpoint while a category blocker remains. Catalog/data gaps or shared dependencies may remain only when policy is fully decided, the gap is named, its owner/gate is explicit, and it cannot be mistaken for launch readiness.

If implementation is explicitly authorized after confirmation, hand the approved artifacts to `implementation-loop`, use test-first development at the named category seam, and preserve the dedicated Personal Plan boundary.

## Handoff

Report:

- confirmed Stage 1/2/3 behavior;
- external evidence added versus internal behavior classified;
- category-local decisions and deliberately deferred shared mechanics;
- fixtures and deterministic stop-gate result;
- catalog/data/launch blockers;
- changed artifacts, validation, and the scoped checkpoint commit when one was authorized.

Never claim the category or implementation complete when the stop gate fails.
