# Category definition checklist

Use this checklist progressively while grilling a Personal Plan category. Before
each decision, read the relevant reconnaissance and question sections; work
through the complete checklist and source ledger before final confirmation. Skip
a question only when repository evidence proves it already answered or
non-applicable, and record why.

## Contents

1. Reconnaissance map
2. Decision-grilling protocol
3. Exact category question set (A-N)
4. Rule and fixture format
5. Final stop gate

## 1. Reconnaissance map

Start from the current worktree or the source branch/worktree Nick identifies. Use `rg`/`rg --files` to resolve renamed paths and inspect actual values, not summaries.

Before committing a decision that affects shared ownership, replacement, day
types, lifecycle, reconciliation, or presentation, inspect the relevant
adjacent-category record and shared-dependency authority. If it remains
unresolved, record it as a named dependency rather than deciding shared behavior
locally.

### Durable Personal Plan sources

- `docs/personal-plan/categories/category-design-framework.md`
- `docs/personal-plan/categories/README.md`
- `docs/personal-plan/categories/<category>/{evidence,decision}.md`
- confirmed adjacent-category `decision.md` files
- `plans/2026-08-02-personal-plan-app-implementation-v2.md`, or its explicitly superseding living plan, plus the current computation specification

Maintain a compact source ledger as you progress: each required source, its
relevance, whether it was consulted or unavailable, and the decision or final
gate it supports. Complete it before final confirmation.

If these are not present in the active worktree, inspect the identified source context read-only. Their absence blocks the final durable checkpoint, but this bundled checklist still governs current-repo reconnaissance and the working decision ledger without inventing answers.

### Lossless user inputs and questions

- `src/lib/personal-plan-quiz/types.ts`, flow/draft/persistence, quiz components, and tests
- profile linking and any post-payment clarification contract
- current-product questions, conditional questions, and frequency vocabulary

Confirm which fields are required, optional, nullable, explicitly empty, or unreachable after validation. Do not depend on a lossy offer/legacy adapter when lossless answers exist.

### Internal behavior to classify

- `src/lib/recommendation-engine/categories/<category>.ts`
- CareBalance evaluators/frequency targets
- recommendation selection, reranking, category contracts/types, and regression tests
- Routine/Chat planning or guidance that currently mentions the category

For each useful rule or helper, classify `reuse`, `adapt`, `reject`, or `missing`. Record its inputs, outputs, tests, and incompatibilities with the Personal Plan.

### Inventory, catalog, and protocols

- `user_product_usage`, pending product-intake state, acquisition, and current frequency
- shared `products` identity/lifecycle/recommendation/price/availability facts
- category product-spec tables, generated types, validators, admin/intake readers, and exact active catalog rows
- `suitable_thicknesses` and other strict gates where applicable
- `product_application_protocols` or current equivalent
- migrations, fixtures, and tests that establish `null` versus `[]` semantics

When current live catalog facts can change the decision, invoke the repository-required Supabase workflow and inspect them read-only. Keep repo schema/migration truth distinct from live row completeness; never perform a backfill, migration, approval, or production write during category definition.

Do not infer a product fact from its name, marketing category, one ingredient, or a legacy default. Distinguish verified mismatch from missing/unreviewed data.

### Output of reconnaissance

Produce a compact ledger:

| Area | Current truth | Treatment | Open decision/gap |
|---|---|---|---|
| Input/question | exact field/behavior | reuse/adapt/reject/missing | category-local/shared/data/evidence |
| Computation | exact rule/helper | reuse/adapt/reject/missing | ... |
| Product facts | exact table/semantics | reuse/adapt/reject/missing | ... |
| Tests | existing fixture/seam | reuse/adapt/reject/missing | ... |

## 2. Decision-grilling protocol

Ask only one consequential question per turn. Before asking it, show:

- what current repo behavior does;
- what external evidence supports or leaves uncertain, if relevant;
- what is already confirmed;
- the smallest set of real options and their downstream effects;
- the recommended option when justified.

After Nick answers, restate the decision in testable terms and add it to the working ledger. Do not edit the durable category artifacts until the complete category is confirmed.

## 3. Exact category question set

### A. Charter and boundaries

1. What precise user problem/job does this category solve?
2. What are its explicit non-jobs and overclaim boundaries?
3. What must Stage 1, Stage 2, and Stage 3 each decide?
4. Which adjacent categories overlap, complement, substitute, or must never be replaced?
5. Does the catalog category contain several semantic roles/use cases? Can one product cover several?

Classify each answer as `category_local` or `shared_dependency`.

### B. Inputs and conditional clarifications

6. Which lossless hair, scalp, concern, goal, treatment, behavior, preference, budget, exclusion, ownership, and product facts can materially change a decision?
7. For every consumed input, which tier, target, cadence, fit, selection, safety, or application result can it change?
8. Which apparent inputs change only explanation and should therefore not be consumed?
9. What does missing, `null`, `[]`, an explicitly empty answer, and an invalid/unreachable state mean?
10. Which affected users need a conditional clarification because current inputs cannot change a material decision safely?
11. What happens while that clarification is unanswered: deterministic fallback, reduced confidence, typed blocker, or omission?

### C. Stage 1 inclusion and need tier

12. What exact rules create `basis`, `optional`, and `not_needed`?
13. Does ownership leave underlying need unchanged?
14. What precedence resolves multiple triggers, conflicts, and duplicate signals?
15. Which thresholds are product-policy calibration versus externally supported hard boundaries?
16. What is the conservative result when decisive inputs are missing?
17. What German tier/type/frequency output and structured reason facts does Stage 1 emit?

Stage 1 output must state:

```text
why + category/type/role + basis|optional|not_needed + total frequency/event cadence
```

### D. Target product and functional needs

18. Which independent target axes are needed to judge an exact product?
19. What are each axis's allowed values, input mapping, precedence, fallback, and confidence?
20. Which functions are required, supporting, or irrelevant for this category?
21. Use shared function priority: `3` current problem plus goal; `2` problem only; `1` goal only. Where does core fit override benefit counting?
22. Which functions can this category own primarily, support, or never claim?
23. Which ownership decisions remain provisional until the portfolio matrix is complete?

Do not collapse independent dimensions merely because one product can combine them.

### E. Cross-category ownership and replacement

24. For every overlapping job, which category is primary and which is supporting?
25. When does this category complement an adjacent category?
26. Can it replace another category or step? If so, list the complete predicate, verified product capability, ordering change, and fallback.
27. When two portfolios cover the same jobs, may product-count minimization decide? What fit/coverage constraints take precedence?
28. Which final ownership, day-type, or presentation choice is shared and deliberately deferred?

### F. Cadence, occurrences, and event allocation

29. What creates one category occurrence?
30. What determines total cadence or range? Is it wash-linked, event-based, acute, maintenance, as-needed, product-directed, or a combination?
31. Does it substitute inside another event budget, attach to an event, or create a separate day type?
32. What are the thresholds, caps, reassessment/check-in rules, and missing-protocol fallback?
33. How do current reported use and recommended plan cadence remain separate?
34. Does allocation cover the category total exactly without adding occurrences?

### G. Multiple products and roles

35. How many products are normally needed, and what exact condition justifies more than one recommendation?
36. Can one verified product fill several roles? When must it not?
37. Are several suitable owned products interchangeable, deliberately rotated, primary/secondary, or visible but unassigned?
38. If allocation changes, what proposed-plan delta and user confirmation are required?
39. How do inactive, pending, shopping, acquired, declined, and override products remain visible without silently entering recipes?
40. What stable saved-choice rule prevents recommendations from changing unnecessarily?

Never invent a per-product split for interchangeable products and never force a second purchase only to maximize benefit count.

### H. Minimal product schema and fact semantics

41. Which exact product facts are required for strict eligibility, core axes, roles/functions, protocols, and only then price/availability tie-breaks?
42. For each field, what do `null`, `[]`, false, missing row, pending identity, and explicit exclusion mean?
43. Which values are invalid for an active recommendable product?
44. Which facts must come from finished-product evidence or an exact protocol rather than inference?
45. Which legacy fields must be migrated, adapted, ignored, or prohibited as Personal Plan authority?
46. What backfill and consumer audit is required before launch?

### I. Layered fit and deterministic selection

47. What are Layer 1 safety/strict gates?
48. What are Layer 2 core role/formula/axis fits?
49. What are Layer 3 required and supporting function-coverage rules?
50. What exact conditions aggregate to:
    - `ideal` / `passt sehr gut`;
    - `supportive` / `passt mit Einschränkung`;
    - `mismatch` / `wechseln empfohlen`;
    - `unknown` / `noch in Prüfung`?
51. What is the precedence among pending identity, safety, strict mismatch, core mismatch, missing required data, supportive deviation, and ideal?
52. How is every owned product evaluated independently and role-relatively?
53. How are candidates filtered, ranked, tie-broken, stabilized, deduplicated across roles, and constrained by exclusions/budget/availability?
54. May a supportive new product be recommended when no ideal exists? How is the limitation shown?
55. What exact no-valid-match state is returned? Never promote mismatch/unknown confidently.

### J. Stage 2 reconciliation and lifecycle

56. For each verdict, what may the user keep, replace, add to shopping, submit for review, decline, or retain as an informed override?
57. What is the explicit state transition for owned, pending, shopping, acquired, inactive, declined, and override states?
58. Which actions create a proposed successor plan? Which require confirmation before changing the active plan?
59. How does acquisition preview affected assignments and recipes?
60. Confirm that affiliate-link opening never means acquisition and never mutates ownership.

Stage 2 output must state:

```text
each exact owned/pending/recommended product + assigned role + axis facts + verdict + limitation + selected action/state transition
```

### K. Stage 3 occurrence and application

61. Which day types may contain the category, and may the category create a day type?
62. What is the ordered application stage and relationship to adjacent products?
63. What wet/damp/dry state, scalp/length placement, distribution/sectioning, rinse/leave-in behavior, and replacement/exclusion rules apply?
64. What safe category fallback applies when exact protocol facts are absent?
65. Which amount, active-time, wait-time, contact-time, temperature, activation, and cadence facts must remain unknown rather than fabricated?
66. Which exact product directions override the category fallback, and which category invariants may they not override silently?
67. What protocol gaps keep a product or occurrence out of precise executable recipes?
68. How do multiple category roles/products allocate to occurrences without duplicate or missing cadence?

Stage 3 output must state:

```text
occurrence + eligible day type + exact in-hand product + order + application state/placement + protocol source or visible fallback/gap
```

### L. Safety, uncertainty, and reasoning

69. What hard exclusions and stop-use signals precede optimization?
70. What medically adjacent symptoms require cautious language or professional escalation?
71. Which diagnosis, structural repair, growth, efficacy, or other claims are forbidden?
72. Which weak/mixed evidence remains optional, confidence-reducing, or excluded from routing?
73. Which structured reason facts preserve inclusion, targets, cadence, fit, limitations, uncertainty, safety, overrides, and cross-category coverage?
74. Can a deterministic German template explain the result without reconstructing hidden logic or letting an LLM change it?
75. Which reason-salience/presentation decisions remain shared and deferred?

### M. Fixtures and deterministic seam

76. Name fixtures for every tier, role, target boundary, conflict, precedence, and missing-input fallback.
77. Cover `ideal`, `supportive`, `mismatch`, `unknown`, and no-valid-candidate products.
78. Cover one product/multiple roles, multiple owned products, exact cadence allocation, pending, shopping, acquisition, override, and decline.
79. Cover exact protocol override, protocol gap, replacement/order, safety suppression, and medically adjacent escalation.
80. Cover stable recomputation, saved recommendation continuity, proposed-plan delta, and explicit confirmation.
81. Name the plan-owned runtime module and test surface. Ensure every rule/fallback maps to at least one fixture.

### N. Data, catalog, and launch gates

82. Which product facts and active launch rows must be complete?
83. Which schema/migration/generated-type/intake/admin/selector consumers require synchronized changes?
84. Which null/empty/legacy semantics require validation or backfill tests?
85. Which exact protocols are mandatory for executable Stage 3 steps?
86. Which test-discovery, regression, artifact-traceability, feature-flag, analytics/privacy, and rollback checks are required?
87. Which shared dependencies block category confirmation versus implementation versus launch?

## 4. Rule and fixture format

For each deterministic rule preserve:

| Field | Required content |
|---|---|
| Rule ID | Stable category-prefixed key |
| Inputs | Exact canonical fields/product facts |
| Trigger | Testable condition including missing/empty behavior |
| Output | Tier, target, cadence, fit fact, application, safety, or transition |
| Precedence | Conflict winner and tie behavior |
| Confidence | Hard rule, calibrated policy, conservative fallback, or uncertain |
| Reason facts | Structured facts for deterministic explanation |
| Fixture | Normal, boundary, conflict, or fallback example |

Fixture records must contain exact input facts, expected Stage 1/2/3 outputs, decisive rule IDs, and expected unresolved/shared/data gates.

## 5. Final stop gate

Do not mark the category confirmed, update the living implementation checkpoint, or commit while any of these is ambiguous:

- category charter, non-jobs, or adjacent-category boundaries;
- `basis | optional | not_needed` thresholds, precedence, or missing-input behavior;
- target axes, allowed values, mappings, or functional ownership;
- total cadence, event allocation, replacement, or multiple-product behavior;
- product schema or `null`/empty/pending/unverified semantics;
- strict gates, fit thresholds, candidate fallbacks, tie-breaks, or no-match behavior;
- owned/pending/shopping/acquired/override transitions;
- Stage 3 occurrence, safe application fallback, or protocol override boundary;
- safety/medical escalation or forbidden claims;
- structured reason facts or required fixtures;
- catalog facts, backfill owner, protocol data, test seam, or launch gate;
- named shared dependencies and the stage at which each must be resolved.

Before that confirmation, complete the reconnaissance/source ledger and every
applicable checklist section. Progressive reading may support earlier questions,
but does not waive this completeness gate.

A catalog/data gap or shared dependency may remain after category confirmation only when the category rule is fully decided, the gap is explicit, its owner and blocking stage are named, and no output claims launch readiness.
