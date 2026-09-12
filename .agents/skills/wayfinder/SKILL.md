---
name: wayfinder
description: Map genuinely open-ended Hair Concierge work into a destination and a small frontier of decision tickets in Linear. Use only when Nick explicitly invokes `$wayfinder`, the destination is nameable, and dependent product, architecture, or scope decisions prevent a concrete implementation outcome or scope from being stated. Resolve uncertainty through grilling, research, or conditional prototype evidence, then hand the chosen direction to `plan-hardening-loop`. Do not use for ordinary fuzzy planning, implementation, or backlog creation.
---

# Wayfinder

Turn fog into a plan-hardenable direction. Map decisions, not deliverables; do not execute the destination.

## 1. Check the boundary

Use Wayfinder only when all are true:

- Nick invoked `$wayfinder` explicitly.
- The destination can be named.
- More than one consequential decision is unresolved or the decisions depend on each other.
- The `plan-hardening-loop` planning contract—outcome, constraints, non-goals, and done-when evidence—cannot yet be stated honestly.
- The exploration is likely to span sessions or needs a durable decision map.

Skip Wayfinder and use `plan-hardening-loop` when a few grilling questions or one meaningful fork can make the plan concrete. Do not start formal Goal mode automatically.

## 2. Create or recover the map

Use the available Linear connector; consult a Linear skill when one is available. Read existing issues first and confirm the team, project, and identifiers. If the connector or access is unavailable, stop before creating a shadow tracker and report the actual capability/access failure to Nick.

Draft the map in conversation before mutating Linear:

```text
Destination: <observable end state, not a task list>
Known decisions: <settled direction and evidence>
Frontier: <unblocked decisions that can be resolved now>
Fog: <in-scope uncertainty not yet sharp enough for a ticket>
Out of scope: <explicit exclusions>
Handoff test: <what must be true to enter plan-hardening-loop>
```

Ask Nick to confirm the destination, scope, and first frontier. Then create or update one parent Linear issue as the map. Keep the map an index and decision log; keep detailed work in decision tickets.

Create one ticket per decision, using this minimum shape:

```text
Question: <one decision this ticket must settle>
Why now: <what it unlocks>
Type: grilling | research | prototype | task
Blocked by: <ticket IDs or none>
Decision criterion: <evidence that resolves it>
Resolution: <empty until resolved>
Evidence: <links or concise references>
```

Use native parent/dependency links when available. Otherwise maintain explicit ticket links and `Blocked by` IDs in the map. Do not turn implementation deliverables into Wayfinder tickets.

## 3. Resolve the frontier

On each continuation:

1. Read the map and linked tickets; do not reconstruct state from chat memory.
2. Choose one unblocked, high-leverage decision from the frontier.
3. Mark it active and resolve it with the lightest sufficient method:
   - `grilling`: ask Nick one consequential question at a time;
   - `research`: gather read-only evidence and state uncertainty;
   - `prototype`: invoke `$prototype` only after naming the question and decision criterion;
   - `task`: perform only bounded work required to expose evidence, never destination implementation.
4. Record the resolution and evidence in the ticket, close it, and update the map's known decisions, frontier, fog, and exclusions.
5. Create newly exposed decision tickets only when they are sharp enough to resolve.

Delegate only bounded independent research under the repository orchestration rules. Keep product and architecture decisions in the main session.

## 4. Exit into plan hardening

Stop Wayfinder when the destination and main product, architecture, scope, risk, and verification decisions are concrete enough to fill the planning contract, and no consequential dependency remains unresolved.

Produce a concise handoff containing:

- destination and chosen direction;
- resolved decisions and strongest evidence links;
- remaining low-risk assumptions and explicit exclusions;
- prototype findings and artifact disposition, when used;
- Linear map and ticket links.

Then invoke `plan-hardening-loop`. That loop owns implementation options, the durable plan, mockup or prototype evidence, counterpart review, designed-journey sign-off, and the handoff to execution.

## Boundaries

- Do not implement product behavior, write an implementation backlog, publish, merge, deploy, or perform production writes.
- Do not promote prototype code to production; carry only its finding into the plan.
- Do not create speculative tickets merely to make the map look complete.
- Keep transient research outside the repository unless the handoff intentionally retains it.
