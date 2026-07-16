# Offer Page Tracking Expansion

## Goal

Instrument the product-led quiz offer page so Chaarlie can explain paid-conversion performance from offer arrival through section reach, CTA intent, plan choice, checkout initialization, and authoritative purchase completion. Preserve the existing acquisition attribution and checkout behavior.

## Source context

- Base: `origin/main` after PR #218 (`158a7e043a324a1439a518ad7f34ad4d9ef440cd`).
- Existing durable funnel milestones remain: `offer_viewed`, `checkout_started`, and `purchase_completed`.
- Existing destination facade remains the only analytics dispatch path.
- PostHog autocapture and automatic page views remain disabled; offer behavior is captured through explicit typed events.
- The current always-capture policy for Meta, Customer.io, and PostHog is an explicit owner decision recorded in `plans/2026-07-12-analytics-loading-performance.md`. This change must not reintroduce consent gates or alter cookie-banner behavior.

## Chosen direction

Use one client-side `OfferTrackingProvider` around the offer shell. Server-rendered offer sections expose stable `data-offer-section`, `data-offer-cta`, and `data-offer-faq` markers. The provider owns the offer-view identity, section visibility observers, CTA delegation, FAQ listeners, and common analytics context. Stateful pricing and checkout components emit explicit events through the provider hook.

This preserves server-rendered content and avoids both per-section hydration boundaries and noisy DOM autocapture.

### Final review remediation direction

The final review fixes use one coherent attempt model rather than isolated counters:

- Every checkout UI open creates a new `checkoutAttemptId`. That ID follows the attempt through payment-method selection, provider failure, and successful `checkout_started`.
- The PayPal SDK rejected state is treated as a provider-session failure and emits one sanitized `paypal_js_load_failed` event for the active attempt. Card checkout remains usable.
- `locked_routine` is a real visible section for every profile. When the quiz supports a third category, show its category title as today. When it does not, keep the same locked teaser and blurred continuation cards but use generic copy such as “Weitere Schritte werden mit Chaarlie festgelegt”; do not invent a category.
- Rate definitions use unique offer views or checkout attempts, never raw repeatable event counts as denominators.
- Browser vendor analytics are disabled on `localhost` and `127.0.0.1` by default, with an explicit local-development override. This is environment isolation, not a consent-policy change.

## Constraints

- Paid purchase remains the primary KPI; section and click events are diagnostic only.
- Monthly, quarterly, and yearly products, prices, default quarterly selection, Stripe, PayPal, and embedded checkout behavior stay unchanged.
- Existing funnel event IDs and package/session attribution must remain intact.
- Granular offer behavior routes only to PostHog. Do not send section, FAQ, CTA, plan-selection, payment-choice, or failure diagnostics to Meta, Customer.io, or the first-party milestone table.
- Keep `pricing_viewed`, `checkout_started`, and purchase events on their current destinations.
- No raw quiz answers, name, email, free text, payment data, or provider error strings in behavioral payloads.
- One destination failure must never block checkout or UI behavior.
- A diagnostic failure must be emitted at most once for one SDK rejection or one classified failure branch within the active checkout UI. A provider retry keeps the same `checkoutAttemptId`; only closing/changing the plan and opening checkout again creates a new one.
- No LLM calls, database migrations, new analytics vendor, tag manager, or session replay.

## Non-goals

- Changing the approved always-capture analytics policy or cookie-consent UX.
- Creating PostHog dashboards through an external API.
- Instrumenting the Stripe iframe or inferring payment-information entry.
- Redesigning pricing, checkout, the offer layout, copy, recommendations, or funnel package selection.
- Backfilling historical events.
- Reopening the approved production consent policy, changing retention settings, or deciding whether `leadId` should remain in the wider analytics system.

## Event contract

### Common offer context

Every offer-behavior event carries:

- `offerViewId`: one UUID per mounted offer view.
- `offerVariant`: the funnel offer variant, currently `default` where appropriate.
- `offerRevision`: stable semantic content revision, initially `product_led_v1`.
- `entryContext`: `quiz_completion`, `saved_result`, or `routine_return`.
- `focusRoutine`.
- `needLane` and `suggestedCategory` from the deterministic preview.
- `shampooModuleId` and `conditionerModuleId` from the selected preview modules.
- existing funnel event/session/package fields when present.

Do not duplicate device/browser properties that PostHog already supplies.

### Existing events

1. `offer_viewed`
   - Move client dispatch ownership from the pricing component to `OfferTrackingProvider`.
   - Preserve server/browser deduplication through the existing supplied funnel event ID.
   - Add the common offer context.
2. `pricing_viewed`
   - Preserve the current once-only 20% visibility trigger and destinations.
   - Add common context, `selectedInterval`, `availableIntervals`, and `pricingRevision`.
3. `checkout_started`
   - Preserve the current meaning: provider session/intent created successfully.
   - Add stable `planId`, numeric `value`, and ISO currency.
   - For `quiz_result_offer`, add the active `checkoutAttemptId` so a successful provider initialization joins back to the exact checkout open.
   - Add the same commerce properties to the first-party funnel milestone and Meta/Customer.io mappings.
4. `purchase_completed`
   - Keep the authoritative server-side billing outbox behavior unchanged.

### New PostHog-only events

1. `offer_section_viewed`
   - Fire once per section per `offerViewId` after at least 25% visibility continuously for 750 ms while the document is visible.
   - Properties: common context, `sectionId`, `sectionIndex`.
2. `offer_cta_clicked`
   - Fire on every offer CTA click.
   - Properties: common context, `ctaId`, `sourceSection`, `destination`, optional `selectedInterval`, and `interactionIndex`.
3. `offer_plan_selected`
   - Fire only for an explicit user click, including clicking the already-selected default.
   - Properties: common context, `interval`, `previousInterval`, `isDefault`, `selectionIndex`, plan commerce properties.
4. `offer_checkout_opened`
   - Fire when the embedded payment UI is opened, before provider initialization.
   - Properties: common context, selected plan commerce properties, `availableProviders`, `openIndex`, and a newly generated `checkoutAttemptId`.
5. `offer_faq_opened`
   - Fire once per FAQ per `offerViewId` when a closed item becomes open.
   - Properties: common context, stable `faqId`, `faqIndex`.
6. `offer_payment_method_selected`
   - Fire for an explicit PayPal attempt or `Karte & weitere` reveal.
   - Properties: common context, `checkoutAttemptId`, `provider`, selected plan commerce properties, `selectionIndex`.
7. `checkout_start_failed`
   - Fire for a failed provider initialization or duplicate-access rejection.
   - Properties: common context, `checkoutAttemptId`, `provider`, selected plan commerce properties, stable `failureStage`, stable `errorCode`, `retryable`.
   - Observe `PayPalScriptProvider` with `usePayPalScriptReducer`. On its first rejected state for the mounted checkout attempt, emit `paypal_js_load_failed`, `failureStage: provider_session`, and `retryable: true` without attaching the SDK error message.
   - Never include exception messages, emails, Stripe/PayPal identifiers, or payment fields.

### Section IDs

Use these stable values in visual order:

1. `personalized_analysis`
2. `mini_routine`
3. `locked_routine`
4. `unlock_explanation`
5. `product_story_chat`
6. `product_story_routine`
7. `product_story_products`
8. `subscription_explanation`
9. `pricing`
10. `guarantee`
11. `faq`
12. `final_cta`

The hero is represented by `offer_viewed`, not a duplicate section event.

### CTA IDs

- `sticky_header`
- `locked_plan`
- `pricing_primary`
- `change_plan`
- `final`

## Metric definitions

Document the following PostHog-ready definitions in `docs/analytics/offer-page-tracking.md`:

- Paid conversion: unique durable funnel sessions with `purchase_completed` / unique durable funnel sessions with `offer_viewed` for the selected attribution window.
- Checkout initialization: unique durable funnel sessions with `checkout_started` / unique durable funnel sessions with `offer_viewed`.
- Checkout UI intent: unique offer views with at least one `offer_checkout_opened` / unique offer views with `pricing_viewed`.
- Checkout start success: unique `checkoutAttemptId` values with `checkout_started` / unique opened `checkoutAttemptId` values.
- Section reach: unique offer views reaching a section / unique `offer_viewed` offer views.
- CTA CTR by placement: unique offer views with at least one placement click / unique offer views that reached the CTA's source section.
- Plan mix: use the interval on `offer_checkout_opened` and purchase, not only explicit plan clicks, because quarterly is preselected.
- Checkout error reach: unique opened `checkoutAttemptId` values with at least one `checkout_start_failed` / unique opened `checkoutAttemptId` values.
- Provider attempt failure rate: unique failed `checkoutAttemptId` values / unique attempts associated with that provider through payment selection, success, or failure, split by stage and stable code.

Required breakdowns: offer revision, offer variant, funnel package, entry context, device, need lane, suggested category, selected interval, and payment provider.

## Target file map

### Analytics contracts and routing

- `src/lib/analytics/events.ts`
- `src/lib/analytics/routes.ts`
- `src/lib/analytics/destinations/posthog.ts`
- `src/lib/analytics/destinations/customerio.ts`
- `src/lib/analytics/destinations/meta.ts`
- `src/lib/meta-pixel.ts`
- `src/lib/stripe/pricing-plans.ts`
- new `src/lib/analytics/runtime/environment.ts` or an equivalently narrow shared browser-vendor guard
- `src/providers/analytics-runtime-coordinator.tsx`, which is the shared release boundary for PostHog, Customer.io, and Meta

### Offer tracking boundary

- new `src/components/quiz/offer-tracking-provider.tsx`
- new narrowly scoped visibility helper under `src/lib/analytics/`
- `src/components/quiz/quiz-result-offer-page.tsx`
- `src/components/quiz/offer-preview-routine.tsx`
- `src/components/quiz/offer-product-story.tsx`
- `src/components/quiz/offer-timeline.tsx`
- `src/components/quiz/offer-faq.tsx`
- `src/components/quiz/result-offer-pricing.tsx`
- `src/app/result/[leadId]/result-client.tsx`
- `src/components/quiz/quiz-results.tsx`
- `src/funnels/types.ts`
- `src/funnels/offers/default.tsx`

### Checkout attempts and first-party properties

- `src/components/checkout/payment-method-checkout.tsx`
- `src/components/checkout/paypal-subscription-button.tsx`
- `src/app/api/stripe/create-checkout-session/route.ts`
- `src/app/api/paypal/create-subscription-intent/route.ts`

### Documentation and tests

- new `docs/analytics/offer-page-tracking.md`
- focused analytics, offer render, result path, pricing interaction, PayPal, Stripe route, and Meta tests under `tests/`

## Implementation checklist

1. Add structured analytics plan metadata (`analyticsId`, numeric value, ISO currency) without parsing display-price strings or changing checkout price IDs.
2. Extend the typed event catalog and route all seven new events to PostHog only.
3. Map new payloads to stable snake_case PostHog properties. Enrich the existing checkout mappings without renaming historical event names.
4. Implement a testable dwell-aware section observer that cleans up timers and observers on exit/unmount.
5. Implement `OfferTrackingProvider`, common context, `offer_viewed`, section tracking, CTA delegation, and FAQ-open listeners.
6. Pass explicit entry context and offer variant through both the in-quiz and persisted-result entry paths.
7. Add stable section/CTA/FAQ markers without changing layout or visible copy.
8. Instrument explicit plan clicks, checkout UI opens, change-plan clicks, payment-method choices, Stripe failures, PayPal failures, and retry behavior.
9. Generate one `checkoutAttemptId` per checkout open and propagate it through payment selection, PayPal/Stripe callbacks, failures, successful client `checkout_started`, and provider-session API properties where applicable.
10. Add a PayPal script-state observer inside `PayPalScriptProvider`; emit one sanitized failure on rejection and preserve the card fallback.
11. Keep `locked_routine` visible for profiles without a computed third category using a generic locked heading (for example, “Deine weiteren Pflegeschritte”) and the existing blurred continuation cards. Only shampoo and conditioner remain identifiable; do not name or imply a specific third category.
12. Enrich successful Stripe/PayPal `checkout_started` client events and first-party milestone properties with the structured plan metadata and attempt ID.
13. Add a shared browser-vendor environment guard: localhost is off by default, production behavior is unchanged, and local capture requires an explicit public override.
14. Correct the durable tracking specification and dashboard formulas to use unique views and attempt IDs.
15. Run focused tests after each seam, then the repository-wide readiness suite and a local browser smoke.

## Verification

### Automated

- Event-map exhaustiveness and destination routing: granular events reach PostHog only.
- Common context and snake_case destination payloads.
- One `offer_viewed` per mount with existing funnel event-ID deduplication.
- Section event requires 25% continuous visibility for 750 ms, resets on exit, respects hidden documents, fires once, and cleans up.
- Stable section order and IDs are present in rendered markup.
- CTA IDs and FAQ IDs are stable; FAQ fires only on first open per view.
- Explicit plan selection distinguishes default selection from no interaction.
- Checkout opened is recorded before provider session creation.
- Each checkout open receives a fresh `checkoutAttemptId`; all downstream offer-checkout events and in-place provider retries reuse it while that checkout UI remains active. Changing the plan closes the attempt; the next checkout open receives a new ID.
- Stripe and PayPal successes retain one `checkout_started` event with value/currency/plan ID.
- Stripe and PayPal failure branches emit sanitized stable codes without disrupting existing UI/Sentry behavior.
- A rejected PayPal SDK load emits exactly one `paypal_js_load_failed` and leaves the card-payment path usable.
- Profiles with and without a computed third category both render a non-empty `locked_routine` section; the fallback exposes no invented category.
- CTA and error-rate fixtures prove that repeated clicks, retries, and multiple failure events cannot make the documented rate exceed 100%.
- Browser vendor SDKs do not initialize on localhost without the explicit override; first-party local funnel behavior remains testable.
- Existing funnel attribution, checkout source, provider, interval, and event IDs remain intact.
- Typecheck, lint, full Node suite, production build, and `git diff --check` pass.

### Browser smoke

On the local lab/offer route and a real non-production result flow where available:

- Scroll through the page and confirm one event per reached section, not on mount.
- Click each CTA placement and confirm stable IDs and destinations.
- Change plans, open checkout, return to plan selection, reveal card checkout, and attempt PayPal where locally possible.
- Simulate or intercept a PayPal SDK load rejection and confirm one sanitized diagnostic plus a usable card fallback.
- Exercise both a profile with a computed third category and a base/scalp profile with only shampoo and conditioner; confirm the locked section remains visible and generic in the latter.
- Confirm visible behavior and embedded checkout remain unchanged.
- Confirm no raw quiz, identity, exception, or payment data appears in captured payloads.

## Review gates

- Claude plan review before implementation edits; classify every material finding.
- Final local code review over `origin/main...HEAD` after checks.
- Ready-check receipt over the exact final content fingerprint.
- Stop before staging, committing, pushing, PR creation, merge, deployment, or worktree cleanup unless the user separately authorizes publication.

## Residual risks

- PostHog events can still be lost on a very fast bounce before the deferred SDK loads; the first-party major funnel milestones remain the durable business record.
- Section reach measures exposure, not comprehension or causality.
- Stripe Embedded Checkout does not expose trustworthy payment-field progress; no `add_payment_info` equivalent will be fabricated.
- The approved always-capture vendor policy remains unchanged and is outside this implementation's compliance claims.
- `leadId` necessity, vendor retention periods, and production session-replay configuration remain governance follow-ups; this remediation does not silently redefine them.
