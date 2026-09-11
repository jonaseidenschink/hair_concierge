"use client"

import { createContext, useContext, type ReactNode } from "react"

import type { EntitlementTier } from "@/lib/entitlements"

/**
 * Server-resolved tier for the Profil page's premium affordances — Haar-Check
 * editing and the Verfeinerungs-Teaser (T15, freemium-scanner-first PR5).
 *
 * Same shape as `ProfileRoutineAccessProvider` in this folder: the layout
 * already awaits the route-agnostic tier loader
 * (`loadAuthenticatedAppPageTier`, `lib/auth/authenticated-app-route-access.ts`
 * — the same one `/scan` uses), so the client page only ever renders a value
 * the server already decided. No client-side entitlement guess runs here.
 *
 * Defaults to "premium" (zero locks) — matches every caller before T15 and
 * the repo-wide fail-closed convention (`resolveAuthenticatedAppPageTier`'s
 * own doc comment: "premium = no free surfaces", never "free" as the
 * fail-closed choice).
 */
const ProfilePageTierContext = createContext<EntitlementTier>("premium")

export function ProfilePageTierProvider({
  tier,
  children,
}: {
  tier: EntitlementTier
  children: ReactNode
}) {
  return <ProfilePageTierContext.Provider value={tier}>{children}</ProfilePageTierContext.Provider>
}

export function useProfilePageTier(): EntitlementTier {
  return useContext(ProfilePageTierContext)
}
