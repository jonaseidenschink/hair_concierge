# Offer page tracking

## Purpose

This specification measures the product-led quiz offer from arrival through purchase. The authoritative business outcome is a completed paid purchase. Section views, clicks, selections, and checkout failures are diagnostic signals used to explain where conversion changes.

The offer uses explicit typed events. PostHog autocapture and session replay are not part of this measurement design.

## Event flow

| Stage                | Event                           | Meaning                                                                     | Destination                                                                            |
| -------------------- | ------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Offer arrival        | `offer_viewed`                  | One mounted offer view                                                      | PostHog and first-party funnel; persisted-result views reuse the server-recorded event |
| Content reach        | `offer_section_viewed`          | A section was at least 25% visible continuously for 750 ms in a visible tab | PostHog                                                                                |
| CTA intent           | `offer_cta_clicked`             | A tracked offer CTA was clicked                                             | PostHog                                                                                |
| Pricing reach        | `pricing_viewed`                | Pricing reached the existing visibility threshold                           | Existing PostHog, Customer.io, and Meta routes                                         |
| Plan choice          | `offer_plan_selected`           | A pricing plan was explicitly clicked                                       | PostHog                                                                                |
| Checkout UI intent   | `offer_checkout_opened`         | The payment UI was opened, before a provider session exists                 | PostHog                                                                                |
| Payment choice       | `offer_payment_method_selected` | PayPal was attempted or the card checkout was explicitly revealed           | PostHog                                                                                |
| Checkout failure     | `checkout_start_failed`         | Provider initialization failed or duplicate access blocked checkout         | PostHog                                                                                |
| Checkout initialized | `checkout_started`              | Stripe created a session or PayPal created an intent                        | Existing PostHog, Customer.io, Meta, and first-party funnel routes                     |
| Purchase             | `purchase_completed`            | Authoritative server-side paid conversion                                   | Existing billing analytics/outbox routes                                               |

`checkout_started` is deliberately later than `offer_checkout_opened`: opening the UI expresses intent, while checkout start requires a successful provider session or intent.

## Stable dimensions

Offer diagnostics include one `offerViewId` per mounted view, one `checkoutAttemptId` per checkout UI open, a unique event ID per interaction, the offer variant and semantic revision, entry context, routine-return state, deterministic need lane and suggested category, selected shampoo and conditioner module IDs, and the existing funnel session/package attribution when available.

Commerce events use structured plan metadata:

| Interval | Plan ID           | Value | Currency |
| -------- | ----------------- | ----: | -------- |
| Month    | `premium_month`   | 14.99 | EUR      |
| Quarter  | `premium_quarter` | 34.99 | EUR      |
| Year     | `premium_year`    | 99.99 | EUR      |

Do not derive analytics values by parsing visible price copy.

## Stable section IDs

In visual order:

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

The hero is represented by `offer_viewed` and is not duplicated as a section event.

Stable CTA IDs are `sticky_header`, `locked_plan`, `pricing_primary`, `change_plan`, and `final`. FAQ IDs are semantic identifiers rather than question copy, so copy edits do not fragment reporting.

## KPI definitions

Use the durable funnel session for anonymous-to-paid conversion, unique people for identified-user reporting, and unique `offerViewId` values for within-page diagnostics. Build every rate from an ordered cohort: the denominator event must occur first, and the numerator must match the same funnel session, offer view, or checkout attempt as stated below.

| Metric                  | Definition                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Paid conversion         | Unique funnel sessions with `offer_viewed` and a later `purchase_completed` / unique funnel sessions with `offer_viewed`                                                                   |
| Checkout initialization | Unique funnel sessions with `offer_viewed` and a later `checkout_started` where `source = quiz_result_offer` / unique funnel sessions with `offer_viewed`                                  |
| Checkout UI intent      | Unique offer views with `pricing_viewed` and a later `offer_checkout_opened` / unique offer views with `pricing_viewed`                                                                    |
| Checkout start success  | Unique opened `checkoutAttemptId` values with a later `checkout_started` where `source = quiz_result_offer` / unique opened `checkoutAttemptId` values                                     |
| Section reach           | Unique offer views with `offer_viewed` and a later view of the section / unique offer views with `offer_viewed`                                                                            |
| CTA CTR by placement    | Unique offer views with the placement click / unique offer views with its source-section view or that placement click; use `offer_viewed` as exposure for hero or sticky-header placements |
| Checkout error reach    | Unique opened `checkoutAttemptId` values with a later `checkout_start_failed` / unique opened `checkoutAttemptId` values                                                                   |

For plan mix, use the interval on `offer_checkout_opened` and the purchase record. Do not rely only on `offer_plan_selected`, because quarterly is preselected and a user can proceed without changing it.

For provider failure rates, first require a matching `offer_checkout_opened`. Divide unique opened `checkoutAttemptId` values with a later provider failure by unique opened attempts associated with that provider through payment selection, successful start, or failure. Split the result by provider, stage, and stable error code. Do not divide raw repeatable clicks or failures by views; retries can otherwise produce rates above 100%.

Exclude orphan numerator events from rate calculations and monitor them separately as tracking-quality errors. For CTA rates, including clicked offer views in the exposure denominator ensures the numerator remains a subset even when the source-section observer was delayed or missed.

Recommended breakdowns are offer revision, offer variant, funnel package, entry context, device, need lane, suggested category, selected interval, and payment provider. Compare rates only after checking sample size and tracking coverage.

## Failure taxonomy

`checkout_start_failed` contains only stable, sanitized fields:

- `failureStage`: `configuration`, `duplicate_access`, `provider_intent`, `provider_session`, or `provider_approval`
- `errorCode`: a code owned by the application, such as `stripe_session_request_failed` or `paypal_approval_failed`
- `retryable`: whether retrying the same action could reasonably succeed

Never attach exception messages, names, email addresses, raw quiz answers, provider IDs, payment fields, or response bodies. Detailed exceptions remain in the existing observability path.

## Interpretation guardrails

- A section view measures exposure, not reading or comprehension.
- A CTA click does not prove checkout readiness; compare it with checkout opens and successful starts.
- Embedded Stripe field progress is not observable and must not be inferred.
- PostHog diagnostic delivery can be lost on very fast exits. Existing first-party funnel milestones remain the durable source for major business stages.
- The repository's approved analytics loading and consent policy is unchanged by this specification.
- Browser vendor SDKs stay disabled on `localhost`, `127.0.0.1`, and local IPv6 by default. Set `NEXT_PUBLIC_ENABLE_LOCAL_VENDOR_ANALYTICS=true` only when local vendor delivery is intentional; this does not disable first-party `/api/funnel/session` behavior.
