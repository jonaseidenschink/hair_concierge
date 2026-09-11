import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  buildFrequencyControlModel,
  getRoutineCardVisual,
  routineCardStatusDescription,
} from "@/components/routine/routine-card-model"
import type { RoutineUiCard } from "@/lib/routines/types"

function read(path: string) {
  return readFileSync(path, "utf8")
}

function assertNear(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} should be near ${expected}`)
}

function createCard(overrides: Partial<RoutineUiCard>): RoutineUiCard {
  return {
    id: "usage-1",
    kind: "verified_matches",
    tone: "green",
    category: "conditioner",
    categoryLabel: "Conditioner",
    productName: "Balea Feuchtigkeit Conditioner",
    currentFrequency: "weekly_1x",
    frequencyTarget: {
      minFrequency: "weekly_1x",
      maxFrequency: "weekly_3_4x",
      preferredFrequency: "weekly_2x",
      delta: "in_range",
    },
    careBalanceRow: null,
    usageRow: null,
    product: null,
    pendingSubmission: null,
    hasProductDrawer: false,
    isLegacyTextOnly: false,
    isTopProposal: false,
    ...overrides,
  }
}

test("routine card visuals map every shaped card kind to a state action", () => {
  assert.equal(getRoutineCardVisual(createCard({ kind: "verified_matches" })).action, "chevron")
  assert.equal(getRoutineCardVisual(createCard({ kind: "verified_swap" })).action, "swap")
  assert.equal(getRoutineCardVisual(createCard({ kind: "verified_swap" })).actionLabel, "Tausch")
  assert.equal(getRoutineCardVisual(createCard({ kind: "verified_unnecessary" })).action, "trash")
  assert.equal(
    getRoutineCardVisual(createCard({ kind: "verified_unnecessary" })).actionLabel,
    "Entfernen?",
  )
  assert.equal(getRoutineCardVisual(createCard({ kind: "verified_more_freq" })).action, "more")
  assert.equal(
    getRoutineCardVisual(createCard({ kind: "verified_more_freq" })).actionLabel,
    "Häufiger",
  )
  assert.equal(getRoutineCardVisual(createCard({ kind: "pending" })).action, "chevron")
  assert.equal(getRoutineCardVisual(createCard({ kind: "pending" })).dotClassName, null)
  assert.equal(getRoutineCardVisual(createCard({ kind: "suggestion" })).action, "chat")
  // Legacy text-only rows carry no Chaarlie signal: no dot, plain chevron.
  const legacy = getRoutineCardVisual(createCard({ kind: "verified_swap", isLegacyTextOnly: true }))
  assert.equal(legacy.action, "chevron")
  assert.equal(legacy.dotClassName, null)
})

test("routine card status descriptions stay German per kind", () => {
  assert.match(routineCardStatusDescription(createCard({ kind: "pending" })), /prüfen/i)
  assert.match(routineCardStatusDescription(createCard({ kind: "suggestion" })), /Routine/)
})

test("frequency model exposes stable slider stops, target band, and compact Chaarlie marker", () => {
  const model = buildFrequencyControlModel(
    createCard({
      currentFrequency: "weekly_1x",
      frequencyTarget: {
        minFrequency: "weekly_1x",
        maxFrequency: "weekly_3_4x",
        preferredFrequency: "weekly_2x",
        delta: "below",
      },
    }),
  )

  assert.equal(model.value, "weekly_1x")
  assert.equal(model.preferredLabel, "2×/Woche")
  assert.equal(model.deltaLabel, "Unter Chaarlies Zielbereich")
  assert.equal(model.markerLabel, "C")
  assert.ok(model.stops.length >= 8)
  assert.ok(model.band)
  assert.ok(model.preferred)
  assertNear(model.band.leftPercent, 42.857142857142854)
  assertNear(model.band.widthPercent, 28.571428571428573)
  assertNear(model.preferred.leftPercent, 57.14285714285714)
})

test("frequency model falls back to the preferred target when the user has no current value", () => {
  const model = buildFrequencyControlModel(
    createCard({
      currentFrequency: null,
      frequencyTarget: {
        minFrequency: "biweekly_1x",
        maxFrequency: "weekly_1x",
        preferredFrequency: "weekly_1x",
        delta: "missing",
      },
    }),
  )

  assert.equal(model.value, "weekly_1x")
  assert.equal(model.currentLabel, "Nicht gesetzt")
  assert.equal(model.preferredLabel, "1×/Woche")
  assert.equal(model.deltaLabel, "Noch nicht gesetzt")
})

test("routine product drawer receives loaded profile context", () => {
  const source = read("src/components/routine/routine-page-client.tsx")

  assert.match(source, /hairProfile=\{routine\.hairProfile\}/)
  assert.doesNotMatch(source, /hairProfile=\{null\}/)
})

/**
 * T16: „Gemerkt" section wiring. A full interactive mount is out of this repo's
 * established test surface for these components (no jsdom/testing-library here, and both
 * `RoutinePageClient` and `PersonalPlanRoutineClient` call the real `useRouter()` — see
 * tests/scan-flow-ui.test.tsx's header comment on why that harness family never attempts
 * a component that does), so — matching the source-pattern style already used for this
 * file just above — these assert the concrete wiring the acceptance criteria and THE
 * hazard both depend on: the flag gate, the deep-link anchor, and that graduation reuses
 * the EXISTING save/move sheet (`ScanSaveSheet`) rather than writing to the routine itself.
 * The write paths those wire into (auto-save's insert-only upsert, the move endpoint's own
 * semantics) are covered directly in tests/scan-wishlist-auto-save-postgres.test.ts and
 * tests/scan-save-route.test.ts respectively.
 *
 * Fix round 1 (F1): the section moved out of `routine-page-client.tsx` into the shared
 * `GemerktSection` component (`src/components/routine/gemerkt-section.tsx`) — the ORIGINAL
 * placement only ever wired into the legacy Routine branch, leaving the scanner bookmark's
 * `/routine#gemerkt` deep-link dead for every freemium-provisioned buyer and every current
 * subscriber, who all resolve to the personal-plan branch instead. These assertions now
 * cover the shared component itself plus BOTH callers wiring it in.
 */
test("Gemerkt section: defaults to hidden (flag-off byte-identity) and fetches only when merklisteEnabled", () => {
  const source = read("src/components/routine/gemerkt-section.tsx")

  assert.match(source, /if \(!merklisteEnabled\) return/)
  assert.match(source, /fetch\("\/api\/scan\/wishlist", \{ cache: "no-store" \}\)/)
})

test("Gemerkt section: the section anchor matches the scanner bookmark's deep-link target", () => {
  const source = read("src/components/routine/gemerkt-section.tsx")
  const scanFlowSource = read("src/components/scan/scan-flow.tsx")

  assert.match(source, /id="gemerkt"/)
  assert.match(scanFlowSource, /navigate\("\/routine#gemerkt"\)/)
})

test("Gemerkt section: graduation hands off to the EXISTING save/move sheet — no direct write from this section", () => {
  const source = read("src/components/routine/gemerkt-section.tsx")

  // The hand-off opens ScanSaveSheet; the actual write only happens once the user picks a
  // destination INSIDE that (already-existing, already-tested) sheet.
  assert.match(source, /<ScanSaveSheet/)
  assert.match(source, /onSavedStateChange=\{handleGraduated\}/)
  // This file's own fetch calls to /api/scan/save are DELETE only (a plain scan_wishlist
  // removal, never touching user_products — see removeScanWishlistProduct). The move
  // endpoint's destructive-if-misused POST half is never called directly from here; the
  // only POST anywhere in this component is the unrelated, pre-existing suggestion-dismiss
  // call, which this regex does not match.
  assert.doesNotMatch(source, /fetch\("\/api\/scan\/save",\s*\{\s*method: "POST"/)
  assert.match(source, /fetch\("\/api\/scan\/save",\s*\{\s*method: "DELETE"/)
  assert.match(source, /kind: "merkliste"/)
})

test("Gemerkt section: a routine graduation (not a plain removal) tells the caller WHICH product graduated (F6, Z3)", () => {
  const source = read("src/components/routine/gemerkt-section.tsx")

  assert.match(
    source,
    /if \(completion\.savedState\.state === "routine"\) \{\s*onGraduated\?\.\(\{/,
  )
  // PR5 review fix (Z3): the product's identity travels with the callback — without it the
  // caller could only refresh a list the graduation does not change, which is exactly how
  // the product came to vanish from „Gemerkt" with nothing to show for it.
  assert.match(source, /productId: completion\.productId/)
  assert.match(source, /name: graduated\?\.name/)
  // A plain removal is still not a graduation.
  assert.doesNotMatch(source, /savedState\.state !== "routine"/)
})

/**
 * PR5 review fix (Z3): the graduation hand-off. The ownership write is real, but the
 * confirmed Routine is compiled from the accepted version — so the product used to leave
 * „Gemerkt" and appear nowhere. The client now runs the EXISTING flows: the routine sync
 * (queued, hence an honest in-progress state), the existing proposal sheet when that sync
 * staged one, and otherwise the truthful "saved as owned, Routine unchanged" state with an
 * entry into the existing editor. No new routine write is introduced anywhere.
 */
test("PersonalPlanRoutineClient: graduation hands off into the existing sync/proposal/editor flow, with an honest in-progress state (Z3)", () => {
  const source = read("src/components/routine/personal-plan/personal-plan-routine-client.tsx")
  const handler = source.slice(
    source.indexOf("const handleGraduated"),
    source.indexOf("const openEditor"),
  )

  // 1. the existing entry-sync endpoint, never a new write of its own.
  assert.match(handler, /fetch\("\/api\/personal-plan\/routine\/sync", \{ method: "POST" \}\)/)
  assert.doesNotMatch(handler, /\/api\/personal-plan\/routine\/proposals/)
  assert.doesNotMatch(handler, /\/api\/scan\/save/)
  // The successor machinery is off when `enabled` is false — the sync is not attempted.
  assert.match(handler, /if \(enabled\) \{/)
  // 2. a staged proposal opens the EXISTING sheet on it.
  assert.match(handler, /if \(next\.pendingProposal\) \{\s*setProposalOpen\(true\)/)
  // 3. the three states the user can actually be in.
  assert.match(handler, /status: "pending"/)
  assert.match(handler, /status: "proposal"/)
  assert.match(handler, /status: "unchanged"/)

  // The in-progress state is announced, and the terminal "not in your routine yet" state
  // hands into the existing editor rather than leaving the user with a vanished product.
  const banner = source.slice(
    source.indexOf("{graduation ? ("),
    source.indexOf("onGraduated={handleGraduated}"),
  )
  assert.match(banner, /aria-live="polite"/)
  assert.match(banner, /wird übernommen …/)
  assert.match(banner, /In deiner Routine steht es noch nicht\./)
  assert.match(banner, /graduation\.status === "unchanged" && canEdit/)
  assert.match(banner, /onClick=\{openEditor\}/)
  assert.match(banner, /Routine anpassen/)
})

test("RoutinePageClient (legacy): wires the shared Gemerkt section with the server-derived flag and refreshes the routine list on graduation (F6)", () => {
  const source = read("src/components/routine/routine-page-client.tsx")

  assert.match(source, /merklisteEnabled = false/)
  assert.match(source, /<GemerktSection/)
  assert.match(source, /merklisteEnabled=\{merklisteEnabled\}/)
  assert.match(source, /onGraduated=\{\(\) => void refreshRoutine\(\)\}/)
})

test("PersonalPlanRoutineClient: wires the shared Gemerkt section too — this is the branch every freemium/subscriber premium user actually resolves to (F1)", () => {
  const clientSource = read("src/components/routine/personal-plan/personal-plan-routine-client.tsx")
  const pageSource = read("src/components/routine/personal-plan/routine-page.tsx")

  assert.match(clientSource, /merklisteEnabled = false/)
  assert.match(clientSource, /merklisteEnabled=\{merklisteEnabled\}/)
  assert.match(clientSource, /onGraduated=\{handleGraduated\}/)
  // T17 added the keepsake `readOnly` prop to the same element; the two original props
  // are still wired straight through, which is what this test exists to pin.
  assert.match(pageSource, /<GemerktSection\s+merklisteEnabled=\{merklisteEnabled\}/)
  assert.match(pageSource, /onGraduated=\{onGraduated\}/)
  assert.match(pageSource, /readOnly=\{merklisteReadOnly\}/)
})

test("RoutinePage: BOTH the legacy and personal-plan branches pass the server-derived flag, not a client-side read (F1)", () => {
  const source = read("src/app/routine/page.tsx")

  assert.match(
    source,
    /<RoutinePageClient merklisteEnabled=\{isFreemiumScannerFirstEnabled\(\)\} \/>/,
  )
  assert.match(source, /<PersonalPlanRoutineClient/)
  assert.match(source, /merklisteEnabled=\{isFreemiumScannerFirstEnabled\(\)\}/)
})

test("routine trigger seeds are sent from session storage with the route conversation id", () => {
  const source = read("src/components/chat/chat-container.tsx")
  const hookSource = read("src/hooks/use-chat.ts")

  assert.match(source, /currentConversationId \?\? initialConversationId/)
  assert.match(
    source,
    /readRoutineTriggerSeed\(routineSeedConversationId, window\.sessionStorage\)/,
  )
  assert.match(source, /readRoutineTriggerSeed\(initialConversationId, window\.sessionStorage\)/)
  assert.match(source, /sendMessage\(seedMessage, \{ conversationId \}\)/)
  assert.match(source, /await loadConversation\(conversationId\)/)
  assert.match(source, /clearRoutineTriggerSeed\(conversationId, window\.sessionStorage\)/)
  assert.match(hookSource, /setCurrentConversationId\(targetConversationId\)/)
  assert.doesNotMatch(
    source,
    /readRoutineTriggerSeed\(currentConversationId, window\.localStorage\)/,
  )
})

test("chat product drawer hydrates routine membership before rendering the action", () => {
  const source = read("src/components/chat/chat-container.tsx")

  assert.match(source, /fetch\(\"\/api\/routine\"\)/)
  assert.match(source, /alreadyInRoutine: routineProductMembership\.has\(drawerProduct\.id\)/)
  assert.match(
    source,
    /existingUsageId: routineProductMembership\.get\(drawerProduct\.id\)\?\.usageId/,
  )
})
