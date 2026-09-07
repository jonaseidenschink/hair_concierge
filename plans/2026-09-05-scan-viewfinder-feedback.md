# Produkt-Scan — Viewfinder-Feedback & kohärente Text-Kette

**Worktree:** `.worktrees/scan-viewfinder-feedback` on `codex/scan-viewfinder-feedback` (base 255ffa87 = origin/main tip after #523).
**Status:** evidence review confirmed (mockup https://claude.ai/code/artifact/14c3728d-7e9e-4d7c-8106-837509ea35d9), journey signed off, decision coverage `confirmed` — Nick, 2026-09-05.

## Context
Nick's phone test after the hardening merge (#521/#523): (1) no visible signal whether the scanner is searching or has seen a barcode — a mist bottle that never decoded silently fell back to the search sheet; (2) "✓ Barcode erkannt" followed by the unknown-product sheet reads as a contradiction.

## Decisions (confirmed with Nick 2026-09-05)
- B: amber outline + pill "Barcode gefunden – kurz stillhalten" when a barcode is spotted but not yet stably read; green outline + corners + plum pill "✓ Gelesen – wird geprüft" on the stable read (replaces the green "✓ Barcode erkannt").
- C: corner markers "breathe" (slow opacity pulse) while detection runs; frozen while a sheet covers the camera.
- D: idle pill reads "Suche Barcode …" with a small pulsing dot; existing hints (näher ran / weniger kippen / mehr Licht) still replace the text when they apply.
- Copy: unknown sheet gains the bridge line "Barcode gelesen – das Produkt fehlt noch in unserer Datenbank." (headline "Danke dir – das ist neu für uns!" stays); the search sheet opened by the 3 s timeout is titled "Barcode nicht lesbar?" with subline "So findest du's trotzdem." — opened manually or after a camera failure it keeps "Ohne Scan finden".
- Rejected: A sweep line ("Game-HUD"), E light edge.

**Implementation defaults:** all animation honours `prefers-reduced-motion`; the outline is an overlay positioned from the detector's bounding box (normalised to the video's intrinsic size, mapped through the `object-cover` crop), cleared after `REARM_EMPTY_DETECTIONS` empty attempts; detection cadence and all hook lifecycle logic unchanged; strings live in `guidance.ts` / `verdict-labels.ts`; the search sheet gets a `reason` prop (`"timeout" | "manual" | "camera"`); `/labs/scan` harness + `tests/scan-flow.spec.ts` assert the searching, spotted and read states. **Undiscussed consequential assumptions affecting this handoff: none.**

## Outcome (2026-09-05)
Implemented on `codex/scan-viewfinder-feedback`: detection-state seam (`onDetectionState`, pure helpers incl. object-cover mapping and rotated-frame inverse), `ScannerView` pure presentational component + `Scanner` hook wiring, breathing corners / dot pill / amber-green outline / plum read pill, debounced `sr-only` live region (visual pill silent; spotted/searching announced once per attempt), copy chain (`SCAN_HINT_SPOTTED`, `SCAN_CONFIRM_LABEL`, `SCAN_UNKNOWN_BRIDGE`, `searchReason` → timeout title), `/labs/scan` detection-state exposure, 5 new Playwright scenarios (16 total). Reviews: per-task (Opus/Sonnet) clean; Codex whole-branch → 3 Important + 2 Minor, all fixed (read-box snapshot during confirm, absolute-delta change gate + metrics off the detection path, debounced announcements, searching reset on unpause, presentational split) + one follow-up defect (announcement budget spent at mount) fixed and re-reviewed. Verification: ci:verify green; 460 scan node tests; Playwright 16/16; full node suite green except the known local billing test. Deferred: no low-light Playwright scenario; ~1 s CI headroom in the viewfinder scenarios; amber pill contrast ≈3.6:1 (signed-off colour).

## Journey
1. Camera live, nothing spotted: corners breathe, pill "● Suche Barcode …". 2. Barcode spotted: amber box on the barcode, pill "Barcode gefunden – kurz stillhalten"; box gone after 3 empty attempts. 3. Stable read: box + corners green for the 400 ms confirm, pill "✓ Gelesen – wird geprüft" (plum); sheet opens. 4. Sheet open: corners/dot frozen, pill static. 5. Unknown: headline + bridge line + category cards. 6. 3 s without a read: "Barcode nicht lesbar? So findest du's trotzdem." + the two fields.

## Tasks
1. Hook seam: `useScannerLoop` reports `onDetectionState({ kind: "searching" } | { kind: "spotted", box } | { kind: "read", box })` with `box = { x, y, width, height }` normalised 0..1 to the video's intrinsic size; spotted on every raw hit (the candidate `selectDetectionCandidate` picked), searching after `REARM_EMPTY_DETECTIONS` empties or on attempt restart; read on an accepted decode. Pure helpers + node tests for the transitions and for the object-cover mapping.
2. `scanner.tsx`: breathing corners (C), idle pill with dot (D), amber/green overlay box (B), plum read pill; reduced-motion; pause freezes animations (`detectionPaused` already a prop). UI test `tests/scan-scanner-ui.test.tsx` (hand-rolled harness like `tests/scan-flow-ui.test.tsx`) for the four states.
3. Copy: `guidance.ts` (`SCAN_HINT_DEFAULT` → "Suche Barcode …", new `SCAN_HINT_SPOTTED`, `SCAN_CONFIRM_LABEL` → "Gelesen – wird geprüft"), `verdict-labels.ts` (`SCAN_UNKNOWN_BRIDGE`), `scan-search-sheet.tsx` `reason` prop + titles, `scan-flow.tsx` passes the reason. Update affected tests.
4. Harness/spec: `/labs/scan` exposes the detection state via `data-scan-detection` on the flow root; Playwright: searching → spotted (one read) → read (two reads) states, timeout sheet title, unknown bridge line.
