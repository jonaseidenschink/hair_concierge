# Chaarlie — Project Instructions

## Role of this file

`AGENTS.md` routes Hair Concierge work. Repository-owned workflow skills live under `.agents/skills` and travel with the repository. External capabilities such as Linear and personal specialist skills are resolved from available connectors and skill discovery; a missing named skill does not imply its service is unavailable. Do not keep a same-named local copy of a repo skill. Prefer the smallest skill set that covers the task and state the chosen skills and order when it matters. If skill discovery is unavailable, apply the named gate directly from this file rather than skipping an approval boundary.

Use current repository contracts for workflow authority; dated memories provide context and evidence, not replacement instructions. Read supporting documents only when their scope applies. Select one owning workflow, then add specialist skills for a concrete dependency or risk. Plugin investigation requires a relevant technical symptom and platform context; frustration words or a dev-server start alone do not justify a second workflow. Reuse applicable browser/check evidence across helpers instead of repeating identical checks.

## Core workflow

```text
[$wayfinder ->] worktree:new -> plan-hardening-loop -> implementation-loop (ready-check -> request-code-review) -> ship-it -> merge -> worktree:finish
```

- `$wayfinder` is an explicit, optional pre-planning loop for a nameable destination whose dependent decisions still prevent a concrete implementation outcome or scope. It keeps a small Linear decision map, may invoke `prototype` for one named uncertainty, and hands the resolved direction to `plan-hardening-loop`. Skip it when ordinary grilling can make the work plan-shaped.
- Start persistent planning in the task worktree. Keep the chosen plan and durable mockup or prototype evidence with the PR; archive or discard transient review artifacts explicitly.
- `plan-hardening-loop` owns non-trivial planning, decision coverage, meaningful option comparison, user-facing evidence, counterpart plan review, revision, and a final designed-user-journey walkthrough. It invokes `prototype` only when a runnable UI or logic artifact is needed to settle a named decision that lighter mockups cannot answer. Creation or hardening stops only after decision coverage is current and confirmed; user-facing work also requires Nick to review the evidence and explicitly confirm the journey. Review-only requests end with findings and missing gates, without requiring implementation approval.
- `implementation-loop` owns execution of an approved plan or clearly bounded non-trivial non-user-facing change. It enforces confirmed decision coverage before editing, then invokes `ready-check` and `request-code-review` before its review-ready handoff; do not rerun them as separate top-level phases on unchanged content.
- `ready-check` owns repository and user-flow verification, including final decision-coverage revalidation when the controlling workflow requires it.
- `request-code-review` is the single repository review router. Do not separately stack `code-reviewer`, thermo review, and other general review skills unless it delegates those lenses.
- `ship-it` owns explicitly authorized publication branches. “Ship it” means commit, push, and draft PR. A later “merge it” is separate authorization for verified-head squash merge plus guarded cleanup of that exact task; deployment and production writes remain separate.

### Merge and finish

- **“Merge it”** means refresh the final PR and verify its author, reviewed head SHA, required checks, review state, migrations, content fingerprints, unresolved conversations, artifact disposition, and task-worktree status before merging that exact task.
- For a PR authored by `NickRuppy`, Nick’s explicit **“merge it”** authorizes `gh pr merge <number> --admin --squash --match-head-commit <reviewed-head-sha>` solely to bypass the impossible self-approval requirement. Never use that bypass while another required gate is pending or failing.
- For a PR authored by anyone else, never use an admin bypass. Require an approving review from `NickRuppy`, then squash-merge with `gh pr merge <number> --squash --match-head-commit <reviewed-head-sha>`.
- After either merge path, verify the merged PR and merge SHA; then run `npm run worktree:finish -- --pr <number>` followed by the same command with `--apply` when its dry run passes.
- Run `worktree:finish` only from the primary root checkout on `main`. It may update a clean root with a fast-forward and clean only the exact merged task’s remote branch, unlocked clean worktree, metadata, and local branch. Never use it to stash, reset, rebase, force-remove, or infer ownership.
- If cleanup refuses after the merge, preserve the remaining artifacts and report the exact blocker. The completed merge is not authorization to repair dirty or ambiguous state.
- **“Merge but keep the worktree until <condition>”** is a rare retention path. Merge with the same reviewed-head guard, lock the local worktree using `git worktree lock --reason`, keep its local branch, record the release condition, and delete the merged remote branch only when no dependent PR or collaborator still needs it. Do not invoke `worktree:finish` until the retention condition is satisfied and the worktree is unlocked.
- The final receipt names the PR, reviewed head SHA, merge SHA, root status, deleted artifacts, and intentional leftovers. Merge never implies deployment or production writes.

### `bug`

Use only when Nick explicitly invokes `$bug` with a screenshot, message, example response, log, or symptom. It owns sanitized intake, Linear canonicalization, evidence-led diagnosis, proportional research, and the five-decision brief. Invocation authorizes Linear maintenance plus read-only investigation, not containment or code/publication changes. After decisions, hand off to the existing core workflow.

### `wayfinder`

Use only when Nick explicitly invokes `$wayfinder` for work that is too open-ended to satisfy the `plan-hardening-loop` planning contract because multiple consequential decisions are unresolved or dependent. It maps decisions rather than implementation tasks, requires confirmation before creating or updating the Linear map, and exits as soon as the direction can be hardened into an implementation plan.

### Goal versus loop

- A **Goal** is the durable outcome that should remain stable across turns.
- A **plan** is the editable set of steps toward that outcome.
- A **loop** is a reusable procedure encoded in a skill.

Use formal Goal mode only when the user explicitly asks for it and the implementation is likely to span several turns, resumptions, or a long autonomous sequence. Before creating one, inspect any active goal. Formal Goal mode supplements the compact implementation contract; it does not replace it. For normal one-turn implementation work, use the contract and a short working plan. Quick audits, questions, routine queue passes, small fixes, and recurring automations need neither.

## Domain skills

### `hair-care-expert`

Use for external hair-care research, evidence-sensitive rules, myth or overreach audits, medically adjacent boundaries, and evidence review of rough specs. Keep external evidence independent from internal methodology unless the user explicitly asks for reconciliation. It is valid to conclude that evidence is weak or inconclusive.

### `category-specific-recommendation`

Use only when Nick explicitly invokes it to define one Personal Plan product category end to end. It owns the Stage 1/2/3 decision contract, exact-product reconciliation, application rules, deterministic fixtures, and catalog/launch gates. Use `hair-care-expert` first only when new external evidence is requested; preserving current internal recommendation behavior does not require external research.

### `product-intake`

Use for product-intake research, review-center operations, image work, rework, worker debugging, publish preflight, and guarded final handoff. `docs/product-intake-research-ops.md` is the source of truth; automation prompts must not restate its policy. For a stuck worker, start with `product-intake` alone to inspect job, queue, and lock state; add `diagnosing-bugs` only after evidence identifies a reproducible code defect. Keep diagnosis read-only; retry, requeue, cancel, or clear a lock only with explicit approval.

### `product-research-engine`

Use for formula-first product research with a category engine: classifying a new Shampoo or Conditioner from its INCI, running production projections (Shampoo Production Light, Conditioner Production Adapter), maintaining classification standards under `docs/research/`, or bootstrapping an engine for a new category from the category template. It routes to the versioned category contract and enforces the shared engine invariants (blind formula-first, product truth vs. user fit, immutable artifacts, no production writes). Guarded publish and the rest of intake stay with `product-intake`.

### `funnel-variant-creator`

Use for campaign-matched landing and offer packages, the shared funnel generator, and bounded fork-based draft PRs. Contributors edit only `src/funnels/**`, `public/images/funnels/**`, and `docs/funnel-briefs/**`. Landing tracking stays route-owned, and offer variants render the shared pricing slot exactly once. Tracking, cookies, analytics, checkout, payment IDs, migrations, workflows, activation, and merge remain owner-controlled. Fork CI skips live-secret checks visibly; never work around that with `pull_request_target` or production credentials.

## Planning decisions

For non-trivial plans, present 2-3 similarly scoped approaches only for meaningful product, architecture, UX, data, rollout, verification, risk, or scope forks. Explain what gets easier, what gets harder, and the residual risk. Let the user choose when local evidence cannot settle the fork.

Use the decision-coverage record in `plan-hardening-loop` for non-trivial implementation and every user-facing change. A choice is consequential when it can change user-visible behavior, product semantics, scope, data ownership, access or payment, rollout, recoverability, or material risk. Resolve those choices with Nick; keep routine technical defaults out of approval requests. An explicit request for clearly bounded non-user-facing work can authorize execution without a second acknowledgement when no consequential choice remains: state the contract, cite that request, and proceed. Preserve the original user acknowledgement; record internal revalidation separately. New consequential choices block only dependent work. Quick audits, questions, queue/status passes, tiny non-user-facing fixes, and routine non-user-facing automations skip this record unless a consequential choice appears. "Tiny" means no effect on the consequential categories above, not a line-count threshold. A separate operator/integration walkthrough is needed only to settle a consequential choice absent from the approved contract. User-facing evidence and journey sign-off below remain mandatory.

For every user-facing change, inspect the current product surface and create at least one reviewable mockup during planning. Use the lightest useful format: an annotated screenshot for a small existing-surface change, a wireframe for a new hierarchy or flow, or rendered lightweight HTML for layout and responsive behavior. For copy-only work on an existing surface, show the before/after copy inside the real component layout. Show 2-3 variants for meaningful visual forks, use realistic German copy, and include responsive or critical error/loading states when they materially affect the experience. Markdown, ASCII, detached copy samples, and prose-only descriptions do not count as mockups for an existing surface.

Invoke `prototype` from the mockup step only after grilling has named the question and decision criterion, and only when interaction, changing state, or a logic model cannot be judged reliably from static evidence. Treat the result as planning evidence: record what it proved, then rewrite any retained behavior through the normal production implementation and test workflow.

Before implementing a user-facing plan, record the reviewed mockup or prototype evidence and incorporated feedback, then translate the final design into the concrete user journey and walk Nick through it once more. Include entry state, ordered user actions and system responses, error/recovery states, meaningful variants, and completion. Require confirmed evidence review and explicit journey sign-off; earlier general plan approval does not satisfy either gate.

## Orchestration

The main session owns user intent, product and architecture decisions, decomposition, worktree and write-scope decisions, integration, final verification, artifact disposition, and the user-facing handoff.

Delegate only bounded, independently executable work when parallelism materially helps or when noisy exploration would harm the main context. Prefer:

- `fast_explorer` for read-only mapping, research, and log or test-output analysis
- `routine_worker` for well-specified mechanical edits and test-fixing to a known oracle
- `judgment_worker` for German copy, UX/taste calls, ambiguous implementation, and tricky deterministic logic

Every delegated brief must state the objective, context, owned files or question, edit permission, constraints, non-goals, acceptance checks, and expected evidence. Parallel writers need disjoint scopes. The main session reviews every result and runs final verification. Model selection lives in the host agent configuration: keep bounded exploration/execution on the configured workers and reserve the judgment worker for difficult independent judgment. Prefer larger coherent scopes over unnecessary agent handoffs.

## Counterpart-model review

Use exactly one external counterpart lane per review pass:

- When Codex is the orchestrator, use `claude-plan-review` for non-trivial plan review, meaningful whole-branch review before push, and independent judgment when stuck.
- When Claude or Fable is the orchestrator, use the configured Codex review agent for those same checkpoints.

The reviewer is read-only and terminal: it returns a verdict and must not invoke another reviewer. The orchestrator verifies findings locally, rejects false positives, and retains the final decision. Do not run counterpart review for trivial fixes, routine exploration, every worker result, or merely to obtain a cleaner approval sentence. Do not silently convert reviewer-proposed product, scope, architecture, or risk tradeoffs into decisions.

## Project conventions

- All UI text is in German.
- Vocabulary: `hair_texture` = pattern (straight/wavy/curly/coily); `thickness` = diameter (fine/normal/coarse).
- No over-engineering: build only what is requested and avoid speculative abstractions.
- Use test-first development for deterministic logic in `src/lib/routines/`, `src/lib/rag/router/`, and `src/lib/quiz/`.
- Keep recommendation logic as deterministic as the evidence allows.
- Do not present weak evidence as a hard rule.
- Separate cosmetic guidance from medically adjacent scalp or hair-loss guidance.
- When evidence is mixed, keep product behavior conservative and explicit about uncertainty.
- Supabase project ID: `pqdkhefxsxkyeqelqegq`.
- Local QA access (dev login, `/labs` harnesses, local post-payment testing): `docs/local-qa-access.md`.

## Git workflow

- Default to repo-local worktrees for implementation, fixes, and parallel investigations.
- Keep the root checkout on a clean `main`; `worktree:new` fetches and fast-forwards it before creating a task.
- Create or reuse `.worktrees/<slug>` on `codex/<slug>` before writing a persistent plan or implementation change.
- Use `npm run worktree:new -- <slug>` and `npm run dev:worktree`.

## Working outputs

- Put the chosen implementation plan in the task worktree under `plans/` and include it in the PR.
- Keep durable mockup or prototype decision evidence with the PR. Store transient reviewer output outside the repository, then archive or discard it explicitly.
- Put reusable project docs in `docs/`.
- Only add to `questions-for-domain-review.md` when internal domain review is genuinely required and external evidence or repository context cannot resolve the question.
- Keep workflow instructions and receipts concise; link to the owning rule instead of repeating it.
