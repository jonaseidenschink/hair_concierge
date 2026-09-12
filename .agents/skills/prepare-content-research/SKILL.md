---
name: prepare-content-research
description: Explicit-only Hair Concierge workflow for preparing verified, provenance-rich research packages from curated repository guidance plus targeted external evidence when needed. Use only when the caller explicitly invokes $prepare-content-research to research a content topic, misconception, category explanation, ingredient question, named-product question, or medically adjacent hair-care boundary before downstream content creation.
---

# Prepare Content Research

Prepare structured research for downstream content work. Return and save evidence-backed research only. Do not write scripts, hooks, voice guidance, visual direction, storyboards, video prompts, CTAs, generation payloads, or publication plans.

## Required resources

Before selecting sources or writing claims, read:

- `references/source-policy.md` for source tiers, gap escalation, claim support, exclusions, verification, and persistence rules.
- `references/source-manifest.json` for the allowlisted repository source routes.

Use `assets/research-template.md` as the Markdown output structure. Produce the structured package first, then render the Markdown from the same facts.

## Explicit invocation gate

Proceed only when the caller explicitly invoked `$prepare-content-research` or asked to use this exact skill by name. If it was loaded implicitly, do not execute this workflow; return to the caller's authorized task without asking for reinvocation.

## Workflow

1. Read the caller's initial brief completely.
2. Identify only missing material fields:
   - the exact question, decision, or misconception to resolve;
   - audience baseline or region, only when it changes evidence selection;
   - whether this is category education, named-product research, ingredient/formula analysis, or a medically adjacent boundary;
   - intended research scope: short video, long-form material, or series.
3. Ask at most four intake questions in one compact prompt. Skip fields the caller already supplied. Never ask about voice, hook, style, visuals, CTA, script, storyboard, generation, or publication.
4. Restate the research scope and proceed without a ceremonial approval question unless the source route is materially ambiguous.
5. Classify the request by:
   - category package or advisory topic;
   - claim types: category guidance, routine behavior, product fact, ingredient/science, current market/product source, safety or medical-adjacent boundary;
   - risk: ordinary cosmetic advice, freshness-sensitive product claim, scientific uncertainty, or medical-adjacent content.
6. Build the minimum repository source packet from `references/source-manifest.json`:
   - load category Markdown plus paired JSON for selected categories;
   - load base packages by purpose;
   - load adjacent categories only for a real boundary or comparison;
   - load runtime/test surfaces only for claims about current Chaarlie behavior;
   - load product/catalog surfaces only for named-product or formula identity claims.
7. Do not use repository-wide search as retrieval. Do not use `plans/`, `docs/archive/`, `docs/agent-v2-guidance-migration/`, `data/agent-guidance/`, or unbounded `src/` as primary content authority. Migration docs may be audit-only.
8. Record repository commit SHA, the source-policy version, and the manifest `schema_version`.
9. Extract candidate atomic claims from the source packet before writing the narrative summary.
10. Mark every claim with provenance and support level. Omit unsupported claims from findings; keep useful blocked claims only in `do_not_claim` or `open_gaps`.
11. Before external research, record the material repository gap as a concrete unsupported question. Only then invoke `$hair-care-expert` for scientific, regulatory, expert, medically adjacent, exact-current-product, or formula freshness evidence. Label all external evidence separately from repository guidance.
12. Preserve conflicts and uncertainty. Do not let external evidence silently overwrite current repository/runtime behavior; show both when material.
13. Run a fresh read-only verification pass before persistence:
    - Prefer a context-isolated sub-agent when available.
    - Render a draft Markdown handoff from the structured package; do not add facts during rendering.
    - Give the verifier only the raw request, intake answers, source packet, structured package, rendered draft Markdown, and output contract.
    - Ask it to re-check source entailment, provenance labels, conflicts, safety boundaries, unsupported claims, and Markdown/JSON parity.

14. Repair verified defects once, downgrade uncertain claims, preserve unresolved conflicts, and set verification status to `verified`, `partial`, or `blocked`.
15. Determine whether persistence is safe before creating any package file:
    - Use the `branch-gate` skill if available, or run equivalent read-only git status/worktree checks.
    - If invoked from protected root `main`, create a task worktree with `npm run worktree:new -- content-research-<date>-<slug>` and write there.
    - Reuse an exact-task worktree only when the path, branch, and cleanliness are unambiguous.
    - Never overwrite an existing package folder; add a timestamp or increment.
    - If persistence fails or the checkout is unsafe, return the full research and set `persistence_skipped` with the exact reason.

16. Run `node .agents/skills/prepare-content-research/scripts/validate-research-package.mjs <draft-package.json> --output-path <new-request-folder>` in the safe task worktree. If persistence is unavailable, pass the package on standard input with package path `-` and omit `--output-path`, so validation does not require a repository write. Repair validation failures before persistence; if they cannot be repaired, return the research as blocked with the errors and do not write an invalid package.
17. Save `research.md` and `package.json` under `content-research/<date>-<slug>/`. Render the Markdown from the validated package and re-check that its claim ledger, sources, gaps, and verification result match the JSON. Do not commit, stage, push, publish, update production data, or trigger content generation unless separately authorized.
18. Return the complete human-readable research package, saved path or `persistence_skipped`, verification status, and unresolved blockers.

## Package contract

The structured package must include:

- `schema_version`
- `request_id`
- `status`
- `created_at`
- `research_scope`
- `intake`
- `repository.commit_sha`
- `repository.source_policy_version`
- `repository.source_manifest_version`
- `findings[]`
- `claims[]`
- `sources[]`
- `material_gaps[]`
- `conflicts[]`
- `open_gaps[]`
- `do_not_claim[]`
- `verification`
- optional `feedback`
- optional `persistence_skipped`

Allowed source types are:

- `repository_guidance`
- `repository_runtime`
- `repository_product_data`
- `external_scientific`
- `external_regulatory`
- `external_expert_guidance`
- `current_product_source`
- `synthesis`
- `unsupported`

Allowed support levels are:

- `direct`
- `supported_synthesis`
- `uncertain`
- `conflicted`
- `unsupported`

Every non-unsupported claim must cite at least one source. Unsupported claims may appear only in `open_gaps`, `do_not_claim`, or a claim entry with `support_level: unsupported` and `verification_status: rejected` or `blocked`.
