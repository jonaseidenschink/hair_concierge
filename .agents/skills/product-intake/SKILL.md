---
name: product-intake
description: Use for Hair Concierge product-intake review-center work, including new product submissions, product research, brand review, image search/processing, affiliate URL and price sourcing, category property payloads, worker/job status debugging, rework loops, manual product additions, and guarded final product handoff into Supabase.
---

# Product Intake

## Purpose

Run the Chaarlie product-intake workflow consistently: research the product,
show Nick reviewable evidence, process the image, validate the exact database
payload, and only publish after explicit final approval.

## Required Context

Before making recommendations, changing product-intake files, researching a
product, or running commands, identify the operating mode and load the canonical
runbook from the active repo or worktree:

```text
docs/product-intake-research-ops.md
```

Read its **Which Workflow Am I In?**, **Core Rule**, **Safety Boundaries**, and
**Two Separate Readiness States** sections, plus the section for the selected
operating mode. Before product research or a publish/final-handoff action, read
the complete applicable research or approval contract first.

Use that document as the source of truth for:

- source priority, shop preference, affiliate URL, and price rules
- image candidate requirements and final image QA
- category-specific property tables and allowed values
- review-center worker, rework, publish, and safety boundaries
- legacy package approval commands

If the runbook is missing, stop and tell Nick that the product-intake contract
is unavailable rather than improvising the workflow.

## Operating Rules

- Inspect current queue, submission, job, worker, package, or review state
  before explaining what is happening.
- Keep user-facing status concrete: active, queued, blocked, waiting for review,
  needs rework, ready for final handoff, or published.
- Never imply a product is fully approved until the final product is in
  Supabase, its final image URL points at the `product-images` bucket, the
  submitted user is linked/notified through the approved handoff path, and the
  review center marks the handoff complete.
- Keep catalog-intake readiness separate from global-recommendation readiness.
  A user-submitted product may be linked while remaining
  `is_chaarlie_recommended = false`; only call it globally recommendation-ready
  when the runbook's image, category facts, thickness eligibility, exact
  protocol, lifecycle, and promotion checks all pass.
- Never run Supabase publish/apply/upload writes unless Nick explicitly approves
  the exact final handoff for that product.
- Preserve unrelated dirty files. Stage, commit, or patch only files that belong
  to the current product-intake task.
- When reviewing category properties, show and reason about the exact database
  values that will be written, not prose explanations or display labels.
- When a worker is blocked, explain the blocker, the current worker lock/slot
  state, and the next concrete action.
- Start stuck-worker work as operational inspection. Add `diagnosing-bugs` only
  after evidence identifies a reproducible code defect. Retry, requeue, cancel,
  or lock-clearing actions require explicit approval.

## Default Workflow

1. Identify the active worktree and product-intake branch.
2. Classify the operating mode, then read the runbook's core, safety, readiness,
   and mode-specific sections. Read the complete applicable research or
   publish/final-handoff contract before performing that operation.
3. Inspect live state:
   - review center submission page or URL, if provided
   - `product_submissions` status when DB access is available
   - `product_intake_research_jobs` / worker status when relevant
   - local package state for legacy package flow
4. Confirm exactly one operating mode:
   - queue triage
   - new submission research
   - brand identity review
   - image search, replacement, processing, or magenta QA
   - category property rework
   - publish preflight
   - final handoff
   - worker/job debugging
5. Apply the runbook contract for that operating mode.
6. Report status in Nick-facing terms: what happened, what is ready, what is
   blocked, and what exact next click or command is safe.

For recurring queue-triage automation runs:

- begin with `products:intake:queue`; use `products:intake:research-queue` only when the automation authorizes local research-package preparation
- keep Supabase writes and publish/apply actions human-gated; the research queue runner writes local package and image-discovery files, so omit it for strictly read-only status requests
- compare against the automation's previous state and report only new items,
  state changes, newly aged blockers, and exact later dry-run/apply commands
- do not duplicate source, image, payload, or approval policy in the automation
  prompt; those rules live in the canonical runbook

## Research Contract Checklist

Use this checklist before marking a product ready for review:

- canonical brand is resolved or explicitly awaiting brand review
- brand, product line, and clean product name are separated
- existing catalog products, including non-recommended products, were checked
- purchase URL and price follow the source priority rules
- all required preferred shops were searched before claiming no result
- raw image candidate is exact, product-only, front-facing, and renderable
- processed image passed finalizer and magenta QA
- category specs include all required tables for the category
- required category fields are current authority fields, not merely legacy
  columns or the existence of a table row
- `suitable_thicknesses` is complete for thickness-sensitive categories
- every required category role has an exact verified application protocol
- catalog-intake readiness and global-recommendation readiness are reported
  separately, with exact missing facts for either state
- review table values are exact DB payload values
- field rationales exist for product fields and category spec tables
- publish preflight passes before final handoff

## Useful Commands

Use commands from the runbook, but prefer these entry points:

```bash
npm run products:intake:review-cockpit:dev
npm run products:intake:codex-worker -- --execute-codex --watch --concurrency=2 --poll-ms=30000
npm run products:intake:queue
npm run products:intake:queue -- --status pending_review --report
npm run products:intake:research-queue -- --limit=10
npm run products:intake:finalize-image -- ops/product-intake-research/YYYY-MM-DD/<submission-id>
npm run products:intake:approve-package -- --package ops/product-intake-research/YYYY-MM-DD/<submission-id> --reviewed-by nick
```

Do not run an apply/confirm command or any final publish action unless Nick has
explicitly approved that specific product/package.
