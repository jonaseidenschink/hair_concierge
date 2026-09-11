import { Lock } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Corner lock marker for a premium-gated Profil affordance (T15,
 * freemium-scanner-first PR5) — the Haar-Check edit button and the
 * Verfeinerungs-Teaser CTA. Same contract as `NavLockBadge`
 * (`components/layout/personal-plan-navigation.tsx`, T3) and `ScanLockBadge`
 * (`components/scan/scan-lock-badge.tsx`, T9): the affordance it marks stays
 * fully visible — this only ever sits at its corner and never covers or
 * replaces it.
 *
 * Decorative: the affordance it marks carries the accessible name ("… —
 * Premium"), so a screen reader hears the gate once, not twice.
 */
export function ProfileLockBadge({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-profile-lock-badge="true"
      className={cn(
        "pointer-events-none absolute -right-1 -top-1 flex h-[13px] w-[13px] items-center justify-center rounded-full bg-primary ring-2 ring-background",
        className,
      )}
    >
      <Lock className="h-2 w-2 text-primary-foreground" strokeWidth={3} />
    </span>
  )
}
