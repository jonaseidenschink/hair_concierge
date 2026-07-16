import { expect, test, type Page, type Route } from "@playwright/test"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const hasLiveSecrets = Boolean(supabaseUrl && supabaseAnonKey && serviceRoleKey)
const runLiveTrackerChecks = hasLiveSecrets && process.env.PLAYWRIGHT_RUN_TRACKER_LIVE === "1"
const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000"

type TrackerDayType = "wash" | "clarifying" | "treatment_only" | "styling_only" | "none" | "custom"

type TrackerDay = {
  loggedOn: string
  dayType: TrackerDayType
  customActivityName?: string | null
  products: Array<{
    category: string
    productName: string | null
    userProductUsageId: string | null
  }>
}

type TrackerFixture = {
  today: string
  days: TrackerDay[]
  shelf: Array<{
    usageId: string
    category: string
    productName: string | null
    imageUrl: string | null
  }>
}

const activityLabels = [
  "Haare gewaschen",
  "Klärwäsche",
  "Pflege ohne Wäsche",
  "Styling aufgefrischt",
  "Keine Haarpflege",
  "Eigene Aktivität",
] as const

function shiftDate(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

function trackerFixture(today = "2026-07-13"): TrackerFixture {
  return {
    today,
    days: [
      {
        loggedOn: shiftDate(today, -2),
        dayType: "wash",
        products: [
          {
            category: "shampoo",
            productName: "Alpha Shampoo",
            userProductUsageId: "usage-shampoo",
          },
          {
            category: "conditioner",
            productName: "Beta Conditioner",
            userProductUsageId: "usage-conditioner",
          },
        ],
      },
    ],
    shelf: [
      { usageId: "usage-oil", category: "oil", productName: "Omega Oil", imageUrl: null },
      {
        usageId: "usage-conditioner",
        category: "conditioner",
        productName: "Beta Conditioner",
        imageUrl: null,
      },
      {
        usageId: "usage-shampoo",
        category: "shampoo",
        productName: "Alpha Shampoo",
        imageUrl:
          "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='48'%3E%3Crect width='40' height='48' fill='%236b50a0'/%3E%3C/svg%3E",
      },
      { usageId: "usage-mask", category: "mask", productName: "Gamma Mask", imageUrl: null },
    ],
  }
}

function trackerBody(fixture: TrackerFixture) {
  return {
    days: fixture.days,
    gate: { unlocked: false, daysRemaining: 7, loggedDayCount: fixture.days.length },
    nudges: [] as Array<{
      category: string
      direction: "increase" | "decrease"
      message: string
    }>,
    rhythm: {
      washesThisWeek: 0,
      targetWashesPerWeek: 2,
      frequencyTarget: {
        minFrequency: "weekly_1x",
        maxFrequency: "weekly_2x",
        preferredFrequency: "weekly_2x",
      },
    },
    rhythmHistory: fixture.days.map(({ loggedOn, dayType }) => ({ loggedOn, dayType })),
    shelf: fixture.shelf,
    today: fixture.today,
  }
}

async function login(page: Page, email: string, password: string) {
  await page.goto(`${baseUrl}/auth`, { waitUntil: "networkidle" })
  await expect(page.getByText("chaarlie").first()).toBeVisible({ timeout: 15_000 })
  const loginTab = page.getByRole("tab", { name: "Anmelden" })
  if (await loginTab.isVisible()) await loginTab.click()
  const emailInput = page.locator('input[type="email"]:visible')
  const passwordInput = page.locator('input[type="password"]:visible')
  await expect(emailInput).toBeEditable()
  await expect(passwordInput).toBeEditable()
  await emailInput.fill(email)
  await passwordInput.fill(password)
  const submit = page.getByRole("button", { name: /^Anmelden$/ })
  await expect(submit).toBeEnabled()
  await submit.click()
  await page.waitForURL(/\/(chat|tracker)$/, { timeout: 30_000 })
}

async function installTrackerFixture(
  page: Page,
  fixture: TrackerFixture,
  onWrite?: (request: {
    method: string
    body: Record<string, unknown>
  }) => Promise<{ status?: number }> | { status?: number },
  bodyForRead?: (
    readNumber: number,
  ) => Promise<ReturnType<typeof trackerBody>> | ReturnType<typeof trackerBody>,
) {
  let readNumber = 0
  const handleWrite = async (route: Route) => {
    const request = route.request()
    const body = request.postDataJSON() as Record<string, unknown>
    const outcome = (await onWrite?.({ method: request.method(), body })) ?? {}
    if ((outcome.status ?? 200) >= 400) {
      await route.fulfill({
        status: outcome.status ?? 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Konnte nicht gespeichert werden." }),
      })
      return
    }

    const loggedOn = String(body.loggedOn)
    if (request.method() === "DELETE") {
      fixture.days = fixture.days.filter((day) => day.loggedOn !== loggedOn)
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true, day: { deletedAt: "now" } }),
      })
      return
    }
    const nextDay: TrackerDay = {
      loggedOn,
      dayType: body.dayType as TrackerDayType,
      customActivityName: (body.customActivityName as string | null | undefined) ?? null,
      products: (body.products as TrackerDay["products"]) ?? [],
    }
    fixture.days = [...fixture.days.filter((day) => day.loggedOn !== loggedOn), nextDay]
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, day: nextDay }),
    })
  }
  await page.route(/\/api\/tracker\?.*$/, async (route) => {
    readNumber += 1
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify((await bodyForRead?.(readNumber)) ?? trackerBody(fixture)),
    })
  })
  await page.route("**/api/tracker/log", handleWrite)
}

async function openTracker(page: Page) {
  await page.goto(`${baseUrl}/tracker`, { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("heading", { name: "Tagebuch" })).toBeVisible()
  const cookieDialog = page.getByRole("dialog", { name: "Cookie-Einstellungen" })
  if (await cookieDialog.isVisible()) {
    await cookieDialog.getByRole("button", { name: "Nur essentielle" }).click()
  }
}

async function openSheet(page: Page) {
  const trigger = page.getByRole("button", { name: /Routine eintragen|Bearbeiten/ }).first()
  await trigger.click()
  await expect(page.getByRole("dialog", { name: "Routine eintragen" })).toBeVisible()
}

async function stubReactivationDestination(page: Page) {
  await page.route("**/reactivate?*", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Membership reactivation</title>",
    })
  })
}

async function selectYesterday(page: Page) {
  await page.getByRole("tablist", { name: "Letzte acht Tage" }).getByRole("tab").nth(6).click()
}

async function expectNoOverflowOrOverlap(page: Page) {
  const problems = await page
    .locator("button, input, [role=dialog], .tracker-product-row")
    .evaluateAll((nodes) =>
      nodes.flatMap((node) => {
        const rect = node.getBoundingClientRect()
        const style = window.getComputedStyle(node)
        if (style.display === "none" || rect.width === 0 || rect.height === 0) return []
        return rect.left < -1 || rect.right > window.innerWidth + 1
          ? [node.textContent?.trim() || node.tagName]
          : []
      }),
    )
  expect(problems).toEqual([])

  for (const selector of [".tracker-activity-tile", ".tracker-product-row"]) {
    const rectangles = await page.locator(selector).evaluateAll((nodes) =>
      nodes
        .map((node) => {
          const rect = node.getBoundingClientRect()
          return { top: rect.top, bottom: rect.bottom, left: rect.left }
        })
        .sort((left, right) => left.top - right.top || left.left - right.left),
    )
    for (let index = 1; index < rectangles.length; index += 1) {
      // Tiles share rows on wider screens, so only compare vertically aligned controls.
      const previous = rectangles[index - 1]
      const current = rectangles[index]
      if (Math.abs(previous.left - current.left) < 2)
        expect(current.top).toBeGreaterThanOrEqual(previous.bottom - 1)
    }
  }
}

test.describe.serial("@ci tracker page regressions", () => {
  // This must remain a runtime skip: importing this file cannot make unrelated
  // Playwright suites fail on machines without the live Supabase credentials.
  test.skip(!hasLiveSecrets, "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")

  const email = `playwright-tracker-${Date.now()}@hairconscierge.test`
  const password = "Playwright123!"
  let admin: SupabaseClient | null = null
  let userId = ""
  let foreignUserId = ""
  let foreignUsageId = ""
  let liveTrackerSchemaReady = false

  test.beforeAll(async () => {
    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) return
    admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: "Playwright Tracker" },
    })
    if (error || !data.user) throw error ?? new Error("Failed to create tracker E2E user")
    userId = data.user.id
    const periodEnd = new Date(Date.now() + 30 * 86_400_000).toISOString()
    const [{ error: profileError }, { error: billingError }, { error: hairError }] =
      await Promise.all([
        admin.from("profiles").upsert(
          {
            id: userId,
            email,
            full_name: "Playwright Tracker",
            onboarding_completed: true,
            subscription_status: "active",
            current_period_end: periodEnd,
          },
          { onConflict: "id" },
        ),
        admin.from("billing_subscriptions").upsert(
          {
            user_id: userId,
            provider: "stripe",
            provider_customer_id: `cus_tracker_${userId}`,
            provider_subscription_id: `sub_tracker_${userId}`,
            provider_status: "active",
            entitlement_status: "active",
            interval: "month",
            current_period_end: periodEnd,
            cancel_at_period_end: false,
            metadata: { ci_seed: "tracker-page" },
          },
          { onConflict: "provider,provider_subscription_id" },
        ),
        admin.from("hair_profiles").upsert(
          {
            user_id: userId,
            hair_texture: "wavy",
            thickness: "fine",
            density: "medium",
            cuticle_condition: "smooth",
            protein_moisture_balance: "stretches_bounces",
            scalp_type: "balanced",
            scalp_condition: [],
            chemical_treatment: [],
            concerns: [],
          },
          { onConflict: "user_id" },
        ),
      ])
    if (profileError) throw profileError
    if (billingError && billingError.code !== "PGRST205") throw billingError
    if (hairError) throw hairError

    if (!runLiveTrackerChecks) return
    const { error: schemaError } = await admin
      .from("routine_logs")
      .select("client_session_id, client_revision")
      .limit(1)
    if (schemaError) return
    liveTrackerSchemaReady = true

    const { data: foreign, error: foreignError } = await admin.auth.admin.createUser({
      email: `playwright-tracker-foreign-${Date.now()}@hairconscierge.test`,
      password,
      email_confirm: true,
    })
    if (foreignError || !foreign.user)
      throw foreignError ?? new Error("Failed to create foreign tracker user")
    foreignUserId = foreign.user.id
    const { error: foreignProfileError } = await admin
      .from("profiles")
      .upsert({ id: foreignUserId, email: foreign.user.email ?? null }, { onConflict: "id" })
    if (foreignProfileError) throw foreignProfileError
    const { data: foreignUsage, error: usageError } = await admin
      .from("user_product_usage")
      .insert({
        user_id: foreignUserId,
        category: "shampoo",
        product_name: "Foreign Shampoo",
        frequency_range: "weekly_1x",
      })
      .select("id")
      .single()
    if (usageError || !foreignUsage) throw usageError ?? new Error("Failed to seed foreign product")
    foreignUsageId = foreignUsage.id
  })

  test.afterAll(async () => {
    if (!admin) return
    if (foreignUserId) {
      await admin.from("user_product_usage").delete().eq("user_id", foreignUserId)
      await admin.from("profiles").delete().eq("id", foreignUserId)
      await admin.auth.admin.deleteUser(foreignUserId)
    }
    if (!userId) return
    await admin.from("routine_logs").delete().eq("user_id", userId)
    await admin.from("user_product_usage").delete().eq("user_id", userId)
    await admin.from("billing_subscriptions").delete().eq("user_id", userId)
    await admin.from("hair_profiles").delete().eq("user_id", userId)
    await admin.from("profiles").delete().eq("id", userId)
    await admin.auth.admin.deleteUser(userId)
  })

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "chaarlie_cookie_consent_v1",
        JSON.stringify({ essential: true, analytics: false, marketing: false, ts: Date.now() }),
      )
    })
    await login(page, email, password)
  })

  test("bottom sheet has keyboard lifecycle, valid activities, custom validation, and responsive containment", async ({
    page,
  }) => {
    const fixture = trackerFixture()
    await installTrackerFixture(page, fixture)
    await page.setViewportSize({ width: 390, height: 844 })
    await openTracker(page)
    const trigger = page.getByRole("button", { name: /Routine eintragen|Bearbeiten/ }).first()
    await trigger.focus()
    await openSheet(page)
    await expect(page.locator("body")).toHaveCSS("overflow", "hidden")
    await expect(page.getByRole("button", { name: "Schließen" })).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog", { name: "Routine eintragen" })).toBeHidden()
    await expect(trigger).toBeFocused()

    await openSheet(page)
    for (const label of activityLabels)
      await expect(page.getByRole("button", { name: new RegExp(label) })).toBeVisible()
    await page.getByRole("button", { name: /Eigene Aktivität/ }).click()
    await expect(page.locator("#custom-activity-error")).toHaveText("Bitte gib einen Namen ein.")
    await expect(page.getByRole("button", { name: "Fertig" })).toBeDisabled()
    const lastEnabledControl = page.getByRole("link", {
      name: /Produkte kannst du in deinem Profil verwalten/,
    })
    await lastEnabledControl.focus()
    await expect(lastEnabledControl).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(page.getByRole("button", { name: "Schließen" })).toBeFocused()
    await page.keyboard.press("Shift+Tab")
    await expect(lastEnabledControl).toBeFocused()
    await page.getByLabel("Wie nennst du diese Aktivität?").fill("Sauna")
    await expect(page.getByRole("button", { name: "Fertig" })).toBeEnabled()
    await expect(
      page.getByRole("link", { name: /Produkte kannst du in deinem Profil verwalten/ }),
    ).toHaveAttribute("href", "/profile#profile-section-products")
    await expect(page.getByTestId("tracker-product-image-usage-shampoo")).toBeVisible()
    await expect(page.locator(".tracker-product-image-fallback").first()).toBeVisible()

    for (const viewport of [
      { width: 390, height: 844 },
      { width: 320, height: 700 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(viewport)
      await expectNoOverflowOrOverlap(page)
    }

    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator(".tracker-product-row input[type=checkbox]").first().check()
    await page.getByLabel("Wie nennst du diese Aktivität?").fill("")
    await page.getByRole("button", { name: "Schließen" }).click()
    await expect(page.getByRole("dialog", { name: "Routine eintragen" })).toBeHidden()
    await expect(trigger).toBeVisible()
  })

  test("invalid custom dismissal restores an in-flight valid save at a newer revision", async ({
    page,
  }) => {
    const fixture = trackerFixture()
    const writes: Array<{ method: string; body: Record<string, unknown> }> = []
    let releaseFirstWrite!: () => void
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    let firstWriteStarted!: () => void
    const started = new Promise<void>((resolve) => {
      firstWriteStarted = resolve
    })
    await installTrackerFixture(page, fixture, async (request) => {
      writes.push(request)
      if (writes.length === 1) {
        firstWriteStarted()
        await firstWrite
      }
      return {}
    })
    await openTracker(page)
    await openSheet(page)
    await page.getByRole("button", { name: /Haare gewaschen/ }).click()
    await started
    await page.getByRole("button", { name: /Eigene Aktivität/ }).click()
    await page.getByRole("button", { name: "Schließen" }).click()
    releaseFirstWrite()

    await expect.poll(() => writes.length).toBe(2)
    expect(writes.map((write) => write.method)).toEqual(["PUT", "PUT"])
    expect(writes.map((write) => write.body.dayType)).toEqual(["wash", "wash"])
    expect(writes.map((write) => write.body.clientRevision)).toEqual([1, 3])
  })

  test("direct empty custom dismissal on an empty day makes no mutation", async ({ page }) => {
    const fixture = trackerFixture()
    const writes: Array<{ method: string; body: Record<string, unknown> }> = []
    await installTrackerFixture(page, fixture, async (request) => {
      writes.push(request)
      return {}
    })
    await openTracker(page)
    await openSheet(page)
    await page.getByRole("button", { name: /Eigene Aktivität/ }).click()
    await page.getByRole("button", { name: "Schließen" }).click()
    await page.waitForTimeout(650)

    expect(writes).toEqual([])
  })

  test("a 403 autosave response redirects to membership reactivation", async ({ page }) => {
    const fixture = trackerFixture()
    await stubReactivationDestination(page)
    await installTrackerFixture(page, fixture, async () => ({ status: 403 }))
    await openTracker(page)
    await openSheet(page)
    await page.getByRole("button", { name: /Keine Haarpflege/ }).click()

    await page.waitForURL(/\/reactivate\?reason=expired&next=%2Ftracker$/)
  })

  test("date selection pre-fills the same activity, keeps product order stable, and serializes rapid writes", async ({
    page,
  }) => {
    const fixture = trackerFixture()
    let activeWrites = 0
    let maxConcurrentWrites = 0
    let releaseFirstWrite!: () => void
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    await installTrackerFixture(page, fixture, async () => {
      activeWrites += 1
      maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites)
      if (activeWrites === 1) await firstWrite
      activeWrites -= 1
      return {}
    })
    await openTracker(page)
    await selectYesterday(page)
    await openSheet(page)
    await page.getByRole("button", { name: /Haare gewaschen/ }).click()
    await expect(page.getByText("Wie bei deinem letzten ähnlichen Eintrag.")).toBeVisible()
    const initialProductOrder = await page.locator(".tracker-product-row").allTextContents()
    expect(initialProductOrder.join(" ")).toContain("Shampoo")
    expect(initialProductOrder.join(" ")).toContain("Conditioner")

    await page.getByRole("button", { name: /Klärwäsche/ }).click()
    await page.getByRole("button", { name: /Pflege ohne Wäsche/ }).click()
    await page.getByRole("button", { name: /Styling aufgefrischt/ }).click()
    expect(await page.locator(".tracker-product-row").allTextContents()).toEqual(
      initialProductOrder,
    )
    await expect.poll(() => maxConcurrentWrites).toBe(1)
    releaseFirstWrite()
    await expect.poll(() => activeWrites).toBe(0)
    expect(maxConcurrentWrites).toBe(1)
  })

  test("a successful autosave refreshes server-derived gate and nudge state", async ({ page }) => {
    const fixture = trackerFixture()
    let persisted = false
    let reads = 0
    await installTrackerFixture(
      page,
      fixture,
      async () => {
        persisted = true
        return {}
      },
      () => {
        reads += 1
        const body = trackerBody(fixture)
        if (!persisted) return body
        return {
          ...body,
          gate: { unlocked: true, daysRemaining: 0, loggedDayCount: 10 },
          nudges: [
            {
              category: "mask",
              direction: "increase" as const,
              message: "Dein aktualisierter Hinweis ist jetzt sichtbar.",
            },
          ],
        }
      },
    )
    await openTracker(page)
    await openSheet(page)
    await page.getByRole("button", { name: /Keine Haarpflege/ }).click()
    await expect(page.getByText("Gespeichert", { exact: true })).toBeVisible()
    await expect(page.getByText("Dein aktualisierter Hinweis ist jetzt sichtbar.")).toBeVisible()
    expect(reads).toBeGreaterThanOrEqual(2)
  })

  test("an older derived-state refresh cannot overwrite a newer save cycle", async ({ page }) => {
    const fixture = trackerFixture()
    let releaseOlderRefresh!: () => void
    const olderRefresh = new Promise<void>((resolve) => {
      releaseOlderRefresh = resolve
    })
    await installTrackerFixture(page, fixture, undefined, async (readNumber) => {
      const body = trackerBody(fixture)
      if (readNumber === 2) {
        const olderBody = {
          ...body,
          gate: { unlocked: true, daysRemaining: 0, loggedDayCount: 10 },
          nudges: [
            {
              category: "mask",
              direction: "increase" as const,
              message: "Veralteter Hinweis",
            },
          ],
        }
        await olderRefresh
        return olderBody
      }
      if (readNumber >= 3) {
        return {
          ...body,
          gate: { unlocked: true, daysRemaining: 0, loggedDayCount: 11 },
          nudges: [
            {
              category: "oil",
              direction: "decrease" as const,
              message: "Neuester Hinweis",
            },
          ],
        }
      }
      return body
    })
    await openTracker(page)
    await openSheet(page)

    const firstSave = page.waitForResponse(
      (response) =>
        response.url().includes("/api/tracker/log") && response.request().method() === "PUT",
    )
    await page.getByRole("button", { name: /Keine Haarpflege/ }).click()
    await firstSave

    const secondSave = page.waitForResponse(
      (response) =>
        response.url().includes("/api/tracker/log") && response.request().method() === "PUT",
    )
    await page.getByRole("button", { name: /Haare gewaschen/ }).click()
    await secondSave
    await expect(page.getByText("Neuester Hinweis")).toBeVisible()

    releaseOlderRefresh()
    await page.waitForTimeout(200)
    await expect(page.getByText("Neuester Hinweis")).toBeVisible()
    await expect(page.getByText("Veralteter Hinweis")).toBeHidden()
  })

  test("failed nudge dismissal restores the card and direct 403 redirects to reactivation", async ({
    page,
  }) => {
    const fixture = trackerFixture()
    await stubReactivationDestination(page)
    await installTrackerFixture(page, fixture, undefined, () => ({
      ...trackerBody(fixture),
      gate: { unlocked: true, daysRemaining: 0, loggedDayCount: 10 },
      nudges: [
        {
          category: "mask",
          direction: "increase" as const,
          message: "Nutze deine Maske etwas häufiger.",
        },
      ],
    }))
    let dismissStatus = 500
    await page.route("**/api/tracker/dismiss-nudge", async (route) => {
      await route.fulfill({
        status: dismissStatus,
        contentType: "application/json",
        body: JSON.stringify({ error: "Nicht gespeichert." }),
      })
    })
    await openTracker(page)

    const nudge = page.getByText("Nutze deine Maske etwas häufiger.")
    await expect(nudge).toBeVisible()
    await page.getByRole("button", { name: "Ausblenden" }).click()
    await expect(nudge).toBeVisible()

    dismissStatus = 403
    await page.getByRole("button", { name: "Ausblenden" }).click()
    await page.waitForURL(/\/reactivate\?reason=expired&next=%2Ftracker$/)
  })

  test("fixture save failures expose retry, deletion undo restores the entry, drag closes, and reduced motion removes travel", async ({
    page,
  }) => {
    const fixture = trackerFixture()
    let writes = 0
    await installTrackerFixture(page, fixture, async () => ({ status: ++writes <= 2 ? 500 : 200 }))
    await page.emulateMedia({ reducedMotion: "reduce" })
    await openTracker(page)
    await openSheet(page)
    await expect(page.locator(".bottom-sheet-panel")).toHaveCSS("transform", "none")
    await expect(page.locator(".tracker-rhythm-progress")).toHaveCSS("transition-duration", "0s")
    await page.getByRole("button", { name: /Keine Haarpflege/ }).click()
    await expect(
      page.getByRole("dialog", { name: "Routine eintragen" }).getByRole("alert"),
    ).toContainText("Konnte nicht gespeichert werden.")
    await page
      .getByRole("dialog", { name: "Routine eintragen" })
      .getByRole("button", { name: "Erneut versuchen" })
      .click()
    await expect(
      page.getByRole("dialog", { name: "Routine eintragen" }).getByText("Gespeichert", {
        exact: true,
      }),
    ).toBeVisible()
    await page.getByRole("button", { name: "Eintrag entfernen" }).click()
    await expect(page.getByRole("status")).toContainText("Eintrag gelöscht")
    await page.getByRole("button", { name: "Rückgängig" }).click()
    await expect(page.getByRole("status")).toBeHidden()

    await page.emulateMedia({ reducedMotion: "no-preference" })
    await openSheet(page)
    const panel = page.locator(".bottom-sheet-panel")
    const handle = page.locator("[data-bottom-sheet-handle]")
    await expect(panel).toHaveAttribute("data-state", "open")
    await expect(panel).toHaveCSS("animation-duration", "0.3s")
    await panel.evaluate(async (element) => {
      const animations = element.getAnimations()
      if (animations.length === 0) throw new Error("Bottom-sheet entrance animation did not start")
      await Promise.all(animations.map((animation) => animation.finished))
    })
    await expect
      .poll(() =>
        panel.evaluate(
          (element) => Math.abs(element.getBoundingClientRect().bottom - window.innerHeight) <= 1,
        ),
      )
      .toBe(true)
    const box = await handle.boundingBox()
    if (!box) throw new Error("Bottom-sheet drag handle is not visible")
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + 120, { steps: 5 })
    await expect(panel).toHaveAttribute("data-dragging", "true")
    await page.mouse.up()
    await expect(page.getByRole("dialog", { name: "Routine eintragen" })).toBeHidden()

    await openSheet(page)
    const reopenedPanel = page.locator(".bottom-sheet-panel")
    const reopenedHandle = page.locator("[data-bottom-sheet-handle]")
    await expect
      .poll(() =>
        reopenedPanel.evaluate(
          (element) => Math.abs(element.getBoundingClientRect().bottom - window.innerHeight) <= 1,
        ),
      )
      .toBe(true)
    const reopenedBox = await reopenedHandle.boundingBox()
    if (!reopenedBox) throw new Error("Bottom-sheet drag handle is not visible")
    await page.mouse.move(
      reopenedBox.x + reopenedBox.width / 2,
      reopenedBox.y + reopenedBox.height / 2,
    )
    await page.mouse.down()
    await page.mouse.move(reopenedBox.x + reopenedBox.width / 2, reopenedBox.y + 50, { steps: 3 })
    await expect(reopenedPanel).toHaveAttribute("data-dragging", "true")
    await reopenedPanel.dispatchEvent("pointercancel", { pointerId: 1 })
    await expect(reopenedPanel).toHaveAttribute("data-dragging", "false")
    await expect.poll(() => reopenedPanel.evaluate((element) => element.style.transform)).toBe("")
    await expect(page.getByRole("dialog", { name: "Routine eintragen" })).toBeVisible()
    await page.mouse.up()

    await page.getByRole("button", { name: "Schließen" }).click()
    await expect(page.getByRole("dialog", { name: "Routine eintragen" })).toBeHidden()
    await openSheet(page)
    const recapturedPanel = page.locator(".bottom-sheet-panel")
    const recapturedHandle = page.locator("[data-bottom-sheet-handle]")
    await expect
      .poll(() =>
        recapturedPanel.evaluate(
          (element) => Math.abs(element.getBoundingClientRect().bottom - window.innerHeight) <= 1,
        ),
      )
      .toBe(true)
    const recapturedBox = await recapturedHandle.boundingBox()
    if (!recapturedBox) throw new Error("Bottom-sheet drag handle is not visible")
    await page.mouse.move(
      recapturedBox.x + recapturedBox.width / 2,
      recapturedBox.y + recapturedBox.height / 2,
    )
    await page.mouse.down()
    await page.mouse.move(recapturedBox.x + recapturedBox.width / 2, recapturedBox.y + 50, {
      steps: 3,
    })
    await expect(recapturedPanel).toHaveAttribute("data-dragging", "true")
    await recapturedPanel.dispatchEvent("lostpointercapture", { pointerId: 1 })
    await expect(recapturedPanel).toHaveAttribute("data-dragging", "false")
    await expect.poll(() => recapturedPanel.evaluate((element) => element.style.transform)).toBe("")
    await page.mouse.up()
  })

  test("shared bottom sheet keeps the existing routine drawer open-close behavior and timing", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await page.route("**/api/routine", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          hairProfile: null,
          cards: [
            {
              id: "routine-card-1",
              kind: "verified_matches",
              tone: "green",
              category: "conditioner",
              categoryLabel: "Conditioner",
              productName: "Test Conditioner",
              currentFrequency: "weekly_1x",
              frequencyTarget: {
                minFrequency: "weekly_1x",
                maxFrequency: "weekly_2x",
                preferredFrequency: "weekly_1x",
                delta: "in_range",
              },
              careBalanceRow: null,
              usageRow: null,
              product: null,
              pendingSubmission: null,
              hasProductDrawer: true,
              isLegacyTextOnly: false,
              isTopProposal: false,
            },
          ],
        }),
      })
    })
    await page.goto(`${baseUrl}/routine`, { waitUntil: "domcontentloaded" })
    const trigger = page.getByRole("button", { name: "Conditioner: Test Conditioner" })
    await expect(trigger).toBeVisible()
    await trigger.focus()
    await trigger.click()
    const drawer = page.getByRole("dialog", { name: "Test Conditioner" })
    await expect(drawer).toBeVisible()
    await expect(page.locator(".bottom-sheet-panel")).toHaveCSS("animation-duration", "0.35s")
    await page.getByRole("button", { name: "Schließen" }).click()
    await expect(drawer).toBeHidden()
    await expect(trigger).toBeVisible()
  })

  test("shared bottom sheet keeps the existing product-detail drawer open-close behavior and timing", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await page.route("**/api/routine", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ routine: { cards: [] } }),
      })
    })
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ conversations: [] }),
        })
        return
      }

      const events = [
        { type: "conversation_id", data: "tracker-product-drawer" },
        { type: "content_delta", data: "Dieses Produkt passt zu deiner Routine." },
        {
          type: "product_recommendations",
          data: [
            {
              id: "tracker-product-1",
              name: "Test Leave-in",
              brand: "Chaarlie",
              category: "leave_in",
              price_eur: 18.9,
              recommendation_meta: { top_reasons: ["Leichte Pflege"] },
            },
          ],
        },
        { type: "assistant_message", data: { id: "tracker-product-message" } },
        { type: "done", data: { category_decision: null } },
      ]
      await route.fulfill({
        contentType: "text/event-stream",
        body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      })
    })

    await page.goto(`${baseUrl}/chat`, { waitUntil: "networkidle" })
    const chatInput = page.getByTestId("chat-input")
    await chatInput.fill("Zeig mir ein passendes Produkt")
    await expect(chatInput).toHaveValue("Zeig mir ein passendes Produkt")
    await expect(page.getByTestId("chat-send")).toBeEnabled()
    await page.getByTestId("chat-send").click()
    const trigger = page.getByRole("button", { name: /Test Leave-in.*Produktdetails öffnen/ })
    await expect(trigger).toBeVisible()
    await trigger.click()

    const drawer = page.getByRole("dialog", { name: "Test Leave-in" })
    await expect(drawer).toBeVisible()
    await expect(page.locator(".bottom-sheet-panel")).toHaveCSS("animation-duration", "0.35s")
    await page.getByRole("button", { name: "Schließen" }).click()
    await expect(drawer).toBeHidden()
    await expect(trigger).toBeVisible()
  })

  test("live write boundary rejects direct and forged payloads and reloads the backfill date", async ({
    page,
  }) => {
    test.skip(
      !runLiveTrackerChecks,
      "Set PLAYWRIGHT_RUN_TRACKER_LIVE=1 after applying the tracker migration",
    )
    test.skip(!liveTrackerSchemaReady, "Tracker atomic-autosave migration is not applied")
    test.skip(!admin || !userId || !foreignUsageId, "Live tracker seed was not created")
    const trackerResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/tracker?") && response.request().method() === "GET",
    )
    await openTracker(page)
    const trackerResponse = await trackerResponsePromise
    const body = (await trackerResponse.json()) as { today: string }
    const backfillDate = shiftDate(body.today, -1)
    const tombstoneDate = shiftDate(body.today, -2)

    const directClient = createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { error: signInError } = await directClient.auth.signInWithPassword({ email, password })
    if (signInError) throw signInError
    const directSessionId = "77777777-7777-4777-8777-777777777777"
    const { data: oversizedResult, error: oversizedError } = await directClient.rpc(
      "replace_routine_log",
      {
        p_logged_on: tombstoneDate,
        p_timezone: "Europe/Berlin",
        p_day_type: "wash",
        p_custom_activity_name: null,
        p_products: Array.from({ length: 41 }, (_, index) => ({
          category: "shampoo",
          product_name: `Direct product ${index}`,
          user_product_usage_id: null,
        })),
        p_client_session_id: directSessionId,
        p_client_revision: 1,
      },
    )
    expect(oversizedError).toBeNull()
    expect(oversizedResult).toMatchObject({ ok: false, code: "invalid_products" })

    const { data: deleteResult, error: deleteError } = await directClient.rpc(
      "delete_routine_log",
      {
        p_logged_on: tombstoneDate,
        p_timezone: "Europe/Berlin",
        p_client_session_id: directSessionId,
        p_client_revision: 3,
      },
    )
    if (deleteError) throw deleteError
    expect(deleteResult).toMatchObject({ ok: true, code: "deleted" })
    const { data: staleResult, error: staleError } = await directClient.rpc("replace_routine_log", {
      p_logged_on: tombstoneDate,
      p_timezone: "Europe/Berlin",
      p_day_type: "none",
      p_custom_activity_name: null,
      p_products: [],
      p_client_session_id: directSessionId,
      p_client_revision: 2,
    })
    if (staleError) throw staleError
    expect(staleResult).toMatchObject({ ok: true, code: "stale_revision" })
    expect(staleResult.day.deletedAt).not.toBeNull()

    const forged = await page.evaluate(
      async ({ backfillDate, foreignUsageId }) => {
        const response = await fetch("/api/tracker/log", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            loggedOn: backfillDate,
            timezone: "Europe/Berlin",
            dayType: "wash",
            customActivityName: null,
            products: [
              {
                category: "shampoo",
                productName: "Foreign Shampoo",
                userProductUsageId: foreignUsageId,
              },
            ],
            clientSessionId: crypto.randomUUID(),
            clientRevision: 1,
          }),
        })
        return response.status
      },
      { backfillDate, foreignUsageId },
    )
    expect(forged).toBe(400)

    await selectYesterday(page)
    await openSheet(page)
    const saveResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/tracker/log") &&
        response.request().method() === "PUT" &&
        response.status() === 200,
    )
    await page.getByRole("button", { name: /Keine Haarpflege/ }).click()
    await saveResponse
    await page.getByRole("button", { name: "Fertig" }).click()
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(
      page.getByRole("tablist", { name: "Letzte acht Tage" }).getByRole("tab").nth(6),
    ).toHaveAttribute("aria-label", /Keine Haarpflege/)
    const { data, error } = await admin!
      .from("routine_logs")
      .select("logged_on, day_type, deleted_at")
      .eq("user_id", userId)
      .eq("logged_on", backfillDate)
      .maybeSingle()
    if (error) throw error
    expect(data).toMatchObject({ logged_on: backfillDate, day_type: "none", deleted_at: null })
  })
})
