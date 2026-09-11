# API enforcement matrix — freemium scanner-first (T4)

One row per route × method: current gate, the entitlement required to pass,
which seam enforces it, and the test proving free-tier users stay denied. See
`plan.md` §8 (T4) for the task and `src/lib/supabase/middleware.ts` for the
subscription-paywall implementation this table describes.

Two enforcing seams appear below:

- **middleware carve-out** — `src/lib/supabase/middleware.ts`'s subscription
  paywall. `SUB_REQUIRED_PREFIXES` lists every route that needs paid access at
  all; `FREEMIUM_ADMITTED_ROUTE_PREFIXES` (flag-gated, T2) is the small
  exception list that lets a free-tier user through anyway. Every `/api/*`
  prefix except `/api/scan` stays outside that exception list, so middleware
  alone fully denies free users there (403 `subscription_required`) — no
  in-route guard is needed or present.
- **in-route guard** — for the one admitted API prefix, `/api/scan`,
  middleware stops enforcing the entitlement at all (any authenticated user,
  paid or not, reaches the route). Sub-routes that are premium features
  therefore have to check paid access themselves, server-side, using
  `hasFreemiumPaidAccess` (`src/lib/entitlements/access.ts`, T4) — the same
  `active || oneTimeAccessState === "active" || moderatorAccess === "active"`
  composite the middleware paywall uses (including the T2 review fix that
  re-verifies `active` via `hasCurrentPaidAppAccess` once a moderator grant
  has ended or its lookup is unavailable, so a stale manual grant can't keep
  counting as paid). `email` is threaded through to the underlying
  `hasAppAccess` call (T4 review fix C1 — an email-bound manual grant has no
  `user_id` row to match otherwise), and the result is the tri-state
  `FreemiumAccessResult` (`"allowed" | "denied" | "unavailable"`, T4 review
  fix I2) rather than a plain boolean, so an unreadable moderator lookup with
  no independent paid entitlement surfaces as the same retriable 503
  (`moderator_access_unavailable`-equivalent) middleware would return, not a
  hard 403 deny.

**Flag off** (`FREEMIUM_SCANNER_FIRST_ENABLED` unset or not `"true"`):
`FREEMIUM_ADMITTED_ROUTE_PREFIXES` never applies (`shouldRedirectToReactivation`
always returns `true` — proven for `/api/scan` itself by
`tests/freemium-admission-middleware.test.ts` → `"flag off: always redirects
to reactivation, admitted or not"`), so a free user is denied by middleware
before ever reaching `/api/scan/save` or `/api/scan/wishlist`. `hasFreemiumPaidAccess`
itself now short-circuits to `"allowed"` before performing any billing or
moderator lookup when the flag is off (PR1 review fix F1) — it is not merely
"redundant but harmless" by virtue of being unreachable; it is provably inert
on its own. This also closes a flag-OFF regression the earlier, non-flag-aware
version of the guard had: a field-test guest who already reaches these routes
today independent of this flag (a valid manual field-test grant plus an
unrelated moderator-lookup outage) would have been 503'd by the guard where
`main` returns 200 for them. See the "field-test-guest" rows below.

## `/api/scan/*`

| Route | Method | Required entitlement | Enforcing seam (flag ON) | Test |
| --- | --- | --- | --- | --- |
| `/api/scan/resolve` | POST | free (auth + rate limit only) | middleware admits (`/api/scan` in `FREEMIUM_ADMITTED_ROUTE_PREFIXES`); route itself has no entitlement check — unaffected by this task | `tests/freemium-admission-middleware.test.ts` → `"isFreemiumAdmittedRoutePath admits the app-shell page prefixes and /api/scan"`, `"flag on: admitted routes are exempted from the reactivation redirect"` |
| `/api/scan/search` | GET | free (auth + rate limit only) | middleware admits; unaffected by this task | same as above (`/api/scan` prefix) |
| `/api/scan/submit` | POST | free (auth + rate limit only) | middleware admits; unaffected by this task | same as above (`/api/scan` prefix) |
| `/api/scan/save` | POST (move to routine/Merkliste) | **premium** | **in-route guard** (new, T4) — `requirePremiumAccess` dep, wired to `hasFreemiumPaidAccess` in `src/app/api/scan/save/route.ts` | `tests/freemium-enforcement-matrix.test.ts` → `"scan save POST: a free-tier user (flag-ON reachable) is denied with the middleware's subscription_required shape"`; paid pass: `"scan save POST: a paid user (composite allowed) passes through unchanged"` |
| `/api/scan/save` | DELETE (remove from routine/Merkliste) | **premium** | **in-route guard** (new, T4), same dep | `tests/freemium-enforcement-matrix.test.ts` → `"scan save DELETE: a free-tier user is denied before any removal"` |
| `/api/scan/wishlist` | GET (Merkliste listing) | **premium** | **in-route guard** (new, T4) — `requirePremiumAccess` dep, wired to `hasFreemiumPaidAccess` in `src/app/api/scan/wishlist/route.ts` | `tests/freemium-enforcement-matrix.test.ts` → `"scan wishlist GET: a free-tier user is denied with the middleware's subscription_required shape"`; paid pass: `"scan wishlist GET: a paid user passes through unchanged"` |
| `/api/scan/reveal` (or equivalent one-lifetime-reveal endpoint) | POST | **premium action for a free user** (consumes the one-lifetime-reveal credit; distinct from ordinary premium — a free user is the intended caller once, ledger-gated) | **planned (T8)** — endpoint does not exist yet; masked-alternative contract + reveal ledger land in T8 | none yet — add with T8 |

Note: `hasFreemiumPaidAccess` recomputes the composite directly (admin client
+ `hasCurrentAppAccess` / `resolveOneTimeAccessStateForUser` /
`resolveModeratorAccess`) because middleware computes its own copy of this
signal per-request but does not forward it to the route handler (no header,
no context). This is the "guard util" the T4 brief allowed for — it does not
restructure `src/lib/scan/route.ts`'s shared `createScanRoute` scaffolding
(auth → rate limit → parse → handler), which all five scan routes share; the
guard is called from inside each premium route's own `handler` callback so
`resolve`/`search`/`submit` are untouched.

Note (PR1 review fix F1): a field-test guest (`user.app_metadata.access_kind
=== "field_test"`) is a case middleware treats specially — it skips the
moderator lookup for them entirely, relying only on `active`/
`oneTimeAccessState` (see `src/lib/supabase/middleware.ts` around
`isPersonalPlanFieldTestGuest`). `hasFreemiumPaidAccess` now takes the same
`fieldTestGuest` signal (computed at each route's call site via
`isPersonalPlanFieldTestGuest`) and applies the identical skip, so a
moderator-lookup outage that is irrelevant to a field-test guest's access can
no longer surface as a 503 for them where middleware would have let them
through. Pinned by the `"field-test-guest"` and
`"field-test-guest-moderator-unavailable"` rows in the `tests/freemium-enforcement-matrix.test.ts`
parity matrix (both seams — the guard util and the middleware paywall —
asserted identical).

## Other premium APIs (middleware-enforced, unaffected by this task)

| Route | Method | Required entitlement | Enforcing seam | Test |
| --- | --- | --- | --- | --- |
| `/api/profile` | GET | premium today; **future: free read** (not changed in this task — a later PR is expected to move Haar-Check display data to a free read; see plan.md §8 T4 note) | middleware carve-out (`/api/profile` not in `FREEMIUM_ADMITTED_ROUTE_PREFIXES`) | `tests/freemium-enforcement-matrix.test.ts` → `"flag on: a free authenticated user is still denied /api/profile (non-admitted, subscription_required)"` (added by this task — previously only the pure-function prefix-list test existed); baseline prefix coverage: `tests/freemium-admission-middleware.test.ts` → `"flag on: non-admitted routes still redirect to reactivation"` |
| `/api/profile` | PUT (Haar-Check fields) | **premium** | middleware carve-out | same tests as GET above (method-agnostic: middleware gates the whole prefix) |
| `/api/chat` | POST | **premium** | middleware carve-out | `tests/auth-middleware-personal-plan-routine.test.ts` → `"flag on: a free authenticated user without current access is still gated on a non-admitted route (/api/chat stays subscription_required)"` (full `createUpdateSession` e2e, asserts the exact `{ error: "subscription_required" }` / 403 shape); prefix coverage: `tests/freemium-admission-middleware.test.ts` → `"flag on: non-admitted routes still redirect to reactivation"` |
| `/api/personal-plan/stage-1/previews` | GET | **premium** | middleware carve-out (`/api/personal-plan` prefix) | `tests/freemium-enforcement-matrix.test.ts` → `"flag on: a free authenticated user is still denied /api/personal-plan/stage-1/previews (non-admitted, subscription_required)"` (added by this task — previously only the `/api/personal-plan` prefix-list test existed, not this concrete route); prefix coverage: `tests/freemium-admission-middleware.test.ts` → `"flag on: non-admitted routes still redirect to reactivation"` |
| `/api/routine`, `/api/tracker`, `/api/memory`, `/api/product-intake` | (all methods) | premium | middleware carve-out | `tests/freemium-admission-middleware.test.ts` → `"flag on: non-admitted routes still redirect to reactivation"` (prefix-level; no route-specific e2e test added — brief scope is `/api/scan/*`, `/api/profile`, `/api/chat`, `/api/personal-plan/stage-1/previews`) |

## Flag-off regression coverage

| Assertion | Test |
| --- | --- |
| `/api/scan` itself stays fully subscription-gated when the flag is off (so a free user never reaches `/api/scan/save` or `/api/scan/wishlist` in the first place) | `tests/freemium-admission-middleware.test.ts` → `"flag off: always redirects to reactivation, admitted or not"` |
| A one-time-access owner or an active moderator (paid via the composite, `active` alone false) is unaffected by admission logic regardless of the flag | `tests/auth-middleware-personal-plan-routine.test.ts` → `"flag off: a one-time-access owner at needs_onboarding is redirected to /onboarding from /anwendung (baseline)"`, `"an ended moderator with independently verified paid access remains admitted"` |
| `hasFreemiumPaidAccess` itself is inert with the flag off — `"allowed"`, with no billing or moderator lookup performed at all (PR1 review fix F1a) | `tests/freemium-enforcement-matrix.test.ts` → `"hasFreemiumPaidAccess: flag off is inert — allowed, no billing/moderator lookups performed"` |
| The in-route guards' own composite semantics with the flag on | `tests/freemium-enforcement-matrix.test.ts` → `hasFreemiumPaidAccess` unit tests (active subscription / one-time / moderator / ended-moderator-fix / unavailable-moderator-fallback / field-test-guest skip) |
