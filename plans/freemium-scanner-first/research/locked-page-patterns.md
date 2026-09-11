# Locked-Page Content Patterns in Consumer Apps — Research Summary

**Scope note:** Patterns and evidence only, no recommendation for Chaarlie. Web research, September 2026. Every claim below is tagged **[FACT]** (directly stated by a cited source), **[INFERENCE]** (my synthesis across sources, not stated verbatim by any one source), or **[STALE?]** (source may be outdated or unverifiable at time of writing). Citations are inline; full URL list is not de-duplicated across sections since some sources recur.

---

## 1. Named examples: what does the free user actually SEE on a locked surface?

Sorted into the four patterns from the brief: (a) own data blurred/obscured, (b) sample/demo content clearly marked as example, (c) empty lock screen with benefits list, (d) interactive limited preview (can touch but not complete).

### Pattern (a) — own data blurred/obscured

- **LinkedIn "Who Viewed Your Profile"** — the canonical example. Free users see a capped list of recent viewers; some viewer photos appear as blurred/generic silhouettes with a "see all" prompt gated behind Premium. **[FACT]** One user teardown reports the blurred photos are sometimes *not even correctly mapped to the real viewer* — i.e., decorative/placeholder blur rather than a true preview of your real data. **[FACT, but single-source anecdote — treat as an isolated user report, not a documented LinkedIn practice]** (Ayush Yadav on LinkedIn, https://www.linkedin.com/posts/ayush-yadav-shan_linkedin-shows-you-fake-blurred-photo-look-activity-7035654718810906624-Igzk; overview at https://www.hyperclapper.com/blog-posts/linkedin-profile-view)
- **Tinder Gold / Bumble Premium "who liked you"** — free users see blurred thumbnails of people who liked/swiped them; unlocking requires a paid tier. **[FACT]** (https://www.hitpaw.com/photo-tips/bumble-unblur.html; https://www.aol.com/tiktoker-demonstrates-see-whos-liked-172816590.html)
- **"Vocabulary" app category example** (per Eleken teardown) — shows blurred AI-generated output the user "can almost see" but cannot open without upgrading. **[FACT, per source]**
- **Mixpanel-style analytics tools** — show a locked/greyed premium dashboard *layout* rather than the user's real blurred data, signaling capability rather than obscuring an actual result. **[FACT, per source]** (https://www.eleken.co/blog-posts/paywall-examples)

### Pattern (b) — sample/demo content clearly marked as example

- Direct, well-documented examples of *labeled* demo content (a badge saying "Beispiel"/"example") were the hardest pattern to find with named consumer apps in this pass — most of what turned up in search results was inferred from generic paywall-design roundups rather than a specific, citable screenshot with a visible "example" badge. **[STALE?/weak coverage — flagging this gap rather than overstating]**
- The closest documented case: **Care.com** shows *locked* premium sections in-place inside the real product surface (not synthetic sample content, but the real feature UI, dimmed/inaccessible) so the user can see what the feature looks like without an explicit "sample" label. **[FACT, per source]** (https://www.eleken.co/blog-posts/paywall-examples)
- **Asana** — advanced features are visible but disabled inside the real interface (real UI chrome, not a mocked demo), again without an explicit "sample" badge — closer to (c)/(d) hybrid than a labeled demo. **[FACT, per source]**

### Pattern (c) — empty lock screen with benefits list

- **Whoop** — cancel the subscription and the hardware itself stops functioning; historical data becomes inaccessible. This is the most extreme version of "empty/locked," since it is hardware-gated, not just software-gated. **[FACT]** (https://www.techradar.com/health-fitness/fitness-trackers/this-looks-awesome-theres-now-an-unofficial-open-source-app-for-reading-whoop-data-that-doesnt-need-a-subscription)
- **Oura Ring** — without membership, free users see only 3 daily scores (Readiness/Activity/Sleep), battery, basic profile/settings, and an "Explore" content tab; everything else (HRV trends, sleep-stage analysis, personalized recommendations) is fully gated with no data shown at all — a clean "locked, nothing to see" surface rather than a teaser. **[FACT]** (https://support.ouraring.com/hc/en-us/articles/4409086524819-Oura-Membership)
- **MyFitnessPal** — the micronutrient/"Nutrients" tab exists in the UI for free users but tapping it shows no data (no macro/vitamin breakdown at all) rather than a blurred preview of what it would show. **[FACT]** (https://support.myfitnesspal.com/hc/en-us/articles/15457546881805-What-is-included-in-the-free-version; https://www.intakenutrition.io/blog/myfitnesspal-free-vs-premium-what-you-actually-get-when-you-upgrade)
- **Headspace** — moved from ~80/20 free/locked to effectively 100% locked content library; the free surface functions almost entirely as a benefits/trial-offer screen rather than any teaser content. **[FACT]** (https://www.revenuecat.com/blog/growth/hard-paywall-vs-soft-paywall; https://www.revenuecat.com/blog/growth/podcast-shreya-oswal-keya-patel-headspace/)

### Pattern (d) — interactive limited preview (can touch but not complete)

- **Duolingo** — hearts/lives system: users can start and play lessons but get locked out mid-session once hearts are exhausted; this is a usage-limit gate rather than a page-level lock, but functions as "touch but not complete." **[FACT]** (https://www.androidpolice.com/duolingo-is-getting-worse-heres-how-id-fix-it/)
- **Flo** — a "tap and hold" gesture is used to create a moment of interaction/commitment immediately before the paywall screen appears — an interaction ritual rather than a true content preview, but designed to feel like "almost getting there." **[FACT, per source — note this source is a UX-teardown aggregator (Lazyweb), not Flo's own documentation, so treat the behavioral-psychology framing as that outlet's interpretation]** (https://www.lazyweb.com/company/flo)
- **FitnessAI** — after onboarding customization, a trial-subscription wall appears; dismissing it only allows "Preview Mode" browsing, i.e., a deliberately reduced interactive preview rather than full functionality. **[FACT]** (via https://www.revenuecat.com/blog/growth/hard-paywall-vs-soft-paywall)
- **Strava** — Relative Effort, Grade Adjusted Pace, full segment leaderboards, and the Training Dashboard are visible as named features/tabs in the navigation but return no computed data for non-subscribers on activities that would otherwise show them — a hybrid of (c) and (d): the tab is reachable and touchable, but produces nothing. **[FACT]** (https://support.strava.com/en-us/articles/15401794-relative-effort; https://communityhub.strava.com/insider-journal-9/using-relative-effort-to-analyze-your-efforts-on-strava-1576)

### Apps searched with weak/no citable locked-surface detail
- **Spotify**: search results centered on new feature rollouts (Jam, AI Playlist, queue tools) rather than a documented locked-tab/page pattern; Spotify's premium gating is mostly about *audio behavior* (ads, skips, offline, audio quality) rather than a visibly locked page in the nav. **[STALE?/no strong citation found — do not treat absence as evidence Spotify lacks locked surfaces, just that this search pass didn't surface a citable teardown]**
- **Yuka**: core scanning/scoring/additive info is free; Premium adds search, offline mode, unlimited history, and preference alerts — i.e., Yuka's premium tier does *not* rely on a locked-content-page pattern at all, it upsells convenience/utility features. **[FACT]** (https://nutrasafe.co.uk/nutrasafe-vs-yuka)
- **CodeCheck**: similarly, the free app is fully functional (scanning + ingredient data); the paid tier removes ads and adds unlimited scans/favorites/badge — again not a "locked content page" pattern. **[FACT]** (Google Play listing via search)
- **Blinkist**: free users get one "Blink of the Day"; all other titles show as locked in the library grid, but no citable screenshot description of the specific badge/lock treatment was found this pass beyond "most books will be locked." **[FACT, low detail]**

---

## 2. Evidence on which pattern converts/retains better; platform guidance; documented failures

### Conversion evidence
- **Hard vs. soft paywall, publishing vertical**: Piano's subscription benchmarks reportedly show **hard paywalls convert ~10x higher than soft paywalls** — but this figure is from the publishing/media industry, not consumer mobile subscription apps, so it may not transfer. **[FACT, per source, industry-mismatch caveat is mine — INFERENCE]** (https://www.revenuecat.com/blog/growth/hard-paywall-vs-soft-paywall)
- **Headspace**: moving from partially-locked to ~100%-locked content correlated with a "double-digit lift in paid subscriptions" and higher engagement among converted free-trial users, and the team reports they did **not** see the backlash they expected. **[FACT, self-reported by Headspace's own product team via a RevenueCat podcast — single-source, not independently verified, and it's company-favorable messaging so treat as a case-study claim, not neutral data]** (https://www.revenuecat.com/blog/growth/podcast-shreya-oswal-keya-patel-headspace/)
- **Lose It!**: internal data suggests users who haven't converted within 30 days are unlikely to convert later — an argument for earlier/more paywall exposure rather than a content-pattern finding per se. **[FACT, per source]**
- **Rootd** (anxiety app): moved the paywall earlier in onboarding (dismissible) and saw a **5x revenue increase** — a placement/timing finding, not a locked-page-content finding. **[FACT, per source]**
- **Four RevenueCat-documented paywall redesigns** (crypto tracker, driver's-license prep, party game, food app) all improved conversion by simplifying the paywall screen itself (shorter copy, trial toggle, social proof/reviews, price anchoring) — these are about the *paywall/checkout screen*, not the locked-tab-behind-it, but are the most concrete quantified evidence available:
  - Crypto app: 2.7% → 3.24% conversion (+20%) after emotionally-framed copy + charts. **[FACT]**
  - Driver's-license app: +17.02% ARPU after shortening feature list, adding trial toggle and embedded reviews. **[FACT]**
  - Party game app: +31% install-to-trial, +64% revenue after shortening layout and adding trial toggle. **[FACT]**
  - Food app: +72% install-to-trial after replacing feature lists with real App Store reviews + impact stats. **[FACT]**
  (https://www.revenuecat.com/blog/growth/paywall-redesigns-case-studies)
- **Blinkist (Growth.Design case study)**: redesigning the *paywall screen* to address the user's real fear ("I'll forget to cancel") instead of listing features produced **+23% trial signups**, a **1,200% jump in push-notification opt-in** (6%→74%), and **-55% customer complaints**. This is squarely about paywall copy/trust, not the locked-content pages behind it, but it's the strongest "ethical design still converts" data point found. **[FACT]** (https://growth.design/case-studies/trial-paywall-challenge)

**[INFERENCE]** Across all sources, there is essentially no rigorously isolated A/B evidence comparing (a) blur vs. (b) sample-content vs. (c) empty-lock vs. (d) limited-preview *as locked-page content patterns specifically* — the available quantified case studies are almost all about the paywall/checkout screen design (copy, trust signals, trial toggles) rather than about what the gated destination page itself contains. This is a real evidence gap, not an oversight in this research pass.

### Platform guidance (Apple / Google)
- **Apple Human Interface Guidelines** (in-app purchase): explicitly encourages **letting people try content for free before signing up** — "limited free access gives people the opportunity to sample your content and encourages engaged users to sign up," citing freemium, metered paywalls, and free trials as valid models, and recommending prompting to subscribe "at relevant times, like when they near their monthly limit of free content." **[FACT]** (https://developers.apple.com/design/human-interface-guidelines/technologies/in-app-purchase, confirmed via search-result excerpt; direct page fetch was blocked/empty on this pass — **[STALE?/verify by re-fetching or viewing directly, as the full page body could not be retrieved]**)
- Apple also requires transparent, prominent price/billing-period disclosure on the paywall itself, and in 2026 reportedly began rejecting apps with **toggle-based free-trial designs or unclear subscription flows** that "confuse users about pricing, trials, and auto-renewal." **[FACT, per source]** (https://revenueflo.com/blog/common-ios-paywall-rejections-and-the-fixes-that-work)
- **Google Play** policy requires subscription terms, pricing, billing cycles, and cancellation to be clearly and truthfully disclosed; Google now emails users ahead of trial-to-paid conversion and notifies subscribers on uninstall that the subscription persists. This is about *subscription transparency*, not locked-content page design specifically. **[FACT]** (https://android-developers.googleblog.com/2020/04/building-user-trust-through-more.html; https://support.google.com/googleplay/android-developer/answer/9900533)
- Neither platform's public guidance was found to prescribe or forbid a specific locked-page content pattern (blur vs. sample vs. empty) — their rules focus on pricing transparency, using the platform's own IAP mechanism, and reviewer testability (reviewers must be able to reach gated content, e.g., via test credentials). **[INFERENCE from absence + FACT re: reviewer testability, https://www.revenuecat.com/blog/growth/the-ultimate-guide-to-app-store-rejections]**

### Documented failures
- **Generic app-store review pattern**: "Wanted to try this app out but every single option is locked behind a paywall. Can't even try it out properly for what we need." — a verbatim complaint pattern found in app review teardown research, illustrating the classic "everything is locked" frustration named in the brief. **[FACT, quoted by source, but the specific app was not identified in the source excerpt — treat as a generic/representative complaint, not attributable to one named app]** (https://community.revenuecat.com/... via RevenueCat guide)
- **MyFitnessPal, October 2022**: removed free barcode scanning (a decade-old free feature) and moved it behind a $19.99/mo or $79.99/yr Premium tier with no warning. This produced a well-documented backlash — "widely cited... as the trigger for many long-term MFP users switching to alternatives," with the company offering a 50%-off promo in anticipation of backlash, and competitor **YAZIO** cited as the beneficiary of user migration. This is a **taking-away** failure (retroactively locking a previously-free feature) rather than a locked-page-content-design failure, but it's the most concrete documented "everything is locked now" backlash found. **[FACT]** (https://www.digitaltrends.com/phones/myfitnesspal-barcode-scanning-not-free-premium-subscription/; https://nutrola.app/en/blog/why-did-myfitnesspal-remove-barcode-scanning)
- **Flo**: user reviews describe paywall coverage as extending to "nearly every useful feature," and note repeated splash-screen/pop-up/push-notification upsell pressure. **[FACT, per source, but exact review counts/dates not verifiable from this pass — STALE?/unquantified]** (search-result synthesis, no single primary review cited)
- **Whoop's hardware-lock model** (subscription lapse = device stops working, historical data locked) is a structurally extreme version of "locked," documented via a workaround — an unofficial open-source app built specifically to read Whoop data without a subscription — which is itself indirect evidence of user frustration strong enough to motivate building a bypass tool. **[FACT — existence of the workaround tool is documented; the frustration-motivation is INFERENCE]** (https://www.techradar.com/health-fitness/fitness-trackers/this-looks-awesome-theres-now-an-unofficial-open-source-app-for-reading-whoop-data-that-doesnt-need-a-subscription)

---

## 3. Blur specifically: premium cue or dark pattern?

- **LinkedIn "who viewed you"** is the most-cited reference case for blur-as-paywall. Framing in sources is mixed-to-negative: one analysis frames it as giving users "a taste of who's interested... but must pay for full transparency" (neutral/persuasive framing), while a first-person user report calls the blurred images potentially **not even accurately mapped to real viewers** — i.e., experienced as a fake/decorative tease rather than a genuine preview of the user's own data. That specific claim is a single anecdotal post, not a verified LinkedIn admission, so it should be read as "some users perceive/allege this," not as confirmed fact about LinkedIn's system. **[FACT of the claim existing; INFERENCE that this is representative]** (https://www.linkedin.com/posts/ayush-yadav-shan_linkedin-shows-you-fake-blurred-photo-look-activity-7035654718810906624-Igzk)
- **Tinder/Bumble blurred likes**: user sentiment found in this pass leans toward suspicion that the blurred "likes" shown to free users may not correspond to real, contactable people at all — one user reported "20+ notifications for likes" as a free user that, on upgrading, turned out to include profiles they'd never actually encountered in their swipe stack, and reported "rarely" seeing new likes-you notifications *after* paying. Users explicitly theorize apps show "bogus blurred images to encourage signups... then show the actual reality once paid." This is a trust-damaging read on blur: it reads as manipulative/inflated rather than as a premium cue, at least among the vocal users captured in these threads. **[FACT of the claims/theory being reported; the underlying accusation of fabricated blur content is unverified — INFERENCE/allegation, not confirmed]** (https://www.teamblind.com/post/tinder-purposely-throttles-your-matches-xzle8eib; https://www.aol.com/tiktoker-demonstrates-see-whos-liked-172816590.html)
- **Dark-pattern literature** (UX Collective, academic "Dark Patterns Side of UX Design") does not single out blur itself as a named dark pattern, but situates blurred/teased content within the broader "confirmshaming"/"roach motel"/"forced continuity" taxonomy of manipulative subscription UX, and explicitly frames the *general* strategy of visually implying value the user can almost reach as a manipulation lever rather than neutral information design. No source in this pass gave blur an explicit "this is always a dark pattern" or "this is fine" verdict — it is discussed as context-dependent, hinging on whether the blurred content is truthful/real. **[INFERENCE — this is a synthesis across sources, not a single citable verdict]** (https://uxdesign.cc/dark-patterns-in-ux-efa007166249; https://www.researchgate.net/publication/322916969_The_Dark_Patterns_Side_of_UX_Design)
- **Cross-cutting read**: [INFERENCE] The evidence suggests blur reads as legitimate/premium when it visibly represents the user's *own real, existing* data (e.g., "you have 3 unread messages, blurred") and reads as cheap/dark-pattern when users suspect the blurred content is fabricated, inflated, or not actually theirs (the Tinder/LinkedIn allegations above). No source directly proves this causal claim; it is my synthesis of the sentiment found across the LinkedIn and Tinder/Bumble threads.

---

## 4. Sample/demo content pattern: marking and personalization

- Coverage here was the thinnest of the five research questions. No source in this pass produced a concretely-cited consumer app screenshot with an explicit "Beispiel"/"Example"/"Demo" badge overlay on a locked page. **[STALE?/gap — flag this explicitly rather than fabricate an example]**
- What *was* found: generic paywall-builder documentation (RevenueCat's "Personalised Paywalls" feature) confirms that **paywall screens** (not necessarily the locked page behind them) are commonly personalized using onboarding-collected variables — e.g., referencing the user's stated goal in paywall copy, with goal-specific copy said to "convert better than generic upgrade prompts." This is about paywall/checkout copy personalization, not about a personalized *sample content wrapper* ("your plan will look like this") on a locked page. **[FACT, per source, but the specific claim "goal-specific copy converts better" was not attributed to a named, checkable study — treat as vendor marketing framing]** (https://www.revenuecat.com/feature/paywalls/personalization)
- Adjacent pattern found: **Care.com and Asana** (section 1b) show the *real* locked feature UI in place (dimmed/disabled), which is a lighter-weight relative of "sample content" — it's not synthetic demo data, but it does let the user see the actual feature surface before paying, un-badged. **[FACT, per source]**
- **[INFERENCE]** Given how weak the direct evidence is here, any claim that "personalized sample content on locked pages is a common, well-documented consumer-app pattern" would be overstating what this research found. The stronger-evidenced adjacent pattern is: show the real (not fabricated) feature UI, disabled, in place — several sources gravitate there instead of synthetic demo content.

---

## 5. Cross-cutting: what do the best implementations put on the locked page besides content?

Synthesizing across all sections, source material converges on these recurring elements around (not just gating) the locked surface:

- **Benefit framing over feature lists**: multiple redesign case studies (Blinkist, the four RevenueCat redesigns) found that shifting from long feature/benefit lists toward addressing the user's actual hesitation (fear of forgetting to cancel, uncertainty about price) outperformed exhaustive benefit enumeration. **[FACT, aggregated across cited case studies]**
- **A single, clear CTA with transparent trial/cancellation mechanics**: Headspace's paywall is specifically praised in sources for a visual timeline showing exactly when the trial ends, when the reminder fires, and when the first charge happens — trust-building through timeline transparency rather than persuasion tactics. **[FACT]** (implied by https://www.revenuecat.com/blog/growth/hard-paywall-vs-soft-paywall)
- **Social proof**: two of the four RevenueCat case studies (driver's-license app, food app) explicitly credit adding real App Store reviews/ratings on the paywall as a conversion driver (ARPU +17%, install-to-trial +72% respectively, though multiple changes shipped together in both tests so the review-embedding effect isn't isolated). **[FACT, with the caveat about confounded variables being mine — INFERENCE]**
- **Progress/commitment hooks before the ask**: Flo's "tap and hold" gesture immediately before its paywall, and Rootd's earlier-but-dismissible paywall placement, are both examples of using interaction/timing (not page content) to prime conversion — i.e., some of the best-documented levers are about *when* and *how* the ask appears, not what the locked page itself displays. **[FACT, per respective sources]**
- **Reviewer/tester access**: a purely operational cross-cutting requirement (not a UX pattern) — Apple's review process requires that gated content remain reachable by reviewers (via test credentials or a documented bypass), which indirectly disciplines apps against building surfaces so locked that even a reviewer can't evaluate them. **[FACT]** (https://www.revenuecat.com/blog/growth/the-ultimate-guide-to-app-store-rejections)
- **[INFERENCE]** Taken together, the strongest cross-cutting theme in the *evidence that actually exists* (as opposed to what the brief hypothesized) is that documented wins cluster around the **paywall/checkout screen's honesty and clarity** (trial timelines, real reviews, addressing the cancellation-fear objection, price transparency) rather than around any particular treatment of the locked destination page's content. The locked-page-content question (blur vs. sample vs. empty vs. limited-preview) is comparatively under-documented in the public case-study literature relative to paywall-screen design — this is a genuine finding of this research pass, not just a limitation of the search.

---

## Sources (deduplicated)

- https://www.revenuecat.com/blog/growth/hard-paywall-vs-soft-paywall
- https://www.revenuecat.com/blog/growth/paywalls-study-guide
- https://www.revenuecat.com/blog/growth/paywall-redesigns-case-studies
- https://www.revenuecat.com/blog/growth/podcast-shreya-oswal-keya-patel-headspace/
- https://www.revenuecat.com/blog/growth/the-ultimate-guide-to-app-store-rejections
- https://www.revenuecat.com/feature/paywalls/personalization
- https://growth.design/case-studies/trial-paywall-challenge
- https://www.eleken.co/blog-posts/paywall-examples
- https://developers.apple.com/design/human-interface-guidelines/technologies/in-app-purchase
- https://revenueflo.com/blog/common-ios-paywall-rejections-and-the-fixes-that-work
- https://android-developers.googleblog.com/2020/04/building-user-trust-through-more.html
- https://support.google.com/googleplay/android-developer/answer/9900533
- https://www.linkedin.com/posts/ayush-yadav-shan_linkedin-shows-you-fake-blurred-photo-look-activity-7035654718810906624-Igzk
- https://www.hyperclapper.com/blog-posts/linkedin-profile-view
- https://www.hitpaw.com/photo-tips/bumble-unblur.html
- https://www.aol.com/tiktoker-demonstrates-see-whos-liked-172816590.html
- https://www.teamblind.com/post/tinder-purposely-throttles-your-matches-xzle8eib
- https://uxdesign.cc/dark-patterns-in-ux-efa007166249
- https://www.researchgate.net/publication/322916969_The_Dark_Patterns_Side_of_UX_Design
- https://support.strava.com/en-us/articles/15401794-relative-effort
- https://communityhub.strava.com/insider-journal-9/using-relative-effort-to-analyze-your-efforts-on-strava-1576
- https://support.ouraring.com/hc/en-us/articles/4409086524819-Oura-Membership
- https://www.techradar.com/health-fitness/fitness-trackers/this-looks-awesome-theres-now-an-unofficial-open-source-app-for-reading-whoop-data-that-doesnt-need-a-subscription
- https://support.myfitnesspal.com/hc/en-us/articles/15457546881805-What-is-included-in-the-free-version
- https://www.intakenutrition.io/blog/myfitnesspal-free-vs-premium-what-you-actually-get-when-you-upgrade
- https://www.digitaltrends.com/phones/myfitnesspal-barcode-scanning-not-free-premium-subscription/
- https://nutrola.app/en/blog/why-did-myfitnesspal-remove-barcode-scanning
- https://www.lazyweb.com/company/flo
- https://help.flo.health/hc/en-us/articles/4407228743956-Trying-Flo-Premium
- https://nutrasafe.co.uk/nutrasafe-vs-yuka
- https://www.androidpolice.com/duolingo-is-getting-worse-heres-how-id-fix-it/

## Known gaps in this research pass

1. **Apple HIG primary page** could not be fully fetched directly (403/redirect issues); the guidance quoted is reconstructed from a search-engine excerpt of that page, not a direct read of the full document. Recommend re-verifying directly at https://developer.apple.com/design/human-interface-guidelines/in-app-purchase if this evidence needs to be load-bearing for a decision.
2. **Section 4 (sample/demo content pattern)** has the weakest evidence base of the five questions — no concretely-cited, badge-labeled "example content" screenshot was found in a named consumer app during this pass. Treat this as "not found," not as "does not exist."
3. **Spotify locked-tab pattern** — not found in citable form; Spotify's premium gating in current sources is about playback behavior (ads, skips, offline, quality), not a visibly locked page/tab.
4. Several conversion figures (the four RevenueCat case studies, Blinkist) come from vendor/growth-consultancy blogs with a commercial interest in promoting paywall-optimization services — treat percentages as vendor-reported case studies, not independently peer-reviewed data.
5. Headspace's "no backlash" and "double-digit lift" claims are self-reported by Headspace's own team on a podcast hosted by a paywall-tooling vendor (RevenueCat) — single-source and commercially adjacent; corroborating independent user-sentiment data (e.g., app store review analysis) was not found in this pass.
