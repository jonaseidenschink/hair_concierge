# PR 221 App Value Stack Offer — Implementation Plan

**Status:** Ready for implementation
**Date:** 2026-07-15
**Source:** PR #221 reviewed against fresh `origin/main` at `7f6b1d0`
**Implementation base:** a fresh `origin/main` worktree; selectively port approved ideas from PR #221 rather than merging or cherry-picking its branch wholesale

**Journey sign-off:** Completed with the owner during the mobile PR #221 review on 2026-07-15. The owner selected the stacked product proof, the mature copy direction, the concise pricing treatment, and the final CTA treatment represented here.
**Independent plan review:** Claude Code reviewed this plan read-only on 2026-07-15. Accepted findings are incorporated below: grammar-safe hero input, null-extra lock fallback, explicit product filtering, a concrete category-title reuse path, correct registry generation, a pre-flip baseline, and explicit rollout/PR disposition.

## Goal Contract

**Outcome:** Replace the offer shown to new default-organic quiz sessions with a cleaner, mobile-first `app-value-stack` offer that turns the user's quiz result into an honest routine preview, demonstrates the real Chaarlie product, adds genuine customer proof, and preserves the existing three-plan checkout.

**In scope:**

- one new offer variant and its presentation-only helper/components;
- the approved German hierarchy and copy below;
- real, production-like app screenshots;
- compact locked routine categories;
- a separate Meta package that renders the same landing and offer while retaining its own attribution identity;
- routing, copy, rendering, accessibility, and visual verification.

**Out of scope:**

- pricing, plan amounts, payment providers, checkout behavior, or discounts;
- recommendation scoring, product selection, or the shared quiz flow;
- daily schedules, reminders, streaks, or progress tracking;
- a founder-letter email;
- inferred “Meta visitor” logic or query-parameter package switching;
- deleting the historical `default` offer;
- merging, pushing, or closing PR #221 as part of implementation.

**Done when:** New organic quiz sessions and `/lp/routine` sessions reach the approved offer with distinct package attribution; old sessions whose stored `offer_variant` is `default` still render the old offer; the selected copy and screenshots are truthful; focused tests, funnel checks, typecheck, lint, build, and mobile/desktop browser QA pass.

**Stop conditions:** Stop before release if the testimonial/survey evidence cannot be retained, the guarantee/cancellation wording conflicts with the current terms, or the screenshots cannot be made from real supported product states. Do not replace those gaps with stronger placeholder claims.

## Product Decisions Locked by Review

### Funnel and migration behavior

| Concern                            | Decision                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New primary offer                  | Create offer variant `app-value-stack`. Launch it as the new organic default, not as a Meta-only pilot.                                                                                                                                                                                                                  |
| Default organic route              | Change `default_organic.offerVariant` from `default` to `app-value-stack` for newly created funnel sessions.                                                                                                                                                                                                             |
| Meta route                         | Create active package `meta_routine_v1` with slug `routine`, channel `meta`, landing `default`, and offer `app-value-stack`. Its public entry URL is `/lp/routine`.                                                                                                                                                      |
| Same experience, separate tracking | Organic and Meta use the same landing/offer components but different package keys and funnel sessions. Do not branch on referrer or infer visitor type.                                                                                                                                                                  |
| Existing sessions                  | Preserve the registered `default` offer. `resolveOfferVariantForSession()` already prioritizes the session's stored `offerVariant`, so historical sessions stay on their original offer. Add regression tests for this behavior.                                                                                         |
| PR #221                            | Treat it as a visual/source draft. Reuse approved concepts and genuine content, but rebuild on fresh main to avoid importing rejected claims, screenshots, founder copy, and the 543-line monolith. Once the port lands, close PR #221 as superseded rather than trying to merge its conflicting package/registry edits. |

This changes the default offer mapping, not the public landing page. The standard route remains landing → shared quiz → `/result/[leadId]`; `/lp/routine` starts the Meta-attributed version of the same journey.

### Approved mobile hierarchy and copy

1. Fixed Chaarlie bar with one CTA: `Routine freischalten`.
2. Hero with one status pill, one personalized H1, and one short deterministic paragraph.
3. `Deine Pflegebasis`: all three computed quiz signals together, followed immediately by two example product cards and three compact locked categories.
4. Compact Chaarlie bridge/unlock card.
5. Three stacked product-proof cards with real app screenshots in the reviewed order: routine, chat, then product recommendation; no carousel/slideshow.
6. A centered testimonial panel with one quiet 4,000-response survey line and three genuine five-star customer testimonials.
7. Short unlock summary, existing three-plan pricing/checkout, and the existing guarantee line.
8. Existing FAQ.
9. Final CTA plus one muted trust line; no additional closing headline or paragraph.

Remove the founder letter, standalone statistic card, countdown/urgency, daily-routine claims, “Woche für Woche besser,” and any “4,000 products/recommendations/checks” wording.

## Copy and Claim Contract

### Hero: computed, concise, and non-promissory

Build presentation copy from the already-computed `QuizResultNarrative` plus the `QuizOfferPreview.lane`; do not add a second scoring system.

- Pill: `Quiz ausgewertet`
- H1 with name: `{firstName}, dein 4-Wochen-Weg zu {narrative.rows[2].after}.`
- H1 without name: `Dein 4-Wochen-Weg zu {narrative.rows[2].after}.`
- Intro when `narrative.primaryConcern` exists: `{concernLead} {laneAction}`
- Intro without a primary concern: `Dein Ziel: {narrative.rows[2].after}. {laneAction}`

Use grammar-safe, complete concern sentences rather than interpolating `narrative.rows[1].before`; that field contains UI fragments such as `gereizt`, `trockene Schuppen`, and `unpassende Pflege` that do not work after a generic `von`.

| Primary concern | Concern lead                                           |
| --------------- | ------------------------------------------------------ |
| `frizz`         | `Frizz ist dein wichtigster Pflegefokus.`              |
| `dryness`       | `Trockenheit ist dein wichtigster Pflegefokus.`        |
| `breakage`      | `Haarbruch ist dein wichtigster Pflegefokus.`          |
| `split_ends`    | `Spliss ist dein wichtigster Pflegefokus.`             |
| `tangling`      | `Verknotungen sind dein wichtigster Pflegefokus.`      |
| `hair_damage`   | `Strapaziertes Haar ist dein wichtigster Pflegefokus.` |

Use one explicit action sentence per existing lane:

| Lane              | Action sentence                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `scalp_focus`     | `Deine Pflegebasis beginnt deshalb mit einer passend abgestimmten Reinigung.`                      |
| `bond_repair`     | `Deine Pflegebasis setzt deshalb auf Schutz und gezielte Strukturpflege.`                          |
| `protein`         | `Deine Pflegebasis verbindet deshalb ausgewogene Basispflege mit gezielter Strukturunterstützung.` |
| `deep_moisture`   | `Deine Pflegebasis setzt deshalb auf milde Reinigung und gezielte Feuchtigkeitspflege.`            |
| `surface_support` | `Deine Pflegebasis setzt deshalb auf Geschmeidigkeit und Schutz zwischen den Haarwäschen.`         |
| `ends_protection` | `Deine Pflegebasis ergänzt deshalb die Basispflege um gezielten Spitzenschutz.`                    |
| `base`            | `Deine Pflegebasis startet deshalb bewusst einfach mit Shampoo und Conditioner.`                   |

The four-week wording describes a route, not a guaranteed result. Do not use `erreichst`, `in vier Wochen bekommst du`, or equivalent outcome guarantees.

### Quiz basis and routine preview

- H2: `Deine Pflegebasis`
- Lead: `Diese drei Punkte bestimmen, womit deine Routine startet.`
- Render all three existing `preview.signals` as numbered insights (`1`, `2`, `3`) in one group.
- Connector: `Daraus entsteht dein Start:`
- Disclosure: `Mit konkreten Beispielen aus unserer Produktdatenbank. Das sind noch nicht deine finalen Produktempfehlungen.`
- Keep the two computed foundation products.
- Replace the tall blurred placeholders with three compact locked cells: the computed suggested category or a neutral fallback, `Maske & Öle`, and `Tools`.
- Avoid redundant mask/oil labels: when the computed category is `Protein-Maske`, `Feuchtigkeitsmaske`, or `Haaröl`, label the second cell `Weitere Pflege`; otherwise keep `Maske & Öle`.
- Closing line: `Diese Bausteine gehören zu deiner vollständigen Routine.`

Product image tiles must use the same `#F3EFE8` treatment as the paid routine cards, so the baked catalog background and the tile read as one surface.

### Chaarlie bridge

- Label: `Nach dem Freischalten`
- H2: `Deine Routine ist erst der Anfang.`
- Body: `Chaarlie begleitet dich bei der Anwendung und passt deine Pflege mit dir an.`
- CTA: `Routine freischalten`

For `focusRoutine`, keep the same page structure and anchor behavior. A small `Weiter mit deiner Routine` context label may appear above the bridge/pricing, but it must not replace the core value proposition or create a second variant.

### Product proof: three stacked sections

Section H2: `So begleitet dich Chaarlie.`

| Label                | Headline                                  | Body                                                                                       | Screenshot must visibly prove                                                                                 |
| -------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `Deine Routine`      | `Deine Routine auf einen Blick.`          | `Produkte, Reihenfolge und Anwendung – klar an einem Ort.`                                 | Real routine overview with coherent product order and no unsupported daily schedule.                          |
| `Dein Haar-Berater`  | `Frag Chaarlie zu deinem Haar.`           | `Chaarlie kennt dein Haarprofil und hilft dir, wenn etwas unklar ist oder sich verändert.` | Realistic chat with the production-supported greeting `Guten Tag, Charlene` and a neutral hair-care question. |
| `Deine Empfehlungen` | `Frag nach Produkten, die zu dir passen.` | `Du bekommst Preis, Anwendung und eine verständliche Begründung direkt dazu.`              | Real product detail state showing image, price, application, and `Warum es passt`.                            |

Use a consistent iPhone-like viewport and border treatment for all three images. Do not show internal feedback controls, private founder names, `Jonas`, or claims such as `heute dran`, tracking, streaks, `nie wieder`, `sofort`, or `rund um die Uhr`.

### Survey proof and testimonials

Place this once, immediately before the testimonials, as muted supporting copy rather than a statistic section:

`Entwickelt mit Erkenntnissen aus über 4.000 Antworten auf unsere Haarpflege-Umfrage.`

Render five accessible stars for each genuine customer quote (`aria-label="5 von 5 Sternen"`) and use:

| Source                 | Genuine quote                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `L. · Chaarlie-Kundin` | `Der Fragebogen ist echt gut und leicht verständlich. Im Chat hat das Antworten super geklappt. Auch die Produktempfehlung fand ich gut.` |
| `A. · Chaarlie-Kundin` | `Ich finde die Interaktion sehr gut: meine Fragen stellen zu können und dann die benötigten Antworten zu bekommen.`                       |
| `M. · Chaarlie-Kundin` | `Dass bei den Produkten der Preis und die Anwendung dabeistehen, ein Foto und warum er es empfiehlt. So muss ich nicht erst googeln.`     |

Do not call them beta testers; they were paying customers. Retain internal evidence for the quotes, ratings, customer status, display-name consent, and the survey-response count before release.

### Pricing and close

- H2: `Aus deiner Pflegebasis wird eine Routine, die im Alltag funktioniert.`
- Maximum three bullets:
  - `Deine komplette Routine – mit Reihenfolge und Anwendung`
  - `Chaarlie beantwortet deine Fragen jederzeit`
  - `Alternativen und Anpassungen, wenn etwas nicht passt`
- Comparison line: `Zum Vergleich: Ein Fehlkauf kostet oft mehr als ein Monat Chaarlie.`
- Render the injected `pricingSlot` unchanged. It remains the only plan selector/checkout implementation and preserves the monthly, quarterly, and yearly plans plus offer/checkout tracking.
- Do not add a duplicate plan selector, provider code, guarantee widget, or checkout CTA outside the shared slot.
- Keep the existing `OfferFaq` unchanged.
- Use `Routine freischalten` for every offer-owned CTA: sticky bar, bridge, and final CTA.
- Final trust line: prefer `14 Tage Geld-zurück · zum Laufzeitende kündbar` because that matches the current FAQ for fixed-term plans. Only use the shorter `jederzeit kündbar` if current customer terms explicitly support that interpretation.

## Technical Design

### 1. Scaffold the package and variant from current main

Run the repository generator rather than editing generated registries by hand:

```bash
npm run funnel:new -- \
  --key meta_routine_v1 \
  --slug routine \
  --landing default \
  --offer app-value-stack \
  --channel meta \
  --status active
```

Then update `src/funnels/packages.json` so `default_organic.offerVariant` is also `app-value-stack`. Leave `scalp_check_placeholder` and the existing `default` offer registered.

Expected package mapping:

```text
default_organic  organic  /             default landing  app-value-stack offer
meta_routine_v1 meta     /lp/routine    default landing  app-value-stack offer
```

The generator creates the new offer registry entry. After manually changing `default_organic`, explicitly write and then verify generated output:

```bash
npm run funnel:check -- --write
npm run funnel:check
```

Do not hand-edit `src/funnels/offers/registry.generated.ts`.

### 2. Add a small presentation-copy helper

Create `src/lib/quiz/app-value-stack-copy.ts`.

- Export a pure `buildAppValueStackHeroCopy({ name, narrative, lane })` function.
- Extract only the first non-empty name token.
- Use `narrative.primaryConcern`, `narrative.rows[2].after`, the grammar-safe concern table, and the explicit lane action table above.
- Return only `{ headline, intro }`.
- Treat this as display copy: do not call recommendation logic, mutate answers, or add new rules.

This keeps the existing `resolveQuizNeed()`/`buildQuizResultNarrative()` calculation authoritative while making the new variant's claims directly testable.

### 3. Implement the dynamic routine block

Create `src/components/quiz/app-value-stack-routine.tsx` based on the useful portion of PR #221's compact preview, not its whole offer component.

- Accept an already-built `QuizOfferPreview`.
- Render the approved three-signal group and disclosure.
- Split products exactly as the current preview does: `foundationProducts = preview.products.filter((product) => !product.suggested)` and `suggestedProduct = preview.products.find((product) => product.suggested)`.
- Export the existing module-local mapping from `src/components/quiz/offer-preview-routine.tsx` as `OFFER_PREVIEW_CATEGORY_TITLES` and import it here. This is a render-neutral shared-copy change; do not otherwise change the historical component's behavior.
- Keep product image `alt`, lazy loading, and honest `Beispiel`/not-final language.
- Match the paid routine card's `#F3EFE8` product tile and compact dimensions.
- Render the three locked cells in one mobile-safe grid. The first uses the suggested product's computed category when `suggestedProduct` exists; otherwise use `Weitere Pflege`. Key the fallback on the missing product, not on a specific lane, because both `base` and `scalp_focus` legitimately have no extra category.
- Apply the approved dedupe rule to locked cell two: use `Weitere Pflege` when cell one is a mask or oil; otherwise use `Maske & Öle`.
- The locks are visual disclosures, not interactive controls; use one accessible explanatory sentence and hide decorative lock/blur elements from assistive technology.

Do not modify `OfferPreviewRoutine`; the historical `default` offer must retain its current rendering.

### 4. Implement product proof and customer proof

Create `src/components/quiz/app-value-stack-proof.tsx`.

- Keep the three app stories and three testimonials as local typed constants.
- Render app stories as stacked cards; do not add carousel state, autoplay, pagination, or swipe behavior.
- Use one shared screenshot frame component local to this file for consistent aspect ratio and border.
- Use `next/image` with explicit dimensions and responsive sizing.
- Render the survey line once, then testimonials with accessible stars and the approved abbreviated sources.
- Keep exact customer quotes unchanged except typographic quotation marks supplied by markup.

Do not create a generic CMS/content system for this single offer.

### 5. Create verified app assets and funnel brief

Add:

- `public/images/funnels/app-value-stack/app-routine.png`
- `public/images/funnels/app-value-stack/app-product-details.png`
- `public/images/funnels/app-value-stack/app-chat.png`
- `docs/funnel-briefs/app-value-stack.md`

Capture or compose each screenshot from actual supported Chaarlie UI states at one consistent phone viewport. Replace PR #221's current screenshots rather than reusing them unchanged: the existing chat image contains a founder name/internal controls, and the product image does not visibly prove every adjacent claim.

The brief records:

- target audience and journey;
- organic and Meta package keys;
- approved copy/claims;
- source/provenance of each screenshot;
- evidence owner for survey count and testimonials;
- explicitly prohibited claims;
- current guarantee/cancellation wording source.

Optimize the PNGs for web delivery and verify that text remains readable at the rendered mobile width.

### 6. Assemble the offer variant

Implement `src/funnels/offers/app-value-stack.tsx` as the page-level orchestrator.

- Accept the existing `FunnelOfferVariantProps` contract.
- Build `preview` once with `buildQuizOfferPreview(quizAnswers)`.
- Build hero copy with the pure helper.
- Compose the fixed bar, hero, routine block, bridge, proof block, pricing wrapper, unchanged `pricingSlot`, unchanged `OfferFaq`, and compact final CTA in the approved order.
- Preserve `id="unlock-plan"`, `id="pricing"`, and `scroll-mt-[76px]` so email-return and fixed-header anchors continue working.
- Keep the current maximum content width (`560px`) and mobile-first spacing, with a restrained desktop presentation rather than a separate desktop layout.
- For `focusRoutine`, preserve the existing return-path context and anchor semantics.

Keep the orchestrator focused on layout. Dynamic routine markup and repeated proof markup belong in the two components above; do not recreate PR #221 as one 500+ line file.

### 7. Add regression and contract tests

Add `tests/app-value-stack-copy.test.ts`:

- table-test all seven need lanes;
- verify named and anonymous headlines;
- verify concern/outcome values are actually reflected rather than one generic paragraph;
- verify the copy contains `4-Wochen-Weg` and excludes promise language such as `erreichst`;
- verify deterministic output for the same inputs.

Update `tests/funnel-packages.test.ts`:

- `default_organic` resolves to `app-value-stack`;
- `routine` resolves to active `meta_routine_v1` with channel `meta`;
- organic and Meta have different package keys but the same landing/offer pair;
- a stored historical `default` offer still wins over the new package mapping;
- unknown keys/slugs still do not fall back silently.

Update `tests/funnel-variants.test.ts`:

- every package still resolves registered variants;
- `app-value-stack` exists once in the generated registry;
- the result route still selects the stored session offer and injects the single shared pricing slot.

Refactor `tests/result-offer-page.test.tsx` only enough to keep its existing historical-default assertions and add a second render suite for `AppValueStackOfferVariant`:

- approved hero, three signals, two examples, three compact locks, bridge, three app stories, survey line, testimonial initials, pricing copy, FAQ, and final CTA are present;
- survey line occurs once and each testimonial exposes `5 von 5 Sternen`;
- base and scalp-focus fixtures both render a non-empty `Weitere Pflege` fallback;
- protein, deep-moisture, and ends-protection fixtures do not repeat mask/oil meaning across the first two locked cells;
- founder letter, `4.000 Empfehlungen`, daily tracking, `Jonas`, urgency/countdown, `Woche für Woche besser`, and unsupported claims are absent;
- `pricingSlot` appears exactly once;
- `focusRoutine` preserves both anchor targets.

Run `tests/acquisition-funnel-tracking.test.ts` as a regression test. Only change it if the new package reveals a missing assertion; do not modify analytics behavior for this page.

### 8. Verify the complete journey

Run focused checks first:

```bash
npm run funnel:check
npx tsx --test \
  tests/app-value-stack-copy.test.ts \
  tests/quiz-offer-preview.test.ts \
  tests/funnel-packages.test.ts \
  tests/funnel-variants.test.ts \
  tests/result-offer-page.test.tsx \
  tests/result-page-client.test.tsx \
  tests/acquisition-funnel-tracking.test.ts \
  tests/result-offer-pricing-tracking.test.ts
npm run typecheck
npm run lint
npm run build
```

Then run the repo-specific readiness workflow and browser QA:

- use `ready-check` before claiming implementation readiness;
- run a motivated non-expert mobile review at approximately 390 px wide;
- also inspect the restrained desktop layout;
- test `/` → quiz → result for a newly created organic session;
- test `/lp/routine` → quiz → result and confirm the same offer with `meta_routine_v1` attribution;
- load a fixture/session with stored `offer_variant=default` and confirm the historical offer remains available;
- confirm top, bridge, pricing, and final CTAs reach the one shared pricing section;
- open checkout far enough to prove plan selection and attribution still work, without completing a real payment;
- check no horizontal overflow, screenshot legibility, image aspect consistency, keyboard focus, contrast, and accessible star labels.

Before push, run the required whole-branch review lane and inspect every finding against the diff and tests.

## Release and Rollback

1. Release the new variant and package mapping together; otherwise `default_organic` could reference an unregistered offer.
2. Capture the immediately pre-flip funnel baseline by package key for quiz completion, lead capture, checkout start, and paid purchase. Record the comparison window and traffic source so post-release movement is interpretable.
3. Confirm CI and the preview deployment before directing Meta traffic to `/lp/routine`.
4. Launch the organic default flip and Meta route together, as selected by the owner; compare results by package key rather than treating the two traffic sources as an A/B test.
5. Monitor the existing funnel ladder by package key: quiz completion, lead capture, checkout start, and paid purchase, with purchase as the primary outcome.
6. If the new default must be rolled back, change only `default_organic.offerVariant` back to `default`, run `npm run funnel:check -- --write`, and verify with `npm run funnel:check`. Do not delete `app-value-stack` or remap `meta_routine_v1`; historical sessions and attribution must remain resolvable.
7. After the selective port is shipped, close PR #221 as superseded with a concise pointer to the replacement PR; do not merge its conflicting `routine-b` package and generated-registry changes.
8. Treat any later two-plan pricing experiment, carousel experiment, or founder email as a separate scoped change.

## Remaining Inputs

No further layout or copy choice blocks implementation. Before release, the owner needs to make two evidence confirmations rather than new product decisions:

1. Confirm the internal source/consent record for the three quotes, five-star ratings, paying-customer labels, initials, and 4,000+ survey responses.
2. Confirm the exact cancellation language against the current terms. The implementation should use `zum Laufzeitende kündbar` unless `jederzeit kündbar` is explicitly supported for all three plans.
