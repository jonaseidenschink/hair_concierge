"use client"

import { ListChecks, Lock, MessageCircle, Rows3, ScanLine, UserRound } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"

import {
  RoutineAttentionIndicator,
  useRoutineAttention,
} from "@/components/routine/personal-plan/routine-attention-indicator"
import type { EntitlementTier } from "@/lib/entitlements"
import type { PersonalPlanNavSurface } from "@/lib/personal-plan/lifecycle/repository"
import type {
  PersonalPlanNavigationItem,
  PersonalPlanNavigationItemKey,
} from "@/lib/personal-plan/navigation-access"

const EMPTY_UNVISITED_NAV_SURFACES: ReadonlySet<PersonalPlanNavSurface> = new Set()

/**
 * Free-tier gated tabs (controller resolution, T3): Chat, Routine, and
 * Anwendung carry the lock marker for a "free" tier viewer. Scan and Profil
 * never do — Scan is the freemium entry surface and Profil stays open.
 * Premium never gets a marker at all (see `NavLockBadge` usage below).
 */
const FREE_TIER_LOCKED_ITEM_KEYS = new Set<PersonalPlanNavigationItemKey>([
  "chat",
  "routine",
  "application",
])

/**
 * Corner lock marker for a gated tab under the freemium restructure
 * (controller resolution, T3): the tab icon itself always stays fully
 * visible — this only ever adds a small badge at its corner, never replaces
 * or covers it. Purely visual like `NavUnvisitedDot`: tapping the tab still
 * navigates to the page as today (gating the page content is a later task).
 */
function NavLockBadge() {
  return (
    <span
      aria-hidden="true"
      data-nav-lock-badge="true"
      className="absolute -right-1 -top-1 flex h-[13px] w-[13px] items-center justify-center rounded-full bg-primary ring-2 ring-background"
    >
      <Lock className="h-2 w-2 text-primary-foreground" strokeWidth={3} />
    </span>
  )
}

/**
 * Decorative "never visited this tab" dot (Task 2.9, decision 14) — no
 * tooltip, no copy, no live-region announcement, unlike
 * `RoutineAttentionIndicator`'s pending-proposal dot: this one is purely
 * visual so `aria-hidden` is correct here, not a shortcut.
 */
function NavUnvisitedDot() {
  return (
    <span
      aria-hidden="true"
      data-nav-unvisited-dot="true"
      className="absolute -right-0.5 -top-0.5 block h-1.5 w-1.5 rounded-full bg-primary ring-2 ring-background"
    />
  )
}

const ICONS = {
  chat: MessageCircle,
  routine: ListChecks,
  scan: ScanLine,
  application: Rows3,
  profile: UserRound,
} as const

/**
 * `unvisitedNavSurfaces` reflects the server read from BEFORE this render's
 * visit-marking write (that write is deferred via `after()` and lands after
 * the response, per `schedulePersonalPlanNavSurfaceVisit`). So on a
 * surface's very first visit, the surface being rendered right now is still
 * in `unvisitedNavSurfaces` — without this, the dot would flash on the tab
 * the user is currently looking at. Render-side fix, not a persistence fix:
 * `active` (the current pathname's own item) is always excluded from the
 * dot regardless of what `unvisitedNavSurfaces` says. The persisted write
 * logic is untouched — the very next navigation reads the now-updated
 * state from the server and the dot is simply gone.
 */
export function PersonalPlanNavigationView({
  items,
  pathname,
  hasPendingRoutineProposal = false,
  unvisitedNavSurfaces = EMPTY_UNVISITED_NAV_SURFACES,
  tier = "premium",
}: {
  items: readonly PersonalPlanNavigationItem[]
  pathname: string
  hasPendingRoutineProposal?: boolean
  unvisitedNavSurfaces?: ReadonlySet<PersonalPlanNavSurface>
  /** Defaults to "premium" (zero lock markers) — matches every caller before T3. */
  tier?: EntitlementTier
}) {
  return (
    <>
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4">
          <Link href="/chat" className="flex items-center gap-2" aria-label="Chaarlie Chat">
            <span className="flex items-center gap-[3px]" aria-hidden="true">
              <span className="h-3.5 w-[3px] rounded-sm bg-primary" />
              <span className="h-3.5 w-[3px] rounded-sm bg-primary/60" />
              <span className="h-3.5 w-[3px] rounded-sm bg-primary/30" />
            </span>
            <span className="font-header text-2xl tracking-wide text-[var(--text-heading)]">
              chaarlie
            </span>
          </Link>
          <nav aria-label="Personal-Plan-Navigation" className="hidden items-center gap-1 md:flex">
            {items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`relative rounded-[10px] px-3 py-2 text-sm font-semibold transition-colors ${
                    active
                      ? "bg-[var(--brand-plum-ice)] text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  }`}
                >
                  {item.label}
                  {item.key === "routine" ? (
                    <RoutineAttentionIndicator hasPendingProposal={hasPendingRoutineProposal} />
                  ) : unvisitedNavSurfaces.has(item.key) && !active ? (
                    <NavUnvisitedDot />
                  ) : null}
                </Link>
              )
            })}
          </nav>
        </div>
      </header>

      <nav
        aria-label="Personal-Plan-Navigation (mobil)"
        className="fixed inset-x-0 bottom-0 z-50 grid min-h-[calc(4.5rem+env(safe-area-inset-bottom))] border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-12px_30px_-26px_rgba(var(--brand-plum-rgb),0.55)] backdrop-blur supports-[backdrop-filter]:bg-background/90 md:hidden"
        style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
      >
        {items.map((item) => {
          const Icon = ICONS[item.key]
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
          return (
            <Link
              key={item.key}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`relative flex min-w-0 flex-col items-center justify-center gap-1 px-2 py-2 text-[11px] font-semibold transition-colors ${
                active
                  ? "text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              }`}
            >
              <span className="relative">
                <Icon className="h-5 w-5" aria-hidden="true" />
                {item.key === "routine" ? (
                  <RoutineAttentionIndicator hasPendingProposal={hasPendingRoutineProposal} />
                ) : unvisitedNavSurfaces.has(item.key) && !active ? (
                  <NavUnvisitedDot />
                ) : null}
                {tier === "free" && FREE_TIER_LOCKED_ITEM_KEYS.has(item.key) ? (
                  <NavLockBadge />
                ) : null}
              </span>
              <span>{item.label}</span>
            </Link>
          )
        })}
      </nav>
    </>
  )
}

export function PersonalPlanNavigation({
  items,
  initialHasPendingRoutineProposal,
  unvisitedNavSurfaces = EMPTY_UNVISITED_NAV_SURFACES,
  tier = "premium",
}: {
  items: readonly PersonalPlanNavigationItem[]
  initialHasPendingRoutineProposal: boolean
  unvisitedNavSurfaces?: ReadonlySet<PersonalPlanNavSurface>
  /** Defaults to "premium" (zero lock markers) — matches every caller before T3. */
  tier?: EntitlementTier
}) {
  const pathname = usePathname() ?? ""
  const hasPendingRoutineProposal = useRoutineAttention(
    items.some((item) => item.key === "routine"),
    initialHasPendingRoutineProposal,
  )
  return (
    <PersonalPlanNavigationView
      items={items}
      pathname={pathname}
      hasPendingRoutineProposal={hasPendingRoutineProposal}
      unvisitedNavSurfaces={unvisitedNavSurfaces}
      tier={tier}
    />
  )
}
