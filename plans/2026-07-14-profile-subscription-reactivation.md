# Membership Reactivation and Active Plan Switching

## Goal

Create two explicit, non-overlapping membership journeys:

1. An authenticated member whose paid access has expired is redirected from membership-protected pages to a dedicated `/reactivate` page. The page explains the expired state, shows the personalized routine recap approved in the local mockup, and lets the member create a new monthly, quarterly, or yearly subscription with embedded Stripe or PayPal checkout.
2. A member with current access manages their existing subscription inside the Profile membership section. They can schedule a switch between monthly, quarterly, and yearly at the next renewal without creating a second subscription or changing the current paid period.

The result must keep acquisition checkout, expired-member reactivation, and active-member plan changes as separate intents with separate route, billing, and analytics behavior.

## Source context

- Worktree/branch: `.worktrees/offer-page-tracking` on `codex/offer-page-tracking`.
- The worktree contains uncommitted offer-page tracking and checkout work plus an approved development mockup at `/labs/profile-reactivation`.
- `origin/main` at planning time is `7f6b1d0`. It includes `/profile` in `SUB_REQUIRED_PREFIXES`, so an expired member cannot use Profile as the reactivation entry point. This is authoritative even though the current dirty branch is one commit behind.
- The current dirty implementation incorrectly removes Profile from the subscription gate and embeds inactive reactivation there. Final implementation must replace that direction, not preserve it.
- `hasCurrentAppAccess()` is the canonical entitlement check. A canceled subscription with `cancel_at_period_end=true` and a future `current_period_end`, or a valid manual grant, still counts as current access.
- Checkout creation already prevents a user or email with current access from starting a second subscription.
- The approved routine preview uses `buildQuizOfferPreview()` and the same product modules as the quiz offer. The reactivation variant intentionally hides the quiz analysis/signals block and starts with the saved routine cards.
- Active Stripe users currently open Stripe Customer Portal. Active PayPal users currently have in-app cancellation and PayPal payment-source guidance; active interval switching is not implemented.
- PayPal checkout intent `source` remains constrained to `pricing_page` or `quiz_result_offer`. Reactivation continues using provider source `pricing_page` plus a separate analytics context; no migration is required for that constraint.
- Stripe supports scheduled end-of-period price changes through subscription schedules. PayPal plan revision takes effect on the next billing cycle and requires buyer re-consent for PayPal-funded subscriptions.
- PayPal configuration was visually verified in the merchant dashboard: the relevant monthly, quarterly, and annual Plan IDs are all children of the same `Chaarlie Premium` subscription Product ID (`PROD-1DJ37758SY227805K`). Revise-in-place switching is therefore structurally supported; implementation still verifies this relationship through provider data before mutation.

Official provider references:

- Stripe price changes: <https://docs.stripe.com/billing/subscriptions/change-price>
- Stripe Customer Portal/subscription schedules: <https://docs.stripe.com/customer-management/configure-portal>
- PayPal subscription revisions: <https://developer.paypal.com/docs/multiparty/subscriptions/customize/revise-subscriptions/>

## Locked product decisions

### Access states

- **Current paid access:** active, past-due access that the canonical entitlement helper still accepts, canceled-at-period-end with time remaining, or a current manual grant.
- **Expired access:** no current provider-backed entitlement and no current manual grant.
- **Uncertain access:** entitlement lookup failed. Fail closed; do not show checkout or plan-change controls until the status can be confirmed.

### Expired members

- `/reactivate` requires authentication but does not require an active membership.
- Membership-protected page requests such as `/chat`, `/routine`, `/tracker`, `/profile`, and `/onboarding` redirect expired members to `/reactivate`.
- The page starts with a clear expired-membership banner, followed by the approved value/routine recap, plan selector, embedded payment choices, trust row, and FAQ.
- The page uses the member's saved profile fields to call the same deterministic offer-preview builder used after the quiz.
- An already-active member who opens `/reactivate` is redirected into the app and is never shown new-subscription checkout.
- After successful reactivation, an onboarded member returns to the safely validated membership-protected destination they originally requested; the default is `/chat`. A member who still needs onboarding goes to `/onboarding`.

### Active members

- Active subscription management stays in `Profile > Mitgliedschaft`.
- The section shows current provider, current interval, renewal/end date, cancellation state, and existing provider management controls.
- Provider-backed, renewing subscriptions in an eligible provider status may open an embedded monthly/quarterly/yearly selector. `past_due`, incomplete, suspended, and other payment-problem states keep their existing recovery/management path and do not expose plan switching.
- Selecting the current interval is disabled/no-op.
- A switch changes the existing provider subscription; it never starts the reactivation/new-subscription checkout.
- The current paid period remains unchanged. The selected interval begins at the next renewal with no mid-cycle proration, credit, or immediate charge.
- A scheduled cancellation is never silently reversed. A canceled-at-period-end member cannot schedule a plan switch until they explicitly resume renewal through supported provider management, or reactivate after expiry.
- Manual-grant-only access, legacy-only records without a canonical manageable provider subscription, and provider records that cannot be safely managed do not show the plan-switch selector. Legacy Stripe accounts retain Customer Portal access until they are canonicalized separately.
- Provider migration is excluded: Stripe stays Stripe and PayPal stays PayPal.

### Provider behavior

- **Stripe:** schedule the new price for `current_period_end`. Reuse or safely update only a schedule owned by this feature; do not overwrite an unrelated existing schedule. Store the pending interval/effective date for Profile display and let webhooks confirm the eventual applied interval.
- **PayPal:** revise the existing subscription to the configured plan under the same PayPal product. The member must complete PayPal re-consent. The revised price starts on the next billing cycle. A dismissal or failure before buyer approval leaves the old plan unchanged. After buyer approval, PayPal may already have revised the provider subscription; any local verification or persistence failure therefore enters an explicit reconciliation state rather than claiming rollback. Retrieve PayPal truth, reconcile forward to the approved plan, and block further plan changes until local state matches the provider.
- One pending change is allowed at a time. Enforce this atomically in the database rather than through a read-then-write check, and make repeat requests idempotent. While a change is pending or provider truth is being reconciled, the selector is read-only and the UI shows the scheduled interval/effective date or a neutral processing state. Replacing or canceling a pending switch is deferred rather than introducing provider-specific override behavior in this change.

## Chosen architecture

### Delivery sequence

Implement and review this as two sequential slices even if they ultimately share a release:

1. **Expired-member reactivation:** route boundary, saved-profile preview, checkout, compatibility redirects, return destination, analytics, and tests.
2. **Active-member plan switching:** provider configuration preflight, Profile UI, Stripe scheduling, PayPal revision/re-consent, pending-state reconciliation, and tests.

Do not let the provider-specific switching work delay or weaken the access-safe reactivation route. Prefer separate reviewable commits/PRs once the existing dirty offer/tracking branch has been safely reconciled.

### 1. Dedicated reactivation boundary

- Add `/reactivate` as a protected/authenticated route in route classification, but deliberately exclude it from `SUB_REQUIRED_PREFIXES`.
- Add `/reactivate` to the auth-first destination list so a direct link from email or another browser never falls back to the quiz merely because the returning cookie is absent.
- Add a shared safe-return helper with a strict allowlist for member destinations. It accepts only same-origin application paths such as `/chat`, `/routine`, `/tracker`, `/profile`, and `/onboarding`; all invalid or recursive values resolve to `/chat`.
- For browser document requests, subscription middleware redirects expired access to `/reactivate?reason=expired&next=<validated-path>`.
- For subscription-protected API requests, return structured JSON instead of an HTML redirect:
  - `403 { error: "subscription_required" }` for confirmed expired access;
  - `503 { error: "access_check_unavailable" }` when the access lookup fails.
- Preserve the current unauthenticated behavior: an unauthenticated member first goes through `/auth` with the requested destination, then entitlement routing sends the authenticated expired account to `/reactivate`.

### 2. Server-owned reactivation page state

- Implement `/reactivate` as a server entry that resolves the authenticated user and canonical access before rendering checkout.
- If access is active, redirect to the validated `next` destination or `/chat`.
- If access is uncertain, render the page shell with a retry/error state and no payment controls.
- Load only the fields needed from `profiles` and `hair_profiles` for name, onboarding state, and routine preview.
- Add a tested `hair profile -> QuizAnswers` adapter with explicit reverse mappings for stored canonical values (`hair_texture`, `cuticle_condition`, `protein_moisture_balance`, `scalp_type`, `scalp_condition`, `chemical_treatment`, concerns, goals, density, thickness, and hair length). Derive `has_scalp_issue=true` whenever a stored scalp condition exists and `false` otherwise so quiz canonicalization does not discard `scalp_condition`.
- Do not invent unsupported precision. Missing legacy fields fall back to the existing conservative offer-preview defaults; the visible foundation remains shampoo and conditioner, with the additional category locked/blurred.
- Convert the approved lab markup into a production reactivation component. Keep the lab as a thin fixture around that component or remove it after the production route has equivalent review coverage.

### 3. Reactivation checkout

- Move/rename the current profile-specific controller to a route-neutral membership reactivation component.
- Reuse `SubscriptionPlanSelector`, `PaymentMethodCheckout`, checkout-attempt identity, duplicate-access dialog, canonical plan metadata, and lazy Stripe loading.
- Rename analytics context from `profile_reactivation` to `membership_reactivation` so tracking matches the final surface. Keep provider/API `source=pricing_page` to satisfy the PayPal source constraint.
- Require an authenticated user whenever `checkoutContext=membership_reactivation`; reject anonymous or lead-bound reactivation requests.
- Add a short-lived, per-user membership-reactivation checkout reservation with an atomic one-open-reservation constraint. Acquire it only after the canonical no-current-access assertion. The same checkout-attempt ID must return/reuse the same reservation; a competing attempt returns a recoverable conflict instead of creating a second provider checkout.
- Use the reservation ID as the Stripe idempotency key and bind the resulting Checkout Session to that reservation. Extend the existing PayPal checkout-intent flow so the same per-user rule applies before provider subscription creation. Expire abandoned reservations and reconcile provider-created/local-persistence-failed attempts before allowing another checkout.
- Pass the validated return destination into provider-owned checkout metadata:
  - Stripe Checkout Session metadata;
  - PayPal checkout intent metadata.
- On `/welcome`, read the verified provider metadata/intent, validate it again, and choose:
  - `/onboarding` if onboarding remains incomplete;
  - the validated original destination otherwise;
  - `/chat` as the safe default.
- New-customer checkout return behavior remains unchanged.

### 4. Active plan-change service

- Add a concrete authenticated server read boundary for Profile (a server wrapper or narrow read endpoint) that returns a discriminated membership-management state: manageable, pending, reconciling, payment-problem, canceled-at-period-end, manual-grant, legacy/unmanageable, or uncertain. Return only current interval, renewal/end date, cancellation state, provider display value, and pending interval/effective date; do not expose provider IDs or raw billing metadata to the client.
- Add a typed plan-change endpoint/service that accepts only the target interval and derives user, provider subscription, current interval, and provider IDs server-side.
- Preconditions:
  - authenticated user;
  - current provider-backed access;
  - subscription is renewing and not canceled-at-period-end;
  - target interval is configured, differs from current/pending interval, and belongs to the expected provider product;
  - no uncertain or conflicting provider schedule/revision state.
- Stripe implementation:
  - retrieve the current subscription and subscription item;
  - verify the configured target price;
  - create a schedule from the existing subscription, then update it with the current price through `current_period_end` and the target price for one target-plan iteration before `end_behavior=release` leaves the subscription continuing on that target price;
  - use `proration_behavior=none` and never reset the current billing anchor;
  - atomically claim the plan-change operation before provider mutation using a compare-and-set/transactional boundary; repeat requests with the same operation ID are idempotent and competing requests are rejected;
  - use provider idempotency keys where supported, persist the feature-owned schedule ID as soon as it exists, and reconcile/clean up partial failures such as schedule-created/update-failed or provider-success/database-failure;
  - persist pending interval, effective date, operation ID, and schedule ID in controlled billing metadata;
  - avoid overwriting schedules not created/owned by this feature.
- PayPal implementation:
  - verify current subscription and target plan belong to the same configured PayPal product;
  - invoke PayPal subscription revision through the JS SDK/provider approval flow;
  - after buyer approval, retrieve and verify the provider subscription server-side before persisting pending interval/effective date;
  - leave the previous plan in place only on dismissal, timeout, or failure before approval;
  - after approval, treat verification/persistence failure as an uncertain state, retrieve PayPal truth, and reconcile forward to the provider-approved plan before re-enabling controls. Do not attempt an automatic compensating revision in this slice.
- Pending plan metadata is merged with existing provider metadata rather than replacing it during normal subscription upserts.
- Webhooks remain the source of truth for the applied interval. Stripe may apply the interval when the scheduled phase begins. PayPal's revision/update event alone must not prematurely replace the current interval because the new price begins at the next billing cycle; apply it only when a completed renewal payment at/after the recorded effective date confirms the new cycle. Then update `billing_subscriptions.interval`, mirror legacy profile fields, and clear pending metadata.
- Profile displays a calm confirmation such as `Wechsel zu Jährlich am 14. August vorgemerkt` and continues to show the current interval until the renewal webhook applies the change.

### 5. Profile membership section

- Keep Profile subscription-gated as on `origin/main`.
- Remove all inactive/loading reactivation UI introduced by the abandoned profile-reactivation direction.
- Keep current status, renewal/end date, Stripe portal access, PayPal cancellation/payment-source guidance, and manual-grant display.
- Add `Plan ändern` only for manageable, renewing provider subscriptions.
- Expand the shared selector inline in the membership section, but use the active plan-change service rather than checkout components.
- For PayPal, selecting and confirming a target plan launches the required PayPal approval flow. For Stripe, confirmation schedules the change without opening checkout.
- Keep cancellation management separate from plan switching.

### 6. `/pricing` compatibility

- `?lead=<id>` redirects to `/result/<id>?focus=unlock-plan`.
- An authenticated expired user without a lead redirects to `/reactivate`, preserving a valid interval and safe return destination.
- An authenticated active user without a lead redirects to `/profile#mitgliedschaft`.
- An anonymous visitor without a lead redirects to `/quiz`.
- Remove the standalone `PricingCards` implementation after all routes and tests move.
- Update stale internal `/pricing` links so acquisition goes through quiz/result and returning expired members go through entitlement routing.

## Analytics and observability

### Reactivation

- Keep `pricing_viewed` and `checkout_started` for compatibility, with `checkout_context=membership_reactivation`, canonical `plan_id`, numeric `value`, currency, interval, provider, and checkout-attempt ID.
- Keep offer-section/offer-CTA/offer-FAQ events exclusive to the acquisition offer. The reactivation page gets its own page/section identifiers and must not pollute offer conversion analysis.
- Preserve Customer.io, PostHog, first-party funnel milestones, Meta purchase behavior, and Sentry checkout breadcrumbs for actual reactivation purchases.

### Active plan changes

- Reuse the canonical server outbox event `subscription_updated` with a `change_phase` payload (`requested`, `approved`, `failed`, or `applied`) plus provider, current interval, target interval, effective date, and operation ID. Do not introduce new outbox event names in this slice.
- Server-own these lifecycle events and use deterministic event keys based on provider subscription, operation ID, and phase so webhook retries cannot duplicate them. Restrict plan-change deliveries explicitly to Customer.io and PostHog; do not rely on the outbox's default destination set because it includes Meta.
- Do not emit `checkout_started`, purchase, or Meta conversion events for a scheduled active plan switch because no new subscription purchase occurs at request time.
- Log provider conflicts, unrelated Stripe schedules, PayPal re-consent failures, and webhook reconciliation failures with non-sensitive identifiers.

## Constraints

- Keep monthly, quarterly, yearly prices and quarterly default unchanged.
- Keep current acquisition offer behavior and checkout appearance unchanged.
- Keep Stripe and PayPal duplicate-access protection.
- Do not relax Profile, Chat, Routine, Tracker, Onboarding, or protected API membership gates.
- Do not expose checkout or plan-change controls from optimistic client state.
- Do not add an LLM call to generate the routine preview.
- Do not migrate payment providers during a plan change.
- Do not silently resume a canceled subscription.
- No staging, commit, push, PR, merge, deploy, or worktree cleanup during implementation without explicit authorization.

## Non-goals

- Discounts, trials, retention offers, or win-back coupons.
- Immediate/prorated active plan changes.
- Switching Stripe subscriptions to PayPal or vice versa.
- Redesigning the broader Profile page.
- Reworking new-customer account activation beyond preserving its existing return behavior.
- Building email win-back campaigns, although `/reactivate` may later be used as their destination.
- Historical analytics backfill.

## Target file map

Exact names may be adjusted during implementation when an existing module already owns the responsibility, but ownership boundaries must remain.

### Reactivation route and UI

- Add `src/app/reactivate/page.tsx` for authenticated server-side access/profile resolution.
- Add `src/components/reactivation/membership-reactivation-page.tsx` for the approved page layout.
- Move/rename `src/components/profile/profile-subscription-reactivation.tsx` to `src/components/reactivation/membership-reactivation-checkout.tsx`.
- Modify `src/components/quiz/offer-preview-routine.tsx` only to preserve the already-added route-specific `routineOnly` presentation without changing the acquisition offer default.
- Convert `src/components/labs/profile-reactivation-lab.tsx` and `src/app/labs/profile-reactivation/page.tsx` into fixtures for the production component or remove them once equivalent local review remains available.
- Add `src/lib/reactivation/profile-quiz-answers.ts` for the deterministic saved-profile adapter.
- Add `src/lib/reactivation/return-destination.ts` for safe destination validation.

### Access and routing

- Modify `src/lib/auth/route-classification.ts` to classify `/reactivate` as authenticated/protected.
- Modify `src/lib/supabase/middleware.ts` to keep Profile subscription-gated, redirect expired document requests to `/reactivate`, and return JSON for protected API failures.
- Modify `src/lib/auth/unauthenticated-redirect.ts` to add `/reactivate` to the auth-first prefixes for direct links without a returning cookie.
- Modify `src/app/pricing/page.tsx` into the compatibility redirect matrix above and remove `src/app/pricing/pricing-cards.tsx`.
- Update `src/components/quiz/quiz-welcome.tsx` and `src/components/auth/auth-form.tsx` only where stale direct-pricing links remain.

### Checkout and returns

- Keep `src/components/checkout/subscription-plan-selector.tsx` as the shared controlled selector.
- Modify `src/components/checkout/payment-method-checkout.tsx` and `src/components/checkout/paypal-subscription-button.tsx` only for route-neutral reactivation context/return metadata.
- Add a migration/RPC for short-lived membership-reactivation checkout reservations, atomic one-open-reservation-per-user acquisition, same-attempt idempotent lookup, provider binding, expiry, and reconciliation status.
- Modify `src/app/api/stripe/create-checkout-session/route.ts`, `src/lib/stripe/checkout-session-params.ts`, `src/app/api/paypal/create-subscription-intent/route.ts`, and `src/lib/paypal/checkout-intents.ts` to carry verified reactivation context and return destination.
- Modify `src/app/welcome/page.tsx` and `src/lib/billing/checkout-success-redirect.ts` to resolve existing-member return destinations without changing acquisition activation.

### Active plan switching

- Add `src/components/profile/profile-plan-switcher.tsx` for the active subscription selector/confirmation state.
- Add `src/app/api/billing/change-plan/route.ts` as the authenticated command boundary, or split provider routes if the PayPal approval contract makes a single route unclear.
- Add `src/lib/billing/plan-change.ts` for shared validation, pending metadata, and provider-neutral result types.
- Add `src/lib/stripe/subscription-plan-change.ts` for schedule creation/update and conflict detection.
- Add `src/lib/paypal/subscription-plan-change.ts` for revision verification and pending-state persistence.
- Add a migration/RPC for atomic plan-change claiming, operation idempotency, pending/reconciliation state, and compare-and-set completion. Keep provider metadata merged, but do not use unconstrained JSON alone as the concurrency boundary.
- Modify `src/app/profile/page.tsx` to remove inactive reactivation UI and render active plan management.
- Modify Stripe/PayPal webhook handlers to reconcile applied intervals and clear pending changes.
- Modify billing display/read helpers to expose current versus pending interval clearly.

### Analytics

- Modify typed browser/server analytics contracts for `membership_reactivation`; active plan changes use canonical `subscription_updated` outbox events with the typed `change_phase` payload.
- Map reactivation context and `subscription_updated` plan-change phases in PostHog and Customer.io as appropriate; pass `destinations: ["customerio", "posthog"]` explicitly. Meta receives purchase events only for actual reactivation purchases.
- Preserve checkout-attempt lifecycle tests already planned for the offer/tracking branch.

### Tests

- Add middleware/route tests for authenticated active, expired, canceled-with-time-left, manual grant, unauthenticated, access-error, API, and redirect-loop cases.
- Add profile-adapter tests for canonical/reverse mappings, derived `has_scalp_issue`, preservation of `scalp_condition`, partial legacy profiles, and conservative defaults.
- Add reactivation page tests for active redirect, expired render, uncertain fail-closed state, routine preview, and checkout visibility.
- Add reactivation checkout tests for two concurrent tabs/attempts, same-attempt idempotent retry, expired reservation recovery, provider-created/local-persistence-failed reconciliation, and Stripe idempotency-key reuse.
- Add Stripe schedule tests for next-renewal timing, no proration, schedule ownership conflicts, atomic rejection while another change is pending, idempotent retries, schedule-created/update-failed recovery, provider-success/database-failure recovery, and webhook application.
- Add PayPal revision tests for pre-approval dismissal/failure, post-approval verification/persistence failure and reconcile-forward behavior, next-cycle effective date, same-product validation, concurrent/retried requests, and webhook application.
- Add Profile tests for manageable Stripe/PayPal, current interval disabled, pending change display, canceled-at-period-end suppression, manual grants, and access errors.
- Add checkout-return tests for safe original destination, invalid destination fallback, onboarding override, Stripe metadata, and PayPal intent metadata.
- Update pricing compatibility, analytics, sitemap/SEO, and relevant E2E tests.

## Implementation checklist

1. Reconcile the worktree with `origin/main` membership gating before implementation; preserve unrelated offer/tracking work and keep `/profile` subscription-gated.
2. Verify provider configuration before active switching by retrieving current and target provider objects: all Stripe prices and PayPal plans must be active, belong to the expected provider product, use EUR, match the canonical amount, and have the expected recurring interval/count. Add negative tests for every rejected mismatch; extend the narrowed PayPal plan type to expose `product_id`.
3. Add safe return-destination validation and route/middleware tests first.
4. Implement `/reactivate` server state and the saved-profile-to-quiz adapter.
5. Convert the approved lab into the production reactivation component and visually verify desktop/mobile states.
6. Move the reactivation checkout controller out of Profile, rename analytics context, and carry safe return metadata through Stripe/PayPal activation.
7. Replace inactive Profile reactivation UI with the active membership read model.
8. Implement Stripe next-renewal scheduling with schedule ownership/conflict protection.
9. Implement PayPal revision plus re-consent and server verification.
10. Add pending-plan display and webhook reconciliation for both providers.
11. Convert `/pricing` to compatibility routing and remove obsolete pricing cards/stale links.
12. Complete analytics mappings and behavioral tests.
13. Run the complete verification suite, simulated browser review, and independent whole-diff code review.

## Verification

### Automated

- `git diff --check`
- focused middleware, route classification, safe-return, profile-adapter, reactivation-page, checkout-return, plan-change, webhook, billing, analytics, pricing, and checkout-attempt tests
- `npm run typecheck`
- `npm run lint`
- `npm run test:node`
- relevant Playwright route/profile/reactivation smoke tests
- `npm run build`

### Browser and provider smoke

- Logged-out former member deep-linking to Chat authenticates, then lands on `/reactivate`.
- Expired authenticated member opening Chat, Routine, Tracker, Profile, or Onboarding lands on `/reactivate` without a loop.
- Canceled-at-period-end member with time remaining continues to the requested app page.
- Manual-grant member continues to the requested app page and sees no provider plan-switch control without a manageable subscription.
- Active member opening `/reactivate` returns to the requested app page or Chat.
- Access-check failure renders no checkout and offers a retry.
- Reactivation page matches the approved mockup, uses saved-profile routine cards, and embeds Stripe/PayPal payment.
- Successful reactivation returns an onboarded member to the safe original destination and an incomplete member to Onboarding.
- Active Stripe member schedules a new interval for the renewal date with no immediate invoice/proration.
- Active PayPal member completes re-consent; dismissal before approval leaves the current plan unchanged, while failure after approval produces a blocked reconciliation state that resolves from PayPal truth.
- Pending change is visible in Profile and clears when the provider webhook applies it.
- Scheduled-cancellation and manual-grant states do not expose unsafe plan switching.
- Acquisition offer, new-customer checkout, and active provider management still behave as before.

## Review gates

- Claude plan review was unavailable on 2026-07-14 because of the local session limit. A fresh-context, read-only sub-agent reviewed the plan against the repository instead; its material findings were independently verified and incorporated into this revision.
- Re-run Claude only if it becomes available before implementation and the plan changes materially; its temporary unavailability is not a blocker after the independent review and accepted fixes above.
- Implementation starts only after the branch/worktree reconciliation strategy is restated in an implementation goal contract.
- Independent whole-diff code review after all checks pass.
- Stop before staging, commit, push, PR, merge, deployment, or cleanup for explicit approval.

## Remaining decisions

No blocking product decision remains for implementation planning.

Defaults recorded here:

- active plan switches take effect at next renewal;
- no mid-cycle proration;
- a scheduled cancellation is not silently resumed;
- successful reactivation returns to the safe original destination, defaulting to Chat;
- incomplete onboarding overrides the return destination;
- Profile is never used as the expired-member entry surface.
