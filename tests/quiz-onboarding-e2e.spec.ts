import { test, expect, type Page } from "@playwright/test"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for quiz E2E tests",
  )
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function hideCookieBanner(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "chaarlie_cookie_consent_v1",
      JSON.stringify({ essential: true, analytics: false, marketing: false, ts: Date.now() }),
    )
  })
}

test.describe.serial("Quiz to onboarding E2E", () => {
  const email = `playwright-quiz-${Date.now()}@hairconscierge.test`
  const password = "Playwright123!"
  const fullName = "Playwright Quiz"
  let userId: string | null = null
  let firstLeadId: string | null = null
  let rerunLeadId: string | null = null

  async function fetchLatestLead() {
    const { data, error } = await admin
      .from("leads")
      .select("id, email, status, user_id, quiz_answers")
      .eq("email", email)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) throw error
    return data
  }

  async function fetchHairProfile() {
    if (!userId) return null

    const { data, error } = await admin
      .from("hair_profiles")
      .select(
        "hair_texture, thickness, density, hair_length, cuticle_condition, protein_moisture_balance, scalp_type, scalp_condition, chemical_treatment, concerns, desired_volume, goals, drying_method, routine_preference",
      )
      .eq("user_id", userId)
      .maybeSingle()

    if (error) throw error
    return data
  }

  async function fetchRoutineCategories() {
    if (!userId) return []

    const { data, error } = await admin
      .from("user_product_usage")
      .select("category")
      .eq("user_id", userId)

    if (error) throw error
    return (data ?? []).map((row) => row.category).sort()
  }

  test.beforeAll(async () => {
    const currentPeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    })

    if (error) throw error
    userId = data.user?.id ?? null

    if (!userId) {
      throw new Error("Failed to create E2E user")
    }

    const { error: profileError } = await admin.from("profiles").upsert(
      {
        id: userId,
        email,
        full_name: fullName,
        stripe_customer_id: `cus_quiz_${userId}`,
        subscription_status: "active",
        current_period_end: currentPeriodEnd,
      },
      { onConflict: "id" },
    )

    if (profileError) throw profileError

    const { error: billingError } = await admin.from("billing_subscriptions").upsert(
      {
        user_id: userId,
        provider: "stripe",
        provider_customer_id: `cus_quiz_${userId}`,
        provider_subscription_id: `sub_quiz_${userId}`,
        provider_status: "active",
        entitlement_status: "active",
        interval: "month",
        current_period_end: currentPeriodEnd,
        cancel_at_period_end: false,
        metadata: { ci_seed: "quiz-onboarding-e2e" },
      },
      { onConflict: "provider,provider_subscription_id" },
    )

    if (billingError && billingError.code !== "PGRST205") throw billingError
  })

  test.afterAll(async () => {
    await admin.from("leads").delete().eq("email", email)

    if (!userId) return

    await admin.from("user_product_usage").delete().eq("user_id", userId)
    await admin.from("billing_subscriptions").delete().eq("user_id", userId)
    await admin.from("hair_profiles").delete().eq("user_id", userId)
    await admin.from("profiles").delete().eq("id", userId)
    await admin.auth.admin.deleteUser(userId)
  })

  test("quiz hands off into onboarding and persists linked diagnostics", async ({ page }) => {
    await hideCookieBanner(page)

    let analyzeRequestCount = 0
    await page.route("**/api/quiz/analyze", async (route) => {
      analyzeRequestCount += 1
      await route.fulfill({
        status: 410,
        contentType: "application/json",
        body: JSON.stringify({ error: "Quiz-Analyse nicht mehr unterstuetzt" }),
      })
    })

    await test.step("Complete the quiz and lead capture", async () => {
      await page.goto("/quiz", { waitUntil: "networkidle" })

      await expect(
        page.getByRole("heading", { name: /Welche Haarstruktur haben die meisten deiner Haare/i }),
      ).toBeVisible()

      await page.getByText("Wellig").first().click()
      await expect(page.getByText("2/10")).toBeVisible()

      await page.getByText("Mittel").first().click()
      await expect(page.getByText("3/10")).toBeVisible()

      await page.getByText("Mittlere Dichte").click()
      await expect(page.getByText("4/10")).toBeVisible()

      await page.getByText("Mittellang").click()
      await expect(page.getByText("5/10")).toBeVisible()

      await page.getByText("Leicht uneben").click()
      await expect(page.getByText("6/10")).toBeVisible()

      await page.getByText("Dehnt sich, bleibt ausgeleiert").click()
      await expect(page.getByText("7/10")).toBeVisible()

      await expect(
        page.getByRole("heading", { name: /Sind deine Haare chemisch behandelt/i }),
      ).toBeVisible()

      const naturCard = page.locator(".quiz-card", { hasText: "Naturhaar" })
      const coloredCard = page.locator(".quiz-card", {
        hasText: "Gefärbt / getönt",
      })
      const bleachedCard = page.locator(".quiz-card", {
        hasText: "Blondiert / aufgehellt",
      })

      await naturCard.click()
      await coloredCard.click()
      await bleachedCard.click()

      await page.getByRole("button", { name: /^Weiter$/i }).click()

      // Scalp question (8/10)
      await expect(page.getByText("8/10")).toBeVisible()
      await expect(
        page.getByRole("heading", { name: /Wie schnell fetten deine Ansätze nach/i }),
      ).toBeVisible()
      await page
        .locator(".quiz-card")
        .filter({ has: page.getByText(/^Trocken$/) })
        .click()
      await expect(
        page.getByRole("heading", {
          name: /Hast du zusätzlich Beschwerden wie Schuppen, Juckreiz oder Rötungen/i,
        }),
      ).toBeVisible()
      await page.getByRole("button", { name: "JA" }).click()
      await page.getByText("Trockene Schuppen").click()

      await expect(page.getByText("9/10")).toBeVisible()
      await expect(page.getByText(/Welche Haarprobleme/i)).toBeVisible()
      await page.getByText("Trockenheit").click()
      await page.getByText("Frizz").click()
      await page.getByRole("button", { name: /^Weiter$/i }).click()

      // New step 12: Goals — picked between concerns and lead capture so the
      // analyse step can already use them and the lead row stores them once.
      await expect(page.getByText("Deine Haarziele", { exact: false })).toBeVisible({
        timeout: 10_000,
      })
      await page.getByRole("button", { name: /Mehr Volumen/i }).click()
      await page.getByRole("button", { name: /Mehr Glanz/i }).click()
      await page.getByRole("button", { name: /^Weiter$/i }).click()

      await page.getByPlaceholder("Dein Vorname").fill("Playwright")
      await page.getByRole("button", { name: /Weiter zum Ergebnis/i }).click()

      await page.getByPlaceholder("name@beispiel.de").fill(email)
      await page.getByRole("button", { name: /^Weiter$/i }).click()

      await page.getByRole("button", { name: /JA, WEITER ZU MEINEM PLAN/i }).click()
    })

    await test.step("Verify the lead stays captured before auth without analyze", async () => {
      await expect(page.getByText(/DEIN PROFIL WIRD ERSTELLT/i)).toBeVisible({
        timeout: 45_000,
      })
      await expect(page.getByRole("button", { name: /MEIN HAARPROFIL ANSEHEN/i })).toBeVisible({
        timeout: 45_000,
      })
      await expect(page.getByText(/Analyse fertig/i)).toHaveCount(0)

      await expect
        .poll(
          async () => {
            const lead = await fetchLatestLead()
            return lead?.status ?? null
          },
          { timeout: 30_000 },
        )
        .toBe("captured")

      const latestLead = await fetchLatestLead()
      expect(latestLead?.id).toBeTruthy()
      await page.getByRole("button", { name: /MEIN HAARPROFIL ANSEHEN/i }).click()
      await page.waitForURL((url) => url.pathname === `/result/${latestLead!.id}`, {
        timeout: 15_000,
      })
      await expect(page.getByRole("heading", { name: /So begleitet dich Chaarlie/i })).toBeVisible()
      await expect(page.getByText(/Warum Chaarlie ein Abo ist/i)).toHaveCount(0)
      await expect(
        page.getByRole("button", { name: /Jetzt starten.*34,99.*Quartal/i }),
      ).toBeVisible()
      await expect(page.getByText(/ERGEBNIS TEILEN/i)).toHaveCount(0)
      expect(analyzeRequestCount).toBe(0)
    })

    await test.step("Authenticate via direct auth shortcut with the latest lead", async () => {
      // The result step now contains the merged offer page and inline Stripe checkout.
      // This E2E skips payment by authenticating directly with the latest lead id,
      // preserving coverage for quiz-to-profile linking without exercising Stripe.
      const latestLead = await fetchLatestLead()
      expect(latestLead?.id).toBeTruthy()
      await page.goto(`/auth?next=/onboarding&lead=${latestLead!.id}`, {
        waitUntil: "networkidle",
      })

      // Authenticate on the login form
      await page.getByPlaceholder("E-Mail-Adresse").fill(email)
      await expect(page.getByPlaceholder("E-Mail-Adresse")).toHaveValue(email)
      await page.getByPlaceholder("Passwort").fill(password)
      await expect(page.getByPlaceholder("Passwort")).toHaveValue(password)
      const loginButton = page.getByRole("button", { name: /^Anmelden$/ })
      await expect(loginButton).toBeEnabled()
      await loginButton.click()

      // Should land on onboarding (single-page flow)
      await page.waitForURL(/\/onboarding(\?.*)?$/, {
        timeout: 30_000,
        waitUntil: "domcontentloaded",
      })
    })

    await test.step("Complete onboarding flow through goals and verify database state", async () => {
      // Welcome screen
      await expect(page.getByRole("button", { name: /LOS GEHT/i })).toBeVisible({ timeout: 10_000 })
      await page.getByRole("button", { name: /LOS GEHT/i }).click()

      // Products basics: select Conditioner
      await expect(page.getByText("Deine Basis-Produkte", { exact: false })).toBeVisible({
        timeout: 10_000,
      })
      await page.getByRole("button", { name: /^Conditioner$/i }).click()
      await page.getByRole("button", { name: /^Weiter$/i }).click()

      // Products extras: skip
      await expect(page.getByText("Weitere Produkte", { exact: false })).toBeVisible({
        timeout: 10_000,
      })
      await page.getByRole("button", { name: /Nichts davon/i }).click()

      // Product drilldown: conditioner — select a frequency
      await expect(page.getByText("Dein Conditioner", { exact: false })).toBeVisible({
        timeout: 10_000,
      })
      await page.getByRole("button", { name: /1x\/Woche/i }).click()
      await page.getByRole("button", { name: /^Weiter$/i }).click()

      // Heat tools: skip (no heat tools)
      await expect(page.getByText("Welche Hitzetools nutzt du?", { exact: false })).toBeVisible({
        timeout: 10_000,
      })
      await page.getByRole("button", { name: /Nichts davon/i }).click()

      // Interstitial: continue
      await expect(page.getByText("Fast geschafft!", { exact: false })).toBeVisible({
        timeout: 10_000,
      })
      await page.getByRole("button", { name: /^Weiter$/i }).click()

      // Towel material: no towel skips technique, then back up and keep the normal Frottee path covered.
      await expect(page.getByText("Womit trocknest du dein Haar?", { exact: false })).toBeVisible({
        timeout: 10_000,
      })
      await page
        .getByRole("button", {
          name: /Kein Handtuch: Ich lasse meine Haare tropfnass trocknen/i,
        })
        .click()

      await expect(
        page.getByText("Wie trocknest du dein Haar hauptsächlich?", { exact: false }),
      ).toBeVisible({
        timeout: 10_000,
      })
      await expect(page.getByText("Wie trocknest du?", { exact: false })).toHaveCount(0)
      await page.getByRole("button", { name: /^Zurück$/i }).click()

      await expect(page.getByText("Womit trocknest du dein Haar?", { exact: false })).toBeVisible({
        timeout: 10_000,
      })
      await page.getByRole("button", { name: /Frottee-Handtuch/i }).click()

      // Towel technique: select Rubbeln (single-select, auto-advances)
      await expect(page.getByText("Wie trocknest du?", { exact: false })).toBeVisible({
        timeout: 10_000,
      })
      await page.getByRole("button", { name: /^Rubbeln$/i }).click()

      // Drying method: select Lufttrocknen (single-select, auto-advances)
      await expect(
        page.getByText("Wie trocknest du dein Haar hauptsächlich?", { exact: false }),
      ).toBeVisible({
        timeout: 10_000,
      })
      await page.getByRole("button", { name: /Lufttrocknen/i }).click()

      // Brush type: select Grobzinkiger Kamm (single-select, auto-advances)
      await expect(page.getByText("Welche Bürste", { exact: false })).toBeVisible({
        timeout: 10_000,
      })
      await page.getByRole("button", { name: /Grobzinkiger Kamm/i }).click()

      // Night protection: skip — this is now the last data step; "Nichts davon"
      // both saves an empty selection AND flips onboarding_completed=true.
      await expect(
        page.getByText("Wie schützt du dein Haar nachts?", { exact: false }),
      ).toBeVisible({ timeout: 10_000 })
      await page.getByRole("button", { name: /Nichts davon/i }).click()

      // Celebration popup
      await expect(page.getByRole("button", { name: /ZUM CHAT/i })).toBeVisible({ timeout: 10_000 })
      await page.getByRole("button", { name: /ZUM CHAT/i }).click()

      // Should land on chat
      await page.waitForURL("**/chat", { timeout: 30_000 })

      // Verify lead is linked
      await expect
        .poll(
          async () => {
            const lead = await fetchLatestLead()
            return lead?.status ?? null
          },
          { timeout: 30_000 },
        )
        .toBe("linked")

      await expect
        .poll(
          async () => {
            const lead = await fetchLatestLead()
            return lead?.user_id ?? null
          },
          { timeout: 30_000 },
        )
        .toBe(userId)

      await expect
        .poll(
          async () => {
            const lead = await fetchLatestLead()
            return lead?.id ?? null
          },
          { timeout: 30_000 },
        )
        .not.toBeNull()

      // Verify hair profile data
      const latestLead = await fetchLatestLead()
      expect(latestLead?.quiz_answers).toMatchObject({
        density: "medium",
        hair_length: "medium",
      })

      await expect
        .poll(
          async () => {
            const profile = await fetchHairProfile()
            return profile?.goals?.includes("volume") ?? false
          },
          { timeout: 30_000 },
        )
        .toBe(true)

      const hairProfile = await fetchHairProfile()

      expect(hairProfile).toMatchObject({
        hair_texture: "wavy",
        thickness: "normal",
        density: "medium",
        hair_length: "medium",
        cuticle_condition: "slightly_rough",
        protein_moisture_balance: "stretches_stays",
        scalp_type: "dry",
        scalp_condition: "dry_flakes",
        desired_volume: null,
      })
      expect(hairProfile?.chemical_treatment).toEqual(["colored", "bleached"])
      expect(hairProfile?.concerns).toEqual(["dryness", "frizz"])
      expect(hairProfile?.goals).toEqual(expect.arrayContaining(["shine", "volume"]))
      expect(hairProfile?.drying_method).toBe("air_dry")
      expect(await fetchRoutineCategories()).toEqual(["conditioner", "shampoo"])

      firstLeadId = (await fetchLatestLead())?.id ?? null
      expect(firstLeadId).not.toBeNull()
    })
  })

  test("existing account can retake the quiz and overwrite diagnostic profile fields", async ({
    page,
  }) => {
    await hideCookieBanner(page)

    await test.step("Confirm the first quiz run is linked", async () => {
      const initialProfile = await fetchHairProfile()

      expect(initialProfile).toMatchObject({
        hair_texture: "wavy",
        thickness: "normal",
        density: "medium",
        hair_length: "medium",
        cuticle_condition: "slightly_rough",
        protein_moisture_balance: "stretches_stays",
        scalp_type: "dry",
        scalp_condition: "dry_flakes",
        desired_volume: null,
      })
      expect(initialProfile?.chemical_treatment).toEqual(["colored", "bleached"])
      expect(initialProfile?.concerns).toEqual(["dryness", "frizz"])
      expect(initialProfile?.goals).toEqual(expect.arrayContaining(["shine", "volume"]))
      expect(initialProfile?.drying_method).toBe("air_dry")
      expect(await fetchRoutineCategories()).toEqual(["conditioner", "shampoo"])
      expect(firstLeadId).not.toBeNull()
    })

    await test.step("Retake the quiz with different diagnostics", async () => {
      await page.goto("/quiz", { waitUntil: "networkidle" })

      await expect(
        page.getByRole("heading", { name: /Welche Haarstruktur haben die meisten deiner Haare/i }),
      ).toBeVisible()
      await page.getByText("Glatt").first().click()
      await expect(page.getByText("2/10")).toBeVisible()
      await page.getByRole("button", { name: /Fein Kaum spürbar/i }).click()
      await expect(page.getByText("3/10")).toBeVisible()
      await page.getByText("Wenig Haare").click()
      await expect(page.getByText("4/10")).toBeVisible()
      await page.getByText("Sehr kurz").click()
      await expect(page.getByText("5/10")).toBeVisible()
      await page.getByText("Glatt wie Glas").click()
      await expect(page.getByText("6/10")).toBeVisible()
      await page.getByText("Reißt sofort").click()

      await expect(
        page.getByRole("heading", { name: /Sind deine Haare chemisch behandelt/i }),
      ).toBeVisible()

      const naturCard = page.locator(".quiz-card", { hasText: "Naturhaar" })
      const coloredCard = page.locator(".quiz-card", {
        hasText: "Gefärbt / getönt",
      })

      await coloredCard.click()
      await naturCard.click()

      await page.getByRole("button", { name: /^Weiter$/i }).click()
      await expect(page.getByText("8/10")).toBeVisible()
      await expect(
        page.getByRole("heading", { name: /Wie schnell fetten deine Ansätze nach/i }),
      ).toBeVisible()
      await page
        .locator(".quiz-card")
        .filter({ has: page.getByText(/^Fettig$/) })
        .click()
      await page.getByRole("button", { name: "NEIN" }).click()
      await expect(page.getByText("9/10")).toBeVisible()
      await page.getByRole("button", { name: /Etwas anderes/i }).click()
      await page.getByLabel("Eigene Notiz").fill("verklebt schnell")
      await page.getByRole("button", { name: /^Weiter$/i }).click()

      // New step 12: Goals — sits between concerns and lead capture. Picks
      // here are persisted to leads.quiz_answers but the clobber guard in
      // linkQuizToProfile keeps the existing user's hair_profiles.goals.
      await expect(page.getByText("Deine Haarziele", { exact: false })).toBeVisible({
        timeout: 10_000,
      })
      await page.getByRole("button", { name: /Mehr Glanz/i }).click()
      await page.getByRole("button", { name: /^Weiter$/i }).click()

      await page.getByPlaceholder("Dein Vorname").fill("Playwright Return")
      await page.getByRole("button", { name: /Weiter zum Ergebnis/i }).click()
      await page.getByPlaceholder("name@beispiel.de").fill(email)
      await page.getByRole("button", { name: /^Weiter$/i }).click()
      await page.getByRole("button", { name: /JA, WEITER ZU MEINEM PLAN/i }).click()

      await expect(page.getByText(/DEIN PROFIL WIRD ERSTELLT/i)).toBeVisible({
        timeout: 45_000,
      })
      await expect(page.getByRole("button", { name: /MEIN HAARPROFIL ANSEHEN/i })).toBeVisible({
        timeout: 45_000,
      })
      const latestLead = await fetchLatestLead()
      expect(latestLead?.id).toBeTruthy()
      await page.getByRole("button", { name: /MEIN HAARPROFIL ANSEHEN/i }).click()
      await page.waitForURL((url) => url.pathname === `/result/${latestLead!.id}`, {
        timeout: 15_000,
      })
      await expect(page.getByRole("heading", { name: /So begleitet dich Chaarlie/i })).toBeVisible()
      await expect(page.getByText(/Warum Chaarlie ein Abo ist/i)).toHaveCount(0)
      await expect(
        page.getByRole("button", { name: /Jetzt starten.*34,99.*Quartal/i }),
      ).toBeVisible()
      await expect(page.getByText(/ERGEBNIS TEILEN/i)).toHaveCount(0)
    })

    await test.step("Log back in via direct auth shortcut and relink the new lead", async () => {
      // The merged result offer page owns the Stripe handoff. This test keeps
      // the non-Stripe relink path by authenticating directly with the latest lead id.
      const latestLead = await fetchLatestLead()
      expect(latestLead?.id).toBeTruthy()
      await page.goto(`/auth?next=/onboarding&lead=${latestLead!.id}`, {
        waitUntil: "networkidle",
      })

      // Log in with existing credentials
      await page.getByPlaceholder("E-Mail-Adresse").fill(email)
      await expect(page.getByPlaceholder("E-Mail-Adresse")).toHaveValue(email)
      await page.getByPlaceholder("Passwort").fill(password)
      await expect(page.getByPlaceholder("Passwort")).toHaveValue(password)
      const loginButton = page.getByRole("button", { name: /^Anmelden$/ })
      await expect(loginButton).toBeEnabled()
      await loginButton.click()

      // Returning user with completed onboarding: lead is linked during the
      // /onboarding server-side load, then redirect to /chat since onboarding_completed is true
      await page.waitForURL("**/chat", {
        timeout: 30_000,
        waitUntil: "domcontentloaded",
      })
    })

    await test.step("Verify the latest lead links and diagnostics are overwritten", async () => {
      await expect
        .poll(
          async () => {
            const lead = await fetchLatestLead()
            return lead?.status ?? null
          },
          { timeout: 30_000 },
        )
        .toBe("linked")

      await expect
        .poll(
          async () => {
            const lead = await fetchLatestLead()
            return lead?.id ?? null
          },
          { timeout: 30_000 },
        )
        .not.toBe(firstLeadId)

      await expect
        .poll(
          async () => {
            const lead = await fetchLatestLead()
            return lead?.user_id ?? null
          },
          { timeout: 30_000 },
        )
        .toBe(userId)

      rerunLeadId = (await fetchLatestLead())?.id ?? null
      expect(rerunLeadId).not.toBeNull()
      expect(rerunLeadId).not.toBe(firstLeadId)

      const latestLead = await fetchLatestLead()
      expect(latestLead?.quiz_answers).toMatchObject({
        density: "low",
        hair_length: "very_short",
        concerns: [],
        concerns_other_text: "verklebt schnell",
      })

      // Diagnostic fields should be overwritten with the new quiz answers
      await expect
        .poll(
          async () => {
            const profile = await fetchHairProfile()
            return profile?.hair_texture ?? null
          },
          { timeout: 30_000 },
        )
        .toBe("straight")

      const hairProfile = await fetchHairProfile()

      expect(hairProfile).toMatchObject({
        hair_texture: "straight",
        thickness: "fine",
        density: "low",
        hair_length: "very_short",
        cuticle_condition: "smooth",
        protein_moisture_balance: "snaps",
        scalp_type: "oily",
        scalp_condition: null,
        // Goals and onboarding data from first run remain (user hasn't re-submitted onboarding)
        desired_volume: null,
      })
      expect(hairProfile?.chemical_treatment).toEqual(["natural"])
      expect(hairProfile?.concerns).toEqual([])
      // Goals stay from first run since user didn't re-save goals page
      expect(hairProfile?.goals).toEqual(expect.arrayContaining(["shine", "volume"]))
      expect(hairProfile?.drying_method).toBe("air_dry")
      expect(await fetchRoutineCategories()).toEqual(["conditioner", "shampoo"])
    })
  })
})
