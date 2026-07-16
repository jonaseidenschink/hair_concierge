# Routine Tracker Final Stability, UX, and Motion Plan

Date: 2026-07-13
Status: Approved Chaarlie-native visual correction implemented and locally verified
Worktree: `/Users/nick/AI_work/hair_conscierge/.worktrees/routine-tracker`
Branch: `codex/routine-tracker`
Base: uncommitted experimental tracker implementation in this worktree
Chosen visual correction mockup: `.superpowers/brainstorm/routine-tracker-chaarlie-native-mockup.html`
Structural research reference only: `.superpowers/brainstorm/routine-tracker-calai-inspired-mockup.html`

Release hardening completed before publication:

- `20260713150000_harden_routine_tracker_rpc_payloads.sql` enforces payload bounds at the
  authenticated RPC boundary and preserves absent-delete revision tombstones;
- Agent diary windows use the latest stored tracker timezone rather than a UTC calendar date;
- successful autosave bursts quietly refresh server-derived gate, rhythm, and nudge state;
- the linked migration and direct authenticated RPC behavior are covered by the live tracker suite.

## Goal

Turn the experimental `/tracker` page into a mobile-first diary that feels immediate, stable,
encouraging, and trustworthy. Logging an activity and its products must be quick enough to use
repeatedly, while every save, progress message, and animation remains truthful.

When complete:

- the main page is a calm, normally scrollable diary with today plus seven backfill dates and one clear entry action;
- logging happens in the shared bottom sheet, with five canonical activities plus a user-written custom activity;
- activity-specific product suggestions are helpful but never presented as recorded fact;
- product rows never reorder while the user is interacting;
- rapid changes coalesce into serialized, atomic background saves;
- `Gespeichert` appears only after the latest full entry is durably stored;
- custom activities are stored for later research but excluded from cadence, nudges, and recommendation calculations;
- the rhythm card uses the existing shampoo frequency target and encouraging, non-punitive copy;
- purposeful motion clarifies selection, sheet position, saving, and progress without scroll effects or decorative animation;
- the page is visually native to Chaarlie's existing authenticated product, not a Cal AI visual imitation;
- mobile browser, reduced-motion, error, rapid-edit, and accessibility behavior are covered by tests.

## Visual Design Contract

Cal AI informed workflow compression, feedback timing, and the separation between daily summary and entry editing.
It is not a visual reference. The existing Chaarlie product is the visual source of truth.

- Preserve the approved information architecture and interaction layout: date strip, daily summary, bottom sheet,
  smart product list, autosave feedback, and rhythm card. This correction is a restyle, not a second UX redesign.
- Reuse the existing `Header`, `BottomSheet`, `Button`, form controls, focus treatment, and authenticated-page spacing
  wherever their behavior fits. Tracker-specific components may compose these patterns but must not introduce a
  parallel component language.
- Use the tokens already defined in `src/app/globals.css`: cream/background and white/card surfaces; plum for
  selection, focus, and guidance; coral for the primary entry action; and the existing heading/body/subdued text tokens.
  Raw Tailwind families such as `sky`, `emerald`, `amber`, `rose`, and `stone` are not permitted for tracker styling,
  except the shared destructive/error tokens where the existing system already uses them.
- Use Chaarlie's editorial typography: Playfair/display treatment for the page title and Plus Jakarta Sans/body
  hierarchy for controls and compact operational copy. Do not introduce oversized marketing typography.
- Match the softer authenticated Routine language: rounded content surfaces, restrained borders, subtle depth,
  compact icon tiles, and generous but mobile-efficient spacing. Do not nest decorative cards or turn every section
  into a floating container.
- Use color to communicate hierarchy, not to assign a different hue to every activity. Activity meaning comes from
  label, description, and icon; selected state uses one consistent plum treatment.
- Keep semantic success, warning, and error states quiet. Autosave must remain legible without green becoming a
  second primary brand color.
- Motion follows the Motion Specification below. It is purposeful state feedback, not a substitute for brand styling.
  No scroll reveal, parallax, confetti, looping decoration, or animated layout.
- Before implementation approval, compare the mockup side by side with `/routine` and `/profile` at mobile width.
  Before declaring the restyle complete, capture screenshots at 390x844 and 1280x900, verify reduced motion, and
  reject the result if it could plausibly belong to an unrelated wellness app after removing the Chaarlie wordmark.

## Implementation Goal Contract

**Goal:** implement the chosen tracker experience and persistence contract in the existing isolated worktree.

**Constraints:**

- Keep canonical tracker semantics for `wash`, `clarifying`, `treatment_only`, `styling_only`, and `none`.
- Add `custom` only as an explicit, non-cadence activity.
- Keep all user-facing copy German.
- Keep one log per user and date and retain today plus the seven previous editable dates.
- Use `PRODUCT_FREQUENCY_METADATA` and the existing CareBalance shampoo target. Do not create another frequency table.
- Use Tailwind/CSS and the existing `BottomSheet`; do not add Framer Motion or another animation dependency.
- Keep the work isolated in `codex/routine-tracker`; preserve all current task changes and unrelated generated Supabase temp files.
- Do not stage, commit, push, open a PR, merge, deploy, or clean up the worktree without explicit approval.
- Do not apply the follow-up migration to the linked Supabase project without explicit approval in the implementation turn.

**Non-goals:**

- Custom activities changing profile frequency, CareBalance, nudges, or agent cadence calculations.
- A general custom-routine builder, activity management screen, reminders, photos, notes, ratings, heatmaps, or gamified points.
- Product creation inside `/tracker`; products continue to be managed in the profile.
- Cross-device optimistic locking. Within one page session saves are ordered; across sessions the database remains last-write-wins.
- Offline synchronization. V1 retains a failed local draft and offers retry but does not claim it is durably queued offline.
- Scroll-linked animation, parallax, auto-advancing content, confetti, shimmer loops, or per-section reveal effects.
- A production feature flag or kill switch. This remains an isolated experiment; any later production rollout uses migration-before-deploy ordering and PR revert as rollback.

**Done when:** focused unit/API tests, authenticated Playwright tests, typecheck, lint, build, the existing tracker tests,
and a mobile simulated-user review pass; no false save confirmation, stale overwrite, row movement, overflow, or reduced-motion violation remains.

## Settled Product Decisions

### Main page and entry flow

The main page remains a normal vertical document. Its order is:

1. `Tagebuch` and selected date, with `(Nachtrag)` for a past date.
2. Eight-date strip: today plus the seven valid backfill dates.
3. Existing entry summary or a primary `Routine eintragen` action.
4. `Dein Waschrhythmus` with target progress and encouraging copy.
5. Unlocked evidence-backed nudges only when the existing trust gate allows them.

Remove these presentation elements:

- the top `N Tage seit deiner letzten Wäsche` annotation;
- `Log-Tage N von 10`;
- the pre-unlock `Muster & Hinweise` progress block;
- a generic `N Wochen aktiv` badge;
- `Produkt hinzufügen` from the tracker.

In the current implementation these removals map to the wash-age header in `tracker-page-client.tsx`,
`GateProgress` in `tracker-widgets.tsx`, and the add-product controls in `log-day-card.tsx`.

The sheet opens for a new entry or for editing an existing one. `Fertig` flushes the latest valid draft and closes the sheet;
it is a close command, not a required save action. Activity selection itself creates the draft and starts autosave.

### Activity vocabulary

| Value            | Label                  | Description                        |
| ---------------- | ---------------------- | ---------------------------------- |
| `wash`           | `Haare gewaschen`      | `Mit Shampoo oder Co-Wash`         |
| `clarifying`     | `Klärwäsche`           | `Mit klärendem Shampoo`            |
| `treatment_only` | `Pflege ohne Wäsche`   | `Maske, Kur oder Öl`               |
| `styling_only`   | `Styling aufgefrischt` | `Mit Wasser oder Stylingprodukt`   |
| `none`           | `Keine Haarpflege`     | `Keine Produkte verwendet`         |
| `custom`         | `Eigene Aktivität`     | `Für alles, was sonst nicht passt` |

The canonical five remain stable identifiers. `custom` requires a trimmed name of 1-60 characters.
Custom activity remains in this v1 scope. It is a diary entry, but it does not count toward the trust gate's
distinct-log-day threshold and cannot unlock cadence-based nudges.

`Fertig` is disabled while an inline `Bitte gib einen Namen ein.` validation message is visible. Close, Escape,
backdrop, and drag dismissal may abandon an empty invalid custom draft without a confirmation because it has
not created a valid entry or selected products; valid drafts always follow the autosave contract.

### Smart product presentation

- Keep product order fixed by shared category order, then normalized product name, then stable usage ID.
- Never sort by checked state and never reorder after a save refresh.
- Show each shelf product with a compact catalog thumbnail before its identity text, matching the production Routine
  card treatment at a smaller scale: the standardized `#F3EFE8` image tile, uncropped `object-contain` packaging,
  and the existing category fallback when `image_url` is missing. Keep the checkbox on the trailing edge so each row
  scans as image, product identity, selection. The image is decorative (`alt=""`); the checkbox label carries the
  complete accessible product name.
- For a canonical activity, show likely categories first and the remaining shelf under `Weitere passende Produkte`.
- Do not hide shelf products that could plausibly be used; smartness is ordering and prefill, not a hard exclusion rule.
- Prefill from the latest same-activity log. If absent, use the existing canonical fallback categories.
- For a custom activity, show the full shelf with nothing selected. Recent-name suggestions and matching-name prefill are deferred until the one-month usage review.
- Clear the prefill explanation after the user changes a product.
- `none` never shows products and the API/database reject products for it.
- Replace the add-product control with small copy and a profile link: `Produkte kannst du in deinem Profil verwalten.`

### Autosave and atomic editing

1. Every valid activity or product action updates the local draft immediately.
2. One framework-free coordinator owns a 500 ms trailing coalescing window.
3. At most one save request is in flight across the tracker page.
4. A pending slot per date keeps only the newest complete snapshot: date, timezone, activity, custom name, and products.
5. The page creates one UUID client session and monotonically increasing per-date revisions. Revisions prevent an older
   response, refresh, or keepalive request from replacing newer intent from the same page session.
6. The server replaces the log and all product rows in one transaction and returns the persisted snapshot.
7. The pending/saving status is shown only if a request lasts at least 300 ms, avoiding status flicker.
8. Success copy is `Gespeichert`; failure copy is `Konnte nicht gespeichert werden.` with `Erneut versuchen`.
   Retry network failures and `5xx` once after a one-second backoff; validation and ownership failures never auto-retry.
9. A failed draft remains visible. It does not affect rhythm, nudges, aggregation, or agent context until server-confirmed.
10. `Fertig`, sheet close, and day change request a coordinator flush without starting parallel writes.
    Tracker writes use `fetch(..., { keepalive: true })`; `pagehide` and `visibilitychange` promote a pending
    debounce to a best-effort keepalive flush. Do not use `beforeunload` or claim an unconfirmed write is saved.
11. An empty custom name remains local and invalid; show `Bitte gib einen Namen ein.` and do not send it.
12. Deletion is one atomic action with `Eintrag gelöscht` and `Rückgängig`; undo restores the previous full snapshot.

`draftsByDate` is the rendered source of truth for visited dates. `data.days` is the last confirmed server state.
Do not optimistically mutate both stores. Cross-tab and cross-device writes remain database last-write-wins in this experiment.

### Rhythm and encouragement

Use the existing CareBalance shampoo `frequencyTarget` and
`PRODUCT_FREQUENCY_METADATA[minFrequency|maxFrequency|preferredFrequency]`.
Only confirmed `wash` and `clarifying` logs count. `custom`, even if it contains shampoo, does not count.

- Weekly targets (`minPerWeek >= 1`) use the current ISO week and show the target band.
- Biweekly and monthly targets use aligned 2- or 4-ISO-week periods so a zero-wash week is not mislabeled as failure.
  Periods are anchored to the fixed ISO Monday `1970-01-05`; period membership is the integer number of ISO weeks
  since that anchor divided into groups of two or four, so ISO year boundaries cannot change parity.
- The progress fill is actual confirmed washes divided by the preferred target for the active period, capped visually at 100%.
- A target band such as 3-4 is represented in text and accessible labeling, not as false decimal precision.
- Consecutive rhythm language is limited to weekly targets and uses completed ISO weeks only. The current incomplete
  week neither extends nor breaks it. Biweekly/monthly targets show current-period progress without a streak.
- The existing lightweight all-history trust query includes `logged_on` and `day_type`; its newest 63 days feed rhythm,
  so current periods and up to eight completed weekly periods are available without loading old product rows or adding a query.
- `less_than_monthly` is presented as a neutral no-progress target (`Dein empfohlener Rhythmus ist seltener als monatlich.`);
  it does not use a fabricated four-week progress bar or streak.

Copy states:

- below target: `Noch eine Wäsche bis zu deinem empfohlenen Rhythmus.` or pluralized
  `Noch N Wäschen bis zu deinem empfohlenen Rhythmus.`;
- inside target: `Du liegst in deinem empfohlenen Rhythmus.`;
- above target: `Du hast diese Woche häufiger gewaschen als empfohlen.` with neutral styling;
- no target: `Mit weiteren Einträgen wird dein Waschrhythmus hier sichtbar.`;
- completed sequence: `Seit 3 Wochen in deinem Rhythmus.` or the equivalent period-aware wording.

Do not display a streak until at least two completed eligible weeks exist. The existing trust gate still controls nudges,
but its pre-unlock countdown is not shown on this page.

## Motion Specification

Motion is included, but only where it explains state or spatial continuity.

| Surface          | Trigger                 | Motion                                                                       | Timing                              | Reduced-motion behavior              |
| ---------------- | ----------------------- | ---------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------ |
| Bottom sheet     | Open                    | `translateY` from bottom plus scrim fade                                     | panel 300 ms ease-out; scrim 180 ms | no travel; instant or 100 ms opacity |
| Bottom sheet     | Close                   | `translateY` down plus scrim fade                                            | panel 200 ms ease-in; scrim 160 ms  | instant removal or short opacity     |
| Sheet drag       | Pointer drag            | panel follows pointer; downward settle/dismiss                               | gesture-driven, 200 ms settle       | drag still works; immediate settle   |
| Day selection    | Tap a date              | selected style immediately; entry content crossfade                          | 140 ms                              | immediate swap                       |
| Activity tile    | Tap                     | background/border/check transition; pressed scale only while pointer is down | 140 ms                              | immediate state, no scale            |
| Product checkbox | Tap                     | native check and row-color transition                                        | 140 ms                              | immediate state                      |
| Save status      | pending/success/error   | icon/text opacity crossfade                                                  | 160 ms                              | text swaps immediately               |
| Rhythm progress  | confirmed value changes | `scaleX` from previous confirmed value                                       | 450 ms ease-out                     | fill jumps immediately               |
| Initial load     | genuinely unknown data  | stable skeleton geometry, then content fade                                  | 120 ms                              | immediate replacement                |

Implementation rules:

- Use `transform` and `opacity` for moving surfaces; use short color transitions for selected states.
- Do not animate layout, list order, height, `top`/`left`, blur, large shadows, or scroll position.
- Do not run JavaScript on page scroll for visual effects.
- Interactions remain available during animation; network completion never delays visual selection.
- The sheet retains a close button and `Fertig` as non-drag alternatives.
- Fix the shared bottom sheet's inline animations so `prefers-reduced-motion: reduce` covers panel and backdrop.
- Add tracker-scoped timing variables or a small `motionPreset="tracker"` API for the new timings; preserve the
  shared component's default timing for `product-detail-drawer.tsx` and `routine-drawer.tsx`.
- Keep body scroll locked while the sheet is open, sheet content independently scrollable, and the footer keyboard-safe using `dvh`/safe-area spacing.
- Use pre-mounted polite and assertive live regions; save meaning must never depend only on motion or color.

## Data and API Contract

Create one forward-only migration after the already-applied tracker migration:

`supabase/migrations/20260713120000_routine_tracker_atomic_autosave.sql`

It must:

- extend the `routine_logs.day_type` check to include `custom`;
- add nullable `custom_activity_name text`;
- add nullable `client_session_id uuid` and `client_revision bigint` columns for same-session ordering;
- add nullable `deleted_at timestamptz` so deletion retains a revision tombstone;
- enforce `custom` iff a trimmed name of 1-60 characters is present;
- enforce `none` with no custom name;
- create/replace authenticated `replace_routine_log(...) -> jsonb` and `delete_routine_log(...) -> jsonb` functions,
  both accepting client session/revision data;
- validate `auth.uid()`, date, activity/custom-name invariants, and linked product ownership;
- replace parent and children transactionally;
- lock the target row and reject/no-op a lower revision from the same client session; a different session remains
  database last-write-wins and replaces the stored session/revision;
- make deletion transactional but soft: set `deleted_at`, retain client session/revision, and delete product rows.
  A higher-revision replace clears `deleted_at`; a lower same-session save cannot resurrect the entry;
- return structured success/error codes and the persisted day;
- the initial design used `SECURITY INVOKER`; migration `20260713143000_secure_routine_tracker_write_boundary.sql`
  superseded it with pinned-search-path `SECURITY DEFINER` functions, and Task 11 replaces those authenticated
  signatures with service-role-only explicit-user variants.

The API repeats Zod validation and maps structured codes to `400`, `403`, and generic `500` responses.
GET preserves the existing 28-day full-detail log/product window for aggregation, nudge cadence, and same-canonical-activity
prefill. The client renders only its newest eight dates. The existing unbounded lightweight trust query widens its projection
to `(logged_on, day_type)` and filters `deleted_at IS NULL`; use its newest 63 days as rhythm history rather than adding another
database round trip. GET also returns the existing frequency target. Independent reads should be parallelized where their inputs permit it.
Raw custom names are stored only in the user's diary data and are not sent to PostHog.
All diary readers, including `load-tracker-days.ts`, the 28-day detail query, trust/rhythm history,
aggregation, and agent context, filter `deleted_at IS NULL`.

Aggregation, nudge inputs, and cadence-facing agent context must explicitly filter `dayType === "custom"`.
The non-cadence diary context may describe the custom entry as user-authored context without inferring standardized meaning.
Custom days are also excluded from `observedWeekKeys`, category distinct-usage days, and the trust gate's qualifying-day count.
The trust-gate query selects `logged_on, day_type`, filters `deleted_at IS NULL`, and the date list is filtered by `day_type`
in `getTracker` before calling `evaluateTrustGate`; pure gate tests alone cannot prove this handler-level exclusion.

## Target File Map

### Create

- `supabase/migrations/20260713120000_routine_tracker_atomic_autosave.sql`
- `src/lib/tracking/presentation.ts`
- `src/lib/tracking/save-coordinator.ts`
- `src/lib/tracking/rhythm.ts`
- `src/components/tracker/use-tracker-autosave.ts`
- `tests/tracker-presentation.test.ts`
- `tests/tracker-save-coordinator.test.ts`
- `tests/tracker-rhythm.test.ts`
- `tests/tracker-page.spec.ts`

### Modify

- `src/lib/tracking/types.ts`
- `src/lib/tracking/api-handlers.ts`
- `src/lib/tracking/aggregation.ts`
- `src/lib/tracking/nudges.ts`
- `src/lib/tracking/load-tracker-days.ts`
- `src/lib/agent/tools/tracking-context.ts`
- `src/app/api/tracker/log/route.ts`
- `src/components/tracker/tracker-page-client.tsx`
- `src/components/tracker/log-day-card.tsx`
- `src/components/tracker/tracker-widgets.tsx`
- `src/components/ui/bottom-sheet.tsx`
- `src/app/globals.css`
- `tests/tracker-api.test.ts`
- `tests/tracker-aggregation.test.ts`
- `tests/tracker-nudges.test.ts`
- `tests/tracker-trust-gate.test.ts`
- `tests/tracker-agent-context.test.ts`

### Preserve

- original tracker table migration and RLS history;
- 14-day/10-distinct-log trust-gate calculation;
- profile frequency values and CareBalance target ownership;
- unrelated header, middleware, agent runtime, and analytics changes already present in the worktree.

## Task Checklist

### Task 1: Lock presentation, custom-activity, and rhythm contracts in pure tests

- [x] Add `presentation.ts` tests for all six labels/descriptions, activity-specific ordering, stable shelf order,
      prefill-source copy, profile disclaimer, and absence of removed progress/streak copy.
- [x] Extend `TrackerDayType` with `custom`, add `customActivityName`, and define pure validation helpers.
- [x] In the same green cycle, update or remove every exhaustive `Record<TrackerDayType, ...>` including
      `TRACKER_DAY_TYPE_LABELS_DE`, `PRECHECK_CATEGORIES`, and the current `DAY_TYPE_EMOJI` map so typecheck never waits for Task 4.
- [x] Explicitly add a distinct `custom` marker to the partial `DOT_CLASS` map; its fallback currently matches `none`
      and typecheck cannot detect that semantic collision.
- [x] Add `rhythm.ts` tests covering ISO-week boundaries, 3-4/week target bands, biweekly/monthly periods,
      current-period incompleteness, consecutive completed weekly periods, no target, above-target neutral copy,
      `less_than_monthly`, singular/plural encouragement, and exclusion of custom/unconfirmed drafts.
- [x] Extend aggregation/trust tests to prove custom days affect neither `observedWeekKeys`, category distinct-usage days,
      wash-cadence denominators, nor the 10-day trust threshold.
- [x] Keep numeric conversion exclusively in `PRODUCT_FREQUENCY_METADATA`.

**Acceptance:** pure tests define the copy, ordering, target math, and exclusion rules before UI work.

### Task 2: Add the forward-only schema change and atomic RPC boundary

- [x] First run `npm exec -- supabase migration list --linked` and confirm `20260708150000` is applied;
      stop and reconcile if the live schema does not match that prerequisite.
- [x] Write the migration with the `custom` constraint, soft-delete tombstone, and transactional replace/delete functions.
- [x] Add the client session/revision columns and row-lock comparison that makes same-session keepalive ordering durable.
- [x] Extend API schemas and fake Supabase client support for `rpc`.
- [x] Prove one RPC per save, persisted response handling, ownership rejection, `none`/products rejection,
      invalid custom names, custom/product persistence, deletion, stale same-session revision no-op, different-session
      last-write-wins, stale-save-after-delete non-resurrection, and unexpected rollback behavior.
- [x] Preserve the existing 28-day full-detail nudge/prefill input; widen the existing all-history trust projection
      to `logged_on, day_type` and derive the newest 63 days for rhythm without another query.
- [x] Filter deleted and custom log dates in the handler before evaluating the trust gate and pin this in `tracker-api.test.ts`.
- [x] Add the `DELETE` HTTP export in `src/app/api/tracker/log/route.ts`.
- [x] Select `custom_activity_name` in `load-tracker-days.ts` and describe custom entries as user-authored,
      non-standardized context in `tracking-context.ts` without feeding cadence calculations; filter soft-deleted rows.
- [x] Do not apply the migration remotely during this task.

**Acceptance:** handler tests prove a rejected or rolled-back write cannot become success or partially replace products.

### Task 3: Implement serialized autosave, drafts, retry, flush, and undo

- [x] Build a framework-free coordinator with injected timer/save functions, 500 ms trailing coalescing,
      global single-flight behavior, per-date pending snapshots, revisions, retry, flush, and idle notification.
- [x] Tests must prove max concurrency one, intermediate-snapshot skipping, two-date retention, stale-response rejection,
      failure retention, one retry for network/`5xx`, no retry for `4xx`, flush behavior, server-side revision ordering,
      stale-save-after-delete non-resurrection, and deletion undo.
- [x] Bind it through `use-tracker-autosave.ts`; React must not own a second debounce.
- [x] Use keepalive-capable tracker writes and `pagehide`/`visibilitychange` for the best-effort final flush;
      never use `beforeunload`, start parallel normal saves, or report success before server acknowledgement.
- [x] Separate confirmed `data.days` from `draftsByDate`; do not refresh after every checkbox.
- [x] Delay visible pending status by 300 ms and expose truthful polite/assertive live regions.

**Acceptance:** rapid edits remain immediate and the final confirmed database snapshot always matches the latest page-session intent.

### Task 4: Move logging into the bottom sheet and implement custom activities

- [x] Keep the main page scannable; replace the inline form with existing-entry summary plus `Routine eintragen`/`Eintrag bearbeiten`.
- [x] Render the six activity tiles in the bottom sheet with stable dimensions, Lucide icons, `aria-pressed`,
      selected checks, two-column mobile layout, and one-column fallback for narrow screens.
- [x] Give confirmed custom days a neutral but distinct week-strip marker and an accessible label containing the custom name;
      do not make them visually identical to unknown/unlogged days or `Keine Haarpflege`.
- [x] Implement custom-name input, validation, a full unselected shelf, and no cadence semantics; do not add recent-name suggestions yet.
- [x] Put `Eintrag entfernen` as a restrained destructive text action in the sheet footer for existing entries only;
      deletion closes the sheet and exposes the short-lived `Rückgängig` action without a confirmation modal.
- [x] Make `Fertig` flush and close; keep close, Escape, and drag dismissal consistent with pending valid drafts.
- [x] Ensure keyboard opening, safe-area inset, body scroll lock, focus trap, and focus restoration work on mobile browsers.

**Acceptance:** logging and editing require no save tap, custom activity is usable, and closing never discards the latest valid draft.

### Task 5: Make product suggestions smart, stable, and profile-owned

- [x] Sort likely activity categories first and the rest under `Weitere passende Produkte`; never hide plausible shelf products.
- [x] Preserve same-activity history prefill and explain its source only while untouched.
- [x] Keep all rows fixed through checking, saving, refresh, activity switching, and reload.
- [x] Remove product creation controls from the tracker.
- [x] Add `Produkte kannst du in deinem Profil verwalten.` with the existing profile route.
- [x] Keep `none` product-free and custom initially unselected.

**Acceptance:** product selection feels relevant without silently asserting use or moving controls under the user's finger.

### Task 6: Replace generic streak UI with frequency-target rhythm and encouragement

- [x] Wire the existing shampoo CareBalance target into `rhythm.ts` and `RhythmBand`.
- [x] Derive the 63-day rhythm slice from the widened lightweight trust/history query and use the fixed epoch-Monday anchor for low-frequency periods.
- [x] Render target text, confirmed count, progress bar, encouragement, and completed-week continuity only when valid.
- [x] Remove top wash-age annotation, log-day counter, pre-unlock trust progress, and generic active-week badge.
- [x] Keep nudges hidden until the existing trust gate unlocks them; do not replace the gate algorithm.
- [x] Ensure custom and failed/pending drafts never affect displayed confirmed progress.
- [x] Treat `less_than_monthly` as neutral target copy without progress or continuity.

**Acceptance:** the card motivates toward the user's actual target without implying failure from missing or incomplete evidence.

### Task 7: Implement the complete restrained motion system

- [x] Add tracker-scoped sheet timing for the specified 300/200 ms panel and 180/160 ms scrim transitions;
      preserve default timings for the existing product-detail and routine drawers.
- [x] Implement tracker timing through CSS custom properties rather than a new named preset enum.
- [x] Add an optional shared `BottomSheetFooter` outside the scroll region so the tracker footer is keyboard/safe-area aware;
      existing consumers keep their current structure unless they opt in.
- [x] Add reduced-motion-safe sheet travel, drag settle, day crossfade, tile/checkbox feedback, save-status crossfade,
      and 450 ms progress interpolation.
- [x] Animate only `transform`, `opacity`, and short state colors; keep row geometry stable.
- [x] Remove animation on reduced motion and verify no meaning depends on movement.
- [x] Do not add a motion library, scroll handler, parallax, reveal cascade, looping animation, or decorative motion.

**Acceptance:** the experience feels responsive and polished at 60 fps while remaining calm and fully usable without motion.

### Task 8: Add authenticated browser, accessibility, and interaction regressions

- [x] Add a `test.skip` live-secret-guarded `@ci` Playwright suite with a dedicated authenticated user and cleanup;
      missing secrets must not throw at module load or break unrelated Playwright suites.
- [x] Cover sheet open/close/drag, background scroll lock, keyboard/focus restoration, day selection,
      custom validation, profile link, activity prefill, fixed product order, rapid toggles, save failure/retry,
      deletion undo, correct backfill date, and persisted reload state.
- [x] Assert max concurrent tracker writes is one and forged cross-user products are rejected.
- [x] Test `390x844`, `320x700`, and `1280x800` for overflow, overlap, clipped labels, and stable controls.
- [x] Emulate `reducedMotion: "reduce"` and assert no sheet travel or progress interpolation.
- [x] Smoke the existing product-detail and routine drawer open/close behavior after the shared reduced-motion fix.
- [x] Use stable network/status/database oracles, never arbitrary sleeps.

**Acceptance:** the test turns red on the current race, false-success, inline-form, motion, and custom-activity gaps and green after implementation.

### Task 9: Full verification, review, and experimental handoff

- [x] Run focused tests:

```bash
./node_modules/.bin/tsx --test \
  tests/tracker-presentation.test.ts \
  tests/tracker-save-coordinator.test.ts \
  tests/tracker-rhythm.test.ts \
  tests/tracker-trust-gate.test.ts \
  tests/tracker-aggregation.test.ts \
  tests/tracker-nudges.test.ts \
  tests/tracker-api.test.ts \
  tests/tracker-agent-context.test.ts
npm run typecheck
npm run lint
git diff --check
```

- [x] After explicit migration approval, apply only the exact follow-up migration and verify migration history.
      Do not use broad `db push` while this worktree has unrelated migration-history divergence.
- [ ] Restart the authenticated worktree server, run Playwright against its actual port, and inspect mobile screenshots.
- [x] Run `npm run ci:verify`, `npm run test:node`, and the relevant authenticated tracker suite.
- [ ] Run a fresh simulated-user review focused on activity clarity, custom activity, prefill trust,
      autosave confidence, encouragement, row stability, and mobile interaction.
- [x] Run the repository-mandated read-only whole-branch Claude/Codex review over the complete diff.
- [x] Stop before staging, commit, push, PR, merge, deploy, or cleanup for explicit user approval.

### Task 10: Apply the approved Chaarlie-native visual correction

- [x] Replace tracker-specific `sky`, `emerald`, `amber`, `rose`, and `stone` styling with the Visual Design Contract's
      existing Chaarlie tokens and authenticated-product patterns.
- [x] Extend the tracker shelf response with the catalog `image_url` already available through the loaded Routine
      artifact usage rows; do not add a second database request solely for images.
- [x] Extend `ShelfItem` with nullable image metadata and render the production-style compact image tile in
      `log-day-card.tsx`, with the existing category-icon fallback for products without an image.
- [x] Keep the current layout, autosave behavior, product ordering, sheet mechanics, and rhythm calculations unchanged.
- [x] Add browser assertions that image and fallback rows retain stable geometry, checkbox accessibility, and no
      horizontal overflow at 320px and 390px.
- [x] Compare final screenshots against `/routine` and the approved Chaarlie-native mockup before acceptance.

**Acceptance:** recognizable catalog imagery improves product selection without turning this visual correction into a
new interaction redesign or weakening the existing functional test evidence.

## Verification Details

Remote migration application, when approved, must use the surgical exact-file path established for this experiment:

```bash
npm exec -- supabase migration list --linked
npm exec -- supabase db query --linked --file \
  supabase/migrations/20260713120000_routine_tracker_atomic_autosave.sql
npm exec -- supabase migration repair --linked --status applied 20260713120000
npm exec -- supabase migration list --linked
```

The original code path depends on the atomic RPC and columns, so those additive migrations are applied before the tracker
code. Task 11 is a contract migration: first land and verify the admin-client API implementation locally, then apply the
exact entitlement-boundary migration to the linked database, immediately rerun authenticated denial plus API success
smokes, and only then deploy the code. This ordering is safe here because the tracker application code is not yet in the
production base; do not reuse it for an already-live caller without an explicit expand/switch/contract rollout.

Start a fresh local server after database code changes so deep imports are not stale:

```bash
LOCAL_DEV_LOGIN_ENABLED=1 npm run dev:worktree
PLAYWRIGHT_BASE_URL=http://localhost:<reported-port> \
  npx playwright test tests/tracker-page.spec.ts --project=chromium
```

## Risks and Mitigations

| Risk                                               | Mitigation                                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Older same-session request overwrites newer intent | One coordinator plus RPC row locking and persisted client session/revision comparison.  |
| Stale save resurrects a deleted entry              | Soft-delete tombstone retains the latest session/revision; readers filter `deleted_at`. |
| Product replacement partially fails                | One transactional RPC returning the persisted snapshot.                                 |
| A refresh replays animations or moves rows         | Stable keys/order and merge only into dates without newer drafts.                       |
| Autosave appears magical or unreliable             | Delayed pending copy, confirmed success, persistent failure, retry, and live regions.   |
| Custom names contaminate product guidance          | Explicit filtering in aggregation, nudges, rhythm, and cadence agent context.           |
| Weekly UI mislabels low-frequency targets          | Use aligned 2-/4-week periods below one wash per week.                                  |
| Motion causes jank or discomfort                   | Composited properties, no scroll effects, reduced-motion fallback, mobile tests.        |
| Bottom sheet drag conflicts with scrolling         | Existing top/handle gesture boundary, pointer threshold, close/Fertig alternatives.     |
| Linked schema diverges from code                   | Exact migration approval gate and surgical migration application.                       |
| Experimental scope leaks into production           | Worktree isolation and stop line before all shipping actions.                           |

## Claude Review Disposition

Review files:

- `plans/2026-07-10-routine-tracker-stability-ux.claude-review.md`
- `plans/2026-07-10-routine-tracker-stability-ux.claude-review-final.md`
- `plans/2026-07-10-routine-tracker-stability-ux.claude-review-blocker-recheck.md`

Accepted and patched:

- add a separate 63-day lightweight rhythm history and limit continuity language to weekly targets;
- define low-frequency period alignment from the fixed ISO Monday `1970-01-05`;
- update all exhaustive day-type maps in Task 1 so intermediate typecheck stays green;
- add the missing DELETE route and custom-name loader surfaces to the file map;
- use keepalive-capable writes plus `pagehide`/`visibilitychange` for best-effort mobile flush durability;
- keep shared drawer timings unchanged through a tracker-scoped motion preset and smoke both existing consumers;
- map removed mockup concepts to the actual current components;
- test both custom-day cadence leaks: observed-week coverage and category distinct-usage counts;
- verify the prerequisite linked migration before writing/applying the follow-up migration.
- preserve the 28-day full-detail nudge/prefill supply while adding a separate 63-day lightweight rhythm history;
- add persisted client session/revision ordering so unload keepalive cannot let an older same-session write win;
- filter custom days at the handler site before trust-gate evaluation;
- define `less_than_monthly` as neutral no-progress copy and pluralize below-target encouragement;
- place deletion in the sheet footer and add the optional shared footer structure;
- guard live-secret Playwright coverage with `test.skip`, not a module-load throw.
- name the partial `DOT_CLASS` custom marker explicitly so custom cannot inherit the `none` fallback;
- retain a soft-delete revision tombstone so a stale same-session keepalive cannot resurrect deletion;
- widen the existing trust projection and reuse its 63-day slice for rhythm rather than adding another query.

Owner decisions resolved from the approved product direction:

- custom activities stay in this implementation rather than a follow-up;
- deletion and atomic undo stay in this implementation;
- custom days do not count toward cadence, nudges, or the trust gate;
- an empty invalid custom draft can be abandoned by dismissal, while `Fertig` remains disabled and explains the validation error;
- the strip contains eight dates: today plus seven backfill dates;
- the original RPC design used `SECURITY INVOKER`; the implemented boundary was subsequently hardened to
  `SECURITY DEFINER`, and Task 11 supersedes its authenticated signatures;
- this isolated experiment has no kill switch; any future release applies migration before deploy and uses PR revert as rollback.
- custom names remain one-off diary labels in v1; recent-name suggestions/prefill wait for the one-month review;
- one automatic retry is allowed for network/`5xx`, followed by explicit manual retry; `4xx` never auto-retries;
- `less_than_monthly` uses neutral target copy rather than invented four-week progress.
- protecting the final sub-second mobile edit is worth the two revision columns and RPC ordering guard;
- the full authenticated Playwright breadth remains funded for this experiment because it directly covers the reported flakiness,
  mobile sheet behavior, reduced motion, and the new security boundary.

Deferred:

- cross-session optimistic concurrency;
- durable offline synchronization;
- a custom-activity management screen;
- recent custom-name suggestions and matching-name prefill;
- continuity streaks for biweekly/monthly targets.
- DB-wide entitlement-aware RLS/API migration for the pre-existing Chat, Profile, Routine, onboarding, and memory
  tables. This requires a separate authorization design because those surfaces currently span roughly twelve
  owner-accessible tables and Profile/onboarding still perform browser-direct Supabase writes. Task 11 unifies their
  user-facing route/API paywall but does not misrepresent that as retroactive database isolation.

Unresolved decisions: none.

## Post-Review Hardening Pass (2026-07-14)

An independent whole-branch review after implementation found five additional gaps. The product decisions are now
settled:

- Chat, Profile, Tracker, and Routine require authentication plus current paid/manual app access. Existing user data is
  retained after expiry so it becomes available again after resubscription.
- Tracker additionally closes its newly introduced direct-Supabase data path: a user without current app access cannot
  read or mutate tracker data through authenticated Supabase calls.
- Custom activity names remain available to Chat as user-authored diary observations, but never as instructions,
  cadence inputs, recommendation inputs, or saved profile truth.
- Dismissing an empty invalid custom activity restores the latest valid state for that day. If no valid state exists,
  the day remains empty.

### Task 11: Close entitlement, context, autosave, and focus-boundary findings

- [x] Make `hasCurrentAppAccess` the shared route-level predicate for Chat, Profile, Tracker, and Routine. Add `/profile`,
      `/api/profile`, and Profile's `/api/memory` dependency to the subscription-required prefixes while preserving
      billing, checkout, authentication, and resubscription routes. Keep the already-gated Chat, Routine, Tracker, and
      Onboarding prefixes unchanged. Use the authenticated session client plus `{ userId: user.id, email: user.email }`
      in middleware so email-only manual grants remain visible under their existing RLS policy. Legacy profile
      entitlements recognized by `hasCurrentAppAccess` deliberately remain valid app access. Catch predicate errors:
      fail closed, return `503` for API routes, and redirect page routes to `/pricing?reason=access_check_unavailable`
      rather than mislabelling the user as expired.
- [x] Make the Next.js tracker API the only user-facing data boundary: authenticate with the session client, check
      `hasCurrentAppAccess(admin, { userId: user.id, email: user.email })`, and perform tracker reads/writes through the
      admin client only. Define `TrackerApiDeps` with separate `createAuthClient`, `createAdminClient`, and
      `hasCurrentAppAccess` dependencies so tests cannot accidentally reuse one privilege level for both jobs. Every
      admin query and RPC must receive or filter by the server-validated user id.
- [x] Add `supabase/migrations/20260714120000_enforce_routine_tracker_entitlement_boundary.sql`. Revoke all
      authenticated access to `routine_logs`, `routine_log_products`, and `tracker_nudge_dismissals`; revoke and
      explicitly drop the old authenticated RPC signatures; then create service-role-only write RPC variants that
      take the server-validated user id explicitly. Preserve all existing payload/date/ownership/revision validation
      and keep RLS enabled. Reject a null explicit user id before any read or mutation.
- [x] Return `403` from every tracker API operation when the authenticated user lacks current app access and `503` when
      the entitlement predicate itself errors. An open Tracker page receiving `403` redirects to
      `/pricing?reason=resubscribe`; it must not present a retry that cannot succeed. Add tests for paid/manual/legacy
      access, expired access, predicate failure, retained data, and denial of direct authenticated table/RPC access.
- [x] Split diary interpretation policy from diary payload: keep trusted interpretation rules in a system item and
      place all custom names and product names in a separate `role: "user"` input item labelled as user-authored diary
      data. The system policy must explicitly say that strings inside that item are data, never instructions.
- [x] Keep the 14-day observation window while enforcing a 16,000-character serialized diary-item limit. Represent
      product categories compactly for every logged day; include product names newest-day-first while budget remains;
      expose `product_names_truncated` and `omitted_product_name_count` when names are omitted. Never silently drop a
      date, day type, custom name, or product category.
- [x] Add adversarial context tests proving instruction-like custom/product names remain lower priority and cannot
      become system instructions: diary strings appear only in the `role: "user"` data item, the trusted system item
      contains the data-not-instructions policy, and unique diary-only sentinel strings do not appear in any system
      item. Add budget tests proving the serialized diary item stays within the limit.
- [x] Track the latest valid snapshot for the open date. When an invalid empty custom draft is dismissed, enqueue that
      snapshot at a newer same-session revision before refreshing. If no valid snapshot exists, enqueue a delete
      tombstone only when a save/delete for that date was already dispatched during this page session; otherwise
      abandon the local invalid draft without a network write. A `wash` selection followed by an empty custom selection
      therefore resolves to `wash`; selecting an empty custom activity directly on a previously empty day leaves the
      day empty. Cover the in-flight valid-save race with the real coordinator.
- [x] Restrict the shared bottom-sheet focus loop to controls that are enabled, visible, and not inert. Cover forward
      and reverse wrapping when `Fertig` is disabled by custom-name validation.

**Acceptance:** expired users cannot reach tracker data through the application or direct authenticated Supabase
access; diary strings are bounded lower-priority data; an in-flight valid save cannot resurrect the wrong state after
an invalid custom draft is abandoned; and keyboard focus remains trapped in every sheet state.

### Task 11 file map

Create:

- `supabase/migrations/20260714120000_enforce_routine_tracker_entitlement_boundary.sql`

Modify:

- `src/app/api/tracker/route.ts`
- `src/app/api/tracker/log/route.ts`
- `src/app/api/tracker/dismiss-nudge/route.ts`
- `src/lib/supabase/middleware.ts`
- `src/lib/tracking/api-handlers.ts`
- `src/lib/agent/tools/tracking-context.ts`
- `src/lib/agent-v2/runtime/responses-agent.ts`
- `src/components/tracker/tracker-page-client.tsx`
- `src/components/tracker/use-tracker-autosave.ts`
- `src/lib/tracking/save-coordinator.ts`
- `src/components/ui/bottom-sheet.tsx`
- `tests/tracker-api.test.ts`
- `tests/tracker-migration-security.test.ts`
- `tests/tracker-agent-context.test.ts`
- `tests/agent-v2-responses-runtime.spec.ts`
- `tests/tracker-save-coordinator.test.ts`
- `tests/tracker-page.spec.ts`
- `tests/routine-routing-nav.test.ts`

The tracker context split is deliberately scoped to this newly introduced diary block. Other pre-existing context
items containing names receive a separate prompt-boundary audit rather than an unreviewed cross-agent refactor here.
Production `/api/chat` is already included in `SUB_REQUIRED_PREFIXES`; do not broaden this task into a second Chat
entitlement implementation. Existing Chat/Profile/Routine storage retains its current owner-scoped RLS in this PR;
the newly introduced Tracker storage is the only data plane moved to a service-role-only boundary here.

The owner accepts the defense-in-depth cost of checking entitlement in both middleware and the Tracker API for this
experiment. Do not add cross-request entitlement caching; record focused API timings during verification and revisit
only if the added check materially affects autosave feedback.

### Hardening verification

Run the focused tracker API, migration security, Agent V2 context/runtime, save coordinator, tracker page, and shared
bottom-sheet coverage in `tests/tracker-page.spec.ts` first. Then run typecheck, lint, build, authenticated Playwright
tracker coverage, `npm run test:chat`, and a fresh mobile simulated-user review focused on entitlement redirects,
invalid-custom dismissal, autosave feedback, and keyboard focus. Finish with an independent whole-branch code review
and recheck every supported finding against the final diff.

## Review Gates

1. Read-only Claude plan reviews are complete; all supported technical defects are patched or explicitly deferred.
2. Begin implementation only after a fresh branch gate and implementation goal contract.
3. After implementation, run focused checks, browser review, simulated-user review, and whole-branch review.
4. Stop before all Git publishing and deployment actions.

## Implementation Handoff

Recommended execution mode for Task 11: three bounded parallel workers with disjoint write scopes.

- Entitlement worker: middleware, Tracker routes/handlers, the entitlement-boundary migration, and routing/API/migration
  tests.
- Agent-context worker: tracking-context construction, Responses API input separation, and context/runtime tests.
- UI-concurrency worker: tracker page/autosave/coordinator, shared bottom-sheet focus handling, and Playwright/coordinator
  regressions.
- The orchestrator owns product semantics, plan status, integration, migration review/application, final verification,
  browser review, simulated-user review, and the independent whole-branch verdict.

Execution stop line: do not apply the linked migration, stage, commit, push, create a PR, merge, deploy,
or clean up the worktree without explicit approval.
