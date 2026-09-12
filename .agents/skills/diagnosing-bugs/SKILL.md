---
name: diagnosing-bugs
description: Use for hard bugs, regressions, flaky behavior, performance regressions, broken tests, throwing code, or explicit diagnosis requests. Builds a red-capable feedback loop, ranks falsifiable hypotheses, proves root cause before fixing, and preserves the repro as final verification.
---

# Diagnosing Bugs

## Operating Model

Run two evidence lanes before any fix:

- Feedback-loop lane: build a fast command that can catch the exact bug.
- Root-cause lane: read errors and traces, inspect recent changes, trace bad data backward, and compare broken behavior with a working example.
- Let either lane block fixes. No feedback loop means the bug cannot be proven fixed. No root-cause evidence means the fix is still guesswork.
- If the work splits cleanly, use subagents only for independent surfaces such as repro harness creation, log review, or code-path tracing. Keep main-thread ownership of the final diagnosis, patch, and verification.

## Phase 1: Build The Feedback Loop

Before hypothesizing, create one command or repeatable procedure that exercises the actual bug path.

Prefer, in order:

1. A failing automated test at the real bug seam.
2. A focused integration or e2e command.
3. A curl, CLI, or script with fixture input and asserted output.
4. A Playwright or browser script that checks DOM, console, and network behavior.
5. A trace replay from captured logs, payloads, HAR files, or event streams.
6. A throwaway harness around the smallest useful subsystem.
7. A repeated flake loop with pinned time, seeded randomness, isolated filesystem, or stress timing.
8. A bisection or differential loop across commits, configs, datasets, or versions.
9. A human-in-the-loop script only when the bug truly requires manual clicks.

Completion criteria:

- The command has already been run at least once.
- It can go red on the user's exact symptom, not just on nearby failure.
- It is deterministic, or raises a flaky bug to a high enough reproduction rate to debug.
- It is fast enough to run repeatedly.
- It can be run unattended unless a human-in-the-loop script is explicitly documented.

If no loop is possible, stop and say so. List what was tried, then ask for the missing artifact, access, log, recording, or permission for temporary instrumentation.

## Phase 2: Reproduce And Minimize

Run the loop and confirm it catches the described bug.

- Capture the exact symptom: error, wrong output, timing, UI state, logs, or response body.
- Minimize inputs, callers, config, data, and steps one at a time.
- Re-run the loop after each removal.
- Keep only the pieces that are load-bearing for the failure.

Do not move on until the smallest practical repro still fails.

## Phase 3: Rank Hypotheses

Generate the evidence-supported plausible hypotheses before testing. One is
sufficient when the cause is already well constrained; do not invent
alternatives merely to meet a count.

Compare the broken path with its closest working sibling or prior state. Test every unexplained difference.

For each hypothesis, include:

- The suspected cause.
- Why current evidence supports it.
- A falsifiable prediction: what should change if this is the cause.
- The smallest probe that would distinguish it from the alternatives.

Share the ranked list with the user when useful, especially when domain or deployment context may re-rank it. If the user is unavailable and the next probe is low-risk, proceed with the best-ranked hypothesis.

## Phase 4: Instrument And Probe

Each probe must map to one hypothesis and change one variable.

Prefer:

1. Debugger or REPL inspection when available.
2. Targeted logs at component boundaries that separate hypotheses.
3. Measurement or profiler output for performance regressions.
4. Bisection when the bug appeared between two known states.

Tag temporary logs with a unique marker such as `[DEBUG-a4f2]` so cleanup is reliable.

Avoid broad "log everything" instrumentation. It creates noise and makes cleanup sloppy.

For component boundaries, guessed timing, or invalid data, use the matching branch in `references/targeted-techniques.md`.

## Phase 5: Fix With A Regression Guard

Only after the feedback loop and root-cause lane agree:

1. Turn the minimized repro into a failing regression test if there is a correct seam.
2. If no correct seam exists, document that as an architecture/testability finding.
3. Apply one focused fix for the root cause.
4. Run the minimized regression test.
5. Re-run the original feedback-loop command from Phase 1.
6. Run the relevant surrounding verification.

Do not bundle opportunistic refactors into the fix.

## Phase 6: Cleanup And Post-Mortem

Before calling the bug fixed:

- Re-run the original repro and confirm it no longer reproduces.
- Confirm the regression guard passes, or document why no correct seam exists.
- Remove all temporary `[DEBUG-...]` instrumentation.
- Delete throwaway harnesses, or move them to a clearly marked debug location only when they remain useful.
- State the confirmed root cause and the hypothesis that proved correct in the handoff, commit, or PR.
- Ask what would have prevented the bug. If the answer is architectural, hand off a follow-up after the fix, not before.

## Controlling rule

```
No fix until there is both a red-capable loop and a root-cause explanation.
```

After two unsupported fix attempts, stop patching and question the diagnosis or architecture before trying again.
