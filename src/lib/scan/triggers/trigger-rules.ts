import type { PersonalPlanCategory } from "@/lib/personal-plan/products/contracts"
import type { PremiumFeatureId } from "@/lib/premium-sheet/context"
import type { ScanVerdict } from "@/lib/scan/types"

/**
 * Deterministic trigger rules for the freemium scan surface (T10, PR2). The 8-trigger
 * catalog is binding verbatim from `.superpowers/sdd/plan/task-10-brief.md` — this module
 * is a pure function of explicit inputs, no I/O, so the whole rule set (including the
 * fatigue rule and the unknown-never-pitches ruling) is unit-testable without a DOM, a
 * network, or a scanner.
 *
 * Two classes, exactly as ruled (journey sign-off, binding):
 * - `user_initiated` gates are always available and never fatigue-limited.
 * - `proactive` pitches are governed by the fatigue rule: at most ONE fires per app
 *   session, across all four combined — see `resolveProactiveScanTrigger`.
 */

export const SCAN_TRIGGER_IDS = [
  "erster_passt_nicht",
  "zwei_scans_gleiche_kategorie",
  "merken_tap",
  "unbekanntes_produkt",
  "kategorien_luecke",
  "passt_gut_moment",
  "frust_serie",
  "wiederkehrer",
] as const

export type ScanTriggerId = (typeof SCAN_TRIGGER_IDS)[number]

export type ScanTriggerClass = "user_initiated" | "proactive"

export const SCAN_TRIGGER_CLASS: Record<ScanTriggerId, ScanTriggerClass> = {
  erster_passt_nicht: "user_initiated",
  zwei_scans_gleiche_kategorie: "user_initiated",
  merken_tap: "user_initiated",
  unbekanntes_produkt: "user_initiated",
  kategorien_luecke: "proactive",
  passt_gut_moment: "proactive",
  frust_serie: "proactive",
  wiederkehrer: "proactive",
}

export type ScanProactiveTriggerId =
  | "kategorien_luecke"
  | "passt_gut_moment"
  | "frust_serie"
  | "wiederkehrer"

export const SCAN_PROACTIVE_TRIGGER_IDS: readonly ScanProactiveTriggerId[] = [
  "kategorien_luecke",
  "passt_gut_moment",
  "frust_serie",
  "wiederkehrer",
]

// --- flag + tier gating ---------------------------------------------------------

export type ScanTriggerGate = {
  freemiumScannerFirstEnabled: boolean
  tier: "free" | "premium"
}

/**
 * Every trigger evaluates only for a free-tier user with the flag on (binding
 * constraint) — premium and flag-off must see zero trigger surfaces and zero behavior
 * change, same byte-identity discipline as T2/T4.
 *
 * Production wiring (`scan-flow.tsx`) passes `freemiumScannerFirstEnabled: true`
 * unconditionally rather than re-reading the flag client-side: `tier` can only ever be
 * `"free"` when the server-side flag was already on (`navigation-access.ts` only ever
 * assigns `tier: "free"` behind `isFreemiumScannerFirstEnabled()`), so gating on the
 * server-verified tier signal alone is equivalent — mirrors T9's discipline of deriving
 * every free-tier decision from a server-verified signal, never a fresh client guess. The
 * explicit flag field stays on this type so the rule itself is independently testable.
 */
export function scanTriggersEnabled(gate: ScanTriggerGate): boolean {
  return gate.freemiumScannerFirstEnabled && gate.tier === "free"
}

// --- sheet-opening contract ------------------------------------------------------

/**
 * Controller ruling on the feature mapping (binding, surfaced to Nick separately, not
 * re-litigated here): scan-context gates (1, 2) → `empfehlungen`; Merken (3) →
 * `merkliste`; the 3 sheet-opening proactive pitches (6-8) → `routine`. Deliberately has
 * no entry for `kategorien_luecke` (links into the gated Routine page instead of opening
 * the sheet — journey ruling) or `unbekanntes_produkt` (never pitches at all).
 *
 * Fix round 1 (F6, adjudicated — keep as-is, do not rewire): `erster_passt_nicht` and
 * `merken_tap` below are the canonical rule models for triggers 1 and 3, but their actual
 * surfaces shipped in T9 as the reveal CTA and the Merken lock, both opening the sheet with
 * `source: "scan:verdict"` (`scan-flow.tsx`'s `MERKLISTE_GATE`/`EMPFEHLUNGEN_GATE`), not
 * `trigger:erster-passt-nicht` / `trigger:merken-tap`. That is intentional: T9's sources are
 * not renamed, and no production caller uses these two registry entries — they exist so the
 * mapping itself stays independently testable.
 */
const SCAN_TRIGGER_SHEET_FEATURE: Partial<Record<ScanTriggerId, PremiumFeatureId>> = {
  erster_passt_nicht: "empfehlungen",
  zwei_scans_gleiche_kategorie: "empfehlungen",
  merken_tap: "merkliste",
  passt_gut_moment: "routine",
  frust_serie: "routine",
  wiederkehrer: "routine",
}

export type ScanTriggerSheetContext = { feature: PremiumFeatureId; source: string }

/**
 * The `PremiumSheetContext` a firing trigger should open, or `null` for the two triggers
 * that never open the stub sheet at all (`kategorien_luecke`, `unbekanntes_produkt`).
 * `source` is `"trigger:<slug>"` (dashes, per the brief) — additive to T9's existing
 * `"scan:verdict"` source, never replacing it.
 */
export function scanTriggerSheetContext(id: ScanTriggerId): ScanTriggerSheetContext | null {
  const feature = SCAN_TRIGGER_SHEET_FEATURE[id]
  if (!feature) return null
  return { feature, source: `trigger:${id.replace(/_/g, "-")}` }
}

// --- 1. Erster "passt nicht" ------------------------------------------------------

/**
 * Surface behavior is T9 (the reveal CTA keyed off `freeRevealAvailable`, T8's
 * server-authoritative signal); this rule only makes that condition explicit for the test
 * lane, without inventing a parallel client-side "is this the first mismatch ever"
 * detector — the server-derived `freeRevealAvailable` already IS that answer.
 */
export function firesErsterPasstNicht(input: {
  isMismatchVerdict: boolean
  freeRevealAvailable: boolean
}): boolean {
  return input.isMismatchVerdict && input.freeRevealAvailable
}

/** The exact complement: a later passt-nicht shows "Was passt stattdessen?" → sheet. */
export function firesWasPasstStattdessen(input: {
  isMismatchVerdict: boolean
  freeRevealAvailable: boolean
}): boolean {
  return input.isMismatchVerdict && !input.freeRevealAvailable
}

// --- 2. Zwei Scans, gleiche Kategorie ---------------------------------------------

export function firesZweiScansGleicheKategorie(input: {
  category: PersonalPlanCategory
  categoriesScannedBeforeThisScan: readonly PersonalPlanCategory[]
}): boolean {
  return input.categoriesScannedBeforeThisScan.includes(input.category)
}

// --- 3. Merken-Taps ------------------------------------------------------------------

export function firesMerkenTap(input: { merkenLocked: boolean }): boolean {
  return input.merkenLocked
}

// --- 4. Unbekanntes Produkt: never pitches --------------------------------------------

/**
 * Ruled 2026-09-09 (supersedes the original catalog copy): unknown product is an honest
 * rescue flow, never a premium pitch — no sheet, ever. Modeled as an explicit function
 * (rather than simply omitted from the catalog) so the test lane can assert
 * unknown-never-pitches for every input, including one that looks pitchable.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for the test lane's explicit rule signature
export function firesUnbekanntesProdukt(_input: { isUnknownProduct: boolean }): false {
  return false
}

// --- 5. Kategorien-Lücke ---------------------------------------------------------------

/**
 * Approximation (documented, per the T10 brief's explicit allowance): the catalog example
 * ties this trigger to a hair-texture profile fact ("wavy profile lacking Leave-in"), but
 * no profile-texture signal reaches the scan client today — threading one in would be a
 * server-side change out of scope for T10. This rule approximates the gap from
 * scanned-category history alone: at least 2 distinct categories scanned this session,
 * including a "wash-day" category (shampoo/conditioner/mask) that a Leave-in typically
 * pairs with, and Leave-in itself never among them. A later task can tighten this once
 * profile facts are threaded to the client.
 */
const CORE_WASHDAY_CATEGORIES: readonly PersonalPlanCategory[] = ["shampoo", "conditioner", "mask"]

export function firesKategorienLuecke(input: {
  categoriesScannedThisSession: readonly PersonalPlanCategory[]
}): boolean {
  const distinct = new Set(input.categoriesScannedThisSession)
  if (distinct.has("leave_in")) return false
  if (distinct.size < 2) return false
  return CORE_WASHDAY_CATEGORIES.some((category) => distinct.has(category))
}

// --- 6. "Passt gut"-Moment ------------------------------------------------------------

export function firesPasstGutMoment(input: { verdict: ScanVerdict | null }): boolean {
  return input.verdict === "ideal"
}

// --- 7. Frust-Serie ---------------------------------------------------------------------

export function firesFrustSerie(input: { consecutiveMismatchCount: number }): boolean {
  return input.consecutiveMismatchCount >= 2
}

// --- 8. Wiederkehrer ---------------------------------------------------------------------

/**
 * Fix round 1 (F4, controller ruling): fires ONLY when the session record says this is
 * EXACTLY the second session (catalog-literal "second session, no purchase") — not on
 * every returning session. Session 1 has no signal yet; session 3+ leaves the one-pitch
 * budget for Frust-Serie / Kategorien-Lücke / Passt-gut instead of Wiederkehrer claiming it
 * every time by virtue of being the only candidate possible on a session's first scan.
 * `sessionNumber` is an explicit input (from `session-marker.ts`'s localStorage record) so
 * this stays a pure, deterministic function of its arguments, same as every other rule
 * here — device-scoped, not account-scoped (no new DB table, per the brief). "Without
 * purchase" needs no separate signal: this trigger — like every trigger in this module —
 * only ever evaluates once `scanTriggersEnabled` has confirmed the viewer is free tier, and
 * a free-tier viewer has by definition not purchased premium.
 */
export function firesWiederkehrer(input: { sessionNumber: number }): boolean {
  return input.sessionNumber === 2
}

// --- fatigue rule: at most one proactive pitch per session ----------------------------

export type ScanProactiveTriggerInput = {
  categoriesScannedThisSession: readonly PersonalPlanCategory[]
  verdict: ScanVerdict | null
  consecutiveMismatchCount: number
  /** Fix round 1 (F4): the explicit session number Wiederkehrer needs — see its doc. */
  sessionNumber: number
}

/** Every proactive trigger whose raw condition currently holds, in no particular order. */
export function candidateProactiveTriggers(
  input: ScanProactiveTriggerInput,
): ScanProactiveTriggerId[] {
  const candidates: ScanProactiveTriggerId[] = []
  if (firesKategorienLuecke(input)) candidates.push("kategorien_luecke")
  if (firesPasstGutMoment(input)) candidates.push("passt_gut_moment")
  if (firesFrustSerie(input)) candidates.push("frust_serie")
  if (firesWiederkehrer(input)) candidates.push("wiederkehrer")
  return candidates
}

/**
 * Deterministic priority when more than one candidate's raw condition holds at once (the
 * brief does not rank them; this fixes one so the winner is reproducible). Frustration
 * first — a repeated bad fit is the strongest signal of unmet need — then the category
 * gap, then a positive moment, then the returning-session nudge last (weakest signal).
 *
 * Fix round 1 (F4): before the ruling above, Wiederkehrer was true from a returning
 * session's first scan while the other three structurally need ≥2 scans, so it always won
 * on session 1 regardless of this ordering — the priority was moot. Now that Wiederkehrer
 * only fires on exactly session 2, a real tie is possible (e.g. two same-session scans that
 * also happen to be a user's second-ever session), and this ordering is what actually
 * decides it.
 */
const PROACTIVE_PRIORITY: readonly ScanProactiveTriggerId[] = [
  "frust_serie",
  "kategorien_luecke",
  "passt_gut_moment",
  "wiederkehrer",
]

/**
 * The fatigue rule (binding, plan §T10): at most one proactive pitch per app session,
 * across all four combined. `alreadyFiredThisSession` is `true` once ANY proactive trigger
 * has already been shown this session — a later call always answers `null` regardless of
 * what newly qualifies, which is exactly "a fired proactive pitch suppresses the other
 * three for the rest of the session." User-initiated gates take no fatigue flag at all —
 * they are exempt by construction (see the 4 `fires*` functions above).
 */
export function resolveProactiveScanTrigger(
  input: ScanProactiveTriggerInput,
  alreadyFiredThisSession: boolean,
): ScanProactiveTriggerId | null {
  if (alreadyFiredThisSession) return null
  const candidates = candidateProactiveTriggers(input)
  for (const id of PROACTIVE_PRIORITY) {
    if (candidates.includes(id)) return id
  }
  return null
}

/** `resolveProactiveScanTrigger`, gated by tier/flag in one call — the shape the UI wants. */
export function resolveGatedProactiveScanTrigger(
  gate: ScanTriggerGate,
  input: ScanProactiveTriggerInput,
  alreadyFiredThisSession: boolean,
): ScanProactiveTriggerId | null {
  if (!scanTriggersEnabled(gate)) return null
  return resolveProactiveScanTrigger(input, alreadyFiredThisSession)
}

/** `firesZweiScansGleicheKategorie`, gated by tier/flag in one call — the shape the UI wants. */
export function firesGatedZweiScansGleicheKategorie(
  gate: ScanTriggerGate,
  input: {
    category: PersonalPlanCategory
    categoriesScannedBeforeThisScan: readonly PersonalPlanCategory[]
  },
): boolean {
  return scanTriggersEnabled(gate) && firesZweiScansGleicheKategorie(input)
}
