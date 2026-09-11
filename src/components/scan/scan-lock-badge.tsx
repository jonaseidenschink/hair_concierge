import { Lock } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Corner lock marker for a premium-gated scan affordance (T9), the same contract as
 * `NavLockBadge` in `components/layout/personal-plan-navigation.tsx` (T3): the symbol it
 * marks stays fully visible — this only ever sits at its corner and never covers or
 * replaces it (binding constraint, "locks never cover symbols").
 *
 * Decorative: the affordance it marks carries the accessible name ("… — Premium"), so a
 * screen reader hears the gate once, not twice.
 */
export function ScanLockBadge({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-scan-lock-badge="true"
      className={cn(
        "pointer-events-none absolute -right-1 -top-1 flex h-[13px] w-[13px] items-center justify-center rounded-full bg-primary ring-2 ring-background",
        className,
      )}
    >
      <Lock className="h-2 w-2 text-primary-foreground" strokeWidth={3} />
    </span>
  )
}
