import { expect, test } from "@playwright/test"

/**
 * T12 pre-boundary fix wave, finding F1: `shouldRenderGatedExample`
 * (`src/lib/gated-preview/gate.ts`) decides whether `/chat`, `/routine` and `/anwendung`
 * render the framed „Beispiel" example or today's real page. Every other lane covering it
 * is indirect — the node suite greps route source text
 * (`tests/gated-example-pages.test.tsx`) and `tests/gated-preview-pages.spec.ts` only
 * drives `/labs/gated-preview`, which renders the example COMPOSITIONS in isolation, never
 * a route's own tier resolution. `/chat` in particular went from a `"use client"` page to
 * a server component with `force-dynamic` for this — the riskiest change in the task — and
 * had no render-level coverage at all before this spec.
 *
 * This drives the REAL routes with a real signed-in session (the dev-login account from
 * docs/local-qa-access.md §1, which is always paid, i.e. premium) and asserts the actual
 * page renders: the real `ChatContainer` (composer input visible, conversation sidebar
 * present), no `[data-gated-preview]` frame, no CTA.
 *
 * The freemium flag (`FREEMIUM_SCANNER_FIRST_ENABLED`) is read straight from `process.env`
 * per request by the already-running dev server (src/lib/entitlements/flag.ts) — a
 * Playwright run cannot flip a separate process's env mid-suite. So this file is run
 * TWICE, once per server, and each test names which premium path it is exercising:
 *
 *   # (a) flag off — the pre-existing short-circuit path
 *   FREEMIUM_SCANNER_FIRST_ENABLED=false npx next dev -p 3120
 *   PLAYWRIGHT_BASE_URL=http://localhost:3120 PLAYWRIGHT_EXPECT_LOCAL_DEV_LOGIN=true \
 *     npx playwright test tests/gated-preview-real-route-tiers.spec.ts --project=chromium
 *
 *   # (b) flag on, premium — the paid-access composite's "premium" branch
 *   FREEMIUM_SCANNER_FIRST_ENABLED=true npx next dev -p 3120
 *   PLAYWRIGHT_BASE_URL=http://localhost:3120 PLAYWRIGHT_EXPECT_LOCAL_DEV_LOGIN=true \
 *     npx playwright test tests/gated-preview-real-route-tiers.spec.ts --project=chromium
 *
 * Both runs must be green; the assertions below hold for a premium session under either
 * flag state (`shouldRenderGatedExample` fails closed to `"premium"` in both cases — see
 * `tests/gated-example-pages.test.tsx`'s "only the free tier renders the example" and "with
 * the freemium flag off..." unit tests for the branch logic itself).
 */

test.beforeEach(async ({ page }) => {
  test.skip(
    process.env.PLAYWRIGHT_EXPECT_LOCAL_DEV_LOGIN !== "true",
    "run against a local server with LOCAL_DEV_LOGIN_ENABLED=1 (see docs/local-qa-access.md §1)",
  )
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "chaarlie_cookie_consent_v1",
      JSON.stringify({ essential: true, analytics: false, marketing: false, ts: Date.now() }),
    )
  })
})

test("premium /chat renders the real ChatContainer, never the gated example", async ({ page }) => {
  await page.goto("/api/dev/login?next=/chat")
  await page.waitForURL("/chat", { timeout: 15_000 })

  // The real composer, visible and enabled — the gated example's `ChatInput` is `disabled`.
  const composer = page.getByPlaceholder(/Stelle eine Frage/)
  await expect(composer).toBeVisible({ timeout: 10_000 })
  await expect(composer).toBeEnabled()

  // The real page's own chrome, absent from the framed example.
  await expect(page.getByRole("heading", { name: "Unterhaltungen" })).toBeVisible()
  // PR3 Codex fix (X3): the greeting is time-of-day dependent (`chat-container.tsx` picks
  // „Guten Morgen"/„Guten Tag"/„Guten Abend" from the local hour), so pin the pattern rather
  // than one fixed greeting — the exact string failed every afternoon.
  await expect(
    page.getByRole("heading", { name: /^Guten (Morgen|Tag|Abend), Local$/ }),
  ).toBeVisible()

  await expect(page.locator("[data-gated-preview]")).toHaveCount(0)
  await expect(page.locator("[data-gated-preview-cta-block]")).toHaveCount(0)
})

// PR3 Codex fix (X2): flag on now streams `/chat`'s tier-resolved segment behind a Suspense
// boundary instead of awaiting it inline. This drives a cold, direct SSR load (not a client
// transition) through that boundary and confirms the resolved DOM still hydrates correctly —
// the composer accepts input — with no leftover Suspense fallback and no gated-preview frame.
test("premium /chat still renders and hydrates correctly through the flag-on Suspense boundary", async ({
  page,
}) => {
  await page.goto("/api/dev/login?next=/chat")
  await page.waitForURL("/chat", { timeout: 15_000 })

  const composer = page.getByPlaceholder(/Stelle eine Frage/)
  await expect(composer).toBeVisible({ timeout: 10_000 })
  await composer.click()
  await composer.fill("Hallo")
  await expect(composer).toHaveValue("Hallo")

  // A fresh, direct navigation re-enters the Suspense boundary from a cold SSR request
  // rather than a client-side transition off an already-hydrated page.
  await page.reload()
  await expect(page.getByPlaceholder(/Stelle eine Frage/)).toBeVisible({ timeout: 10_000 })
  await expect(page.locator("[data-gated-preview]")).toHaveCount(0)
})

test("premium /routine and /anwendung never render the gated example", async ({ page }) => {
  await page.goto("/api/dev/login?next=/routine")
  await page.waitForURL("/routine", { timeout: 15_000 })
  await expect(page.locator("[data-gated-preview]")).toHaveCount(0)
  // The dev-login account has no Personal Plan enrollment, so this is the legacy Routine —
  // real content either way, and specifically not the framed „Beispiel · eine
  // Chaarlie-Routine" this page would show a free user.
  await expect(page.getByText("Beispiel · eine Chaarlie-Routine")).toHaveCount(0)

  await page.goto("/anwendung")
  await expect(page.locator("[data-gated-preview]")).toHaveCount(0)
  await expect(page.getByText("Beispiel · eine Chaarlie-Anwendung")).toHaveCount(0)
})
