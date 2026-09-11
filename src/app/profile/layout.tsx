import { AuthenticatedAppShell } from "@/components/layout/authenticated-app-shell"
import { ProfilePageTierProvider } from "@/components/profile/profile-page-tier"
import { ProfileRoutineAccessProvider } from "@/components/profile/profile-routine-access"
import { loadAuthenticatedAppPageTier } from "@/lib/auth/authenticated-app-route-access"
import {
  hasRoutineTabAccess,
  loadAuthenticatedAppNavigationAccess,
  schedulePersonalPlanNavSurfaceVisit,
} from "@/lib/personal-plan/navigation-access"
import { AppRouteProviders } from "@/providers/route-providers"
import { PRIVATE_PAGE_METADATA } from "@/lib/seo/site-identity"

export const metadata = PRIVATE_PAGE_METADATA

export default async function ProfileLayout({ children }: { children: React.ReactNode }) {
  // T15 (freemium-scanner-first PR5): `tier` gates the Haar-Check edit affordance and the
  // Verfeinerungs-Teaser — both real behavior, not cosmetic — so it comes from the same
  // route-agnostic, email-aware loader `/scan` uses (`loadAuthenticatedAppPageTier`), never
  // from `navigation.tier` (that value is deliberately looked up by user id only, correct
  // for the nav's purely cosmetic lock dots but wrong for anything that gates behavior — see
  // that loader's own doc comment). Independent of `navigation`, so read concurrently.
  const [navigation, tier] = await Promise.all([
    loadAuthenticatedAppNavigationAccess(),
    loadAuthenticatedAppPageTier(),
  ])
  await schedulePersonalPlanNavSurfaceVisit(navigation, "profile")
  return (
    <AppRouteProviders>
      <AuthenticatedAppShell navigation={navigation}>
        <ProfileRoutineAccessProvider hasRoutineAccess={hasRoutineTabAccess(navigation)}>
          <ProfilePageTierProvider tier={tier}>{children}</ProfilePageTierProvider>
        </ProfileRoutineAccessProvider>
      </AuthenticatedAppShell>
    </AppRouteProviders>
  )
}
