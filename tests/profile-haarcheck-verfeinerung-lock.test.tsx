import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import React, { type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { HaarCheckEditControl } from "../src/components/profile/haar-check-edit-control"
import { MemoryToggleControl } from "../src/components/profile/memory-toggle-control"
import { ProfileLockBadge } from "../src/components/profile/profile-lock-badge"
import { VerfeinerungTeaser } from "../src/components/profile/verfeinerung-teaser"
import { Button } from "../src/components/ui/button"
import { Switch } from "../src/components/ui/switch"
import { PREMIUM_FEATURES } from "../src/lib/premium-sheet/context"

/**
 * T15 (freemium-scanner-first PR5): the Profil page's two premium gates — the Haar-Check
 * edit affordance and the Verfeinerungs-Teaser.
 *
 * The Profil page itself (`src/app/profile/page.tsx`) is a large, heavily effectful client
 * component with no render-test harness in this repo (every existing test that touches it —
 * `profile-account-logout.test.ts`, `personal-plan-profil-haarprofil.test.tsx`,
 * `billing-plan-change.test.ts` — asserts against its SOURCE TEXT, not a render). This file
 * follows that same established convention for the page-level wiring, and covers the
 * components with real `renderToStaticMarkup`/element-tree render tests — mirroring how T3's
 * free-tier nav lock is proven (`personal-plan-stage5-navigation.test.tsx` renders
 * `PersonalPlanNavigationView` directly with `tier: "free"`).
 *
 * Fix round 1 (`task-15-review.md`, F3): the Haar-Check edit affordance itself had only
 * source-text regex coverage — a refactor could keep the strings but break the gate and the
 * suite would stay green. `HaarCheckEditControl` is extracted for exactly that reason, and is
 * now covered by real render tests below (F1's corner-lock fix included). `MemoryToggleControl`
 * (F5, controller ruling) follows the same pattern for the memory toggle's new lock.
 */

const pageSource = readFileSync("src/app/profile/page.tsx", "utf8")
const layoutSource = readFileSync("src/app/profile/layout.tsx", "utf8")

// --- element-tree helpers (same family as tests/gated-preview-component.test.tsx) ----

type AnyElement = ReactElement<Record<string, any>>

function childrenOf(node: ReactNode): ReactNode[] {
  if (!React.isValidElement(node)) return []
  return React.Children.toArray((node as ReactElement<{ children?: ReactNode }>).props.children)
}

// --- VerfeinerungTeaser (free-tier stand-in for "Dein Haarprofil") --------------

test("VerfeinerungTeaser renders the noch-genauer framing, not a bad-current-profile framing", () => {
  const html = renderToStaticMarkup(<VerfeinerungTeaser onUnlock={() => {}} />)

  assert.match(html, /Noch genauer werden/)
  assert.match(html, /noch genauer/)
  // Binding constraint: must never read as "your current recommendations are wrong/missing".
  assert.doesNotMatch(html, /nicht genau|ungenau|fehlerhaft|unvollständig/)
})

test("VerfeinerungTeaser's CTA carries the accessible Premium gate name and the corner lock badge", () => {
  const html = renderToStaticMarkup(<VerfeinerungTeaser onUnlock={() => {}} />)

  assert.match(html, /Verfeinerung freischalten/)
  assert.match(html, /aria-label="Verfeinerung freischalten — Premium"/)
  assert.match(html, /data-profile-lock-badge="true"/)
})

// --- ProfileLockBadge (shared corner marker, NavLockBadge/ScanLockBadge contract) ---

test("ProfileLockBadge is decorative and never covers content (no interactive role, aria-hidden)", () => {
  const html = renderToStaticMarkup(<ProfileLockBadge />)

  assert.match(html, /aria-hidden="true"/)
  assert.match(html, /data-profile-lock-badge="true"/)
  assert.match(html, /pointer-events-none/)
  // Positioned at a corner, not covering the whole affordance.
  assert.match(html, /absolute -right-1 -top-1/)
})

// --- HaarCheckEditControl (fix round 1: F1 corner-lock fix, F2 byte-identity, F3 extraction) --

test("HaarCheckEditControl free tier: the corner lock renders as a Button SIBLING, not a child — proves F1", () => {
  const root = HaarCheckEditControl({ tier: "free", onEdit: () => {} }) as AnyElement

  assert.equal(root.type, "span")
  assert.match(root.props.className as string, /relative/)
  assert.match(root.props.className as string, /inline-flex/)

  const [buttonChild, badgeChild] = childrenOf(root) as AnyElement[]
  assert.equal(buttonChild.type, Button, "first child is the Button")
  assert.equal(badgeChild.type, ProfileLockBadge, "second child is the lock badge, as a SIBLING")

  // The badge must not be inside the Button — that's the exact bug F1 fixed: Button's
  // `[&_svg]:size-4` beats the badge's own icon sizing when the badge is a child.
  const buttonOwnChildren = childrenOf(buttonChild)
  assert.deepEqual(buttonOwnChildren, ["Haar-Check bearbeiten"])
})

test("HaarCheckEditControl free tier: rendered markup places the lock <svg> after the Button closes, not inside it", () => {
  const html = renderToStaticMarkup(<HaarCheckEditControl tier="free" onEdit={() => {}} />)

  const buttonClose = html.indexOf("</button>")
  const svgOpen = html.indexOf("<svg")
  assert.notEqual(buttonClose, -1)
  assert.notEqual(svgOpen, -1)
  assert.ok(
    svgOpen > buttonClose,
    "the lock glyph's <svg> must render after </button> — a sibling, never a descendant",
  )
})

test("HaarCheckEditControl free tier: carries the accessible Premium name", () => {
  const root = HaarCheckEditControl({ tier: "free", onEdit: () => {} }) as AnyElement
  const [buttonChild] = childrenOf(root) as AnyElement[]

  assert.equal(buttonChild.props["aria-label"], "Haar-Check bearbeiten — Premium")
})

test("HaarCheckEditControl premium tier: renders the bare Button, byte-identical to pre-T15 markup — proves F2", () => {
  const root = HaarCheckEditControl({ tier: "premium", onEdit: () => {} }) as AnyElement

  assert.equal(root.type, Button, "no wrapper span for premium — nothing new to escape")
  assert.equal(root.props.className, "w-auto", "no stray `relative` class on the premium Button")
  assert.equal(root.props["aria-label"], undefined)
  assert.deepEqual(childrenOf(root), ["Haar-Check bearbeiten"])
})

test("HaarCheckEditControl: tapping calls onEdit for both tiers — tier branching stays inside the page's single choke point (startQuizEditing), not duplicated here", () => {
  let freeCalls = 0
  const freeRoot = HaarCheckEditControl({
    tier: "free",
    onEdit: () => {
      freeCalls += 1
    },
  }) as AnyElement
  const [freeButton] = childrenOf(freeRoot) as AnyElement[]
  freeButton.props.onClick()
  assert.equal(freeCalls, 1)

  let premiumCalls = 0
  const premiumRoot = HaarCheckEditControl({
    tier: "premium",
    onEdit: () => {
      premiumCalls += 1
    },
  }) as AnyElement
  premiumRoot.props.onClick()
  assert.equal(premiumCalls, 1)
})

test("the page wires HaarCheckEditControl with the server-resolved tier and the startQuizEditing choke point", () => {
  assert.match(
    pageSource,
    /<HaarCheckEditControl tier=\{tier\} onEdit=\{\(\) => startQuizEditing\(\)\} \/>/,
  )
})

// --- MemoryToggleControl (fix round 1, F5 — controller ruling) ------------------

test("MemoryToggleControl free tier: the corner lock renders as a Switch SIBLING, never claims Aktiv, and routes taps to the Premium sheet instead of the API", () => {
  let lockedTaps = 0
  let apiCalls = 0
  const root = MemoryToggleControl({
    tier: "free",
    checked: true,
    disabled: false,
    onCheckedChange: () => {
      apiCalls += 1
    },
    onLockedTap: () => {
      lockedTaps += 1
    },
  }) as AnyElement

  assert.equal(root.type, "span")
  assert.match(root.props.className as string, /relative/)
  assert.match(root.props.className as string, /inline-flex/)

  const [switchChild, badgeChild] = childrenOf(root) as AnyElement[]
  assert.equal(switchChild.type, Switch, "first child is the Switch")
  assert.equal(badgeChild.type, ProfileLockBadge, "second child is the lock badge, as a SIBLING")

  assert.equal(switchChild.props.checked, false, "never renders as falsely Aktiv for a free user")
  assert.equal(switchChild.props["aria-label"], "Erinnerungen aktivieren — Premium")

  // Tapping (Switch's internal handler calls onCheckedChange) must open the sheet, not PATCH.
  switchChild.props.onCheckedChange(true)
  assert.equal(lockedTaps, 1, "the locked tap handler fires")
  assert.equal(apiCalls, 0, "the real onCheckedChange (PATCH /api/memory) is never reached")
})

test("MemoryToggleControl premium tier: renders the bare functional Switch, unchanged", () => {
  let apiCalls = 0
  const root = MemoryToggleControl({
    tier: "premium",
    checked: true,
    disabled: false,
    onCheckedChange: () => {
      apiCalls += 1
    },
    onLockedTap: () => {},
  }) as AnyElement

  assert.equal(root.type, Switch, "no wrapper span for premium")
  assert.equal(root.props.checked, true)
  assert.equal(root.props.disabled, false)
  assert.equal(root.props["aria-label"], "Erinnerungen aktivieren")

  root.props.onCheckedChange(false)
  assert.equal(apiCalls, 1, "premium still reaches the real handler")
})

test("the page wires MemoryToggleControl with the server-resolved tier and a distinct memory sheet context", () => {
  assert.match(
    pageSource,
    /const MEMORY_GATE: PremiumSheetContext = \{ feature: "chat", source: "profil:gedaechtnis" \}/,
  )
  assert.match(
    pageSource,
    /<MemoryToggleControl\s*\n\s*tier=\{tier\}\s*\n\s*checked=\{memoryEnabled\}\s*\n\s*disabled=\{memoryLoading \|\| memorySaving\}\s*\n\s*onCheckedChange=\{handleMemoryToggle\}\s*\n\s*onLockedTap=\{\(\) => openPremiumSheet\(MEMORY_GATE\)\}\s*\n\s*\/>/,
  )
})

test("the memory section's status text never claims Aktiv for a free user (F5)", () => {
  const start = pageSource.indexOf("const memoryStatus =")
  assert.notEqual(start, -1, "memoryStatus must still exist")
  const end = pageSource.indexOf("\n\n", start)
  const body = pageSource.slice(start, end)

  assert.match(body, /tier === "free"/)
  assert.match(body, /"Nur mit Premium"/)
  // The free branch must be checked before ever reaching the loading/Aktiv/Pausiert ladder.
  const freeBranchIndex = body.indexOf('tier === "free"')
  const aktivIndex = body.indexOf('"Aktiv"')
  assert.ok(freeBranchIndex < aktivIndex, "the tier check must precede the Aktiv fallback")
})

// --- Sheet contexts: exact per the brief's binding design -----------------------

test("the brief's exact sheet contexts are wired: haarcheck and verfeinerung gates", () => {
  assert.match(
    pageSource,
    /const HAARCHECK_GATE: PremiumSheetContext = \{ feature: "haarcheck", source: "profil:haarcheck" \}/,
  )
  assert.match(
    pageSource,
    /const VERFEINERUNG_GATE: PremiumSheetContext = \{\s*\n\s*feature: "verfeinerung",\s*\n\s*source: "profil:verfeinerung",\s*\n\s*\}/,
  )
})

test("both premium-sheet feature ids used by this page have approved copy registered", () => {
  assert.ok(PREMIUM_FEATURES.haarcheck)
  assert.ok(PREMIUM_FEATURES.verfeinerung)
  assert.ok(PREMIUM_FEATURES.chat)
  assert.equal(PREMIUM_FEATURES.haarcheck.name, "Haar-Check bearbeiten")
  assert.equal(PREMIUM_FEATURES.verfeinerung.name, "Profil-Verfeinerung")
})

// --- Haar-Check: editing is corner-locked at a single choke point ---------------

test("startQuizEditing gates on tier before entering edit mode — the single choke point for the header button, per-field cards and the Haarlänge prompt", () => {
  const start = pageSource.indexOf("function startQuizEditing(fieldKey?: string) {")
  assert.notEqual(start, -1, "startQuizEditing must still exist")
  const end = pageSource.indexOf("\n  }", start)
  const body = pageSource.slice(start, end)

  assert.match(body, /if \(tier === "free"\) \{/)
  assert.match(body, /openPremiumSheet\(HAARCHECK_GATE\)/)
  assert.match(body, /return\s*\n\s*\}/)
  // The free branch must return before ever flipping quizEditing.
  const freeBranchIndex = body.indexOf('if (tier === "free")')
  const setEditingIndex = body.indexOf("setQuizEditing(true)")
  assert.ok(freeBranchIndex < setEditingIndex, "the tier check must precede entering edit mode")
})

// --- Verfeinerungs-Teaser: free branch is additive, premium branch untouched ----

test("the Verfeinerungs-Teaser is a SEPARATE block from the existing premium HairProfileSection conditional — the premium branch's source is byte-for-byte unchanged", () => {
  assert.match(
    pageSource,
    /\{tier === "free" \? \(\s*\n\s*<VerfeinerungTeaser onUnlock=\{\(\) => openPremiumSheet\(VERFEINERUNG_GATE\)\} \/>\s*\n\s*\) : null\}/,
  )
  // Exact literal the pre-existing test in personal-plan-profil-haarprofil.test.tsx pins —
  // proof that block was not touched or nested inside the new conditional above.
  assert.match(pageSource, /\{hasRoutineAccess && refinementStatus \? \(/)
})

// --- PremiumSheet mount: one sheet, both gates, PayPal-return fallback ----------

test("the PremiumSheet is mounted once with a PayPal-return fallback to the Haar-Check gate", () => {
  assert.match(pageSource, /<PremiumSheet\b/)
  assert.match(pageSource, /open=\{premiumSheetOpen\}/)
  assert.match(pageSource, /context=\{premiumSheetContext\}/)
  assert.match(
    pageSource,
    /onRequestOpen=\{\(context\) => openPremiumSheet\(context \?\? HAARCHECK_GATE\)\}/,
  )
})

// --- Tier derivation: server-only, route-agnostic loader, no client guess ------

test("tier is read from the server-resolved context, never computed client-side", () => {
  assert.match(pageSource, /const tier = useProfilePageTier\(\)/)
  assert.doesNotMatch(
    pageSource,
    /getEntitlements|hasFreemiumPaidAccess|resolveAuthenticatedAppPageTier/,
  )
})

test("the layout resolves tier server-side via the same route-agnostic loader /scan uses", () => {
  assert.match(
    layoutSource,
    /import \{ loadAuthenticatedAppPageTier \} from "@\/lib\/auth\/authenticated-app-route-access"/,
  )
  assert.match(layoutSource, /const \[navigation, tier\] = await Promise\.all\(\[/)
  assert.match(layoutSource, /loadAuthenticatedAppPageTier\(\)/)
  assert.match(
    layoutSource,
    /<ProfilePageTierProvider tier=\{tier\}>\{children\}<\/ProfilePageTierProvider>/,
  )
})
