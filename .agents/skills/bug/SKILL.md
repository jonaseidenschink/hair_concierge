---
name: bug
description: Use when Nick explicitly invokes $bug with a screenshot, message, example response, log, or symptom and wants it recorded in Linear, diagnosed with evidence, researched where useful, converted into five implementation decisions, and optionally handed into the guarded plan, patch, and ship workflow.
---

# Bug

Turn one reported symptom into a durable Linear case and an evidence-backed decision brief. Preserve the original report; do not treat the Linear summary as the only diagnostic input.

## Authority

Explicit invocation authorizes:

- duplicate search plus creation or maintenance of the canonical Linear case;
- read-only diagnosis and targeted research.

It does not authorize production containment, code edits, implementation, commit, push, PR, merge, deployment, production writes, or cleanup. Require the matching later approval.

## 1. Capture And Triage

Read [references/case-template.md](references/case-template.md). Build the investigation packet from the current task, original attachments, follow-up context, Linear history, and repository or runtime evidence. Preserve verbatim evidence alongside the normalized summary. Redact secrets and unnecessary personal data before sharing it.

Check first for safety, privacy, payments, data loss, or active production harm. Preserve evidence and request containment authority before any mitigating mutation.

Use the available Linear connector to search likely duplicates; consult a Linear skill when one is available. If the connector or access is unavailable, report the actual capability/access failure rather than treating a missing named skill as the failure. Under this skill's explicit authority, update the canonical issue when one exists; otherwise create a symptom-titled Bug in the `Hair-concierge` team, starting in Triage when available. Set a project only when context clearly identifies one. Return the canonical issue ID.

## 2. Diagnose Proportionally

Classify the feedback loop before investigating:

- deterministic UI or data: focused test, browser check, or exact visual/manual reproduction;
- stochastic LLM or recommendation: full transcript and trace context, replay, then a representative eval or failure-rate check;
- intermittent production: event or trace replay, bounded stress loop, or approved instrumentation and observation window.

Use `diagnosing-bugs` through confirmed diagnosis, but stop before its fix phase. Keep an evidence ledger with `reported`, `reproduced`, `inferred`, `confirmed`, and `disproven` states. Separate symptom, trigger, root cause, contributing conditions, contradictory evidence, and unknowns.

Default to one investigator. Spawn parallel read-only lanes only for independent evidence surfaces such as reproduction, runtime tracing, or logs/history. Give each lane the same investigation packet plus one bounded question. The main session owns synthesis; agents do not vote on causes or patch competing theories.

## 3. Exit Diagnosis Explicitly

Choose one outcome and update Linear:

- `confirmed defect`: permanent-fix planning may proceed;
- `needs evidence`: request the missing artifact or propose instrumentation only;
- `mitigation required`: contain with explicit authority, then continue diagnosis;
- `expected behavior / improvement`: reclassify with an explanation;
- `duplicate`: attach the report to the canonical issue.

Record the reproduction result, diagnosis, confidence, negative evidence, and remaining unknowns. Do not call a probable cause confirmed.

## 4. Research And Decide

Research only after the failure class is bounded, unless evidence is needed to establish expected behavior. Prefer authoritative primary sources. Route hair-care evidence to `hair-care-expert` and assistant architecture to `llm-architecture-review`. Route category logic to `category-specific-recommendation` only when Nick explicitly invokes that skill; otherwise keep the bug pass diagnostic and hand the chosen category decision slot into the normal planning workflow. Keep external evidence separate from internal product logic unless reconciliation is requested.

Return a concise diagnosis brief followed by exactly five decision slots:

1. Intended behavior
2. Blast radius and containment
3. Remediation direction
4. Rollout and compatibility
5. Verification and monitoring

Mark each slot `resolved by evidence`, `not applicable`, or `needs user decision`. For unresolved forks, present 2-3 options and recommend one. Ask only the questions that remain real choices.

## 5. Hand Off Through Existing Gates

After the decisions are settled:

1. Use `plan-hardening-loop` for a non-trivial implementation plan and counterpart review.
2. After implementation approval, state an Implementation Goal Contract and use `implementation-loop`; it owns `branch-gate`, `ready-check`, and `request-code-review`.
3. After explicit publication approval, use `ship-it`.
4. Keep patched, PR-opened, merged, deployed, and user-verified states distinct in Linear.

If two unsupported fix attempts occur later, reopen diagnosis. Do not force parallel agents, external research, an automated test, or a postmortem when a lighter proportional oracle is sufficient.
