# Paid Offer Packaging — Market Research

Date: 2026-09-08
Scope: Web research (read-only) into how behavior-change/health/scanner apps package and sell their paid subscription tier, to inform what Chaarlie's paid product should *be* and how the offer/checkout page should sell it. No recommendation for Chaarlie is made here — patterns and evidence only, per the research brief.

Legend: **[FACT]** = directly sourced claim, cited. **[INFERENCE]** = my synthesis/reading across sources, not a direct quote. **[STALE?]** = pricing or feature claim that may be outdated or is contradicted across sources (consumer subscription pricing changes often and search results mix years).

---

## 1. Program/outcome framing (Noom, 8fit, Fastic, skincare coaching apps)

**Noom** sells a 16-week behavior-change *program*, not a feature bundle.
- **[FACT]** Noom's primary published outcome is weight change at the end of a 16-week program, with secondary outcomes (weight maintenance, activity, eating-disorder risk, body appreciation) measured 52 weeks after the program ends — i.e., the product is explicitly framed and clinically evaluated as a time-boxed program with a durable outcome claim. ([GlobeNewswire](https://www.globenewswire.com/news-release/2026/06/04/3306707/0/en/Noom-Members-Kept-Losing-Weight-a-Full-Year-After-the-Program-Ended-Largest-Ever-Noom-Randomized-Clinical-Trial-Shows.html), [Noom Publications](https://www.noom.com/research/publications/))
- **[FACT]** Noom advertises ~15 lbs average weight loss in 16 weeks based on internal data ([noom.com blog](https://www.noom.com/blog/weight-management/noom-cost/)).
- **[FACT]** In a large study of 35,921 Noom users, >77% lost weight ([search summary](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7303833/)); a hypertension-focused Noom program improved weight (−3.05 kg) and diastolic BP (−5.06 mmHg) at 24 weeks.
- **[FACT]** Onboarding builds a "built for you" narrative across the whole funnel — health metrics, behavioral profile, diet, lifestyle — such that "by the end, you genuinely feel as though the plan was designed specifically for you," before the results/paywall screen shows a personalized weight-loss timeline (e.g., "0.5–1 kg/week") to set expectations ahead of pricing. ([RevenueCat teardown](https://www.revenuecat.com/blog/growth/web-to-app-onboarding-funnel))
- **[FACT]** Noom's entry offer in that funnel is a 14-day trial with a "pay what you want" model, plus a time-boxed (15-minute) bonus offer to create urgency (a free stress-management course) — a program-add-on, not a feature toggle. (Same RevenueCat source.)
- **[FACT]** Pricing (2026 aggregator data, **[STALE?]** — third-party cost trackers, not Noom's own pricing page): $70/month month-to-month, $29.83/month on a 6-month commitment, $17.42/month on a 12-month commitment ([noom.com cost blog](https://www.noom.com/blog/weight-management/noom-cost/)). The pattern — steep discount for longer commitment — mirrors program-length framing: you're buying a "course," and committing to the full course is priced far below buying it week-by-week.

**8fit**: **[FACT]** "8fit workouts are on-demand, built from your onboarding quiz answers" — a single personalized plan combining training + a diet-filtered meal planner/recipe library, not an à la carte feature set ([Daily Burn comparison](https://dailyburn.com/life/health/daily-burn-vs-8fit-which-fitness-app-is-better-in-2026/)). Pricing reported around $6.67/mo on a 12-month plan (**[STALE?]**, third-party, ~€79.99/yr) ([search summary](https://dailyburn.com/life/health/daily-burn-vs-8fit-which-fitness-app-is-better-in-2026/); [8fit Adapty paywall listing](https://adapty.io/paywall-library/8fit-workouts-meal-planner/)).

**Fastic**: **[FACT]** Fastic's onboarding runs ~15–20 question screens, ending in a *personalized* paywall that shows "the results users can expect, along with the time it will take them to achieve those results, all based on the information they have provided" ([Purchasely / Adapty summaries](https://www.purchasely.com/blog/app-onboarding)). This is the same pattern as Noom: long quiz → projected personal outcome → price, in that order.

**Cross-cutting pattern [INFERENCE]**: all three sell a *program with a start, an arc, and a projected personal outcome* rather than "unlimited access to features X/Y/Z." The program framing does three things simultaneously: (a) it justifies a subscription price by attaching it to a promised change, not a tool; (b) it creates a natural, low-friction place to show a personalized projection (which the literature below ties to conversion); (c) it gives structure for the coaching/check-in cadence discussed in §2.

**Conversion evidence, outcome vs. feature framing:**
- **[FACT]** "High-performing paywalls highlight outcomes — how your app saves time, unlocks creativity, or improves life quality — rather than feature lists," and the recommended paywall sequence is outcome → value explanation → reassurance → pricing → CTA, matching the order users actually ask questions in ([RevenueCat: What the best subscription apps get right about paywalls](https://www.revenuecat.com/blog/growth/how-top-apps-approach-paywalls); [Airbridge: Paywall Conversion structural decisions](https://www.airbridge.io/en/blog/paywall-conversion-structural-decisions)).
- **[FACT]** Noom's quiz-then-paywall funnel is cited as converting "north of 10% of quiz completers to paying subscribers versus a 2.7% median for subscription apps" ([search-aggregated claim, RevenueCat/industry sources](https://www.revenuecat.com/blog/growth/web-to-app-onboarding-funnel)) — no single primary study directly A/B-tests "outcome framing" vs. "feature list" in isolation; this is industry-observed correlation, not a controlled experiment. **[INFERENCE]** Treat the causal claim ("outcome framing beats feature lists") as directionally well-supported by practitioner consensus (RevenueCat, Adapty, Superwall all state it independently) but not proven by a single rigorous study in the sources found.
- **[FACT]** Adapty 2025 benchmark: paywalls with "personalized benefit copy referencing the user's stated fitness goal" show meaningfully higher trial conversion than generic copy, and paywalls matching onboarding selections "consistently outperform generic presentations" ([RocketShip HQ / Adapty benchmark](https://www.rocketshiphq.com/paywall-optimization-fitness-apps/)).

---

## 2. Coach/chat-delivered plans (Noom coaches, Ada, Freeletics Coach)

**Noom (human coach via chat)**
- **[FACT]** Noom users get a goal check-in on day 3 and then weekly support "on a day agreed upon together," delivered by a trained "goal specialist" who responds to questions via in-app messaging ([search summary](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12459734/), [Noom FAQ](https://www.noom.com/support/faqs/using-the-app/daily-features/2025/10/what-is-the-premium-subscription/)).
- **[FACT]** Users cite the accountability structure (regular human check-ins) as a key reason for adherence, but at scale "responses take on a formulaic quality... Noom coaches manage hundreds of users simultaneously" — i.e., the chat coach is a real retention lever but its personalization degrades under scale ([search-aggregated observation, no single primary citation](https://arxiv.org/pdf/2606.26641) discusses a related empathy-in-chatbot-coaching study).
- **[FACT]** A GLP-1 coaching study (Noom's own, **[INFERENCE]** likely marketing-adjacent, not RCT) claims users combining GLP-1 drugs with Noom's behavioral coaching lose 48% more weight over 6 months than GLP-1 alone — explicitly flagged in the source as non-randomized and self-report-biased.
- **[FACT]** Related academic work: an arXiv paper isolates the effect of empathy in a long-term physical-activity coaching chatbot, suggesting the *quality* of conversational engagement (not just its existence) drives behavior-change outcomes — relevant if Chaarlie's paid chat is AI-only ([arXiv 2606.26641](https://arxiv.org/pdf/2606.26641)).

**Freeletics Coach (AI-only)**
- **[FACT]** Pricing reported at $34.99/month or $99.99/year (~$8.33/mo effective) in one source, with a conflicting report of ~€12.99/month elsewhere — **[STALE?]**/inconsistent across aggregators, treat as directional only, not exact ([Agent Finder](https://agent-finder.co/reviews/freeletics), [Cora Health](https://www.corahealth.app/compare/freeletics)).
- **[FACT]** Mechanic: after an intake assessment, the AI generates a weekly training schedule; after each workout the user rates difficulty, and the AI adjusts the *next* week's plan — a closed adaptive loop, not a static plan ([search summary](https://agent-finder.co/reviews/freeletics)).
- No sourced data found on Freeletics' specific weekly-check-in retention numbers; nothing to report beyond the mechanic itself.

**Ada Health (comparison point — free, not paid consumer coaching)**
- **[FACT]** Ada's consumer-facing AI symptom checker is free; Ada monetizes via enterprise/health-system licensing, not consumer subscription ([search summary](https://ada.com/app/), various aggregator pages). This is an important negative case: a high-trust, clinically-validated AI health tool chose *not* to charge consumers directly — its "AI coach" value was worth more to institutional payers than to individual subscribers. **[INFERENCE]** This is a caution against assuming "AI health assessment" alone supports consumer subscription pricing; Ada's own model says it doesn't, at least not at scale.

**Cross-cutting pattern [INFERENCE]**: where the paid product literally *is* a conversational coach (Noom, Freeletics), the subscription is sold as ongoing adaptive personalization + accountability cadence, not a one-time report. The chat/coach must produce a visibly different artifact each period (new weekly plan, adjusted targets) to keep re-earning the subscription — a static "your profile" screen does not do this.

---

## 3. Tracking/progress-centric paid tiers (skincare diaries, Whoop/Oura, Flo)

**Skincare diary apps** — free tier is usually logging; paid tier is almost always the *comparison/analytics* layer:
- **[FACT]** GlowRoutine: face-comparison tool (Day 1 vs Day 7 photos), voice-controlled sessions, and consistency/streak tracking are gated behind Premium ([App Store listing](https://apps.apple.com/es/app/id6747299559)).
- **[FACT]** Skin Diary: Track & Glow gates its "Entry Comparison" (side-by-side before/after) tool and shows the paywall right after account creation ([App Store](https://apps.apple.com/us/app/skin-diary-track-glow/id6612022313)).
- **[FACT]** Skincare Tracker Skin Journal: $4.99 **lifetime** (not subscription) unlocks unlimited products, PDF reports, and an interactive photo-comparison slider ([App Store](https://apps.apple.com/us/app/skincare-tracker-skin-journal/id6753622426)) — notable outlier: low one-time price rather than recurring, for what is otherwise a "progress proof" feature set.
- **[FACT]** SkinDooLae gates its entire Routine Builder / Inventory Tracker / Skin Diary behind subscription-or-one-time-purchase (not freemium at all) ([App Store](https://apps.apple.com/us/app/skindoolae/id6757052178)).
- **[INFERENCE]** Consistent pattern: free = single-point logging; paid = *change-over-time proof* (comparison, trends, reports) plus light gamification (streaks/points). This is cheap to build and is exactly "progress proof," matching the brief's framing — but these apps monetize at very low price points ($4.99 lifetime to a few dollars/month), not $10–35/mo.

**Whoop / Oura (conceptual anchor — hardware+software, not directly comparable, but instructive on what justifies premium recurring price)**
- **[FACT]** Whoop: $199–$359/year depending on tier (ONE/PEAK/LIFE), the top tier adding "medical grade" ECG/blood pressure ([Garage Gym Reviews](https://www.garagegymreviews.com/whoop-vs-oura)). Oura: $5.99/mo or $69.99/yr on top of the ring hardware purchase ([search summary](https://nexragear.com/oura-ring-subscription-cost-explained/)).
- **[FACT]** Free/no-membership Oura still shows the three daily scores (Readiness, Sleep, Activity) but loses "detailed insights, long-term trends, and personalized guidance" without the paid membership — i.e., raw score is free, *interpretation and trend* is paid ([search summary](https://www.garagegymreviews.com/whoop-vs-oura)).
- **[FACT]** Whoop is explicitly positioned as "a premium analytics service, not just a device," justified by continuous algorithm/feature improvement and proprietary composite metrics (strain, recovery) computed from continuous physiological sensor data — a stream of new sensor-derived data every day, not a static report ([search summary](https://www.garagegymreviews.com/whoop-vs-oura)).
- **[INFERENCE]** The Whoop/Oura justification for high recurring price rests on (a) continuous new data generation (hardware sensor is always producing fresh signal) and (b) proprietary interpretation of that stream that visibly improves over time. Neither condition holds for a barcode-scan app — there is no continuous physiological stream, and "interpretation" of a scanned product doesn't change day to day. This is the strongest structural reason a scanner's *free* tier and a Whoop-style *paid* tier are not analogous.

**Flo (comparison point, women's health tracking)**
- **[FACT]** Free: cycle/period/ovulation prediction, community ("Secret Chats"). Premium: personalized cycle reports, partner sharing, detailed pregnancy tracking, health reports, doctor-authored educational content, and a virtual-assistant chatbot ([Flo Help Center](https://help.flo.health/hc/en-us/articles/4411293934740-What-s-included-in-the-free-version)).
- **[FACT]** Flo Premium pricing cited at ~$39.99/year (~$3.33/mo) in one 2026 aggregator (**[STALE?]**, third-party) ([subger.com](https://subger.com/en/us/service/flo-health)) — notably lower than Noom/Freeletics, consistent with Flo's paid layer being "more detail on a passive tracker" rather than an active coaching/behavior-change program.

**Cross-cutting pattern [INFERENCE]**: pure "progress proof" (comparison photos, trend reports, streaks) reliably monetizes, but historically at low price points (a few €/mo, or one-time €5) unless bundled with active coaching/guidance (Flo's chatbot, Whoop's algorithmic interpretation of continuous sensor data). Progress-tracking alone is not evidenced anywhere in this research as supporting a €15–35/mo price — it supports a few dollars/month or a one-time fee.

---

## 4. Entry-product ladders (one-time report → subscription upsell)

- **[FACT]** Prose's ~25–30 question hair/scalp quiz is completely free, and the company explicitly does **not** push subscription: "all products are presented as an optional add-on," with a subscription only *recommended* because formulas are meant to be iteratively tweaked with feedback over repeat shipments ([DTC Patterns](https://www.dtcpatterns.com/dtc-patterns-articles/proses-product-picker-quiz-is-the-like-having-a-hair-guru-on-your-phone), [MySubscriptionAddiction](https://www.mysubscriptionaddiction.com/b/prose)). This is a physical-goods DTC model (formulated product refills), not a software subscription — the "subscription" there is a shipment cadence, and the entry point is a free diagnostic, not a paid one-time report.
- **[FACT]** Typology's ~15-question skin diagnostic is also free; it produces a personalized routine recommendation, and separately the store sells products (pricing/subscription structure for the *products* wasn't confirmed in sources found — only that the diagnostic itself is free) ([Typology support](https://us.typology.com/support/products-and-skincare-routine/how-does-the-typology-skin-diagnostic-work)).
- **[INFERENCE — important caveat]**: the two "quiz/DNA-report → product" examples the brief named (Prose, Typology) do **not** actually use a *paid one-time report* as the entry step — both give the diagnostic away free and monetize on recurring product shipments. No source found in this research describes a genuine "paid one-time analysis report, later upsold to subscription" pattern in the hair/skin space specifically. This means the brief's assumed comparable (typology/Prose-style one-time-analysis-then-subscription funnel) is **not evidenced as it was framed** — it should be treated as an open question rather than a validated pattern.
- **[FACT, adjacent evidence on general one-time→subscription upsell, not diagnostics-specific]**: post-purchase subscription upsells (converting a one-time buyer to a subscriber immediately after checkout, card already on file) convert at 15–25% acceptance rates, vs. ~78% conversion loss if the customer has to re-enter payment details later by email ([Purposeful Profits / DTC playbook](https://www.purposefulprofits.co/blog/dtc-subscription-conversion-one-time-buyers-recurring-revenue); [Focus Digital 2025 report](https://focus-digital.co/average-upsell-conversion-rate-2025-report/)).
- **[FACT]** Subscription LTV is typically cited as 3–5x higher than one-time-purchase LTV at equivalent gross margin, because purchase frequency compounds ([Eightx 2026 DTC benchmarks](https://eightx.co/blog/average-ltv-subscription-vs-one-time)) — this is a general DTC/e-commerce statistic, not evidence specific to diagnostic-report products, and says nothing about cannibalization risk (i.e., whether offering the cheap one-time option reduces the number of people who would otherwise have subscribed directly).
- **[INFERENCE]** No direct evidence was found — in either direction — on whether a one-time low-price entry report *cannibalizes* subscription conversions for health/beauty apps specifically. The general e-commerce literature found here addresses "one-time buyer converted to subscriber post-purchase" (a monetization funnel), not "does offering a cheap one-time alternative reduce who chooses the subscription in the first place" (a cannibalization question) — these are different questions, and the search did not surface data on the latter. This should be flagged as a genuine evidence gap, not glossed over.

---

## 5. Offer-page conversion best practices for consumer subscription apps

**Annual vs. monthly:**
- **[FACT]** RevenueCat's State of Subscription Apps (SOSA) 2026 data: annual subscriptions retain better across categories; one-year retention was reported (in a related SOSA figure) as ~44.1% annual vs. 17.0% monthly vs. 3.4% weekly ([RevenueCat SOSA](https://www.revenuecat.com/state-of-subscription-apps)). However, monthly plans still generate revenue equal to or exceeding their subscriber share in most categories (e.g., productivity: 76.7% of subscriptions are monthly but 90.7% of revenue comes from them) — **[INFERENCE]** meaning monthly-plan subscribers who stick around pay more in aggregate even though each individual is less "sticky."
- **[FACT]** Best-practice guidance: lead with the (higher) monthly price as an anchor so the annual plan's effective per-month cost looks cheap by comparison (cited example: Calm) ([Superwall: 5 Paywall Patterns](https://superwall.com/blog/5-paywall-patterns-used-by-million-dollar-apps)).
- **[FACT]** 2026 trend cited: contextual/dynamic plan surfacing — show annual/lifetime in "high-consideration" contexts (stationary, longer evening sessions) and shorter plans (weekly/monthly) in "in-motion," brief sessions ([RevenueCat: Contextual Paywall Targeting](https://www.revenuecat.com/blog/growth/contextual-paywall-targeting/)).

**Single-tier vs. multi-tier:**
- **[FACT]** SOSA 2026: hard paywalls convert 5x better than freemium at day 35 (10.7% vs 2.1% download-to-paid) with "nearly identical year-one retention," and D60 revenue-per-download for hard-paywall apps is reported at $3.09 median vs $0.38 for freemium (8x) ([RevenueCat SOSA](https://www.revenuecat.com/state-of-subscription-apps)).
- **[FACT]** Higher-priced apps convert downloads to paid at roughly 2x the rate of low-priced apps in SOSA data (high-priced median 2.8%, top quartile >6.1%; low-priced median 1.4%, top quartile >3.7%), with roughly a 1.4x step-up in conversion at each price-tier percentile ([RevenueCat SOSA](https://www.revenuecat.com/state-of-subscription-apps)) — **[INFERENCE]** this is a correlation across a large cross-app dataset (higher price ≈ stronger product-market fit / better-run apps), not proof that raising any given app's price causes higher conversion; RevenueCat itself frames this as "high-priced apps tend to convert better," consistent with selection effects (apps that can charge more usually also have better activation/onboarding).
- Note: sourced quote above does not itself explicitly state a single-tier-vs-multi-tier comparison; it addresses hard-paywall-vs-freemium and price-level, not tier-count. **[Evidence gap]** No source in this research directly compares "one subscription tier" vs. "three tiers" (e.g., Chaarlie's current €14.99/€34.99/€99.99 structure) on conversion.

**Personalization recap on the paywall:**
- **[FACT]** Recommended pattern: end onboarding with a "Based on your answers..." summary that leads directly into the paywall ([Adapty: personalizing onboarding and paywalls](https://adapty.io/blog/how-to-personalize-onboarding-and-paywalls-in-your-mobile-app/)).
- **[FACT]** Personalization is described as "the newest and fastest-growing lever" in paywall optimization — tailoring based on country, engagement level, acquisition source, or in-app behavior, including plan recommendations by context ([RevenueCat: mobile paywalls guide](https://www.revenuecat.com/blog/growth/guide-to-mobile-paywalls-subscription-apps)).
- **[FACT]** Adapty 2025 benchmark: paywalls with copy that references the user's own stated goal, and paywalls that match onboarding selections, "consistently outperform generic presentations" ([RocketShip/Adapty](https://www.rocketshiphq.com/paywall-optimization-fitness-apps/)).

**Social proof:**
- **[FACT]** Common patterns cited: app-store ratings, "Trusted by 5M+ users" badges, expert endorsements, and leading with a 5-star testimonial before the price is shown ([Superwall: 5 Paywall Patterns](https://superwall.com/blog/5-paywall-patterns-used-by-million-dollar-apps); [Apphud: high-converting paywalls](https://apphud.com/blog/design-high-converting-subscription-app-paywalls)).

**Price anchoring:**
- **[FACT]** Named pattern "the anchor & decoy" — show a high reference price first (e.g., monthly) so the plan you want to sell (annual) looks like the obviously better deal by comparison; comparison cards are used to make the premium option "feel inevitable" ([Superwall](https://superwall.com/blog/5-paywall-patterns-used-by-million-dollar-apps); [Apphud](https://apphud.com/blog/design-high-converting-subscription-app-paywalls)).
- **[FACT]** Weekly-price framing (e.g., "$1.15/week" instead of the annual total) is reported to lift trial-start rate 10–18% in Adapty's fitness-app benchmark ([RocketShip/Adapty](https://www.rocketshiphq.com/paywall-optimization-fitness-apps/)) — a framing/anchoring tactic distinct from tier structure.

---

## 6. Scanner-adjacent apps and the price ceiling on "lookup" value

- **[FACT]** Yuka: Premium is pay-what-you-want with a suggested annual anchor of $10 (US) / €10 (EU) / £10 (UK); the paid tier's marquee feature is an advanced search bar to view a product's grade *without scanning it* — otherwise the free and paid experiences are close to identical in core value (scan → grade) ([Yuka Help](https://help.yuka.io/l/en/article/hkzw2hkj5w-cost-membership), [Yuka Premium page](https://yuka.io/en/premium-member/)).
- **[FACT]** CodeCheck: Pro is €1.99/month or €11.99/year (~€0.99/mo effective); free tier already includes 5 scans/week and basic ratings; Pro adds more detailed analysis and removes ads ([CodeCheck news](https://www.codecheck.info/news/Das-neue-CodeCheck-Pro-ist-da-364302), search-aggregated pricing confirmation).
- **[INFERENCE, synthesizing across all sections above]** What separates apps that credibly charge €10–35/mo from scanner-class apps (€1–2/mo) is not "more detail on the same lookup," it's one or more of:
  1. **A time-boxed program with a promised, measurable personal outcome** (Noom, Fastic, Freeletics) — the subscription is bought *against* a future state, not for present information.
  2. **An adaptive loop that changes what the user is told every week based on new input from them** (Freeletics' week-over-week plan adjustment; Noom's coach conversation) — the product visibly does new work on your behalf each cycle.
  3. **A continuously-generated proprietary data stream that only the paid layer interprets** (Whoop/Oura) — not applicable to a scan-triggered app, since there's no passive sensor feed.
  4. **Active guidance/interpretation layered on top of passive tracking** (Flo's chatbot + doctor-authored content on top of cycle prediction).
  - A barcode scanner's core action (evaluate a product against ingredient criteria) is inherently a *lookup*, structurally similar to Yuka/CodeCheck's free-tier value, regardless of how much personalization is layered onto the verdict shown. **[INFERENCE]** This suggests the case for €14.99+/mo has to come from something adjacent to the scan itself — a program, a coach/chat loop, or a continuously-updated plan the scan feeds into — not from making the scan verdict itself more detailed or more personalized, because Yuka/CodeCheck-class apps already show that "better lookup" alone caps out around €1–2/mo in the market's revealed willingness to pay.
  - No direct source was found stating this comparison explicitly (i.e., no article says "here is why Yuka can't charge €15/mo"); this entire section's causal reasoning is **[INFERENCE]** built from the pricing facts above plus the program/coach/tracking evidence in §1–3, not a single cited analysis.

---

## Cross-cutting patterns (synthesis across all six sections)

1. **Outcome-over-features is the dominant paywall philosophy across every category examined** (behavior-change, fitness, tracking) — repeatedly stated independently by RevenueCat, Adapty, Superwall, and Apphud, and structurally reflected in how Noom/Fastic/8fit sequence their onboarding→paywall funnels. **[INFERENCE strength: high]** — convergent practitioner consensus, though direct controlled A/B evidence isolating "outcome copy" from confounding variables (personalization, urgency, social proof shown alongside it) was not found in a single study.
2. **Personalization recap immediately before pricing ("built from your answers") is near-universal** in the highest-converting funnels found (Noom, Fastic, 8fit, and the general paywall-optimization literature). **[FACT, well-sourced across multiple independent sources.]**
3. **Recurring high price (€10–35/mo) correlates with either an active coaching loop or a continuously-refreshed personal deliverable — not with a richer static report or a better lookup tool.** Progress-tracking-only apps and scanner-only apps both cap out at low price points (a few €/mo or one-time fees) in every example found. **[INFERENCE, but built on consistent, converging pricing facts across categories.]**
4. **The "paid one-time report → subscription" ladder the brief hypothesized (typology/Prose-style) is not actually evidenced in the sources found** — the closest real-world analogs (Prose, Typology) give the diagnostic away free and monetize via product shipments, not via a paid report. Whether a paid one-time analysis cannibalizes or grows subscription conversion remains an open evidence gap for this specific pattern.
5. **Hard paywalls structurally outperform freemium on conversion and revenue-per-download at the aggregate/industry level** (RevenueCat SOSA 2026), which is relevant context given Chaarlie's decided free tier (quiz + unlimited scanning) is a freemium model by definition — though SOSA's comparison is against apps that gate core functionality entirely, not apps (like Chaarlie's planned free tier) that give away a complete, useful free product and monetize a genuinely separate deeper layer.

---

## Sources (all URLs cited above, deduplicated)

- https://www.globenewswire.com/news-release/2026/06/04/3306707/0/en/Noom-Members-Kept-Losing-Weight-a-Full-Year-After-the-Program-Ended-Largest-Ever-Noom-Randomized-Clinical-Trial-Shows.html
- https://www.noom.com/research/publications/
- https://www.noom.com/blog/weight-management/noom-cost/
- https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7303833/
- https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12459734/
- https://www.noom.com/support/faqs/using-the-app/daily-features/2025/10/what-is-the-premium-subscription/
- https://arxiv.org/pdf/2606.26641
- https://www.revenuecat.com/blog/growth/web-to-app-onboarding-funnel
- https://dailyburn.com/life/health/daily-burn-vs-8fit-which-fitness-app-is-better-in-2026/
- https://adapty.io/paywall-library/8fit-workouts-meal-planner/
- https://www.purchasely.com/blog/app-onboarding
- https://agent-finder.co/reviews/freeletics
- https://www.corahealth.app/compare/freeletics
- https://ada.com/app/
- https://apps.apple.com/es/app/id6747299559 (GlowRoutine)
- https://apps.apple.com/us/app/skin-diary-track-glow/id6612022313
- https://apps.apple.com/us/app/skincare-tracker-skin-journal/id6753622426
- https://apps.apple.com/us/app/skindoolae/id6757052178
- https://www.garagegymreviews.com/whoop-vs-oura
- https://nexragear.com/oura-ring-subscription-cost-explained/
- https://help.flo.health/hc/en-us/articles/4411293934740-What-s-included-in-the-free-version
- https://subger.com/en/us/service/flo-health
- https://www.dtcpatterns.com/dtc-patterns-articles/proses-product-picker-quiz-is-the-like-having-a-hair-guru-on-your-phone
- https://www.mysubscriptionaddiction.com/b/prose
- https://us.typology.com/support/products-and-skincare-routine/how-does-the-typology-skin-diagnostic-work
- https://www.purposefulprofits.co/blog/dtc-subscription-conversion-one-time-buyers-recurring-revenue
- https://focus-digital.co/average-upsell-conversion-rate-2025-report/
- https://eightx.co/blog/average-ltv-subscription-vs-one-time
- https://www.revenuecat.com/state-of-subscription-apps
- https://www.revenuecat.com/blog/growth/contextual-paywall-targeting/
- https://superwall.com/blog/5-paywall-patterns-used-by-million-dollar-apps
- https://adapty.io/blog/how-to-personalize-onboarding-and-paywalls-in-your-mobile-app/
- https://www.revenuecat.com/blog/growth/guide-to-mobile-paywalls-subscription-apps
- https://apphud.com/blog/design-high-converting-subscription-app-paywalls
- https://www.rocketshiphq.com/paywall-optimization-fitness-apps/
- https://help.yuka.io/l/en/article/hkzw2hkj5w-cost-membership
- https://yuka.io/en/premium-member/
- https://www.codecheck.info/news/Das-neue-CodeCheck-Pro-ist-da-364302
