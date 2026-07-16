import { z } from "zod"

import type { RoutineArtifactData } from "@/lib/routines/types"
import { normalizeProductFrequency, PRODUCT_FREQUENCY_METADATA } from "@/lib/vocabulary/frequencies"

import { computeObservedCadences, countWashesInWeek, daysSinceLastWash } from "./aggregation"
import { computeNudges, type TrackerNudge } from "./nudges"
import { evaluateTrustGate, type TrustGateStatus } from "./trust-gate"
import {
  TRACKER_CATEGORY_LABELS_DE,
  TRACKER_DAY_TYPES,
  type TrackerDayType,
  type TrackerLogDay,
} from "./types"

export interface ApiResult {
  status: number
  body: Record<string, unknown>
}

type AuthUser = { id: string; email?: string | null }

type SupabaseishClient = {
  auth: { getUser(): Promise<{ data: { user: AuthUser | null } }> }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<any>
  // The real Supabase fluent builder is intentionally structural here so API
  // tests can inject a small fake, mirroring the routine API handler factory.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any
}

type SupabaseReadError = { message?: string } | null

export interface TrackerApiDeps {
  createAuthClient(): Promise<SupabaseishClient>
  createAdminClient(): SupabaseishClient
  hasCurrentAppAccess(
    client: SupabaseishClient,
    lookup: { userId: string; email?: string | null },
  ): Promise<boolean>
  loadRoutineArtifactData(args: {
    userId: string
  }): Promise<Pick<RoutineArtifactData, "runtime" | "usageRows">>
  now?: () => Date
}

const WINDOW_DAYS = 28
const BACKFILL_DAYS = 7
const DISMISS_COOLDOWN_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

const putLogSchema = z
  .object({
    loggedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timezone: z.string().min(1).max(64),
    dayType: z.enum(TRACKER_DAY_TYPES),
    customActivityName: z.string().max(60).nullable().optional(),
    clientSessionId: z.string().uuid(),
    clientRevision: z.number().int().positive(),
    products: z
      .array(
        z.object({
          category: z.string().min(1),
          productName: z.string().max(200).nullable().optional(),
          userProductUsageId: z.string().uuid().nullable().optional(),
        }),
      )
      .max(40),
  })
  .superRefine((value, ctx) => {
    const customName = value.customActivityName?.trim() ?? ""
    if (value.dayType === "custom" && (customName.length < 1 || customName.length > 60)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Ungültige eigene Aktivität." })
    }
    if (value.dayType !== "custom" && customName.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Eigene Aktivität nur für custom." })
    }
    if (value.dayType === "none" && value.products.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Nichts darf keine Produkte enthalten.",
      })
    }
  })

const deleteLogSchema = z.object({
  loggedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().min(1).max(64),
  clientSessionId: z.string().uuid(),
  clientRevision: z.number().int().positive(),
})

const dismissSchema = z.object({
  category: z.string().min(1),
  direction: z.enum(["increase", "decrease"]),
})

function json(body: Record<string, unknown>, status = 200): ApiResult {
  return { status, body }
}

function hasReadError(error: SupabaseReadError | undefined): boolean {
  return Boolean(error)
}

function rpcResult(
  data: unknown,
  error: SupabaseReadError | undefined,
  fallbackError: string,
): ApiResult {
  if (error || !data || typeof data !== "object") return json({ error: fallbackError }, 500)
  const result = data as Record<string, unknown>
  if (result.ok === true) return json(result)
  if (result.code === "not_authenticated") return json({ error: "Nicht angemeldet." }, 401)
  if (result.code === "forbidden") return json({ error: "Nicht erlaubt." }, 403)
  if (
    result.code === "invalid_date" ||
    result.code === "invalid_activity" ||
    result.code === "invalid_products" ||
    result.code === "unknown_category" ||
    result.code === "foreign_product"
  ) {
    return json(
      { error: typeof result.error === "string" ? result.error : "Ungültige Eintrag-Daten." },
      400,
    )
  }
  return json({ error: fallbackError }, 500)
}

export function todayInTimezone(timezone: string, now: Date): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((part) => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}`
}

function isValidCalendarDate(dateIso: string): boolean {
  const parsed = new Date(`${dateIso}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === dateIso
}

function shiftDate(dateIso: string, days: number): string {
  return new Date(Date.parse(`${dateIso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

function currentWeekDates(today: string): string[] {
  const date = new Date(`${today}T00:00:00Z`)
  const weekday = (date.getUTCDay() + 6) % 7
  const monday = shiftDate(today, -weekday)
  return Array.from({ length: 7 }, (_, index) => shiftDate(monday, index))
}

async function requireUser(client: SupabaseishClient): Promise<ApiResult | AuthUser> {
  const {
    data: { user },
  } = await client.auth.getUser()
  if (!user) return json({ error: "Nicht angemeldet." }, 401)
  return user
}

export function createTrackerApiHandlers(deps: TrackerApiDeps) {
  const now = deps.now ?? (() => new Date())

  async function requireCurrentAccess(user: AuthUser): Promise<ApiResult | SupabaseishClient> {
    const admin = deps.createAdminClient()
    try {
      if (!(await deps.hasCurrentAppAccess(admin, { userId: user.id, email: user.email }))) {
        return json({ error: "Nicht erlaubt." }, 403)
      }
    } catch {
      return json({ error: "Zugriff konnte nicht geprüft werden." }, 503)
    }
    return admin
  }

  async function loadDays(
    client: SupabaseishClient,
    userId: string,
    start: string,
    end: string,
  ): Promise<TrackerLogDay[]> {
    const { data: logs, error: logsError } = await client
      .from("routine_logs")
      .select("id, logged_on, day_type, custom_activity_name")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .gte("logged_on", start)
      .lte("logged_on", end)
    if (hasReadError(logsError)) {
      throw new Error("load tracker logs failed")
    }
    const logRows = (logs ?? []) as Array<{
      id: string
      logged_on: string
      day_type: TrackerDayType
      custom_activity_name: string | null
    }>
    if (logRows.length === 0) return []

    const { data: products, error: productsError } = await client
      .from("routine_log_products")
      .select("routine_log_id, category, product_name, user_product_usage_id")
      .in(
        "routine_log_id",
        logRows.map((log) => log.id),
      )
    if (hasReadError(productsError)) {
      throw new Error("load tracker log products failed")
    }
    const productRows = (products ?? []) as Array<{
      routine_log_id: string
      category: string
      product_name: string | null
      user_product_usage_id: string | null
    }>
    const logIds = new Set(logRows.map((log) => log.id))
    const byLog = new Map<string, TrackerLogDay["products"]>()
    for (const product of productRows) {
      if (!logIds.has(product.routine_log_id)) continue
      if (!byLog.has(product.routine_log_id)) byLog.set(product.routine_log_id, [])
      byLog.get(product.routine_log_id)!.push({
        category: product.category,
        productName: product.product_name,
        userProductUsageId: product.user_product_usage_id,
      })
    }

    return logRows
      .map((log) => ({
        loggedOn: log.logged_on,
        dayType: log.day_type,
        customActivityName: log.custom_activity_name,
        products: byLog.get(log.id) ?? [],
      }))
      .sort((left, right) => left.loggedOn.localeCompare(right.loggedOn))
  }

  return {
    async getTracker(params: { tz: string }): Promise<ApiResult> {
      const authClient = await deps.createAuthClient()
      const user = await requireUser(authClient)
      if ("status" in user) return user
      const client = await requireCurrentAccess(user)
      if ("status" in client) return client

      let today: string
      try {
        today = todayInTimezone(params.tz, now())
      } catch {
        return json({ error: "Ungültige Zeitzone." }, 400)
      }
      const windowStart = shiftDate(today, -(WINDOW_DAYS - 1))
      let days: TrackerLogDay[]
      try {
        days = await loadDays(client, user.id, windowStart, today)
      } catch {
        return json({ error: "Tagebuch konnte nicht geladen werden." }, 500)
      }

      const [shelfResult, historyResult, artifact] = await Promise.all([
        client
          .from("user_product_usage")
          .select("id, category, product_name, frequency_range")
          .eq("user_id", user.id),
        client
          .from("routine_logs")
          .select("logged_on, day_type")
          .eq("user_id", user.id)
          .is("deleted_at", null),
        deps.loadRoutineArtifactData({ userId: user.id }),
      ])
      const { data: shelfRows, error: shelfError } = shelfResult
      if (hasReadError(shelfError)) {
        return json({ error: "Tagebuch konnte nicht geladen werden." }, 500)
      }
      const typedShelfRows = (shelfRows ?? []) as Array<{
        id: string
        category: string
        product_name: string | null
        frequency_range: string | null
      }>
      const imageUrlByUsageId = new Map(
        artifact.usageRows.map((usageRow) => [
          usageRow.id,
          Array.isArray(usageRow.product)
            ? (usageRow.product[0]?.image_url ?? null)
            : (usageRow.product?.image_url ?? null),
        ]),
      )
      const shelf = typedShelfRows.map((row) => ({
        usageId: row.id,
        category: row.category,
        productName: row.product_name,
        imageUrl: imageUrlByUsageId.get(row.id) ?? null,
      }))

      const { data: allLogDates, error: allLogDatesError } = historyResult
      if (hasReadError(allLogDatesError)) {
        return json({ error: "Tagebuch konnte nicht geladen werden." }, 500)
      }
      const gate: TrustGateStatus = evaluateTrustGate(
        ((allLogDates ?? []) as Array<{ logged_on: string; day_type: TrackerDayType }>)
          .filter((row) => row.day_type !== "custom")
          .map((row) => row.logged_on),
        today,
      )
      const rhythmStart = shiftDate(today, -62)
      const rhythmHistory = (
        (allLogDates ?? []) as Array<{
          logged_on: string
          day_type: TrackerDayType
        }>
      )
        .filter(
          (row) =>
            row.day_type !== "custom" && row.logged_on >= rhythmStart && row.logged_on <= today,
        )
        .sort((left, right) => left.logged_on.localeCompare(right.logged_on))
        .map((row) => ({ loggedOn: row.logged_on, dayType: row.day_type }))

      let nudges: TrackerNudge[] = []
      const targetRows = artifact.runtime.careBalance.rows.map((row) => ({
        category: row.category,
        cadencePolicy: row.cadencePolicy,
        frequencyTarget: row.frequencyTarget,
      }))
      const shampooTarget = targetRows.find((row) => row.category === "shampoo")
      if (gate.unlocked) {
        const shampooShelfRow = typedShelfRows.find((row) => row.category === "shampoo")
        const selfReportedFrequency = normalizeProductFrequency(
          shampooShelfRow?.frequency_range ?? null,
        )
        const selfReportedWashCadence = selfReportedFrequency
          ? PRODUCT_FREQUENCY_METADATA[selfReportedFrequency].midpointPerWeek
          : null
        const cadences = computeObservedCadences(days, selfReportedWashCadence, targetRows)
        const { data: dismissedRows, error: dismissalsError } = await client
          .from("tracker_nudge_dismissals")
          .select("category, direction, reappear_at")
          .eq("user_id", user.id)
        if (hasReadError(dismissalsError)) {
          return json({ error: "Tagebuch konnte nicht geladen werden." }, 500)
        }
        const nowIso = now().toISOString()
        const activeDismissals = (
          (dismissedRows ?? []) as Array<{
            category: string
            direction: string
            reappear_at: string
          }>
        ).filter((dismissal) => dismissal.reappear_at > nowIso)
        nudges = computeNudges({
          cadences,
          targets: targetRows,
          dismissed: activeDismissals,
        })
      }

      return json({
        days,
        gate,
        nudges,
        rhythm: {
          washesThisWeek: countWashesInWeek(days, currentWeekDates(today)),
          targetWashesPerWeek: shampooTarget?.frequencyTarget
            ? PRODUCT_FREQUENCY_METADATA[shampooTarget.frequencyTarget.preferredFrequency]
                .midpointPerWeek
            : null,
          frequencyTarget: shampooTarget?.frequencyTarget ?? null,
        },
        rhythmHistory,
        daysSinceLastWash: daysSinceLastWash(days, today),
        shelf,
        today,
      })
    },

    async putLog(payload: unknown): Promise<ApiResult> {
      const parsed = putLogSchema.safeParse(payload)
      if (!parsed.success) return json({ error: "Ungültige Eintrag-Daten." }, 400)

      const unknownCategory = parsed.data.products.find(
        (product) => !(product.category in TRACKER_CATEGORY_LABELS_DE),
      )
      if (unknownCategory) return json({ error: "Unbekannte Kategorie." }, 400)

      try {
        new Intl.DateTimeFormat("en-CA", { timeZone: parsed.data.timezone })
      } catch {
        return json({ error: "Ungültige Zeitzone." }, 400)
      }
      if (!isValidCalendarDate(parsed.data.loggedOn)) {
        return json({ error: "Ungültiges Datum." }, 400)
      }

      const authClient = await deps.createAuthClient()
      const user = await requireUser(authClient)
      if ("status" in user) return user
      const client = await requireCurrentAccess(user)
      if ("status" in client) return client

      const today = todayInTimezone(parsed.data.timezone, now())
      const earliest = shiftDate(today, -BACKFILL_DAYS)
      if (parsed.data.loggedOn > today) {
        return json({ error: "Zukünftige Tage können nicht geloggt werden." }, 400)
      }
      if (parsed.data.loggedOn < earliest) {
        return json({ error: "Nur die letzten 7 Tage können nachgetragen werden." }, 400)
      }

      const { data, error } = await client.rpc("replace_routine_log", {
        p_user_id: user.id,
        p_logged_on: parsed.data.loggedOn,
        p_timezone: parsed.data.timezone,
        p_day_type: parsed.data.dayType,
        p_custom_activity_name: parsed.data.customActivityName?.trim() || null,
        p_products: parsed.data.products.map((product) => ({
          category: product.category,
          product_name: product.productName ?? null,
          user_product_usage_id: product.userProductUsageId ?? null,
        })),
        p_client_session_id: parsed.data.clientSessionId,
        p_client_revision: parsed.data.clientRevision,
      })
      return rpcResult(data, error, "Eintrag konnte nicht gespeichert werden.")
    },

    async deleteLog(payload: unknown): Promise<ApiResult> {
      const parsed = deleteLogSchema.safeParse(payload)
      if (!parsed.success) return json({ error: "Ungültige Eintrag-Daten." }, 400)
      try {
        new Intl.DateTimeFormat("en-CA", { timeZone: parsed.data.timezone })
      } catch {
        return json({ error: "Ungültige Zeitzone." }, 400)
      }
      if (!isValidCalendarDate(parsed.data.loggedOn))
        return json({ error: "Ungültiges Datum." }, 400)
      const authClient = await deps.createAuthClient()
      const user = await requireUser(authClient)
      if ("status" in user) return user
      const client = await requireCurrentAccess(user)
      if ("status" in client) return client
      const today = todayInTimezone(parsed.data.timezone, now())
      const earliest = shiftDate(today, -BACKFILL_DAYS)
      if (parsed.data.loggedOn > today || parsed.data.loggedOn < earliest) {
        return json({ error: "Nur die letzten 7 Tage können bearbeitet werden." }, 400)
      }
      const { data, error } = await client.rpc("delete_routine_log", {
        p_user_id: user.id,
        p_logged_on: parsed.data.loggedOn,
        p_timezone: parsed.data.timezone,
        p_client_session_id: parsed.data.clientSessionId,
        p_client_revision: parsed.data.clientRevision,
      })
      return rpcResult(data, error, "Eintrag konnte nicht gelöscht werden.")
    },

    async dismissNudge(payload: unknown): Promise<ApiResult> {
      const parsed = dismissSchema.safeParse(payload)
      if (!parsed.success) return json({ error: "Ungültige Daten." }, 400)

      const authClient = await deps.createAuthClient()
      const user = await requireUser(authClient)
      if ("status" in user) return user
      const client = await requireCurrentAccess(user)
      if ("status" in client) return client

      const nowDate = now()
      const { error } = await client.from("tracker_nudge_dismissals").upsert(
        {
          user_id: user.id,
          category: parsed.data.category,
          direction: parsed.data.direction,
          dismissed_at: nowDate.toISOString(),
          reappear_at: new Date(nowDate.getTime() + DISMISS_COOLDOWN_DAYS * DAY_MS).toISOString(),
        },
        { onConflict: "user_id,category,direction" },
      )
      if (error) return json({ error: "Konnte nicht gespeichert werden." }, 500)
      return json({ ok: true })
    },
  }
}
