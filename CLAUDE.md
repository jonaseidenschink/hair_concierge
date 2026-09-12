# Chaarlie — Project Instructions

## Core Workflow

```text
[$wayfinder ->] worktree:new -> plan-hardening-loop -> implementation-loop (ready-check -> request-code-review) -> ship-it -> merge -> worktree:finish
```

This file adapts the shared `AGENTS.md` workflow to Claude's tools. Its Claude-specific session/tool instructions do not govern Codex. Current repository contracts take precedence over dated workflow memories. This is the repo's canonical loop, shared with Codex. Each stage's contract of record is `.agents/skills/<name>/SKILL.md` — read it when entering the stage. Claude-side execution of each stage:

- **`$wayfinder`** — explicit-only pre-planning for open-ended work; read its SKILL.md when Nick invokes it.
- **`plan-hardening-loop`** — run via Plan Mode + the User-Facing Planning Gates below. Creation or hardening ends with current, confirmed decision coverage and an approved implementation handoff (for user-facing work: confirmed evidence review + journey sign-off). Review-only requests end with findings and missing gates.
- **`implementation-loop`** — enforce the decision-coverage intake gate, then execute via `executing-plans` / `subagent-driven-development`, `branch-gate` first.
- **`ready-check`** — repo, decision-coverage, and user-flow verification on the exact tree to be reviewed: run the checks appropriate to the approved change and observe the affected flow when one changes; reuse applicable evidence under `ready-check`. Documentation-only changes need instruction/metadata/reference validation, not an application build.
- **`request-code-review`** — the single review router; on the Claude side this is the Codex whole-branch review ("Finishing a Feature Branch" step 2). One counterpart lane, no stacked reviewers.
- **`ship-it`** — the `/ship` agent: publish-only (commit, push, PR). Skip re-running verification `/ship` would duplicate on an unchanged tree.
- **`merge` / `worktree:finish`** — the "merge it" flow in "Ship Workflow"; merge is separate authorization from shipping.

**Debugging** enters the loop from the side: `$bug` (explicit-only) owns intake and the five-decision brief; for hard bugs, regressions, or flaky behavior use `superpowers:systematic-debugging`, holding it to the repo's evidence bar in `.agents/skills/diagnosing-bugs/SKILL.md` — red repro first, ranked falsifiable hypotheses, root cause proven before fixing, repro preserved as final verification. Fixes then rejoin the loop at `implementation-loop`.

## Plan Mode

Inspect the task context first. For plan creation or hardening, follow `plan-hardening-loop`; for a review-only request, finish with findings and missing implementation gates rather than starting a new approval interview.

Present 2-3 similarly scoped options only for a meaningful unresolved fork. Recommend a direction from evidence and ask only when the remaining choice is consequential. Do not ask the user to choose routine implementation details.

Use the decision-coverage record and acknowledgement rules in `plan-hardening-loop`. An explicit request for bounded non-user-facing work can authorize execution without a second acknowledgement when no consequential choice remains. Preserve the original user approval and scope; record internal revalidation separately. Create or reuse the task worktree before writing the chosen plan under `plans/`.

Quick audits, questions, queue/status passes, tiny non-user-facing fixes, and routine non-user-facing automation runs may skip the options comparison and decision-coverage checkpoint unless evidence exposes a consequential choice. "Tiny" means mechanically bounded work that cannot affect a consequential category above; line count alone does not make a change tiny. User-facing work still requires decision coverage plus the mockup and journey gates below even when the eventual code diff is small.

## User-Facing Planning Gates

Before any user-facing implementation:

1. Inspect the current product surface and create at least one reviewable mockup during planning. Use an annotated current/proposed screenshot for a small existing-surface change, a wireframe for a new flow, or rendered lightweight HTML for layout and responsive behavior. For copy-only work, show the before/after copy inside the real component layout. Markdown, ASCII, detached copy samples, and prose-only descriptions do not count as mockups for an existing surface.
2. Show 2-3 variants for a meaningful visual fork, use realistic German copy, and include responsive or critical loading/error/recovery states when they materially affect the experience.
3. If interaction, changing state, or a logic model cannot be judged from static evidence, first name the question and decision criterion, then follow the repo's `prototype` contract (`.agents/skills/prototype/SKILL.md`) as a higher-fidelity branch of this mockup step. Record what it proved and rewrite retained behavior through the normal production implementation and test workflow.
4. Present the relevant evidence to Nick, incorporate feedback, and record evidence review as confirmed in the implementation plan.
5. Translate the final design into a concrete user journey: entry state, ordered user actions and system responses, meaningful variants, error/recovery states, and completion.
6. Revalidate and present the final decision-coverage record with the journey, then obtain explicit sign-off. Earlier general plan approval does not satisfy the evidence or journey gate, and sign-off is invalid while an open or undiscussed consequential assumption affects the handed-off scope.

Before implementation, follow the current `implementation-loop` intake. User-facing work requires confirmed evidence review and user-journey sign-off. For internal work, the approved implementation contract suffices unless an operator/integration interaction introduces a consequential choice absent from that contract. State that no surface, copy, timing, or user-visible feedback changes. Pause only work dependent on unresolved choices; continue independent authorized work. The quick-work exemption above remains conditional on no consequential choice surfacing.

## Branch Gate

Before writing a persistent plan or invoking `executing-plans` or `subagent-driven-development`, invoke `branch-gate` first.

## Repo Skill Contracts (`.agents/skills`)

The repo's workflow contracts live in `.agents/skills/<name>/SKILL.md` (Codex-side skills, not registered in Claude's skill list). When Nick invokes one — `$bug`, `$wayfinder`, `product-intake`, `category-specific-recommendation`, `funnel-variant-creator`, `prepare-content-research`, `prototype` — read its SKILL.md and apply the contract directly; do not skip an approval boundary because the skill isn't discoverable here. Explicit-only skills (`$bug`, `$wayfinder`, `category-specific-recommendation`, `prepare-content-research`) run only when Nick names them. The governing routing file for these contracts is `AGENTS.md`.

## Multi-Model Orchestration

The main interactive session (intended: Fable 5) is the orchestrator: it owns decomposition and routes independently executable work to a suitable model. Keep small or tightly coupled execution in the main session. Delegate bounded independent work when parallelism or moving noisy exploration out of context materially helps; do not delegate merely to keep the main session free of implementation.

**Execution routing (Agent tool, `model` override):**

- **Explore agent (or Haiku)** — read-only tier (≈ AGENTS.md `fast_explorer`): codebase mapping, targeted research, log/test-output analysis, and any noisy exploration that would pollute the main context. Never for edits.
- **Sonnet** — default execution tier (≈ `routine_worker`): mechanical/multi-file edits, boilerplate, well-scoped tasks with clear acceptance criteria, test-fixing to a known oracle.
- **Opus** — judgment tier (≈ `judgment_worker`): ambiguous scope, German UI copy, UX/taste calls, tricky deterministic logic in `src/lib/routines/`, `src/lib/rag/router/`, `src/lib/quiz/` (the main session owns the test-first design; Opus implements to green).
- Bias toward Sonnet; escalate to Opus only when the task needs judgment.

**Decomposition discipline:**

- Split only genuinely independent, specifiable units — dispatched subagents do NOT share the main session's conversation context, so each brief must be self-contained.
- Every delegated brief states: the concrete objective and context, the owned files or question, whether the agent may edit files, constraints, non-goals, acceptance checks, and the evidence expected on handback. Parallel writers need disjoint write scopes.
- Do not shatter tightly-coupled work into context-starved subagents; keep coupled logic in one unit.
- Use `superpowers:dispatching-parallel-agents` for 2+ independent tasks and `subagent-driven-development` when executing a written plan. Run `branch-gate` first (mandatory).

**The main session does these itself — never delegated:**

- Architecture, task decomposition, routing, final review/integration.
- Edits to `.claude/*`, `CLAUDE*.md`, and `AGENTS.md`.

**Codex (GPT) — reviewer & second-opinion lane:**

- Use the `codex:codex-rescue` agent (via the Agent tool with `subagent_type: "codex:codex-rescue"`), never the `/codex:rescue` skill (it stalls silently).
- Do not pin a model — it inherits the global Codex default from `~/.codex/config.toml`, so it tracks the configured default. Add `--effort high` for these deeper passes.
- Use for: whole-branch review before push (see "Finishing a Feature Branch"), plan review on non-trivial plans, and any "stuck / want an independent second opinion" moment.
- Every review brief must explicitly say: `read-only, review only, do not edit files`; never pass `--write`.
- A session invoked as a reviewer is terminal: review and return the verdict; do not dispatch the other model for another review.
- Use exactly one external counterpart lane per review pass — do not stack Codex plus other general review agents on the same content.
- Reviewer-proposed product, scope, architecture, or risk tradeoffs are proposals, not decisions — never adopt them silently; surface them to Nick.

**Verify every delegated result — never rubber-stamp.** Read the full diff, run `npm run ci:verify` or the relevant tests, drive the affected flow. Reject false positives; keep only what checks out.

## Git Workflow

- Default to repo-local worktrees for new implementation work, fixes, and parallel investigations
- Keep the root checkout on a clean `main`; `worktree:new` fetches and fast-forwards it
- Create or reuse `.worktrees/<slug>` on `codex/<slug>` before writing persistent plans or implementation changes
- Use `npm run worktree:new -- <slug>` to create a bootstrapped worktree
- Use `npm run dev:worktree` inside a worktree so parallel runs do not fight over the same port
- Include the chosen plan and durable mockup or prototype evidence in the PR; keep transient review output outside the repo and explicitly archive or discard it
- Put reusable project docs in `docs/`; add to `questions-for-domain-review.md` only when internal domain review is genuinely required and external evidence or repo context cannot resolve the question
- Keep workflow receipts concise; link to the owning rule instead of repeating it

## Project Conventions

- All UI text is in German
- Vocabulary: `hair_texture` = pattern (straight/wavy/curly/coily), `thickness` = diameter (fine/normal/coarse)
- No over-engineering — only build what's requested, no speculative abstractions
- Supabase project ID: `pqdkhefxsxkyeqelqegq`
- Local QA access (dev login, `/labs` harnesses, local post-payment testing): `docs/local-qa-access.md`
- Use TDD (test-first) for deterministic logic in `src/lib/routines/`, `src/lib/rag/router/`, `src/lib/quiz/`
- Keep recommendation logic as deterministic as the evidence allows
- Do not present weak evidence as a hard rule; when evidence is mixed, keep product behavior conservative and explicit about uncertainty
- Separate cosmetic guidance from medically adjacent scalp or hair-loss guidance

## Finishing a Feature Branch

When all tasks on a worktree/feature branch are complete, follow this order before pushing:

1. **Verify** — follow `ready-check` and the approved verification scope. For application changes run the relevant repository checks, including `npm run ci:verify` where required; for instruction-only changes validate the instructions, metadata, references, and behavioral boundaries. Reuse applicable recorded proofs while checking the final proposed tree.
2. **Codex review** — Fetch the latest remote refs, then invoke the `codex:codex-rescue` agent (via the Agent tool with `subagent_type: "codex:codex-rescue"`) on the full branch diff (`git diff origin/main...HEAD`) with an explicit `read-only, review only, do not edit files` brief and no `--write`. Do NOT use the `/codex:rescue` skill — it has been observed stalling silently. This step catches integration-level issues (wrong API flags, outdated library patterns, cross-file problems) that per-task reviews miss.
3. **Fix findings** — Address any real issues Codex found. Skip false positives.
4. **Resolve artifacts** — Commit, archive, or discard every task-owned artifact.
5. **Push + PR** — Push only a clean task worktree. The PR is the durable record.

## Ship Workflow

Standard finish command: use the `/ship` agent when implementation is done.

- `/ship` applies `.agents/skills/ship-it/SKILL.md`: validate matching verification/review receipts and publication authority, then commit, push, and create the draft PR.
- Do not simplify reviewed code, stack reviewers, or repeat valid checks during publishing. Missing/stale evidence returns to its owning verification/review workflow.
- The explicit shipping request authorizes those actions without another confirmation; pre-commit hooks and required CI remain in force.
- Report real blockers without resetting or unstaging unrelated work.

`/ship` remains publish-only. After it returns a PR, a later explicit **“merge it”** authorizes verified-head squash merge plus guarded cleanup of that exact task:

1. Refresh final PR, check, review, migration, and content-fingerprint state, then merge only the reviewed head. For a PR authored by `NickRuppy`, "merge it" authorizes `gh pr merge <number> --admin --squash --match-head-commit <reviewed-head-sha>` solely to bypass the impossible self-approval requirement — never while any other required gate is pending or failing. For a PR authored by anyone else, no admin bypass: require an approving review from `NickRuppy`, then `gh pr merge <number> --squash --match-head-commit <reviewed-head-sha>`.
2. Verify GitHub reports the PR merged and record the merge SHA.
3. From the primary root checkout on `main`, run `npm run worktree:finish -- --pr <number>`; when the dry run passes, run it again with `--apply` without asking for another confirmation.
4. Report root sync, remote branch, worktree, local branch, and any preserved blocker. Deployment and production writes remain separate.

**“Merge but keep the worktree until <condition>”** is the rare opt-out: perform the same verified-head merge, lock the retained worktree with `git worktree lock --reason`, retain its local branch, and record the release condition. Delete the remote branch only when no dependent PR or collaborator needs it. Do not run the finisher until the worktree is intentionally released and unlocked.

## Session Start

- Use `/checkin` when Nick asks for daily priorities or a check-in; do not prepend it to unrelated tasks.
- A running dev server alone is not a reason to run chat evaluations. Run them when the changed behavior or requested verification requires them.
