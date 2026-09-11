import assert from "node:assert/strict"
import test from "node:test"

import {
  candidateProactiveTriggers,
  firesErsterPasstNicht,
  firesFrustSerie,
  firesKategorienLuecke,
  firesMerkenTap,
  firesPasstGutMoment,
  firesUnbekanntesProdukt,
  firesWasPasstStattdessen,
  firesWiederkehrer,
  firesZweiScansGleicheKategorie,
  resolveGatedProactiveScanTrigger,
  resolveProactiveScanTrigger,
  scanTriggerSheetContext,
  scanTriggersEnabled,
  SCAN_TRIGGER_CLASS,
  type ScanProactiveTriggerInput,
  type ScanTriggerGate,
} from "../src/lib/scan/triggers/trigger-rules"

/**
 * Rule lane for T10 (plan §PR2): the 8-trigger catalog, the fatigue rule, and the
 * unknown-never-pitches ruling, all as pure functions with no I/O. Each trigger's exact
 * firing condition gets its own test, per the task-10-brief acceptance criteria.
 */

const FREE_ON: ScanTriggerGate = { freemiumScannerFirstEnabled: true, tier: "free" }
const PREMIUM_ON: ScanTriggerGate = { freemiumScannerFirstEnabled: true, tier: "premium" }
const FREE_FLAG_OFF: ScanTriggerGate = { freemiumScannerFirstEnabled: false, tier: "free" }

// --- trigger classification ---------------------------------------------------

test("classification: 4 user-initiated gates never fatigue-limited, 4 proactive pitches are", () => {
  assert.deepEqual(SCAN_TRIGGER_CLASS, {
    erster_passt_nicht: "user_initiated",
    zwei_scans_gleiche_kategorie: "user_initiated",
    merken_tap: "user_initiated",
    unbekanntes_produkt: "user_initiated",
    kategorien_luecke: "proactive",
    passt_gut_moment: "proactive",
    frust_serie: "proactive",
    wiederkehrer: "proactive",
  })
})

// --- 1. Erster "passt nicht" ---------------------------------------------------

test("erster_passt_nicht fires exactly on a mismatch verdict with the free reveal still available", () => {
  assert.equal(firesErsterPasstNicht({ isMismatchVerdict: true, freeRevealAvailable: true }), true)
  assert.equal(
    firesErsterPasstNicht({ isMismatchVerdict: true, freeRevealAvailable: false }),
    false,
  )
  assert.equal(
    firesErsterPasstNicht({ isMismatchVerdict: false, freeRevealAvailable: true }),
    false,
  )
})

test('"was passt stattdessen" is the exact complement for a later passt-nicht', () => {
  assert.equal(
    firesWasPasstStattdessen({ isMismatchVerdict: true, freeRevealAvailable: false }),
    true,
  )
  assert.equal(
    firesWasPasstStattdessen({ isMismatchVerdict: true, freeRevealAvailable: true }),
    false,
  )
  assert.equal(
    firesWasPasstStattdessen({ isMismatchVerdict: false, freeRevealAvailable: false }),
    false,
  )
})

// --- 2. Zwei Scans, gleiche Kategorie ------------------------------------------

test("zwei_scans_gleiche_kategorie fires when the scanned category already appeared this session", () => {
  assert.equal(
    firesZweiScansGleicheKategorie({
      category: "shampoo",
      categoriesScannedBeforeThisScan: ["shampoo"],
    }),
    true,
  )
  assert.equal(
    firesZweiScansGleicheKategorie({
      category: "shampoo",
      categoriesScannedBeforeThisScan: ["conditioner"],
    }),
    false,
  )
  assert.equal(
    firesZweiScansGleicheKategorie({ category: "shampoo", categoriesScannedBeforeThisScan: [] }),
    false,
  )
})

// --- 3. Merken-Taps -------------------------------------------------------------

test("merken_tap fires exactly when the bookmark is locked", () => {
  assert.equal(firesMerkenTap({ merkenLocked: true }), true)
  assert.equal(firesMerkenTap({ merkenLocked: false }), false)
})

// --- 4. Unbekanntes Produkt: never pitches -------------------------------------

test("unbekanntes_produkt never pitches, for every input including one that looks pitchable", () => {
  assert.equal(firesUnbekanntesProdukt({ isUnknownProduct: true }), false)
  assert.equal(firesUnbekanntesProdukt({ isUnknownProduct: false }), false)
})

// --- 5. Kategorien-Lücke --------------------------------------------------------

test("kategorien_luecke fires on a wash-day category scanned without ever scanning leave_in", () => {
  assert.equal(
    firesKategorienLuecke({ categoriesScannedThisSession: ["shampoo", "conditioner"] }),
    true,
  )
})

test("kategorien_luecke does not fire once leave_in has been scanned", () => {
  assert.equal(
    firesKategorienLuecke({
      categoriesScannedThisSession: ["shampoo", "conditioner", "leave_in"],
    }),
    false,
  )
})

test("kategorien_luecke does not fire on a single scan (needs ≥2 distinct categories)", () => {
  assert.equal(firesKategorienLuecke({ categoriesScannedThisSession: ["shampoo"] }), false)
})

test("kategorien_luecke does not fire without a wash-day category among the scans", () => {
  assert.equal(
    firesKategorienLuecke({ categoriesScannedThisSession: ["oil", "dry_shampoo"] }),
    false,
  )
})

// --- 6. "Passt gut"-Moment -------------------------------------------------------

test('passt_gut_moment fires exactly on an "ideal" verdict', () => {
  assert.equal(firesPasstGutMoment({ verdict: "ideal" }), true)
  assert.equal(firesPasstGutMoment({ verdict: "supportive" }), false)
  assert.equal(firesPasstGutMoment({ verdict: "mismatch" }), false)
  assert.equal(firesPasstGutMoment({ verdict: null }), false)
})

// --- 7. Frust-Serie ---------------------------------------------------------------

test("frust_serie fires at 2 or more consecutive passt-nicht verdicts, not at 1", () => {
  assert.equal(firesFrustSerie({ consecutiveMismatchCount: 0 }), false)
  assert.equal(firesFrustSerie({ consecutiveMismatchCount: 1 }), false)
  assert.equal(firesFrustSerie({ consecutiveMismatchCount: 2 }), true)
  assert.equal(firesFrustSerie({ consecutiveMismatchCount: 3 }), true)
})

// --- 8. Wiederkehrer ---------------------------------------------------------------

test("wiederkehrer fires exactly on session number 2, not session 1 or session 3+ (F4)", () => {
  assert.equal(firesWiederkehrer({ sessionNumber: 1 }), false)
  assert.equal(firesWiederkehrer({ sessionNumber: 2 }), true)
  assert.equal(firesWiederkehrer({ sessionNumber: 3 }), false)
  assert.equal(firesWiederkehrer({ sessionNumber: 4 }), false)
})

// --- fatigue rule: at most one proactive pitch per session -----------------------

test("candidateProactiveTriggers lists every proactive trigger whose raw condition holds", () => {
  const candidates = candidateProactiveTriggers({
    categoriesScannedThisSession: ["shampoo", "conditioner"],
    verdict: "ideal",
    consecutiveMismatchCount: 2,
    sessionNumber: 2,
  })
  assert.deepEqual(
    new Set(candidates),
    new Set(["frust_serie", "kategorien_luecke", "passt_gut_moment", "wiederkehrer"]),
  )
})

test("resolveProactiveScanTrigger picks one deterministic winner when several qualify at once", () => {
  const input: ScanProactiveTriggerInput = {
    categoriesScannedThisSession: ["shampoo", "conditioner"],
    verdict: "ideal",
    consecutiveMismatchCount: 2,
    sessionNumber: 2,
  }
  const winner = resolveProactiveScanTrigger(input, false)
  assert.ok(winner)
  // Calling again with the identical input is deterministic (same winner every time).
  assert.equal(resolveProactiveScanTrigger(input, false), winner)
})

test("fatigue: a second proactive candidate in the same session is suppressed once one has fired", () => {
  const input: ScanProactiveTriggerInput = {
    categoriesScannedThisSession: ["shampoo", "conditioner"],
    verdict: "ideal",
    consecutiveMismatchCount: 0,
    sessionNumber: 1,
  }
  assert.notEqual(resolveProactiveScanTrigger(input, false), null)
  assert.equal(resolveProactiveScanTrigger(input, true), null)
})

test("F4: on session 3+, Wiederkehrer never claims the budget — it structurally cannot qualify", () => {
  const input: ScanProactiveTriggerInput = {
    categoriesScannedThisSession: ["shampoo", "conditioner"],
    verdict: null,
    consecutiveMismatchCount: 0,
    sessionNumber: 3,
  }
  assert.deepEqual(candidateProactiveTriggers(input), ["kategorien_luecke"])
  assert.equal(resolveProactiveScanTrigger(input, false), "kategorien_luecke")
})

test("F4: a genuine tie on session 2 is broken by PROACTIVE_PRIORITY, not by Wiederkehrer always winning", () => {
  const input: ScanProactiveTriggerInput = {
    categoriesScannedThisSession: ["shampoo", "conditioner"],
    verdict: null,
    consecutiveMismatchCount: 2,
    sessionNumber: 2,
  }
  assert.deepEqual(
    new Set(candidateProactiveTriggers(input)),
    new Set(["frust_serie", "kategorien_luecke", "wiederkehrer"]),
  )
  // frust_serie outranks both kategorien_luecke and wiederkehrer (documented priority).
  assert.equal(resolveProactiveScanTrigger(input, false), "frust_serie")
})

test("fatigue does not touch user-initiated gates: they fire regardless of alreadyFiredThisSession", () => {
  // User-initiated predicates take no fatigue flag at all — asserting the shape here
  // documents that omission is deliberate, not an oversight.
  assert.equal(firesMerkenTap({ merkenLocked: true }), true)
  assert.equal(
    firesZweiScansGleicheKategorie({
      category: "shampoo",
      categoriesScannedBeforeThisScan: ["shampoo"],
    }),
    true,
  )
})

test("no proactive candidate yields no winner", () => {
  assert.equal(
    resolveProactiveScanTrigger(
      {
        categoriesScannedThisSession: [],
        verdict: null,
        consecutiveMismatchCount: 0,
        sessionNumber: 1,
      },
      false,
    ),
    null,
  )
})

// --- flag + tier gating: zero triggers for premium or flag-off -------------------

test("scanTriggersEnabled is true only for free tier with the flag on", () => {
  assert.equal(scanTriggersEnabled(FREE_ON), true)
  assert.equal(scanTriggersEnabled(PREMIUM_ON), false)
  assert.equal(scanTriggersEnabled(FREE_FLAG_OFF), false)
  assert.equal(scanTriggersEnabled({ freemiumScannerFirstEnabled: false, tier: "premium" }), false)
})

test("resolveGatedProactiveScanTrigger yields no trigger for premium regardless of raw conditions", () => {
  const hotInput: ScanProactiveTriggerInput = {
    categoriesScannedThisSession: ["shampoo", "conditioner"],
    verdict: "ideal",
    consecutiveMismatchCount: 5,
    sessionNumber: 2,
  }
  assert.equal(resolveGatedProactiveScanTrigger(PREMIUM_ON, hotInput, false), null)
})

test("resolveGatedProactiveScanTrigger yields no trigger with the flag off regardless of raw conditions", () => {
  const hotInput: ScanProactiveTriggerInput = {
    categoriesScannedThisSession: ["shampoo", "conditioner"],
    verdict: "ideal",
    consecutiveMismatchCount: 5,
    sessionNumber: 2,
  }
  assert.equal(resolveGatedProactiveScanTrigger(FREE_FLAG_OFF, hotInput, false), null)
})

test("resolveGatedProactiveScanTrigger fires for a genuinely free, flag-on session", () => {
  const hotInput: ScanProactiveTriggerInput = {
    categoriesScannedThisSession: ["shampoo", "conditioner"],
    verdict: "ideal",
    consecutiveMismatchCount: 0,
    sessionNumber: 1,
  }
  assert.notEqual(resolveGatedProactiveScanTrigger(FREE_ON, hotInput, false), null)
})

// --- sheet-opening contract: correct PremiumSheetContext per trigger -------------

test("scanTriggerSheetContext maps scan-context gates to empfehlungen", () => {
  assert.deepEqual(scanTriggerSheetContext("erster_passt_nicht"), {
    feature: "empfehlungen",
    source: "trigger:erster-passt-nicht",
  })
  assert.deepEqual(scanTriggerSheetContext("zwei_scans_gleiche_kategorie"), {
    feature: "empfehlungen",
    source: "trigger:zwei-scans-gleiche-kategorie",
  })
})

test("scanTriggerSheetContext maps Merken to merkliste", () => {
  assert.deepEqual(scanTriggerSheetContext("merken_tap"), {
    feature: "merkliste",
    source: "trigger:merken-tap",
  })
})

test("scanTriggerSheetContext maps the 3 sheet-opening proactive pitches to routine", () => {
  for (const id of ["passt_gut_moment", "frust_serie", "wiederkehrer"] as const) {
    assert.deepEqual(scanTriggerSheetContext(id), {
      feature: "routine",
      source: `trigger:${id.replace(/_/g, "-")}`,
    })
  }
})

test("scanTriggerSheetContext is null for kategorien_luecke (links into the gated Routine page instead)", () => {
  assert.equal(scanTriggerSheetContext("kategorien_luecke"), null)
})

test("scanTriggerSheetContext is null for unbekanntes_produkt (never pitches, no sheet)", () => {
  assert.equal(scanTriggerSheetContext("unbekanntes_produkt"), null)
})
