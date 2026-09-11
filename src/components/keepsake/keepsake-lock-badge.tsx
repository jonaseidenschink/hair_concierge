import { Lock } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Corner lock marker for a premium-gated affordance on a KEEPSAKE surface (T17,
 * freemium-scanner-first PR5) — the Routine's „Anpassen" entry and the locked chat
 * composer a lapsed owner sees on their own content.
 *
 * Same contract as `NavLockBadge` (T3), `ScanLockBadge` (T9) and `ProfileLockBadge`
 * (T15): the affordance it marks stays fully visible — this only ever sits at its
 * corner and never covers or replaces it.
 *
 * Decorative: the affordance it marks carries the accessible name ("… — Premium"), so
 * a screen reader hears the gate once, not twice.
 */
export function KeepsakeLockBadge({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-keepsake-lock-badge="true"
      className={cn(
        "pointer-events-none absolute -right-1 -top-1 flex h-[13px] w-[13px] items-center justify-center rounded-full bg-primary ring-2 ring-background",
        className,
      )}
    >
      <Lock className="h-2 w-2 text-primary-foreground" strokeWidth={3} />
    </span>
  )
}
