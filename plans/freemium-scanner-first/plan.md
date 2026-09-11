# Freemium Scanner-First Restructure — Implementation Plan

Rev. 2 · 2026-09-09 · Worktree `.worktrees/freemium-scanner-first` (`codex/freemium-scanner-first`)
Rev. 2 incorporates the Codex (gpt-6-astra, effort high) counterpart review — findings ledger in §11; all 11 findings verified against the repo and accepted.

## 1. Outcome and source context

Free tier goes live behind a feature flag: after the quiz, users create a **free account** (email + magic link) and land in the **full app shell** — the scanner works completely (unlimited scans, personalized verdicts), while Routine, Anwendung, Chat, Haar-Check-Bearbeitung, Verfeinerung and Merkliste are **visible but premium-gated**. Every gate opens one **contextual payment sheet** (three explained benefits, tapped feature first, production prices, embedded checkout). Existing subscribers see no change; nothing currently free is re-locked.

Source context:
- Decision record: memory `project_freemium_scanner_first` (rulings 2026-09-07…09; Jonas walkthrough confirmed 2026-09-09).
- Clickable prototype (approved evidence): https://claude.ai/code/artifact/4b738b1c-de71-4023-a946-939e6d63b0b3
- Research: `plans/freemium-scanner-first/research/` (4 reports).
- Counterpart review: Codex Astra, 2026-09-09 (§11).

## 2. Chosen direction

Foundation-first, six flagged PRs. A new entitlement layer distinguishes `free` vs `premium` signed-in users. Free users are admitted to the app shell by explicit middleware branches (subscription admission + intake/frontier routing + shell selection), with premium enforcement at every mutating/paid API seam per an explicit enforcement matrix. The scanner's free tier ships Variante A on top of a **new masked alternative response contract** (identity, IDs, images and commerce withheld server-side; comparison rows derived per alternative) plus a one-lifetime-reveal credit. A **free initial need-snapshot provisioning** path (from the quiz artifact) is a hard prerequisite so the scanner works for free accounts at all. Gated pages render real product components in **presentation-only composition** over production-quality example fixtures. All conversion taps open the universal PremiumSheet through a **shared opener/context contract introduced in PR1**; the sheet reuses the existing plan-selection and the **already-existing embedded checkout** (`ui_mode` embedded / `EmbeddedCheckoutProvider`) — the new work is **contextual completion**: in-sheet completion callback, verified activation, pending-payment recovery, entitlement refresh, PayPal completion integration, a server-authoritative standard price catalog, freemium-purchase → Personal-Plan-enrollment admission, and post-purchase provisioning of an accepted initial routine so the bought world is immediately real (per the approved journey). Cutover is a full switch for new users once built and tested; scanner de-stealth happens in the same flag step.

## 3. Scope and non-goals

**In scope:** free-account registration contract (quiz-end email → account + magic link with lead binding and prepared-artifact preservation), entitlement service + flag, middleware admission/intake/shell branches, API enforcement matrix, free snapshot provisioning, scanner free-tier gating (masked contract + per-alternative comparison derivation + reveal credit + Merken lock), the 8 contextual triggers with fatigue rule, gated Beispiel pages (presentation-only composition + fixtures), contextual PremiumSheet with contextual embedded-checkout completion + enrollment/provisioning, Profil (Haar-Check lock + Verfeinerungs-Teaser), Merkliste as „Gemerkt"-Sektion (non-destructive auto-save) + scanner-bookmark shortcut, lapsed-user keepsake read exemptions, funnel cutover + de-stealth.

**Unchanged (constraints):** five-tab nav composition; recommendation/verdict computation and its outputs (masking is a serialization-boundary concern — verified seam, §11 verified-claims); production prices (14,99 / 34,99 / 99,99) served from the standard catalog regardless of the launch-pricing flag; existing subscriber experience incl. `ideal`-verdict alternatives; existing quiz content; keepsake rule.

**Non-goals (parked, Nick acknowledged):** landing-page messaging; Programm/Autopilot; email nudges + marketing consent; metrics/kill-criteria dashboards; „verdict never for sale" codification (explicitly not yet ruled); scan-aware chat; brand/affiliate work.

## 4. Target map

Verified anchors (Codex-confirmed unless noted):
- **Middleware/auth:** `src/lib/supabase/middleware.ts` (SUB_REQUIRED_PREFIXES at :29; intake/frontier redirects around :168/:486; reactivation redirect :451), `src/lib/auth/intake-state.ts`, `src/lib/auth/route-classification.ts`, `src/app/api/auth/send-magic-link/route.ts` (**payment-activation endpoint** — free registration is a NEW contract, not reuse), `src/app/auth/confirm/route.ts` (lead param handling :164), `src/lib/quiz/link-to-profile.ts` (projects hair profile; does NOT create need versions).
- **Shell/nav:** `src/components/layout/authenticated-app-shell.tsx` (legacy-vs-five-tab selection :18), `src/lib/personal-plan/navigation-access.ts` (five tabs :79; returns `legacy` without journey access :71).
- **Personal plan:** `src/lib/personal-plan/persistence/stage1-service.ts` (snapshot creation currently requires enrollment/source/qualification/lead :181), `src/lib/personal-plan/enrollment.ts` (:222 — `personal_plan_launch_v1` + funnel/lead evidence), `src/lib/personal-plan/journey-access.ts` (:62), `src/app/routine/page.tsx` (Stage-4 gate :59), `src/app/anwendung/page.tsx` (Stage-5 + accepted routine :102), `src/app/api/personal-plan/stage-1/previews/route.ts` (:58 — full-identity recommendations; must stay premium-gated when Stage-1 access broadens).
- **Scanner:** `src/app/api/scan/resolve/route.ts` (serialization seam :425–479; accepts direct `productId` :336), `src/lib/scan/profile-context.ts` (reads `personal_plan_need_versions.output_snapshot`; 409 `profile_missing`), `src/lib/scan/types.ts` (:42 alternatives carry identity/commerce; no per-alternative dimensions), `src/lib/scan/resolve-verdict.ts` (:246 alternatives on all evaluable verdicts incl. `ideal`), `src/lib/scan/resolve-event-log.ts` (fail-open telemetry — NOT the reveal ledger), `src/app/api/scan/route.ts` wrapper (:53 auth+rate-limit only), `src/app/api/scan/save/route.ts` (**move semantics**, admin client; migration `20260904150000_scan_move_saved_product.sql` deletes `user_products` rows), `src/app/api/scan/wishlist/route.ts` (:58 — Merkliste table is `scan_wishlist`).
- **Billing:** `src/lib/stripe/checkout-session-params.ts` (`presentation: "embedded_page" | "elements"` exists), `src/app/api/stripe/create-checkout-session/route.ts` (:758 catalog via launch-pricing flag; :867 session), `src/components/checkout/payment-method-checkout.tsx` (:440 `EmbeddedCheckoutProvider`, no completion callback today), `src/components/checkout/paypal-subscription-button.tsx` (:727 navigates `/welcome`), `src/lib/stripe/pricing-plans.ts` (:19 standard amounts), `src/components/quiz/result-offer-pricing.tsx` (plan-selection UI/logic).
- **Chat/profile APIs:** `src/app/api/chat/route.ts` (:155 auth+rate-limit only), `src/app/api/profile/route.ts` (:31 authenticated upsert).
- **New seams:** `src/lib/entitlements/` (`getEntitlements`); `PremiumSheetContext` opener contract (feature id + source surface); `GatedPreview` component; free-registration endpoint; freemium enrollment admission; masked-alternatives serializer + per-alternative comparison derivation lib; non-destructive wishlist auto-save path; free-snapshot provisioning service.
- **De-stealth control:** the scanner's current stealth gate must be located and named as the first PR6 sub-step (not verified to exist as a single flag; treat as possibly-new).
- **Migrations:** free-reveal credit (PR2). Enrollment/provisioning may need one (PR4) — decide at implementation with billing-data review.
- **Flag:** `freemium_scanner_first` (server-read, default off).

## 5. Decision coverage

Status: **confirmed** (retained per plan-hardening rule: Rev. 2 changes are verified technical defects and implementation contracts, no consequential product choice changed; acknowledgement refresh due at the §6 walkthrough)

**Confirmed with Nick** (unchanged from Rev. 1): free-tier job = paid conversion; paid = current full product; free = full shell with locked-but-visible features; Variante A scanner (unlimited, criteria visible, identity masked server-side, 1× lifetime reveal); 8 triggers + fatigue rule; unknown never pitched; one universal contextual payment sheet (3 benefits, tapped-first, embedded payment reusing existing logic); production prices; Beispiel gating (framed real content, in-frame scroll, benefit CTAs); locks never cover symbols; production-real content rule; Profil Haar-Check lock + Verfeinerung premium („noch genauer" framing); Merkliste home = Routine „Gemerkt" + scanner-bookmark shortcut; chat back as paid feature, no scan-aware claims, no „Warum?" on verdicts; email per quiz + magic link + scanner landing; keepsake rule; full-switch cutover; six-PR foundation-first; in-app nudges only.

**Inherited from evidence or contract:** immediate post-purchase real content (Routine live directly after purchase) — inherited from the approved prototype journey (Jonas walkthrough 2026-09-09); implemented via provisioning (T14), not reopened. Five-tab nav ruling. `scan_wishlist` as Merkliste store. Standard price catalog amounts exist (`pricing-plans.ts`). Embedded checkout capability exists. Serialization seam permits masking without touching verdict computation (Codex-verified).

**Implementation defaults:** entitlement/flag naming; reveal-credit storage shape; fixture layout; enforcement-matrix representation; opener-contract shape; copy micro-edits within approved framing.

**Open consequential assumptions:** none `resolve before handoff`. Parked out of scope (Nick acknowledged 2026-09-09): landing messaging; „verdict never for sale"; email nudges/consent; metrics; Programm/Autopilot; scan-aware chat.

**Undiscussed consequential assumptions affecting this handoff: none.**

Coverage acknowledgement: Nick reviewed the Rev. 2 record with the §6 journey walkthrough on 2026-09-09 (post-Codex adjustments explained; immediate-provisioning call explicitly confirmed). Covers plan Rev. 2 / this handoff.

## 6. Designed user journey

**Sign-off status: confirmed** — Nick, 2026-09-09, after the post-review walkthrough; explicitly including the immediate post-purchase routine provisioning (staged-journey alternative offered and declined).

Journey text unchanged from Rev. 1 (it described the approved prototype; the review changed how we build it, not what the user experiences), with two precision additions:

- Step 2 (E-Mail-Gate): account creation runs on the **new free-registration contract** — the magic link binds the exact quiz lead and preserves the prepared plan artifact through auth confirmation; resend, wrong-email correction and expired-link recovery are explicit states.
- Step 9 (Purchase → unlock): "Routine live" is delivered by provisioning — the purchase creates the Personal-Plan enrollment and an accepted initial routine from the user's snapshot, so the Routine/Anwendung pages satisfy their stage gates immediately; if provisioning lags, the sheet's success state shows the standard preparing state before landing (no dead ends).

Full journey narrative: see Rev. 1 §6 content, reproduced here:

**Actor & entry:** a new visitor lands on the quiz (any acquisition path), device mobile-first.

1. **Quiz** — unchanged questions; intro copy states the deal up front: „Am Ende: dein Haarprofil, und du kannst jedes Produkt scannen — gratis."
2. **E-Mail-Gate** — clean screen: „Fertig, Lena. Wohin dürfen wir dein Haarprofil schicken?" → email → free account via the free-registration contract (lead-bound magic link; resend/correction/expired states). Fine print: „Gratis, kein Abo nötig. Dein Profil findest du jederzeit im Profil-Tab."
3. **Landing = Scanner** — real `/scan`; five tabs visible; Chat/Routine/Anwendung with corner-lock markers; bookmark with corner lock.
4. **Scanning (free loop)** — full personalized verdict every scan; „passt nicht" shows the comparison table (criteria/frequency readable, alternative identity masked server-side); first „passt nicht" ever offers „Produkt aufdecken — einmalig gratis" (1.2s unblur); later ones „Was passt stattdessen?" → sheet; unknown = honest rescue, no pitch; scans unlimited forever.
5. **Triggers** — user-initiated gates always; proactive pitches (Kategorien-Lücke, Passt-gut, Frust-Serie ≥2, Wiederkehrer) max one per session; gap card links into gated Routine.
6. **Gated pages (Beispiel)** — framed real-component previews with example data, in-frame scroll, benefit line + CTA; chat example is capability-true.
7. **Profil** — live profile, Haar-Check visible with corner-locked editing, Verfeinerungs-Teaser locked.
8. **PremiumSheet** — „Chaarlie Premium — Alles für dein Haar." + exactly three explained benefits (tapped first, accented) + plan rows (Jährlich 99,99 € empfohlen · Vierteljährlich 34,99 € · Monatlich 14,99 €) + embedded payment (Stripe embedded; PayPal integrated completion). „Weiter scannen" always escapes; declining never degrades free.
9. **Purchase → unlock** — success closes the sheet into the unlocked world: locks gone, originating gate opens with real content (provisioned routine, active chat, populated Merkliste), toast „Alles freigeschaltet"; failure returns to the sheet, free session unharmed.
10. **Premium loop** — scans auto-save non-destructively; „Gemerkt" beside aktiv/Prüfung/Vorschläge with graduate-into-routine affordance; bookmark = one-tap jump; Haar-Check/Verfeinerung open their real flows.
11. **Lapse** — profile, Merkliste and routine remain readable (keepsake exemptions); living services re-lock to the free states; nothing free is ever removed.

**Variants:** existing subscribers unchanged; legacy links routable; mobile-first.
**Error/recovery:** magic-link resend/expiry; camera denied → existing fallback + „Produkt suchen"; scan miss → unknown flow; checkout failure → retry in sheet; provisioning delay → preparing state.

## 7. Planning evidence

Unchanged from Rev. 1 (evidence review **confirmed**; prototype archived, link above; research committed in this directory). Addition: counterpart findings (§11) are part of the evidence base; the attempt log is confirmed suitable for telemetry but explicitly NOT the reveal-credit ledger.

## 8. Ordered tasks

Authoritative shared values: flag `freemium_scanner_first`; `getEntitlements(user) → { tier, canSeeAlternatives, canSave, canChat, canEditHairCheck, freeRevealAvailable }`; `PremiumSheetContext = { feature: FeatId, source: string }` with `FeatId ∈ {empfehlungen, merkliste, routine, anwendung, chat, haarcheck, verfeinerung}` (FEAT registry: German name + one-liner as approved); plans `jahr | quartal | monat` → standard catalog price ids (`pricing-plans.ts` amounts 99,99 / 34,99 / 14,99 — server-authoritative for the sheet regardless of launch-pricing flag).

**PR1 — Foundation: admission, shell, enforcement, opener contract**
- T1 Entitlement service (`src/lib/entitlements/`), TDD matrix (free/premium/lapsed). *Produces:* `getEntitlements`. Done: matrix tests green.
- T2 Middleware free-admission branches: flag-gated subscription admission AND intake/frontier routing (quiz-complete free user must not bounce to `/onboarding`; scanner exception decoupled from Personal-Plan entitlement) AND reactivation-redirect carve-out hook (consumed by T16). *Consumes:* T1. Done: flag off = byte-identical behavior (regression tests); flag on = free user reaches `/scan`, `/profile`, gated-page shells; subscriber untouched.
- T3 Shell + nav for free users: `authenticated-app-shell` selects the five-tab shell (not legacy) for free-tier users; `navigation-access` grants five-tab composition; corner-lock markers from entitlements (icons never replaced). *Consumes:* T1, T2. Done: free user sees five tabs with locks; legacy users unaffected; component tests both tiers.
- T4 API enforcement matrix: explicit table (route × method × required entitlement) covering at minimum `/api/scan/*` (resolve free; save/wishlist mutations premium), `/api/profile` (GET free, PUT premium for Haar-Check fields), `/api/chat` POST premium, `/api/personal-plan/stage-1/previews` premium; enforced at each seam; **direct-request tests** (curl-level) per row proving premium APIs stay denied to free users at every intermediate PR. *Consumes:* T1. *Produces:* the matrix doc in this plan directory + guards. Done: adversarial direct-request suite green.
- T5 PremiumSheet opener contract: `PremiumSheetContext` + a stub sheet (renders context, no payment) so PR2/PR3/PR5 gates integrate against a stable interface; final sheet replaces the stub in PR4 (interim vs final acceptance split). *Produces:* opener contract. Done: contract typed + stub renders from a test gate.

**PR2 — Free snapshot + scanner gating** (migration)
- T6 Free-snapshot provisioning: service creating the initial `personal_plan_need_versions.output_snapshot` for a free account from its linked quiz artifact (ownership/persistence contract documented; no enrollment/source/qualification required — new admission path beside `stage1-service`, which stays untouched for paid flows). Stage-1 previews endpoint remains premium-gated (T4 row). *Consumes:* T1; quiz artifact linking. *Produces:* snapshot for free users (scanner prerequisite). Done: free account scans without `profile_missing` (409 path covered by test).
- T7 Migration + reveal-credit accessor (server-side ledger; explicitly not the attempt log). Done: migration applies; accessor unit-tested.
- T8 Masked alternative contract: new response shape for free tier — per-alternative **comparison rows derived server-side** (deterministic lib, TDD) + summary score; identity, `productId`, image URLs, purchase URLs, prices all withheld pre-reveal; reveal endpoint consumes credit and returns the full existing alternative shape; premium (incl. `ideal`-verdict alternatives) byte-compatible with today. *Consumes:* T1, T6, T7. Done: adversarial anti-leak lane (fixtures asserting absence of every identifying field, incl. no resolvable IDs); premium regression suite green.
- T9 Verdict UI free states: comparison table, first-reveal CTA + 1.2s unblur, post-reveal locked state, Merken lock (opens stub sheet w/ `merkliste`), no „Warum?". *Consumes:* T5, T8. Done: labs + Playwright cover first-reveal/post-reveal/premium.
- T10 Trigger layer: deterministic rules for 8 triggers + 1-proactive-per-session fatigue (pure lib, TDD) + surfaces opening the stub sheet with correct `PremiumSheetContext`; gap card → gated Routine. *Consumes:* T1, T5. Done: rule tests incl. fatigue + unknown-never-pitches.

**PR3 — Gated Beispiel pages**
- T11 `GatedPreview` component (frame, „Beispiel" header, in-frame scroll, benefit line + CTA with context via T5). Done: component test + fixed-viewport visual check.
- T12 Presentation-only example composition: production-quality fixtures for Routine/Anwendung/Chat rendered through the real visual components with live reads/writes/navigation suppressed (pattern: `RouteAwareApplicationPage`-style direct view injection, per labs; Routine client must NOT fire its mount-sync POST; chat is a scripted capability-true transcript, no `useChat`). *Consumes:* T1, T11. Done: free user sees Beispiel pages matching prototype; zero network mutations from gated pages (asserted in test); premium sees real pages.

**PR4 — PremiumSheet final + contextual purchase completion**
- T13 PremiumSheet final: 3-benefit algorithm (tapped-first + core fill), plan rows via extracted `result-offer-pricing` logic pinned to the **standard catalog** server-side (launch-pricing flag must not alter sheet prices); replaces the T5 stub everywhere. *Consumes:* T5 contract. Done: benefit-ordering unit tests per source; sheet opens from every existing gate with correct context; served prices asserted = 99,99/34,99/14,99.
- T14 Contextual purchase completion: embedded Stripe checkout mounted in-sheet with completion callback → verified activation → **freemium enrollment admission** (standard-price subscription becomes a Personal-Plan enrollment; new server contract beside `personal_plan_launch_v1` path) → **post-purchase provisioning** (accepted initial routine version from the T6 snapshot so Stage-4/Stage-5 gates open) → entitlement refresh → contextual unlock landing + toast; pending/failed payment recovery states; PayPal completion integrated into the same contextual finish (no bare `/welcome` navigation from the sheet). *Consumes:* T6, T13. Done: local test-mode purchase completes fully in-sheet (respect `docs/local-qa-access.md` §3 analytics caveat; test keys only); routine page renders real content immediately after; failure path returns to sheet with free session intact.

**PR5 — Profil, Merkliste, keepsakes**
- T15 Profil: Haar-Check corner lock → sheet (`haarcheck`); Verfeinerungs-Teaser → sheet (`verfeinerung`); premium routes into existing edit/refinement entries; profile PUT stays premium per matrix. Done: both tiers verified in browser + direct-request test.
- T16 Merkliste: **non-destructive auto-save** for premium scans (insert-only `scan_wishlist` path — never the move endpoint, never deleting `user_products`); „Gemerkt" section on Routine page beside aktiv/Prüfung/Vorschläge; graduation = explicit hand-off into the existing routine-editor flow (no implicit routine writes); scanner bookmark = lock/count corner badge deep-linking to the section. Regression test: owning a product, then rescanning + auto-save must NOT remove ownership. *Consumes:* T1, T4. Done: round-trip + non-destructive regression tests green.
- T17 Keepsake/lapsed reads: middleware + journey-access exemptions so lapsed subscribers keep read access to profile, Merkliste and their routine (reactivation redirect bypassed for read surfaces; mutations stay premium). **Scope addition from T2 review (finding I2):** the Personal-Plan frontier redirect (middleware ~:571-580) must also be carved out under the flag for lapsed users — today it bounces them from /anwendung and /routine to /plan-start → /reactivate; never-paid users are unaffected (frontier=legacy). *Consumes:* T2 hook. Done: lapsed-user matrix test (read allowed, mutate denied, gates show sheet, no frontier bounce).

**PR6 — Funnel cutover + de-stealth**
- T18 Free-registration contract: new endpoint/flow at quiz completion (email → create free account, `shouldCreateUser: true` path, bind the exact quiz lead, preserve the prepared plan artifact through `/auth/confirm`); resend, correction, expired-link recovery; post-auth landing `/scan`; quiz-intro expectation line. Explicitly does NOT touch the payment-activation magic-link route. *Consumes:* T1, T2, T6. Done: journey test quiz→email→magic link→scan with artifact intact (verified via Profil showing quiz-derived content).
- T19 De-stealth + cutover: locate and name the scanner's current stealth control (first sub-step; treat as possibly-new), tie de-stealth + funnel cutover to `freemium_scanner_first`; legacy offer routes remain routable; flag-flip runbook (verify → flip → smoke → rollback=flag off). Done: flag on = full new journey; flag off = byte-identical for new users (journey tests both).

## 9. Verification

- **Automated:** `npm run ci:verify` per PR; full `test:node` in ready-check; suites named per task — entitlement matrix (T1), enforcement direct-request suite (T4, rerun every PR), snapshot provisioning (T6), anti-leak lane (T8), trigger rules (T10), zero-mutation gated pages (T12), benefit ordering + price assertion (T13), purchase-completion journey (T14), non-destructive save regression (T16), lapsed matrix (T17), funnel journey (T18/T19). Playwright: free-scan loop incl. first reveal; gated pages per tier; sheet-from-every-gate; Merkliste round-trip; full PR6 journey.
- **Manual/browser:** per-PR mobile-viewport flow drive via dev login + `/labs/scan`; PR4 one local test-mode purchase (evidence tier named in each ready-check receipt).
- **Migration/live:** PR2 (and possible PR4) migrations dry-run + apply per repo convention; verify no `profiles`/billing regressions.
- **Evidence-sensitive:** before flag flip, re-drive the §6 journeys on a production build with the standard test account (complete profile, products, wash days — Nick's requirement) and capture screenshots into the PR.
- **Rollout risk:** flag default off in every PR; single flip in the PR6 runbook; rollback = flag off; no destructive migration.

## 10. Review and handoff

- Branch/worktree: `.worktrees/freemium-scanner-first` on `codex/freemium-scanner-first`; this plan + research committed on the branch (Rev. 2 commit).
- Per-PR gates: ready-check (`ci:verify` + full `test:node` + flow drive + T4 direct-request suite) → Codex whole-branch review before push → `/ship` publish-only → explicit "merge it".
- Counterpart review of this plan: **done** (Codex Astra high, 2026-09-09) — ledger §11; all findings accepted and folded into Rev. 2. Re-run only on material blocker-driven changes.
- User-journey sign-off: **confirmed** (2026-09-09, post-review walkthrough; no corrections).
- Artifact disposition: prototype = archive (link retained); research + this plan = commit; Codex transcript = discard (ledger preserved in §11).
- Stop point: no PR publication before its ready-check; no flag flip before the §9 evidence-sensitive pass and Nick's explicit go.

## 11. Counterpart findings ledger (Codex Astra high, 2026-09-09)

| ID | Type | Severity | Decision | Plan change | Revalidation |
| -- | ---- | -------- | -------- | ----------- | ------------ |
| F01 free accounts lack scan-required need snapshot (`profile-context` → 409) | defect | High | accepted (verified) | T6 provisioning producer; PR2 prerequisite | anti-409 test |
| F02 PR1 hides intake-routing + legacy-shell selection work | defect | High | accepted (verified) | T2 intake/frontier branches; T3 shell selection | flag-off regression + free-shell tests |
| F03 feature seams need explicit API/method enforcement matrix (save/profile-PUT/chat open once admitted) | defect | High | accepted (verified) | T4 matrix + direct-request suite, rerun per PR | adversarial suite |
| F04 magic-link route is payment activation; lead binding + artifact preservation unspecified | defect | High | accepted (verified) | T18 new free-registration contract | journey test w/ artifact check |
| F05 embedded checkout already exists; missing part is contextual completion (incl. PayPal `/welcome` nav) | defect | High | accepted (verified) | T14 rewritten around completion/activation/recovery/refresh | in-sheet purchase test |
| F06 price catalog via launch-pricing flag can diverge; enrollment path requires launch_v1 + lead evidence | defect | High | accepted (verified) | T13 standard-catalog pinning + price assertion; T14 freemium enrollment admission | price + enrollment tests |
| F07 masking needs a new contract (comparison rows per alternative; withhold IDs/images/URLs; guard stage-1 previews) | defect | High | accepted (verified) | T8 masked contract + derivation lib; T4 previews row | anti-leak lane |
| F08 Stage-1 “example machinery” narrower than claimed; live containers unsafe as-is | defect | Medium | accepted (verified) | T12 presentation-only composition + fixtures | zero-mutation test |
| F09 save endpoint is a move; auto-save would delete owned products | defect | High | accepted (verified) | T16 insert-only auto-save + explicit graduation | non-destructive regression test |
| F10 purchase alone opens nothing (Stage-4/5 gates); lapsed users redirect to reactivation | defect | High | accepted (verified) | T14 provisioning; T17 keepsake exemptions | post-purchase + lapsed matrix tests |
| F11 dependency graph broken (sheet openers before sheet; missing producers) | defect | Medium | accepted | T5 stub/contract; interim-vs-final acceptance; T6 producer assigned | plan self-review |

Corrections adopted: `SUB_REQUIRED_PREFIXES` location = `middleware.ts:29`; de-stealth control marked possibly-new (T19 first sub-step); plan/research committed (was untracked). Verified-correct claims (serialization seam, attempt-log independence, converged resolve handler, five-tab nav existence, `scan_wishlist`, standard amounts, lab view-injection seam) are relied upon in §2–§4. No finding was classified `needs user decision`; none touches a settled product ruling.
