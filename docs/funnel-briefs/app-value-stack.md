# App Value Stack offer

## Purpose

`app-value-stack` is the primary mobile offer shown after the Chaarlie hair quiz. It connects the computed result to a small, honest routine preview, then demonstrates the product a customer receives before the existing plan selector and checkout.

The same rendered experience supports two separately attributable entries:

| Package           | Channel   | Entry                     | Landing   | Offer             |
| ----------------- | --------- | ------------------------- | --------- | ----------------- |
| `default_organic` | `organic` | standard landing and quiz | `default` | `app-value-stack` |
| `meta_routine_v1` | `meta`    | `/lp/routine`             | `default` | `app-value-stack` |

Package identity belongs to the funnel session. The page must not infer a visitor's channel from referrer data or alter the experience based on a Meta assumption.

## Audience and journey

The page is written for a motivated but non-expert German-speaking customer who has just completed the quiz and wants a clear answer to three questions:

1. What did Chaarlie learn from my answers?
2. What will the paid product actually give me?
3. Why should I trust it enough to choose a plan?

The page therefore shows the three computed quiz signals together, two database-backed example products, three locked routine categories, three real product views, genuine customer proof, and then the unchanged shared pricing and checkout.

## Claim boundaries

Approved claims and copy are defined in `plans/2026-07-15-pr221-app-value-stack-offer-plan.md`. In particular:

- `4-Wochen-Weg` describes a route and is not a guaranteed four-week result.
- Product cards are examples from the product database, not final recommendations.
- The survey line refers to more than 4,000 responses to the related Chaarlie hair-care survey. It does not describe 4,000 products, recommendations, analyses, or completed offer quizzes.
- Testimonials are from paying customers and use approved initials plus `Chaarlie-Kundin`.
- The product-detail claim is limited to what the screenshot visibly supports: price, application, and `Warum es passt`.
- Cancellation is described as `zum Laufzeitende kündbar` unless the current terms explicitly support stronger wording for every plan.

Do not add daily schedules, reminders, tracking, streaks, guaranteed outcomes, `nie wieder`, `sofort`, `rund um die Uhr`, countdowns, urgency, a founder letter, or a standalone 4,000 statistic.

## Screenshot assets and provenance

All assets use one consistent phone viewport and represent supported Chaarlie product states. The source UI and visible copy must be rechecked whenever a screenshot is replaced. Product proof is presented in the reviewed order: routine, chat, then product recommendation.

| Asset                                                           | Supported state represented | Required visible evidence                                                                                                                       |
| --------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `public/images/funnels/app-value-stack/app-routine.png`         | Routine overview            | products and coherent order; no unsupported daily schedule. Application is visibly supported by the following product-detail state.             |
| `public/images/funnels/app-value-stack/app-product-details.png` | Product-detail drawer       | product image, price, application, and `Warum es passt`                                                                                         |
| `public/images/funnels/app-value-stack/app-chat.png`            | Customer chat               | The production-supported greeting `Guten Tag, Charlene` and a neutral hair-care question; no internal feedback controls or private founder name |

The images are offer-page crops of the supported product states, not independent evidence of functionality. Their adjacent copy must remain no stronger than the state shown.

The 390×844 captures were regenerated from the development-only review fixture on 2026-07-15 with
`scripts/funnels/capture-app-value-stack-assets.mjs`. The controlled fixture reuses the real
`RoutineCard` and `ProductDetailDrawer` components. Its product data points to the reviewed catalog
records `ead1333b-6839-464d-b272-673d39bb95a4` (Balea Aqua Hyaluron),
`2a159694-6799-4be7-a0aa-572757c94801` (Langhaarmädchen Lovely Long Conditioner), and
`0b21f996-bb42-4b10-89bd-4881c4346d53` (Isana Feuchtigkeits Leave-In). The conditioner supplies the
visible €4.95 price and application metadata. The chat capture mirrors the current production
empty-state greeting pattern without creating a customer conversation or exposing feedback controls.

To regenerate locally, run the worktree development server, then execute:

```bash
node scripts/funnels/capture-app-value-stack-assets.mjs http://localhost:<port>
```

The capture script verifies the HTTP response, intended fixture state, and loaded product images before
replacing any asset. It removes only Next's development indicator from the final capture. In production,
the lab routes remain protected and their page components return 404; there is no capture override.

## Evidence and release ownership

The product owner retains the internal evidence/consent record for:

- the exact three testimonial quotes;
- five-star ratings;
- paying-customer status;
- display-name initials and permission;
- the 4,000+ survey-response count and survey relationship.

Before release, the product owner also confirms the final cancellation wording against the customer terms. The implementation owner verifies that each screenshot still matches the current product and that the shared pricing slot remains the only plan selector and checkout implementation.

If any evidence cannot be confirmed, remove or weaken the corresponding claim before release. Do not substitute a placeholder claim.
