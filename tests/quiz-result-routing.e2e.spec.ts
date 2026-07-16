import { expect, test, type Page } from "@playwright/test"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for quiz result routing E2E tests",
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

test("completed quiz opens the stored funnel offer on the canonical result route", async ({
  page,
}) => {
  test.setTimeout(120_000)
  const email = `playwright-result-route-${Date.now()}@hairconscierge.test`

  await hideCookieBanner(page)

  try {
    await page.goto("/quiz", { waitUntil: "networkidle" })

    await page.getByRole("button", { name: "Wellig", exact: true }).click()
    await page.getByRole("button", { name: "Mittel", exact: true }).click()
    await page.getByRole("button", { name: "Mittlere Dichte", exact: true }).click()
    await page.getByRole("button", { name: "Mittellang", exact: true }).click()
    await page.getByRole("button", { name: "Leicht uneben", exact: true }).click()
    await page.getByRole("button", { name: "Dehnt sich, bleibt ausgeleiert", exact: true }).click()
    await page.getByRole("button", { name: "Naturhaar", exact: true }).click()
    await page.getByRole("button", { name: "Weiter", exact: true }).click()
    await page.getByRole("button", { name: "Trocken", exact: true }).click()
    await page.getByRole("button", { name: "Nein", exact: true }).click()
    await page.getByRole("button", { name: "Trockenheit", exact: true }).click()
    await page.getByRole("button", { name: "Weiter", exact: true }).click()
    await page.getByRole("button", { name: "Mehr Glanz", exact: true }).click()
    await page.getByRole("button", { name: "Weiter", exact: true }).click()

    await page.getByPlaceholder("Dein Vorname").fill("Playwright Route")
    await page.getByRole("button", { name: /Weiter zum Ergebnis/i }).click()
    await page.getByPlaceholder("name@beispiel.de").fill(email)
    await page.getByRole("button", { name: "Weiter", exact: true }).click()
    await page.getByRole("button", { name: /JA, WEITER ZU MEINEM PLAN/i }).click()

    await expect(page.getByRole("button", { name: /MEIN HAARPROFIL ANSEHEN/i })).toBeVisible({
      timeout: 45_000,
    })

    const { data: lead, error } = await admin
      .from("leads")
      .select("id")
      .eq("email", email)
      .order("created_at", { ascending: false })
      .limit(1)
      .single()

    if (error) throw error

    await page.getByRole("button", { name: /MEIN HAARPROFIL ANSEHEN/i }).click()
    await page.waitForURL((url) => url.pathname === `/result/${lead.id}`, { timeout: 15_000 })
    expect(new URL(page.url()).searchParams.get("entry")).toBe("quiz_completion")

    await expect(page.getByRole("heading", { name: /So begleitet dich Chaarlie/i })).toBeVisible()
    await expect(page.getByText(/Warum Chaarlie ein Abo ist/i)).toHaveCount(0)
    await expect(page.getByRole("button", { name: /Jetzt starten.*34,99.*Quartal/i })).toBeVisible()
  } finally {
    await admin.from("leads").delete().eq("email", email)
  }
})
