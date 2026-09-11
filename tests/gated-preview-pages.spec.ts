import { expect, test, type Page } from "@playwright/test"

import { GATED_EXAMPLE_COPY } from "../src/lib/gated-preview/example-copy"

/**
 * Browser cover for the three gated „Beispiel" pages (T11 frame + T12 compositions),
 * driven through the dev-only `/labs/gated-preview` harness — the real routes need a
 * signed-in free account with the freemium flag on, while the harness renders the SAME
 * composition components inside a stand-in for the authenticated shell's geometry.
 *
 * These are the findings the node tests cannot reach, because they only exist once a real
 * DOM, real layout and a real event dispatch run together: that the frame plus its one CTA
 * fit a 375×812 screen without the page body scrolling, that the example scrolls INSIDE
 * the frame, that a tap on a link inside the example neither navigates nor pushes history
 * (the composition renders real `<Link>`s whose handler would `pushState`), and that no
 * request leaves the page while it is open.
 *
 * Run against a dev server (the harness 404s in a production build):
 *   npm run dev:worktree
 *   PLAYWRIGHT_BASE_URL=http://localhost:<port> npx playwright test tests/gated-preview-pages.spec.ts --project=chromium
 */

const EXAMPLES = ["routine", "anwendung", "chat"] as const

async function openExample(page: Page, example: (typeof EXAMPLES)[number]) {
  const apiCalls: string[] = []
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(`/labs/gated-preview?example=${example}`)
  const appOrigin = new URL(page.url()).origin
  page.on("request", (request) => {
    const url = new URL(request.url())
    // Only this app's own API surface. Third-party ingest hosts (Sentry, PostHog) are
    // app-global instrumentation present on EVERY page and are not something a gated
    // composition can cause or prevent — Sentry's ingest path happens to look like
    // `/api/<projectId>/envelope/`, hence the origin check rather than a path check.
    if (url.origin === appOrigin && url.pathname.startsWith("/api/")) {
      apiCalls.push(`${request.method()} ${url.pathname}`)
    }
  })
  await expect(page.locator("[data-gated-preview]")).toBeVisible()
  // The cookie banner is a global overlay, not part of this surface; decline the
  // non-essential half so it stops covering the CTA.
  const declineCookies = page.getByRole("button", { name: "Nur essentielle" })
  if (await declineCookies.isVisible().catch(() => false)) await declineCookies.click()
  return apiCalls
}

for (const example of EXAMPLES) {
  const copy = GATED_EXAMPLE_COPY[example]

  test(`gated ${example}: one screen — frame, „Beispiel" band, benefit and the single CTA`, async ({
    page,
  }) => {
    await openExample(page, example)

    await expect(page.locator(`[data-gated-preview="${copy.feature}"]`)).toBeVisible()
    await expect(page.locator("[data-gated-preview-label]")).toHaveText(copy.exampleLabel)
    await expect(page.getByText(copy.benefit)).toBeVisible()

    const cta = page.getByRole("button", { name: copy.cta })
    await expect(cta).toBeVisible()
    await expect(page.locator("[data-gated-preview-cta-block] button")).toHaveCount(1)

    // The example scrolls inside the frame, so the page body never grows past the screen.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    )
    expect(overflow).toBeLessThanOrEqual(1)
  })

  test(`gated ${example}: the example scrolls inside the frame`, async ({ page }) => {
    await openExample(page, example)

    const scroller = page.locator("[data-gated-preview-scroll]")
    const scrolled = await scroller.evaluate((node) => {
      node.scrollTop = node.scrollHeight
      return { top: node.scrollTop, overflow: node.scrollHeight - node.clientHeight }
    })
    expect(scrolled.overflow).toBeGreaterThan(0)
    expect(scrolled.top).toBeGreaterThan(0)

    // Scrolling the example must not have moved the CTA off the screen.
    await expect(page.getByRole("button", { name: copy.cta })).toBeInViewport()
  })

  test(`gated ${example}: nothing inside the example does anything`, async ({ page }) => {
    const apiCalls = await openExample(page, example)

    const before = { url: page.url(), history: await page.evaluate(() => history.length) }
    const links = page.locator("[data-gated-example-inert] a")
    const linkCount = await links.count()

    for (let index = 0; index < Math.min(linkCount, 4); index += 1) {
      await links.nth(index).click({ force: true })
    }
    // …and a control that is not a link: the disabled composer / a card row.
    await page.locator("[data-gated-example-inert]").click({ position: { x: 8, y: 8 } })
    await page.waitForTimeout(400)

    expect(page.url()).toBe(before.url)
    expect(await page.evaluate(() => history.length)).toBe(before.history)
    await expect(page.locator("[data-gated-preview]")).toBeVisible()
    // No sheet was opened by anything inside the example — only the CTA may do that.
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    expect(apiCalls, `gated ${example} must issue no API request`).toEqual([])
  })

  test(`gated ${example}: the one CTA opens the Premium sheet with this page's context`, async ({
    page,
  }) => {
    await openExample(page, example)

    await page.getByRole("button", { name: copy.cta }).click()
    const sheet = page.locator('[role="dialog"]')
    await expect(sheet).toBeVisible()
    await expect(sheet).toContainText("Alles für dein Haar.")
    // The tapped feature is ordered first (T5's `orderedBenefits`).
    await expect(sheet.locator("li").first()).toContainText(
      { routine: "Deine Routine", anwendung: "Deine Anwendung", chat: "Chaarlie Chat" }[example],
    )
  })
}

test("the Anwendung example shows real products on its shelves", async ({ page }) => {
  await openExample(page, "anwendung")

  await expect(page.getByText("Waschtag")).toBeVisible()
  await expect(page.locator('[data-application-shelf-slot="confirmed"]').first()).toBeVisible()
  await expect(page.locator('[data-application-shelf-slot="open"]')).toHaveCount(0)
})

test("the Routine example shows real catalog products with their images", async ({ page }) => {
  await openExample(page, "routine")

  await expect(page.getByText("Balea Aqua Hyaluron")).toBeVisible()
  await expect(page.getByText("Deine Routine mit 5 Produkten.")).toBeVisible()
  await expect(page.locator("[data-routine-card-list] img").first()).toBeVisible()
})

test("the Chat example shows a transcript and a composer that cannot be used", async ({ page }) => {
  await openExample(page, "chat")

  await expect(page.locator('[data-testid="message-user"]').first()).toBeVisible()
  await expect(page.locator('[data-testid="message-assistant"]').first()).toBeVisible()
  await expect(page.locator('[data-testid="chat-input"]')).toBeDisabled()
})
