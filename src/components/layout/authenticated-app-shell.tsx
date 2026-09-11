import type { ReactNode } from "react"

import { Header } from "@/components/layout/header"
import { PersonalPlanNavigation } from "@/components/layout/personal-plan-navigation"
import type { AuthenticatedAppNavigationAccess } from "@/lib/personal-plan/navigation-access"

export function AuthenticatedAppShell({
  navigation,
  children,
  legacyHeader,
  personalPlanNavigation,
}: {
  navigation: AuthenticatedAppNavigationAccess
  children: ReactNode
  legacyHeader?: ReactNode
  personalPlanNavigation?: ReactNode
}) {
  const personalPlan = navigation.kind === "personal_plan"

  return (
    <div
      className={
        personalPlan
          ? // Die Variable bleibt auf allen Breiten konstant, weil application-state
            // seine Höhe daraus ableitet; nur die Padding-Kompensation entfällt ab md.
            "min-h-dvh [--personal-plan-shell-bottom-padding:calc(4.5rem+env(safe-area-inset-bottom))] [--personal-plan-shell-header-offset:3.5rem]"
          : "min-h-dvh"
      }
      data-personal-plan-shell={personalPlan || undefined}
    >
      {personalPlan
        ? (personalPlanNavigation ?? (
            <PersonalPlanNavigation
              key={navigation.hasPendingRoutineProposal ? "pending" : "clear"}
              items={navigation.items}
              initialHasPendingRoutineProposal={navigation.hasPendingRoutineProposal}
              unvisitedNavSurfaces={navigation.unvisitedNavSurfaces}
              tier={navigation.tier}
            />
          ))
        : (legacyHeader ?? <Header />)}
      {personalPlan ? (
        <div
          data-personal-plan-content="true"
          className="pb-[var(--personal-plan-shell-bottom-padding)] md:pb-0"
        >
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  )
}
